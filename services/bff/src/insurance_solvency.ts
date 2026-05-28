// services/bff/src/insurance_solvency.ts
//
// Insurance EWS — Module 4: Solvency Watch (IRDAI).
//
// Monitors the insurer-level solvency position against the IRDAI control
// level (ASM / RSM ≥ 1.50), forecasts the ratio 30/60/90 days out under
// claims-growth stress, and surfaces compliance alerts. Pure-function
// builders over deterministic synthesis (FNV-1a seed + Mulberry32), same
// template as Modules 1–3. Unlike the per-customer modules this is a
// single-entity (whole-book) metric, so the "book" is one current snapshot
// + a trailing/forward ratio series. Swap builder bodies to
// app_insurance.{solvency_metrics,solvency_forecasts,compliance_alerts}
// when the insurer's finance feed lands. Shapes stay frozen.
//
// Surfaces:
//   buildSolvencyDashboard(tenant, now)       → SolvencyDashboard (4 widgets)
//   forecastSolvency(input, now)              → SolvencyForecast (ad-hoc)
//   listComplianceAlerts(tenant, now, opts)   → ComplianceAlertList

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
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ─── domain constants + enums ───────────────────────────────────────────

/** IRDAI control level — ASM/RSM must stay at or above this. */
export const CONTROL_LEVEL = 1.5;
/** Watch band upper bound — a thin buffer above the floor. */
export const WATCH_CEILING = 1.6;

export const SOLVENCY_STATUSES = ['compliant', 'watch', 'breach'] as const;
export type SolvencyStatus = (typeof SOLVENCY_STATUSES)[number];

export const SOLVENCY_HORIZONS = [30, 60, 90] as const;
export type SolvencyHorizon = (typeof SOLVENCY_HORIZONS)[number];

export const STRESS_SCENARIOS = ['baseline', 'adverse', 'severe'] as const;
export type StressScenario = (typeof STRESS_SCENARIOS)[number];

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** Map a solvency ratio to its compliance status. */
export function statusFor(ratio: number): SolvencyStatus {
  if (ratio < CONTROL_LEVEL) return 'breach';
  if (ratio < WATCH_CEILING) return 'watch';
  return 'compliant';
}

export class SolvencyError extends Error {
  constructor(
    public code: 'invalid_input' | 'invalid_horizon' | 'invalid_scenario' | 'invalid_growth',
    message: string,
  ) {
    super(message);
    this.name = 'SolvencyError';
  }
}

// ─── shapes ─────────────────────────────────────────────────────────────

export interface SolvencySnapshot {
  as_of: string; // YYYY-MM-DD
  available_solvency_margin_kes: number; // ASM
  required_solvency_margin_kes: number; // RSM
  solvency_ratio: number; // ASM / RSM
  control_level: number; // 1.50
  capital_adequacy_pct: number; // 0..1
  status: SolvencyStatus;
}

export interface SolvencyTrendPoint {
  date: string; // YYYY-MM (monthly)
  solvency_ratio: number;
  status: SolvencyStatus;
  is_forecast: boolean;
}

export interface StressSimulation {
  scenario: StressScenario;
  claims_growth_pct: number; // assumption
  projected_ratio: number;
  status: SolvencyStatus;
  breach_probability: number; // 0..1
  capital_shortfall_kes: number; // >0 when projected RSM unmet; 0 otherwise
}

export interface ComplianceAlert {
  alert_id: string;
  regulator: string; // IRDAI
  rule_code: string;
  severity: AlertSeverity;
  message: string;
  metric_value: number;
  threshold_value: number;
  status: 'open' | 'acknowledged' | 'resolved';
  raised_at: string;
}

export interface SolvencyDashboard {
  tenant_id: string;
  generated_at: string;
  current: SolvencySnapshot;
  forecast_trend: SolvencyTrendPoint[]; // 12 trailing months + 3 forward
  capital_stress_simulation: StressSimulation[]; // baseline / adverse / severe
  compliance_alerts: ComplianceAlert[]; // open, worst-first
  totals: {
    open_alerts: number;
    critical_alerts: number;
    min_forecast_ratio: number;
    breach_horizon_days: number | null; // first forward horizon projected to breach; null if none
  };
  model_version: string;
}

export interface ForecastSolvencyInput {
  available_solvency_margin_kes?: number;
  required_solvency_margin_kes?: number;
  current_ratio?: number; // alternative to ASM/RSM
  claims_growth_pct?: number; // e.g. 0.10 = +10%
  premium_growth_pct?: number;
  horizon_days?: number;
  scenario?: string;
}

