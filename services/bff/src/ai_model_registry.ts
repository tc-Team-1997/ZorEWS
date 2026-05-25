// services/bff/src/ai_model_registry.ts
//
// T6 M7.1 — BIL AI/ML model registry.
//
// Module 7 (AI/ML Model Engine) had T4.5 surface — the PD model
// computer used by /v1/ews/evaluate. M7.1 lands the registry + ad-hoc
// inference + metrics surface so the SPA can show:
//   - "what models are deployed and at what stage"
//   - "what's the AUC/precision/recall of the production fraud model"
//   - "score this customer with model X and see the result"
//
// Distinct from the rules engine (deterministic if/else over indicators)
// — this is the ML side. The 6 seed models map to the BIL pitch's
// declared use-cases (PD, fraud, churn, lapse, anomaly, claim severity).
//
// Production wires this to MLflow / Sagemaker / Vertex; the
// AiModelRegistry interface keeps the swap mechanical.

// ─── Public types ──────────────────────────────────────────────────────

export type ModelType =
  | 'pd'
  | 'fraud'
  | 'churn'
  | 'lapse'
  | 'anomaly'
  | 'claim_severity';

export type ModelStatus =
  | 'experimental'
  | 'staging'
  | 'production'
  | 'shadow'
  | 'retired';

export type ModelFramework =
  | 'xgboost'
  | 'sklearn'
  | 'torch'
  | 'lightgbm'
  | 'isolation_forest';

export interface ModelMetrics {
  /** ROC-AUC for binary models; null for regression. */
  auc: number | null;
  precision: number;
  recall: number;
  f1: number;
  /** Mean absolute error — for regression models (claim_severity). */
  mae: number | null;
  /** Number of training rows. */
  training_rows: number;
  /** ISO date the model was last evaluated against the holdout. */
  evaluated_at: string;
}

export interface ModelVersion {
  model_id: string;
  name: string;
  type: ModelType;
  version: string;
  status: ModelStatus;
  framework: ModelFramework;
  description: string;
  trained_at: string;
  deployed_at: string | null;
  retired_at: string | null;
  /** Training data window (days back from trained_at). */
  training_data_window_days: number;
  /** Comma-separated key feature list — surfaced in the SPA tooltip. */
  key_features: string[];
  metrics: ModelMetrics;
}

export interface InferenceInput {
  customer_id: string;
  /** Optional override features. When omitted, the stub uses
   *  deterministic synthetic features per (tenant, customer, day). */
  features?: Record<string, number>;
}

export interface InferenceResult {
  model_id: string;
  customer_id: string;
  /** Score on the model's native scale. PD/fraud/churn/lapse: 0..1
   *  probability. anomaly: -1..1 (negative = anomalous). claim_severity:
   *  KES (regression). */
  score: number;
  /** Calibrated probability for binary models; null for regression / anomaly. */
  probability: number | null;
  /** Decision band — operator-readable bucket per BIL §12. null for regression. */
  band: 'low' | 'medium' | 'high' | null;
  scored_at: string;
  /** Top contributing features with their SHAP-style attributions. */
  top_features: { feature: string; value: number; attribution: number }[];
}

/** M4.2 — payload for creating a new model version. status defaults
 *  to 'experimental' and cannot be 'production' (production status
 *  changes go through the promotion-gate + maker-checker flow per
 *  spec acceptance). retired_at is null on create. */
export interface ModelCreateInput {
  model_id: string;
  name: string;
  type: ModelType;
  version: string;
  framework: ModelFramework;
  description?: string;
  status?: Exclude<ModelStatus, 'production'>;
  training_data_window_days?: number;
  key_features?: string[];
  metrics?: Partial<ModelMetrics>;
  trained_at?: string;
}

/** M4.2 — partial update. status is INTENTIONALLY excluded; status
 *  changes go through the promotion-gate / promotion-request flow
 *  per spec acceptance "Promotion from Staging → Prod requires both
 *  metric gate pass AND human approval." */
export interface ModelUpdateInput {
  name?: string;
  description?: string;
  training_data_window_days?: number;
  key_features?: string[];
  metrics?: Partial<ModelMetrics>;
}

