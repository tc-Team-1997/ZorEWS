// web/src/modules/executive/executiveCockpitEngine.ts
//
// Executive Risk Cockpit — pure data resolvers for the 8 cockpit sections.
//
// Reuses the widget registry from the Role-Based Dashboard Engine for
// Section 1 (Enterprise Risk Overview KPIs). Sections 2-8 add executive-
// specific data via deterministic FNV-1a + Mulberry32 synthesis (same
// pattern as bil_dashboards.ts, aiInsights.ts, Security Activity Center).
//
// Production swap: each resolver function's body becomes a BFF query
// against the appropriate mart/store. Signatures + return shapes stay
// stable, so the cockpit page never has to change.

import { getWidget } from '@/modules/dashboard/roleEngine/widgetRegistry';

// ───────────────────────────────────────────────────────────────────────
// Role gate — the 7 personas allowed into the cockpit
// ───────────────────────────────────────────────────────────────────────

export type ExecutiveRole =
  | 'super_admin'
  | 'cro'
  | 'ceo'
  | 'cfo'
  | 'coo'
  | 'board_member'
  | 'country_head';

export const EXECUTIVE_ROLES: readonly ExecutiveRole[] = [
  'super_admin', 'cro', 'ceo', 'cfo', 'coo', 'board_member', 'country_head',
] as const;

/**
 * Maps a user's role array → whether they can access the cockpit.
 * Accepts either the 16 enterprise role ids OR the 5 legacy backend roles
 * (admin → super_admin equivalence is the closest the backend currently has).
 */
export function canAccessExecutiveCockpit(roles: readonly string[] | null | undefined): boolean {
  if (!roles || roles.length === 0) return false;
  if (roles.includes('super_admin')) return true;
  if (roles.includes('cro')) return true;
  if (roles.includes('ceo')) return true;
  if (roles.includes('cfo')) return true;
  if (roles.includes('coo')) return true;
  if (roles.includes('board_member')) return true;
  if (roles.includes('country_head')) return true;
  if (roles.includes('executive')) return true; // generic exec
  if (roles.includes('admin')) return true;     // legacy backend admin treated as super_admin
  return false;
}

// ───────────────────────────────────────────────────────────────────────
// FNV-1a + Mulberry32 — deterministic synthesis (same scheme as aiInsights)
// ───────────────────────────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function rngFor(scope: string): () => number {
  return mulberry32(fnv1a(scope));
}

// ───────────────────────────────────────────────────────────────────────
// Section 1 — Enterprise Risk Overview (7 KPI widget refs)
// ───────────────────────────────────────────────────────────────────────

export interface EnterpriseRiskKpi {
  widget_id: string;
  label: string;
  drill_to: string | null;
  /** Deterministic synthetic value for prototype demo; null when unwired. */
  value: string;
  /** Optional sub-line ("vs last month" / "target 90%" etc.). */
  sub: string;
}

const ENTERPRISE_RISK_KPI_IDS: readonly string[] = [
  'rs_enterprise_risk_score',
  'rs_portfolio_health',
  'kpi_total_alerts',
  'kpi_open_cases',
  'kpi_fraud_exposure_kes',
  'kpi_compliance_score',
  'kpi_recovery_rate',
];

export function getEnterpriseRiskOverview(tenant_id: string, asOf: Date = new Date()): EnterpriseRiskKpi[] {
  const day = asOf.toISOString().slice(0, 10);
  const rng = rngFor('exec:overview:' + tenant_id + ':' + day);

  return ENTERPRISE_RISK_KPI_IDS.map((widget_id) => {
    const def = getWidget(widget_id);
    return {
      widget_id,
      label: def?.label ?? widget_id,
      drill_to: def?.drill_to ?? null,
      value: synthesiseKpiValue(widget_id, rng),
      sub: synthesiseKpiSub(widget_id, rng),
    };
  });
}

function synthesiseKpiValue(id: string, rng: () => number): string {
  if (id === 'rs_enterprise_risk_score') return Math.round(45 + rng() * 25).toString(); // 45..70 / 100
  if (id === 'rs_portfolio_health') return Math.round(72 + rng() * 18).toString();      // 72..90 / 100
  if (id === 'kpi_total_alerts') return Math.round(380 + rng() * 220).toString();
  if (id === 'kpi_open_cases') return Math.round(45 + rng() * 80).toString();
  if (id === 'kpi_fraud_exposure_kes') return '₹' + (12 + rng() * 18).toFixed(1) + ' Cr';
  if (id === 'kpi_compliance_score') return (88 + rng() * 11).toFixed(1) + '%';
  if (id === 'kpi_recovery_rate') return (84 + rng() * 12).toFixed(1) + '%';
  return '—';
}