export interface SolvencyForecast {
  horizon_days: SolvencyHorizon;
  scenario: StressScenario;
  baseline_ratio: number;
  projected_ratio: number;
  claims_growth_pct: number;
  premium_growth_pct: number;
  breach_probability: number;
  status: SolvencyStatus;
  capital_shortfall_kes: number | null; // null when ASM/RSM not supplied
  drivers: { signal: string; contribution: number }[];
  model_version: string;
  scored_at: string;
}

export interface ComplianceAlertList {
  tenant_id: string;
  generated_at: string;
  severity_filter: AlertSeverity | 'all';
  status_filter: ComplianceAlert['status'] | 'all';
  total: number;
  alerts: ComplianceAlert[];
}

const MODEL_VERSION = 'solvency-stub-v1';

function tenantScale(tenant_id: string): number {
  return tenant_id === 'BANK_DEMO' ? 1.0 : 0.6;
}

/** Synthesise the current solvency snapshot for a tenant on a given day. */
function synthSnapshot(tenant_id: string, now: Date): SolvencySnapshot {
  const r = rng(seedFrom(tenant_id, now.toISOString().slice(0, 10), 'solvency'));
  // Ratio centred a touch above the control level — most tenants compliant,
  // some on watch, occasionally a breach.
  const ratio = round4(1.35 + r() * 0.75); // 1.35 .. 2.10
  const scale = tenantScale(tenant_id);
  const rsm = round2((4_000_000_000 + r() * 6_000_000_000) * scale); // required margin
  const asm = round2(rsm * ratio);
  return {
    as_of: now.toISOString().slice(0, 10),
    available_solvency_margin_kes: asm,
    required_solvency_margin_kes: rsm,
    solvency_ratio: ratio,
    control_level: CONTROL_LEVEL,
    capital_adequacy_pct: round4(Math.min(1, ratio / 2.5)),
    status: statusFor(ratio),
  };
}

function monthLabel(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ─── builders ─────────────────────────────────────────────────────────────

export function buildSolvencyDashboard(tenant_id: string, now: Date): SolvencyDashboard {
  if (!tenant_id) throw new SolvencyError('invalid_input', 'tenant_id required');
  const current = synthSnapshot(tenant_id, now);

  // Forecast trend — 12 trailing months (actual) + 3 forward (projected),
  // a gentle random walk around the current ratio with slight forward drift.
  const forecast_trend: SolvencyTrendPoint[] = [];
  for (let m = 12; m >= 1; m--) {
    const r = rng(seedFrom(tenant_id, 'trend-actual', String(m)));
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
    const ratio = round4(Math.max(1.2, current.solvency_ratio + (r() - 0.5) * 0.3));
    forecast_trend.push({ date: monthLabel(d), solvency_ratio: ratio, status: statusFor(ratio), is_forecast: false });
  }
  // current month
  forecast_trend.push({
    date: monthLabel(now),
    solvency_ratio: current.solvency_ratio,
    status: current.status,
    is_forecast: false,
  });
  // 3 forward months — slight downward drift to model claims growth.
  for (let m = 1; m <= 3; m++) {
    const r = rng(seedFrom(tenant_id, 'trend-fc', String(m)));
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, 1));
    const ratio = round4(Math.max(1.0, current.solvency_ratio - m * 0.04 - r() * 0.05));
    forecast_trend.push({ date: monthLabel(d), solvency_ratio: ratio, status: statusFor(ratio), is_forecast: true });
  }

  // Capital stress simulation — 3 scenarios with rising claims-growth shock.
  const stressDefs: { scenario: StressScenario; growth: number }[] = [
    { scenario: 'baseline', growth: 0.05 },
    { scenario: 'adverse', growth: 0.2 },
    { scenario: 'severe', growth: 0.4 },
  ];
  const capital_stress_simulation: StressSimulation[] = stressDefs.map(({ scenario, growth }) => {
    // Claims growth erodes ASM → ratio falls roughly proportionally.
    const projected = round4(Math.max(0.5, current.solvency_ratio * (1 - growth * 0.6)));
    const status = statusFor(projected);
    const breach_probability = round4(Math.max(0, Math.min(1, (CONTROL_LEVEL - projected) / 0.5 + 0.1 * growth)));
    const projectedAsm = current.available_solvency_margin_kes * (1 - growth * 0.6);
    const shortfall = projectedAsm < current.required_solvency_margin_kes * CONTROL_LEVEL
      ? round2(current.required_solvency_margin_kes * CONTROL_LEVEL - projectedAsm)
      : 0;
    return {
      scenario,
      claims_growth_pct: growth,
      projected_ratio: projected,
      status,
      breach_probability,
      capital_shortfall_kes: Math.max(0, shortfall),
    };
  });

  // Compliance alerts — derived from current status + forward breaches.
  const compliance_alerts = synthComplianceAlerts(tenant_id, now, current, forecast_trend);

  const forwardPoints = forecast_trend.filter((p) => p.is_forecast);
  const minForecast = forwardPoints.length
    ? round4(Math.min(...forwardPoints.map((p) => p.solvency_ratio)))
    : current.solvency_ratio;
  const firstBreach = forwardPoints.find((p) => p.status === 'breach');
  const breach_horizon_days = firstBreach
    ? (forwardPoints.indexOf(firstBreach) + 1) * 30
    : null;

  const openAlerts = compliance_alerts.filter((a) => a.status === 'open');

  return {
    tenant_id,
    generated_at: now.toISOString(),
    current,
    forecast_trend,
    capital_stress_simulation,
    compliance_alerts: openAlerts.sort(severitySort),
    totals: {
      open_alerts: openAlerts.length,
      critical_alerts: openAlerts.filter((a) => a.severity === 'critical').length,
      min_forecast_ratio: minForecast,
      breach_horizon_days,
    },
    model_version: MODEL_VERSION,
  };
}

