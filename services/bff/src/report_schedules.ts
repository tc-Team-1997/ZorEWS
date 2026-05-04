// services/bff/src/report_schedules.ts
//
// T6 M12.2 — Recurring report schedules.
//
// M12.1 ships the BIL report catalog + async job tracker for ad-hoc
// runs. Compliance teams also need *recurring* runs — "the RBI
// monthly compliance pack must be generated on the 1st at 06:00 UTC
// and delivered to compliance.lead@bil.example.com". M12.2 ships
// the schedule definitions + the tick endpoints the SPA polls to
// fan out the matching report jobs.
//
// Design:
//  - Pure-function `computeNextRun(cadence, dow, dom, hour_utc, after)`
//    — deterministic, no I/O.
//  - `ReportScheduleStore` interface + in-memory implementation,
//    capped at 50 schedules/tenant.
//  - SPA polls `GET /v1/reports/schedules/due?as_of=ISO` for due
//    schedules, fires the matching jobs via M12.1's POST /v1/reports/jobs,
//    then calls `POST /v1/reports/schedules/:id/mark-run` to bump
//    last_run_at + recompute next_run_at. Keeps the schedule
//    machinery decoupled from the job tracker.
//  - `report_id` cross-checked against M12.1's `getReportDef()` so
//    bogus report ids are rejected at create time.
//  - Recipients validated as basic email shape (tightened beyond
//    simple non-empty since these get used in dispatch URLs and
//    SMTP envelopes downstream).
//  - day_of_month capped at 28 to avoid leap-year / February
//    surprises. Production scheduler can later support "last day
//    of month" semantics — out of scope for M12.2.

import { randomUUID } from 'node:crypto';
import {
  type ReportFormat,
  getReportDef,
} from './reports_catalog';

// ─── Public types ──────────────────────────────────────────────────────

export type ScheduleCadence = 'daily' | 'weekly' | 'monthly';

export const VALID_CADENCES: readonly ScheduleCadence[] = ['daily', 'weekly', 'monthly'] as const;

export interface ReportScheduleInput {
  report_id: string;
  format: ReportFormat;
  name: string;
  cadence: ScheduleCadence;
  /** UTC hour 0-23. */
  hour_utc: number;
  /** 0=Sun … 6=Sat. Required when cadence='weekly'. */
  day_of_week?: number;
  /** 1-28. Required when cadence='monthly'. */
  day_of_month?: number;
  /** Email recipients — at least 1, at most 25. */
  recipients: string[];
  /** Defaults to true. */
  enabled?: boolean;
  /** Forwarded to M12.1's report job parameters. */
  parameters?: Record<string, unknown>;
}

export interface ReportScheduleEntry {
  schedule_id: string;
  tenant_id: string;
  report_id: string;
  format: ReportFormat;
  name: string;
  cadence: ScheduleCadence;
  hour_utc: number;
  day_of_week: number | null;
  day_of_month: number | null;
  recipients: string[];
  enabled: boolean;
  parameters: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
  next_run_at: string;
  last_run_at: string | null;
}

export type ReportSchedulePatch = Partial<Pick<
  ReportScheduleInput,
  'name' | 'cadence' | 'hour_utc' | 'day_of_week' | 'day_of_month' | 'recipients' | 'enabled' | 'parameters' | 'format'
>>;

export interface ReportSchedulePage {
  items: ReportScheduleEntry[];
  page: number;
  page_size: number;
  total: number;
}

export class ScheduleError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ScheduleError';
  }
}

// ─── Type guards ──────────────────────────────────────────────────────

export function isScheduleCadence(s: unknown): s is ScheduleCadence {
  return typeof s === 'string' && VALID_CADENCES.includes(s as ScheduleCadence);
}

const VALID_FORMATS: readonly ReportFormat[] = ['json', 'csv', 'pdf', 'xlsx'] as const;

function isReportFormat(s: unknown): s is ReportFormat {
  return typeof s === 'string' && VALID_FORMATS.includes(s as ReportFormat);
}

// Pragmatic email regex — RFC 5322 strict is overkill for an
// internal recipient list. Rejects obvious garbage.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmail(s: unknown): s is string {
  return typeof s === 'string' && EMAIL_RE.test(s) && s.length <= 200;
}

// ─── Pure-function next-run computation ────────────────────────────────

/**
 * Given a cadence + clock anchor + an `after` instant, compute the
 * next strictly-future fire time. Pure — no I/O, no clock side-effects.
 */
