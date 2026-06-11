// services/bff/src/model_performance_benchmark.ts
//
// T6 M7.24 — Model performance benchmark comparison.
//
// For each model in the M7.1 registry, compare its latest performance
// metrics against industry benchmarks.

import type { AiModelRegistry, ModelType } from './ai_model_registry';
import type { ModelPerformanceStore } from './model_performance';

// ─── Public types ──────────────────────────────────────────────────────

export const BENCHMARK_AUC: Partial<Record<ModelType, number>> = {
  pd: 0.75,
  fraud: 0.85,
  churn: 0.70,
  lapse: 0.72,
  // anomaly: N/A — no standard benchmark
};

export const BENCHMARK_MAE: Partial<Record<ModelType, number>> = {
  claim_severity: 90000,
};

export interface ModelBenchmarkEntry {
  model_id: string;
  name: string;
  type: ModelType;
  status: string;
  latest_auc: number | null;
  benchmark_auc: number | null;
  exceeds_benchmark: boolean | null;
  gap: number | null; // latest_auc - benchmark_auc; null if either null
}

export interface ModelPerformanceBenchmarkResult {
  tenant_id: string;
  generated_at: string;
  models: ModelBenchmarkEntry[];
  models_above_benchmark: number;
  models_below_benchmark: number;
  benchmark_definitions: Record<string, number>;
}

// ─── Main function ────────────────────────────────────────────────────

export function computeModelPerformanceBenchmark(
  tenant_id: string,
  registry: AiModelRegistry,
  performanceStore: ModelPerformanceStore,
  now: Date,
): ModelPerformanceBenchmarkResult {
  const allModels = registry.list();
  const entries: ModelBenchmarkEntry[] = [];

  for (const model of allModels) {
    const perfEntries = performanceStore.list(tenant_id, model.model_id, {});

    // Find latest AUC entry
    const aucEntries = perfEntries
      .filter((e) => e.metric === 'auc')
      .sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1));

    const latest_auc = aucEntries.length > 0 ? aucEntries[0].value : null;
    const benchmark_auc = BENCHMARK_AUC[model.type] ?? null;

    let exceeds_benchmark: boolean | null = null;
    let gap: number | null = null;

    if (latest_auc !== null && benchmark_auc !== null) {
      exceeds_benchmark = latest_auc > benchmark_auc;
      gap = Math.round((latest_auc - benchmark_auc) * 10000) / 10000;
    }

    entries.push({
      model_id: model.model_id,
      name: model.name,
      type: model.type,
      status: model.status,
      latest_auc,
      benchmark_auc,
      exceeds_benchmark,
      gap,
    });
  }

  // Sort: production first, then by gap desc (best to worst)
  entries.sort((a, b) => {
    const aProd = a.status === 'production' ? 0 : 1;
    const bProd = b.status === 'production' ? 0 : 1;
    if (aProd !== bProd) return aProd - bProd;
    const aGap = a.gap ?? -Infinity;
    const bGap = b.gap ?? -Infinity;
    return bGap - aGap;
  });

  const models_above_benchmark = entries.filter((e) => e.exceeds_benchmark === true).length;
  const models_below_benchmark = entries.filter((e) => e.exceeds_benchmark === false).length;

  // Combine benchmark definitions
  const benchmark_definitions: Record<string, number> = {};
  for (const [type, val] of Object.entries(BENCHMARK_AUC)) {
    if (val !== undefined) benchmark_definitions[`${type}_auc`] = val;
  }
  for (const [type, val] of Object.entries(BENCHMARK_MAE)) {
    if (val !== undefined) benchmark_definitions[`${type}_mae`] = val;
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    models: entries,
    models_above_benchmark,
    models_below_benchmark,
    benchmark_definitions,
  };
}