export interface AiModelRegistry {
  list(filter?: { type?: ModelType; status?: ModelStatus }): ModelVersion[];
  get(model_id: string): ModelVersion | null;
  /** Returns the *production* model for a type (or null if none). */
  getProductionByType(type: ModelType): ModelVersion | null;
  score(model_id: string, input: InferenceInput, tenant_id: string, asOf: Date): InferenceResult;
  // M4.2 — Model Registry CRUD
  create(input: ModelCreateInput, now: Date): ModelVersion;
  update(model_id: string, patch: ModelUpdateInput, now: Date): ModelVersion;
  /** Soft delete — transitions status → 'retired' + sets retired_at.
   *  Refused on currently-production models unless force=true. */
  retire(model_id: string, opts: { force?: boolean }, now: Date): ModelVersion;
}

export class ModelRegistryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ModelRegistryError';
  }
}

const VALID_TYPES: ModelType[] = ['pd', 'fraud', 'churn', 'lapse', 'anomaly', 'claim_severity'];
const VALID_STATUSES: ModelStatus[] = ['experimental', 'staging', 'production', 'shadow', 'retired'];

export function isModelType(s: unknown): s is ModelType {
  return typeof s === 'string' && VALID_TYPES.includes(s as ModelType);
}
export function isModelStatus(s: unknown): s is ModelStatus {
  return typeof s === 'string' && VALID_STATUSES.includes(s as ModelStatus);
}

// ─── Seed catalogue ────────────────────────────────────────────────────
//
// 6 BIL models per the DataNetworks pitch §6. Production deployments
// always have at most one production model per type (the registry's
// score-by-type lookup depends on this invariant). The seed includes
// one production version per type plus a shadow/staging/retired
// version on a couple of types so the registry isn't trivially flat.

