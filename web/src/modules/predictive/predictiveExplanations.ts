// web/src/modules/predictive/predictiveExplanations.ts
//
// AI explanation framework — pure resolver.
//
// For every prediction we surface:
//   • prediction_score
//   • confidence
//   • key_drivers  (top SHAP-style features that pushed score UP)
//   • risk_factors (qualitative narrative bullets)
//   • recommended_actions (FK to predictiveRecommendations.ts)
//
// Production swap: read SHAP values from the model registry response on
// `/v1/ai/models/:id/score`. The shape stays identical so the SPA doesn't
// branch on synthetic-vs-real.

import {
  BANKING_LABELS,
  BANKING_PREDICTIONS,
  INSURANCE_LABELS,
  type PredictionForecast,
  type PredictionKind,
} from './predictiveRiskEngine';

export interface KeyDriver {
  feature: string;
  display_label: string;
  shap_value: number; // signed (positive = pushes score up = worse)
  direction: 'up' | 'down';
  human_value: string; // e.g. "DPD = 42 days"
}

export interface PredictionExplanation {
  tenant_id: string;
  kind: PredictionKind;
  label: string;
  prediction_score: number;
  confidence: number;
  generated_at: string;
  top_drivers: KeyDriver[]; // typically 5
  risk_factors: string[]; // 3-5 narrative bullets
  recommended_action_ids: string[]; // resolved against predictiveRecommendations.ts
  model_id: string;
  model_version: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-prediction feature pools — what features each model would normally
// surface. The synth generator picks 5 weighted by the kind.
// ───────────────────────────────────────────────────────────────────────────

interface FeaturePoolEntry {
  feature: string;
  label: string;
  formatValue: (rng: () => number) => string;
}

const COMMON_BANKING_FEATURES: FeaturePoolEntry[] = [
  { feature: 'dpd_max_90d', label: 'Max DPD (90d)', formatValue: (r) => `${Math.floor(r() * 90)} days` },
  { feature: 'utilization', label: 'Credit Utilisation', formatValue: (r) => `${Math.round(40 + r() * 55)}%` },
  { feature: 'bureau_score', label: 'Bureau Score', formatValue: (r) => `${Math.round(550 + r() * 280)}` },
  { feature: 'income_drop_30d_pct', label: 'Income Drop (30d)', formatValue: (r) => `-${Math.round(r() * 40)}%` },
  { feature: 'repayment_delay_streak', label: 'Repayment Delay Streak', formatValue: (r) => `${Math.floor(r() * 8)}` },
  { feature: 'txn_volume_zscore_90d', label: 'Txn Volume Z-Score', formatValue: (r) => `${(r() * 3 + 0.5).toFixed(2)}σ` },
  { feature: 'product_concentration', label: 'Product Concentration', formatValue: (r) => `${Math.round(60 + r() * 40)}%` },
];

const COMMON_INSURANCE_FEATURES: FeaturePoolEntry[] = [
  { feature: 'premium_due_days', label: 'Premium Due (days)', formatValue: (r) => `${Math.floor(r() * 60)} days overdue` },
  { feature: 'claim_freq_180d', label: 'Claim Frequency (180d)', formatValue: (r) => `${Math.floor(1 + r() * 6)}` },
  { feature: 'agent_persistency_pct', label: 'Agent Persistency', formatValue: (r) => `${Math.round(45 + r() * 30)}%` },
  { feature: 'portal_login_drop', label: 'Portal Engagement Drop', formatValue: (r) => `-${Math.round(40 + r() * 55)}%` },
  { feature: 'solvency_ratio', label: 'Solvency Ratio', formatValue: (r) => `${(1.4 + r() * 0.5).toFixed(2)}` },
  { feature: 'channel_persistency_delta', label: 'Channel Persistency Δ', formatValue: (r) => `-${Math.round(r() * 12)}pp` },
  { feature: 'policy_age_days', label: 'Policy Age (days)', formatValue: (r) => `${Math.floor(r() * 1800 + 30)}` },
  { feature: 'rapid_claim_flag', label: 'Rapid Post-Issuance Claim', formatValue: () => 'TRUE' },
];

// Narrative templates per prediction kind
const NARRATIVE_TEMPLATES: Record<PredictionKind, string[]> = {
  npa_probability: [
    'Repayment behaviour drifted into the 60-90 DPD bucket',
    'Bureau score deteriorated > 40 points in last 60 days',
    'Sector exposure concentration breached internal limit',
    'Loan tenure ratio above peer-segment median',
  ],
  sma_migration_risk: [
    'Borrower has crossed SMA-1 marker on at least one tradeline',
    'Cash-flow volatility exceeds 90-day baseline',
    'Repayment delay streak rising > 3 cycles',
  ],
  emi_default_risk: [
    'Multiple direct-debit bounce events observed',
    'Salary credit pattern broke vs trailing 6-month baseline',
    'Utilisation crossed 90% on revolving credit lines',
  ],
  collection_failure_risk: [
    'Prior collection attempts returned promised_to_pay with no follow-through',
    'Customer reachability score dropped > 30pp',
    'Field-visit outcome trended toward "no_response" cluster',
  ],
  borrower_stress_index: [
    'Cash inflow / EMI ratio fell below 1.3 stress threshold',
    'Cross-product exposure rose > 25% in trailing 90 days',
    'Repayment delay streak intersects with bureau enquiry spike',
  ],
  sector_deterioration_risk: [
    'Sector default rate rose > 15% vs trailing 12-month mean',
    'Peer-bank NPA ratio in sector crossed RBI watchlist threshold',
    'Macro indicators flag downturn in geography × sector combination',
  ],
  portfolio_risk_forecast: [
    'Concentration in top-3 sectors crossed 55% mark',
    'Average bureau score in book dropped > 15 points QoQ',
    'High-risk customer cohort grew faster than portfolio overall',
  ],
  policy_lapse_probability: [
    'Renewal premium overdue beyond grace half-point',
    'Customer engagement signals (portal, calls) trending down',
    'Policy issued through historically low-persistency channel',
  ],
  claim_fraud_probability: [
    'Claim filed within high-risk window post-issuance',
    'Hospital flagged on internal anti-fraud watchlist',
    'Repeat claim reason intersects with red-flag cluster',
    'Documents fall outside expected template fingerprints',
  ],
  persistency_decline_risk: [
    'Channel-level persistency dropped > 6pp YoY',
    'Agent cluster shows rising surrender/cancellation pattern',
    'Customer segment exhibits early-stage churn precursors',
  ],
  solvency_pressure_risk: [
    'IRDAI solvency ratio approaching 1.65 watch level',
    'Claim payout ratio rising vs trailing 12 months',
    'New business volume growth outpacing reserve accretion',
  ],
  premium_collection_risk: [
    'Renewal premium overdue across multiple tradelines',
    'Channel collection success rate dropping vs baseline',
    'Customer reachability signals weakening',
  ],
  agent_risk_escalation: [
    'Agent generated > 4 cancellations in trailing 90 days',
    'Agent persistency dropped below 70% in current quarter',
    'Multiple complaints clustered against agent in trailing 60 days',
  ],
  customer_churn_probability: [
    'Portal engagement dropped > 60% vs trailing 90 days',
    'Customer disengaged from value-add interactions',
    'Renewal interaction patterns suggest competitive shopping',
  ],
};

// Per-prediction recommendation defaults
const RECOMMENDATION_DEFAULTS: Record<PredictionKind, string[]> = {
  npa_probability: ['contact_borrower', 'increase_monitoring', 'launch_investigation'],
  sma_migration_risk: ['contact_borrower', 'increase_monitoring'],
  emi_default_risk: ['contact_borrower', 'increase_monitoring', 'escalate_review'],
  collection_failure_risk: ['escalate_review', 'launch_investigation'],
  borrower_stress_index: ['increase_monitoring', 'contact_borrower'],
  sector_deterioration_risk: ['escalate_review', 'freeze_exposure'],
  portfolio_risk_forecast: ['escalate_review', 'freeze_exposure'],
  policy_lapse_probability: ['trigger_retention_campaign', 'contact_borrower'],
  claim_fraud_probability: ['launch_investigation', 'escalate_review'],
  persistency_decline_risk: ['trigger_retention_campaign', 'escalate_review'],
  solvency_pressure_risk: ['escalate_review', 'freeze_exposure'],
  premium_collection_risk: ['trigger_retention_campaign', 'contact_borrower'],
  agent_risk_escalation: ['launch_investigation', 'escalate_review'],
  customer_churn_probability: ['trigger_retention_campaign', 'contact_borrower'],
};

// ───────────────────────────────────────────────────────────────────────────
// Deterministic synthesis helpers (mirror engine pattern)
// ───────────────────────────────────────────────────────────────────────────

function fnv1a(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function rng(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickN<T>(rng: () => number, pool: ReadonlyArray<T>, n: number): T[] {
  const arr = [...pool];
  const out: T[] = [];
  const cap = Math.min(n, pool.length);
  while (out.length < cap && arr.length > 0) {
    const idx = Math.floor(rng() * arr.length) % arr.length;
    out.push(arr[idx]);
    arr.splice(idx, 1);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Public resolver
// ───────────────────────────────────────────────────────────────────────────

export function buildExplanation(forecast: PredictionForecast, asOf: Date = new Date()): PredictionExplanation {
  const day = Math.floor(asOf.getTime() / 86_400_000);
  const rng = mulberry32(fnv1a([forecast.tenant_id, forecast.kind, day, 'expl'].join('|')));

  const pool = forecast.domain === 'banking' ? COMMON_BANKING_FEATURES : COMMON_INSURANCE_FEATURES;
  const drivers = pickN(rng, pool, 5).map((entry, idx) => {
    // top driver gets highest SHAP; descending
    const baseShap = (0.45 - idx * 0.08) * (forecast.current_score / 100); // weighted by severity
    const direction: 'up' | 'down' = rng() > 0.18 ? 'up' : 'down';
    const shap = Number((direction === 'up' ? baseShap : -baseShap * 0.6).toFixed(3));
    return {
      feature: entry.feature,
      display_label: entry.label,
      shap_value: shap,
      direction,
      human_value: entry.formatValue(rng),
    } as KeyDriver;
  });
  // sort by |shap| desc so top driver leads
  drivers.sort((a, b) => Math.abs(b.shap_value) - Math.abs(a.shap_value));

  const narrative = NARRATIVE_TEMPLATES[forecast.kind] ?? [];
  const risk_factors = pickN(rng, narrative, Math.min(narrative.length, 3 + Math.floor(rng() * 3)));

  // model_id maps kind → standard registry id (matches M7.1 catalog conventions)
  const isBanking = (BANKING_PREDICTIONS as readonly string[]).includes(forecast.kind);
  const model_id = isBanking ? `predictive-${forecast.kind}` : `predictive-${forecast.kind}`;

  return {
    tenant_id: forecast.tenant_id,
    kind: forecast.kind,
    label: isBanking
      ? BANKING_LABELS[forecast.kind as keyof typeof BANKING_LABELS]
      : INSURANCE_LABELS[forecast.kind as keyof typeof INSURANCE_LABELS],
    prediction_score: forecast.current_score,
    confidence: forecast.confidence,
    generated_at: asOf.toISOString(),
    top_drivers: drivers,
    risk_factors,
    recommended_action_ids: RECOMMENDATION_DEFAULTS[forecast.kind] ?? ['increase_monitoring'],
    model_id,
    model_version: '1.0.0',
  };
}
