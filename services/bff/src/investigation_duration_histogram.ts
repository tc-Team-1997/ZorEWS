// services/bff/src/investigation_duration_histogram.ts
//
// T6 M9.19 — Investigation duration histogram.
//
// Per-tenant histogram bucketing every investigation by its
// duration (`closed_at − opened_at` for closed; null for still-
// open) into 6 canonical buckets answering "how fast do we typically
// close a fraud investigation? are any cases dragging past 30 days?".
//
// 6 buckets in canonical resolution-speed order:
//   under_1h   — closed within 1 hour
//   1_to_24h   — closed within [1h, 24h)
//   1_to_7d    — closed within [24h, 7d)
//   7_to_30d   — closed within [7d, 30d)
//   30d_plus   — closed after ≥ 30d (concerning duration)
//   still_open — status != 'closed' yet (waiting on operator)
//
// Strict-< upper bound semantics (1h exactly → 1_to_24h, 24h → 1_to_7d,
// 7d → 7_to_30d, 30d → 30d_plus; matches M8.12 alert ack-time + M9.11
// case age boundary convention).
//
// Distinct from:
//   M9.5  — case SLA breach (per-state SLA deadlines vs wall clock)
//   M9.8  — investigation cohort summary (current status snapshot)
//   M9.11 — case AGE buckets (time SINCE opened — different question)
//   M9.13 — age × status matrix (composition, not closure speed)
//   M9.14 — note authorship rollup (per-author note volume)
//   M9.16 — maker-checker by-reviewer activity (CAS/CAP decisions)
//   M9.17 — case state transition matrix (transition counts)
//   M9.18 — note daily volume timeline (note volume over time)
//
// Mirror of M8.12 alert ack-time + M7.15 promotion latency +
// M9.11 case age histogram pattern for the investigation surface.
//
// Drives BIL ops review:
//   - "what's our typical fraud-investigation turnaround?" (peak_bucket
//     + mean/median/p95 durations)
//   - "any investigations dragging past 30 days?" (30d_plus bucket
//     samples surface the oldest closures + still_open samples surface
//     the oldest open investigations needing supervisor attention)
//   - "are we improving over time?" (compare across periods)

import type {
  CaseInvestigation,
  CaseInvestigationStore,
} from './case_investigation';
import { linearPercentile } from './connector_run_analytics';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

export type InvestigationDurationBucket =
  | 'under_1h'
  | '1_to_24h'
  | '1_to_7d'
  | '7_to_30d'
  | '30d_plus'
  | 'still_open';

export const ALL_INVESTIGATION_DURATION_BUCKETS: readonly InvestigationDurationBucket[] = [
  'under_1h',
  '1_to_24h',
  '1_to_7d',
  '7_to_30d',
  '30d_plus',
  'still_open',
] as const;

export const SAMPLE_INVESTIGATIONS_CAP = 3;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface BucketMeta {
  bucket: InvestigationDurationBucket;
  label: string;
  /** Lower bound in ms (inclusive). null for still_open (no closure). */
  min_ms: number | null;
  /** Upper bound in ms (exclusive). null for 30d_plus + still_open. */
  max_ms: number | null;
}

const BUCKET_DEFS: readonly BucketMeta[] = [
  { bucket: 'under_1h', label: '< 1 hour', min_ms: 0, max_ms: HOUR_MS },
  { bucket: '1_to_24h', label: '1h - 24h', min_ms: HOUR_MS, max_ms: DAY_MS },
  { bucket: '1_to_7d', label: '1d - 7d', min_ms: DAY_MS, max_ms: 7 * DAY_MS },
  { bucket: '7_to_30d', label: '7d - 30d', min_ms: 7 * DAY_MS, max_ms: 30 * DAY_MS },
  { bucket: '30d_plus', label: '30d+', min_ms: 30 * DAY_MS, max_ms: null },
  { bucket: 'still_open', label: 'Still open', min_ms: null, max_ms: null },
] as const;

// ---------------------------------------------------------------------
// Pure bucketing helper
// ---------------------------------------------------------------------

