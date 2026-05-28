// services/bff/src/insurance_persistency.ts
//
// Insurance EWS — Module 5: Persistency Watch.
//
// Monitors policy persistency across the standard IRDAI milestones
// (13 / 25 / 37 / 49 / 61 months) and slices it by product, channel, and
// region. Surfaces an AI root-cause read on under-performing cohorts.
// Pure-function builders over deterministic synthesis (FNV-1a seed +
// Mulberry32), same template as Modules 1–4. Swap builder bodies to
// app_insurance.{persistency_metrics,retention_analysis,persistency_alerts}
// when the policy-admin feed lands. Shapes stay frozen.
//
// Surfaces:
//   buildPersistencyDashboard(tenant, now)      → PersistencyDashboard (4 widgets)
//   analyzePersistency(input, now)              → PersistencyAnalysis (AI root-cause)
//   listPersistencyAlerts(tenant, now, opts)    → PersistencyAlertList

// ─── deterministic synthesis helpers ───────────────────────────────────

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
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ─── domain enums + benchmarks ──────────────────────────────────────────

export const PERSISTENCY_PERIODS = [13, 25, 37, 49, 61] as const;
export type PersistencyPeriod = (typeof PERSISTENCY_PERIODS)[number];

/** IRDAI-style benchmark persistency by milestone (industry-typical). */
export const TARGET_BY_PERIOD: Record<PersistencyPeriod, number> = {
  13: 0.85,
  25: 0.75,
  37: 0.68,
  49: 0.62,
  61: 0.55,
};

export const PERSISTENCY_PRODUCTS = ['TERM_LIFE', 'ENDOWMENT', 'ULIP', 'HEALTH', 'PENSION'] as const;
export type PersistencyProduct = (typeof PERSISTENCY_PRODUCTS)[number];

export const PERSISTENCY_CHANNELS = ['agent', 'broker', 'bancassurance', 'direct', 'online'] as const;
export type PersistencyChannel = (typeof PERSISTENCY_CHANNELS)[number];

export const PERSISTENCY_REGIONS = ['North', 'South', 'East', 'West', 'Central'] as const;
export type PersistencyRegion = (typeof PERSISTENCY_REGIONS)[number];

export const PERSISTENCY_DIMENSIONS = ['product', 'channel', 'region'] as const;
export type PersistencyDimension = (typeof PERSISTENCY_DIMENSIONS)[number];

export const PERSISTENCY_BANDS = ['healthy', 'watch', 'concern', 'critical'] as const;
export type PersistencyBand = (typeof PERSISTENCY_BANDS)[number];

/** Classify a cohort by how far it sits below its period target. */
export function bandForShortfall(shortfall: number): PersistencyBand {
  if (shortfall <= 0) return 'healthy';
  if (shortfall < 0.05) return 'watch';
  if (shortfall < 0.12) return 'concern';
  return 'critical';
}

export const PERSISTENCY_ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type PersistencyAlertSeverity = (typeof PERSISTENCY_ALERT_SEVERITIES)[number];

export class PersistencyError extends Error {
  constructor(
    public code: 'invalid_input' | 'invalid_period' | 'invalid_dimension' | 'invalid_value' | 'invalid_pct',
    message: string,
  ) {
    super(message);
    this.name = 'PersistencyError';
  }
}

// ─── shapes ─────────────────────────────────────────────────────────────

export interface PersistencyTrendPoint {
  period_month: PersistencyPeriod;
  persistency_pct: number; // 0..1
  target_pct: number;
  shortfall: number; // target - actual (>0 = below target)
  band: PersistencyBand;
}
export interface DimensionPersistency {
  dimension_value: string;
  persistency_pct: number; // at the headline 13-month milestone
  target_pct: number;
  shortfall: number;
  band: PersistencyBand;
  policies_in_force: number;
}
export interface PersistencyDashboard {
  tenant_id: string;
  generated_at: string;
  totals: {
    headline_13m_pct: number; // book-wide 13-month persistency
    headline_61m_pct: number;
    cohorts_below_target: number; // across product+channel+region slices
    open_alerts: number;
    worst_dimension: string | null; // e.g. "channel:online"
  };
  persistency_trend: PersistencyTrendPoint[]; // the 5 milestones, book-wide
  product_retention: DimensionPersistency[]; // by product, worst-first
  channel_risk: DimensionPersistency[]; // by channel, worst-first
  location_persistency: DimensionPersistency[]; // by region, worst-first
  model_version: string;
}