function severitySort(a: ComplianceAlert, b: ComplianceAlert): number {
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return rank[a.severity] - rank[b.severity] || a.alert_id.localeCompare(b.alert_id);
}

function synthComplianceAlerts(
  tenant_id: string,
  now: Date,
  current: SolvencySnapshot,
  trend: SolvencyTrendPoint[],
): ComplianceAlert[] {
  const alerts: ComplianceAlert[] = [];
  let seq = 0;
  const push = (
    severity: AlertSeverity,
    rule_code: string,
    message: string,
    metric_value: number,
    threshold_value: number,
    status: ComplianceAlert['status'] = 'open',
  ) => {
    alerts.push({
      alert_id: `CMP-${tenant_id}-${String(700000 + seq++)}`,
      regulator: 'IRDAI',
      rule_code,
      severity,
      message,
      metric_value: round4(metric_value),
      threshold_value,
      status,
      raised_at: now.toISOString(),
    });
  };

  if (current.status === 'breach') {
    push('critical', 'SOLVENCY_RATIO_FLOOR', `Solvency ratio ${current.solvency_ratio} below IRDAI control level ${CONTROL_LEVEL}`, current.solvency_ratio, CONTROL_LEVEL);
  } else if (current.status === 'watch') {
    push('warning', 'SOLVENCY_RATIO_BUFFER', `Solvency ratio ${current.solvency_ratio} within thin buffer of control level`, current.solvency_ratio, WATCH_CEILING);
  }
  const fwdBreach = trend.find((p) => p.is_forecast && p.status === 'breach');
  if (fwdBreach) {
    push('critical', 'FORECAST_BREACH', `Forecast solvency ${fwdBreach.solvency_ratio} projected to breach by ${fwdBreach.date}`, fwdBreach.solvency_ratio, CONTROL_LEVEL);
  }
  const fwdWatch = trend.find((p) => p.is_forecast && p.status === 'watch');
  if (fwdWatch && !fwdBreach) {
    push('warning', 'FORECAST_BUFFER', `Forecast solvency ${fwdWatch.solvency_ratio} entering watch band by ${fwdWatch.date}`, fwdWatch.solvency_ratio, WATCH_CEILING);
  }
  // Always include a low-severity capital-adequacy info alert for context.
  push('info', 'CAPITAL_ADEQUACY', `Capital adequacy at ${round4(current.capital_adequacy_pct * 100)}%`, current.capital_adequacy_pct, 0.6,
    current.capital_adequacy_pct >= 0.6 ? 'resolved' : 'open');

  return alerts;
}

/**
 * Ad-hoc solvency forecast from current position + claims/premium growth.
 * Deterministic — same inputs → same projection. Accepts either ASM+RSM
 * (capital_shortfall computed) or a current_ratio (shortfall null).
 */
