// services/bff/src/audit_correlation_duration_histogram.ts
//
// T6 M15.16 — Audit correlation duration histogram.
//
// M15.10 ships the correlation rollup over the audit chain with per-
// correlation `duration_ms` (last_ts − first_ts) + has_failure flag.
// M15.10 returns per-row detail; M15.16 lands the aggregate
// DISTRIBUTION view: bucket every correlation by duration_ms.
//
// 5 canonical buckets in `ALL_CORRELATION_DURATION_BUCKETS` order:
//   instant      [0, 1s)
//   fast         [1s, 1m)
//   medium       [1m, 1h)
//   slow         [1h, 1d)
//   day_plus     >= 1d
//
// Strict-< upper bound semantics on each non-terminal bucket. Single-
// event correlations have duration_ms=0 → fall into `instant`. The
// special `unbounded` row counts correlations whose duration cannot
// be computed (e.g. corrupt timestamps); should always be 0 with the
// in-memory store but defensively reported.
//
// Per-bucket: count + has_failure_count (correlations with ≥ 1
// outcome != 'success') + sample_correlation_ids (cap 3, longest-
// duration first within bucket; for instant, sorted by event_count
// desc since duration is uniform). Envelope: peak_bucket + percentile
// stats over the full duration distribution.
//
// Mirror of M7.15 (promotion latency histogram) + M8.12 (alert
// ack-time histogram) + M9.11 (case age buckets) pattern for the
// audit-correlation surface.
//
// Drives BIL ops "how long do our workflows take? are critical
// correlations slow?" answers. Pure resolver — caller passes drained
// event list.

import type { AuditEvent } from './audit_trail';

// ─── Canonical buckets ─────────────────────────────────────────────────

export type CorrelationDurationBucket =
  | 'instant'
  | 'fast'
  | 'medium'
  | 'slow'
  | 'day_plus';

export const ALL_CORRELATION_DURATION_BUCKETS:
  readonly CorrelationDurationBucket[] = [
  'instant',
  'fast',
  'medium',
  'slow',
  'day_plus',
] as const;

interface BucketDef {
  bucket: CorrelationDurationBucket;
  label: string;
  min_ms: number;
  max_ms: number | null;
}

const MS_SEC = 1000;
const MS_MIN = 60 * MS_SEC;
const MS_HOUR = 60 * MS_MIN;
const MS_DAY = 24 * MS_HOUR;

const BUCKET_DEFS: Record<CorrelationDurationBucket, BucketDef> = {
  instant: { bucket: 'instant', label: '< 1 second', min_ms: 0, max_ms: MS_SEC },
  fast: { bucket: 'fast', label: '1s – 1m', min_ms: MS_SEC, max_ms: MS_MIN },
  medium: { bucket: 'medium', label: '1m – 1h', min_ms: MS_MIN, max_ms: MS_HOUR },
  slow: { bucket: 'slow', label: '1h – 1d', min_ms: MS_HOUR, max_ms: MS_DAY },
  day_plus: { bucket: 'day_plus', label: '> 1 day', min_ms: MS_DAY, max_ms: null },
};

// ─── Public types ──────────────────────────────────────────────────────

export interface CorrelationDurationBucketRow {
  bucket: CorrelationDurationBucket;
  label: string;
  min_ms: number;
  max_ms: number | null;
  count: number;
  /** Correlations in this bucket that had ≥ 1 outcome != 'success'. */
  has_failure_count: number;
  /** Sample correlation_ids (cap 3, longest-duration first within
   *  bucket; ties broken by correlation_id asc). */
  sample_correlation_ids: string[];
}