export const SEED_MODELS: readonly ModelVersion[] = [
  // PD model — drives /v1/ews/evaluate today
  {
    model_id: 'pd_xgb_v3',
    name: 'PD Model — XGBoost v3',
    type: 'pd',
    version: '3.2.1',
    status: 'production',
    framework: 'xgboost',
    description: 'Probability of default over the next 12 months for the loan book',
    trained_at: '2026-04-01T08:00:00.000Z',
    deployed_at: '2026-04-08T08:00:00.000Z',
    retired_at: null,
    training_data_window_days: 730,
    key_features: ['dpd_30d', 'utilisation_pct', 'income_volatility', 'sector', 'tenure_days'],
    metrics: {
      auc: 0.847,
      precision: 0.71,
      recall: 0.68,
      f1: 0.6948,
      mae: null,
      training_rows: 1_250_000,
      evaluated_at: '2026-04-15T08:00:00.000Z',
    },
  },
  {
    model_id: 'pd_xgb_v2',
    name: 'PD Model — XGBoost v2 (retired)',
    type: 'pd',
    version: '2.4.0',
    status: 'retired',
    framework: 'xgboost',
    description: 'Predecessor to v3; retained for back-testing',
    trained_at: '2025-10-01T08:00:00.000Z',
    deployed_at: '2025-10-15T08:00:00.000Z',
    retired_at: '2026-04-08T08:00:00.000Z',
    training_data_window_days: 540,
    key_features: ['dpd_30d', 'utilisation_pct', 'sector'],
    metrics: {
      auc: 0.812,
      precision: 0.68,
      recall: 0.64,
      f1: 0.6593,
      mae: null,
      training_rows: 980_000,
      evaluated_at: '2025-11-01T08:00:00.000Z',
    },
  },
  // Fraud model — claim fraud detection
  {
    model_id: 'fraud_lgb_v1',
    name: 'Claim Fraud — LightGBM v1',
    type: 'fraud',
    version: '1.5.0',
    status: 'production',
    framework: 'lightgbm',
    description: 'Per-claim fraud probability for BIL claim queue',
    trained_at: '2026-03-15T08:00:00.000Z',
    deployed_at: '2026-03-22T08:00:00.000Z',
    retired_at: null,
    training_data_window_days: 365,
    key_features: ['claim_amount_kes', 'days_since_inception', 'reason_code', 'claimant_match_score'],
    metrics: {
      auc: 0.891,
      precision: 0.62,
      recall: 0.79,
      f1: 0.694,
      mae: null,
      training_rows: 320_000,
      evaluated_at: '2026-04-10T08:00:00.000Z',
    },
  },
  // Churn model — life policies
  {
    model_id: 'churn_xgb_v1',
    name: 'Policy Churn — XGBoost v1',
    type: 'churn',
    version: '1.2.0',
    status: 'production',
    framework: 'xgboost',
    description: '90-day churn probability per active policy',
    trained_at: '2026-02-01T08:00:00.000Z',
    deployed_at: '2026-02-08T08:00:00.000Z',
    retired_at: null,
    training_data_window_days: 1095,
    key_features: ['premium_paid_lag_days', 'agent_persistency_score', 'product', 'rider_count'],
    metrics: {
      auc: 0.78,
      precision: 0.55,
      recall: 0.71,
      f1: 0.6193,
      mae: null,
      training_rows: 540_000,
      evaluated_at: '2026-04-01T08:00:00.000Z',
    },
  },
  {
    model_id: 'churn_torch_v1',
    name: 'Policy Churn — Torch deep model (shadow)',
    type: 'churn',
    version: '1.0.0-rc1',
    status: 'shadow',
    framework: 'torch',
    description: 'Sequence-aware deep model running in shadow against the XGBoost prod',
    trained_at: '2026-04-20T08:00:00.000Z',
    deployed_at: '2026-04-24T08:00:00.000Z',
    retired_at: null,
    training_data_window_days: 1095,
    key_features: ['premium_event_seq', 'product', 'agent_id', 'tenure_seq'],
    metrics: {
      auc: 0.81,
      precision: 0.58,
      recall: 0.74,
      f1: 0.6519,
      mae: null,
      training_rows: 540_000,
      evaluated_at: '2026-04-28T08:00:00.000Z',
    },
  },
  // Lapse model — predict policy lapse next 30d
  {
    model_id: 'lapse_xgb_v1',
    name: 'Policy Lapse — XGBoost v1',
    type: 'lapse',
    version: '1.0.3',
    status: 'production',
    framework: 'xgboost',
    description: '30-day policy lapse probability',
    trained_at: '2026-03-01T08:00:00.000Z',
    deployed_at: '2026-03-08T08:00:00.000Z',
    retired_at: null,
    training_data_window_days: 730,
    key_features: ['days_since_last_payment', 'premium_amount', 'rider_count', 'agent_id'],
    metrics: {
      auc: 0.83,
      precision: 0.64,
      recall: 0.69,
      f1: 0.6641,
      mae: null,
      training_rows: 410_000,
      evaluated_at: '2026-04-05T08:00:00.000Z',
    },
  },
  // Anomaly — unsupervised on transaction streams
  {
    model_id: 'anomaly_iforest_v2',
    name: 'Transaction Anomaly — IsolationForest v2',
    type: 'anomaly',
    version: '2.0.1',
    status: 'production',
    framework: 'isolation_forest',
    description: 'Unsupervised anomaly detection on transaction streams',
    trained_at: '2026-02-20T08:00:00.000Z',
    deployed_at: '2026-02-27T08:00:00.000Z',
    retired_at: null,
    training_data_window_days: 90,
    key_features: ['amount_kes', 'mcc_code', 'time_of_day', 'velocity_24h'],
    metrics: {
      auc: null,
      precision: 0.45,
      recall: 0.81,
      f1: 0.5797,
      mae: null,
      training_rows: 4_200_000,
      evaluated_at: '2026-04-01T08:00:00.000Z',
    },
  },
  // Claim severity — regression
  {
    model_id: 'claim_sev_lgb_v1',
    name: 'Claim Severity — LightGBM regressor v1',
    type: 'claim_severity',
    version: '1.1.0',
    status: 'staging',
    framework: 'lightgbm',
    description: 'Predicted claim payout amount in KES — regressor in staging',
    trained_at: '2026-04-15T08:00:00.000Z',
    deployed_at: null,
    retired_at: null,
    training_data_window_days: 1825,
    key_features: ['policy_sum_assured', 'reason_code', 'claimant_age', 'days_since_inception'],
    metrics: {
      auc: null,
      precision: 0,
      recall: 0,
      f1: 0,
      mae: 87_500,
      training_rows: 220_000,
      evaluated_at: '2026-04-25T08:00:00.000Z',
    },
  },
];

