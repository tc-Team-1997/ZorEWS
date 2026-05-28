// services/bff/src/insurance_policy_lapse.ts
//
// Insurance EWS — Module 1: Policy Lapse Risk.
//
// Predicts which in-force policies are likely to lapse in the next
// 30 / 60 / 90 days and surfaces retention opportunities. Pure-function
// builders over deterministic synthesis (FNV-1a seed + Mulberry32 PRNG),
// same pattern as bil_dashboards.ts — a given (tenant, day) yields a
// stable book so the SPA can integrate against the contract today. When
// the insurer's policy + payment feeds land in app_insurance.* the
// builder bodies swap to real queries; the response shapes stay frozen.
//
// Surfaces:
//   buildPolicyLapseDashboard(tenant, now)         → LapseDashboard (5 widgets)
//   listHighRiskPolicies(tenant, now, opts)        → HighRiskPolicyList
//   predictPolicyLapse(input)                      → LapsePrediction (ad-hoc scoring)
//
// Errors: PolicyLapseError carries machine-readable codes the route
// layer maps to HTTP (invalid_input → 400, invalid_horizon → 400).

// ─── deterministic synthesis helpers (shared shape with bil_dashboards) ──

function seedFrom(...parts: string[]): number {
  let h = 2166136261 >>> 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
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

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ─── domain enums ────────────────────────────────────────────────────

export const LAPSE_CHANNELS = [
  'agent',
  'broker',
  'bancassurance',
  'direct',
  'online',
] as const;
export type LapseChannel = (typeof LAPSE_CHANNELS)[number];

export const LAPSE_REGIONS = ['North', 'South', 'East', 'West', 'Central'] as const;
export type LapseRegion = (typeof LAPSE_REGIONS)[number];

export const LAPSE_PRODUCTS = [
  'TERM_LIFE',
  'ENDOWMENT',
  'ULIP',
  'HEALTH',
  'MOTOR',
] as const;
export type LapseProduct = (typeof LAPSE_PRODUCTS)[number];

export const RETENTION_BANDS = ['low', 'medium', 'high', 'critical'] as const;
export type RetentionBand = (typeof RETENTION_BANDS)[number];

export const LAPSE_HORIZONS = [30, 60, 90] as const;
export type LapseHorizon = (typeof LAPSE_HORIZONS)[number];

/** Map a lapse probability to a retention-risk band. */
export function bandFor(p: number): RetentionBand {
  if (p >= 0.75) return 'critical';
  if (p >= 0.5) return 'high';
  if (p >= 0.25) return 'medium';
  return 'low';
}

export class PolicyLapseError extends Error {
  constructor(
    public code:
      | 'invalid_input'
      | 'invalid_horizon'
      | 'invalid_payment_behaviour',
    message: string,
  ) {
    super(message);
    this.name = 'PolicyLapseError';
  }
}

// ─── shapes ──────────────────────────────────────────────────────────

export interface LapseDriver {
  feature: string;
  contribution: number; // signed; positive raises lapse risk
}

export interface PolicyLapseRow {
  policy_id: string;
  customer_id: string;
  customer_name: string;
  product_code: LapseProduct;
  channel: LapseChannel;
  region: LapseRegion;
  gwp_kes: number;
  lapse_probability: number; // 0..1
  renewal_probability: number; // 0..1
  horizon_days: LapseHorizon;
  retention_risk_band: RetentionBand;
  days_since_last_payment: number;
  missed_instalments_12m: number;
  top_drivers: LapseDriver[];
  recommended_action: string;
  model_version: string;
  scored_at: string;
}

export interface LapseTrendPoint {
  date: string; // YYYY-MM-DD (upcoming due dates)
  expected_lapses: number;
  gwp_at_risk_kes: number;
}

export interface ChannelLapseRisk {
  channel: LapseChannel;
  policies_at_risk: number;
  mean_lapse_probability: number;
  gwp_at_risk_kes: number;
}

export interface RegionLapseRisk {
  region: LapseRegion;
  policies_at_risk: number;
  mean_lapse_probability: number;
  gwp_at_risk_kes: number;
}

export interface RetentionOpportunity {
  policy_id: string;
  customer_name: string;
  gwp_kes: number;
  lapse_probability: number;
  renewal_probability: number;
  recommended_action: string;
  expected_gwp_saved_kes: number;
}

export interface LapseDashboard {
  tenant_id: string;
  generated_at: string;
  totals: {
    in_force_policies: number;
    at_risk_policies: number; // band ∈ {high, critical}
    critical_count: number;
    high_count: number;
    gwp_at_risk_kes: number;
    mean_lapse_probability: number;
  };
  high_risk_policies: PolicyLapseRow[]; // top 10 by lapse_probability
  upcoming_lapse_trend: LapseTrendPoint[]; // next ~12 weeks
  channel_lapse_risk: ChannelLapseRisk[];
  region_lapse_risk: RegionLapseRisk[];
  top_retention_opportunities: RetentionOpportunity[]; // top 5 by gwp × probability
  model_version: string;
}

export interface HighRiskPolicyList {
  tenant_id: string;
  generated_at: string;
  horizon_days: LapseHorizon;
  band_filter: RetentionBand | 'all';
  total: number;
  policies: PolicyLapseRow[];
}

export interface PredictLapseInput {
  customer_id: string;
  policy_id?: string;
  product_code?: string;
  channel?: string;
  region?: string;
  gwp_kes?: number;
  horizon_days?: number;
  // Payment-behaviour signals (drive the scored probability)
  missed_instalments_12m?: number;
  days_since_last_payment?: number;
  prior_lapses?: number;
  claims_in_12m?: number;
  tenure_months?: number;
}

export interface LapsePrediction {
  customer_id: string;
  policy_id: string;
  horizon_days: LapseHorizon;
  lapse_probability: number;
  renewal_probability: number;
  retention_risk_band: RetentionBand;
  top_drivers: LapseDriver[];
  recommended_action: string;
  model_version: string;
  scored_at: string;
}

const MODEL_VERSION = 'lapse-stub-v1';

const FIRST_NAMES = [
  'Aarav', 'Diya', 'Kabir', 'Ananya', 'Vivaan', 'Ishika', 'Reyansh', 'Myra',
  'Arjun', 'Saanvi', 'Aditya', 'Kiara', 'Vihaan', 'Anika', 'Rohan', 'Tara',
];
const LAST_NAMES = [
  'Sharma', 'Patel', 'Reddy', 'Iyer', 'Khan', 'Nair', 'Mehta', 'Das',
  'Gupta', 'Bose', 'Rao', 'Joshi', 'Menon', 'Verma', 'Pillai', 'Shetty',
];

function synthName(r: () => number): string {
  const f = FIRST_NAMES[Math.floor(r() * FIRST_NAMES.length)];
  const l = LAST_NAMES[Math.floor(r() * LAST_NAMES.length)];
  return `${f} ${l}`;
}

function recommendedAction(band: RetentionBand, channel: LapseChannel): string {
  if (band === 'critical') {
    return channel === 'agent'
      ? 'Assign agent for in-person retention visit within 48h'
      : 'Priority outbound retention call + premium-holiday offer';
  }
  if (band === 'high') {
    return 'Outbound retention call + auto-debit enrolment nudge';
  }
  if (band === 'medium') {
    return 'Automated SMS + email renewal reminder sequence';
  }
  return 'Monitor — include in standard renewal cycle';
}

// Per-tenant scale so two tenants look distinct side-by-side (mirrors the
// bil_dashboards.ts convention: BIL ~60% the volume of BANK_DEMO).
function tenantScale(tenant_id: string): number {
  return tenant_id === 'BANK_DEMO' ? 1.0 : 0.6;
}

/** Synthesise the full at-risk policy book for a tenant on a given day. */
function synthPolicyBook(tenant_id: string, now: Date): PolicyLapseRow[] {
  const day = utcDay(now);
  const scale = tenantScale(tenant_id);
  const count = Math.max(20, Math.round(60 * scale));
  const out: PolicyLapseRow[] = [];
  for (let i = 0; i < count; i++) {
    const r = rng(seedFrom(tenant_id, day, 'policy', String(i)));
    const product = LAPSE_PRODUCTS[Math.floor(r() * LAPSE_PRODUCTS.length)];
    const channel = LAPSE_CHANNELS[Math.floor(r() * LAPSE_CHANNELS.length)];
    const region = LAPSE_REGIONS[Math.floor(r() * LAPSE_REGIONS.length)];
    // Lapse probability skews toward the low/medium end; ~25% are high/critical.
    const base = r();
    const lapse = round4(Math.min(1, base ** 1.4)); // bias downward
    const band = bandFor(lapse);
    const missed = Math.floor(r() * 6);
    const daysSince = 10 + Math.floor(r() * 120);
    const gwp = round2((5000 + r() * 95000) * (product === 'ULIP' ? 2.2 : product === 'ENDOWMENT' ? 1.6 : 1));
    const renewal = round4(Math.max(0, 1 - lapse - r() * 0.1));
    const drivers: LapseDriver[] = [
      { feature: 'missed_instalments_12m', contribution: round4(missed * 0.08) },
      { feature: 'days_since_last_payment', contribution: round4(Math.min(0.3, daysSince / 400)) },
      { feature: 'channel_risk', contribution: round4(channel === 'online' ? 0.12 : channel === 'broker' ? 0.08 : 0.03) },
      { feature: 'product_persistency', contribution: round4(product === 'ULIP' ? 0.1 : 0.04) },
    ].sort((a, b) => b.contribution - a.contribution).slice(0, 3);
    out.push({
      policy_id: `POL-${tenant_id}-${String(100000 + i)}`,
      customer_id: `CUST-${tenant_id}-${String(200000 + i)}`,
      customer_name: synthName(r),
      product_code: product,
      channel,
      region,
      gwp_kes: gwp,
      lapse_probability: lapse,
      renewal_probability: renewal,
      horizon_days: LAPSE_HORIZONS[Math.floor(r() * LAPSE_HORIZONS.length)],
      retention_risk_band: band,
      days_since_last_payment: daysSince,
      missed_instalments_12m: missed,
      top_drivers: drivers,
      recommended_action: recommendedAction(band, channel),
      model_version: MODEL_VERSION,
      scored_at: now.toISOString(),
    });
  }
  return out;
}

// ─── builders ────────────────────────────────────────────────────────

export function buildPolicyLapseDashboard(tenant_id: string, now: Date): LapseDashboard {
  if (!tenant_id) throw new PolicyLapseError('invalid_input', 'tenant_id required');
  const book = synthPolicyBook(tenant_id, now);
  const atRisk = book.filter((p) => p.retention_risk_band === 'high' || p.retention_risk_band === 'critical');
  const critical = book.filter((p) => p.retention_risk_band === 'critical');
  const high = book.filter((p) => p.retention_risk_band === 'high');
  const gwpAtRisk = round2(atRisk.reduce((a, p) => a + p.gwp_kes, 0));
  const meanProb = book.length ? round4(book.reduce((a, p) => a + p.lapse_probability, 0) / book.length) : 0;

  // High-risk policies — top 10 by lapse_probability desc, policy_id tie-break.
  const highRisk = [...book]
    .sort((a, b) => b.lapse_probability - a.lapse_probability || a.policy_id.localeCompare(b.policy_id))
    .slice(0, 10);

  // Upcoming lapse trend — next 12 weeks of expected lapses + GWP at risk.
  const trend: LapseTrendPoint[] = [];
  for (let w = 1; w <= 12; w++) {
    const r = rng(seedFrom(tenant_id, utcDay(now), 'trend', String(w)));
    const d = new Date(now.getTime() + w * 7 * 86400000);
    const expected = Math.round(atRisk.length * (0.04 + r() * 0.06));
    const gwp = round2(gwpAtRisk * (0.03 + r() * 0.05));
    trend.push({ date: utcDay(d), expected_lapses: expected, gwp_at_risk_kes: gwp });
  }

  // Channel-wise + region-wise rollups over the at-risk subset.
  const channel_lapse_risk: ChannelLapseRisk[] = LAPSE_CHANNELS.map((ch) => {
    const rows = atRisk.filter((p) => p.channel === ch);
    return {
      channel: ch,
      policies_at_risk: rows.length,
      mean_lapse_probability: rows.length ? round4(rows.reduce((a, p) => a + p.lapse_probability, 0) / rows.length) : 0,
      gwp_at_risk_kes: round2(rows.reduce((a, p) => a + p.gwp_kes, 0)),
    };
  }).sort((a, b) => b.gwp_at_risk_kes - a.gwp_at_risk_kes);

  const region_lapse_risk: RegionLapseRisk[] = LAPSE_REGIONS.map((rg) => {
    const rows = atRisk.filter((p) => p.region === rg);
    return {
      region: rg,
      policies_at_risk: rows.length,
      mean_lapse_probability: rows.length ? round4(rows.reduce((a, p) => a + p.lapse_probability, 0) / rows.length) : 0,
      gwp_at_risk_kes: round2(rows.reduce((a, p) => a + p.gwp_kes, 0)),
    };
  }).sort((a, b) => b.gwp_at_risk_kes - a.gwp_at_risk_kes);

  // Top retention opportunities — rank by GWP × lapse_probability (biggest
  // saveable book first). expected_gwp_saved assumes a ~55% save rate.
  const top_retention_opportunities: RetentionOpportunity[] = [...atRisk]
    .map((p) => ({
      policy_id: p.policy_id,
      customer_name: p.customer_name,
      gwp_kes: p.gwp_kes,
      lapse_probability: p.lapse_probability,
      renewal_probability: p.renewal_probability,
      recommended_action: p.recommended_action,
      expected_gwp_saved_kes: round2(p.gwp_kes * p.lapse_probability * 0.55),
      _rank: p.gwp_kes * p.lapse_probability,
    }))
    .sort((a, b) => b._rank - a._rank || a.policy_id.localeCompare(b.policy_id))
    .slice(0, 5)
    .map(({ _rank, ...rest }) => rest);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    totals: {
      in_force_policies: book.length,
      at_risk_policies: atRisk.length,
      critical_count: critical.length,
      high_count: high.length,
      gwp_at_risk_kes: gwpAtRisk,
      mean_lapse_probability: meanProb,
    },
    high_risk_policies: highRisk,
    upcoming_lapse_trend: trend,
    channel_lapse_risk,
    region_lapse_risk,
    top_retention_opportunities,
    model_version: MODEL_VERSION,
  };
}

