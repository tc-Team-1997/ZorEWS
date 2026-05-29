// services/bff/src/ai_experiments.ts
//
// T7 Module 10 — Experiment Tracking.
//
// Tracks ML experiment RUNS: dataset, parameters, evaluation metrics,
// outcome, owner. This is the pre-deployment R&D record ("we tried XGBoost
// max_depth=6 on the Q1 mart slice → AUC 0.84") that FEEDS the M7.2 model
// promotion decision. Distinct from:
//   - M7.1 ai_model_registry  — DEPLOYED model versions (the champions/challengers)
//   - M5.1 ai_retraining       — SCHEDULED retrains (cadence-driven jobs)
//   - ai_predictions           — per-customer INFERENCE rows
//
// In-memory store by default (prototype); the additive pg-backed swap lands via
// data/schema/040_ai_experiments.sql (app_copilot.ai_experiments). Mirrors the
// in-memory + singleton + reset shape of the Phase-6 SIU store.

import type { ModelType } from './ai_model_registry';

// ─── closed enums ────────────────────────────────────────────────────────

export type ExperimentStatus = 'running' | 'completed' | 'failed' | 'archived';
export const ALL_EXPERIMENT_STATUSES: ExperimentStatus[] = ['running', 'completed', 'failed', 'archived'];

export type ExperimentDomain = 'banking' | 'insurance';
export const ALL_EXPERIMENT_DOMAINS: ExperimentDomain[] = ['banking', 'insurance'];

export type ExperimentOutcome = 'promoted' | 'rejected' | 'inconclusive';
export const ALL_EXPERIMENT_OUTCOMES: ExperimentOutcome[] = ['promoted', 'rejected', 'inconclusive'];

export const ALL_EXPERIMENT_MODEL_TYPES: ModelType[] = ['pd', 'fraud', 'churn', 'lapse', 'anomaly', 'claim_severity'];

// State machine: a run is `running`, then resolves to `completed` | `failed`,
// then can be `archived` for tidiness. `archived` is terminal.
const TRANSITIONS: Record<ExperimentStatus, ExperimentStatus[]> = {
  running: ['completed', 'failed'],
  completed: ['archived'],
  failed: ['archived'],
  archived: [],
};