const MODELS_BY_ID = new Map<string, ModelVersion>(SEED_MODELS.map((m) => [m.model_id, m]));

// ─── Deterministic synthetic inference ─────────────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bandFor(score: number): 'low' | 'medium' | 'high' {
  if (score < 0.3) return 'low';
  if (score < 0.7) return 'medium';
  return 'high';
}

function synthesiseInference(
  model: ModelVersion,
  input: InferenceInput,
  tenant_id: string,
  asOf: Date,
): InferenceResult {
  const day = asOf.toISOString().slice(0, 10);
  const seed = fnv1a(`infer|${model.model_id}|${tenant_id}|${input.customer_id}|${day}`);
  const r = rng(seed);

  let score: number;
  let probability: number | null;
  let band: InferenceResult['band'];

  if (model.type === 'anomaly') {
    // -1..1, mostly 0..0.3 (normal); rarely negative (anomalous)
    score = Math.round((r() < 0.05 ? -(0.3 + r() * 0.6) : r() * 0.4) * 10000) / 10000;
    probability = null;
    band = null;
  } else if (model.type === 'claim_severity') {
    // KES regression — biased by model's training mae.
    score = Math.round(50_000 + r() * 4_950_000);
    probability = null;
    band = null;
  } else {
    // PD / fraud / churn / lapse — calibrated 0..1 probability
    const raw = r();
    score = Math.round(raw * 10000) / 10000;
    probability = score;
    band = bandFor(score);
  }

  // Top features — synthesise SHAP-style attributions across the
  // model's declared key_features, summing close to the score.
  const shap_seed = rng(seed ^ 0xa5a5a5a5);
  const top_features = model.key_features.slice(0, 4).map((feature) => {
    const value = Math.round(shap_seed() * 10000) / 10000;
    const attribution = Math.round((shap_seed() - 0.5) * 0.3 * 10000) / 10000;
    return { feature, value, attribution };
  });

  return {
    model_id: model.model_id,
    customer_id: input.customer_id,
    score,
    probability,
    band,
    scored_at: asOf.toISOString(),
    top_features,
  };
}

// ─── In-memory registry ────────────────────────────────────────────────

// M4.2 — model_id format: snake-case alphanumeric + hyphens, 3..64 chars.
const MODEL_ID_RE = /^[a-z][a-z0-9_-]{2,63}$/;

export class InMemoryAiModelRegistry implements AiModelRegistry {
  list(filter?: { type?: ModelType; status?: ModelStatus }): ModelVersion[] {
    // M4.2 — read from MODELS_BY_ID (mutable) so create/update/retire
    // surface in subsequent list() calls. SEED_MODELS stays the
    // bootstrap source-of-truth at module load.
    let arr = [...MODELS_BY_ID.values()];
    if (filter?.type) arr = arr.filter((m) => m.type === filter.type);
    if (filter?.status) arr = arr.filter((m) => m.status === filter.status);
    // Sort: production first, then status order, then newest trained_at
    const statusRank: Record<ModelStatus, number> = {
      production: 0,
      shadow: 1,
      staging: 2,
      experimental: 3,
      retired: 4,
    };
    return arr.sort((a, b) => {
      const sd = statusRank[a.status] - statusRank[b.status];
      if (sd !== 0) return sd;
      return b.trained_at.localeCompare(a.trained_at);
    });
  }

  get(model_id: string): ModelVersion | null {
    return MODELS_BY_ID.get(model_id) ?? null;
  }

  getProductionByType(type: ModelType): ModelVersion | null {
    // M4.2 — also read from MODELS_BY_ID so a retired-then-re-promoted
    // model surfaces correctly.
    for (const m of MODELS_BY_ID.values()) {
      if (m.type === type && m.status === 'production') return m;
    }
    return null;
  }

