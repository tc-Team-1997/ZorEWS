// services/bff/src/model_performance_trend.ts
//
// T6 M7.8 — Model performance metric trend.
//
// M7.5 ships the append-only telemetry store. M7.6 emits a printable
// summary. M7.7 detects per-entry outliers via z-score. M7.8 emits
// a TIME-SERIES trend: linear-regression slope over the metric's
// values vs `recorded_at`, plus first/last/abs_change so the SPA
// can render a "↗ 0.04/day over 12 samples" badge.
//
// Pure — no I/O. Caller passes the entries already filtered to the
// model + metric + time window of interest.
//
// Sign convention is metric-neutral: positive slope = value
// increasing over time. The SPA decides whether that's "improving"
// (auc) or "declining" (drift_score, calibration_err) by consulting
// each metric's polarity table.

import type {
  ModelPerformanceEntry,
  PerformanceMetric,
} from './model_performance';

// ─── Public types ─────────────────────────────────────────────────────

export interface MetricTrend {
  metric: PerformanceMetric;
  sample_size: number;
  /** Mean of all observed values across the window. */
  mean: number;
  /** Oldest entry's value (by recorded_at asc). */
  first_value: number;
  first_at: string;
  /** Newest entry's value. */
  last_value: number;
  last_at: string;
  /** last_value - first_value. */
  abs_change: number;
  /** Percentage change vs first_value. null when first_value === 0
   *  (divide-by-zero). */
  abs_change_pct: number | null;
  /** Least-squares slope over (recorded_at_unix_days, value). Positive
   *  = value increasing. Caller maps to "improving"/"declining" per
   *  metric polarity. null when sample_size < 2. */
  slope_per_day: number | null;
}

// ─── Pure trend extractor ─────────────────────────────────────────────

/**
 * Pure trend extractor for a single metric. Returns null when there
 * are fewer than 2 entries (a single point has no trend).
 */
export function computeMetricTrend(
  entries: readonly ModelPerformanceEntry[],
  metric: PerformanceMetric,
): MetricTrend | null {
  const filtered = entries.filter((e) => e.metric === metric);
  if (filtered.length === 0) return null;
  // Sort oldest-first for first/last semantics + slope x-values.
  const sorted = [...filtered].sort((a, b) =>
    a.recorded_at < b.recorded_at ? -1 : a.recorded_at > b.recorded_at ? 1 : 0,
  );
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const values = sorted.map((e) => e.value);
  const sum = values.reduce((s, v) => s + v, 0);
  const mean = sum / values.length;
  const abs_change = last.value - first.value;
  const abs_change_pct =
    first.value === 0 ? null : (abs_change / Math.abs(first.value)) * 100;

  // Least-squares slope where x = days-since-first, y = value.
  let slope_per_day: number | null = null;
  if (sorted.length >= 2) {
    const firstMs = new Date(first.recorded_at).getTime();
    const xs = sorted.map((e) => (new Date(e.recorded_at).getTime() - firstMs) / 86_400_000);
    const xMean = xs.reduce((s, v) => s + v, 0) / xs.length;
    const yMean = mean;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i += 1) {
      const dx = xs[i]! - xMean;
      num += dx * (values[i]! - yMean);
      den += dx * dx;
    }
    // den=0 happens when every entry has the same recorded_at (no
    // time progression) — slope is undefined.
    slope_per_day = den === 0 ? null : num / den;
  }

  return {
    metric,
    sample_size: sorted.length,
    mean,
    first_value: first.value,
    first_at: first.recorded_at,
    last_value: last.value,
    last_at: last.recorded_at,
    abs_change,
    abs_change_pct,
    slope_per_day,
  };
}
