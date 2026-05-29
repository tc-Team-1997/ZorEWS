// services/bff/src/ai_drift.ts
//
// T7 Module 7 — Drift Detection (operational surface).
//
// The OFFLINE monitor already exists at ml/monitoring/drift.py (batch PSI/KS
// over reference-vs-current windows). This module is the LIVE operational
// surface the SPA + ops dashboard query: per-model drift snapshots the
// platform can poll without running the Python batch job. It mirrors the
// offline monitor's concepts + thresholds exactly:
//   - data drift           — per-feature PSI (bands: stable < 0.10 ≤ warn < 0.25 ≤ drift)
//   - model drift          — KS two-sample on the prediction distribution
//   - performance drift     — rolling AUC vs the model's baseline
//   - anomaly spike        — current anomaly-rate vs baseline
//
// Snapshots are deterministic per (tenant, model_id, day) via FNV-1a +
// Mulberry32 (the M7.x / bil_dashboards synthesis pattern) so the SPA renders
// stable data + the demo shows a realistic spread. In-memory store; the
// additive pg swap target is data/schema/041_ai_drift_tracking.sql.

import type { ModelType } from './ai_model_registry';

// ─── PSI severity bands (industry convention; matches ml/monitoring/drift.py) ──
export const PSI_OK = 0.10;
export const PSI_WARN = 0.25;

export type DriftBand = 'stable' | 'warn' | 'drift';
export const ALL_DRIFT_BANDS: DriftBand[] = ['stable', 'warn', 'drift'];

export function psiBand(psi: number): DriftBand {
  if (psi < PSI_OK) return 'stable';
  if (psi < PSI_WARN) return 'warn';
  return 'drift';
}

/** Worst-wins ordering for rolling up signals into an overall status. */
const BAND_RANK: Record<DriftBand, number> = { stable: 0, warn: 1, drift: 2 };
function worstBand(bands: DriftBand[]): DriftBand {
  return bands.reduce<DriftBand>((acc, b) => (BAND_RANK[b] > BAND_RANK[acc] ? b : acc), 'stable');
}

// ─── shapes ──────────────────────────────────────────────────────────────

export interface DriftFeatureRow {
  feature: string;
  psi: number;
  band: DriftBand;
  feature_type: 'numeric' | 'categorical';
}

export interface DataDriftBlock {
  features: DriftFeatureRow[];
  drifted_count: number; // features in band 'drift'
  warn_count: number;
  max_psi: number;
  worst_feature: string | null;
}

export interface ModelDriftBlock {
  ks_stat: number;
  p_value: number;
  drifted: boolean; // p < 0.01 && ks_stat > 0.10  (mirror of offline monitor)
}

export interface PerformanceDriftBlock {
  current_auc: number | null; // null for models without a binary AUC (e.g. anomaly)
  baseline_auc: number | null;
  delta: number | null; // current - baseline
  drifted: boolean; // delta < -0.03 (3-pt AUC drop)
}

export interface AnomalySpikeBlock {
  baseline_rate: number; // anomalies / 1000 scored, reference window
  current_rate: number;
  ratio: number; // current / baseline
  spiked: boolean; // ratio > 1.5
}

export interface DriftSnapshot {
  snapshot_id: string;
  tenant_id: string;
  model_id: string;
  model_type: ModelType;
  model_version: string;
  computed_at: string;
  reference_window: string; // e.g. "training" / "2026-Q1"
  current_window: string; // e.g. "last_7d"
  overall_status: DriftBand;
  data_drift: DataDriftBlock;
  model_drift: ModelDriftBlock;
  performance_drift: PerformanceDriftBlock;
  anomaly_spike: AnomalySpikeBlock;
}

export interface DriftFleetSummary {
  tenant_id: string;
  generated_at: string;
  total_models: number;
  by_status: Record<DriftBand, number>;
  models_needing_attention: number; // warn + drift
  worst_offender: { model_id: string; overall_status: DriftBand; max_psi: number } | null;
  models: DriftSnapshot[];
}

// ─── monitored model catalog ───────────────────────────────────────────────
// The production models under live drift surveillance. Self-contained (mirrors
// ai_model_registry's SEED_MODELS) so the module stays pure + independently
// testable. Each carries the feature set whose distribution we watch.

interface MonitoredModel {
  model_id: string;
  model_type: ModelType;
  version: string;
  baseline_auc: number | null;
  features: { name: string; type: 'numeric' | 'categorical' }[];
}

const BANKING_FEATURES: MonitoredModel['features'] = [
  { name: 'utilization', type: 'numeric' },
  { name: 'dpd_max_90d', type: 'numeric' },
  { name: 'bureau_score', type: 'numeric' },
  { name: 'repayment_delay_streak', type: 'numeric' },
  { name: 'txn_volume_zscore_90d', type: 'numeric' },
  { name: 'tenure_months', type: 'numeric' },
  { name: 'product_level', type: 'categorical' },
  { name: 'income_level', type: 'categorical' },
];
const INSURANCE_FEATURES: MonitoredModel['features'] = [
  { name: 'premium_to_sum_assured', type: 'numeric' },
  { name: 'days_since_last_premium', type: 'numeric' },
  { name: 'policy_age_months', type: 'numeric' },
  { name: 'claim_frequency_12m', type: 'numeric' },
  { name: 'agent_persistency', type: 'numeric' },
  { name: 'product_category', type: 'categorical' },
];

