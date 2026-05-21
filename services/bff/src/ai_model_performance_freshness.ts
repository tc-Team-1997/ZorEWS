// services/bff/src/ai_model_performance_freshness.ts
//
// T6 M7.18 — AI model performance freshness rollup.
//
// For each model in the M7.1 registry, computes "when did we last
// record a performance metric for this model?" using the M7.5 perf
// ledger. Classifies each model into a freshness bucket so ops can
// spot models whose drift may be unseen.
//
// Drives:
//   - "model X has no recent perf data — drift could be unseen"
//     governance signal
//   - quarterly model risk review per `docs/bau-runbook.md` monthly
//     checklist (M7.5 AI metric drift > 2σ)
//   - SaaS admin "are we monitoring all production models?" headline
//
// Pure resolver — accepts the registry's ModelVersion[] + a perf-
// lookup function that returns the most-recent recorded_at per
// model. Route handler drains the perf store per model.

import type {
  ModelStatus,
  ModelType,
  ModelVersion,
} from './ai_model_registry';

// ─── Constants ───────────────────────────────────────────────────────

export const DEFAULT_PERF_FRESH_DAYS = 14;
export const DEFAULT_PERF_STALE_DAYS = 60;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ALL_MODEL_STATUSES: readonly ModelStatus[] = [
  'experimental',
  'staging',
  'production',
  'shadow',
  'retired',
];

const ALL_MODEL_TYPES: readonly ModelType[] = [
  'pd',
  'fraud',
  'churn',
  'lapse',
  'anomaly',
  'claim_severity',
];

// ─── Errors ──────────────────────────────────────────────────────────

export class ModelPerformanceFreshnessError extends Error {
  override name = 'ModelPerformanceFreshnessError';
  constructor(public code: 'invalid_input', message: string) {
    super(message);
  }
}

// ─── Output shapes ────────────────────────────────────────────────────

export type PerfFreshnessBucket = 'recent' | 'stable' | 'stale' | 'never_recorded';

export interface ModelPerfFreshnessRow {
  model_id: string;
  name: string;
  type: ModelType;
  version: string;
  status: ModelStatus;
  /** ISO of most-recent perf record across any metric; null when none. */
  last_recorded_at: string | null;
  /** Floor((now − last_recorded_at) / 86_400_000); null when never recorded. */
  days_since_recorded: number | null;
  freshness: PerfFreshnessBucket;
}

export interface ModelPerformanceFreshnessReport {
  tenant_id: string;
  generated_at: string;
  fresh_days: number;
  stale_days: number;
  total_models: number;
  recent_count: number;
  stable_count: number;
  stale_count: number;
  never_recorded_count: number;
  /** All rows sorted oldest-recorded-first (never_recorded first,
   *  then days_since_recorded desc among the recorded). Tie-break
   *  by model_id asc. */
  models: ModelPerfFreshnessRow[];
  /** Per-status marginal counts — every ModelStatus key present at 0
   *  when absent. */
  by_status: Record<ModelStatus, number>;
  /** Per-type marginal counts — every ModelType key present. */
  by_type: Record<ModelType, number>;
  /** Production-status subset of never_recorded — production models
   *  without perf data are a governance signal. Sorted by model_id
   *  asc. */
  production_models_without_perf: string[];
}

// ─── Builder ──────────────────────────────────────────────────────────

function bucketFor(
  days: number | null,
  fresh_days: number,
  stale_days: number,
): PerfFreshnessBucket {
  if (days === null) return 'never_recorded';
  if (days < fresh_days) return 'recent';
  if (days > stale_days) return 'stale';
  return 'stable';
}

/** PerfLookup returns the most-recent recorded_at (ISO) for a model;
 *  null when no records exist. Route handler implements this against
 *  the M7.5 ModelPerformanceStore. */
export type PerfLookup = (tenant_id: string, model_id: string) => string | null;

export function summarizeModelPerformanceFreshness(
  tenant_id: string,
  models: readonly ModelVersion[],
  lookup: PerfLookup,
  now: Date,
  fresh_days: number = DEFAULT_PERF_FRESH_DAYS,
  stale_days: number = DEFAULT_PERF_STALE_DAYS,
): ModelPerformanceFreshnessReport {
  if (!Number.isInteger(fresh_days) || fresh_days < 0) {
    throw new ModelPerformanceFreshnessError(
      'invalid_input',
      'fresh_days must be a non-negative integer',
    );
  }
  if (!Number.isInteger(stale_days) || stale_days < 0) {
    throw new ModelPerformanceFreshnessError(
      'invalid_input',
      'stale_days must be a non-negative integer',
    );
  }
  if (stale_days < fresh_days) {
    throw new ModelPerformanceFreshnessError(
      'invalid_input',
      `stale_days (${stale_days}) must be >= fresh_days (${fresh_days})`,
    );
  }

  const nowMs = now.getTime();
  const rows: ModelPerfFreshnessRow[] = [];
  let recent_count = 0;
  let stable_count = 0;
  let stale_count = 0;
  let never_recorded_count = 0;

  const by_status = {} as Record<ModelStatus, number>;
  for (const s of ALL_MODEL_STATUSES) by_status[s] = 0;
  const by_type = {} as Record<ModelType, number>;
  for (const t of ALL_MODEL_TYPES) by_type[t] = 0;

  const production_models_without_perf: string[] = [];

  for (const m of models) {
    const last = lookup(tenant_id, m.model_id);
    let days_since_recorded: number | null;
    if (last === null) {
      days_since_recorded = null;
    } else {
      const ms = new Date(last).getTime();
      if (!Number.isFinite(ms)) {
        days_since_recorded = null;
      } else {
        days_since_recorded = Math.max(0, Math.floor((nowMs - ms) / MS_PER_DAY));
      }
    }
    const freshness = bucketFor(days_since_recorded, fresh_days, stale_days);

    if (freshness === 'recent') recent_count += 1;
    else if (freshness === 'stable') stable_count += 1;
    else if (freshness === 'stale') stale_count += 1;
    else never_recorded_count += 1;

    if (ALL_MODEL_STATUSES.includes(m.status)) by_status[m.status] += 1;
    if (ALL_MODEL_TYPES.includes(m.type)) by_type[m.type] += 1;

    if (m.status === 'production' && freshness === 'never_recorded') {
      production_models_without_perf.push(m.model_id);
    }

    rows.push({
      model_id: m.model_id,
      name: m.name,
      type: m.type,
      version: m.version,
      status: m.status,
      last_recorded_at: days_since_recorded === null ? null : last,
      days_since_recorded,
      freshness,
    });
  }

  // Sort: never_recorded first, then by days_since_recorded desc
  // (oldest first), then model_id asc.
  rows.sort((a, b) => {
    if (a.days_since_recorded === null && b.days_since_recorded !== null) return -1;
    if (a.days_since_recorded !== null && b.days_since_recorded === null) return 1;
    if (a.days_since_recorded === null && b.days_since_recorded === null) {
      return a.model_id < b.model_id ? -1 : a.model_id > b.model_id ? 1 : 0;
    }
    const ad = a.days_since_recorded as number;
    const bd = b.days_since_recorded as number;
    if (bd !== ad) return bd - ad;
    return a.model_id < b.model_id ? -1 : a.model_id > b.model_id ? 1 : 0;
  });

  production_models_without_perf.sort();

  return {
    tenant_id,
    generated_at: now.toISOString(),
    fresh_days,
    stale_days,
    total_models: rows.length,
    recent_count,
    stable_count,
    stale_count,
    never_recorded_count,
    models: rows,
    by_status,
    by_type,
    production_models_without_perf,
  };
}
