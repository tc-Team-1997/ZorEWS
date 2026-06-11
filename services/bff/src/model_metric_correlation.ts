// services/bff/src/model_metric_correlation.ts
//
// T6 M7.22 — Model performance metric correlation matrix.
//
// For each pair of M7.5 performance metrics with >=3 common observations,
// computes the Pearson correlation coefficient to surface which metrics
// move together.

import type { ModelPerformanceStore, PerformanceMetric } from './model_performance';
import { PERFORMANCE_METRICS } from './model_performance';

// ─── Public types ──────────────────────────────────────────────────────

export type CorrelationInterpretation =
  | 'strong_positive'    // r >= 0.7
  | 'moderate_positive'  // 0.3 <= r < 0.7
  | 'weak'               // |r| < 0.3
  | 'moderate_negative'  // -0.7 < r <= -0.3
  | 'strong_negative';   // r <= -0.7

export interface MetricCorrelationEntry {
  metric_a: PerformanceMetric;
  metric_b: PerformanceMetric;
  /** Pearson r, rounded to 4 decimals. */
  correlation: number;
  interpretation: CorrelationInterpretation;
  /** Number of observations where both metrics were recorded. */
  sample_size: number;
}

export interface ModelMetricCorrelation {
  model_id: string;
  tenant_id: string;
  generated_at: string;
  /** Total perf entries used. */
  entry_count: number;
  /** Pairs with >= 3 common observations, sorted by |correlation| desc. */
  correlations: MetricCorrelationEntry[];
  strongest_correlation: { metric_a: PerformanceMetric; metric_b: PerformanceMetric; correlation: number } | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function interpretCorrelation(r: number): CorrelationInterpretation {
  if (r >= 0.7) return 'strong_positive';
  if (r >= 0.3) return 'moderate_positive';
  if (r <= -0.7) return 'strong_negative';
  if (r <= -0.3) return 'moderate_negative';
  return 'weak';
}

/** Pearson r over two parallel numeric arrays. Returns null if n < 3 or std=0. */
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;

  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;

  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const denom = Math.sqrt(denX * denY);
  if (denom === 0) return null;
  return Math.round((num / denom) * 10000) / 10000;
}

// ─── Pure function ─────────────────────────────────────────────────────

/**
 * buildModelMetricCorrelation
 *
 * @param tenant_id  caller's tenant
 * @param store      ModelPerformanceStore
 * @param model_id   model to analyse
 * @param now        current Date
 */
export async function buildModelMetricCorrelation(
  tenant_id: string,
  store: ModelPerformanceStore,
  model_id: string,
  now: Date,
): Promise<ModelMetricCorrelation> {
  // Collect all entries for this model (store may throw if model unknown)
  let allEntries: import('./model_performance').ModelPerformanceEntry[];
  try {
    allEntries = store.list(tenant_id, model_id, {});
  } catch {
    allEntries = [];
  }

  // Group by recorded_at (ISO), build a map ts → {metric → value}
  // We align on timestamps: two metrics share an observation if they
  // were recorded at the same timestamp.
  const byTs = new Map<string, Partial<Record<PerformanceMetric, number>>>();
  for (const e of allEntries) {
    const slot = byTs.get(e.recorded_at) ?? {};
    slot[e.metric] = e.value;
    byTs.set(e.recorded_at, slot);
  }

  // Build per-metric value arrays aligned on timestamps
  const metricsValues: Partial<Record<PerformanceMetric, number[]>> = {};
  for (const m of PERFORMANCE_METRICS) {
    metricsValues[m] = [];
  }
  for (const slot of byTs.values()) {
    for (const m of PERFORMANCE_METRICS) {
      if (slot[m] !== undefined) {
        metricsValues[m]!.push(slot[m]!);
      }
    }
  }

  // For each (a, b) pair, find common-timestamp observations
  const correlations: MetricCorrelationEntry[] = [];
  const mList = [...PERFORMANCE_METRICS];
  for (let i = 0; i < mList.length; i++) {
    for (let j = i + 1; j < mList.length; j++) {
      const ma = mList[i];
      const mb = mList[j];
      // Find timestamps where BOTH metrics were recorded
      const xs: number[] = [];
      const ys: number[] = [];
      for (const slot of byTs.values()) {
        if (slot[ma] !== undefined && slot[mb] !== undefined) {
          xs.push(slot[ma]!);
          ys.push(slot[mb]!);
        }
      }
      if (xs.length < 3) continue;
      const r = pearson(xs, ys);
      if (r === null) continue;
      correlations.push({
        metric_a: ma,
        metric_b: mb,
        correlation: r,
        interpretation: interpretCorrelation(r),
        sample_size: xs.length,
      });
    }
  }

  // Sort by |correlation| desc, then metric_a asc tie-break
  correlations.sort((a, b) => {
    const da = Math.abs(b.correlation) - Math.abs(a.correlation);
    if (da !== 0) return da;
    return a.metric_a < b.metric_a ? -1 : a.metric_a > b.metric_a ? 1 : 0;
  });

  const strongest_correlation =
    correlations.length > 0
      ? {
          metric_a: correlations[0].metric_a,
          metric_b: correlations[0].metric_b,
          correlation: correlations[0].correlation,
        }
      : null;

  return {
    model_id,
    tenant_id,
    generated_at: now.toISOString(),
    entry_count: allEntries.length,
    correlations,
    strongest_correlation,
  };
}
