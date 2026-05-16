// services/bff/src/ai_model_framework_distribution.ts
//
// T6 M7.13 — AI model framework distribution.
//
// M7.12 ships the type coverage matrix (pivot by ModelType).
// M7.13 ships the orthogonal framework axis: per ModelFramework
// (xgboost / sklearn / torch / lightgbm / isolation_forest),
// surface count + by_status + by_type + has_production +
// production_count + most_recent_trained_at + model_ids.
//
// Use case: BIL AI governance committee wants to answer "what's
// our ML-framework mix? are we over-indexed on xgboost? do we have
// production deployments using each framework or are some still
// only experimental?" in one round-trip.
//
// Mirror of M7.12 (type) + M5.16 / M11.11 / M14.27 pivot pattern.

import type {
  AiModelRegistry,
  ModelFramework,
  ModelStatus,
  ModelType,
  ModelVersion,
} from './ai_model_registry';

// ─── Canonical enum orders ────────────────────────────────────────────

export const ALL_MODEL_FRAMEWORKS: readonly ModelFramework[] = [
  'xgboost',
  'sklearn',
  'torch',
  'lightgbm',
  'isolation_forest',
] as const;

const ALL_STATUSES: readonly ModelStatus[] = [
  'experimental',
  'staging',
  'production',
  'shadow',
  'retired',
] as const;

const ALL_TYPES: readonly ModelType[] = [
  'pd',
  'fraud',
  'churn',
  'lapse',
  'anomaly',
  'claim_severity',
] as const;

// ─── Public types ─────────────────────────────────────────────────────

export interface ModelFrameworkRow {
  framework: ModelFramework;
  count: number;
  /** Per-ModelStatus count; every key present at 0 when absent. */
  by_status: Record<ModelStatus, number>;
  /** Per-ModelType count; every key present at 0 when absent. */
  by_type: Record<ModelType, number>;
  /** = by_status.production > 0. */
  has_production: boolean;
  /** Convenience copy of by_status.production. */
  production_count: number;
  /** Newest trained_at across versions of this framework. null when count=0. */
  most_recent_trained_at: string | null;
  /** All model_ids using this framework, sorted asc. */
  model_ids: string[];
}

export interface ModelFrameworkDistributionSummary {
  generated_at: string;
  total_models: number;
  /** Every ModelFramework in canonical order even when zero-count. */
  frameworks: ModelFrameworkRow[];
  /** Highest count framework. Canonical-order tie-break (xgboost
   *  beats sklearn at same count). null when no models. */
  most_common_framework: ModelFramework | null;
  /** Frameworks with count=0 in canonical order. */
  unused_frameworks: ModelFramework[];
  /** Framework with the highest production_count. Canonical-order
   *  tie-break. null when no production model in registry. */
  framework_with_most_production: {
    framework: ModelFramework;
    production_count: number;
  } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByStatus(): Record<ModelStatus, number> {
  return { experimental: 0, staging: 0, production: 0, shadow: 0, retired: 0 };
}

function emptyByType(): Record<ModelType, number> {
  return { pd: 0, fraud: 0, churn: 0, lapse: 0, anomaly: 0, claim_severity: 0 };
}

function buildRow(framework: ModelFramework, versions: ModelVersion[]): ModelFrameworkRow {
  const by_status = emptyByStatus();
  const by_type = emptyByType();
  let most_recent_trained_at: string | null = null;

  for (const v of versions) {
    if (ALL_STATUSES.includes(v.status)) by_status[v.status]++;
    if (ALL_TYPES.includes(v.type)) by_type[v.type]++;
    if (!most_recent_trained_at || v.trained_at > most_recent_trained_at) {
      most_recent_trained_at = v.trained_at;
    }
  }

  const production_count = by_status.production;

  return {
    framework,
    count: versions.length,
    by_status,
    by_type,
    has_production: production_count > 0,
    production_count,
    most_recent_trained_at,
    model_ids: versions.map((v) => v.model_id).sort(),
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeModelFrameworkDistribution(
  registry: AiModelRegistry,
  now: Date,
): ModelFrameworkDistributionSummary {
  // Group all models by framework. Use list() with no filter then
  // partition — single registry call instead of per-framework filtered
  // calls, since the registry doesn't expose a framework filter.
  const all = registry.list();
  const byFramework = new Map<ModelFramework, ModelVersion[]>();
  for (const f of ALL_MODEL_FRAMEWORKS) byFramework.set(f, []);
  for (const v of all) {
    if (!ALL_MODEL_FRAMEWORKS.includes(v.framework)) continue;
    byFramework.get(v.framework)!.push(v);
  }

  const frameworks: ModelFrameworkRow[] = ALL_MODEL_FRAMEWORKS.map((f) =>
    buildRow(f, byFramework.get(f)!),
  );

  // most_common_framework: highest count with canonical tie-break.
  let most_common_framework: ModelFramework | null = null;
  let mostCount = 0;
  for (const f of ALL_MODEL_FRAMEWORKS) {
    const row = frameworks.find((r) => r.framework === f)!;
    if (row.count > mostCount) {
      mostCount = row.count;
      most_common_framework = f;
    }
  }
  if (mostCount === 0) most_common_framework = null;

  const unused_frameworks = ALL_MODEL_FRAMEWORKS.filter(
    (f) => frameworks.find((r) => r.framework === f)!.count === 0,
  );

  // framework_with_most_production: highest production_count with
  // canonical tie-break.
  let framework_with_most_production: ModelFrameworkDistributionSummary['framework_with_most_production'] = null;
  let mostProd = 0;
  for (const f of ALL_MODEL_FRAMEWORKS) {
    const row = frameworks.find((r) => r.framework === f)!;
    if (row.production_count > mostProd) {
      mostProd = row.production_count;
      framework_with_most_production = {
        framework: f,
        production_count: row.production_count,
      };
    }
  }
  if (mostProd === 0) framework_with_most_production = null;

  return {
    generated_at: now.toISOString(),
    total_models: all.length,
    frameworks,
    most_common_framework,
    unused_frameworks,
    framework_with_most_production,
  };
}