export interface AnalyzePersistencyInput {
  dimension: string; // product | channel | region
  dimension_value: string;
  period_month?: number; // default 13
  persistency_pct?: number; // observed; if omitted, synthesised
  // Root-cause signals
  auto_debit_share?: number; // 0..1 — low → more lapses
  claims_settlement_delay_days?: number;
  agent_attrition_rate?: number; // 0..1
  complaint_rate?: number; // 0..1
  digital_engagement_score?: number; // 0..1 — low → more lapses
}

export interface RootCause {
  cause: string;
  weight: number; // 0..1 share of the explained shortfall
  detail: string;
}
export interface PersistencyAnalysis {
  dimension: PersistencyDimension;
  dimension_value: string;
  period_month: PersistencyPeriod;
  persistency_pct: number;
  target_pct: number;
  shortfall: number;
  band: PersistencyBand;
  root_causes: RootCause[];
  recommendation: string;
  model_version: string;
  analyzed_at: string;
}

export interface PersistencyAlert {
  alert_id: string;
  dimension: PersistencyDimension;
  dimension_value: string;
  period_month: PersistencyPeriod;
  persistency_pct: number;
  threshold_pct: number;
  shortfall: number;
  severity: PersistencyAlertSeverity;
  status: 'open' | 'acknowledged' | 'resolved';
  raised_at: string;
}
export interface PersistencyAlertList {
  tenant_id: string;
  generated_at: string;
  severity_filter: PersistencyAlertSeverity | 'all';
  total: number;
  alerts: PersistencyAlert[];
}

const MODEL_VERSION = 'persistency-stub-v1';

function tenantScale(tenant_id: string): number {
  return tenant_id === 'BANK_DEMO' ? 1.0 : 0.6;
}

/** Synthesise a deterministic persistency % for a (dimension_value, period). */
function synthPct(tenant_id: string, key: string, period: PersistencyPeriod): number {
  const r = rng(seedFrom(tenant_id, 'persistency', key, String(period)));
  // Centre a touch below the period target; some cohorts above, some well below.
  const target = TARGET_BY_PERIOD[period];
  const delta = (r() - 0.55) * 0.28; // bias slightly negative
  return round4(Math.max(0.2, Math.min(0.99, target + delta)));
}

function dimensionRows(
  tenant_id: string,
  values: readonly string[],
  period: PersistencyPeriod,
): DimensionPersistency[] {
  const scale = tenantScale(tenant_id);
  const target = TARGET_BY_PERIOD[period];
  return values
    .map((v) => {
      const pct = synthPct(tenant_id, v, period);
      const shortfall = round4(Math.max(0, target - pct));
      const r = rng(seedFrom(tenant_id, 'pif', v, String(period)));
      return {
        dimension_value: v,
        persistency_pct: pct,
        target_pct: target,
        shortfall,
        band: bandForShortfall(target - pct),
        policies_in_force: Math.round((2000 + r() * 18000) * scale),
      };
    })
    .sort((a, b) => b.shortfall - a.shortfall || a.dimension_value.localeCompare(b.dimension_value));
}

// ─── builders ─────────────────────────────────────────────────────────────

export function buildPersistencyDashboard(tenant_id: string, now: Date): PersistencyDashboard {
  if (!tenant_id) throw new PersistencyError('invalid_input', 'tenant_id required');

  // Book-wide trend across the 5 milestones.
  const persistency_trend: PersistencyTrendPoint[] = PERSISTENCY_PERIODS.map((p) => {
    const pct = synthPct(tenant_id, 'book', p);
    const target = TARGET_BY_PERIOD[p];
    return {
      period_month: p,
      persistency_pct: pct,
      target_pct: target,
      shortfall: round4(Math.max(0, target - pct)),
      band: bandForShortfall(target - pct),
    };
  });

  // Dimension slices at the headline 13-month milestone.
  const product_retention = dimensionRows(tenant_id, PERSISTENCY_PRODUCTS, 13);
  const channel_risk = dimensionRows(tenant_id, PERSISTENCY_CHANNELS, 13);
  const location_persistency = dimensionRows(tenant_id, PERSISTENCY_REGIONS, 13);

  const allCohorts = [
    ...product_retention.map((r) => ({ ...r, dimension: 'product' as const })),
    ...channel_risk.map((r) => ({ ...r, dimension: 'channel' as const })),
    ...location_persistency.map((r) => ({ ...r, dimension: 'region' as const })),
  ];
  const belowTarget = allCohorts.filter((c) => c.shortfall > 0);
  const worst = [...belowTarget].sort((a, b) => b.shortfall - a.shortfall)[0];

  const alerts = synthAlerts(tenant_id, now, allCohorts);
  const openAlerts = alerts.filter((a) => a.status === 'open');

  return {
    tenant_id,
    generated_at: now.toISOString(),
    totals: {
      headline_13m_pct: persistency_trend.find((t) => t.period_month === 13)!.persistency_pct,
      headline_61m_pct: persistency_trend.find((t) => t.period_month === 61)!.persistency_pct,
      cohorts_below_target: belowTarget.length,
      open_alerts: openAlerts.length,
      worst_dimension: worst ? `${worst.dimension}:${worst.dimension_value}` : null,
    },
    persistency_trend,
    product_retention,
    channel_risk,
    location_persistency,
    model_version: MODEL_VERSION,
  };
}