export const MONITORED_MODELS: MonitoredModel[] = [
  { model_id: 'pd_xgb_v3', model_type: 'pd', version: 'v3', baseline_auc: 0.847, features: BANKING_FEATURES },
  { model_id: 'fraud_lgbm_v1', model_type: 'fraud', version: 'v1', baseline_auc: 0.891, features: BANKING_FEATURES },
  { model_id: 'churn_xgb_v1', model_type: 'churn', version: 'v1', baseline_auc: 0.782, features: BANKING_FEATURES },
  { model_id: 'lapse_xgb_v1', model_type: 'lapse', version: 'v1', baseline_auc: 0.804, features: INSURANCE_FEATURES },
  { model_id: 'anomaly_if_v2', model_type: 'anomaly', version: 'v2', baseline_auc: null, features: BANKING_FEATURES },
];

export function listMonitoredModels(): { model_id: string; model_type: ModelType; version: string }[] {
  return MONITORED_MODELS.map((m) => ({ model_id: m.model_id, model_type: m.model_type, version: m.version }));
}

// ─── deterministic synthesis (FNV-1a + Mulberry32) ──────────────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const round = (n: number, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;

// ─── snapshot builder ───────────────────────────────────────────────────────

function buildSnapshot(tenant_id: string, m: MonitoredModel, now: Date, salt = ''): DriftSnapshot {
  const day = now.toISOString().slice(0, 10);
  const rng = mulberry32(fnv1a(`${tenant_id}|drift|${m.model_id}|${day}|${salt}`));

  // Per-feature PSI: mostly stable, occasional warn/drift. A per-model "stress"
  // factor (seeded) makes one or two models in the fleet visibly degraded so the
  // operational dashboard isn't uniformly green.
  const stress = rng(); // 0..1 — higher = more drift on this model
  const features: DriftFeatureRow[] = m.features.map((f) => {
    const r = rng();
    // baseline PSI 0..0.06, plus a stress-scaled tail that can push into warn/drift.
    let psi = r * 0.06;
    if (r > 0.78) psi += stress * 0.18; // some features pick up drift under stress
    if (r > 0.94) psi += stress * 0.22; // rare strong drift
    psi = round(Math.max(0, psi), 4);
    return { feature: f.name, psi, band: psiBand(psi), feature_type: f.type };
  });
  const max_psi = features.reduce((mx, f) => Math.max(mx, f.psi), 0);
  const worst = features.reduce<DriftFeatureRow | null>((acc, f) => (acc === null || f.psi > acc.psi ? f : acc), null);
  const data_drift: DataDriftBlock = {
    features,
    drifted_count: features.filter((f) => f.band === 'drift').length,
    warn_count: features.filter((f) => f.band === 'warn').length,
    max_psi: round(max_psi, 4),
    worst_feature: worst && worst.psi > 0 ? worst.feature : null,
  };

  // Model drift — KS two-sample on the prediction distribution.
  const ks_stat = round(0.02 + rng() * 0.04 + stress * 0.12, 4); // 0.02..~0.18
  const p_value = round(Math.max(0.0001, (1 - stress) * (0.2 + rng() * 0.6)), 4);
  const model_drift: ModelDriftBlock = { ks_stat, p_value, drifted: p_value < 0.01 && ks_stat > 0.10 };

  // Performance drift — rolling AUC vs baseline (null for anomaly models).
  let performance_drift: PerformanceDriftBlock;
  if (m.baseline_auc === null) {
    performance_drift = { current_auc: null, baseline_auc: null, delta: null, drifted: false };
  } else {
    const delta = round(-(stress * 0.06) + (rng() - 0.5) * 0.01, 4); // mostly small negative under stress
    const current_auc = round(Math.max(0.5, Math.min(0.999, m.baseline_auc + delta)), 4);
    performance_drift = { current_auc, baseline_auc: m.baseline_auc, delta, drifted: delta < -0.03 };
  }

  // Anomaly spike — current rate vs baseline.
  const baseline_rate = round(8 + rng() * 6, 2); // per-1000 scored
  const ratio = round(0.85 + rng() * 0.5 + stress * 1.1, 3); // 0.85..~2.45
  const current_rate = round(baseline_rate * ratio, 2);
  const anomaly_spike: AnomalySpikeBlock = { baseline_rate, current_rate, ratio, spiked: ratio > 1.5 };

  const overall_status = worstBand([
    worstBand(features.map((f) => f.band)),
    model_drift.drifted ? 'drift' : 'stable',
    performance_drift.drifted ? 'warn' : 'stable',
    anomaly_spike.spiked ? 'warn' : 'stable',
  ]);

  return {
    snapshot_id: `drift-${tenant_id}-${m.model_id}-${day}${salt ? '-' + salt : ''}`,
    tenant_id,
    model_id: m.model_id,
    model_type: m.model_type,
    model_version: m.version,
    computed_at: now.toISOString(),
    reference_window: 'training',
    current_window: 'last_7d',
    overall_status,
    data_drift,
    model_drift,
    performance_drift,
    anomaly_spike,
  };
}

