// Enterprise Demo Foundation — Analytics Engine (KPIs + forecasts + compliance).
// Pure, deterministic synthesis. No I/O, no external deps.

/** Local time helper to keep all no-arg Date construction in one place. */
function currentTime(): Date {
  return new Date();
}

// ---------------------------------------------------------------------------
// Closed enums
// ---------------------------------------------------------------------------

export const FORECAST_HORIZONS = ['30d', '60d', '90d', '180d'] as const;
export type ForecastHorizon = (typeof FORECAST_HORIZONS)[number];

export const BANKING_FORECAST_KINDS = ['npa_growth', 'collections_risk', 'sector_stress'] as const;
export type BankingForecastKind = (typeof BANKING_FORECAST_KINDS)[number];

export const INSURANCE_FORECAST_KINDS = ['policy_lapse_growth', 'claim_fraud_growth', 'persistency_risk'] as const;
export type InsuranceForecastKind = (typeof INSURANCE_FORECAST_KINDS)[number];

export const BANKING_FRAMEWORKS = ['rbi', 'basel', 'aml', 'kyc'] as const;
export type BankingFramework = (typeof BANKING_FRAMEWORKS)[number];

export const INSURANCE_FRAMEWORKS = ['irdai', 'solvency', 'claims_compliance'] as const;
export type InsuranceFramework = (typeof INSURANCE_FRAMEWORKS)[number];

export const OBLIGATION_STATUSES = ['compliant', 'due_soon', 'overdue', 'breach', 'remediation'] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];

export const FINDING_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export type EnterpriseDomain = 'banking' | 'insurance';
export type EnterpriseFramework = BankingFramework | InsuranceFramework;
export type EnterpriseForecastKind = BankingForecastKind | InsuranceForecastKind;
export type FindingStatus = 'open' | 'in_remediation' | 'closed';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface BankingExecutiveKpi {
  generated_at: string;
  portfolio_exposure_inr: number;
  sma_accounts_count: number;
  npa_exposure_inr: number;
  npa_ratio_pct: number;
  fraud_alerts_30d: number;
  recovery_rate_pct: number;
  growth_trend_30d: { day_offset: number; portfolio_inr: number; npa_inr: number }[];
}

export interface InsuranceExecutiveKpi {
  generated_at: string;
  active_policies_count: number;
  claim_ratio_pct: number;
  fraud_claims_count: number;
  persistency_ratio_pct: number;
  solvency_ratio_pct: number;
  growth_trend_30d: { day_offset: number; active_policies: number; claim_ratio_pct: number }[];
}

export interface EnterpriseForecast {
  forecast_id: string;
  tenant_id: string;
  domain: EnterpriseDomain;
  kind: EnterpriseForecastKind;
  horizon: ForecastHorizon;
  generated_at: string;
  baseline_value: number;
  forecast_value: number;
  delta_pct: number;
  confidence_score: number;
  risk_drivers: { driver: string; contribution_pct: number }[];
  recommended_actions: string[];
}

export interface ComplianceObligation {
  obligation_id: string;
  tenant_id: string;
  framework: EnterpriseFramework;
  domain: EnterpriseDomain;
  title: string;
  description: string;
  due_date: string;
  owner_username: string;
  status: ObligationStatus;
  severity: FindingSeverity;
  days_to_due: number;
}

export interface ComplianceFinding {
  finding_id: string;
  tenant_id: string;
  obligation_id: string;
  severity: FindingSeverity;
  title: string;
  description: string;
  detected_at: string;
  status: FindingStatus;
}

export interface CompliancePosture {
  total_obligations: number;
  by_framework: Record<string, number>;
  by_status: Record<ObligationStatus, number>;
  by_severity: Record<FindingSeverity, number>;
  open_findings: number;
  critical_open_findings: number;
  compliance_health_score: number;
  domain_health_scores: Record<EnterpriseDomain, number>;
}