/** Bucket a closure duration (in ms) into one of the 5 closed
 *  buckets. Returns null on negative / non-finite values (defensive —
 *  shouldn't happen but the histogram silently skips). */
export function bucketForDurationMs(
  duration_ms: number,
): Exclude<InvestigationDurationBucket, 'still_open'> | null {
  if (!Number.isFinite(duration_ms) || duration_ms < 0) return null;
  if (duration_ms < HOUR_MS) return 'under_1h';
  if (duration_ms < DAY_MS) return '1_to_24h';
  if (duration_ms < 7 * DAY_MS) return '1_to_7d';
  if (duration_ms < 30 * DAY_MS) return '7_to_30d';
  return '30d_plus';
}

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface InvestigationSample {
  investigation_id: string;
  case_id: string;
  customer_id: string;
  status: string;
  opened_at: string;
  /** ISO timestamp; null for still_open samples. */
  closed_at: string | null;
  /** Duration in ms; null for still_open samples (no closure). */
  duration_ms: number | null;
}

export interface InvestigationDurationBucketRow {
  bucket: InvestigationDurationBucket;
  label: string;
  min_ms: number | null;
  max_ms: number | null;
  count: number;
  /** Cap 3 samples. For closed buckets: sorted duration desc (longest
   *  first — biggest tail surfaces). For still_open: sorted opened_at
   *  asc (oldest-pending first — needs supervisor attention soonest). */
  samples: InvestigationSample[];
}

export interface InvestigationDurationHistogram {
  tenant_id: string;
  generated_at: string;
  total_investigations: number;
  total_closed: number;
  total_still_open: number;
  /** 6 buckets in canonical order. */
  buckets: InvestigationDurationBucketRow[];
  /** Highest-count bucket. Canonical iteration tie-break: earlier
   *  bucket wins at tied count (under_1h beats 1_to_24h). null when
   *  zero investigations. */
  peak_bucket: InvestigationDurationBucket | null;
  peak_count: number;
  /** Aggregate duration stats over CLOSED investigations only.
   *  null when no closed investigations. Computed via M3.5 linear-
   *  interpolation percentile (Excel/R type 7). */
  mean_duration_ms: number | null;
  median_duration_ms: number | null;
  p95_duration_ms: number | null;
  /** Longest closed investigation (max duration). null when no closed. */
  longest_closed: InvestigationSample | null;
  /** Oldest still-open investigation (earliest opened_at among status
   *  != 'closed'). null when none. */
  oldest_open: InvestigationSample | null;
  /** Subset of buckets with count=0 (canonical order). */
  empty_buckets: InvestigationDurationBucket[];
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function toSample(
  inv: CaseInvestigation,
  duration_ms: number | null,
): InvestigationSample {
  return {
    investigation_id: inv.investigation_id,
    case_id: inv.case_id,
    customer_id: inv.customer_id,
    status: inv.status,
    opened_at: inv.opened_at,
    closed_at: inv.closed_at,
    duration_ms,
  };
}

function compareSampleByDurationDesc(
  a: InvestigationSample,
  b: InvestigationSample,
): number {
  const da = a.duration_ms ?? 0;
  const db = b.duration_ms ?? 0;
  if (db !== da) return db - da;
  return a.investigation_id.localeCompare(b.investigation_id);
}

function compareSampleByOpenedAtAsc(
  a: InvestigationSample,
  b: InvestigationSample,
): number {
  const ta = Date.parse(a.opened_at);
  const tb = Date.parse(b.opened_at);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  return a.investigation_id.localeCompare(b.investigation_id);
}

// ---------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------

export function buildInvestigationDurationHistogram(
  tenant_id: string,
  investigations: CaseInvestigation[],
  now: Date,
): InvestigationDurationHistogram {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new Error('buildInvestigationDurationHistogram: tenant_id required');
  }

  // Per-bucket accumulators
  const counts = new Map<InvestigationDurationBucket, number>();
  const samples = new Map<InvestigationDurationBucket, InvestigationSample[]>();
  for (const b of BUCKET_DEFS) {
    counts.set(b.bucket, 0);
    samples.set(b.bucket, []);
  }