export function computeNextRun(
  cadence: ScheduleCadence,
  day_of_week: number | null,
  day_of_month: number | null,
  hour_utc: number,
  after: Date,
): Date {
  if (cadence === 'daily') {
    const d = new Date(Date.UTC(
      after.getUTCFullYear(),
      after.getUTCMonth(),
      after.getUTCDate(),
      hour_utc, 0, 0, 0,
    ));
    if (d.getTime() <= after.getTime()) {
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return d;
  }
  if (cadence === 'weekly') {
    if (day_of_week === null) {
      throw new ScheduleError('invalid_input', 'weekly cadence requires day_of_week');
    }
    const d = new Date(Date.UTC(
      after.getUTCFullYear(),
      after.getUTCMonth(),
      after.getUTCDate(),
      hour_utc, 0, 0, 0,
    ));
    let delta = (day_of_week - d.getUTCDay() + 7) % 7;
    d.setUTCDate(d.getUTCDate() + delta);
    if (d.getTime() <= after.getTime()) {
      d.setUTCDate(d.getUTCDate() + 7);
    }
    return d;
  }
  // monthly
  if (day_of_month === null) {
    throw new ScheduleError('invalid_input', 'monthly cadence requires day_of_month');
  }
  const candidate = new Date(Date.UTC(
    after.getUTCFullYear(),
    after.getUTCMonth(),
    day_of_month,
    hour_utc, 0, 0, 0,
  ));
  if (candidate.getTime() <= after.getTime()) {
    candidate.setUTCMonth(candidate.getUTCMonth() + 1);
    candidate.setUTCDate(day_of_month);
    candidate.setUTCHours(hour_utc, 0, 0, 0);
  }
  return candidate;
}

// ─── Validation ────────────────────────────────────────────────────────

function validateInput(input: ReportScheduleInput): void {
  if (!input || typeof input !== 'object') {
    throw new ScheduleError('invalid_input', 'request body required');
  }
  if (typeof input.name !== 'string' || !input.name.trim()) {
    throw new ScheduleError('invalid_input', 'name is required');
  }
  if (input.name.length > 120) {
    throw new ScheduleError('invalid_input', 'name ≤ 120 chars');
  }
  if (typeof input.report_id !== 'string' || !input.report_id.trim()) {
    throw new ScheduleError('invalid_input', 'report_id is required');
  }
  if (!getReportDef(input.report_id)) {
    throw new ScheduleError('invalid_report_id', `unknown report_id: ${input.report_id}`);
  }
  if (!isReportFormat(input.format)) {
    throw new ScheduleError('invalid_format', `format must be one of ${VALID_FORMATS.join(', ')}`);
  }
  const def = getReportDef(input.report_id)!;
  if (!def.supported_formats.includes(input.format)) {
    throw new ScheduleError(
      'invalid_format',
      `format ${input.format} not supported by ${input.report_id} (allowed: ${def.supported_formats.join(', ')})`,
    );
  }
  if (!isScheduleCadence(input.cadence)) {
    throw new ScheduleError('invalid_cadence', `cadence must be one of ${VALID_CADENCES.join(', ')}`);
  }
  if (
    typeof input.hour_utc !== 'number' ||
    !Number.isInteger(input.hour_utc) ||
    input.hour_utc < 0 ||
    input.hour_utc > 23
  ) {
    throw new ScheduleError('invalid_input', 'hour_utc must be integer 0-23');
  }
  if (input.cadence === 'weekly') {
    if (
      typeof input.day_of_week !== 'number' ||
      !Number.isInteger(input.day_of_week) ||
      input.day_of_week < 0 ||
      input.day_of_week > 6
    ) {
      throw new ScheduleError('invalid_input', 'day_of_week must be integer 0-6 (Sun=0) for weekly cadence');
    }
  }
  if (input.cadence === 'monthly') {
    if (
      typeof input.day_of_month !== 'number' ||
      !Number.isInteger(input.day_of_month) ||
      input.day_of_month < 1 ||
      input.day_of_month > 28
    ) {
      throw new ScheduleError('invalid_input', 'day_of_month must be integer 1-28 for monthly cadence');
    }
  }
  if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
    throw new ScheduleError('invalid_recipients', 'recipients[] must contain at least 1 email');
  }
  if (input.recipients.length > 25) {
    throw new ScheduleError('invalid_recipients', 'at most 25 recipients per schedule');
  }
  for (const r of input.recipients) {
    if (!isEmail(r)) {
      throw new ScheduleError('invalid_recipients', `'${r}' is not a valid email address`);
    }
  }
  if (
    input.parameters !== undefined &&
    (typeof input.parameters !== 'object' ||
      input.parameters === null ||
      Array.isArray(input.parameters))
  ) {
    throw new ScheduleError('invalid_input', 'parameters must be a JSON object');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new ScheduleError('invalid_input', 'enabled must be a boolean');
  }
}