function synthesiseKpiSub(id: string, rng: () => number): string {
  const delta = (rng() * 20 - 10).toFixed(1);
  const dir = parseFloat(delta) >= 0 ? '↑' : '↓';
  if (id === 'rs_enterprise_risk_score') return `${dir} ${Math.abs(parseFloat(delta))} pts vs last month`;
  if (id === 'rs_portfolio_health') return `${dir} ${Math.abs(parseFloat(delta))} pts vs last quarter`;
  if (id === 'kpi_total_alerts') return `last 7d`;
  if (id === 'kpi_open_cases') return `${dir} ${Math.abs(parseFloat(delta))}% vs last week`;
  if (id === 'kpi_fraud_exposure_kes') return `${dir} ${Math.abs(parseFloat(delta))}% MoM`;
  if (id === 'kpi_compliance_score') return `target 90%`;
  if (id === 'kpi_recovery_rate') return `target 88%`;
  return '';
}

// ───────────────────────────────────────────────────────────────────────
// Section 2 — Risk Heatmaps (country / tenant / branch / sector)
// ───────────────────────────────────────────────────────────────────────

export type HeatmapScope = 'country' | 'tenant' | 'branch' | 'sector';

export interface HeatmapCell {
  label: string;
  /** 0..100 composite risk score */
  risk_score: number;
  /** Cohort size (customers / loans / employees / etc.) */
  cohort_size: number;
  /** low / medium / high / critical band */
  band: 'low' | 'medium' | 'high' | 'critical';
  /** Optional drill target. */
  drill_to?: string;
}

const COUNTRIES = ['India', 'Nepal', 'Bhutan', 'Bangladesh', 'Sri Lanka', 'Kenya', 'Uganda', 'Tanzania'];
const TENANTS = ['BANK_DEMO', 'BIL', 'BIL_Mumbai', 'BIL_Delhi'];
const BRANCHES = ['BR-001 Mumbai HQ', 'BR-018 Delhi NCR', 'BR-082 Pune', 'BR-104 Bangalore', 'BR-211 Chennai', 'BR-340 Hyderabad', 'BR-512 Kolkata', 'BR-678 Ahmedabad'];
const SECTORS = ['Retail Banking', 'SME Lending', 'Corporate Banking', 'Auto Loans', 'Personal Loans', 'Working Capital', 'Insurance — Life', 'Insurance — General'];

export function getRiskHeatmap(scope: HeatmapScope, tenant_id: string, asOf: Date = new Date()): HeatmapCell[] {
  const day = asOf.toISOString().slice(0, 10);
  const rng = rngFor('exec:heatmap:' + scope + ':' + tenant_id + ':' + day);

  let labels: readonly string[];
  switch (scope) {
    case 'country': labels = COUNTRIES; break;
    case 'tenant': labels = TENANTS; break;
    case 'branch': labels = BRANCHES; break;
    case 'sector': labels = SECTORS; break;
  }

  return labels.map((label) => {
    const score = Math.round(rng() * 100);
    const cohort = Math.round(50 + rng() * 12000);
    return {
      label,
      risk_score: score,
      cohort_size: cohort,
      band: scoreToBand(score),
      drill_to: scope === 'branch' ? '/branch-heatmap' : (scope === 'sector' ? '/banking/sectors' : undefined),
    };
  });
}

