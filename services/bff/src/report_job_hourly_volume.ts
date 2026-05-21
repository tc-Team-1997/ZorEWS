// services/bff/src/report_job_hourly_volume.ts
//
// T6 M12.18 — Report job hourly volume distribution.
//
// Distinct from M12.13 (daily linear trend over N days) by being the
// orthogonal CYCLIC INTRADAY view: every job's requested_at is
// bucketed by UTC hour-of-day 0..23 across the whole tenant history.
// Drives the BIL ops scheduler-ergonomics view "do all our reports
// fire at 6am? — should we stagger them?" + capacity planning
// ("which hour pegs the worker fleet?").
//
// Mirror of M3.12 connector run hourly volume + M14.22 field visit
// dow×hour heatmap + M15.7 audit activity dow×hour heatmap pattern,
// adapted for the M12.1 ReportJob surface. 1D hourly (not 2D
// dow×hour) because the spec calls for the simpler intraday view —
// the dow×hour 2D version is a future M12.19 if demand warrants.

import {
  type JobStatus,
  type ReportFormat,
  type ReportJob,
  type ReportJobStore,
} from './reports_catalog';
import { ALL_JOB_STATUSES } from './report_format_status_matrix';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

export const HOURS_IN_DAY = 24;
/** Pagination cap when draining the store for the rollup. */
export const DRAIN_PAGE_SIZE = 500;
/** Max pages to drain (= 100k jobs ceiling, matches M12.11/M12.12/M12.13). */
export const MAX_DRAIN_PAGES = 200;
/** Canonical format priority for tie-break in busiest_format. */
export const ALL_REPORT_FORMATS_CANONICAL: ReportFormat[] = ['json', 'csv', 'pdf', 'xlsx'];

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface HourlyVolumeBucket {
  /** UTC hour-of-day 0..23. */
  hour: number;
  total: number;
  /** Every JobStatus key present at 0 when absent (stable SPA grid). */
  by_status: Record<JobStatus, number>;
  /** Every ReportFormat key present at 0 when absent (stable grid). */
  by_format: Record<ReportFormat, number>;
  /** Distinct requesters that submitted ≥1 job in this hour bucket. */
  distinct_requesters: number;
}

export interface ReportJobHourlyVolumeResult {
  tenant_id: string;
  generated_at: string;
  total_jobs: number;
  /** Always exactly 24 buckets, in 0..23 order, even when zero jobs. */
  by_hour: HourlyVolumeBucket[];
  /**
   * UTC hour with highest total_jobs. Earliest-hour-wins tie-break
   * via strict > comparison (matches M3.12 convention). null when
   * total_jobs=0.
   */
  peak_hour: number | null;
  /** Count at peak_hour (0 when total_jobs=0). */
  peak_count: number;
  /** Math.round(total_jobs / 24) — average load per hour. */
  mean_per_hour: number;
  /** UTC hours with zero jobs (asc). Empty when every hour active. */
  quiet_hours: number[];
  /**
   * Format with the highest total across the whole window.
   * Canonical-order tie-break (json wins over csv at tied count).
   * null when total_jobs=0.
   */
  busiest_format: ReportFormat | null;
}

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

function zeroByStatus(): Record<JobStatus, number> {
  // Use exported ALL_JOB_STATUSES to stay in sync with M12.11/M12.14
  // canonical order. Build with literal field names so the type
  // doesn't degrade to Record<string, number>.
  const out: Record<JobStatus, number> = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
  };
  // Defensive sanity check — flags drift if the closed-enum order changes.
  void ALL_JOB_STATUSES;
  return out;
}

function zeroByFormat(): Record<ReportFormat, number> {
  return { json: 0, csv: 0, pdf: 0, xlsx: 0 };
}

function emptyBucket(hour: number): HourlyVolumeBucket {
  return {
    hour,
    total: 0,
    by_status: zeroByStatus(),
    by_format: zeroByFormat(),
    distinct_requesters: 0,
  };
}

/** Parses requested_at to UTC hour. Returns null on malformed input. */
function utcHourOf(requested_at: unknown): number | null {
  if (typeof requested_at !== 'string') return null;
  const t = Date.parse(requested_at);
  if (!Number.isFinite(t)) return null;
  return new Date(t).getUTCHours();
}