function validatePatch(patch: ReportSchedulePatch, base: ReportScheduleEntry): void {
  // Build a hypothetical merged record and run validateInput on it.
  // Note: report_id is intentionally not patchable — schedules are
  // bound to the report at create time.
  const merged: ReportScheduleInput = {
    report_id: base.report_id,
    format: patch.format ?? base.format,
    name: patch.name ?? base.name,
    cadence: patch.cadence ?? base.cadence,
    hour_utc: patch.hour_utc ?? base.hour_utc,
    day_of_week: patch.day_of_week !== undefined ? patch.day_of_week : (base.day_of_week ?? undefined),
    day_of_month: patch.day_of_month !== undefined ? patch.day_of_month : (base.day_of_month ?? undefined),
    recipients: patch.recipients ?? base.recipients,
    enabled: patch.enabled ?? base.enabled,
    parameters: patch.parameters ?? base.parameters,
  };
  validateInput(merged);
}

// ─── Store ─────────────────────────────────────────────────────────────

export interface ReportScheduleStore {
  create(
    tenant_id: string,
    input: ReportScheduleInput,
    created_by: string,
    now: Date,
  ): ReportScheduleEntry;
  list(tenant_id: string, page: number, page_size: number): ReportSchedulePage;
  get(tenant_id: string, schedule_id: string): ReportScheduleEntry | null;
  update(
    tenant_id: string,
    schedule_id: string,
    patch: ReportSchedulePatch,
    now: Date,
  ): ReportScheduleEntry;
  delete(tenant_id: string, schedule_id: string): boolean;
  listDue(tenant_id: string, as_of: Date): ReportScheduleEntry[];
  markRun(tenant_id: string, schedule_id: string, now: Date): ReportScheduleEntry;
}

export class InMemoryReportScheduleStore implements ReportScheduleStore {
  private readonly perTenant = new Map<string, Map<string, ReportScheduleEntry>>();
  private readonly cap: number;

  constructor(opts: { cap?: number } = {}) {
    this.cap = opts.cap ?? 50;
  }

  private bucket(tenant_id: string): Map<string, ReportScheduleEntry> {
    let m = this.perTenant.get(tenant_id);
    if (!m) {
      m = new Map();
      this.perTenant.set(tenant_id, m);
    }
    return m;
  }

  create(
    tenant_id: string,
    input: ReportScheduleInput,
    created_by: string,
    now: Date,
  ): ReportScheduleEntry {
    if (!created_by || typeof created_by !== 'string' || !created_by.trim()) {
      throw new ScheduleError('invalid_input', 'created_by required');
    }
    validateInput(input);
    const bucket = this.bucket(tenant_id);
    if (bucket.size >= this.cap) {
      throw new ScheduleError(
        'cap_reached',
        `tenant ${tenant_id} already has ${this.cap} schedules — delete or disable one first`,
      );
    }
    const next = computeNextRun(
      input.cadence,
      input.cadence === 'weekly' ? input.day_of_week! : null,
      input.cadence === 'monthly' ? input.day_of_month! : null,
      input.hour_utc,
      now,
    );
    const entry: ReportScheduleEntry = {
      schedule_id: `sch-${randomUUID()}`,
      tenant_id,
      report_id: input.report_id,
      format: input.format,
      name: input.name.trim(),
      cadence: input.cadence,
      hour_utc: input.hour_utc,
      day_of_week: input.cadence === 'weekly' ? input.day_of_week! : null,
      day_of_month: input.cadence === 'monthly' ? input.day_of_month! : null,
      recipients: [...input.recipients],
      enabled: input.enabled ?? true,
      parameters: input.parameters ?? {},
      created_by: created_by.trim(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      next_run_at: next.toISOString(),
      last_run_at: null,
    };
    bucket.set(entry.schedule_id, entry);
    return { ...entry, recipients: [...entry.recipients], parameters: { ...entry.parameters } };
  }

  list(tenant_id: string, page: number, page_size: number): ReportSchedulePage {
    const bucket = this.perTenant.get(tenant_id) ?? new Map<string, ReportScheduleEntry>();
    const arr = [...bucket.values()].sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
    );
    const p = Math.max(1, page);
    const ps = Math.max(1, Math.min(100, page_size));
    const start = (p - 1) * ps;
    const items = arr.slice(start, start + ps).map((e) => ({
      ...e,
      recipients: [...e.recipients],
      parameters: { ...e.parameters },
    }));
    return { items, total: arr.length, page: p, page_size: ps };
  }

