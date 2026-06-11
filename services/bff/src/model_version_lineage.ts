// services/bff/src/model_version_lineage.ts
// T6 M7.28 — Model version lineage tracker.

import { defaultAiModelRegistry, type AiModelRegistry } from './ai_model_registry';

export interface ModelLineageRow {
  type: string;
  version_count: number;
  oldest_version_id: string | null;
  latest_version_id: string | null;
  avg_days_between_versions: number | null;
  generation_improvement: number | null;
}

export interface ModelVersionLineage {
  tenant_id: string;
  generated_at: string;
  by_type: ModelLineageRow[];
  most_iterated_type: string | null;
  avg_generations_across_types: number;
}

const ALL_MODEL_TYPES = ['pd', 'fraud', 'churn', 'lapse', 'anomaly', 'claim_severity'] as const;

export function buildModelVersionLineage(
  registry: AiModelRegistry,
  tenant_id: string,
  now: Date,
): ModelVersionLineage {
  const by_type: ModelLineageRow[] = ALL_MODEL_TYPES.map((type) => {
    const versions = registry.list({ type }).sort((a, b) => a.trained_at < b.trained_at ? -1 : 1);
    const version_count = versions.length;
    if (version_count === 0) return { type, version_count: 0, oldest_version_id: null, latest_version_id: null, avg_days_between_versions: null, generation_improvement: null };

    const oldest_version_id = versions[0].model_id;
    const latest_version_id = versions[version_count - 1].model_id;

    let avg_days_between_versions: number | null = null;
    if (version_count >= 2) {
      const firstMs = new Date(versions[0].trained_at).getTime();
      const lastMs = new Date(versions[version_count - 1].trained_at).getTime();
      const totalDays = (lastMs - firstMs) / 86400000;
      avg_days_between_versions = Math.round((totalDays / (version_count - 1)) * 10) / 10;
    }

    let generation_improvement: number | null = null;
    if (version_count >= 2) {
      const oldestAuc = versions[0].metrics?.auc ?? null;
      const latestAuc = versions[version_count - 1].metrics?.auc ?? null;
      if (oldestAuc !== null && latestAuc !== null) {
        generation_improvement = Math.round((latestAuc - oldestAuc) * 10000) / 10000;
      }
    }

    return { type, version_count, oldest_version_id, latest_version_id, avg_days_between_versions, generation_improvement };
  });

  const nonZero = by_type.filter((r) => r.version_count > 0);
  let most_iterated_type: string | null = null;
  if (nonZero.length > 0) {
    most_iterated_type = nonZero.reduce((max, r) => r.version_count > max.version_count ? r : max).type;
  }

  const avg_generations_across_types = by_type.length > 0
    ? Math.round((by_type.reduce((s, r) => s + r.version_count, 0) / by_type.length) * 100) / 100
    : 0;

  return { tenant_id, generated_at: now.toISOString(), by_type, most_iterated_type, avg_generations_across_types };
}

export { defaultAiModelRegistry };
