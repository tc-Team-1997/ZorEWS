// services/bff/src/report_job_processing_time_histogram.ts
//
// T6 M12.19 — Report job processing-time histogram.
//
// Per-tenant histogram bucketing every report job by processing
// duration (`completed_at − requested_at` for completed jobs;
// running / queued / failed get their own buckets so ops sees the
// full job-status mix in one chart).
//
// 7 canonical buckets in resolution-speed order:
//   under_1s   — completed in < 1s (snappy)
//   1_to_5s    — [1s, 5s)
//   5_to_30s   — [5s, 30s)
//   30s_to_5m  — [30s, 5m) (heavy reports)
//   5m_plus    — ≥ 5m (very slow — investigate)
//   failed     — status='failed' (no successful completion)
//   in_flight  — status='queued' or 'running' (no completion yet)
//
// Strict-< upper bound semantics on every completion bucket (1s →
// 1_to_5s, 5s → 5_to_30s, 30s → 30s_to_5m, 5m → 5m_plus; matches
// M9.19 / M8.12 / M7.15 boundary convention).
//
// Distinct from:
//   M12.1  — async job tracker (status snapshot)
//   M12.5  — fleet-wide ReportJob analytics (current state aggregate)
//   M12.10 — per-report runtime trend (drift over time per report_id)
//   M12.11 — format distribution (per-format pivot)
//   M12.12 — per-requester rollup (per-actor pivot)
//   M12.13 — daily volume timeline (cross-job trend)
//   M12.14 — format × status cross-tab matrix
//   M12.15 — error pattern clustering
//   M12.16 — schedule recipient distribution
//   M12.17 — schedule cadence × format matrix
//   M12.18 — hourly volume distribution
//
// Mirror of M9.19 (investigation duration) + M8.12 (alert ack-time)
// + M7.15 (promotion latency) histogram pattern for the report job
// surface.
//
// Drives BIL ops "what's our typical report processing time? are any
// formats hitting > 5min consistently? how many jobs failed today?"
// answer in one round-trip.

import type {
  ReportJob,
  ReportJobStore,
  ReportFormat,
  JobStatus,
} from './reports_catalog';
import { linearPercentile } from './connector_run_analytics';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

export type ReportJobProcessingTimeBucket =
  | 'under_1s'
  | '1_to_5s'
  | '5_to_30s'
  | '30s_to_5m'
  | '5m_plus'
  | 'failed'
  | 'in_flight';

export const ALL_REPORT_JOB_PROCESSING_TIME_BUCKETS: readonly ReportJobProcessingTimeBucket[] = [
  'under_1s',
  '1_to_5s',
  '5_to_30s',
  '30s_to_5m',
  '5m_plus',
  'failed',
  'in_flight',
] as const;

export const SAMPLE_JOBS_CAP = 3;

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;

interface BucketMeta {
  bucket: ReportJobProcessingTimeBucket;
  label: string;
  /** Lower bound in ms (inclusive); null for failed + in_flight. */
  min_ms: number | null;
  /** Upper bound in ms (exclusive); null for 5m_plus + failed + in_flight. */
  max_ms: number | null;
}

const BUCKET_DEFS: readonly BucketMeta[] = [
  { bucket: 'under_1s', label: '< 1 second', min_ms: 0, max_ms: SECOND_MS },
  { bucket: '1_to_5s', label: '1s - 5s', min_ms: SECOND_MS, max_ms: 5 * SECOND_MS },
  { bucket: '5_to_30s', label: '5s - 30s', min_ms: 5 * SECOND_MS, max_ms: 30 * SECOND_MS },
  { bucket: '30s_to_5m', label: '30s - 5min', min_ms: 30 * SECOND_MS, max_ms: 5 * MINUTE_MS },
  { bucket: '5m_plus', label: '5min+', min_ms: 5 * MINUTE_MS, max_ms: null },
  { bucket: 'failed', label: 'Failed', min_ms: null, max_ms: null },
  { bucket: 'in_flight', label: 'In flight', min_ms: null, max_ms: null },
] as const;

// ---------------------------------------------------------------------
// Pure bucketing helper
// ---------------------------------------------------------------------

/** Bucket a successful job's processing duration (ms) into one of the
 *  5 completion buckets. Returns null on negative / non-finite values
 *  (defensive — silently skipped from histogram). */