export function canTransitionExperiment(from: ExperimentStatus, to: ExperimentStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function isExperimentStatus(v: unknown): v is ExperimentStatus {
  return typeof v === 'string' && (ALL_EXPERIMENT_STATUSES as string[]).includes(v);
}
export function isExperimentDomain(v: unknown): v is ExperimentDomain {
  return typeof v === 'string' && (ALL_EXPERIMENT_DOMAINS as string[]).includes(v);
}
export function isExperimentOutcome(v: unknown): v is ExperimentOutcome {
  return typeof v === 'string' && (ALL_EXPERIMENT_OUTCOMES as string[]).includes(v);
}
export function isExperimentModelType(v: unknown): v is ModelType {
  return typeof v === 'string' && (ALL_EXPERIMENT_MODEL_TYPES as string[]).includes(v);
}

// ─── shapes ──────────────────────────────────────────────────────────────

export type ExperimentParamValue = string | number | boolean;

export interface AiExperiment {
  experiment_id: string;
  tenant_id: string;
  name: string;
  domain: ExperimentDomain;
  model_type: ModelType;
  status: ExperimentStatus;
  /** Pointer to the dataset slice used, e.g. "mart.customer_360@2026-Q1". */
  dataset_ref: string;
  dataset_rows: number;
  /** Hyper-parameters — flat primitive map (jsonb in pg). */
  params: Record<string, ExperimentParamValue>;
  /** Evaluation metrics — flat number map: auc/precision/recall/f1/brier/ks… */
  metrics: Record<string, number>;
  outcome: ExperimentOutcome | null;
  owner: string;
  notes: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateExperimentInput {
  name: string;
  domain: ExperimentDomain;
  model_type: ModelType;
  dataset_ref: string;
  dataset_rows: number;
  params?: Record<string, ExperimentParamValue>;
  metrics?: Record<string, number>;
  owner: string;
  notes?: string | null;
}

export interface ExperimentFilter {
  domain?: ExperimentDomain;
  status?: ExperimentStatus;
  model_type?: ModelType;
  owner?: string;
  page?: number;
  page_size?: number;
}

export interface ExperimentSummary {
  tenant_id: string;
  generated_at: string;
  total: number;
  by_status: Record<ExperimentStatus, number>;
  by_domain: Record<ExperimentDomain, number>;
  by_model_type: Record<ModelType, number>;
  by_outcome: Record<ExperimentOutcome, number>;
  /** completed/archived experiments with no recorded outcome yet — decision backlog. */
  pending_outcome_count: number;
  /** highest auc among completed/archived runs that recorded one; null when none. */
  best_auc: { experiment_id: string; name: string; auc: number } | null;
  most_recent_at: string | null;
}

// ─── errors ──────────────────────────────────────────────────────────────

export type ExperimentErrorCode =
  | 'invalid_input'
  | 'invalid_status'
  | 'invalid_transition'
  | 'invalid_outcome'
  | 'unknown_experiment'
  | 'outcome_requires_completion';

export class AiExperimentError extends Error {
  constructor(public readonly code: ExperimentErrorCode, message: string) {
    super(message);
    this.name = 'AiExperimentError';
  }
}

// ─── limits ──────────────────────────────────────────────────────────────

export const EXPERIMENT_NAME_MAX = 200;
export const EXPERIMENT_DATASET_REF_MAX = 200;
export const EXPERIMENT_NOTES_MAX = 4000;
export const EXPERIMENT_METRIC_MAX_ABS = 1_000_000;
export const EXPERIMENT_PARAM_KEY_CAP = 50;
export const EXPERIMENT_METRIC_KEY_CAP = 50;
export const EXPERIMENT_PAGE_SIZE_DEFAULT = 50;
export const EXPERIMENT_PAGE_SIZE_MAX = 200;

function validateMetrics(metrics: Record<string, number> | undefined): Record<string, number> {
  if (metrics === undefined) return {};
  if (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics)) {
    throw new AiExperimentError('invalid_input', 'metrics must be a flat object of numbers');
  }
  const keys = Object.keys(metrics);
  if (keys.length > EXPERIMENT_METRIC_KEY_CAP) {
    throw new AiExperimentError('invalid_input', `metrics may carry at most ${EXPERIMENT_METRIC_KEY_CAP} keys`);
  }
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = metrics[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new AiExperimentError('invalid_input', `metric ${k} must be a finite number`);
    }
    if (Math.abs(v) > EXPERIMENT_METRIC_MAX_ABS) {
      throw new AiExperimentError('invalid_input', `metric ${k} out of range`);
    }
    out[k] = v;
  }
  return out;
}

function validateParams(params: Record<string, ExperimentParamValue> | undefined): Record<string, ExperimentParamValue> {
  if (params === undefined) return {};
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new AiExperimentError('invalid_input', 'params must be a flat object of primitives');
  }
  const keys = Object.keys(params);
  if (keys.length > EXPERIMENT_PARAM_KEY_CAP) {
    throw new AiExperimentError('invalid_input', `params may carry at most ${EXPERIMENT_PARAM_KEY_CAP} keys`);
  }
  const out: Record<string, ExperimentParamValue> = {};
  for (const k of keys) {
    const v = params[k];
    const t = typeof v;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') {
      throw new AiExperimentError('invalid_input', `param ${k} must be string/number/boolean`);
    }
    if (t === 'number' && !Number.isFinite(v as number)) {
      throw new AiExperimentError('invalid_input', `param ${k} must be finite`);
    }
    out[k] = v;
  }
  return out;
}

