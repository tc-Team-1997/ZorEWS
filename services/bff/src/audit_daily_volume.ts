// services/bff/src/audit_daily_volume.ts
//
// T6 M15.11 — Audit log daily volume timeline.
//
// M15.7 ships the day-of-week × hour heatmap (cyclic weekly view).
// M15.11 is the COMPLEMENTARY view: a trend line across N consecutive
// UTC calendar days. Where M15.7 answers "what's our weekly traffic
// shape?", M15.11 answers "is audit volume growing or shrinking?
// is there a spike I should investigate?"
//
// Per UTC-day bucket: total event count + per-severity (3 keys) +
// per-outcome (3 keys). Every day in the trailing window emitted
// even when zero — gives the SPA a stable x-axis for time-series
// rendering. Envelope adds peak_day, mean_per_day, growth_rate
// (second-half-mean vs first-half-mean, surfacing trends).
//
// Pure rollup over an AuditEvent[]. Tenant-scoped at the caller layer
// (route only passes the requesting tenant's events).

import type {
  AuditEvent,
  AuditOutcome,
  AuditSeverity,
} from './audit_trail';

// ─── Constants ────────────────────────────────────────────────────────

export const DEFAULT_DAILY_WINDOW = 30;
export const MAX_DAILY_WINDOW = 365;
export const MIN_DAILY_WINDOW = 1;

const ALL_SEVERITIES: readonly AuditSeverity[] = ['critical', 'warning', 'info'] as const;
const ALL_OUTCOMES: readonly AuditOutcome[] = ['success', 'failure', 'denied'] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Public types ─────────────────────────────────────────────────────

export interface DailyVolumeBucket {
  /** UTC calendar day YYYY-MM-DD. */
  date: string;
  total: number;
  /** Per-AuditSeverity count; every key present at 0 when absent. */
  by_severity: Record<AuditSeverity, number>;
  /** Per-AuditOutcome count; every key present at 0 when absent. */
  by_outcome: Record<AuditOutcome, number>;
}

export interface AuditDailyVolumeSummary {
  tenant_id: string;
  generated_at: string;
  /** Window length in days. */
  days: number;
  /** First day of the window (oldest, inclusive) — YYYY-MM-DD UTC. */
  window_start: string;
  /** Last day of the window (= today UTC) — YYYY-MM-DD. */
  window_end: string;
  /** Total events that fell inside the trailing window. */
  total_events_in_window: number;
  /** Total events scanned (regardless of window). Useful when the
   *  SPA wants to show "showing the last 30 of N total" footnote. */
  total_events_observed: number;
  /** Every day in [window_start, window_end] in oldest-first order. */
  by_day: DailyVolumeBucket[];
  /** Highest-volume day. Tie-broken by date asc (earliest day wins
   *  at same count). null when zero events. */
  peak_day: string | null;
  /** Total at peak_day. 0 when no events. */
  peak_count: number;
  /** Σ total / days, rounded. */
  mean_per_day: number;
  /** (second-half mean − first-half mean) / first-half mean.
   *  Positive = growth, negative = shrinking. null when:
   *    - first-half mean is 0 (divide-by-zero guard)
   *    - days < 2 (no halves to compare). */
  growth_rate: number | null;
  /** Severity with the highest total across the window. Tie-broken
   *  by canonical order (critical wins over warning at same count).
   *  null when no events. */
  busiest_severity: AuditSeverity | null;
}

export class AuditDailyVolumeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AuditDailyVolumeError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyBySeverity(): Record<AuditSeverity, number> {
  return { critical: 0, warning: 0, info: 0 };
}

function emptyByOutcome(): Record<AuditOutcome, number> {
  return { success: 0, failure: 0, denied: 0 };
}

/** UTC YYYY-MM-DD for the given Date. */
function utcDateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Date at UTC midnight for the given input. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function emptyBucket(date: string): DailyVolumeBucket {
  return {
    date,
    total: 0,
    by_severity: emptyBySeverity(),
    by_outcome: emptyByOutcome(),
  };
}

