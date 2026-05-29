// services/bff/src/scorecard_evaluator.ts
//
// Composite scorecard evaluator — the runtime that CONSUMES two config screens:
//   • Risk Score Configuration (#11) — the per-domain enabled FACTORS + weights
//   • Alert Classification Setup (#12) — the tenant's RAG score-band boundaries
//
// Given a per-factor signal map (0..100 each), it computes the weighted
// composite Σ(weight_pct/100 × signal) and runs that composite through the
// tenant's configured RAG bands to derive the band + recommended action. This
// is the missing "config drives runtime" link: the weights an operator tunes on
// screen #11 and the bands they set on screen #12 now actually produce a score.
//
// Pure — no store, no I/O. The route resolves enabled factors + the
// classification config and hands them in. Factor signals are keyed by factor
// CODE (friendlier for callers + the SPA than opaque factor_ids).

import type { ScoreFactor } from './risk_score_config';
import { classifyScore, type AlertClassificationConfig, type RagBand, type ScoreClassification } from './alert_classification_config';

export class ScorecardEvalError extends Error {
  constructor(
    public code: 'invalid_input',
    message: string,
  ) {
    super(message);
    this.name = 'ScorecardEvalError';
  }
}

export interface FactorContribution {
  factor_id: string;
  code: string;
  name: string;
  weight_pct: number;
  signal_value: number; // 0..100, clamped; 0 when the caller didn't supply it
  value_provided: boolean; // whether the caller supplied a value for this factor
  contribution: number; // round2((weight_pct / 100) × signal_value)
}

export interface ScorecardEvaluation {
  tenant_id: string;
  domain: string;
  composite_score: number; // round2(Σ contributions)
  total_weight_pct: number; // sum of enabled factor weights (transparency)
  balanced: boolean; // total_weight_pct === 100 within tolerance
  classification: ScoreClassification; // RAG band from the alert-classification config
  factors: FactorContribution[]; // enabled factors, in sort order
  unknown_value_codes: string[]; // codes the caller supplied that are NOT enabled factors
  missing_value_count: number; // enabled factors the caller left unset (treated as 0)
  evaluated_at: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function clamp01_100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

// Normalise the caller's factor_values payload into a code → number map.
// Non-object input throws; non-numeric / non-finite values throw (so the
// caller learns about a typo rather than silently scoring it as 0). Keys are
// upper-cased to match the factor CODE convention.
export function normalizeFactorValues(raw: unknown): Record<string, number> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScorecardEvalError('invalid_input', 'factor_values must be an object keyed by factor code');
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new ScorecardEvalError('invalid_input', `factor_values['${k}'] must be a finite number`);
    }
    out[k.trim().toUpperCase()] = v;
  }
  return out;
}

// `enabledFactors` must already be filtered to the target domain AND enabled,
// in display (sort) order. `factorValues` is keyed by factor CODE (upper-case).
export function evaluateScorecard(
  tenant_id: string,
  domain: string,
  enabledFactors: ScoreFactor[],
  factorValues: Record<string, number>,
  classification: AlertClassificationConfig,
  nowMs: number,
): ScorecardEvaluation {
  const factorCodes = new Set(enabledFactors.map((f) => f.code));
  const unknown_value_codes = Object.keys(factorValues)
    .filter((code) => !factorCodes.has(code))
    .sort();

  let missing = 0;
  const factors: FactorContribution[] = enabledFactors.map((f) => {
    const provided = Object.prototype.hasOwnProperty.call(factorValues, f.code);
    if (!provided) missing += 1;
    const signal_value = provided ? clamp01_100(factorValues[f.code]) : 0;
    const contribution = round2((f.weight_pct / 100) * signal_value);
    return {
      factor_id: f.factor_id,
      code: f.code,
      name: f.name,
      weight_pct: f.weight_pct,
      signal_value,
      value_provided: provided,
      contribution,
    };
  });

  const composite_score = round2(factors.reduce((s, f) => s + f.contribution, 0));
  const total_weight_pct = round2(enabledFactors.reduce((s, f) => s + f.weight_pct, 0));

  return {
    tenant_id,
    domain,
    composite_score,
    total_weight_pct,
    balanced: Math.abs(total_weight_pct - 100) < 0.01,
    classification: classifyScore(classification, composite_score),
    factors,
    unknown_value_codes,
    missing_value_count: missing,
    evaluated_at: new Date(nowMs).toISOString(),
  };
}

// ─── Batch evaluation (config drives runtime at scale) ───────────────

export const SCORECARD_BATCH_MAX = 500;

export interface ScorecardBatchInputRow {
  id: string; // caller's reference (customer id, sample label, …)
  factor_values: Record<string, number>;
}

export interface ScorecardBatchRow {
  id: string;
  composite_score: number;
  band: RagBand;
  label: string;
  action_required: string;
}

export interface ScorecardBatchResult {
  tenant_id: string;
  domain: string;
  evaluated_at: string;
  total: number;
  total_weight_pct: number;
  balanced: boolean;
  // RAG distribution across the batch — every band key present (0 when absent)
  distribution: Record<RagBand, number>;
  mean_composite: number | null;
  max_composite: number | null;
  min_composite: number | null;
  rows: ScorecardBatchRow[];
}

// Score N profiles in one call against the same configured factors + RAG bands,
// returning a per-row band + a distribution rollup. Reuses evaluateScorecard so
// the per-row math is identical to the single-evaluate path. Throws on a
// non-array / oversized batch or a malformed row.
export function evaluateScorecardBatch(
  tenant_id: string,
  domain: string,
  rows: unknown,
  enabledFactors: ScoreFactor[],
  classification: AlertClassificationConfig,
  nowMs: number,
): ScorecardBatchResult {
  if (!Array.isArray(rows)) {
    throw new ScorecardEvalError('invalid_input', 'rows must be an array');
  }
  if (rows.length > SCORECARD_BATCH_MAX) {
    throw new ScorecardEvalError('invalid_input', `batch exceeds ${SCORECARD_BATCH_MAX} rows`);
  }
  const distribution: Record<RagBand, number> = { green: 0, amber: 0, red: 0 };
  const out: ScorecardBatchRow[] = [];
  let sum = 0;
  let max: number | null = null;
  let min: number | null = null;
  let total_weight_pct = 0;
  let balanced = false;

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ScorecardEvalError('invalid_input', 'each row must be an object');
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || r.id.trim() === '') {
      throw new ScorecardEvalError('invalid_input', 'each row needs a non-empty id');
    }
    const fv = normalizeFactorValues(r.factor_values);
    const ev = evaluateScorecard(tenant_id, domain, enabledFactors, fv, classification, nowMs);
    total_weight_pct = ev.total_weight_pct;
    balanced = ev.balanced;
    distribution[ev.classification.band] += 1;
    sum += ev.composite_score;
    max = max === null ? ev.composite_score : Math.max(max, ev.composite_score);
    min = min === null ? ev.composite_score : Math.min(min, ev.composite_score);
    out.push({
      id: r.id,
      composite_score: ev.composite_score,
      band: ev.classification.band,
      label: ev.classification.label,
      action_required: ev.classification.action_required,
    });
  }

  return {
    tenant_id,
    domain,
    evaluated_at: new Date(nowMs).toISOString(),
    total: out.length,
    total_weight_pct,
    balanced,
    distribution,
    mean_composite: out.length === 0 ? null : round2(sum / out.length),
    max_composite: max,
    min_composite: min,
    rows: out,
  };
}
