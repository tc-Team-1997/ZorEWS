// services/bff/src/field_officer.ts
//
// T6 M14.10 — Field-officer mobile.
//
// BFF surface for the field-officer mobile client. Field officers
// visit customers in person (collections, dispute resolution,
// rural underwriting check-ins) and need to log the visit's
// outcome the moment they walk out the door — including an
// optional GPS pin and a 6-value outcome enum that downstream
// case-management workflows (M9) can react to.
//
// Design:
//  - Per-tenant visit ledger; cap 200 entries with FIFO retention
//    (oldest visits aged out first). Same shape as M15.1 audit
//    trail's per-tenant retention.
//  - Visits are append-only from this surface — there is no edit
//    or delete; mistaken entries are corrected by a follow-up
//    visit with a clarifying note. Keeps the ledger immutable
//    so M15 audit consumers can rely on it.
//  - Optional `location` is just lat/lon validated to plausible
//    Earth ranges; no geofencing or tenant-perimeter check (out
//    of scope for prototype).
//  - "Today" is computed in UTC. Tenants in different timezones
//    can pass the M12.4 SUPPORTED_TZ via the optional `tz` query
//    param; default is UTC.

import { randomUUID } from 'node:crypto';
import { type ScheduleTz, isScheduleTz } from './report_schedules';

// ─── Public types ─────────────────────────────────────────────────────

export const VISIT_OUTCOMES = [
  'met_customer',
  'no_response',
  'partial_payment',
  'promised_to_pay',
  'dispute',
  'escalation_needed',
] as const;

export type VisitOutcome = (typeof VISIT_OUTCOMES)[number];

export function isVisitOutcome(s: unknown): s is VisitOutcome {
  return typeof s === 'string' && (VISIT_OUTCOMES as readonly string[]).includes(s);
}

export interface VisitLocation {
  lat: number;
  lon: number;
}

export interface FieldVisitInput {
  officer_id: string;
  customer_id: string;
  visit_at: string;
  outcome: VisitOutcome;
  note: string;
  location?: VisitLocation;
}

export interface FieldVisit {
  visit_id: string;
  tenant_id: string;
  officer_id: string;
  customer_id: string;
  visit_at: string;
  outcome: VisitOutcome;
  note: string;
  location: VisitLocation | null;
  created_at: string;
  created_by: string;
}

export interface VisitFilter {
  customer_id?: string;
  officer_id?: string;
  /** ISO-8601 lower bound (inclusive) on visit_at. */
  since?: string;
  /** ISO-8601 upper bound (exclusive) on visit_at. */
  until?: string;
  outcome?: VisitOutcome;
}

export class FieldVisitError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'FieldVisitError';
  }
}

// ─── Validation ───────────────────────────────────────────────────────

const ID_CAP = 64;
const NOTE_CAP = 1000;

function checkId(name: string, v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new FieldVisitError('invalid_input', `${name} is required`);
  }
  if (v.length > ID_CAP) {
    throw new FieldVisitError('invalid_input', `${name} ≤ ${ID_CAP} chars`);
  }
  return v.trim();
}

function checkIso(name: string, v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new FieldVisitError('invalid_input', `${name} is required`);
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) {
    throw new FieldVisitError('invalid_input', `${name} must be a valid ISO-8601 timestamp`);
  }
  return new Date(t).toISOString();
}

function checkLocation(v: unknown): VisitLocation | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object') {
    throw new FieldVisitError('invalid_input', 'location must be an object');
  }
  const o = v as Record<string, unknown>;
  if (typeof o.lat !== 'number' || !Number.isFinite(o.lat) || o.lat < -90 || o.lat > 90) {
    throw new FieldVisitError('invalid_input', 'location.lat must be in [-90, 90]');
  }
  if (typeof o.lon !== 'number' || !Number.isFinite(o.lon) || o.lon < -180 || o.lon > 180) {
    throw new FieldVisitError('invalid_input', 'location.lon must be in [-180, 180]');
  }
  return { lat: o.lat, lon: o.lon };
}

