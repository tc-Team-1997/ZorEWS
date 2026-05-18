// services/bff/src/connector_run_latency_histogram.ts
//
// T6 M3.16 — Connector run latency histogram.
//
// M3.5 ships per-connector run analytics (mean / p50 / p95 / max
// duration for one connector's window). M3.6 ships failure pattern
// clustering. M3.12 ships fleet hourly volume.
//
// M3.16 lands the FLEET-WIDE LATENCY DISTRIBUTION histogram across
// every connector in the registry. For each ConnectorRun in the
// window: compute duration_ms = finished_at − started_at; bucket into
// 5 canonical bands (instant / fast / medium / slow / day_plus).
// Still-running runs (finished_at=null) get a separate
// `still_running` bucket so they don't pollute the duration math.
//
// Mirror of M7.15 (promotion latency histogram) + M8.12 (alert
// ack-time histogram) + M9.11 (case age buckets) + M15.16 (audit
// correlation duration) pattern for the ingestion run surface.
//
// Drives BIL ops "how long do our ingestion runs typically take? are
// any connectors running excessively slow?" answers in one round-trip.
//
// Pure resolver — iterates registry, drains per-connector runs.

import type {
  Connector,
  ConnectorRun,
  IngestionRegistry,
  RunStatus,
} from './ingestion';

// ─── Canonical buckets ─────────────────────────────────────────────────

export type RunLatencyBucket =
  | 'instant'      // [0, 1s)
  | 'fast'         // [1s, 1m)
  | 'medium'       // [1m, 10m)
  | 'slow'         // [10m, 1h)
  | 'very_slow'    // >= 1h
  | 'still_running';

export const ALL_RUN_LATENCY_BUCKETS: readonly RunLatencyBucket[] = [
  'instant',
  'fast',
  'medium',
  'slow',
  'very_slow',
  'still_running',
] as const;

interface BucketDef {
  bucket: RunLatencyBucket;
  label: string;
  min_ms: number | null;
  max_ms: number | null;
}

const MS_SEC = 1000;
const MS_MIN = 60 * MS_SEC;
const MS_10MIN = 10 * MS_MIN;
const MS_HOUR = 60 * MS_MIN;

const BUCKET_DEFS: Record<RunLatencyBucket, BucketDef> = {
  instant: { bucket: 'instant', label: '< 1 second', min_ms: 0, max_ms: MS_SEC },
  fast: { bucket: 'fast', label: '1s – 1m', min_ms: MS_SEC, max_ms: MS_MIN },
  medium: { bucket: 'medium', label: '1m – 10m', min_ms: MS_MIN, max_ms: MS_10MIN },
  slow: { bucket: 'slow', label: '10m – 1h', min_ms: MS_10MIN, max_ms: MS_HOUR },
  very_slow: { bucket: 'very_slow', label: '> 1h', min_ms: MS_HOUR, max_ms: null },
  still_running: {
    bucket: 'still_running',
    label: 'Still running',
    min_ms: null,
    max_ms: null,
  },
};

// ─── Public types ──────────────────────────────────────────────────────

export interface ConnectorRunLatencyBucketRow {
  bucket: RunLatencyBucket;
  label: string;
  min_ms: number | null;
  max_ms: number | null;
  count: number;
  /** Per-status counts; every RunStatus key present at 0 when absent. */
  by_status: Record<RunStatus, number>;
  /** Distinct connector_ids contributing to this bucket. */
  distinct_connectors: number;
  /** Top-3 samples within bucket (longest-duration first for finished
   *  buckets; oldest started_at first for still_running). */
  samples: Array<{
    run_id: string;
    connector_id: string;
    duration_ms: number | null;
    started_at: string;
    finished_at: string | null;
    status: RunStatus;
  }>;
}

export interface ConnectorRunLatencyHistogramSummary {
  tenant_id: string;
  generated_at: string;
  per_connector_limit: number;
  total_connectors: number;
  total_runs: number;
  total_finished_runs: number;
  total_still_running: number;
  buckets: ConnectorRunLatencyBucketRow[];
  /** Highest-count bucket; canonical iteration tie-break (instant
   *  beats fast at tied); null when no runs. */
  peak_bucket: RunLatencyBucket | null;
  peak_count: number;
  /** Mean / p50 / p95 over FINISHED runs only; null when no finished. */
  mean_duration_ms: number | null;
  median_duration_ms: number | null;
  p95_duration_ms: number | null;
  /** Slowest finished run (run_id + connector_id + duration_ms);
   *  null when no finished. */
  slowest_run: {
    run_id: string;
    connector_id: string;
    duration_ms: number;
  } | null;
}

const PER_CONNECTOR_LIMIT = 200;

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByStatus(): Record<RunStatus, number> {
  return { success: 0, failure: 0, partial: 0, running: 0 };
}

function classifyDuration(duration_ms: number): RunLatencyBucket {
  if (duration_ms < MS_SEC) return 'instant';
  if (duration_ms < MS_MIN) return 'fast';
  if (duration_ms < MS_10MIN) return 'medium';
  if (duration_ms < MS_HOUR) return 'slow';
  return 'very_slow';
}

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

