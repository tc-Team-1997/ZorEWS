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
    'c-103': makeStubProfile('c-103', 'Catherine Wanjiru', 0.18, 'Low',    320_000,  4),
    'c-104': makeStubProfile('c-104', 'Daniel Mwangi',     0.09, 'Low',    150_000,  0),
    'c-105': makeStubProfile('c-105', 'Esther Njeri',      0.61, 'High',   880_000, 22),
    'c-106': makeStubProfile('c-106', 'Faisal Hussein',    0.74, 'High', 1_650_000, 41),
    'c-107': makeStubProfile('c-107', 'Grace Atieno',      0.34, 'Medium', 470_000,  8),
    'c-108': makeStubProfile('c-108', 'Hassan Otieno',     0.12, 'Low',    220_000,  0),
    'c-109': makeStubProfile('c-109', 'Irene Mutua',       0.51, 'High',   780_000, 17),
    'c-110': makeStubProfile('c-110', 'James Kiprotich',   0.27, 'Medium', 380_000,  3),
    'c-111': makeStubProfile('c-111', 'Kavita Singh',      0.06, 'Low',    180_000,  0),
    'c-112': makeStubProfile('c-112', 'Linus Owino',       0.55, 'High',   910_000, 28),
    'c-113': makeStubProfile('c-113', 'Mary Wambui',       0.31, 'Medium', 420_000,  6),
    'c-114': makeStubProfile('c-114', 'Nathan Korir',      0.08, 'Low',    260_000,  0),
    'c-115': makeStubProfile('c-115', 'Olivia Cherop',     0.83, 'High', 1_980_000, 67),
    'c-116': makeStubProfile('c-116', 'Peter Maina',       0.58, 'High',   720_000, 24),
    'c-117': makeStubProfile('c-117', 'Quentin Wamalwa',   0.36, 'Medium', 510_000, 11),
    'c-118': makeStubProfile('c-118', 'Ruth Akinyi',       0.69, 'High',   840_000, 19),
    'c-119': makeStubProfile('c-119', 'Samuel Tanui',      0.11, 'Low',    195_000,  0),
    'c-120': makeStubProfile('c-120', 'Tabitha Njoroge',   0.64, 'High', 1_110_000, 35),
  };

  async get(customer_id: string): Promise<RiskProfile | null> {
    return this.profiles[customer_id] ?? null;
  }
}

function makeStubProfile(
  id: string,
  name: string,
  pd: number,
  level: 'Low' | 'Medium' | 'High',
  exposure: number,
  dpd: number,
): RiskProfile {
  return {
    id,
    name,
    pd,
    level,
    exposure,
    dpd,
    balance_trend: [
      { month: 'Nov', balance: Math.round(exposure * 0.32) },
      { month: 'Dec', balance: Math.round(exposure * 0.28) },
      { month: 'Jan', balance: Math.round(exposure * 0.24) },
      { month: 'Feb', balance: Math.round(exposure * 0.21) },
      { month: 'Mar', balance: Math.round(exposure * 0.17) },
      { month: 'Apr', balance: Math.round(exposure * 0.14) },
    ],
    top_reasons: [
      { feature: 'utilization',  value: Math.min(0.99, 0.4 + pd * 0.6), shap_value: pd * 0.4,  direction: 'positive' },
      { feature: 'bureau_score', value: Math.round(720 - pd * 200),     shap_value: pd * 0.25, direction: 'positive' },
      { feature: 'tenure_months',value: 36,                              shap_value: -0.08,     direction: 'negative' },
    ],
    model_name: 'pd_xgboost',
    model_version: '0.1.0',
  };
}