interface CohortRow extends DimensionPersistency {
  dimension: PersistencyDimension;
}

function severityFromBand(band: PersistencyBand): PersistencyAlertSeverity {
  if (band === 'critical') return 'critical';
  if (band === 'concern') return 'warning';
  if (band === 'watch') return 'info';
  return 'info';
}

function synthAlerts(tenant_id: string, now: Date, cohorts: CohortRow[]): PersistencyAlert[] {
  let seq = 0;
  return cohorts
    .filter((c) => c.shortfall > 0.05) // watch+ only raises an alert
    .map((c) => ({
      alert_id: `PST-${tenant_id}-${String(800000 + seq++)}`,
      dimension: c.dimension,
      dimension_value: c.dimension_value,
      period_month: 13 as PersistencyPeriod,
      persistency_pct: c.persistency_pct,
      threshold_pct: c.target_pct,
      shortfall: c.shortfall,
      severity: severityFromBand(c.band),
      status: 'open' as const,
      raised_at: now.toISOString(),
    }))
    .sort((a, b) => b.shortfall - a.shortfall || a.alert_id.localeCompare(b.alert_id));
}

/**
 * AI root-cause read on an under-performing cohort. Deterministic — derives
 * a weighted root-cause breakdown from the supplied behavioural signals and
 * the observed (or synthesised) persistency shortfall. Same inputs → same.
 */
export function analyzePersistency(input: AnalyzePersistencyInput, now: Date): PersistencyAnalysis {
  if (!input || typeof input !== 'object') throw new PersistencyError('invalid_input', 'request body required');
  if (!input.dimension || !PERSISTENCY_DIMENSIONS.includes(input.dimension as PersistencyDimension)) {
    throw new PersistencyError('invalid_dimension', `dimension must be one of ${PERSISTENCY_DIMENSIONS.join(', ')}`);
  }
  if (!input.dimension_value || typeof input.dimension_value !== 'string') {
    throw new PersistencyError('invalid_value', 'dimension_value required');
  }
  const dimension = input.dimension as PersistencyDimension;

  let period: PersistencyPeriod = 13;
  if (input.period_month !== undefined) {
    if (!PERSISTENCY_PERIODS.includes(input.period_month as PersistencyPeriod)) {
      throw new PersistencyError('invalid_period', `period_month must be one of ${PERSISTENCY_PERIODS.join(', ')}`);
    }
    period = input.period_month as PersistencyPeriod;
  }
  const target = TARGET_BY_PERIOD[period];

  let pct: number;
  if (input.persistency_pct !== undefined) {
    pct = numOr(input.persistency_pct, target);
    if (pct < 0 || pct > 1) throw new PersistencyError('invalid_pct', 'persistency_pct must be in [0,1]');
  } else {
    pct = synthPct('ADHOC', input.dimension_value, period);
  }
  const shortfall = round4(Math.max(0, target - pct));
  const band = bandForShortfall(target - pct);

  // Root-cause signals → raw contributions (clamped). When omitted, signals
  // default to neutral so the breakdown leans on whatever was supplied.
  const autoDebit = clamp01OrThrow(input.auto_debit_share, 0.6);
  const claimsDelay = numOr(input.claims_settlement_delay_days, 7);
  const attrition = clamp01OrThrow(input.agent_attrition_rate, 0.1);
  const complaints = clamp01OrThrow(input.complaint_rate, 0.05);
  const digital = clamp01OrThrow(input.digital_engagement_score, 0.6);
  if (claimsDelay < 0) throw new PersistencyError('invalid_value', 'claims_settlement_delay_days must be ≥ 0');

  const cLowAutoDebit = (1 - autoDebit) * 0.4; // manual payers lapse more
  const cClaimsDelay = Math.min(0.3, claimsDelay / 60);
  const cAttrition = attrition * 0.5;
  const cComplaints = complaints * 0.6;
  const cLowDigital = (1 - digital) * 0.25;

  const rawCauses = [
    { cause: 'low_auto_debit_adoption', weight: cLowAutoDebit, detail: `Auto-debit share ${(autoDebit * 100).toFixed(0)}% — manual payers lapse more` },
    { cause: 'claims_settlement_delay', weight: cClaimsDelay, detail: `Avg settlement delay ${claimsDelay}d erodes trust` },
    { cause: 'agent_attrition', weight: cAttrition, detail: `Servicing-agent attrition ${(attrition * 100).toFixed(0)}% leaves orphaned policies` },
    { cause: 'complaint_rate', weight: cComplaints, detail: `Complaint rate ${(complaints * 100).toFixed(1)}% signals dissatisfaction` },
    { cause: 'low_digital_engagement', weight: cLowDigital, detail: `Digital engagement ${(digital * 100).toFixed(0)}% — disengaged customers drift` },
  ].filter((c) => c.weight > 0.001);

  // Normalise weights to sum to 1 (share of explained shortfall).
  const totalW = rawCauses.reduce((a, c) => a + c.weight, 0) || 1;
  const root_causes: RootCause[] = rawCauses
    .map((c) => ({ ...c, weight: round4(c.weight / totalW) }))
    .sort((a, b) => b.weight - a.weight);

  return {
    dimension,
    dimension_value: input.dimension_value,
    period_month: period,
    persistency_pct: round4(pct),
    target_pct: target,
    shortfall,
    band,
    root_causes,
    recommendation: recommend(band, root_causes[0]?.cause),
    model_version: MODEL_VERSION,
    analyzed_at: now.toISOString(),
  };
}