export interface AuditCorrelationDurationHistogramSummary {
  tenant_id: string;
  generated_at: string;
  total_correlations: number;
  total_events_with_correlation: number;
  buckets: CorrelationDurationBucketRow[];
  peak_bucket: CorrelationDurationBucket | null;
  peak_count: number;
  /** Mean duration_ms across all correlations (rounded); null on empty. */
  mean_duration_ms: number | null;
  /** Median duration_ms (M3.5 linear-interpolation); null on empty. */
  median_duration_ms: number | null;
  /** p95 duration_ms; null on empty. */
  p95_duration_ms: number | null;
  /** Longest correlation (id + duration_ms); null on empty. */
  longest_correlation: { correlation_id: string; duration_ms: number } | null;
  /** Subset where has_failure=true; sorted duration_ms desc + correlation_id asc tie-break. */
  failed_correlations: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────

function classifyDuration(duration_ms: number): CorrelationDurationBucket {
  for (const b of ALL_CORRELATION_DURATION_BUCKETS) {
    const def = BUCKET_DEFS[b];
    if (def.max_ms === null) return b;
    if (duration_ms < def.max_ms) return b;
  }
  return 'day_plus'; // unreachable
}

/** Linear-interpolation percentile (Excel/R type 7), same as M3.5. */
function percentile(sortedAsc: readonly number[], pct: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const rank = (pct / 100) * (n - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedAsc[lower];
  const frac = rank - lower;
  return sortedAsc[lower] + frac * (sortedAsc[upper] - sortedAsc[lower]);
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildAuditCorrelationDurationHistogram(
  tenant_id: string,
  events: readonly AuditEvent[],
  now: Date,
): AuditCorrelationDurationHistogramSummary {
  // Group events by correlation_id; events with null correlation_id are
  // counted in total_events but excluded from correlation analysis.
  type Group = {
    correlation_id: string;
    first_ts: string;
    last_ts: string;
    event_count: number;
    has_failure: boolean;
  };
  const groups = new Map<string, Group>();
  let total_events_with_correlation = 0;

  for (const e of events) {
    if (!e.correlation_id) continue;
    total_events_with_correlation++;
    let g = groups.get(e.correlation_id);
    if (!g) {
      g = {
        correlation_id: e.correlation_id,
        first_ts: e.ts,
        last_ts: e.ts,
        event_count: 0,
        has_failure: false,
      };
      groups.set(e.correlation_id, g);
    }
    g.event_count++;
    if (e.ts < g.first_ts) g.first_ts = e.ts;
    if (e.ts > g.last_ts) g.last_ts = e.ts;
    if (e.outcome !== 'success') g.has_failure = true;
  }

  // Compute durations per correlation.
  type Enriched = Group & { duration_ms: number };
  const enriched: Enriched[] = [];
  for (const g of groups.values()) {
    const firstMs = new Date(g.first_ts).getTime();
    const lastMs = new Date(g.last_ts).getTime();
    if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) continue;
    const duration_ms = Math.max(0, lastMs - firstMs);
    enriched.push({ ...g, duration_ms });
  }

  // Initialise per-bucket structures.
  const buckets: Record<CorrelationDurationBucket, CorrelationDurationBucketRow> = {} as never;
  for (const b of ALL_CORRELATION_DURATION_BUCKETS) {
    const def = BUCKET_DEFS[b];
    buckets[b] = {
      bucket: b,
      label: def.label,
      min_ms: def.min_ms,
      max_ms: def.max_ms,
      count: 0,
      has_failure_count: 0,
      sample_correlation_ids: [],
    };
  }

  // Candidate pool per bucket for sampling.
  const candidates: Record<CorrelationDurationBucket, Enriched[]> = {} as never;
  for (const b of ALL_CORRELATION_DURATION_BUCKETS) candidates[b] = [];

  for (const g of enriched) {
    const b = classifyDuration(g.duration_ms);
    buckets[b].count++;
    if (g.has_failure) buckets[b].has_failure_count++;
    candidates[b].push(g);
  }

  // Finalise samples — sort by duration_ms desc within bucket (longest
  // first), correlation_id asc tie-break.
  for (const b of ALL_CORRELATION_DURATION_BUCKETS) {
    candidates[b].sort((x, y) => {
      if (y.duration_ms !== x.duration_ms) return y.duration_ms - x.duration_ms;
      return x.correlation_id.localeCompare(y.correlation_id);
    });
    buckets[b].sample_correlation_ids = candidates[b]
      .slice(0, 3)
      .map((g) => g.correlation_id);
  }

  // peak_bucket — highest count + canonical iteration tie-break.
  let peak_bucket: CorrelationDurationBucket | null = null;
  let peak_count = 0;
  for (const b of ALL_CORRELATION_DURATION_BUCKETS) {
    if (buckets[b].count > peak_count) {
      peak_count = buckets[b].count;
      peak_bucket = b;
    }
  }
  if (peak_count === 0) peak_bucket = null;

  // mean / median / p95 across full distribution.
  const sorted = enriched.map((g) => g.duration_ms).sort((a, b) => a - b);
  const mean_duration_ms = sorted.length === 0
    ? null
    : Math.round(sorted.reduce((acc, x) => acc + x, 0) / sorted.length);
  const median_duration_ms = sorted.length === 0
    ? null
    : Math.round(percentile(sorted, 50) ?? 0);
  const p95_duration_ms = sorted.length === 0
    ? null
    : Math.round(percentile(sorted, 95) ?? 0);

  // longest_correlation — top by duration_ms (correlation_id asc tie-break).
  let longest_correlation: { correlation_id: string; duration_ms: number } | null = null;
  if (enriched.length > 0) {
    const sortedByDuration = [...enriched].sort((a, b) => {
      if (b.duration_ms !== a.duration_ms) return b.duration_ms - a.duration_ms;
      return a.correlation_id.localeCompare(b.correlation_id);
    });
    longest_correlation = {
      correlation_id: sortedByDuration[0].correlation_id,
      duration_ms: sortedByDuration[0].duration_ms,
    };
  }

  // failed_correlations — subset with has_failure=true; sorted desc + asc.
  const failed_correlations = [...enriched]
    .filter((g) => g.has_failure)
    .sort((a, b) => {
      if (b.duration_ms !== a.duration_ms) return b.duration_ms - a.duration_ms;
      return a.correlation_id.localeCompare(b.correlation_id);
    })
    .map((g) => g.correlation_id);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_correlations: enriched.length,
    total_events_with_correlation,
    buckets: ALL_CORRELATION_DURATION_BUCKETS.map((b) => buckets[b]),
    peak_bucket,
    peak_count,
    mean_duration_ms,
    median_duration_ms,
    p95_duration_ms,
    longest_correlation,
    failed_correlations,
  };
}