function scoreToBand(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

// ───────────────────────────────────────────────────────────────────────
// Section 3 — Top Risk Exposures (4 leaderboards)
// ───────────────────────────────────────────────────────────────────────

export type ExposureKind = 'borrowers' | 'portfolios' | 'policies' | 'fraud_cases';

export interface ExposureRow {
  rank: number;
  entity_id: string;
  entity_name: string;
  /** KES exposure or notional value. */
  exposure_kes: number;
  risk_score: number;
  band: 'low' | 'medium' | 'high' | 'critical';
  /** Top 1-2 contributing factors. */
  drivers: string[];
  drill_to?: string;
}

export function getTopExposures(kind: ExposureKind, tenant_id: string, asOf: Date = new Date()): ExposureRow[] {
  const day = asOf.toISOString().slice(0, 10);
  const rng = rngFor('exec:top:' + kind + ':' + tenant_id + ':' + day);

  const driversPool: Record<ExposureKind, string[]> = {
    borrowers: ['rising DPD', 'utilisation > 95%', 'sector downturn', 'income drop', 'bureau score fell'],
    portfolios: ['NPA concentration', 'sector exposure', 'foreign-currency risk', 'tenor mismatch'],
    policies: ['lapse probability ↑', 'claims anomaly', 'agent risk', 'premium delinquency'],
    fraud_cases: ['velocity anomaly', 'channel switch', 'AML hit', 'document mismatch', 'repeat claimant'],
  };

  const prefixMap: Record<ExposureKind, string> = {
    borrowers: 'CUST-',
    portfolios: 'PORT-',
    policies: 'POL-',
    fraud_cases: 'CASE-',
  };

  const drillMap: Record<ExposureKind, string> = {
    borrowers: '/customers',
    portfolios: '/banking/sectors',
    policies: '/insurance/policy-lapse',
    fraud_cases: '/cms/cases',
  };

  return Array.from({ length: 10 }).map((_, i) => {
    const score = Math.round(70 + rng() * 30); // top exposures are biased high
    const exposure = Math.round((5 + rng() * 95) * 1_00_000); // 5L..1Cr
    const pool = driversPool[kind];
    const drivers: string[] = [];
    drivers.push(pool[Math.floor(rng() * pool.length)]!);
    if (rng() > 0.5) drivers.push(pool[Math.floor(rng() * pool.length)]!);

    return {
      rank: i + 1,
      entity_id: prefixMap[kind] + (10000 + Math.round(rng() * 90000)),
      entity_name: synthesiseEntityName(kind, rng),
      exposure_kes: exposure,
      risk_score: score,
      band: scoreToBand(score),
      drivers: Array.from(new Set(drivers)),
      drill_to: drillMap[kind],
    };
  });
}

const FIRST_NAMES = ['Aarav', 'Ananya', 'Rajesh', 'Priya', 'Vikram', 'Meera', 'Arjun', 'Sneha', 'Karan', 'Divya'];
const LAST_NAMES = ['Sharma', 'Patel', 'Iyer', 'Reddy', 'Nair', 'Singh', 'Verma', 'Joshi', 'Mehta', 'Khan'];
const PORTFOLIO_NAMES = ['Retail Auto Q3', 'SME WC Bucket', 'CRE Mumbai', 'Microfinance NE', 'Personal Loans 18-24mo', 'AgriCredit South', 'NRI Housing', 'Corporate Term'];

function synthesiseEntityName(kind: ExposureKind, rng: () => number): string {
  if (kind === 'borrowers' || kind === 'fraud_cases') {
    return FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)] + ' ' + LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)];
  }
  if (kind === 'portfolios') {
    return PORTFOLIO_NAMES[Math.floor(rng() * PORTFOLIO_NAMES.length)]!;
  }
  // policies
  const types = ['Term Life Plus', 'Health Shield', 'Auto Comprehensive', 'ULIP Growth', 'Retirement Plan'];
  return types[Math.floor(rng() * types.length)] + ' #' + Math.round(10000 + rng() * 90000);
}

// ───────────────────────────────────────────────────────────────────────
// Section 4 — Predictive Intelligence (5 forecasts)
// ───────────────────────────────────────────────────────────────────────

export type ForecastKind = 'npa_growth' | 'policy_lapse_growth' | 'fraud_trend' | 'compliance_risk' | 'recovery';

export interface ForecastSeries {
  kind: ForecastKind;
  label: string;
  /** Trailing-N months actual + 3-month forecast appended. */
  series: Array<{ period: string; value: number; is_forecast: boolean }>;
  /** Forecast delta vs trailing-3 mean — % change. */
  forecast_delta_pct: number;
  /** Direction interpretation: rising / falling / flat. */
  trend: 'rising' | 'falling' | 'flat';
  /** Severity of the trend (info / warning / critical). */
  severity: 'info' | 'warning' | 'critical';
  /** Model confidence band 0..1. */
  confidence: number;
}

