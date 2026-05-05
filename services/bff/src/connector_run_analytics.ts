// services/bff/src/connector_run_analytics.ts
//
// T6 M3.5 — Connector run analytics.
//
// Pure aggregator that consumes existing M3.1 `ConnectorRun`
// records and rolls them up into the metrics an SRE watches
// during a staged connector rollout: success rate, latency
// percentiles, throughput.
//
// Design:
//  - Pure function. No I/O, no clock dependency. Caller supplies
//    the run window (typically the last N runs from
//    IngestionRegistry.listRuns). Default window 20, max 200 —
//    this is the rollout-monitoring band, not a long-tail BI view.
//  - Only FINISHED runs (finished_at != null) contribute to
//    duration / status percentiles. In-flight runs are surfaced
//    separately as `in_flight_count` so the SPA can show "5
//    completed, 1 still running" without polluting averages.
//  - Percentiles use linear interpolation between the two
//    bracketing samples (the standard "type 7" definition Excel
//    PERCENTILE uses). Avoids the bias of nearest-rank for small
//    windows.

import { type ConnectorRun, type RunStatus } from './ingestion';

// ─── Public types ─────────────────────────────────────────────────────

export interface RunAnalytics {
  /** Number of runs the analytics is computed over. */
  sample_size: number;
  /** Runs not yet finished — surface separately, not folded in. */
  in_flight_count: number;
  /** Buckets for the finished runs. */
  by_status: Record<RunStatus, number>;
  /** finished_count - failure_count) / finished_count.
   *  null when no finished runs. */
  success_rate: number | null;
  /** Duration metrics across FINISHED runs. null fields when none. */
  duration_ms: {
    min: number | null;
    mean: number | null;
    p50: number | null;
    p95: number | null;
    max: number | null;
  };
  /** Total records_processed across finished runs. */
  records_processed_total: number;
  /** Total records_failed across finished runs. */
  records_failed_total: number;
  /** Most recent failure message (if any), with the run_id. */
  last_failure: { run_id: string; finished_at: string; error_message: string } | null;
}

// ─── Pure math ────────────────────────────────────────────────────────

/** Linear-interpolation percentile (Excel PERCENTILE / R type 7).
 *  Returns null when the input is empty. p in [0, 1]. */
export function linearPercentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (p <= 0) return sorted[0]!;
  if (p >= 1) return sorted[sorted.length - 1]!;
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

function durationMs(r: ConnectorRun): number | null {
  if (!r.finished_at) return null;
  return new Date(r.finished_at).getTime() - new Date(r.started_at).getTime();
}

// ─── Aggregator ───────────────────────────────────────────────────────

/**
 * Roll up a window of ConnectorRun records into RunAnalytics.
 * Caller is responsible for slicing the window before calling
 * (typically `listRuns(..., window)`).
 *
 * `window` here is just used for documentation in the response
 * shape — the actual window is whatever `runs[]` you passed.
 */
export function aggregateRunAnalytics(runs: readonly ConnectorRun[]): RunAnalytics {
  const finished = runs.filter((r) => r.finished_at !== null);
  const in_flight_count = runs.length - finished.length;

  const by_status: Record<RunStatus, number> = {
    success: 0,
    failure: 0,
    partial: 0,
    running: in_flight_count,
  };
  for (const r of finished) {
    if (r.status === 'success' || r.status === 'failure' || r.status === 'partial') {
      by_status[r.status] += 1;
    }
  }

  // Latency distribution
  const durations: number[] = finished
    .map(durationMs)
    .filter((d): d is number => d !== null && d >= 0);
  durations.sort((a, b) => a - b);

  const finishedCount = finished.length;
  const failureCount = by_status.failure + by_status.partial;
  const successRate = finishedCount === 0 ? null : (finishedCount - failureCount) / finishedCount;

  let records_processed_total = 0;
  let records_failed_total = 0;
  for (const r of finished) {
    records_processed_total += r.records_processed;
    records_failed_total += r.records_failed;
  }

  // Last failure = newest by finished_at among failures/partials.
  let last_failure: RunAnalytics['last_failure'] = null;
  for (const r of finished) {
    if (r.status === 'success' || !r.error_message) continue;
    if (!last_failure || r.finished_at! > last_failure.finished_at) {
      last_failure = {
        run_id: r.run_id,
        finished_at: r.finished_at!,
        error_message: r.error_message,
      };
    }
  }

  const mean =
    durations.length === 0
      ? null
      : durations.reduce((s, x) => s + x, 0) / durations.length;

  return {
    sample_size: runs.length,
    in_flight_count,
    by_status,
    success_rate: successRate,
    duration_ms: {
      min: durations.length === 0 ? null : durations[0]!,
      mean,
      p50: linearPercentile(durations, 0.5),
      p95: linearPercentile(durations, 0.95),
      max: durations.length === 0 ? null : durations[durations.length - 1]!,
    },
    records_processed_total,
    records_failed_total,
    last_failure,
  };
}

// ─── Limits surfaced to the route ─────────────────────────────────────

export const RUN_ANALYTICS_DEFAULT_WINDOW = 20;
export const RUN_ANALYTICS_MAX_WINDOW = 200;