  score(model_id: string, input: InferenceInput, tenant_id: string, asOf: Date): InferenceResult {
    if (!input || typeof input !== 'object') {
      throw new ModelRegistryError('invalid_input', 'request body required');
    }
    if (typeof input.customer_id !== 'string' || !input.customer_id.trim()) {
      throw new ModelRegistryError('invalid_input', 'customer_id is required');
    }
    const model = MODELS_BY_ID.get(model_id);
    if (!model) {
      throw new ModelRegistryError('unknown_model', `unknown model_id: ${model_id}`);
    }
    if (model.status === 'retired') {
      throw new ModelRegistryError(
        'retired',
        `model ${model_id} is retired and cannot be scored against`,
      );
    }
    return synthesiseInference(model, input, tenant_id, asOf);
  }

  // ─── M4.2 — Model Registry CRUD ───────────────────────────────────

  create(input: ModelCreateInput, now: Date): ModelVersion {
    if (!input || typeof input !== 'object') {
      throw new ModelRegistryError('invalid_input', 'request body required');
    }
    if (typeof input.model_id !== 'string' || !MODEL_ID_RE.test(input.model_id)) {
      throw new ModelRegistryError(
        'invalid_input',
        'model_id must match ^[a-z][a-z0-9_-]{2,63}$',
      );
    }
    if (MODELS_BY_ID.has(input.model_id)) {
      throw new ModelRegistryError(
        'duplicate_model_id',
        `model_id ${input.model_id} already exists`,
      );
    }
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) {
      throw new ModelRegistryError('invalid_input', 'name required (≤ 120 chars)');
    }
    if (!isModelType(input.type)) {
      throw new ModelRegistryError('invalid_input', `invalid type: ${input.type}`);
    }
    if (typeof input.version !== 'string' || !input.version.trim() || input.version.length > 32) {
      throw new ModelRegistryError('invalid_input', 'version required (≤ 32 chars)');
    }
    if (!VALID_FRAMEWORKS.includes(input.framework)) {
      throw new ModelRegistryError('invalid_input', `invalid framework: ${input.framework}`);
    }
    // status defaults to 'experimental'. Creating directly at
    // 'production' is forbidden — production promotions go through
    // the gate + maker-checker flow per spec acceptance.
    const status: ModelStatus = input.status ?? 'experimental';
    // Defense-in-depth: route layer narrows away 'production', but if a
    // caller ever drives create() directly with a wider type we still
    // refuse production on the create path. Status promotion happens
    // through evaluatePromotionGate + maker-checker.
    if ((status as string) === 'production') {
      throw new ModelRegistryError(
        'protected_status_change',
        'cannot create a model with status=production; promote via the gate + maker-checker flow',
      );
    }
    if (!VALID_STATUSES.includes(status) || status === 'retired') {
      throw new ModelRegistryError(
        'invalid_input',
        `status must be one of experimental/staging/shadow (got ${status})`,
      );
    }
    const window = input.training_data_window_days ?? 90;
    if (!Number.isFinite(window) || window < 1 || window > 3650) {
      throw new ModelRegistryError(
        'invalid_input',
        'training_data_window_days must be in [1, 3650]',
      );
    }
    const key_features = (input.key_features ?? []).filter(
      (f) => typeof f === 'string' && f.trim().length > 0,
    );
    if (key_features.length > 64) {
      throw new ModelRegistryError('invalid_input', 'key_features: max 64 entries');
    }
    const metrics: ModelMetrics = {
      auc: input.metrics?.auc ?? null,
      precision: input.metrics?.precision ?? 0,
      recall: input.metrics?.recall ?? 0,
      f1: input.metrics?.f1 ?? 0,
      mae: input.metrics?.mae ?? null,
      training_rows: input.metrics?.training_rows ?? 0,
      evaluated_at: input.metrics?.evaluated_at ?? now.toISOString(),
    };
    const entry: ModelVersion = {
      model_id: input.model_id,
      name: input.name.trim(),
      type: input.type,
      version: input.version.trim(),
      status,
      framework: input.framework,
      description: typeof input.description === 'string' ? input.description : '',
      trained_at: input.trained_at ?? now.toISOString(),
      deployed_at: null,
      retired_at: null,
      training_data_window_days: Math.round(window),
      key_features,
      metrics,
    };
    MODELS_BY_ID.set(entry.model_id, entry);
    return { ...entry };
  }

  update(model_id: string, patch: ModelUpdateInput, now: Date): ModelVersion {
    const cur = MODELS_BY_ID.get(model_id);
    if (!cur) {
      throw new ModelRegistryError('unknown_model', `unknown model_id: ${model_id}`);
    }
    if (!patch || typeof patch !== 'object') {
      throw new ModelRegistryError('invalid_input', 'patch body required');
    }
    // Refuse status mutation via PUT.
    if ('status' in patch) {
      throw new ModelRegistryError(
        'protected_status_change',
        'status cannot be changed via PUT — use /promotion-gate/auto-promote or /v1/ai/promotions',
      );
    }
    const next: ModelVersion = { ...cur };
    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.length > 120) {
        throw new ModelRegistryError('invalid_input', 'name (≤ 120 chars)');
      }
      next.name = patch.name.trim();
    }
    if (patch.description !== undefined) {
      if (typeof patch.description !== 'string' || patch.description.length > 1000) {
        throw new ModelRegistryError('invalid_input', 'description (≤ 1000 chars)');
      }
      next.description = patch.description;
    }
    if (patch.training_data_window_days !== undefined) {
      const w = patch.training_data_window_days;
      if (typeof w !== 'number' || !Number.isFinite(w) || w < 1 || w > 3650) {
        throw new ModelRegistryError(
          'invalid_input',
          'training_data_window_days must be in [1, 3650]',
        );
      }
      next.training_data_window_days = Math.round(w);
    }
    if (patch.key_features !== undefined) {
      if (!Array.isArray(patch.key_features)) {
        throw new ModelRegistryError('invalid_input', 'key_features must be string[]');
      }
      const cleaned = patch.key_features.filter(
        (f) => typeof f === 'string' && f.trim().length > 0,
      );
      if (cleaned.length > 64) {
        throw new ModelRegistryError('invalid_input', 'key_features: max 64 entries');
      }
      next.key_features = cleaned;
    }
    if (patch.metrics !== undefined) {
      if (typeof patch.metrics !== 'object' || patch.metrics === null || Array.isArray(patch.metrics)) {
        throw new ModelRegistryError('invalid_input', 'metrics must be an object');
      }
      next.metrics = {
        ...cur.metrics,
        ...patch.metrics,
        evaluated_at: patch.metrics.evaluated_at ?? now.toISOString(),
      };
    }
    // Mark touch — the registry doesn't expose updated_at on
    // ModelVersion (intentional — version is the canonical "changed"
    // marker). Persistence layer will stamp updated_at separately.
    MODELS_BY_ID.set(model_id, next);
    return { ...next };
  }

  retire(model_id: string, opts: { force?: boolean }, now: Date): ModelVersion {
    const cur = MODELS_BY_ID.get(model_id);
    if (!cur) {
      throw new ModelRegistryError('unknown_model', `unknown model_id: ${model_id}`);
    }
    if (cur.status === 'retired') {
      throw new ModelRegistryError('already_retired', `${model_id} is already retired`);
    }
    if (cur.status === 'production' && !opts.force) {
      throw new ModelRegistryError(
        'protected_production_retire',
        `cannot retire production model ${model_id} without force=true — promote a successor first`,
      );
    }
    const next: ModelVersion = {
      ...cur,
      status: 'retired',
      retired_at: now.toISOString(),
    };
    MODELS_BY_ID.set(model_id, next);
    return { ...next };
  }
}

const VALID_FRAMEWORKS: ModelFramework[] = [
  'xgboost',
  'sklearn',
  'torch',
  'lightgbm',
  'isolation_forest',
];

// M4.2 — test helper: re-seed MODELS_BY_ID from the readonly SEED_MODELS
// constant. Existing tests that don't touch CRUD can stay unchanged;
// new CRUD smokes call this in beforeEach so each test starts clean.
export function _resetAiModelRegistry(): void {
  MODELS_BY_ID.clear();
  for (const m of SEED_MODELS) MODELS_BY_ID.set(m.model_id, m);
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultAiModelRegistry: AiModelRegistry = new InMemoryAiModelRegistry();
