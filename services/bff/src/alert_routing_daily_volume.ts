// services/bff/src/alert_routing_daily_volume.ts
//
// T6 M8.15 — Alert routing daily volume timeline.
//
// M8.6 ships the alert routing ledger + analytics rollup over a sliding
// window (default 50, max 200 records). M8.11 ships the SLA breach
// detail list. M8.12 ships the ack-time histogram. M8.13 ships the
// channel dispatch 1D distribution. M8.14 ships the class × channel
// 2D matrix.
//
// M8.15 lands the TREND-LINE view: per UTC calendar day across N days,
// count routed alerts + per-class breakdown + acked/open/monitor split.
// Distinct from M8.6 (window aggregate, not time-bucketed) by being a
// time-series.
//
// Mirror of M12.13 (report jobs daily volume) / M15.11 (audit daily
// volume) / M10.15 (notification daily volume) / M1.9 (api key daily
// volume) pattern for the alerts surface.
//
// Drives "are we routing more alerts this month than last? when did
// the spike happen?" answers in one round-trip.
//
// Pure resolver — caller passes the drained ledger record list.

import type { RoutedAlertRecord } from './alert_routing_analytics';
import type { BilAlertClass } from './bil_alert_classification';

// ─── Constants ─────────────────────────────────────────────────────────

export const DEFAULT_ALERT_DAILY_WINDOW = 30;
export const MAX_ALERT_DAILY_WINDOW = 365;
export const MIN_ALERT_DAILY_WINDOW = 1;

const ALL_CLASSES: readonly BilAlertClass[] = ['red', 'orange', 'yellow', 'green'] as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Public types ──────────────────────────────────────────────────────

export interface AlertRoutingDailyBucket {
  date: string;
  total: number;
  /** Every BilAlertClass key always present (0 when absent). */
  by_class: Record<BilAlertClass, number>;
  /** Alerts in this bucket with acked_at != null. */
  acked_count: number;
  /** Alerts in this bucket with acked_at == null AND not monitor_only. */
  open_count: number;
  /** Alerts in this bucket with monitor_only=true (no ack expected). */
  monitor_only_count: number;
}

export interface AlertRoutingDailyVolumeSummary {
  tenant_id: string;
  generated_at: string;
  days: number;
  window_start: string;
  window_end: string;
  total_records_in_window: number;
  total_records_observed: number;
  by_day: AlertRoutingDailyBucket[];
  peak_day: string | null;
  peak_count: number;
  mean_per_day: number;
  /** (second-half mean − first-half mean) / first-half mean; null when
   *  first-half=0 OR days<2. */
  growth_rate: number | null;
  /** Class with the highest total across the window; canonical-order
   *  tie-break (red > orange > yellow > green); null on empty. */
  busiest_class: BilAlertClass | null;
}

export class AlertRoutingDailyVolumeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AlertRoutingDailyVolumeError';
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByClass(): Record<BilAlertClass, number> {
  return { red: 0, orange: 0, yellow: 0, green: 0 };
}

function utcDateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function meanOf(arr: AlertRoutingDailyBucket[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((acc, b) => acc + b.total, 0) / arr.length;
}

function validateDays(days: number): void {
  if (
    !Number.isInteger(days) ||
    days < MIN_ALERT_DAILY_WINDOW ||
    days > MAX_ALERT_DAILY_WINDOW
  ) {
    throw new AlertRoutingDailyVolumeError(
      'invalid_input',
      `days must be an integer in [${MIN_ALERT_DAILY_WINDOW}, ${MAX_ALERT_DAILY_WINDOW}]`,
    );
  }
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function summarizeAlertRoutingDailyVolume(
  tenant_id: string,
  records: readonly RoutedAlertRecord[],
  days: number,
  now: Date,
): AlertRoutingDailyVolumeSummary {
  validateDays(days);

  const endDay = startOfUtcDay(now);
  const startDay = new Date(endDay.getTime() - (days - 1) * MS_PER_DAY);

  const byDate = new Map<string, AlertRoutingDailyBucket>();
  const by_day: AlertRoutingDailyBucket[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startDay.getTime() + i * MS_PER_DAY);
    const date = utcDateStr(d);
    const bucket: AlertRoutingDailyBucket = {
      date,
      total: 0,
      by_class: emptyByClass(),
      acked_count: 0,
      open_count: 0,
      monitor_only_count: 0,
    };
    byDate.set(date, bucket);
    by_day.push(bucket);
  }
  const window_start = by_day[0]!.date;
  const window_end = by_day[by_day.length - 1]!.date;

  let total_records_in_window = 0;

  for (const rec of records) {
    const ts = new Date(rec.created_at).getTime();
    if (!Number.isFinite(ts)) continue;
    const bucket = byDate.get(utcDateStr(new Date(ts)));
    if (!bucket) continue;
    bucket.total++;
    total_records_in_window++;
    if (ALL_CLASSES.includes(rec.class)) {
      bucket.by_class[rec.class]++;
    }
    if (rec.monitor_only) {
      bucket.monitor_only_count++;
    } else if (rec.acked_at) {
      bucket.acked_count++;
    } else {
      bucket.open_count++;
    }
  }

  // peak_day — highest total; earliest-day-wins tie-break via strict >.
  let peak_day: string | null = null;
  let peak_count = 0;
  for (const b of by_day) {
    if (b.total > peak_count) {
      peak_count = b.total;
      peak_day = b.date;
    }
  }
  if (peak_count === 0) peak_day = null;

  const mean_per_day = Math.round(total_records_in_window / days);

  // growth_rate — same semantics as M12.13/M15.11/M10.15/M1.9
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

  // busiest_class — highest total across the window with canonical tie-break.
  let busiest_class: BilAlertClass | null = null;
  let busiestCount = 0;
  for (const cls of ALL_CLASSES) {
    const total = by_day.reduce((acc, b) => acc + b.by_class[cls], 0);
    if (total > busiestCount) {
      busiestCount = total;
      busiest_class = cls;
    }
  }
  if (busiestCount === 0) busiest_class = null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    days,
    window_start,
    window_end,
    total_records_in_window,
    total_records_observed: records.length,
    by_day,
    peak_day,
    peak_count,
    mean_per_day,
    growth_rate,
    busiest_class,
  };
}