// ---------------------------------------------------------------------------
// Deterministic RNG (FNV-1a + Mulberry32)
// ---------------------------------------------------------------------------

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function rngFor(tenant_id: string, asOf: Date, ...axes: string[]): () => number {
  const seedKey = [tenant_id, isoDay(asOf), ...axes].join('|');
  return mulberry32(fnv1a(seedKey));
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function randRange(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

function randInt(rng: () => number, lo: number, hi: number): number {
  return Math.floor(randRange(rng, lo, hi + 1));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Indian-flavour helpers (currency + naming)
// ---------------------------------------------------------------------------

const LAKH = 100000;
const CRORE = 10000000;

function lakhs(n: number): number {
  return n * LAKH;
}

function crores(n: number): number {
  return n * CRORE;
}

const FIRST_NAMES = [
  'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Reyansh', 'Mohammed', 'Ayaan',
  'Krishna', 'Ishaan', 'Saanvi', 'Aanya', 'Aaradhya', 'Pari', 'Diya',
] as const;

const LAST_NAMES = [
  'Sharma', 'Patel', 'Kumar', 'Singh', 'Gupta', 'Mehta', 'Shah', 'Khan',
  'Reddy', 'Iyer', 'Verma', 'Rao', 'Joshi', 'Nair', 'Menon',
] as const;

function makeOwnerUsername(rng: () => number): string {
  const first = pick(rng, FIRST_NAMES).toLowerCase();
  const last = pick(rng, LAST_NAMES).toLowerCase();
  return `${first}.${last}`;
}

// ---------------------------------------------------------------------------
// Banking executive KPI
// ---------------------------------------------------------------------------

/** Build deterministic banking executive KPI dashboard for a tenant. */
export function buildBankingExecutiveKpi(tenant_id: string, asOf: Date = currentTime()): BankingExecutiveKpi {
  const rng = rngFor(tenant_id, asOf, 'banking_exec_kpi');
  // Portfolio base ~5000 Cr ± 15%.
  const portfolio_exposure_inr = Math.round(crores(randRange(rng, 4250, 5750)));
  const npa_ratio_pct = round2(randRange(rng, 3, 7));
  const npa_exposure_inr = Math.round(portfolio_exposure_inr * (npa_ratio_pct / 100));
  const sma_accounts_count = randInt(rng, 800, 2400);
  const fraud_alerts_30d = randInt(rng, 35, 180);
  const recovery_rate_pct = round2(randRange(rng, 55, 82));

  const growth_trend_30d: { day_offset: number; portfolio_inr: number; npa_inr: number }[] = [];
  for (let offset = -29; offset <= 0; offset++) {
    const drift = 1 + (offset / 29) * 0.04 + (rng() - 0.5) * 0.01;
    const npaDrift = 1 + (offset / 29) * 0.06 + (rng() - 0.5) * 0.015;
    growth_trend_30d.push({
      day_offset: offset,
      portfolio_inr: Math.round(portfolio_exposure_inr * drift),
      npa_inr: Math.round(npa_exposure_inr * npaDrift),
    });
  }

  return {
    generated_at: asOf.toISOString(),
    portfolio_exposure_inr,
    sma_accounts_count,
    npa_exposure_inr,
    npa_ratio_pct,
    fraud_alerts_30d,
    recovery_rate_pct,
    growth_trend_30d,
  };
}

// ---------------------------------------------------------------------------
// Insurance executive KPI
// ---------------------------------------------------------------------------

/** Build deterministic insurance executive KPI dashboard for a tenant. */
export function buildInsuranceExecutiveKpi(tenant_id: string, asOf: Date = currentTime()): InsuranceExecutiveKpi {
  const rng = rngFor(tenant_id, asOf, 'insurance_exec_kpi');
  const active_policies_count = randInt(rng, 320000, 540000);
  const claim_ratio_pct = round2(randRange(rng, 55, 75));
  const fraud_claims_count = randInt(rng, 40, 220);
  const persistency_ratio_pct = round2(randRange(rng, 70, 85));
  const solvency_ratio_pct = round2(randRange(rng, 150, 220));

  const growth_trend_30d: { day_offset: number; active_policies: number; claim_ratio_pct: number }[] = [];
  for (let offset = -29; offset <= 0; offset++) {
    const policiesDrift = 1 + (offset / 29) * 0.03 + (rng() - 0.5) * 0.008;
    const ratioJitter = (rng() - 0.5) * 1.5;
    growth_trend_30d.push({
      day_offset: offset,
      active_policies: Math.round(active_policies_count * policiesDrift),
      claim_ratio_pct: round2(claim_ratio_pct + ratioJitter),
    });
  }

  return {
    generated_at: asOf.toISOString(),
    active_policies_count,
    claim_ratio_pct,
    fraud_claims_count,
    persistency_ratio_pct,
    solvency_ratio_pct,
    growth_trend_30d,
  };
}

// ---------------------------------------------------------------------------
// Forecast catalog
// ---------------------------------------------------------------------------

const HORIZON_FACTOR: Record<ForecastHorizon, number> = {
  '30d': 0.05,
  '60d': 0.10,
  '90d': 0.15,
  '180d': 0.25,
};

const HORIZON_CONFIDENCE: Record<ForecastHorizon, number> = {
  '30d': 0.85,
  '60d': 0.75,
  '90d': 0.65,
  '180d': 0.55,
};

const BANKING_BASELINES: Record<BankingForecastKind, number> = {
  npa_growth: 4.2,
  collections_risk: 18.5,
  sector_stress: 32.0,
};

const INSURANCE_BASELINES: Record<InsuranceForecastKind, number> = {
  policy_lapse_growth: 12.0,
  claim_fraud_growth: 6.5,
  persistency_risk: 22.0,
};

const BANKING_DRIVERS: Record<BankingForecastKind, string[]> = {
  npa_growth: ['Retail unsecured stress', 'MSME slowdown', 'Sector concentration', 'Seasonal repayment dip'],
  collections_risk: ['Field officer attrition', 'Tier-2 city defaults', 'Promise-to-pay slippage', 'Channel mix shift'],
  sector_stress: ['Real estate exposure', 'Auto OEM slowdown', 'Power discom dues', 'Agri monsoon variance'],
};

const INSURANCE_DRIVERS: Record<InsuranceForecastKind, string[]> = {
  policy_lapse_growth: ['Renewal channel mix', 'Premium hike pass-through', 'Agent persistency drop', 'Digital nudge gap'],
  claim_fraud_growth: ['Provider network anomalies', 'Repeat-claim hotspots', 'Document tampering rise', 'Geo-clustered claims'],
  persistency_risk: ['ULIP market sentiment', '13M cohort attrition', 'Bancassurance channel dip', 'Renewal CX score drop'],
};

const BANKING_ACTIONS: Record<BankingForecastKind, string[]> = {
  npa_growth: [
    'Tighten SMA-1 tagging rules in retail unsecured',
    'Reallocate field collection capacity to top-5 stressed pin codes',
    'Escalate sector-cap review to ALCO',
  ],
  collections_risk: [
    'Launch promise-to-pay tele-calling sprint in Tier-2 cities',
    'Activate dunning channel A/B test for 30-60 DPD bucket',
    'Add field-visit verification for high-ticket exposures',
  ],
  sector_stress: [
    'Convene sector risk committee for top-2 exposures',
    'Freeze fresh sanctions in stressed sub-sector',
    'Run scenario-based provisioning preview',
  ],
};

const INSURANCE_ACTIONS: Record<InsuranceForecastKind, string[]> = {
  policy_lapse_growth: [
    'Trigger 30-day pre-lapse retention nudges via SMS + IVR',
    'Offer EMI conversion on premium for tier-2 cohort',
    'Run agent-led save-call campaign on high-AUM lapses',
  ],
  claim_fraud_growth: [
    'Add 4-eyes review on flagged-provider claims > 2 lakh',
    'Geo-cluster anomaly scan refresh weekly',
    'Tighten document-OCR validation in claim intake',
  ],
  persistency_risk: [
    'Bancassurance partner SLA review',
    'Activate 13M cohort retention bonus to top-quartile agents',
    'Increase renewal CX outreach frequency',
  ],
};

function makeForecastId(domain: EnterpriseDomain, kind: EnterpriseForecastKind, horizon: ForecastHorizon): string {
  const prefix = domain === 'banking' ? 'FCB' : 'FCI';
  return `${prefix}-${kind.toUpperCase()}-${horizon.toUpperCase()}`;
}

function buildForecastEntry(
  tenant_id: string,
  asOf: Date,
  domain: EnterpriseDomain,
  kind: EnterpriseForecastKind,
  horizon: ForecastHorizon,
): EnterpriseForecast {
  const rng = rngFor(tenant_id, asOf, 'forecast', domain, kind, horizon);
  const baseline =
    domain === 'banking'
      ? BANKING_BASELINES[kind as BankingForecastKind]
      : INSURANCE_BASELINES[kind as InsuranceForecastKind];
  const horizonFactor = HORIZON_FACTOR[horizon];
  const direction = rng() < 0.78 ? 1 : -1; // stress forecasts skew upward
  const delta_pct = round2(direction * horizonFactor * 100 * randRange(rng, 0.6, 1.4));
  const forecast_value = round2(baseline * (1 + delta_pct / 100));
  const confidence_score = round2(HORIZON_CONFIDENCE[horizon] * randRange(rng, 0.92, 1.04));

  const driverPool =
    domain === 'banking'
      ? BANKING_DRIVERS[kind as BankingForecastKind]
      : INSURANCE_DRIVERS[kind as InsuranceForecastKind];
  const actionPool =
    domain === 'banking'
      ? BANKING_ACTIONS[kind as BankingForecastKind]
      : INSURANCE_ACTIONS[kind as InsuranceForecastKind];

  const drivers = driverPool.slice(0, 4).map((driver) => ({
    driver,
    contribution_pct: round2(randRange(rng, 8, 38)),
  }));
  // Normalize contributions to sum to ~100.
  const total = drivers.reduce((s, d) => s + d.contribution_pct, 0);
  for (const d of drivers) {
    d.contribution_pct = round2((d.contribution_pct / total) * 100);
  }

  return {
    forecast_id: makeForecastId(domain, kind, horizon),
    tenant_id,
    domain,
    kind,
    horizon,
    generated_at: asOf.toISOString(),
    baseline_value: round2(baseline),
    forecast_value: Math.max(0, forecast_value),
    delta_pct,
    confidence_score: Math.min(1, Math.max(0, confidence_score)),
    risk_drivers: drivers,
    recommended_actions: actionPool.slice(0, 3),
  };
}

/** List all enterprise forecasts (24 = (3 banking + 3 insurance) x 4 horizons), optionally filtered. */
export function listEnterpriseForecasts(
  tenant_id: string,
  asOf: Date = currentTime(),
  filter?: { domain?: EnterpriseDomain; kind?: EnterpriseForecastKind; horizon?: ForecastHorizon },
): EnterpriseForecast[] {
  const out: EnterpriseForecast[] = [];
  for (const kind of BANKING_FORECAST_KINDS) {
    for (const horizon of FORECAST_HORIZONS) {
      out.push(buildForecastEntry(tenant_id, asOf, 'banking', kind, horizon));
    }
  }
  for (const kind of INSURANCE_FORECAST_KINDS) {
    for (const horizon of FORECAST_HORIZONS) {
      out.push(buildForecastEntry(tenant_id, asOf, 'insurance', kind, horizon));
    }
  }
  if (!filter) return out;
  return out.filter((f) => {
    if (filter.domain && f.domain !== filter.domain) return false;
    if (filter.kind && f.kind !== filter.kind) return false;
    if (filter.horizon && f.horizon !== filter.horizon) return false;
    return true;
  });
}

/** Fetch a single forecast by id; returns null when not found for this tenant. */
export function getEnterpriseForecast(
  id: string,
  tenant_id: string,
  asOf: Date = currentTime(),
): EnterpriseForecast | null {
  const all = listEnterpriseForecasts(tenant_id, asOf);
  return all.find((f) => f.forecast_id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Compliance obligations + findings
// ---------------------------------------------------------------------------

interface ObligationSeed {
  framework: EnterpriseFramework;
  domain: EnterpriseDomain;
  title: string;
  description: string;
}

const OBLIGATION_SEEDS: ObligationSeed[] = [
  // RBI (banking)
  { framework: 'rbi', domain: 'banking', title: 'IRACP norms quarterly review', description: 'Verify income recognition and asset classification per RBI Master Direction.' },
  { framework: 'rbi', domain: 'banking', title: 'SMA-2 reporting to CRILC', description: 'Submit weekly SMA-2 disclosures to Central Repository of Information on Large Credits.' },
  { framework: 'rbi', domain: 'banking', title: 'NPA divergence assessment', description: 'Reconcile bank-reported NPAs against RBI inspection findings.' },
  { framework: 'rbi', domain: 'banking', title: 'Provisioning coverage ratio review', description: 'Maintain PCR per RBI guidance and document board review.' },
  { framework: 'rbi', domain: 'banking', title: 'Wilful defaulter list submission', description: 'File wilful defaulter list with credit information companies.' },
  // Basel
  { framework: 'basel', domain: 'banking', title: 'CET1 capital adequacy report', description: 'Confirm CET1 ratio above regulatory minimum + buffer.' },
  { framework: 'basel', domain: 'banking', title: 'Liquidity coverage ratio disclosure', description: 'Publish LCR disclosures per Basel III liquidity framework.' },
  { framework: 'basel', domain: 'banking', title: 'Leverage ratio attestation', description: 'Board attestation on leverage ratio computation.' },
  { framework: 'basel', domain: 'banking', title: 'ICAAP submission', description: 'Annual Internal Capital Adequacy Assessment Process filing.' },
  { framework: 'basel', domain: 'banking', title: 'Stress test scenario refresh', description: 'Refresh and run regulator-mandated stress scenarios.' },
  // AML
  { framework: 'aml', domain: 'banking', title: 'STR filing to FIU-IND', description: 'Submit Suspicious Transaction Reports within prescribed timeline.' },
  { framework: 'aml', domain: 'banking', title: 'CTR monthly upload', description: 'Cash Transaction Report monthly submission.' },
  { framework: 'aml', domain: 'banking', title: 'Sanctions list screening refresh', description: 'Refresh OFAC/UN/MEA sanctions lists in screening engine.' },
  { framework: 'aml', domain: 'banking', title: 'Customer risk re-categorization', description: 'Annual high-risk customer risk-rating review.' },
  { framework: 'aml', domain: 'banking', title: 'AML training attestation', description: 'Branch-level AML training completion attestation.' },
  // KYC
  { framework: 'kyc', domain: 'banking', title: 'High-risk KYC re-verification', description: 'Re-verify KYC for high-risk customers every 24 months.' },
  { framework: 'kyc', domain: 'banking', title: 'Aadhaar OVD validity check', description: 'Verify Aadhaar/OVD validity across active CIFs.' },
  { framework: 'kyc', domain: 'banking', title: 'CKYC upload reconciliation', description: 'Reconcile CKYC uploads against onboarded customers.' },
  { framework: 'kyc', domain: 'banking', title: 'Video-KYC audit trail', description: 'Retain V-CIP audit trail with timestamps for 10 years.' },
  { framework: 'kyc', domain: 'banking', title: 'PEP screening refresh', description: 'Refresh Politically Exposed Persons list and re-screen book.' },
  // IRDAI (insurance)
  { framework: 'irdai', domain: 'insurance', title: 'Public disclosure quarterly filing', description: 'File quarterly public disclosures with IRDAI.' },
  { framework: 'irdai', domain: 'insurance', title: 'Outsourcing policy review', description: 'Board review of outsourcing arrangements per IRDAI Regs.' },
  { framework: 'irdai', domain: 'insurance', title: 'Grievance redressal dashboard', description: 'Maintain Bima Bharosa-aligned grievance dashboard.' },
  { framework: 'irdai', domain: 'insurance', title: 'Mis-selling complaints review', description: 'Quarterly mis-selling complaints root-cause review.' },
  { framework: 'irdai', domain: 'insurance', title: 'Product re-filing on rider change', description: 'Re-file product on rider repricing per IRDAI norms.' },
  // Solvency
  { framework: 'solvency', domain: 'insurance', title: 'Solvency ratio monthly attestation', description: 'Solvency ratio computation + appointed actuary attestation.' },
  { framework: 'solvency', domain: 'insurance', title: 'ALM gap report', description: 'Asset-Liability Management gap quarterly report.' },
  { framework: 'solvency', domain: 'insurance', title: 'Required Solvency Margin filing', description: 'RSM filing with IRDAI as per Form-K.' },
  { framework: 'solvency', domain: 'insurance', title: 'Catastrophe reserve adequacy', description: 'Review catastrophe reserve adequacy against scenario losses.' },
  { framework: 'solvency', domain: 'insurance', title: 'Reinsurance treaty refresh', description: 'Annual reinsurance treaty renewal + IRDAI intimation.' },
  // Claims compliance
  { framework: 'claims_compliance', domain: 'insurance', title: 'Claim TAT regulatory threshold', description: 'Ensure claim turnaround within IRDAI-prescribed days.' },
  { framework: 'claims_compliance', domain: 'insurance', title: 'Repudiation rationale audit', description: 'Audit claim repudiation rationale documentation.' },
  { framework: 'claims_compliance', domain: 'insurance', title: 'Cashless network compliance', description: 'Network hospital compliance with cashless SLAs.' },
  { framework: 'claims_compliance', domain: 'insurance', title: 'Surveyor licence validity', description: 'Verify empanelled surveyors hold valid IRDAI licences.' },
  { framework: 'claims_compliance', domain: 'insurance', title: 'Death claim 30-day disposal', description: 'Disposal of death claims within 30 days of intimation.' },
  { framework: 'claims_compliance', domain: 'insurance', title: 'Ombudsman award compliance', description: 'Honour Ombudsman awards within prescribed timeline.' },
  { framework: 'claims_compliance', domain: 'insurance', title: 'Fraud claims escalation log', description: 'Maintain fraud-claim escalation register with monthly review.' },
  { framework: 'claims_compliance', domain: 'insurance', title: 'Customer satisfaction post-claim', description: 'Capture and review post-claim CX score monthly.' },
  { framework: 'claims_compliance', domain: 'insurance', title: 'Provider blacklist refresh', description: 'Refresh blacklisted hospital/provider list quarterly.' },
  { framework: 'claims_compliance', domain: 'insurance', title: 'Reopened claims root-cause review', description: 'Quarterly review of reopened claims and root causes.' },
];

function statusFromDaysToDue(days_to_due: number, rng: () => number): ObligationStatus {
  if (days_to_due < -7) {
    return rng() < 0.55 ? 'breach' : 'overdue';
  }
  if (days_to_due < 0) {
    return rng() < 0.4 ? 'remediation' : 'overdue';
  }
  if (days_to_due <= 14) {
    return 'due_soon';
  }
  return rng() < 0.85 ? 'compliant' : 'remediation';
}

function severityForObligation(status: ObligationStatus, rng: () => number): FindingSeverity {
  if (status === 'breach') return rng() < 0.65 ? 'critical' : 'high';
  if (status === 'overdue') return rng() < 0.5 ? 'high' : 'medium';
  if (status === 'remediation') return rng() < 0.4 ? 'high' : 'medium';
  if (status === 'due_soon') return rng() < 0.6 ? 'medium' : 'low';
  return rng() < 0.75 ? 'low' : 'medium';
}

function buildObligation(tenant_id: string, asOf: Date, seed: ObligationSeed, idx: number): ComplianceObligation {
  const rng = rngFor(tenant_id, asOf, 'obligation', seed.framework, seed.title, String(idx));
  const days_to_due = randInt(rng, -30, 180);
  const status = statusFromDaysToDue(days_to_due, rng);
  const severity = severityForObligation(status, rng);
  const dueDate = new Date(asOf.getTime() + days_to_due * 86400000);
  const obligation_id = `OBL-${String(idx + 1).padStart(4, '0')}`;
  return {
    obligation_id,
    tenant_id,
    framework: seed.framework,
    domain: seed.domain,
    title: seed.title,
    description: seed.description,
    due_date: isoDay(dueDate),
    owner_username: makeOwnerUsername(rng),
    status,
    severity,
    days_to_due,
  };
}

/** List the 40 compliance obligations for the tenant, optionally filtered. */
export function listComplianceObligations(
  tenant_id: string,
  asOf: Date = currentTime(),
  filter?: { framework?: EnterpriseFramework; domain?: EnterpriseDomain; status?: ObligationStatus; severity?: FindingSeverity },
): ComplianceObligation[] {
  const all = OBLIGATION_SEEDS.map((seed, idx) => buildObligation(tenant_id, asOf, seed, idx));
  if (!filter) return all;
  return all.filter((o) => {
    if (filter.framework && o.framework !== filter.framework) return false;
    if (filter.domain && o.domain !== filter.domain) return false;
    if (filter.status && o.status !== filter.status) return false;
    if (filter.severity && o.severity !== filter.severity) return false;
    return true;
  });
}

/** Fetch a single compliance obligation by id; returns null when not found. */
export function getComplianceObligation(
  id: string,
  tenant_id: string,
  asOf: Date = currentTime(),
): ComplianceObligation | null {
  const all = listComplianceObligations(tenant_id, asOf);
  return all.find((o) => o.obligation_id === id) ?? null;
}

const FINDING_TITLES = [
  'Documentation gap detected',
  'SLA breach on remediation task',
  'Sampling exception flagged in audit',
  'Late submission to regulator',
  'Control test failure',
  'Data quality discrepancy',
  'Manual override without 4-eyes',
  'Outdated reference data',
] as const;

const FINDING_DESCRIPTIONS = [
  'Sample-based review surfaced an exception requiring corrective action.',
  'Audit trail incomplete for the most recent reporting period.',
  'Process step executed outside policy threshold without escalation.',
  'Evidence repository missing supporting artefacts for the obligation.',
  'Manual journal posted without dual control sign-off.',
  'Reference data refresh delayed beyond agreed cadence.',
] as const;

function buildFindingsForObligation(
  tenant_id: string,
  asOf: Date,
  obligation: ComplianceObligation,
  idx: number,
): ComplianceFinding[] {
  const rng = rngFor(tenant_id, asOf, 'finding', obligation.obligation_id, String(idx));
  // Heavier-status obligations spawn more findings; total across 40 ≈ 80.
  let count: number;
  if (obligation.status === 'breach') count = 4;
  else if (obligation.status === 'overdue') count = 3;
  else if (obligation.status === 'remediation') count = 2;
  else if (obligation.status === 'due_soon') count = 2;
  else count = 1;

  const findings: ComplianceFinding[] = [];
  for (let i = 0; i < count; i++) {
    const detectedDayOffset = -randInt(rng, 1, 45);
    const detectedAt = new Date(asOf.getTime() + detectedDayOffset * 86400000).toISOString();
    const severityRoll = rng();
    let severity: FindingSeverity;
    if (obligation.severity === 'critical') {
      severity = severityRoll < 0.6 ? 'critical' : 'high';
    } else if (obligation.severity === 'high') {
      severity = severityRoll < 0.45 ? 'high' : 'medium';
    } else if (obligation.severity === 'medium') {
      severity = severityRoll < 0.55 ? 'medium' : 'low';
    } else {
      severity = severityRoll < 0.7 ? 'low' : 'medium';
    }
    const statusRoll = rng();
    let status: FindingStatus;
    if (obligation.status === 'breach' || obligation.status === 'overdue') {
      status = statusRoll < 0.7 ? 'open' : 'in_remediation';
    } else if (obligation.status === 'remediation') {
      status = statusRoll < 0.6 ? 'in_remediation' : 'open';
    } else if (obligation.status === 'compliant') {
      status = statusRoll < 0.75 ? 'closed' : 'in_remediation';
    } else {
      status = statusRoll < 0.45 ? 'open' : statusRoll < 0.8 ? 'in_remediation' : 'closed';
    }
    findings.push({
      finding_id: `FND-${obligation.obligation_id.slice(4)}-${String(i + 1).padStart(2, '0')}`,
      tenant_id,
      obligation_id: obligation.obligation_id,
      severity,
      title: pick(rng, FINDING_TITLES),
      description: pick(rng, FINDING_DESCRIPTIONS),
      detected_at: detectedAt,
      status,
    });
  }
  return findings;
}

/** List compliance findings (~80 total) across all obligations, optionally filtered. */
export function listComplianceFindings(
  tenant_id: string,
  asOf: Date = currentTime(),
  filter?: { framework?: EnterpriseFramework; severity?: FindingSeverity; status?: FindingStatus },
): ComplianceFinding[] {
  const obligations = listComplianceObligations(tenant_id, asOf);
  const obligationById = new Map(obligations.map((o) => [o.obligation_id, o] as const));
  const all: ComplianceFinding[] = [];
  obligations.forEach((obligation, idx) => {
    const findings = buildFindingsForObligation(tenant_id, asOf, obligation, idx);
    all.push(...findings);
  });
  if (!filter) return all;
  return all.filter((f) => {
    if (filter.severity && f.severity !== filter.severity) return false;
    if (filter.status && f.status !== filter.status) return false;
    if (filter.framework) {
      const ob = obligationById.get(f.obligation_id);
      if (!ob || ob.framework !== filter.framework) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Compliance posture rollup
// ---------------------------------------------------------------------------

function emptyStatusCounts(): Record<ObligationStatus, number> {
  return {
    compliant: 0,
    due_soon: 0,
    overdue: 0,
    breach: 0,
    remediation: 0,
  };
}

function emptySeverityCounts(): Record<FindingSeverity, number> {
  return { low: 0, medium: 0, high: 0, critical: 0 };
}

function healthScoreFromCounts(
  by_status: Record<ObligationStatus, number>,
  total_obligations: number,
  critical_open_findings: number,
): number {
  if (total_obligations === 0) return 100;
  const breachPenalty = (by_status.breach / total_obligations) * 45;
  const overduePenalty = (by_status.overdue / total_obligations) * 25;
  const remediationPenalty = (by_status.remediation / total_obligations) * 12;
  const dueSoonPenalty = (by_status.due_soon / total_obligations) * 6;
  const findingsPenalty = Math.min(15, critical_open_findings * 1.5);
  const raw = 100 - breachPenalty - overduePenalty - remediationPenalty - dueSoonPenalty - findingsPenalty;
  return Math.max(0, Math.min(100, round2(raw)));
}

/** Roll up posture across obligations + findings into a single dashboard payload. */
export function summarizeCompliancePosture(tenant_id: string, asOf: Date = currentTime()): CompliancePosture {
  const obligations = listComplianceObligations(tenant_id, asOf);
  const findings = listComplianceFindings(tenant_id, asOf);
  const obligationById = new Map(obligations.map((o) => [o.obligation_id, o] as const));

  const by_framework: Record<string, number> = {};
  for (const fw of BANKING_FRAMEWORKS) by_framework[fw] = 0;
  for (const fw of INSURANCE_FRAMEWORKS) by_framework[fw] = 0;

  const by_status = emptyStatusCounts();
  const by_severity = emptySeverityCounts();

  for (const o of obligations) {
    by_framework[o.framework] = (by_framework[o.framework] ?? 0) + 1;
    by_status[o.status] += 1;
    by_severity[o.severity] += 1;
  }

  const open_findings = findings.filter((f) => f.status !== 'closed').length;
  const critical_open_findings = findings.filter((f) => f.status !== 'closed' && f.severity === 'critical').length;

  const compliance_health_score = healthScoreFromCounts(by_status, obligations.length, critical_open_findings);

  const domain_health_scores: Record<EnterpriseDomain, number> = { banking: 100, insurance: 100 };
  for (const domain of ['banking', 'insurance'] as const) {
    const domainObligations = obligations.filter((o) => o.domain === domain);
    const domainStatusCounts = emptyStatusCounts();
    for (const o of domainObligations) domainStatusCounts[o.status] += 1;
    const domainCriticalOpen = findings.filter((f) => {
      const ob = obligationById.get(f.obligation_id);
      return ob?.domain === domain && f.status !== 'closed' && f.severity === 'critical';
    }).length;
    domain_health_scores[domain] = healthScoreFromCounts(
      domainStatusCounts,
      domainObligations.length,
      domainCriticalOpen,
    );
  }

  return {
    total_obligations: obligations.length,
    by_framework,
    by_status,
    by_severity,
    open_findings,
    critical_open_findings,
    compliance_health_score,
    domain_health_scores,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers retained for future composition (unused-export-safe).
// ---------------------------------------------------------------------------

export const __internal = {
  lakhs,
  crores,
  fnv1a,
  mulberry32,
  rngFor,
  HORIZON_FACTOR,
  HORIZON_CONFIDENCE,
};
