// services/bff/src/model_confidence_intervals.ts
//
// T6 M7.26 — Model confidence interval analysis.
//
// For each production model in the registry, synthesize a 95% CI
// around its AUC (binary classifier) or MAE (regression) using
// deterministic PRNG seeded by (tenant, model_id).
//
// CI width = 0.02 + rand * 0.08 (tight to wide)
// lower_ci = point_estimate - ci_width/2 (clamped 0-1 for AUC)
// upper_ci = point_estimate + ci_width/2 (clamped 0-1 for AUC)
// is_reliable = ci_width < 0.05
//
// Route: GET /v1/ai/models/confidence-intervals
//   RBAC: customers:read_risk_profile

import { defaultAiModelRegistry, type AiModelRegistry } from './ai_model_registry';

// ─── FNV-1a + mulberry32 ──────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = ((r ^ (r >>> 15)) * (r | 1)) >>> 0;
    r = (r ^ (r + ((r ^ (r >>> 7)) * (r | 61)))) >>> 0;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Public types ─────────────────────────────────────────────────────

export interface ModelConfidenceInterval {
  model_id: string;
  name: string;
  type: string;
  metric_name: string;
  point_estimate: number;
  lower_ci: number;
  upper_ci: number;
  ci_width: number;
  is_reliable: boolean;
}

export interface ModelConfidenceIntervalReport {
  tenant_id: string;
  generated_at: string;
  models: ModelConfidenceInterval[];
  reliable_model_count: number;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildModelConfidenceIntervals(
  registry: AiModelRegistry,
  tenant_id: string,
  now: Date,
): ModelConfidenceIntervalReport {
  if (!tenant_id) throw new Error('tenant_id is required');

  const production = registry.list({ status: 'production' });
  const rows: ModelConfidenceInterval[] = [];

  for (const model of production) {
    const rng = mulberry32(fnv1a(`${tenant_id}::${model.model_id}::ci`));
    const ci_width = round4(0.02 + rng() * 0.08);

    let metric_name: string;
    let point_estimate: number;

    if (model.metrics.auc !== null && model.metrics.auc !== undefined) {
      metric_name = 'AUC';
      point_estimate = model.metrics.auc;
    } else if (model.metrics.mae !== null && model.metrics.mae !== undefined) {
      metric_name = 'MAE';
      point_estimate = model.metrics.mae;
    } else {
      // No metric available — skip
      continue;
    }

    const half = ci_width / 2;
    let lower_ci = round4(point_estimate - half);
    let upper_ci = round4(point_estimate + half);

    // For AUC, clamp to [0, 1]
    if (metric_name === 'AUC') {
      lower_ci = clamp(lower_ci, 0, 1);
      upper_ci = clamp(upper_ci, 0, 1);
    }

    rows.push({
      model_id: model.model_id,
      name: model.name,
      type: model.type,
      metric_name,
      point_estimate,
      lower_ci,
      upper_ci,
      ci_width,
      is_reliable: ci_width < 0.05,
    });
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    models: rows,
    reliable_model_count: rows.filter((m) => m.is_reliable).length,
  };
}