export function bucketForProcessingMs(
  duration_ms: number,
): Exclude<ReportJobProcessingTimeBucket, 'failed' | 'in_flight'> | null {
  if (!Number.isFinite(duration_ms) || duration_ms < 0) return null;
  if (duration_ms < SECOND_MS) return 'under_1s';
  if (duration_ms < 5 * SECOND_MS) return '1_to_5s';
  if (duration_ms < 30 * SECOND_MS) return '5_to_30s';
  if (duration_ms < 5 * MINUTE_MS) return '30s_to_5m';
  return '5m_plus';
}

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface ReportJobSample {
  job_id: string;
  report_id: string;
  format: ReportFormat;
  status: JobStatus;
  requested_by: string;
  requested_at: string;
  completed_at: string | null;
  /** Duration in ms for completion buckets; null for failed / in_flight. */
  duration_ms: number | null;
  /** Error message present on failed jobs. */
  error_message: string | null;
}

export interface ReportJobProcessingTimeBucketRow {
  bucket: ReportJobProcessingTimeBucket;
  label: string;
  min_ms: number | null;
  max_ms: number | null;
  count: number;
  /** Cap 3. Completion buckets: sorted duration desc + job_id asc
   *  tie-break (longest first — biggest tail surfaces). failed:
   *  sorted requested_at desc (newest first). in_flight: sorted
   *  requested_at asc (oldest queued first — needs attention soonest). */
  samples: ReportJobSample[];
}

export interface ReportJobProcessingTimeHistogram {
  tenant_id: string;
  generated_at: string;
  total_jobs: number;
  total_completed: number;
  total_failed: number;
  total_in_flight: number;
  /** 7 buckets in canonical order. */
  buckets: ReportJobProcessingTimeBucketRow[];
  /** Highest-count bucket. Canonical iteration tie-break: under_1s
   *  beats 1_to_5s at tied count. null when zero jobs. */
  peak_bucket: ReportJobProcessingTimeBucket | null;
  peak_count: number;
  /** Aggregate stats over COMPLETED jobs only via M3.5 linearPercentile
   *  (Excel/R type 7). null when no completed. Rounded to whole ms. */
  mean_duration_ms: number | null;
  median_duration_ms: number | null;
  p95_duration_ms: number | null;
  /** Slowest completed job (max duration). null when no completed. */
  slowest_job: ReportJobSample | null;
  /** Most recent failed job (newest requested_at). null when no failed. */
  newest_failed: ReportJobSample | null;
  /** Oldest in-flight job (earliest requested_at). null when no in-flight. */
  oldest_in_flight: ReportJobSample | null;
  /** Subset of buckets with count=0 in canonical order. */
  empty_buckets: ReportJobProcessingTimeBucket[];
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function toSample(job: ReportJob, duration_ms: number | null): ReportJobSample {
  return {
    job_id: job.job_id,
    report_id: job.report_id,
    format: job.format,
    status: job.status,
    requested_by: job.requested_by,
    requested_at: job.requested_at,
    completed_at: job.completed_at,
    duration_ms,
    error_message: job.error_message,
  };
}

function compareSampleByDurationDesc(
  a: ReportJobSample,
  b: ReportJobSample,
): number {
  const da = a.duration_ms ?? 0;
  const db = b.duration_ms ?? 0;
  if (db !== da) return db - da;
  return a.job_id.localeCompare(b.job_id);
}

function compareSampleByRequestedAtDesc(
  a: ReportJobSample,
  b: ReportJobSample,
): number {
  const ta = Date.parse(a.requested_at);
  const tb = Date.parse(b.requested_at);
  if (Number.isFinite(ta) && Number.isFinite(tb) && tb !== ta) return tb - ta;
  return a.job_id.localeCompare(b.job_id);
}

function compareSampleByRequestedAtAsc(
  a: ReportJobSample,
  b: ReportJobSample,
): number {
  const ta = Date.parse(a.requested_at);
  const tb = Date.parse(b.requested_at);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  return a.job_id.localeCompare(b.job_id);
}

// ---------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------

export function buildReportJobProcessingTimeHistogram(
  tenant_id: string,
  jobs: ReportJob[],
  now: Date,
): ReportJobProcessingTimeHistogram {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new Error('buildReportJobProcessingTimeHistogram: tenant_id required');
  }

  const counts = new Map<ReportJobProcessingTimeBucket, number>();
  const samples = new Map<ReportJobProcessingTimeBucket, ReportJobSample[]>();
  for (const b of BUCKET_DEFS) {
    counts.set(b.bucket, 0);
    samples.set(b.bucket, []);
  }

  const completedDurations: number[] = [];
  let slowest_job: ReportJobSample | null = null;
  let newest_failed: ReportJobSample | null = null;
  let oldest_in_flight: ReportJobSample | null = null;

  let total_completed = 0;
  let total_failed = 0;
  let total_in_flight = 0;