export interface HighRiskOpts {
  horizon_days?: number;
  band?: string;
  limit?: number;
}

export function listHighRiskPolicies(
  tenant_id: string,
  now: Date,
  opts: HighRiskOpts = {},
): HighRiskPolicyList {
  if (!tenant_id) throw new PolicyLapseError('invalid_input', 'tenant_id required');

  let horizon: LapseHorizon = 30;
  if (opts.horizon_days !== undefined) {
    if (!LAPSE_HORIZONS.includes(opts.horizon_days as LapseHorizon)) {
      throw new PolicyLapseError('invalid_horizon', 'horizon_days must be 30, 60, or 90');
    }
    horizon = opts.horizon_days as LapseHorizon;
  }

  let band: RetentionBand | 'all' = 'all';
  if (opts.band !== undefined && opts.band !== 'all') {
    if (!RETENTION_BANDS.includes(opts.band as RetentionBand)) {
      throw new PolicyLapseError('invalid_input', `band must be one of ${RETENTION_BANDS.join(', ')} or 'all'`);
    }
    band = opts.band as RetentionBand;
  }

  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const book = synthPolicyBook(tenant_id, now);
  let rows = book.filter((p) => p.retention_risk_band === 'high' || p.retention_risk_band === 'critical');
  if (band !== 'all') rows = rows.filter((p) => p.retention_risk_band === band);
  rows.sort((a, b) => b.lapse_probability - a.lapse_probability || a.policy_id.localeCompare(b.policy_id));

  return {
    tenant_id,
    generated_at: now.toISOString(),
    horizon_days: horizon,
    band_filter: band,
    total: rows.length,
    policies: rows.slice(0, limit),
  };
}