const FORECAST_LABELS: Record<ForecastKind, string> = {
  npa_growth: 'Expected NPA Growth',
  policy_lapse_growth: 'Expected Policy Lapse Growth',
  fraud_trend: 'Fraud Trend Forecast',
  compliance_risk: 'Compliance Risk Forecast',
  recovery: 'Recovery Rate Forecast',
};

export function getPredictiveForecasts(tenant_id: string, asOf: Date = new Date()): ForecastSeries[] {
  const day = asOf.toISOString().slice(0, 10);
  return (Object.keys(FORECAST_LABELS) as ForecastKind[]).map((kind) => {
    const rng = rngFor('exec:forecast:' + kind + ':' + tenant_id + ':' + day);
    // Build trailing 6 months + 3 forecast months
    const series: ForecastSeries['series'] = [];
    let v = 30 + rng() * 30;
    const baseDate = new Date(asOf);
    for (let m = -5; m <= 3; m++) {
      const d = new Date(baseDate);
      d.setUTCMonth(d.getUTCMonth() + m);
      // smooth random walk
      v += (rng() - 0.5) * 8;
      if (kind === 'npa_growth' || kind === 'fraud_trend') v = Math.max(0, v);
      if (kind === 'recovery' || kind === 'compliance_risk') v = Math.max(40, Math.min(100, v));
      series.push({
        period: d.toISOString().slice(0, 7),
        value: Math.round(v * 10) / 10,
        is_forecast: m > 0,
      });
    }
    const actual = series.filter((s) => !s.is_forecast).slice(-3);
    const forecast = series.filter((s) => s.is_forecast);
    const actualMean = actual.reduce((a, b) => a + b.value, 0) / Math.max(1, actual.length);
    const forecastMean = forecast.reduce((a, b) => a + b.value, 0) / Math.max(1, forecast.length);
    const deltaPct = actualMean === 0 ? 0 : ((forecastMean - actualMean) / actualMean) * 100;
    const trend: 'rising' | 'falling' | 'flat' = Math.abs(deltaPct) < 2 ? 'flat' : (deltaPct > 0 ? 'rising' : 'falling');

    // Severity rule: "rising NPA growth" or "rising fraud trend" or "rising compliance risk" = bad; rising recovery = good
    let severity: 'info' | 'warning' | 'critical' = 'info';
    const isBadDirection = (kind === 'npa_growth' || kind === 'fraud_trend' || kind === 'compliance_risk' || kind === 'policy_lapse_growth')
      ? trend === 'rising'
      : trend === 'falling';
    if (isBadDirection && Math.abs(deltaPct) >= 10) severity = 'critical';
    else if (isBadDirection && Math.abs(deltaPct) >= 4) severity = 'warning';

    return {
      kind,
      label: FORECAST_LABELS[kind],
      series,
      forecast_delta_pct: Math.round(deltaPct * 10) / 10,
      trend,
      severity,
      confidence: Math.round((0.72 + rng() * 0.23) * 100) / 100,
    };
  });
}

// ───────────────────────────────────────────────────────────────────────
// Section 7 — Strategic KPI Center (6 strategic KPIs)
// ───────────────────────────────────────────────────────────────────────

export type StrategicKpiId =
  | 'risk_adjusted_return'
  | 'capital_at_risk'
  | 'portfolio_stability_index'
  | 'recovery_efficiency'
  | 'compliance_health'
  | 'fraud_loss_avoidance';

export interface StrategicKpi {
  id: StrategicKpiId;
  label: string;
  value: string;
  delta_pct: number;
  trend: 'rising' | 'falling' | 'flat';
  /** Interpretation: green = healthy, amber = watch, red = critical. */
  band: 'green' | 'amber' | 'red';
  /** Brief operator-facing context line. */
  context: string;
}