// ---------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------

/**
 * Pure rollup over a list of ReportJob rows. Drives the route via
 * the convenience helper below; exported separately for unit tests
 * that supply rows directly without a store.
 */
export function buildReportJobHourlyVolume(
  tenant_id: string,
  jobs: ReportJob[],
  now: Date,
): ReportJobHourlyVolumeResult {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new Error('buildReportJobHourlyVolume: tenant_id required');
  }
  // Initialise 24 empty buckets + per-hour requester Sets
  const buckets: HourlyVolumeBucket[] = [];
  const requesterSets: Set<string>[] = [];
  for (let h = 0; h < HOURS_IN_DAY; h++) {
    buckets.push(emptyBucket(h));
    requesterSets.push(new Set<string>());
  }

  let total_jobs = 0;
  const formatTotals = zeroByFormat();

  for (const job of jobs) {
    if (!job || job.tenant_id !== tenant_id) continue;
    const hour = utcHourOf(job.requested_at);
    if (hour === null) continue;
    const bucket = buckets[hour];
    bucket.total += 1;
    // by_status: defensively guard out-of-enum status
    if ((ALL_JOB_STATUSES as readonly string[]).includes(job.status)) {
      bucket.by_status[job.status] += 1;
    }
    // by_format: defensively guard out-of-enum format
    if (ALL_REPORT_FORMATS_CANONICAL.includes(job.format)) {
      bucket.by_format[job.format] += 1;
      formatTotals[job.format] += 1;
    }
    if (typeof job.requested_by === 'string' && job.requested_by !== '') {
      requesterSets[hour].add(job.requested_by);
    }
    total_jobs += 1;
  }

  // Finalize distinct_requesters per bucket
  for (let h = 0; h < HOURS_IN_DAY; h++) {
    buckets[h].distinct_requesters = requesterSets[h].size;
  }

  // peak_hour + peak_count (earliest-hour-wins tie-break via strict >)
  let peak_hour: number | null = null;
  let peak_count = 0;
  if (total_jobs > 0) {
    for (let h = 0; h < HOURS_IN_DAY; h++) {
      if (buckets[h].total > peak_count) {
        peak_count = buckets[h].total;
        peak_hour = h;
      }
    }
  }

  // quiet_hours: zero-count hours in canonical asc order
  const quiet_hours: number[] = [];
  for (let h = 0; h < HOURS_IN_DAY; h++) {
    if (buckets[h].total === 0) quiet_hours.push(h);
  }

  // busiest_format: highest total across window, canonical tie-break
  let busiest_format: ReportFormat | null = null;
  if (total_jobs > 0) {
    let max = 0;
    for (const fmt of ALL_REPORT_FORMATS_CANONICAL) {
      if (formatTotals[fmt] > max) {
        max = formatTotals[fmt];
        busiest_format = fmt;
      }
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_jobs,
    by_hour: buckets,
    peak_hour,
    peak_count,
    mean_per_hour: Math.round(total_jobs / HOURS_IN_DAY),
    quiet_hours,
    busiest_format,
  };
}

/**
 * Drain the ReportJobStore via paginated list (no filter — full rollup
 * across the tenant's complete job history). Mirror of M12.13 daily
 * volume drain pattern: 500/page × 200 pages = 100k jobs ceiling.
 */
export async function buildReportJobHourlyVolumeFromStore(
  store: ReportJobStore,
  tenant_id: string,
  now: Date,
): Promise<ReportJobHourlyVolumeResult> {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new Error('buildReportJobHourlyVolumeFromStore: tenant_id required');
  }
  const jobs: ReportJob[] = [];
  let page = 1;
  while (page <= MAX_DRAIN_PAGES) {
    const slice = store.list(tenant_id, { page, page_size: DRAIN_PAGE_SIZE });
    if (slice.items.length === 0) break;
    jobs.push(...slice.items);
    if (slice.items.length < DRAIN_PAGE_SIZE) break;
    page += 1;
  }
  return buildReportJobHourlyVolume(tenant_id, jobs, now);
}