function validateCreate(input: CreateExperimentInput): void {
  if (!input || typeof input !== 'object') throw new AiExperimentError('invalid_input', 'body required');
  const name = (input.name ?? '').trim();
  if (name.length === 0) throw new AiExperimentError('invalid_input', 'name required');
  if (name.length > EXPERIMENT_NAME_MAX) throw new AiExperimentError('invalid_input', `name exceeds ${EXPERIMENT_NAME_MAX}`);
  if (!isExperimentDomain(input.domain)) throw new AiExperimentError('invalid_input', 'domain must be banking|insurance');
  if (!isExperimentModelType(input.model_type)) throw new AiExperimentError('invalid_input', 'model_type out of enum');
  const ref = (input.dataset_ref ?? '').trim();
  if (ref.length === 0) throw new AiExperimentError('invalid_input', 'dataset_ref required');
  if (ref.length > EXPERIMENT_DATASET_REF_MAX) throw new AiExperimentError('invalid_input', `dataset_ref exceeds ${EXPERIMENT_DATASET_REF_MAX}`);
  if (typeof input.dataset_rows !== 'number' || !Number.isInteger(input.dataset_rows) || input.dataset_rows < 0) {
    throw new AiExperimentError('invalid_input', 'dataset_rows must be a non-negative integer');
  }
  const owner = (input.owner ?? '').trim();
  if (owner.length === 0) throw new AiExperimentError('invalid_input', 'owner required');
  if (input.notes != null && String(input.notes).length > EXPERIMENT_NOTES_MAX) {
    throw new AiExperimentError('invalid_input', `notes exceed ${EXPERIMENT_NOTES_MAX}`);
  }
}

// ─── store ───────────────────────────────────────────────────────────────

export interface AiExperimentStore {
  create(tenant_id: string, input: CreateExperimentInput, now?: Date): AiExperiment;
  list(tenant_id: string, filter?: ExperimentFilter): {
    items: AiExperiment[];
    page: number;
    page_size: number;
    total: number;
  };
  get(tenant_id: string, experiment_id: string): AiExperiment | null;
  updateStatus(tenant_id: string, experiment_id: string, to: ExperimentStatus, now?: Date): AiExperiment;
  setOutcome(tenant_id: string, experiment_id: string, outcome: ExperimentOutcome, now?: Date): AiExperiment;
  summarize(tenant_id: string, now?: Date): ExperimentSummary;
}

export class InMemoryAiExperimentStore implements AiExperimentStore {
  private readonly byTenant = new Map<string, AiExperiment[]>();
  private readonly seq = new Map<string, number>();

  private mintId(tenant_id: string, day: string): string {
    const n = (this.seq.get(tenant_id) ?? 0) + 1;
    this.seq.set(tenant_id, n);
    return `exp-${tenant_id}-${day}-${String(n).padStart(4, '0')}`;
  }

  create(tenant_id: string, input: CreateExperimentInput, now: Date = new Date()): AiExperiment {
    if (!tenant_id) throw new AiExperimentError('invalid_input', 'tenant_id required');
    validateCreate(input);
    const ts = now.toISOString();
    const params = validateParams(input.params);
    const metrics = validateMetrics(input.metrics);
    const row: AiExperiment = {
      experiment_id: this.mintId(tenant_id, ts.slice(0, 10)),
      tenant_id,
      name: input.name.trim(),
      domain: input.domain,
      model_type: input.model_type,
      status: 'running',
      dataset_ref: input.dataset_ref.trim(),
      dataset_rows: input.dataset_rows,
      params,
      metrics,
      outcome: null,
      owner: input.owner.trim(),
      notes: input.notes != null ? String(input.notes).trim() : null,
      started_at: ts,
      completed_at: null,
      created_at: ts,
      updated_at: ts,
    };
    let arr = this.byTenant.get(tenant_id);
    if (!arr) {
      arr = [];
      this.byTenant.set(tenant_id, arr);
    }
    arr.unshift(row);
    return structuredClone(row);
  }

  list(tenant_id: string, filter: ExperimentFilter = {}): {
    items: AiExperiment[];
    page: number;
    page_size: number;
    total: number;
  } {
    const arr = this.byTenant.get(tenant_id) ?? [];
    let filtered = arr;
    if (filter.domain) filtered = filtered.filter((e) => e.domain === filter.domain);
    if (filter.status) filtered = filtered.filter((e) => e.status === filter.status);
    if (filter.model_type) filtered = filtered.filter((e) => e.model_type === filter.model_type);
    if (filter.owner) filtered = filtered.filter((e) => e.owner === filter.owner);
    const page = Math.max(1, Math.floor(filter.page ?? 1));
    const page_size = Math.min(
      EXPERIMENT_PAGE_SIZE_MAX,
      Math.max(1, Math.floor(filter.page_size ?? EXPERIMENT_PAGE_SIZE_DEFAULT)),
    );
    const start = (page - 1) * page_size;
    return {
      items: filtered.slice(start, start + page_size).map((e) => structuredClone(e)),
      page,
      page_size,
      total: filtered.length,
    };
  }

