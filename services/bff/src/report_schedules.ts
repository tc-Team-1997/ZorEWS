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

export type ScheduleCadence = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'last_day_of_month';

export const VALID_CADENCES: readonly ScheduleCadence[] = [
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'last_day_of_month',
] as const;

// T6 M12.4 — schedule timezones beyond UTC.
//
// Whitelisted zones for the prototype. Open-ended IANA strings
// would force us to ship the tzdata, so we cap the surface to the
// dozen zones BIL operations actually run in.
export const SUPPORTED_TZ = [
  'UTC',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Dubai',
  'Asia/Tokyo',
  'Asia/Hong_Kong',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Australia/Sydney',
] as const;

export type ScheduleTz = (typeof SUPPORTED_TZ)[number];

export function isScheduleTz(s: unknown): s is ScheduleTz {
  return typeof s === 'string' && (SUPPORTED_TZ as readonly string[]).includes(s);
}

export interface ReportScheduleInput {
  report_id: string;
  format: ReportFormat;
  name: string;
  cadence: ScheduleCadence;
  /** Wall-clock hour 0-23 in the schedule's configured `tz`.
   *  Field name kept for backwards compat — when `tz` is omitted
   *  (or 'UTC') this is literally the UTC hour. */
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
  /** T6 M12.4 — IANA zone the wall-clock fields are in.
   *  Defaults to 'UTC'. Must be one of `SUPPORTED_TZ`. */
  tz?: ScheduleTz;
}

/** M3.3 — retry tracking attached to a schedule entry when the
 *  scheduler tick fails to submit the job. Cleared on the next
 *  successful run. */
export interface ScheduleRetryState {
  /** 1 = first retry pending; increments on each failure. */
  attempt: number;
  last_failure_at: string;
  last_failure_message: string;
  /** ISO when the next retry is eligible (now + backoff). The tick
   *  worker skips entries whose next_retry_at > as_of. */
  next_retry_at: string;
  /** Set by the tick worker when attempt ≥ max_retries — the schedule
   *  is parked and surfaces in the ops dashboard for manual review. */
  parked: boolean;
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
  /** T6 M12.4 — always set; legacy schedules default to 'UTC'. */
  tz: ScheduleTz;
  /** M3.3 — set by the scheduler tick worker on submit failure.
   *  Cleared by markRun on the next successful run. */
  retry_state?: ScheduleRetryState | null;
}

export type ReportSchedulePatch = Partial<Pick<
  ReportScheduleInput,
  'name' | 'cadence' | 'hour_utc' | 'day_of_week' | 'day_of_month' | 'recipients' | 'enabled' | 'parameters' | 'format' | 'tz'
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
 * Returns the offset (in minutes) of `tz` from UTC at the given
 * instant. Positive when the zone is ahead of UTC (e.g. Asia/Kolkata
 * → +330). Uses Intl.DateTimeFormat to extract wall-clock parts in
 * the target zone, then recomposes them as a UTC instant.
 */
function offsetMinutesAt(instant: Date, tz: ScheduleTz): number {
  if (tz === 'UTC') return 0;
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
  const parts = fmt.formatToParts(instant);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)!.value, 10);
  // 'en-US' with hour12:false sometimes returns "24" for midnight.
  let hour = get('hour');
  if (hour === 24) hour = 0;
  const zonedAsIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second'),
  );
  return Math.round((zonedAsIfUtc - instant.getTime()) / 60_000);
}

/**
 * Given a wall-clock (year/month/day/hour) in `tz`, return the UTC
 * instant. Iterates to converge across DST transitions (DST shifts
 * make the offset itself a function of the instant; two passes are
 * always enough for hourly granularity).
 */
function utcFromZoned(
  year: number,
  month0: number,
  day: number,
  hour: number,
  tz: ScheduleTz,
): Date {
  if (tz === 'UTC') {
    return new Date(Date.UTC(year, month0, day, hour, 0, 0, 0));
  }
  // First guess: pretend the wall clock IS UTC.
  let utcMs = Date.UTC(year, month0, day, hour, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const offsetMin = offsetMinutesAt(new Date(utcMs), tz);
    const corrected = Date.UTC(year, month0, day, hour, 0, 0, 0) - offsetMin * 60_000;
    if (corrected === utcMs) break;
    utcMs = corrected;
  }
  return new Date(utcMs);
}