/**
 * Ad-hoc lapse scoring from explicit payment-behaviour signals. This is the
 * deterministic stub of the production model: a logistic-ish blend of the
 * behavioural drivers, clamped to [0,1]. Same inputs → same score.
 */
export function predictPolicyLapse(input: PredictLapseInput, now: Date): LapsePrediction {
  if (!input || typeof input !== 'object') {
    throw new PolicyLapseError('invalid_input', 'request body required');
  }
  if (!input.customer_id || typeof input.customer_id !== 'string') {
    throw new PolicyLapseError('invalid_input', 'customer_id required');
  }

  let horizon: LapseHorizon = 30;
  if (input.horizon_days !== undefined) {
    if (!LAPSE_HORIZONS.includes(input.horizon_days as LapseHorizon)) {
      throw new PolicyLapseError('invalid_horizon', 'horizon_days must be 30, 60, or 90');
    }
    horizon = input.horizon_days as LapseHorizon;
  }

  const missed = numOr(input.missed_instalments_12m, 0);
  const daysSince = numOr(input.days_since_last_payment, 30);
  const priorLapses = numOr(input.prior_lapses, 0);
  const claims = numOr(input.claims_in_12m, 0);
  const tenure = numOr(input.tenure_months, 24);
  if (missed < 0 || daysSince < 0 || priorLapses < 0 || tenure < 0) {
    throw new PolicyLapseError('invalid_payment_behaviour', 'behaviour signals must be non-negative');
  }

  // Driver contributions (each clamped); longer horizons raise risk slightly.
  const dMissed = Math.min(0.4, missed * 0.09);
  const dDays = Math.min(0.3, daysSince / 365);
  const dPrior = Math.min(0.2, priorLapses * 0.1);
  const dTenure = Math.max(-0.15, -tenure / 600); // longer tenure lowers risk
  const dClaims = Math.min(0.08, claims * 0.02); // recent claim → slightly stickier? small +
  const dHorizon = horizon === 90 ? 0.06 : horizon === 60 ? 0.03 : 0;

  const raw = 0.12 + dMissed + dDays + dPrior + dTenure + dClaims + dHorizon;
  const lapse = round4(Math.max(0, Math.min(1, raw)));
  const renewal = round4(Math.max(0, 1 - lapse));
  const band = bandFor(lapse);

  const channel = (input.channel && LAPSE_CHANNELS.includes(input.channel as LapseChannel)
    ? (input.channel as LapseChannel)
    : 'agent');

  const drivers: LapseDriver[] = [
    { feature: 'missed_instalments_12m', contribution: round4(dMissed) },
    { feature: 'days_since_last_payment', contribution: round4(dDays) },
    { feature: 'prior_lapses', contribution: round4(dPrior) },
    { feature: 'tenure_months', contribution: round4(dTenure) },
    { feature: 'horizon_days', contribution: round4(dHorizon) },
  ]
    .filter((d) => d.contribution !== 0)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 5);

  return {
    customer_id: input.customer_id,
    policy_id: input.policy_id ?? `POL-${input.customer_id}`,
    horizon_days: horizon,
    lapse_probability: lapse,
    renewal_probability: renewal,
    retention_risk_band: band,
    top_drivers: drivers,
    recommended_action: recommendedAction(band, channel),
    model_version: MODEL_VERSION,
    scored_at: now.toISOString(),
  };
}

function numOr(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new PolicyLapseError('invalid_input', 'numeric signal must be finite');
  return n;
}