  private find(tenant_id: string, experiment_id: string): AiExperiment | undefined {
    return (this.byTenant.get(tenant_id) ?? []).find((e) => e.experiment_id === experiment_id);
  }

  get(tenant_id: string, experiment_id: string): AiExperiment | null {
    const row = this.find(tenant_id, experiment_id);
    return row ? structuredClone(row) : null;
  }

  updateStatus(tenant_id: string, experiment_id: string, to: ExperimentStatus, now: Date = new Date()): AiExperiment {
    if (!isExperimentStatus(to)) throw new AiExperimentError('invalid_status', `unknown status ${to}`);
    const row = this.find(tenant_id, experiment_id);
    if (!row) throw new AiExperimentError('unknown_experiment', `unknown experiment ${experiment_id}`);
    if (!canTransitionExperiment(row.status, to)) {
      throw new AiExperimentError('invalid_transition', `cannot move ${row.status} → ${to}`);
    }
    const ts = now.toISOString();
    row.status = to;
    if (to === 'completed' || to === 'failed') row.completed_at = row.completed_at ?? ts;
    row.updated_at = ts;
    return structuredClone(row);
  }

  setOutcome(tenant_id: string, experiment_id: string, outcome: ExperimentOutcome, now: Date = new Date()): AiExperiment {
    if (!isExperimentOutcome(outcome)) throw new AiExperimentError('invalid_outcome', `unknown outcome ${outcome}`);
    const row = this.find(tenant_id, experiment_id);
    if (!row) throw new AiExperimentError('unknown_experiment', `unknown experiment ${experiment_id}`);
    // An outcome is a post-run judgment — only meaningful once the run has resolved.
    if (row.status === 'running') {
      throw new AiExperimentError('outcome_requires_completion', 'experiment must be completed/failed/archived before an outcome is recorded');
    }
    row.outcome = outcome;
    row.updated_at = now.toISOString();
    return structuredClone(row);
  }

  summarize(tenant_id: string, now: Date = new Date()): ExperimentSummary {
    const arr = this.byTenant.get(tenant_id) ?? [];
    const by_status = Object.fromEntries(ALL_EXPERIMENT_STATUSES.map((s) => [s, 0])) as Record<ExperimentStatus, number>;
    const by_domain = Object.fromEntries(ALL_EXPERIMENT_DOMAINS.map((d) => [d, 0])) as Record<ExperimentDomain, number>;
    const by_model_type = Object.fromEntries(ALL_EXPERIMENT_MODEL_TYPES.map((m) => [m, 0])) as Record<ModelType, number>;
    const by_outcome = Object.fromEntries(ALL_EXPERIMENT_OUTCOMES.map((o) => [o, 0])) as Record<ExperimentOutcome, number>;
    let pending_outcome_count = 0;
    let best_auc: ExperimentSummary['best_auc'] = null;
    let most_recent_at: string | null = null;
    for (const e of arr) {
      by_status[e.status] += 1;
      by_domain[e.domain] += 1;
      by_model_type[e.model_type] += 1;
      if (e.outcome) by_outcome[e.outcome] += 1;
      const resolved = e.status === 'completed' || e.status === 'archived';
      if (resolved && e.outcome === null) pending_outcome_count += 1;
      if (resolved && typeof e.metrics.auc === 'number') {
        if (best_auc === null || e.metrics.auc > best_auc.auc) {
          best_auc = { experiment_id: e.experiment_id, name: e.name, auc: e.metrics.auc };
        }
      }
      if (most_recent_at === null || e.started_at > most_recent_at) most_recent_at = e.started_at;
    }
    return {
      tenant_id,
      generated_at: now.toISOString(),
      total: arr.length,
      by_status,
      by_domain,
      by_model_type,
      by_outcome,
      pending_outcome_count,
      best_auc,
      most_recent_at,
    };
  }
}

// ─── singleton + reset ─────────────────────────────────────────────────────

export const defaultAiExperimentStore: AiExperimentStore = new InMemoryAiExperimentStore();

/** Test-only — reset the module singleton between jest cases. */
export function _resetAiExperimentStore(): void {
  const s = defaultAiExperimentStore as unknown as {
    byTenant: Map<string, unknown>;
    seq: Map<string, unknown>;
  };
  s.byTenant.clear();
  s.seq.clear();
}