export function getStrategicKpis(tenant_id: string, asOf: Date = new Date()): StrategicKpi[] {
  const day = asOf.toISOString().slice(0, 10);
  const rng = rngFor('exec:strategic:' + tenant_id + ':' + day);

  const make = (
    id: StrategicKpiId,
    label: string,
    rawValue: number,
    suffix: string,
    healthyHigh: boolean,
    context: string,
  ): StrategicKpi => {
    const delta = (rng() * 14 - 7);
    const trend: 'rising' | 'falling' | 'flat' = Math.abs(delta) < 1.5 ? 'flat' : (delta > 0 ? 'rising' : 'falling');
    let band: 'green' | 'amber' | 'red' = 'green';
    // "healthy high" KPIs (recovery, compliance, RaR) → falling = bad
    if (healthyHigh) {
      band = trend === 'falling' && Math.abs(delta) >= 4 ? 'red'
            : trend === 'falling' && Math.abs(delta) >= 2 ? 'amber'
            : 'green';
    } else {
      // "healthy low" KPIs (CaR, etc.) → rising = bad
      band = trend === 'rising' && Math.abs(delta) >= 4 ? 'red'
            : trend === 'rising' && Math.abs(delta) >= 2 ? 'amber'
            : 'green';
    }
    return {
      id,
      label,
      value: rawValue.toFixed(suffix === '%' ? 1 : 0) + suffix,
      delta_pct: Math.round(delta * 10) / 10,
      trend,
      band,
      context,
    };
  };

  return [
    make('risk_adjusted_return', 'Risk Adjusted Return (RaR)', 14 + rng() * 6, '%', true, 'Target ≥ 15% for tier-1 banking ops'),
    make('capital_at_risk', 'Capital At Risk (CaR)', 8 + rng() * 6, '%', false, 'RBI internal cap 15%'),
    make('portfolio_stability_index', 'Portfolio Stability Index', 72 + rng() * 18, '/100', true, 'Internal composite stability score'),
    make('recovery_efficiency', 'Recovery Efficiency', 82 + rng() * 14, '%', true, 'Target ≥ 85% across last 30 days'),
    make('compliance_health', 'Compliance Health', 88 + rng() * 11, '/100', true, 'Audit chain + access reviews + maker-checker SLA'),
    make('fraud_loss_avoidance', 'Fraud Loss Avoidance', 14 + rng() * 8, ' Cr', true, '₹ value of attempted fraud blocked'),
  ];
}

// ───────────────────────────────────────────────────────────────────────
// Section 8 — Executive Actions (closed enum)
// ───────────────────────────────────────────────────────────────────────

export type ExecutiveAction =
  | 'escalate_risk'
  | 'launch_investigation'
  | 'trigger_review'
  | 'export_report'
  | 'notify_leadership';

export const ALL_EXECUTIVE_ACTIONS: readonly ExecutiveAction[] = [
  'escalate_risk', 'launch_investigation', 'trigger_review', 'export_report', 'notify_leadership',
] as const;

export interface ExecutiveActionDef {
  id: ExecutiveAction;
  label: string;
  description: string;
  /** Roles that can fire this action — restrictive subset of EXECUTIVE_ROLES. */
  allowed_roles: readonly ExecutiveRole[];
  /** Severity classification for the audit trail event. */
  severity: 'warning' | 'critical' | 'info';
}

export const EXECUTIVE_ACTIONS: readonly ExecutiveActionDef[] = [
  { id: 'escalate_risk', label: 'Escalate Risk', description: 'Raise a top-priority alert to the entire executive group and the CRO.', allowed_roles: ['super_admin', 'cro', 'ceo', 'coo'], severity: 'critical' },
  { id: 'launch_investigation', label: 'Launch Investigation', description: 'Trigger M9.1 investigation tracker for a customer or case.', allowed_roles: ['super_admin', 'cro', 'ceo'], severity: 'warning' },
  { id: 'trigger_review', label: 'Trigger Review', description: 'Mandate a maker-checker review cycle on a high-impact rule or model.', allowed_roles: ['super_admin', 'cro', 'cfo'], severity: 'warning' },
  { id: 'export_report', label: 'Export Report', description: 'Generate quarterly board pack PDF / Excel from the current cockpit state.', allowed_roles: ['super_admin', 'cro', 'ceo', 'cfo', 'coo', 'board_member', 'country_head'], severity: 'info' },
  { id: 'notify_leadership', label: 'Notify Leadership', description: 'Send a leadership notification via email + push with a key insight.', allowed_roles: ['super_admin', 'cro', 'ceo', 'cfo', 'coo'], severity: 'info' },
] as const;

export function actionsForRole(role: ExecutiveRole): readonly ExecutiveActionDef[] {
  return EXECUTIVE_ACTIONS.filter((a) => a.allowed_roles.includes(role));
}