// ─── errors ──────────────────────────────────────────────────────────────

export class AiDriftError extends Error {
  constructor(public readonly code: 'unknown_model' | 'invalid_input', message: string) {
    super(message);
    this.name = 'AiDriftError';
  }
}

// ─── store ───────────────────────────────────────────────────────────────

export const DRIFT_HISTORY_CAP = 50;

export interface AiDriftStore {
  /** Latest snapshot for one model (computes on first access per day). */
  latest(tenant_id: string, model_id: string, now?: Date): DriftSnapshot;
  /** Fleet rollup — latest snapshot per monitored model. */
  fleet(tenant_id: string, now?: Date): DriftFleetSummary;
  /** Force a fresh recompute; appends to history. */
  recompute(tenant_id: string, model_id: string, now?: Date): DriftSnapshot;
  /** Recompute history for one model, newest-first. */
  history(tenant_id: string, model_id: string, limit?: number): DriftSnapshot[];
}

export class InMemoryAiDriftStore implements AiDriftStore {
  // (tenant|model) → newest-first snapshot history
  private readonly hist = new Map<string, DriftSnapshot[]>();
  private seq = 0;

  private key(t: string, m: string) {
    return `${t}::${m}`;
  }
  private model(model_id: string): MonitoredModel {
    const m = MONITORED_MODELS.find((x) => x.model_id === model_id);
    if (!m) throw new AiDriftError('unknown_model', `model ${model_id} is not under drift surveillance`);
    return m;
  }

  latest(tenant_id: string, model_id: string, now: Date = new Date()): DriftSnapshot {
    if (!tenant_id) throw new AiDriftError('invalid_input', 'tenant_id required');
    const m = this.model(model_id);
    const arr = this.hist.get(this.key(tenant_id, model_id));
    if (arr && arr.length > 0) return structuredClone(arr[0]);
    // First access — synthesise the day's snapshot + store it.
    const snap = buildSnapshot(tenant_id, m, now);
    this.hist.set(this.key(tenant_id, model_id), [snap]);
    return structuredClone(snap);
  }

  fleet(tenant_id: string, now: Date = new Date()): DriftFleetSummary {
    if (!tenant_id) throw new AiDriftError('invalid_input', 'tenant_id required');
    const models = MONITORED_MODELS.map((m) => this.latest(tenant_id, m.model_id, now));
    const by_status = Object.fromEntries(ALL_DRIFT_BANDS.map((b) => [b, 0])) as Record<DriftBand, number>;
    let worst_offender: DriftFleetSummary['worst_offender'] = null;
    for (const s of models) {
      by_status[s.overall_status] += 1;
      const rank = BAND_RANK[s.overall_status];
      if (
        worst_offender === null ||
        rank > BAND_RANK[worst_offender.overall_status] ||
        (rank === BAND_RANK[worst_offender.overall_status] && s.data_drift.max_psi > worst_offender.max_psi)
      ) {
        worst_offender = { model_id: s.model_id, overall_status: s.overall_status, max_psi: s.data_drift.max_psi };
      }
    }
    // worst_offender is only meaningful when something is non-stable.
    if (worst_offender && worst_offender.overall_status === 'stable') worst_offender = null;
    return {
      tenant_id,
      generated_at: now.toISOString(),
      total_models: models.length,
      by_status,
      models_needing_attention: by_status.warn + by_status.drift,
      worst_offender,
      models,
    };
  }

  recompute(tenant_id: string, model_id: string, now: Date = new Date()): DriftSnapshot {
    if (!tenant_id) throw new AiDriftError('invalid_input', 'tenant_id required');
    const m = this.model(model_id);
    const snap = buildSnapshot(tenant_id, m, now, `r${++this.seq}`);
    const k = this.key(tenant_id, model_id);
    const arr = this.hist.get(k) ?? [];
    arr.unshift(snap);
    if (arr.length > DRIFT_HISTORY_CAP) arr.length = DRIFT_HISTORY_CAP;
    this.hist.set(k, arr);
    return structuredClone(snap);
  }

  history(tenant_id: string, model_id: string, limit = 20): DriftSnapshot[] {
    if (!tenant_id) throw new AiDriftError('invalid_input', 'tenant_id required');
    this.model(model_id); // validates
    const arr = this.hist.get(this.key(tenant_id, model_id)) ?? [];
    const n = Math.min(Math.max(1, Math.floor(limit)), DRIFT_HISTORY_CAP);
    return arr.slice(0, n).map((s) => structuredClone(s));
  }
}

// ─── singleton + reset ─────────────────────────────────────────────────────

export const defaultAiDriftStore: AiDriftStore = new InMemoryAiDriftStore();

export function _resetAiDriftStore(): void {
  const s = defaultAiDriftStore as unknown as { hist: Map<string, unknown>; seq: number };
  s.hist.clear();
  s.seq = 0;
}
