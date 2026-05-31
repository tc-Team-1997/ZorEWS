// web/src/modules/predictive/predictiveRiskEngine.ts
//
// Predictive Risk Intelligence — pure resolvers.
//
// 11th IA addition this session. Follows the proven overlay-Center pattern
// (additive only — existing dashboards / Executive Cockpit / Role-Based
// Dashboard untouched). Mounted at /predictive-risk-center.
//
// Surface
//   • 7 banking predictions × 4 horizons (30/60/90/180d)
//   • 7 insurance predictions × 4 horizons
//   • 5-level risk scoring engine with per-scope threshold overrides
//   • Risk Evolution Timeline (historical + current + predicted)
//   • Confidence + SHAP-style key drivers
//   • Enterprise / country / tenant / portfolio executive forecasts
//
// Determinism
//   FNV-1a hash → Mulberry32 PRNG keyed on (tenant, prediction, day).
//   Same scheme as aiInsights.ts / bil_dashboards.ts / executiveCockpitEngine.
//   Production BFF wire-up swaps body of `predict*()` resolvers — surface
//   contract stays stable.

// ───────────────────────────────────────────────────────────────────────────
// Closed enums
// ───────────────────────────────────────────────────────────────────────────

export const RISK_LEVELS = ['low', 'moderate', 'high', 'severe', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const FORECAST_HORIZONS = [30, 60, 90, 180] as const;
export type ForecastHorizon = (typeof FORECAST_HORIZONS)[number];

export const BANKING_PREDICTIONS = [
  'npa_probability',
  'sma_migration_risk',
  'emi_default_risk',
  'collection_failure_risk',
  'borrower_stress_index',
  'sector_deterioration_risk',
  'portfolio_risk_forecast',
] as const;
export type BankingPrediction = (typeof BANKING_PREDICTIONS)[number];

export const INSURANCE_PREDICTIONS = [
  'policy_lapse_probability',
  'claim_fraud_probability',
  'persistency_decline_risk',
  'solvency_pressure_risk',
  'premium_collection_risk',
  'agent_risk_escalation',
  'customer_churn_probability',
] as const;
export type InsurancePrediction = (typeof INSURANCE_PREDICTIONS)[number];

export type PredictionKind = BankingPrediction | InsurancePrediction;

export const PREDICTIVE_DOMAINS = ['banking', 'insurance'] as const;
export type PredictiveDomain = (typeof PREDICTIVE_DOMAINS)[number];

export const PREDICTIVE_ROLES = [
  'super_admin',
  'country_admin',
  'bank_admin',
  'insurance_admin',
  'risk_analyst',
  'fraud_analyst',
  'cro',
  'ceo',
  'cfo',
  'coo',
  'board_member',
  'country_head',
  // legacy backend roles (admin = super_admin, supervisor + executive = exec roles)
  'admin',
  'supervisor',
  'executive',
] as const;
export type PredictiveRole = (typeof PREDICTIVE_ROLES)[number];

export function canAccessPredictiveRiskCenter(roles?: string[]): boolean {
  if (!roles || roles.length === 0) return false;
  const allow = new Set<string>(PREDICTIVE_ROLES);
  return roles.some((r) => allow.has(r));
}

// ───────────────────────────────────────────────────────────────────────────
// Display metadata
// ───────────────────────────────────────────────────────────────────────────

export const BANKING_LABELS: Record<BankingPrediction, string> = {
  npa_probability: 'NPA Probability',
  sma_migration_risk: 'SMA Migration Risk',
  emi_default_risk: 'EMI Default Risk',
  collection_failure_risk: 'Collection Failure Risk',
  borrower_stress_index: 'Borrower Stress Index',
  sector_deterioration_risk: 'Sector Deterioration Risk',
  portfolio_risk_forecast: 'Portfolio Risk Forecast',
};

export const INSURANCE_LABELS: Record<InsurancePrediction, string> = {
  policy_lapse_probability: 'Policy Lapse Probability',
  claim_fraud_probability: 'Claim Fraud Probability',
  persistency_decline_risk: 'Persistency Decline Risk',
  solvency_pressure_risk: 'Solvency Pressure Risk',
  premium_collection_risk: 'Premium Collection Risk',
  agent_risk_escalation: 'Agent Risk Escalation',
  customer_churn_probability: 'Customer Churn Probability',
};

// ───────────────────────────────────────────────────────────────────────────
// Deterministic synthesis (FNV-1a + Mulberry32)
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

function dayOf(asOf: Date): number {
  return Math.floor(asOf.getTime() / 86_400_000);
}

function seededRng(parts: ReadonlyArray<string | number>): () => number {
  return mulberry32(fnv1a(parts.join('|')));
}

function pickFrom<T>(rng: () => number, pool: ReadonlyArray<T>): T {
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

// ───────────────────────────────────────────────────────────────────────────
// Risk scoring engine
// ───────────────────────────────────────────────────────────────────────────

export interface RiskThresholds {
  // upper-exclusive boundaries; ordered low → moderate → high → severe → critical
  moderate: number; // score < moderate → low
  high: number; //     score < high     → moderate
  severe: number; //   score < severe   → high
  critical: number; // score < critical → severe; >= critical → critical
}

export const DEFAULT_THRESHOLDS: RiskThresholds = {
  moderate: 20,
  high: 40,
  severe: 65,
  critical: 85,
};

/**
 * Scope-aware threshold override. Resolution order:
 *   tenant > domain > country > default
 * Production swap: read from `predictive_models.thresholds_json`.
 */
export interface ThresholdOverrides {
  countries?: Record<string, RiskThresholds>;
  tenants?: Record<string, RiskThresholds>;
  domains?: Partial<Record<PredictiveDomain, RiskThresholds>>;
}

export function resolveThresholds(
  scope: { country?: string; tenant?: string; domain?: PredictiveDomain },
  overrides: ThresholdOverrides = {},
): RiskThresholds {
  if (scope.tenant && overrides.tenants?.[scope.tenant]) return overrides.tenants[scope.tenant];
  if (scope.domain && overrides.domains?.[scope.domain]) return overrides.domains[scope.domain]!;
  if (scope.country && overrides.countries?.[scope.country]) return overrides.countries[scope.country];
  return DEFAULT_THRESHOLDS;
}

export function bandForScore(score: number, thresholds: RiskThresholds = DEFAULT_THRESHOLDS): RiskLevel {
  if (score >= thresholds.critical) return 'critical';
  if (score >= thresholds.severe) return 'severe';
  if (score >= thresholds.high) return 'high';
  if (score >= thresholds.moderate) return 'moderate';
  return 'low';
}

// ───────────────────────────────────────────────────────────────────────────
// Forecasts (per prediction × horizon)
// ───────────────────────────────────────────────────────────────────────────

export interface ForecastPoint {
  day_offset: number; // 0 = today; > 0 = future
  score: number; // 0..100
  band: RiskLevel;
  confidence: number; // 0..1
  lower_bound: number; // 0..100 (confidence interval)
  upper_bound: number; // 0..100
}

export interface PredictionForecast {
  tenant_id: string;
  kind: PredictionKind;
  domain: PredictiveDomain;
  label: string;
  horizon: ForecastHorizon;
  generated_at: string;
  current_score: number;
  current_band: RiskLevel;
  forecast_score: number; // score at horizon
  forecast_band: RiskLevel;
  delta_pp: number; // forecast - current (percentage points; signed)
  confidence: number; // aggregate 0..1
  trend: 'rising' | 'falling' | 'flat'; // > +2pp / < -2pp / else
  points: ForecastPoint[];
}

/**
 * Compute a single prediction × horizon forecast.
 * Synthesises a smooth, slightly noisy trajectory from today to horizon
 * with widening confidence bounds as the horizon grows.
 */
export function predictRisk(
  tenant_id: string,
  kind: PredictionKind,
  horizon: ForecastHorizon,
  asOf: Date = new Date(),
  overrides?: { thresholds?: ThresholdOverrides; country?: string },
): PredictionForecast {
  const domain: PredictiveDomain =
    (BANKING_PREDICTIONS as readonly string[]).includes(kind) ? 'banking' : 'insurance';
  const thresholds = resolveThresholds(
    { tenant: tenant_id, domain, country: overrides?.country },
    overrides?.thresholds ?? {},
  );

  const day = dayOf(asOf);
  const rng = seededRng([tenant_id, kind, day, 'forecast']);

  // current score 5..90, biased per prediction kind
  const baseBias = fnv1a(kind) % 25; // 0..24
  const current_score = Math.round(5 + rng() * 65 + baseBias);
  const current_band = bandForScore(current_score, thresholds);

  // trend factor: most predictions drift up over time (signal of deterioration);
  // a minority drift down (mean reversion / recovery)
  const trendDir = rng() > 0.35 ? 1 : -1;
  const trendMag = 0.08 + rng() * 0.22; // 8..30% drift relative to horizon

  const points: ForecastPoint[] = [];
  const stepDays = Math.max(1, Math.floor(horizon / 6)); // ~6 buckets per horizon
  for (let off = 0; off <= horizon; off += stepDays) {
    const fraction = off / horizon; // 0..1
    const drift = trendDir * trendMag * fraction * current_score;
    const noise = (rng() - 0.5) * 6; // ±3pp jitter
    const raw = current_score + drift + noise;
    const score = Math.max(0, Math.min(100, Math.round(raw)));
    const confSpread = 4 + fraction * 14; // widens 4 → 18pp at horizon
    const lower = Math.max(0, Math.round(score - confSpread));
    const upper = Math.min(100, Math.round(score + confSpread));
    const confidence = Math.round((0.92 - fraction * 0.32) * 100) / 100; // 0.92 → 0.60
    points.push({
      day_offset: off,
      score,
      band: bandForScore(score, thresholds),
      confidence,
      lower_bound: lower,
      upper_bound: upper,
    });
  }

  const last = points[points.length - 1];
  const delta_pp = last.score - current_score;
  const trend: PredictionForecast['trend'] =
    delta_pp > 2 ? 'rising' : delta_pp < -2 ? 'falling' : 'flat';

  return {
    tenant_id,
    kind,
    domain,
    label: domain === 'banking' ? BANKING_LABELS[kind as BankingPrediction] : INSURANCE_LABELS[kind as InsurancePrediction],
    horizon,
    generated_at: asOf.toISOString(),
    current_score,
    current_band,
    forecast_score: last.score,
    forecast_band: last.band,
    delta_pp,
    confidence: Math.round((points.reduce((a, p) => a + p.confidence, 0) / points.length) * 100) / 100,
    trend,
    points,
  };
}

/** Run every banking prediction at one horizon. */
export function predictBankingSuite(
  tenant_id: string,
  horizon: ForecastHorizon,
  asOf: Date = new Date(),
  overrides?: { thresholds?: ThresholdOverrides; country?: string },
): PredictionForecast[] {
  return BANKING_PREDICTIONS.map((k) => predictRisk(tenant_id, k, horizon, asOf, overrides));
}

/** Run every insurance prediction at one horizon. */
export function predictInsuranceSuite(
  tenant_id: string,
  horizon: ForecastHorizon,
  asOf: Date = new Date(),
  overrides?: { thresholds?: ThresholdOverrides; country?: string },
): PredictionForecast[] {
  return INSURANCE_PREDICTIONS.map((k) => predictRisk(tenant_id, k, horizon, asOf, overrides));
}

// ───────────────────────────────────────────────────────────────────────────
// Risk Evolution Timeline
// ───────────────────────────────────────────────────────────────────────────

export interface TimelinePoint {
  day_offset: number; // -90..+180 typical
  score: number;
  band: RiskLevel;
  source: 'historical' | 'current' | 'predicted';
  confidence: number | null; // null on historical
}

export interface RiskTimeline {
  tenant_id: string;
  kind: PredictionKind;
  label: string;
  domain: PredictiveDomain;
  horizon: ForecastHorizon;
  generated_at: string;
  current_score: number;
  current_band: RiskLevel;
  history_window_days: number;
  points: TimelinePoint[];
}

export function buildRiskTimeline(
  tenant_id: string,
  kind: PredictionKind,
  horizon: ForecastHorizon,
  asOf: Date = new Date(),
  historyDays: number = 90,
): RiskTimeline {
  const forecast = predictRisk(tenant_id, kind, horizon, asOf);
  const day = dayOf(asOf);
  const rng = seededRng([tenant_id, kind, day, 'history']);

  const historical: TimelinePoint[] = [];
  for (let off = -historyDays; off < 0; off += Math.max(1, Math.floor(historyDays / 9))) {
    // history drifts smoothly toward current_score
    const fraction = (historyDays + off) / historyDays; // 0..1 (1 = today)
    const drift = (forecast.current_score - 35) * fraction;
    const noise = (rng() - 0.5) * 8;
    const score = Math.max(0, Math.min(100, Math.round(35 + drift + noise)));
    historical.push({
      day_offset: off,
      score,
      band: bandForScore(score),
      source: 'historical',
      confidence: null,
    });
  }

  const current: TimelinePoint = {
    day_offset: 0,
    score: forecast.current_score,
    band: forecast.current_band,
    source: 'current',
    confidence: 1.0,
  };

  const predicted: TimelinePoint[] = forecast.points
    .filter((p) => p.day_offset > 0)
    .map((p) => ({
      day_offset: p.day_offset,
      score: p.score,
      band: p.band,
      source: 'predicted',
      confidence: p.confidence,
    }));

  return {
    tenant_id,
    kind,
    label: forecast.label,
    domain: forecast.domain,
    horizon,
    generated_at: asOf.toISOString(),
    current_score: forecast.current_score,
    current_band: forecast.current_band,
    history_window_days: historyDays,
    points: [...historical, current, ...predicted],
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Executive Forecasts (scope rollups)
// ───────────────────────────────────────────────────────────────────────────

export const EXECUTIVE_FORECAST_SCOPES = [
  'enterprise',
  'country',
  'tenant',
  'portfolio',
] as const;
export type ExecutiveForecastScope = (typeof EXECUTIVE_FORECAST_SCOPES)[number];

export interface ExecutiveForecastEntry {
  scope: ExecutiveForecastScope;
  entity_id: string; // 'ENT' for enterprise, ISO country code, tenant id, portfolio id
  entity_label: string;
  horizon: ForecastHorizon;
  forecast_score: number;
  forecast_band: RiskLevel;
  delta_pp: number;
  trend: 'rising' | 'falling' | 'flat';
  confidence: number;
  top_kind: PredictionKind | null;
}

const COUNTRIES = ['IN', 'BT', 'NP', 'AE'] as const;
const PORTFOLIOS = ['retail_loans', 'sme_loans', 'corp_loans', 'auto_loans', 'insurance_life', 'insurance_general'] as const;
const TENANTS = ['BANK_DEMO', 'BIL', 'SBI_TEST', 'HDFC_TEST'] as const;

export function buildExecutiveForecast(
  scope: ExecutiveForecastScope,
  horizon: ForecastHorizon,
  asOf: Date = new Date(),
): ExecutiveForecastEntry[] {
  const day = dayOf(asOf);
  const entities = ((): { id: string; label: string }[] => {
    switch (scope) {
      case 'enterprise':
        return [{ id: 'ENT', label: 'Enterprise' }];
      case 'country':
        return COUNTRIES.map((c) => ({ id: c, label: c }));
      case 'tenant':
        return TENANTS.map((t) => ({ id: t, label: t }));
      case 'portfolio':
        return PORTFOLIOS.map((p) => ({ id: p, label: p.replace(/_/g, ' ') }));
    }
  })();

  return entities.map(({ id, label }) => {
    const rng = seededRng([scope, id, horizon, day, 'execfc']);
    const current = 18 + rng() * 55;
    const dir = rng() > 0.4 ? 1 : -1;
    const delta = dir * (rng() * 14);
    const forecast = Math.max(0, Math.min(100, Math.round(current + delta)));
    const trend: ExecutiveForecastEntry['trend'] =
      delta > 2 ? 'rising' : delta < -2 ? 'falling' : 'flat';
    const confidence = Math.round((0.78 - (horizon / 180) * 0.18 + (rng() - 0.5) * 0.06) * 100) / 100;
    const top_kind = pickFrom(rng, [
      ...BANKING_PREDICTIONS,
      ...INSURANCE_PREDICTIONS,
    ] as ReadonlyArray<PredictionKind>);
    return {
      scope,
      entity_id: id,
      entity_label: label,
      horizon,
      forecast_score: forecast,
      forecast_band: bandForScore(forecast),
      delta_pp: Math.round(delta),
      trend,
      confidence: Math.max(0.4, Math.min(0.99, confidence)),
      top_kind,
    };
  });
}