function meanOf(arr: DailyVolumeBucket[]): number {
  if (arr.length === 0) return 0;
  const sum = arr.reduce((acc, b) => acc + b.total, 0);
  return sum / arr.length;
}

function validateDays(days: number): void {
  if (!Number.isInteger(days) || days < MIN_DAILY_WINDOW || days > MAX_DAILY_WINDOW) {
    throw new AuditDailyVolumeError(
      'invalid_input',
      `days must be an integer in [${MIN_DAILY_WINDOW}, ${MAX_DAILY_WINDOW}]`,
    );
  }
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeAuditDailyVolume(
  tenant_id: string,
  events: readonly AuditEvent[],
  days: number,
  now: Date,
): AuditDailyVolumeSummary {
  validateDays(days);

  // Compute window [window_start, window_end] (both inclusive) in UTC
  // days. window_end = today, window_start = today - (days-1) days.
  const endDay = startOfUtcDay(now);
  const startDay = new Date(endDay.getTime() - (days - 1) * MS_PER_DAY);

  // Build the bucket array oldest-first.
  const byDate = new Map<string, DailyVolumeBucket>();
  const by_day: DailyVolumeBucket[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startDay.getTime() + i * MS_PER_DAY);
    const date = utcDateStr(d);
    const bucket = emptyBucket(date);
    byDate.set(date, bucket);
    by_day.push(bucket);
  }
  const window_start = by_day[0]!.date;
  const window_end = by_day[by_day.length - 1]!.date;

  let total_events_in_window = 0;
  for (const e of events) {
    const t = new Date(e.ts);
    if (!Number.isFinite(t.getTime())) continue;
    const date = utcDateStr(t);
    const bucket = byDate.get(date);
    if (!bucket) continue; // outside window
    bucket.total++;
    if (ALL_SEVERITIES.includes(e.severity)) bucket.by_severity[e.severity]++;
    if (ALL_OUTCOMES.includes(e.outcome)) bucket.by_outcome[e.outcome]++;
    total_events_in_window++;
  }

  // peak_day: highest total; ties broken by date asc (earliest day
  // wins). null when zero events.
  let peak_day: string | null = null;
  let peak_count = 0;
  for (const b of by_day) {
    if (b.total > peak_count) {
      peak_count = b.total;
      peak_day = b.date;
    }
  }
  if (peak_count === 0) peak_day = null;

  const mean_per_day = Math.round(total_events_in_window / days);

  // growth_rate: split window into halves (even split when days even;
  // odd-length windows put the middle day in the SECOND half so the
  // first-half is the more historical baseline — keeps the rate
  // monotone vs day-count changes).
  let growth_rate: number | null = null;
  if (days >= 2) {
    const half = Math.floor(days / 2);
    const firstHalf = by_day.slice(0, half);
    const secondHalf = by_day.slice(half);
    const firstMean = meanOf(firstHalf);
    const secondMean = meanOf(secondHalf);
    if (firstMean > 0) {
      growth_rate = (secondMean - firstMean) / firstMean;
    }
  }

  // busiest_severity: highest total across the window, canonical-order
  // tie-break (critical wins over warning at same count).
  const totalBySeverity = emptyBySeverity();
  for (const b of by_day) {
    for (const sev of ALL_SEVERITIES) {
      totalBySeverity[sev] += b.by_severity[sev];
    }
  }
  let busiest_severity: AuditSeverity | null = null;
  let busiestCount = 0;
  for (const sev of ALL_SEVERITIES) {
    if (totalBySeverity[sev] > busiestCount) {
      busiestCount = totalBySeverity[sev];
      busiest_severity = sev;
    }
  }
  if (busiestCount === 0) busiest_severity = null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    days,
    window_start,
    window_end,
    total_events_in_window,
    total_events_observed: events.length,
    by_day,
    peak_day,
    peak_count,
    mean_per_day,
    growth_rate,
    busiest_severity,
  };
}