  for (const job of jobs) {
    if (job.status === 'completed' && job.completed_at !== null) {
      const reqMs = Date.parse(job.requested_at);
      const compMs = Date.parse(job.completed_at);
      if (!Number.isFinite(reqMs) || !Number.isFinite(compMs)) continue;
      const duration_ms = compMs - reqMs;
      const bucket = bucketForProcessingMs(duration_ms);
      if (bucket === null) continue;
      const sample = toSample(job, duration_ms);
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      samples.get(bucket)!.push(sample);
      completedDurations.push(duration_ms);
      total_completed += 1;
      if (slowest_job === null || duration_ms > (slowest_job.duration_ms ?? -Infinity)) {
        slowest_job = sample;
      }
    } else if (job.status === 'failed') {
      const sample = toSample(job, null);
      counts.set('failed', (counts.get('failed') ?? 0) + 1);
      samples.get('failed')!.push(sample);
      total_failed += 1;
      const reqMs = Date.parse(job.requested_at);
      if (Number.isFinite(reqMs)) {
        const cur = newest_failed ? Date.parse(newest_failed.requested_at) : -Infinity;
        if (reqMs > cur) newest_failed = sample;
      }
    } else {
      // queued / running / completed-without-timestamp → in_flight
      const sample = toSample(job, null);
      counts.set('in_flight', (counts.get('in_flight') ?? 0) + 1);
      samples.get('in_flight')!.push(sample);
      total_in_flight += 1;
      const reqMs = Date.parse(job.requested_at);
      if (Number.isFinite(reqMs)) {
        const cur = oldest_in_flight ? Date.parse(oldest_in_flight.requested_at) : Infinity;
        if (reqMs < cur) oldest_in_flight = sample;
      }
    }
  }

  // Sort + cap samples per bucket
  for (const [bucket, arr] of samples.entries()) {
    if (bucket === 'failed') {
      arr.sort(compareSampleByRequestedAtDesc);
    } else if (bucket === 'in_flight') {
      arr.sort(compareSampleByRequestedAtAsc);
    } else {
      arr.sort(compareSampleByDurationDesc);
    }
    if (arr.length > SAMPLE_JOBS_CAP) arr.length = SAMPLE_JOBS_CAP;
  }

  const buckets: ReportJobProcessingTimeBucketRow[] = BUCKET_DEFS.map((meta) => ({
    bucket: meta.bucket,
    label: meta.label,
    min_ms: meta.min_ms,
    max_ms: meta.max_ms,
    count: counts.get(meta.bucket) ?? 0,
    samples: samples.get(meta.bucket) ?? [],
  }));

  // peak_bucket via canonical iteration (strict > so first wins on ties)
  let peak_bucket: ReportJobProcessingTimeBucket | null = null;
  let peak_count = 0;
  for (const row of buckets) {
    if (row.count > peak_count) {
      peak_count = row.count;
      peak_bucket = row.bucket;
    }
  }
  if (peak_count === 0) peak_bucket = null;

  // Aggregate stats over completed durations
  const sorted = [...completedDurations].sort((a, b) => a - b);
  const mean_duration_ms =
    completedDurations.length === 0
      ? null
      : Math.round(
          completedDurations.reduce((acc, d) => acc + d, 0) /
            completedDurations.length,
        );
  const median_duration_ms =
    completedDurations.length === 0 ? null : Math.round(linearPercentile(sorted, 0.5) ?? 0);
  const p95_duration_ms =
    completedDurations.length === 0 ? null : Math.round(linearPercentile(sorted, 0.95) ?? 0);

  const empty_buckets = buckets.filter((r) => r.count === 0).map((r) => r.bucket);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_jobs: jobs.length,
    total_completed,
    total_failed,
    total_in_flight,
    buckets,
    peak_bucket,
    peak_count,
    mean_duration_ms,
    median_duration_ms,
    p95_duration_ms,
    slowest_job,
    newest_failed,
    oldest_in_flight,
    empty_buckets,
  };
}

// ---------------------------------------------------------------------
// Store adapter
// ---------------------------------------------------------------------

// 200 = max page_size the InMemoryReportJobStore.list() clamps to.
// Anything larger gets silently truncated by the store.
const DRAIN_PAGE_SIZE = 200;
const MAX_DRAIN_PAGES = 500;

export function buildReportJobProcessingTimeHistogramFromStore(
  store: ReportJobStore,
  tenant_id: string,
  now: Date,
): ReportJobProcessingTimeHistogram {
  const all: ReportJob[] = [];
  let page = 1;
  for (let i = 0; i < MAX_DRAIN_PAGES; i++) {
    const r = store.list(tenant_id, { page, page_size: DRAIN_PAGE_SIZE });
    all.push(...r.items);
    if (r.items.length < DRAIN_PAGE_SIZE) break;
    page += 1;
  }
  return buildReportJobProcessingTimeHistogram(tenant_id, all, now);
}