function recommend(band: PersistencyBand, topCause?: string): string {
  if (band === 'healthy') return 'Persistency at or above target — maintain current servicing cadence';
  const lead =
    topCause === 'low_auto_debit_adoption'
      ? 'Run an auto-debit enrolment drive for this cohort'
      : topCause === 'claims_settlement_delay'
        ? 'Fast-track claims settlement + proactive status comms'
        : topCause === 'agent_attrition'
          ? 'Reassign orphaned policies to active agents + welcome-back outreach'
          : topCause === 'complaint_rate'
            ? 'Trigger grievance-redressal review + service-recovery calls'
            : 'Launch a digital re-engagement + renewal-reminder sequence';
  return band === 'critical' ? `${lead} — escalate to retention war-room` : lead;
}

export interface PersistencyAlertOpts {
  severity?: string;
  limit?: number;
}

export function listPersistencyAlerts(
  tenant_id: string,
  now: Date,
  opts: PersistencyAlertOpts = {},
): PersistencyAlertList {
  if (!tenant_id) throw new PersistencyError('invalid_input', 'tenant_id required');
  let severity: PersistencyAlertSeverity | 'all' = 'all';
  if (opts.severity !== undefined && opts.severity !== 'all') {
    if (!PERSISTENCY_ALERT_SEVERITIES.includes(opts.severity as PersistencyAlertSeverity)) {
      throw new PersistencyError('invalid_input', `severity must be one of ${PERSISTENCY_ALERT_SEVERITIES.join(', ')} or 'all'`);
    }
    severity = opts.severity as PersistencyAlertSeverity;
  }
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));

  const dash = buildPersistencyDashboard(tenant_id, now);
  const cohorts: CohortRow[] = [
    ...dash.product_retention.map((r) => ({ ...r, dimension: 'product' as const })),
    ...dash.channel_risk.map((r) => ({ ...r, dimension: 'channel' as const })),
    ...dash.location_persistency.map((r) => ({ ...r, dimension: 'region' as const })),
  ];
  let alerts = synthAlerts(tenant_id, now, cohorts);
  if (severity !== 'all') alerts = alerts.filter((a) => a.severity === severity);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    severity_filter: severity,
    total: alerts.length,
    alerts: alerts.slice(0, limit),
  };
}

function numOr(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new PersistencyError('invalid_value', 'numeric signal must be finite');
  return n;
}
function clamp01OrThrow(v: unknown, fallback: number): number {
  const n = numOr(v, fallback);
  if (n < 0 || n > 1) throw new PersistencyError('invalid_value', 'signal must be in [0,1]');
  return n;
}
