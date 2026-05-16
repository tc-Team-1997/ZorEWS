// services/bff/src/ai_model_type_coverage.ts
//
// T6 M7.12 — AI model type coverage matrix.
//
// M7.1 ships the 6-type model registry. M7.2 ships the promotion
// workflow. M7.9 ships retirement-candidates. M7.11 ships the
// deployment-age histogram. M7.12 closes the missing TYPE-pivot:
// per BIL model type (pd / fraud / churn / lapse / anomaly /
// claim_severity), surface count + by_status + by_framework +
// has_production + production_model_id + most_recent_trained_at.
//
// Use case: BIL AI governance committee wants the answer to
// "where do we have a production deployment vs only staging?"
// in one round-trip. Surfaces coverage gaps — if `lapse` shows
// has_production=false, the committee knows the next graduation
// gate is the lapse model.
//
// Mirror of M5.16 / M11.11 / M7.11 / M12.11 / M3.12 pivot pattern
// (now the de-facto BIL analytics shape: per-key row with
// every-enum-key-present-at-0 + envelope leaderboards).

import type {
  AiModelRegistry,
  ModelFramework,
  ModelStatus,
  ModelType,
  ModelVersion,
} from './ai_model_registry';

// ─── Canonical enum orders ────────────────────────────────────────────

export const ALL_MODEL_TYPES: readonly ModelType[] = [
  'pd',
  'fraud',
  'churn',
  'lapse',
  'anomaly',
  'claim_severity',
] as const;

const ALL_STATUSES: readonly ModelStatus[] = [
  'experimental',
  'staging',
  'production',
  'shadow',
  'retired',
] as const;

const ALL_FRAMEWORKS: readonly ModelFramework[] = [
  'xgboost',
  'sklearn',
  'torch',
  'lightgbm',
  'isolation_forest',
] as const;

// ─── Public types ─────────────────────────────────────────────────────

export interface ModelTypeRow {
  type: ModelType;
  count: number;
  /** Per-ModelStatus count; every key present at 0 when absent. */
  by_status: Record<ModelStatus, number>;
  /** Per-ModelFramework count; every key present at 0 when absent. */
  by_framework: Record<ModelFramework, number>;
  /** Has at least one model in `production` status. */
  has_production: boolean;
  /** The model_id of the production model. null when has_production=false.
   *  When (hypothetically) >1 production version exists, the most recently
   *  trained wins (matches the SPA's "current production" semantics). */
  production_model_id: string | null;
  /** Newest trained_at across all versions of this type. null when count=0. */
  most_recent_trained_at: string | null;
  /** Count of distinct frameworks used across versions of this type. */
  distinct_frameworks: number;
}

export interface ModelTypeCoverageSummary {
  generated_at: string;
  total_models: number;
  /** Every ModelType in canonical order even when zero-count. */
  types: ModelTypeRow[];
  /** Subset of types[] where has_production=false. In canonical
   *  ALL_MODEL_TYPES order. The coverage-gap list. */
  types_without_production: ModelType[];
  /** Highest count type. Ties broken by canonical ALL_MODEL_TYPES
   *  order (pd wins over fraud at same count). null when no models. */
  most_supported_type: ModelType | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByStatus(): Record<ModelStatus, number> {
  return {
    experimental: 0,
    staging: 0,
    production: 0,
    shadow: 0,
    retired: 0,
  };
}

function emptyByFramework(): Record<ModelFramework, number> {
  return {
    xgboost: 0,
    sklearn: 0,
    torch: 0,
    lightgbm: 0,
    isolation_forest: 0,
  };
}

function buildRow(type: ModelType, versions: ModelVersion[]): ModelTypeRow {
  const by_status = emptyByStatus();
  const by_framework = emptyByFramework();
  let most_recent_trained_at: string | null = null;
  let production_model_id: string | null = null;
  let production_trained_at: string | null = null;
  const frameworksUsed = new Set<ModelFramework>();

  for (const v of versions) {
    if (ALL_STATUSES.includes(v.status)) by_status[v.status]++;
    if (ALL_FRAMEWORKS.includes(v.framework)) {
      by_framework[v.framework]++;
      frameworksUsed.add(v.framework);
    }
    if (!most_recent_trained_at || v.trained_at > most_recent_trained_at) {
      most_recent_trained_at = v.trained_at;
    }
    if (v.status === 'production') {
      // Most-recently-trained production version wins (matches SPA's
      // "current production" semantics if there's drift between the
      // registry and the promotion engine).
      if (!production_trained_at || v.trained_at > production_trained_at) {
        production_trained_at = v.trained_at;
        production_model_id = v.model_id;
      }
    }
  }

  return {
    type,
    count: versions.length,
    by_status,
    by_framework,
    has_production: by_status.production > 0,
    production_model_id,
    most_recent_trained_at,
    distinct_frameworks: frameworksUsed.size,
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildModelTypeCoverageMatrix(
  registry: AiModelRegistry,
  now: Date,
): ModelTypeCoverageSummary {
  const types: ModelTypeRow[] = [];
  let total_models = 0;

  for (const type of ALL_MODEL_TYPES) {
    const versions = registry.list({ type });
    total_models += versions.length;
    types.push(buildRow(type, versions));
  }

  const types_without_production = ALL_MODEL_TYPES.filter((t) => {
    const row = types.find((r) => r.type === t)!;
    return !row.has_production;
  });

  // most_supported_type: highest count; ties broken by canonical
  // ALL_MODEL_TYPES order via iteration (pd wins over fraud at tie).
  let most_supported_type: ModelType | null = null;
  let mostCount = 0;
  for (const t of ALL_MODEL_TYPES) {
    const row = types.find((r) => r.type === t)!;
    if (row.count > mostCount) {
      mostCount = row.count;
      most_supported_type = t;
    }
  }
  if (mostCount === 0) most_supported_type = null;

  return {
    generated_at: now.toISOString(),
    total_models,
    types,
    types_without_production,
    most_supported_type,
  };
}