/**
 * Given a cadence + clock anchor + an `after` instant, compute the
 * next strictly-future fire time. Pure — no I/O, no clock side-effects.
 *
 * `tz` (T6 M12.4) treats `hour_utc`, day_of_week, day_of_month as
 * wall-clock fields in that zone. Defaults to 'UTC' so legacy
 * callers see no behavior change.
 */
export function computeNextRun(
  cadence: ScheduleCadence,
  day_of_week: number | null,
  day_of_month: number | null,
  hour_utc: number,
  after: Date,
  tz: ScheduleTz = 'UTC',
): Date {
  // Helper: zoned year/month/day for the `after` instant — used
  // when we anchor candidates to "today/this-month in the zone".
  const zonedAnchor = (() => {
    if (tz === 'UTC') {
      return {
        year: after.getUTCFullYear(),
        month: after.getUTCMonth(),
        day: after.getUTCDate(),
        weekday: after.getUTCDay(),
      };
    }
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour12: false,
    });
    const parts = fmt.formatToParts(after);
    const get = (t: string) => parseInt(parts.find((p) => p.type === t)!.value, 10);
    const wkMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = wkMap[parts.find((p) => p.type === 'weekday')!.value] ?? 0;
    return {
      year: get('year'),
      month: get('month') - 1,
      day: get('day'),
      weekday,
    };
  })();

  if (cadence === 'daily') {
    const d = utcFromZoned(zonedAnchor.year, zonedAnchor.month, zonedAnchor.day, hour_utc, tz);
    if (d.getTime() <= after.getTime()) {
      return utcFromZoned(zonedAnchor.year, zonedAnchor.month, zonedAnchor.day + 1, hour_utc, tz);
    }
    return d;
  }
  if (cadence === 'weekly') {
    if (day_of_week === null) {
      throw new ScheduleError('invalid_input', 'weekly cadence requires day_of_week');
    }
    const delta = (day_of_week - zonedAnchor.weekday + 7) % 7;
    let d = utcFromZoned(
      zonedAnchor.year,
      zonedAnchor.month,
      zonedAnchor.day + delta,
      hour_utc,
      tz,
    );
    if (d.getTime() <= after.getTime()) {
      d = utcFromZoned(
        zonedAnchor.year,
        zonedAnchor.month,
        zonedAnchor.day + delta + 7,
        hour_utc,
        tz,
      );
    }
    return d;
  }
  if (cadence === 'last_day_of_month') {
    // Last day = day 0 of NEXT month (works in zoned arithmetic too).
    const lastDayThis = utcFromZoned(zonedAnchor.year, zonedAnchor.month + 1, 0, hour_utc, tz);
    if (lastDayThis.getTime() > after.getTime()) return lastDayThis;
    return utcFromZoned(zonedAnchor.year, zonedAnchor.month + 2, 0, hour_utc, tz);
  }

  if (cadence === 'quarterly') {
    if (day_of_month === null) {
      throw new ScheduleError('invalid_input', 'quarterly cadence requires day_of_month');
    }
    const quarterStartMonth = Math.floor(zonedAnchor.month / 3) * 3;
    const candidate = utcFromZoned(
      zonedAnchor.year,
      quarterStartMonth,
      day_of_month,
      hour_utc,
      tz,
    );
    if (candidate.getTime() > after.getTime()) return candidate;
    return utcFromZoned(zonedAnchor.year, quarterStartMonth + 3, day_of_month, hour_utc, tz);
  }

  // monthly
  if (day_of_month === null) {
    throw new ScheduleError('invalid_input', 'monthly cadence requires day_of_month');
  }
  const candidate = utcFromZoned(
    zonedAnchor.year,
    zonedAnchor.month,
    day_of_month,
    hour_utc,
    tz,
  );
  if (candidate.getTime() <= after.getTime()) {
    return utcFromZoned(zonedAnchor.year, zonedAnchor.month + 1, day_of_month, hour_utc, tz);
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
  if (input.cadence === 'monthly' || input.cadence === 'quarterly') {
    if (
      typeof input.day_of_month !== 'number' ||
      !Number.isInteger(input.day_of_month) ||
      input.day_of_month < 1 ||
      input.day_of_month > 28
    ) {
      throw new ScheduleError(
        'invalid_input',
        `day_of_month must be integer 1-28 for ${input.cadence} cadence`,
      );
    }
  }
  // last_day_of_month doesn't take day_of_month (it's always last)
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
  if (input.tz !== undefined && !isScheduleTz(input.tz)) {
    throw new ScheduleError(
      'invalid_tz',
      `tz must be one of ${SUPPORTED_TZ.join(', ')}`,
    );
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
    tz: patch.tz ?? base.tz,
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
  /** M3.3 — record a tick-time failure. Increments attempt + writes
   *  next_retry_at + parks when attempt ≥ max_retries. Cleared by the
   *  next successful markRun. */
  recordFailure(
    tenant_id: string,
    schedule_id: string,
    opts: { error_message: string; max_retries: number; backoff_minutes: number; now: Date },
  ): ReportScheduleEntry;
  /** M3.3 — explicitly clear retry_state (used by SPA "retry now"
   *  affordance + by markRun on the next successful run). */
  clearRetryState(tenant_id: string, schedule_id: string, now: Date): ReportScheduleEntry;
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
    const usesDom = input.cadence === 'monthly' || input.cadence === 'quarterly';
    const tz: ScheduleTz = input.tz ?? 'UTC';
    const next = computeNextRun(
      input.cadence,
      input.cadence === 'weekly' ? input.day_of_week! : null,
      usesDom ? input.day_of_month! : null,
      input.hour_utc,
      now,
      tz,
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
      day_of_month: usesDom ? input.day_of_month! : null,
      recipients: [...input.recipients],
      enabled: input.enabled ?? true,
      parameters: input.parameters ?? {},
      created_by: created_by.trim(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      next_run_at: next.toISOString(),
      last_run_at: null,
      tz,
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
      tz: patch.tz ?? cur.tz,
      updated_at: now.toISOString(),
    };
    // Recompute next_run_at if any timing field changed.
    const timingChanged =
      patch.cadence !== undefined ||
      patch.hour_utc !== undefined ||
      patch.day_of_week !== undefined ||
      patch.day_of_month !== undefined ||
      patch.tz !== undefined;
    if (timingChanged) {
      const usesDomNext = next.cadence === 'monthly' || next.cadence === 'quarterly';
      next.next_run_at = computeNextRun(
        next.cadence,
        next.cadence === 'weekly' ? next.day_of_week : null,
        usesDomNext ? next.day_of_month : null,
        next.hour_utc,
        now,
        next.tz,
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
    const usesDom = cur.cadence === 'monthly' || cur.cadence === 'quarterly';
    const next = computeNextRun(
      cur.cadence,
      cur.cadence === 'weekly' ? cur.day_of_week : null,
      usesDom ? cur.day_of_month : null,
      cur.hour_utc,
      now,
      cur.tz,
    );
    const updated: ReportScheduleEntry = {
      ...cur,
      last_run_at: now.toISOString(),
      next_run_at: next.toISOString(),
      updated_at: now.toISOString(),
      // M3.3 — successful run clears any pending retry state.
      retry_state: null,
    };
    bucket.set(schedule_id, updated);
    return { ...updated, recipients: [...updated.recipients], parameters: { ...updated.parameters } };
  }

  recordFailure(
    tenant_id: string,
    schedule_id: string,
    opts: { error_message: string; max_retries: number; backoff_minutes: number; now: Date },
  ): ReportScheduleEntry {
    const bucket = this.bucket(tenant_id);
    const cur = bucket.get(schedule_id);
    if (!cur) {
      throw new ScheduleError('unknown_schedule', `schedule ${schedule_id} not found`);
    }
    const prev_attempt = cur.retry_state?.attempt ?? 0;
    const attempt = prev_attempt + 1;
    const backoff_ms = computeBackoffMinutes(attempt, opts.backoff_minutes) * 60_000;
    const retry_state: ScheduleRetryState = {
      attempt,
      last_failure_at: opts.now.toISOString(),
      last_failure_message: String(opts.error_message).slice(0, 1000),
      next_retry_at: new Date(opts.now.getTime() + backoff_ms).toISOString(),
      parked: attempt >= opts.max_retries,
    };
    const updated: ReportScheduleEntry = {
      ...cur,
      retry_state,
      updated_at: opts.now.toISOString(),
    };
    bucket.set(schedule_id, updated);
    return { ...updated, recipients: [...updated.recipients], parameters: { ...updated.parameters } };
  }

  clearRetryState(tenant_id: string, schedule_id: string, now: Date): ReportScheduleEntry {
    const bucket = this.bucket(tenant_id);
    const cur = bucket.get(schedule_id);
    if (!cur) {
      throw new ScheduleError('unknown_schedule', `schedule ${schedule_id} not found`);
    }
    const updated: ReportScheduleEntry = {
      ...cur,
      retry_state: null,
      updated_at: now.toISOString(),
    };
    bucket.set(schedule_id, updated);
    return { ...updated, recipients: [...updated.recipients], parameters: { ...updated.parameters } };
  }
}

// ─── M3.3 — pure helpers for the scheduler tick worker ──────────────

/** Exponential backoff in minutes. base × 2^(attempt − 1) — so a
 *  base of 5 yields 5 / 10 / 20 / 40 / ... clamped to a sensible max
 *  (24h) to avoid runaway delays on a schedule that's been broken
 *  forever. */
export function computeBackoffMinutes(attempt: number, base_minutes: number): number {
  if (!Number.isFinite(attempt) || attempt < 1) return base_minutes;
  if (!Number.isFinite(base_minutes) || base_minutes < 1) return 1;
  const mult = Math.pow(2, attempt - 1);
  const minutes = Math.round(base_minutes * mult);
  return Math.min(minutes, 24 * 60); // 24h cap
}

/** Pure. Returns schedules eligible to fire at `as_of` honouring the
 *  ±tolerance_minutes window AND any active retry_state backoff.
 *
 *  A schedule is eligible iff:
 *   - enabled
 *   - next_run_at is within [as_of - tolerance, as_of + tolerance]  OR
 *     it's overdue (next_run_at < as_of - tolerance) — overdue still fires
 *   - no retry_state, OR retry_state.parked === false AND
 *     next_retry_at ≤ as_of
 *
 *  M3.3 acceptance — "daily schedule fires within ±5 min of configured
 *  time": tolerance default 5 min. Production cron ticks at ~1 Hz so
 *  the window is generous enough to absorb cron jitter + clock skew. */
export function findDueSchedulesWithTolerance(
  schedules: readonly ReportScheduleEntry[],
  as_of: Date,
  tolerance_minutes: number,
): ReportScheduleEntry[] {
  const t = as_of.getTime();
  const window_ms = Math.max(0, tolerance_minutes) * 60_000;
  const due: ReportScheduleEntry[] = [];
  for (const e of schedules) {
    if (!e.enabled) continue;
    if (e.retry_state) {
      if (e.retry_state.parked) continue;
      const nextRetry = new Date(e.retry_state.next_retry_at).getTime();
      if (nextRetry > t) continue;
    }
    const next = new Date(e.next_run_at).getTime();
    // Fire if next_run_at is in the past OR within the future tolerance.
    if (next <= t + window_ms) {
      due.push(e);
    }
  }
  // Oldest-due first so retries surface ahead of green-path firings.
  due.sort((a, b) =>
    a.next_run_at < b.next_run_at ? -1 : a.next_run_at > b.next_run_at ? 1 : 0,
  );
  return due;
}

/** Heuristic: should a schedule retry be allowed to fire? Used by the
 *  tick worker to decide between "fire now" and "skip / waiting on
 *  backoff". Pure — passed `as_of` so behaviour is deterministic in
 *  tests. */
export function canRetryNow(entry: ReportScheduleEntry, as_of: Date): boolean {
  if (!entry.retry_state) return true;
  if (entry.retry_state.parked) return false;
  return new Date(entry.retry_state.next_retry_at).getTime() <= as_of.getTime();
}

export const defaultReportScheduleStore: ReportScheduleStore = new InMemoryReportScheduleStore();
