// services/bff/src/report_job_daily_volume.ts
//
// T6 M12.13 — Report job daily volume timeline.
//
// M12.5 ships fleet-wide job analytics (no time axis). M12.10 ships
// per-report runtime trend. M12.11 ships format distribution.
// M12.12 ships per-requester rollup. M12.13 lands the TREND-LINE
// view over the job store: per UTC calendar day across N days,
// total jobs + by_status + by_format breakdown.
//
// Mirror of M15.11 audit daily volume + M10.15 notification daily
// volume shape (same window mechanics, growth_rate math, peak/mean
// envelope). Distinct only in the data source (M12.1 ReportJob[]).
//
// Use case: ops dashboard "are we running more reports this month
// than last? when did the spike happen?" trend.
//
// Pure resolver. Drains the store via paginated list.

import type {
  JobStatus,
  ReportFormat,
  ReportJob,
  ReportJobStore,
} from './reports_catalog';

// ─── Constants ────────────────────────────────────────────────────────

export const DEFAULT_REPORT_DAILY_WINDOW = 30;
export const MAX_REPORT_DAILY_WINDOW = 365;
export const MIN_REPORT_DAILY_WINDOW = 1;

const ALL_STATUSES: readonly JobStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
] as const;

const ALL_FORMATS: readonly ReportFormat[] = [
  'json',
  'csv',
  'pdf',
  'xlsx',
] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DRAIN_PAGE_SIZE = 500;
const DRAIN_PAGE_CAP = 200;

// ─── Public types ─────────────────────────────────────────────────────

export interface ReportJobDailyBucket {
  date: string;
  total: number;
  /** Per-JobStatus; every key present at 0 when absent. */
  by_status: Record<JobStatus, number>;
  /** Per-ReportFormat; every key present at 0 when absent. */
  by_format: Record<ReportFormat, number>;
}

export interface ReportJobDailyVolumeSummary {
  tenant_id: string;
  generated_at: string;
  days: number;
  window_start: string;
  window_end: string;
  total_jobs_in_window: number;
  total_jobs_observed: number;
  by_day: ReportJobDailyBucket[];
  peak_day: string | null;
  peak_count: number;
  mean_per_day: number;
  /** Same semantics as M15.11/M10.15 — null when first-half mean=0
   *  or days<2. */
  growth_rate: number | null;
  /** Canonical tie-break: json > csv > pdf > xlsx. null on empty. */
  busiest_format: ReportFormat | null;
}

export class ReportDailyVolumeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ReportDailyVolumeError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByStatus(): Record<JobStatus, number> {
  return { queued: 0, running: 0, completed: 0, failed: 0 };
}

function emptyByFormat(): Record<ReportFormat, number> {
  return { json: 0, csv: 0, pdf: 0, xlsx: 0 };
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

function meanOf(arr: ReportJobDailyBucket[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((acc, b) => acc + b.total, 0) / arr.length;
}

function validateDays(days: number): void {
  if (!Number.isInteger(days) || days < MIN_REPORT_DAILY_WINDOW || days > MAX_REPORT_DAILY_WINDOW) {
    throw new ReportDailyVolumeError(
      'invalid_input',
      `days must be an integer in [${MIN_REPORT_DAILY_WINDOW}, ${MAX_REPORT_DAILY_WINDOW}]`,
    );
  }
}

function drainJobs(store: ReportJobStore, tenant_id: string): ReportJob[] {
  const out: ReportJob[] = [];
  for (let page = 1; page <= DRAIN_PAGE_CAP; page++) {
    const result = store.list(tenant_id, { page, page_size: DRAIN_PAGE_SIZE });
    out.push(...result.items);
    if (result.items.length < DRAIN_PAGE_SIZE) break;
    if (out.length >= result.total) break;
  }
  return out;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeReportJobDailyVolume(
  store: ReportJobStore,
  tenant_id: string,
  days: number,
  now: Date,
): ReportJobDailyVolumeSummary {
  validateDays(days);

  const endDay = startOfUtcDay(now);
  const startDay = new Date(endDay.getTime() - (days - 1) * MS_PER_DAY);

  const byDate = new Map<string, ReportJobDailyBucket>();
  const by_day: ReportJobDailyBucket[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startDay.getTime() + i * MS_PER_DAY);
    const date = utcDateStr(d);
    const bucket: ReportJobDailyBucket = {
      date,
      total: 0,
      by_status: emptyByStatus(),
      by_format: emptyByFormat(),
    };
    byDate.set(date, bucket);
    by_day.push(bucket);
  }
  const window_start = by_day[0]!.date;
  const window_end = by_day[by_day.length - 1]!.date;

  const jobs = drainJobs(store, tenant_id);
  let total_jobs_in_window = 0;
  const total_jobs_observed = jobs.length;

  for (const j of jobs) {
    const t = new Date(j.requested_at);
    if (!Number.isFinite(t.getTime())) continue;
    const bucket = byDate.get(utcDateStr(t));
    if (!bucket) continue;
    bucket.total++;
    if (ALL_STATUSES.includes(j.status)) bucket.by_status[j.status]++;
    if (ALL_FORMATS.includes(j.format)) bucket.by_format[j.format]++;
    total_jobs_in_window++;
  }

  // peak_day: highest total; earliest-day-wins tie-break.
  let peak_day: string | null = null;
  let peak_count = 0;
  for (const b of by_day) {
    if (b.total > peak_count) {
      peak_count = b.total;
      peak_day = b.date;
    }
  }
  if (peak_count === 0) peak_day = null;

  const mean_per_day = Math.round(total_jobs_in_window / days);

  // growth_rate — same semantics as M15.11/M10.15.
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

  // busiest_format: highest total across window; canonical tie-break.
  let busiest_format: ReportFormat | null = null;
  let mostFmt = 0;
  for (const fmt of ALL_FORMATS) {
    const total = by_day.reduce((acc, b) => acc + b.by_format[fmt], 0);
    if (total > mostFmt) {
      mostFmt = total;
      busiest_format = fmt;
    }
  }
  if (mostFmt === 0) busiest_format = null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    days,
    window_start,
    window_end,
    total_jobs_in_window,
    total_jobs_observed,
    by_day,
    peak_day,
    peak_count,
    mean_per_day,
    growth_rate,
    busiest_format,
  };
}