  get(tenant_id: string, schedule_id: string): ReportScheduleEntry | null {
    const e = this.perTenant.get(tenant_id)?.get(schedule_id);
    return e
      ? { ...e, recipients: [...e.recipients], parameters: { ...e.parameters } }
      : null;
  }

  update(
    tenant_id: string,
    schedule_id: string,
    patch: ReportSchedulePatch,
    now: Date,
  ): ReportScheduleEntry {
    const bucket = this.bucket(tenant_id);
    const cur = bucket.get(schedule_id);
    if (!cur) {
      throw new ScheduleError('unknown_schedule', `schedule ${schedule_id} not found`);
    }
    if (!patch || typeof patch !== 'object') {
      throw new ScheduleError('invalid_input', 'patch body required');
    }
    validatePatch(patch, cur);
    const next: ReportScheduleEntry = {
      ...cur,
      name: patch.name !== undefined ? patch.name.trim() : cur.name,
      format: patch.format ?? cur.format,
      cadence: patch.cadence ?? cur.cadence,
      hour_utc: patch.hour_utc ?? cur.hour_utc,
      day_of_week: patch.day_of_week !== undefined
        ? patch.day_of_week
        : (patch.cadence !== undefined && patch.cadence !== 'weekly' ? null : cur.day_of_week),
      day_of_month: patch.day_of_month !== undefined
        ? patch.day_of_month
        : (patch.cadence !== undefined && patch.cadence !== 'monthly' ? null : cur.day_of_month),
      recipients: patch.recipients ? [...patch.recipients] : cur.recipients,
      enabled: patch.enabled !== undefined ? patch.enabled : cur.enabled,
      parameters: patch.parameters !== undefined ? patch.parameters : cur.parameters,
      updated_at: now.toISOString(),
    };
    // Recompute next_run_at if any timing field changed.
    const timingChanged =
      patch.cadence !== undefined ||
      patch.hour_utc !== undefined ||
      patch.day_of_week !== undefined ||
      patch.day_of_month !== undefined;
    if (timingChanged) {
      next.next_run_at = computeNextRun(
        next.cadence,
        next.cadence === 'weekly' ? next.day_of_week : null,
        next.cadence === 'monthly' ? next.day_of_month : null,
        next.hour_utc,
        now,
      ).toISOString();
    }
    bucket.set(schedule_id, next);
    return { ...next, recipients: [...next.recipients], parameters: { ...next.parameters } };
  }

  delete(tenant_id: string, schedule_id: string): boolean {
    const bucket = this.perTenant.get(tenant_id);
    return bucket ? bucket.delete(schedule_id) : false;
  }

  listDue(tenant_id: string, as_of: Date): ReportScheduleEntry[] {
    const bucket = this.perTenant.get(tenant_id) ?? new Map<string, ReportScheduleEntry>();
    return [...bucket.values()]
      .filter((e) => e.enabled && e.next_run_at <= as_of.toISOString())
      .sort((a, b) => (a.next_run_at < b.next_run_at ? -1 : a.next_run_at > b.next_run_at ? 1 : 0))
      .map((e) => ({
        ...e,
        recipients: [...e.recipients],
        parameters: { ...e.parameters },
      }));
  }

  markRun(tenant_id: string, schedule_id: string, now: Date): ReportScheduleEntry {
    const bucket = this.bucket(tenant_id);
    const cur = bucket.get(schedule_id);
    if (!cur) {
      throw new ScheduleError('unknown_schedule', `schedule ${schedule_id} not found`);
    }
    const next = computeNextRun(
      cur.cadence,
      cur.cadence === 'weekly' ? cur.day_of_week : null,
      cur.cadence === 'monthly' ? cur.day_of_month : null,
      cur.hour_utc,
      now,
    );
    const updated: ReportScheduleEntry = {
      ...cur,
      last_run_at: now.toISOString(),
      next_run_at: next.toISOString(),
      updated_at: now.toISOString(),
    };
    bucket.set(schedule_id, updated);
    return { ...updated, recipients: [...updated.recipients], parameters: { ...updated.parameters } };
  }
}

export const defaultReportScheduleStore: ReportScheduleStore = new InMemoryReportScheduleStore();
