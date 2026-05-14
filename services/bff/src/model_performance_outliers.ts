// services/bff/src/model_performance_outliers.ts
//
// T6 M7.7 — Model performance outlier detection.
//
// M7.5 ships the per-(tenant, model) performance ledger; M7.6 the
// printable summary. Both surface what the metric history LOOKS
// LIKE. M7.7 adds the active-alerting layer: given the same ledger
// entries, flag observations that are statistically far from the
// metric's rolling mean — useful for "is this latest reading
// actually concerning?" supervisor dashboards.
//
// Design:
//  - Pure aggregator over `ModelPerformanceEntry[]`. No I/O.
//  - For each metric independently, computes the sample mean +
//    sample standard deviation (Bessel-corrected n-1 denominator
//    when n ≥ 2; std_dev=0 with single entry). Flags entries with
//    |value - mean| > z_threshold * std_dev as outliers.
//  - When std_dev = 0 (all observations identical or single entry),
//    no outliers are produced — z-score is undefined.
//  - z_threshold defaults to 2 (≈ 95% interval under normal
//    assumption). Tunable per call via the resolver param + ?z=
//    query param.
//  - Outliers per metric returned newest-first.

import {
  PERFORMANCE_METRICS,
  type ModelPerformanceEntry,
  type PerformanceMetric,
} from './model_performance';

// ─── Public types ─────────────────────────────────────────────────────

export type OutlierDirection = 'high' | 'low';

export interface OutlierEntry {
  entry_id: string;
  value: number;
  recorded_at: string;
  /** Signed z-score: (value - mean) / std_dev. Positive = above mean. */
  z_score: number;
  direction: OutlierDirection;
}

export interface PerMetricOutliers {
  metric: PerformanceMetric;
  sample_count: number;
  /** null when sample_count = 0. */
  mean: number | null;
  /** Sample std dev (Bessel n-1). null when sample_count < 2. */
  std_dev: number | null;
  /** Outliers newest-first; empty when std_dev is null or 0. */
  outliers: OutlierEntry[];
}

export interface PerformanceOutliersResult {
  /** Total entries the analysis was run over. */
  total_entries: number;
  /** z threshold applied (default 2). */
  z_threshold: number;
  /** Per-metric blocks; only metrics with ≥ 1 entry observed appear.
   *  Empty array when total_entries=0. */
  per_metric: PerMetricOutliers[];
  /** Sum of outliers across all metrics. */
  total_outlier_count: number;
}

export const DEFAULT_Z_THRESHOLD = 2;
export const MIN_Z_THRESHOLD = 0.5;
export const MAX_Z_THRESHOLD = 10;

// ─── Pure aggregator ──────────────────────────────────────────────────

function meanStdDev(values: readonly number[]): { mean: number; std_dev: number | null } {
  const n = values.length;
  if (n === 0) return { mean: 0, std_dev: null };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  if (n < 2) return { mean, std_dev: null };
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  return { mean, std_dev: Math.sqrt(variance) };
}

/**
 * Pure outlier detector. For each metric, computes sample
 * mean + std_dev across the supplied entries and flags entries
 * whose |z-score| exceeds `z_threshold`.
 */
export function detectPerformanceOutliers(
  entries: readonly ModelPerformanceEntry[],
  z_threshold: number = DEFAULT_Z_THRESHOLD,
): PerformanceOutliersResult {
  if (!Number.isFinite(z_threshold) || z_threshold <= 0) {
    z_threshold = DEFAULT_Z_THRESHOLD;
  }
  if (z_threshold < MIN_Z_THRESHOLD) z_threshold = MIN_Z_THRESHOLD;
  if (z_threshold > MAX_Z_THRESHOLD) z_threshold = MAX_Z_THRESHOLD;

  const per_metric: PerMetricOutliers[] = [];
  let total_outlier_count = 0;

  for (const m of PERFORMANCE_METRICS) {
    const subset = entries.filter((e) => e.metric === m);
    if (subset.length === 0) continue;
    const values = subset.map((e) => e.value);
    const { mean, std_dev } = meanStdDev(values);

    const outliers: OutlierEntry[] = [];
    if (std_dev !== null && std_dev > 0) {
      for (const e of subset) {
        const z = (e.value - mean) / std_dev;
        if (Math.abs(z) > z_threshold) {
          outliers.push({
            entry_id: e.entry_id,
            value: e.value,
            recorded_at: e.recorded_at,
            z_score: z,
            direction: z > 0 ? 'high' : 'low',
          });
        }
      }
      // Newest-first by recorded_at (ISO compare is correct).
      outliers.sort((a, b) =>
        a.recorded_at < b.recorded_at ? 1 : a.recorded_at > b.recorded_at ? -1 : 0,
      );
    }

    total_outlier_count += outliers.length;
    per_metric.push({
      metric: m,
      sample_count: subset.length,
      mean: subset.length === 0 ? null : mean,
      std_dev,
      outliers,
    });
  }

  return {
    total_entries: entries.length,
    z_threshold,
    per_metric,
    total_outlier_count,
  };
}
