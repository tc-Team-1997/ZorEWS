// services/bff/src/risk_profile.ts
//
// RiskProfileSource — pluggable read of a customer's risk profile. The v1
// public-API endpoint /v1/risk-profile/:customer_id joins three things:
//
//   1) customer master (agent-data)  — name, basic identity
//   2) exposure / DPD / balance trend (agent-data, mart.customer_360)
//   3) PD score + SHAP (ai-copilot-svc /score)
//
// In production, the BFF orchestrates those three calls. For the prototype
// we ship a `StubRiskProfileSource` so the public REST contract can be
// exercised without booting Python + Postgres.

import type { ShapReason } from './score';

export interface BalancePoint {
  month: string;
  balance: number;
}

export interface RiskProfile {
  id: string;
  name: string;
  pd: number;
  level: 'Low' | 'Medium' | 'High';
  exposure: number;
  dpd: number;
  balance_trend: BalancePoint[];
  top_reasons: ShapReason[];
  model_name: string;
  model_version: string;
}

export interface RiskProfileSource {
  get(customer_id: string): Promise<RiskProfile | null>;
}

/**
 * Canned profiles for the seed customer set. Mirrors web/src/mocks/data.ts
 * so a local v1 smoke matches what users see in the SPA's MSW path.
 */
export class StubRiskProfileSource implements RiskProfileSource {
  private readonly profiles: Record<string, RiskProfile> = {
    'c-101': {
      id: 'c-101',
      name: 'Achieng Otieno',
      pd: 0.78,
      level: 'High',
      exposure: 1_240_000,
      dpd: 32,
      balance_trend: [
        { month: 'Nov', balance: 312000 },
        { month: 'Dec', balance: 290000 },
        { month: 'Jan', balance: 248000 },
        { month: 'Feb', balance: 192000 },
        { month: 'Mar', balance: 110000 },
        { month: 'Apr', balance: 64000 },
      ],
      top_reasons: [
        { feature: 'dpd_max_90d', value: 32, shap_value: 0.41, direction: 'positive' },
        { feature: 'utilization', value: 0.97, shap_value: 0.32, direction: 'positive' },
        { feature: 'bureau_score', value: 540, shap_value: 0.18, direction: 'positive' },
        { feature: 'repayment_delay_streak', value: 3, shap_value: 0.11, direction: 'positive' },
        { feature: 'tenure_months', value: 26, shap_value: -0.08, direction: 'negative' },
      ],
      model_name: 'pd_xgboost',
      model_version: '0.1.0',
    },
    'c-102': {
      id: 'c-102',
      name: 'Brian Kamau',
      pd: 0.42,
      level: 'Medium',
      exposure: 540_000,
      dpd: 12,
      balance_trend: [
        { month: 'Nov', balance: 180000 },
        { month: 'Dec', balance: 175000 },
        { month: 'Jan', balance: 160000 },
        { month: 'Feb', balance: 150000 },
        { month: 'Mar', balance: 138000 },
        { month: 'Apr', balance: 122000 },
      ],
      top_reasons: [
        { feature: 'utilization', value: 0.91, shap_value: 0.28, direction: 'positive' },
        { feature: 'bureau_score', value: 605, shap_value: 0.16, direction: 'positive' },
        {
          feature: 'product_type=credit_card',
          value: 'credit_card',
          shap_value: 0.12,
          direction: 'positive',
        },
        { feature: 'tenure_months', value: 41, shap_value: -0.10, direction: 'negative' },
        { feature: 'txn_volume_zscore_90d', value: -1.2, shap_value: 0.07, direction: 'positive' },
      ],
      model_name: 'pd_xgboost',
      model_version: '0.1.0',
    },
  };

  async get(customer_id: string): Promise<RiskProfile | null> {
    return this.profiles[customer_id] ?? null;
  }
}