  // Track aggregate stats over closed investigations
  const closedDurations: number[] = [];
  let longest_closed: InvestigationSample | null = null;
  let oldest_open: InvestigationSample | null = null;

  let total_closed = 0;
  let total_still_open = 0;

  for (const inv of investigations) {
    if (inv.status === 'closed' && inv.closed_at !== null) {
      const openedMs = Date.parse(inv.opened_at);
      const closedMs = Date.parse(inv.closed_at);
      if (!Number.isFinite(openedMs) || !Number.isFinite(closedMs)) continue;
      const duration_ms = closedMs - openedMs;
      const bucket = bucketForDurationMs(duration_ms);
      if (bucket === null) continue; // negative duration → skip defensively
      const sample = toSample(inv, duration_ms);
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      samples.get(bucket)!.push(sample);
      closedDurations.push(duration_ms);
      total_closed += 1;
      if (longest_closed === null || duration_ms > (longest_closed.duration_ms ?? -Infinity)) {
        longest_closed = sample;
      }
    } else {
      // still_open
      const sample = toSample(inv, null);
      counts.set('still_open', (counts.get('still_open') ?? 0) + 1);
      samples.get('still_open')!.push(sample);
      total_still_open += 1;
      const openedMs = Date.parse(inv.opened_at);
      if (Number.isFinite(openedMs)) {
        const cur = oldest_open ? Date.parse(oldest_open.opened_at) : Infinity;
        if (openedMs < cur) oldest_open = sample;
      }
    }
  }

  // Sort + cap samples per bucket
  for (const [bucket, arr] of samples.entries()) {
    if (bucket === 'still_open') {
      arr.sort(compareSampleByOpenedAtAsc);
    } else {
      arr.sort(compareSampleByDurationDesc);
    }
    if (arr.length > SAMPLE_INVESTIGATIONS_CAP) arr.length = SAMPLE_INVESTIGATIONS_CAP;
  }

  // Build canonical-order buckets[]
  const buckets: InvestigationDurationBucketRow[] = BUCKET_DEFS.map((meta) => ({
    bucket: meta.bucket,
    label: meta.label,
    min_ms: meta.min_ms,
    max_ms: meta.max_ms,
    count: counts.get(meta.bucket) ?? 0,
    samples: samples.get(meta.bucket) ?? [],
  }));

  // peak_bucket via canonical iteration (strict > so first wins on ties)
  let peak_bucket: InvestigationDurationBucket | null = null;
  let peak_count = 0;
  for (const row of buckets) {
    if (row.count > peak_count) {
      peak_count = row.count;
      peak_bucket = row.bucket;
    }
  }
  if (peak_count === 0) peak_bucket = null;

  // Aggregate stats over closed durations
  const sorted = [...closedDurations].sort((a, b) => a - b);
  const mean_duration_ms =
    closedDurations.length === 0
      ? null
      : Math.round(closedDurations.reduce((acc, d) => acc + d, 0) / closedDurations.length);
  const median_duration_ms =
    closedDurations.length === 0 ? null : Math.round(linearPercentile(sorted, 0.5) ?? 0);
  const p95_duration_ms =
    closedDurations.length === 0 ? null : Math.round(linearPercentile(sorted, 0.95) ?? 0);

  const empty_buckets = buckets.filter((r) => r.count === 0).map((r) => r.bucket);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_investigations: investigations.length,
    total_closed,
    total_still_open,
    buckets,
    peak_bucket,
    peak_count,
    mean_duration_ms,
    median_duration_ms,
    p95_duration_ms,
    longest_closed,
    oldest_open,
    empty_buckets,
  };
}

// ---------------------------------------------------------------------
// Store adapter
// ---------------------------------------------------------------------

export function buildInvestigationDurationHistogramFromStore(
  store: CaseInvestigationStore,
  tenant_id: string,
  now: Date,
): InvestigationDurationHistogram {
  // Drain via paginated list — same convention as M9.14 / M9.18
  const page = store.list(tenant_id, { page: 1, page_size: 100000 });
  return buildInvestigationDurationHistogram(tenant_id, page.items, now);
}