export function forecastSolvency(input: ForecastSolvencyInput, now: Date): SolvencyForecast {
  if (!input || typeof input !== 'object') throw new SolvencyError('invalid_input', 'request body required');

  let horizon: SolvencyHorizon = 30;
  if (input.horizon_days !== undefined) {
    if (!SOLVENCY_HORIZONS.includes(input.horizon_days as SolvencyHorizon)) {
      throw new SolvencyError('invalid_horizon', 'horizon_days must be 30, 60, or 90');
    }
    horizon = input.horizon_days as SolvencyHorizon;
  }

  let scenario: StressScenario = 'baseline';
  if (input.scenario !== undefined) {
    if (!STRESS_SCENARIOS.includes(input.scenario as StressScenario)) {
      throw new SolvencyError('invalid_scenario', `scenario must be one of ${STRESS_SCENARIOS.join(', ')}`);
    }
    scenario = input.scenario as StressScenario;
  }

  // Resolve the baseline ratio from ASM/RSM or current_ratio.
  let baseline: number;
  let asm: number | null = null;
  let rsm: number | null = null;
  if (input.available_solvency_margin_kes !== undefined && input.required_solvency_margin_kes !== undefined) {
    asm = numOr(input.available_solvency_margin_kes, 0);
    rsm = numOr(input.required_solvency_margin_kes, 0);
    if (asm < 0 || rsm <= 0) throw new SolvencyError('invalid_input', 'ASM must be ≥ 0 and RSM > 0');
    baseline = round4(asm / rsm);
  } else if (input.current_ratio !== undefined) {
    baseline = numOr(input.current_ratio, 0);
    if (baseline <= 0) throw new SolvencyError('invalid_input', 'current_ratio must be > 0');
  } else {
    throw new SolvencyError('invalid_input', 'supply ASM+RSM or current_ratio');
  }

  const claimsGrowth = numOr(input.claims_growth_pct, 0);
  const premiumGrowth = numOr(input.premium_growth_pct, 0);
  if (claimsGrowth < 0 || premiumGrowth < 0) throw new SolvencyError('invalid_growth', 'growth rates must be non-negative');

  // Scenario shock multiplier amplifies claims growth's drag.
  const scenarioMult = scenario === 'severe' ? 1.5 : scenario === 'adverse' ? 1.2 : 1.0;
  // Longer horizons compound the effect.
  const horizonMult = horizon === 90 ? 1.0 : horizon === 60 ? 0.7 : 0.4;

  const claimsDrag = claimsGrowth * 0.6 * scenarioMult * horizonMult;
  const premiumLift = premiumGrowth * 0.3 * horizonMult;
  const projected = round4(Math.max(0.3, baseline * (1 - claimsDrag) + premiumLift * baseline));
  const status = statusFor(projected);
  const breach_probability = round4(Math.max(0, Math.min(1, (CONTROL_LEVEL - projected) / 0.5 + 0.05)));

  let capital_shortfall_kes: number | null = null;
  if (asm !== null && rsm !== null) {
    const projectedAsm = asm * (1 - claimsDrag) + premiumLift * asm;
    const needed = rsm * CONTROL_LEVEL;
    capital_shortfall_kes = projectedAsm < needed ? round2(needed - projectedAsm) : 0;
  }

  const drivers = [
    { signal: 'claims_growth', contribution: round4(-claimsDrag) },
    { signal: 'premium_growth', contribution: round4(premiumLift) },
    { signal: 'scenario_shock', contribution: round4(scenarioMult - 1) },
  ].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  return {
    horizon_days: horizon,
    scenario,
    baseline_ratio: round4(baseline),
    projected_ratio: projected,
    claims_growth_pct: claimsGrowth,
    premium_growth_pct: premiumGrowth,
    breach_probability,
    status,
    capital_shortfall_kes,
    drivers,
    model_version: MODEL_VERSION,
    scored_at: now.toISOString(),
  };
}

export interface ComplianceOpts {
  severity?: string;
  status?: string;
  limit?: number;
}

export function listComplianceAlerts(
  tenant_id: string,
  now: Date,
  opts: ComplianceOpts = {},
): ComplianceAlertList {
  if (!tenant_id) throw new SolvencyError('invalid_input', 'tenant_id required');

  let severity: AlertSeverity | 'all' = 'all';
  if (opts.severity !== undefined && opts.severity !== 'all') {
    if (!ALERT_SEVERITIES.includes(opts.severity as AlertSeverity)) {
      throw new SolvencyError('invalid_input', `severity must be one of ${ALERT_SEVERITIES.join(', ')} or 'all'`);
    }
    severity = opts.severity as AlertSeverity;
  }
  let status: ComplianceAlert['status'] | 'all' = 'all';
  if (opts.status !== undefined && opts.status !== 'all') {
    if (!['open', 'acknowledged', 'resolved'].includes(opts.status)) {
      throw new SolvencyError('invalid_input', "status must be open | acknowledged | resolved | all");
    }
    status = opts.status as ComplianceAlert['status'];
  }
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));

  const current = synthSnapshot(tenant_id, now);
  // Rebuild the trend just for alert derivation (cheap, deterministic).
  const dash = buildSolvencyDashboard(tenant_id, now);
  let alerts = synthComplianceAlerts(tenant_id, now, current, dash.forecast_trend);
  if (severity !== 'all') alerts = alerts.filter((a) => a.severity === severity);
  if (status !== 'all') alerts = alerts.filter((a) => a.status === status);
  alerts.sort(severitySort);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    severity_filter: severity,
    status_filter: status,
    total: alerts.length,
    alerts: alerts.slice(0, limit),
  };
}

function numOr(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new SolvencyError('invalid_input', 'numeric input must be finite');
  return n;
}