export function buildConnectorRunLatencyHistogram(
  registry: IngestionRegistry,
  tenant_id: string,
  now: Date,
): ConnectorRunLatencyHistogramSummary {
  const connectors: Connector[] = registry.list(tenant_id);

  // Per-bucket structures.
  type Cand = {
    run: ConnectorRun;
    duration_ms: number | null;
  };
  const candidates: Record<RunLatencyBucket, Cand[]> = {} as never;
  const distinctConnectorIds: Record<RunLatencyBucket, Set<string>> = {} as never;
  const buckets: Record<RunLatencyBucket, ConnectorRunLatencyBucketRow> = {} as never;
  for (const b of ALL_RUN_LATENCY_BUCKETS) {
    const def = BUCKET_DEFS[b];
    candidates[b] = [];
    distinctConnectorIds[b] = new Set<string>();
    buckets[b] = {
      bucket: b,
      label: def.label,
      min_ms: def.min_ms,
      max_ms: def.max_ms,
      count: 0,
      by_status: emptyByStatus(),
      distinct_connectors: 0,
      samples: [],
    };
  }

  const finishedDurations: number[] = [];
  let total_runs = 0;
  let total_finished_runs = 0;
  let total_still_running = 0;

  for (const c of connectors) {
    const runs = registry.listRuns(tenant_id, c.id, PER_CONNECTOR_LIMIT);
    for (const r of runs) {
      total_runs++;
      const startedMs = new Date(r.started_at).getTime();

      if (r.finished_at) {
        const finishedMs = new Date(r.finished_at).getTime();
        if (Number.isFinite(startedMs) && Number.isFinite(finishedMs)) {
          const duration_ms = Math.max(0, finishedMs - startedMs);
          total_finished_runs++;
          finishedDurations.push(duration_ms);
          const b = classifyDuration(duration_ms);
          buckets[b].count++;
          buckets[b].by_status[r.status]++;
          distinctConnectorIds[b].add(r.connector_id);
          candidates[b].push({ run: r, duration_ms });
        }
      } else {
        total_still_running++;
        buckets.still_running.count++;
        buckets.still_running.by_status[r.status]++;
        distinctConnectorIds.still_running.add(r.connector_id);
        candidates.still_running.push({ run: r, duration_ms: null });
      }
    }
  }

  // Finalise samples — longest-first for finished buckets; oldest-
  // started for still_running (longest-waiting top of mind).
  for (const b of ALL_RUN_LATENCY_BUCKETS) {
    buckets[b].distinct_connectors = distinctConnectorIds[b].size;
    if (b === 'still_running') {
      candidates[b].sort((x, y) => x.run.started_at.localeCompare(y.run.started_at));
    } else {
      candidates[b].sort((x, y) => {
        const xd = x.duration_ms ?? 0;
        const yd = y.duration_ms ?? 0;
        if (yd !== xd) return yd - xd;
        return x.run.run_id.localeCompare(y.run.run_id);
      });
    }
    buckets[b].samples = candidates[b].slice(0, 3).map((c) => ({
      run_id: c.run.run_id,
      connector_id: c.run.connector_id,
      duration_ms: c.duration_ms,
      started_at: c.run.started_at,
      finished_at: c.run.finished_at,
      status: c.run.status,
    }));
  }

  // peak_bucket — highest count, canonical tie-break via iteration.
  let peak_bucket: RunLatencyBucket | null = null;
  let peak_count = 0;
  for (const b of ALL_RUN_LATENCY_BUCKETS) {
    if (buckets[b].count > peak_count) {
      peak_count = buckets[b].count;
      peak_bucket = b;
    }
  }
  if (peak_count === 0) peak_bucket = null;

  // mean / p50 / p95 over finished durations only.
  const sorted = [...finishedDurations].sort((a, b) => a - b);
  const mean_duration_ms = sorted.length === 0
    ? null
    : Math.round(sorted.reduce((acc, x) => acc + x, 0) / sorted.length);
  const median_duration_ms = sorted.length === 0
    ? null
    : Math.round(percentile(sorted, 50) ?? 0);
  const p95_duration_ms = sorted.length === 0
    ? null
    : Math.round(percentile(sorted, 95) ?? 0);

  // slowest_run — across all finished buckets (find the candidate with
  // largest duration_ms; canonical run_id asc tie-break).
  let slowest_run:
    | { run_id: string; connector_id: string; duration_ms: number }
    | null = null;
  let bestDuration = -1;
  for (const b of ALL_RUN_LATENCY_BUCKETS) {
    if (b === 'still_running') continue;
    for (const c of candidates[b]) {
      if (c.duration_ms === null) continue;
      if (
        c.duration_ms > bestDuration ||
        (c.duration_ms === bestDuration &&
          slowest_run &&
          c.run.run_id < slowest_run.run_id)
      ) {
        bestDuration = c.duration_ms;
        slowest_run = {
          run_id: c.run.run_id,
          connector_id: c.run.connector_id,
          duration_ms: c.duration_ms,
        };
      }
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    per_connector_limit: PER_CONNECTOR_LIMIT,
    total_connectors: connectors.length,
    total_runs,
    total_finished_runs,
    total_still_running,
    buckets: ALL_RUN_LATENCY_BUCKETS.map((b) => buckets[b]),
    peak_bucket,
    peak_count,
    mean_duration_ms,
    median_duration_ms,
    p95_duration_ms,
    slowest_run,
  };
}