function validate(input: unknown): FieldVisitInput {
  if (!input || typeof input !== 'object') {
    throw new FieldVisitError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  const officer_id = checkId('officer_id', i.officer_id);
  const customer_id = checkId('customer_id', i.customer_id);
  const visit_at = checkIso('visit_at', i.visit_at);
  if (!isVisitOutcome(i.outcome)) {
    throw new FieldVisitError(
      'invalid_input',
      `outcome must be one of ${VISIT_OUTCOMES.join(', ')}`,
    );
  }
  if (typeof i.note !== 'string' || !i.note.trim()) {
    throw new FieldVisitError('invalid_input', 'note is required');
  }
  if (i.note.length > NOTE_CAP) {
    throw new FieldVisitError('invalid_input', `note ≤ ${NOTE_CAP} chars`);
  }
  const location = checkLocation(i.location) ?? undefined;
  return {
    officer_id,
    customer_id,
    visit_at,
    outcome: i.outcome,
    note: i.note.trim(),
    location,
  };
}

// ─── Today resolution (zone-aware) ────────────────────────────────────

/** Returns the [start, end) UTC window covering "today" in `tz`. */
export function todayWindow(now: Date, tz: ScheduleTz = 'UTC'): { start: Date; end: Date } {
  if (tz === 'UTC') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)!.value, 10);
  let hour = get('hour');
  if (hour === 24) hour = 0;
  const zonedAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  const offsetMin = Math.round((zonedAsUtc - now.getTime()) / 60_000);
  // Local midnight expressed as UTC
  const start = new Date(Date.UTC(get('year'), get('month') - 1, get('day')) - offsetMin * 60_000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

// ─── Store ────────────────────────────────────────────────────────────

export interface FieldVisitStore {
  log(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): FieldVisit;
  list(tenant_id: string, filter: VisitFilter): FieldVisit[];
  todayForOfficer(
    tenant_id: string,
    officer_id: string,
    now: Date,
    tz?: ScheduleTz,
  ): FieldVisit[];
}

const CAP_PER_TENANT = 200;

export class InMemoryFieldVisitStore implements FieldVisitStore {
  private readonly perTenant = new Map<string, FieldVisit[]>();

  private bucket(tenant_id: string): FieldVisit[] {
    let arr = this.perTenant.get(tenant_id);
    if (!arr) {
      arr = [];
      this.perTenant.set(tenant_id, arr);
    }
    return arr;
  }

  log(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): FieldVisit {
    if (!created_by || !created_by.trim()) {
      throw new FieldVisitError('invalid_input', 'created_by required');
    }
    const valid = validate(input);
    const arr = this.bucket(tenant_id);
    const visit: FieldVisit = {
      visit_id: `vst-${randomUUID()}`,
      tenant_id,
      officer_id: valid.officer_id,
      customer_id: valid.customer_id,
      visit_at: valid.visit_at,
      outcome: valid.outcome,
      note: valid.note,
      location: valid.location ?? null,
      created_at: now.toISOString(),
      created_by: created_by.trim(),
    };
    arr.push(visit);
    if (arr.length > CAP_PER_TENANT) {
      arr.splice(0, arr.length - CAP_PER_TENANT);
    }
    return { ...visit, location: visit.location ? { ...visit.location } : null };
  }

  list(tenant_id: string, filter: VisitFilter): FieldVisit[] {
    const arr = this.perTenant.get(tenant_id) ?? [];
    return arr
      .filter((v) => {
        if (filter.customer_id && v.customer_id !== filter.customer_id) return false;
        if (filter.officer_id && v.officer_id !== filter.officer_id) return false;
        if (filter.outcome && v.outcome !== filter.outcome) return false;
        if (filter.since && v.visit_at < filter.since) return false;
        if (filter.until && v.visit_at >= filter.until) return false;
        return true;
      })
      // Newest visit first.
      .sort((a, b) => (a.visit_at < b.visit_at ? 1 : a.visit_at > b.visit_at ? -1 : 0))
      .map((v) => ({ ...v, location: v.location ? { ...v.location } : null }));
  }

  todayForOfficer(
    tenant_id: string,
    officer_id: string,
    now: Date,
    tz: ScheduleTz = 'UTC',
  ): FieldVisit[] {
    const { start, end } = todayWindow(now, tz);
    return this.list(tenant_id, {
      officer_id,
      since: start.toISOString(),
      until: end.toISOString(),
    });
  }
}

export const defaultFieldVisitStore: FieldVisitStore = new InMemoryFieldVisitStore();

// ─── Pure-function: aggregate by outcome ──────────────────────────────

export interface OutcomeAggregate {
  total: number;
  by_outcome: Record<VisitOutcome, number>;
}

export function aggregateByOutcome(visits: readonly FieldVisit[]): OutcomeAggregate {
  const by_outcome = Object.fromEntries(
    VISIT_OUTCOMES.map((o) => [o, 0]),
  ) as Record<VisitOutcome, number>;
  for (const v of visits) by_outcome[v.outcome] += 1;
  return { total: visits.length, by_outcome };
}

/** Re-exported for callers that need the cap value (e.g. tests). */
export { CAP_PER_TENANT as VISIT_CAP_PER_TENANT };

/** Re-export the tz guard so route handlers don't need a separate import. */
export { isScheduleTz as isVisitTz };
