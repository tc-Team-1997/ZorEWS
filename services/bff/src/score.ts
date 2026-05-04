// services/bff/src/score.ts
//
// Evaluator — pluggable client for ai-copilot-svc /score. The prototype
// ships a `StubEvaluator` so the public REST surface can be exercised
// without booting the Python service; in production agent-ai's /score
// is a one-line factory swap behind the same interface.

export interface CustomerFeatures {
  utilization?: number;
  dpd_max_90d?: number;
  balance_drop_30d_pct?: number;
  bureau_score?: number;
  repayment_delay_streak?: number;
  txn_volume_zscore_90d?: number;
  tenure_months?: number;
  product_type?: string;
  income_bucket?: string;
}

export interface ShapReason {
  feature: string;
  value: number | string | null;
  shap_value: number;
  direction: 'positive' | 'negative';
}

export interface ScoreResponse {
  customer_id: string | null;
  pd: number;
  level: 'Low' | 'Medium' | 'High';
  top_reasons: ShapReason[];
  model_name: string;
  model_version: string;
}

export interface Evaluator {
  evaluate(input: { customer_id?: string; features?: CustomerFeatures }): Promise<ScoreResponse>;
}

/**
 * Canned scoring path. The thresholds match the ai-copilot-svc level bands
 * (Low <0.30, Medium <0.60, High otherwise). SHAP reasoning is heuristic but
 * shape-correct so a UI smoke test exercises the v1 contract.
 */
export class StubEvaluator implements Evaluator {
  constructor(
    private readonly modelName = 'pd_xgboost',
    private readonly modelVersion = '0.1.0',
  ) {}

  async evaluate(input: {
    customer_id?: string;
    features?: CustomerFeatures;
  }): Promise<ScoreResponse> {
    const f = input.features ?? {};
    const pd = clamp01(
      0.10 +
        0.30 * normaliseFraction(f.utilization, 1.5) +
        0.30 * normaliseRange(f.dpd_max_90d, 0, 360) +
        0.15 * (1 - normaliseRange(f.bureau_score, 200, 900)) +
        0.10 * normaliseRange(f.repayment_delay_streak, 0, 12) +
        0.05 * Math.max(0, f.txn_volume_zscore_90d ?? 0),
    );
    const level: ScoreResponse['level'] = pd < 0.3 ? 'Low' : pd < 0.6 ? 'Medium' : 'High';

    const reasons: ShapReason[] = [];
    if (f.dpd_max_90d != null && f.dpd_max_90d > 0) {
      reasons.push({
        feature: 'dpd_max_90d',
        value: f.dpd_max_90d,
        shap_value: 0.4 * normaliseRange(f.dpd_max_90d, 0, 360),
        direction: 'positive',
      });
    }
    if (f.utilization != null) {
      reasons.push({
        feature: 'utilization',
        value: f.utilization,
        shap_value: 0.3 * normaliseFraction(f.utilization, 1.5),
        direction: f.utilization > 0.5 ? 'positive' : 'negative',
      });
    }
    if (f.bureau_score != null) {
      const sv = 0.2 * (1 - normaliseRange(f.bureau_score, 200, 900));
      reasons.push({
        feature: 'bureau_score',
        value: f.bureau_score,
        shap_value: sv,
        direction: sv > 0 ? 'positive' : 'negative',
      });
    }
    if (f.tenure_months != null) {
      reasons.push({
        feature: 'tenure_months',
        value: f.tenure_months,
        shap_value: -0.1 * normaliseRange(f.tenure_months, 0, 60),
        direction: 'negative',
      });
    }
    if (f.product_type) {
      reasons.push({
        feature: `product_type=${f.product_type}`,
        value: f.product_type,
        shap_value: 0.05,
        direction: 'positive',
      });
    }
    reasons.sort((a, b) => Math.abs(b.shap_value) - Math.abs(a.shap_value));

    return {
      customer_id: input.customer_id ?? null,
      pd,
      level,
      top_reasons: reasons.slice(0, 5),
      model_name: this.modelName,
      model_version: this.modelVersion,
    };
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return Math.min(1, Math.max(0, x));
}
function normaliseRange(x: number | undefined, lo: number, hi: number): number {
  if (x == null || !Number.isFinite(x)) return 0;
  return clamp01((x - lo) / (hi - lo));
}
function normaliseFraction(x: number | undefined, ceil: number): number {
  if (x == null || !Number.isFinite(x)) return 0;
  return clamp01(x / ceil);
}
