/**
 * Digital Twin Risk Simulation Center — core deterministic engine.
 *
 * Pure-function engine: no I/O, no React, no stores. All functions are
 * deterministic for the same (tenant, day) pair, using FNV-1a + Mulberry32.
 *
 * Mirrors the 10-table schema in data/schema/060_digital_twin.sql and
 * the 10 seed templates (5 banking + 5 insurance) provisioned for BANK_DEMO.
 *
 * Phase 17 IA overlay — additive; every prior module untouched.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers (copy of the standard engine helper set)
// ─────────────────────────────────────────────────────────────────────────────

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round(value: number, decimals = 0): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Closed enums
// ─────────────────────────────────────────────────────────────────────────────

export const SIMULATION_DOMAINS = ['banking', 'insurance', 'cross_domain'] as const;
export type SimulationDomain = (typeof SIMULATION_DOMAINS)[number];

export const SIMULATION_KINDS = [
  'interest_rate_shock',
  'liquidity_crisis',
  'sector_shock',
  'economic_stress',
  'claims_surge',
  'fraud_spike',
  'lapse_surge',
  'catastrophic_event',
  'solvency_stress',
] as const;
export type SimulationKind = (typeof SIMULATION_KINDS)[number];

export const SIMULATION_HORIZONS = ['30d', '60d', '90d', '180d'] as const;
export type SimulationHorizon = (typeof SIMULATION_HORIZONS)[number];

export const SCENARIO_STATES = ['draft', 'review', 'approved', 'rejected', 'archived'] as const;
export type ScenarioState = (typeof SCENARIO_STATES)[number];

export const IMPACT_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

export const IMPACT_CATEGORIES = ['financial', 'operational', 'compliance', 'risk', 'executive'] as const;
export type ImpactCategory = (typeof IMPACT_CATEGORIES)[number];

export const WORKFLOW_ACTIONS = [
  'submit_for_review',
  'approve',
  'reject',
  'archive',
  'restore',
  'clone',
] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

export const BOARD_REPORT_KINDS = ['board', 'risk_committee', 'audit_committee', 'regulatory'] as const;
export type BoardReportKind = (typeof BOARD_REPORT_KINDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// RBAC
// ─────────────────────────────────────────────────────────────────────────────

export const DIGITAL_TWIN_ROLES: readonly string[] = [
  'admin',
  'supervisor',
  'risk_analyst',
  'super_admin',
  'country_admin',
  'bank_admin',
  'insurance_admin',
  'fraud_analyst',
  'auditor',
  'compliance_officer',
  'operations_user',
  'executive',
  'cdo',
  'cro',
  'ceo',
  'board_member',
];

export function canAccessDigitalTwinCenter(roles: readonly string[] | undefined): boolean {
  if (!roles || roles.length === 0) return false;
  const allowed = new Set(DIGITAL_TWIN_ROLES);
  for (const r of roles) {
    if (allowed.has(r)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario Templates (mirrors the 10 SQL seed rows)
// ─────────────────────────────────────────────────────────────────────────────

export interface ScenarioTemplate {
  template_id: string;
  name: string;
  description: string;
  domain: SimulationDomain;
  kind: SimulationKind;
  default_severity_pct: number;
  default_horizon: SimulationHorizon;
  risk_drivers: string[];
  estimated_npa_impact_bps: number;
  estimated_ecl_impact_pct: number;
}

export const SCENARIO_TEMPLATES: readonly ScenarioTemplate[] = [
  {
    template_id: 'TPL-BNK-RATE-RBI',
    name: 'RBI Rate Increase',
    description: 'RBI hikes repo rate by 100–500 bps in the next monetary cycle.',
    domain: 'banking',
    kind: 'interest_rate_shock',
    default_severity_pct: 200,
    default_horizon: '90d',
    risk_drivers: ['NIM compression', 'Bond portfolio MTM', 'Retail reprice lag', 'CASA attrition'],
    estimated_npa_impact_bps: 35,
    estimated_ecl_impact_pct: 1.8,
  },
  {
    template_id: 'TPL-BNK-LIQ-CRISIS',
    name: 'Liquidity Crisis',
    description: 'System-wide liquidity drain triggers withdrawal pressure on branches.',
    domain: 'banking',
    kind: 'liquidity_crisis',
    default_severity_pct: 35,
    default_horizon: '60d',
    risk_drivers: ['LCR breach risk', 'CD rollover risk', 'Wholesale funding flight', 'Repo market stress'],
    estimated_npa_impact_bps: 80,
    estimated_ecl_impact_pct: 3.2,
  },
  {
    template_id: 'TPL-BNK-MSME',
    name: 'MSME Collapse',
    description: 'Concentrated MSME stress driven by demand shock + working-capital squeeze.',
    domain: 'banking',
    kind: 'sector_shock',
    default_severity_pct: 40,
    default_horizon: '90d',
    risk_drivers: ['MSME NPA spike', 'OD utilisation surge', 'Supply chain disruption', 'GST revenue miss'],
    estimated_npa_impact_bps: 120,
    estimated_ecl_impact_pct: 4.5,
  },
  {
    template_id: 'TPL-BNK-HOUSING',
    name: 'Housing Market Crash',
    description: 'Real-estate price correction triggers home-loan defaults in mid-tier cities.',
    domain: 'banking',
    kind: 'sector_shock',
    default_severity_pct: 30,
    default_horizon: '180d',
    risk_drivers: ['LTV breach cascade', 'Developer default', 'Under-construction stall', 'Affordability cliff'],
    estimated_npa_impact_bps: 65,
    estimated_ecl_impact_pct: 2.8,
  },
  {
    template_id: 'TPL-BNK-REGIONAL',
    name: 'Regional Stress',
    description: 'Localised GDP contraction in 2–3 states drives broad portfolio deterioration.',
    domain: 'banking',
    kind: 'economic_stress',
    default_severity_pct: 25,
    default_horizon: '90d',
    risk_drivers: ['State GSVA decline', 'Agri distress', 'Urban employment shock', 'Government capex pause'],
    estimated_npa_impact_bps: 50,
    estimated_ecl_impact_pct: 2.1,
  },
  {
    template_id: 'TPL-INS-CLAIM-INF',
    name: 'Claims Inflation',
    description: 'Sustained 15–30% claims-volume growth across health + motor lines.',
    domain: 'insurance',
    kind: 'claims_surge',
    default_severity_pct: 25,
    default_horizon: '90d',
    risk_drivers: ['Medical inflation', 'Motor third-party inflation', 'Fraud leakage', 'Under-reserving legacy'],
    estimated_npa_impact_bps: 0,
    estimated_ecl_impact_pct: 5.5,
  },
  {
    template_id: 'TPL-INS-FRAUD',
    name: 'Fraud Wave',
    description: 'Organised fraud cluster spikes investigation workload + SIU capacity.',
    domain: 'insurance',
    kind: 'fraud_spike',
    default_severity_pct: 50,
    default_horizon: '60d',
    risk_drivers: ['Staged accident rings', 'Ghost hospitals', 'Agent collusion', 'Digital forgery surge'],
    estimated_npa_impact_bps: 0,
    estimated_ecl_impact_pct: 8.2,
  },
  {
    template_id: 'TPL-INS-PERSIST',
    name: 'Persistency Decline',
    description: 'Renewal slump driven by competitive pressure + economic uncertainty.',
    domain: 'insurance',
    kind: 'lapse_surge',
    default_severity_pct: 20,
    default_horizon: '90d',
    risk_drivers: ['13th month lapse spike', 'Surrender value arbitrage', 'Mis-sell reputation risk', 'Digital aggregator pricing'],
    estimated_npa_impact_bps: 0,
    estimated_ecl_impact_pct: 3.0,
  },
  {
    template_id: 'TPL-INS-CATASTRO',
    name: 'Catastrophe Event',
    description: 'Cyclone + flooding in coastal states triggers high-volume claims surge.',
    domain: 'insurance',
    kind: 'catastrophic_event',
    default_severity_pct: 60,
    default_horizon: '30d',
    risk_drivers: ['CAT reinsurance exhaustion', 'Claims triage overload', 'Solvency ratio dip', 'Regulator intervention risk'],
    estimated_npa_impact_bps: 0,
    estimated_ecl_impact_pct: 12.0,
  },
  {
    template_id: 'TPL-INS-SOLVENCY',
    name: 'Solvency Shock',
    description: 'Adverse-development + reserve strengthening drives solvency ratio down.',
    domain: 'insurance',
    kind: 'solvency_stress',
    default_severity_pct: 35,
    default_horizon: '90d',
    risk_drivers: ['IBNR development', 'Asset liability mismatch', 'Interest rate reversal', 'Run-on-bank analogue'],
    estimated_npa_impact_bps: 0,
    estimated_ecl_impact_pct: 6.8,
  },
] as const;

export function listScenarioTemplates(domain?: SimulationDomain): ScenarioTemplate[] {
  if (!domain) return [...SCENARIO_TEMPLATES];
  return SCENARIO_TEMPLATES.filter((t) => t.domain === domain);
}

export function getTemplate(template_id: string): ScenarioTemplate | undefined {
  return SCENARIO_TEMPLATES.find((t) => t.template_id === template_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulation Run types
// ─────────────────────────────────────────────────────────────────────────────

export interface MetricProjection {
  metric: string;
  label: string;
  unit: string;
  baseline_value: number;
  projected_value: number;
  delta_value: number;
  delta_pct: number;
  direction: 'up' | 'down' | 'neutral';
  risk_flag: boolean;
}

export interface SimulationRun {
  run_id: string;
  scenario_id: string;
  template_id: string;
  domain: SimulationDomain;
  kind: SimulationKind;
  name: string;
  severity_pct: number;
  horizon: SimulationHorizon;
  triggered_by: string;
  started_at: string;
  duration_ms: number;
  confidence_score: number;
  impact_level: ImpactLevel;
  metrics: MetricProjection[];
}

export interface ImpactCategoryScore {
  category: ImpactCategory;
  score: number;
  level: ImpactLevel;
  key_drivers: string[];
  financial_estimate_inr: number | null;
}

export interface ImpactAnalysis {
  analysis_id: string;
  run_id: string;
  overall_score: number;
  overall_level: ImpactLevel;
  categories: ImpactCategoryScore[];
  generated_at: string;
}

export interface AiRecommendation {
  recommendation_id: string;
  run_id: string;
  confidence_score: number;
  narrative: string;
  immediate_actions: string[];
  medium_term_actions: string[];
  risk_appetite_note: string;
  generated_at: string;
}

export interface WorkflowEvent {
  event_id: string;
  scenario_id: string;
  action: WorkflowAction;
  actor: string;
  ts: string;
  from_state: ScenarioState | null;
  to_state: ScenarioState;
  comment: string;
}

export interface SavedScenario {
  scenario_id: string;
  name: string;
  template_id: string;
  domain: SimulationDomain;
  kind: SimulationKind;
  severity_pct: number;
  horizon: SimulationHorizon;
  state: ScenarioState;
  created_by: string;
  created_at: string;
  run_count: number;
  last_run_at: string | null;
  latest_impact_level: ImpactLevel | null;
}

export interface ScenarioComparison {
  comparison_id: string;
  scenario_a: string;
  scenario_b: string;
  risk_delta_pp: number;
  revenue_delta_inr: number;
  compliance_delta_pp: number;
  solvency_delta_pp: number;
  npa_delta_pp: number;
  winner: 'A' | 'B' | 'tie';
  generated_at: string;
}

export interface BoardReport {
  report_id: string;
  kind: BoardReportKind;
  format: 'pdf' | 'excel' | 'csv';
  period_label: string;
  recipient_audience: string;
  scenarios_included: number;
  high_impact_count: number;
  download_size_kb: number;
  sign_off_required_from: string[];
  generated_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Impact level helpers
// ─────────────────────────────────────────────────────────────────────────────

export function scoreToLevel(score: number): ImpactLevel {
  if (score >= 75) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

export function levelToColor(level: ImpactLevel): string {
  if (level === 'critical') return '#EF4444';
  if (level === 'high') return '#F97316';
  if (level === 'medium') return '#F59E0B';
  return '#10B981';
}

export function levelTone(level: ImpactLevel): 'danger' | 'warning' | 'neutral' | 'success' {
  if (level === 'critical') return 'danger';
  if (level === 'high') return 'warning';
  if (level === 'medium') return 'neutral';
  return 'success';
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Simulation Run (deterministic)
// ─────────────────────────────────────────────────────────────────────────────

const BANKING_METRICS = [
  { metric: 'npa_ratio', label: 'Gross NPA Ratio', unit: '%' },
  { metric: 'net_npa_ratio', label: 'Net NPA Ratio', unit: '%' },
  { metric: 'ecl_provision', label: 'ECL Provision (₹ Cr)', unit: '₹ Cr' },
  { metric: 'crar', label: 'CRAR', unit: '%' },
  { metric: 'pcr', label: 'Provision Coverage', unit: '%' },
  { metric: 'nim', label: 'Net Interest Margin', unit: '%' },
  { metric: 'slr', label: 'SLR Ratio', unit: '%' },
  { metric: 'casa_ratio', label: 'CASA Ratio', unit: '%' },
] as const;

const INSURANCE_METRICS = [
  { metric: 'combined_ratio', label: 'Combined Ratio', unit: '%' },
  { metric: 'loss_ratio', label: 'Loss Ratio', unit: '%' },
  { metric: 'solvency_ratio', label: 'Solvency Ratio', unit: '%' },
  { metric: 'persistency_13m', label: 'Persistency (13M)', unit: '%' },
  { metric: 'claim_settlement', label: 'Claim Settlement Ratio', unit: '%' },
  { metric: 'expense_ratio', label: 'Expense Ratio', unit: '%' },
  { metric: 'premium_growth', label: 'Premium Growth', unit: '%' },
  { metric: 'reinsurance_coverage', label: 'Reinsurance Coverage', unit: '%' },
] as const;

const BANKING_BASELINES: Record<string, number> = {
  npa_ratio: 3.2, net_npa_ratio: 1.1, ecl_provision: 4850, crar: 16.8,
  pcr: 74.2, nim: 3.4, slr: 23.5, casa_ratio: 42.1,
};

const INSURANCE_BASELINES: Record<string, number> = {
  combined_ratio: 98.5, loss_ratio: 71.2, solvency_ratio: 182.3,
  persistency_13m: 83.4, claim_settlement: 97.2, expense_ratio: 27.3,
  premium_growth: 14.8, reinsurance_coverage: 68.5,
};

export function buildSimulationRun(
  tenant: string,
  template_id: string,
  asOf: Date,
  overrides?: { severity_pct?: number; horizon?: SimulationHorizon },
): SimulationRun {
  const template = getTemplate(template_id);
  if (!template) throw new Error(`Unknown template: ${template_id}`);

  const severity_pct = overrides?.severity_pct ?? template.default_severity_pct;
  const horizon = overrides?.horizon ?? template.default_horizon;
  const stressMultiplier = clamp(severity_pct / 100, 0, 3);

  const rng = mulberry32(fnv1a(`${tenant}:${template_id}:${dayKey(asOf)}:run`));

  const run_id = `RUN-${tenant.slice(0, 3)}-${template_id.slice(-5)}-${dayKey(asOf).replace(/-/g, '')}`;

  const metricDefs = template.domain === 'insurance' ? INSURANCE_METRICS : BANKING_METRICS;
  const baselines = template.domain === 'insurance' ? INSURANCE_BASELINES : BANKING_BASELINES;

  const metrics: MetricProjection[] = metricDefs.map((def) => {
    const baseline = baselines[def.metric] ?? 10;
    // stress impact: severity_pct controls magnitude; rng adds noise
    const baseImpact = baseline * stressMultiplier * 0.08 * (0.5 + rng());
    const noise = (rng() - 0.5) * baseline * 0.03;
    const isAdverseMetric = [
      'npa_ratio', 'net_npa_ratio', 'ecl_provision', 'loss_ratio', 'combined_ratio', 'expense_ratio',
    ].includes(def.metric);
    const isBeneficialMetric = [
      'crar', 'pcr', 'solvency_ratio', 'persistency_13m', 'claim_settlement', 'reinsurance_coverage',
    ].includes(def.metric);

    let delta = isAdverseMetric ? baseImpact + noise : isBeneficialMetric ? -(baseImpact + noise) : noise;
    delta = round(delta, 2);

    const projected = round(baseline + delta, 2);
    const delta_pct = baseline !== 0 ? round((delta / baseline) * 100, 1) : 0;

    return {
      metric: def.metric,
      label: def.label,
      unit: def.unit,
      baseline_value: baseline,
      projected_value: projected,
      delta_value: delta,
      delta_pct,
      direction: delta > 0.05 ? 'up' : delta < -0.05 ? 'down' : 'neutral',
      risk_flag: isAdverseMetric ? delta > baseline * 0.05 : isBeneficialMetric ? delta < -(baseline * 0.08) : false,
    };
  });

  const confidence_score = round(clamp(0.72 + (1 - stressMultiplier / 3) * 0.22 + (rng() - 0.5) * 0.08, 0.6, 0.98), 3);
  const risk_score = round(30 + stressMultiplier * 30 + rng() * 15);
  const impact_level = scoreToLevel(risk_score);

  return {
    run_id,
    scenario_id: `SCN-${tenant.slice(0, 3)}-${template_id.slice(-5)}`,
    template_id,
    domain: template.domain,
    kind: template.kind,
    name: template.name,
    severity_pct,
    horizon,
    triggered_by: 'risk_analyst',
    started_at: asOf.toISOString(),
    duration_ms: Math.floor(1200 + rng() * 3800),
    confidence_score,
    impact_level,
    metrics,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Impact Analysis
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_DRIVERS: Record<ImpactCategory, string[][]> = {
  financial: [
    ['NPA ratio deterioration', 'ECL provision surge', 'NIM compression', 'Capital adequacy pressure'],
    ['Loss ratio spike', 'Solvency margin erosion', 'Premium income stress', 'Reinsurance recovery gap'],
    ['Revenue impact ₹120–₹450 Cr', 'Provision shortfall risk', 'CRAR breach watch', 'MTM losses'],
  ],
  operational: [
    ['SIU capacity overload', 'Claims processing backlog', 'Branch liquidity pressure', 'Collections mobilisation'],
    ['IT system load spike', 'Staff overtime trigger', 'Vendor SLA stress', 'Process bottleneck risk'],
    ['Turnaround time +35%', 'Queue depth 2.4× normal', 'Escalations +180%', 'Manual override spike'],
  ],
  compliance: [
    ['RBI early warning breach threshold', 'IRDAI solvency floor watch', 'Provisioning norms', 'IFRS 9 Stage-3 migration'],
    ['Regulatory reporting lag', 'Disclosure obligation trigger', 'Audit committee alert', 'Board MIS update required'],
    ['Supervisory review flag', 'Corrective Action Plan risk', 'Consent order watch', 'PCA framework entry risk'],
  ],
  risk: [
    ['Credit concentration breach', 'Sectoral exposure limit stress', 'Correlation risk spike', 'Tail risk materialisation'],
    ['VaR limit utilisation >85%', 'Stress VaR breach zone', 'Liquidity coverage risk', 'Counterparty exposure spike'],
    ['Rating downgrade trigger', 'Covenant breach risk', 'Collateral value erosion', 'Cross-default watch'],
  ],
  executive: [
    ['Board risk appetite breach', 'Strategic KPI miss risk', 'Investor relations concern', 'Credit rating watch'],
    ['CEO disclosure threshold', 'AGM agenda implication', 'ESG impact flagged', 'Compensation plan linkage'],
    ['Management bandwidth risk', 'Crisis communication plan trigger', 'Regulator engagement needed', 'External audit flag'],
  ],
};

export function buildImpactAnalysis(tenant: string, run: SimulationRun, asOf: Date): ImpactAnalysis {
  const rng = mulberry32(fnv1a(`${tenant}:${run.run_id}:impact:${dayKey(asOf)}`));
  const stressMultiplier = clamp(run.severity_pct / 100, 0, 3);
  const analysis_id = `ANA-${run.run_id}`;

  const categories: ImpactCategoryScore[] = IMPACT_CATEGORIES.map((cat) => {
    const base = 25 + stressMultiplier * 20 + rng() * 25;
    const score = round(clamp(base, 10, 95));
    const level = scoreToLevel(score);
    const driverSets = CATEGORY_DRIVERS[cat];
    const drivers = pick(driverSets, rng);
    const financial_estimate = cat === 'financial'
      ? round((120 + stressMultiplier * 330 + rng() * 150) * 1e7, 0)
      : null;

    return {
      category: cat,
      score,
      level,
      key_drivers: drivers.slice(0, 3),
      financial_estimate_inr: financial_estimate,
    };
  });

  const overall_score = round(categories.reduce((s, c) => s + c.score, 0) / categories.length);
  const overall_level = scoreToLevel(overall_score);

  return {
    analysis_id,
    run_id: run.run_id,
    overall_score,
    overall_level,
    categories,
    generated_at: asOf.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build AI Recommendations
// ─────────────────────────────────────────────────────────────────────────────

const BANKING_NARRATIVES = [
  'Portfolio stress modelling indicates elevated credit risk concentration in the MSME and retail segments. Immediate provisioning review recommended per RBI IRACP norms.',
  'Liquidity stress tests suggest LCR may approach the 100% regulatory floor under severe scenarios. Proactive HQLA buffer augmentation warranted.',
  'NPA migration analysis projects Stage 2 to Stage 3 movement of 1.8–2.4% of the performing book over the stress horizon. Early restructuring eligibility assessment advised.',
  'Capital adequacy modelling under the stress path indicates CRAR may compress by 80–120 bps. Tier-1 capital optimisation and risk-weighted asset management recommended.',
];

const INSURANCE_NARRATIVES = [
  'Claims frequency modelling projects a 22–35% surge in health and motor lines over the stress horizon. Reinsurance programme adequacy review and claims reserving strengthening are priority actions.',
  'Persistency stress analysis indicates 13th-month lapse rates may deteriorate by 6–9 percentage points under adverse conditions. Proactive renewal campaign and customer engagement escalation recommended.',
  'Solvency stress testing projects a potential 18–24 percentage point compression in the solvency ratio. Capital injection planning and reinsurance coverage optimisation are immediate priorities.',
  'Catastrophic event modelling indicates maximum probable loss exposure of ₹380–620 Cr net of reinsurance. Retrocession programme review and CAT reserve adequacy confirmation required.',
];

const BANKING_IMMEDIATE = [
  'Activate Credit Risk Early Warning System alerts for MSME + retail segments',
  'Initiate OAEM and Special Mention Account review under RBI circulars',
  'Escalate to Board Risk Committee with updated stress test results',
  'Trigger contingency funding plan protocol at 95% LCR threshold',
];

const BANKING_MEDIUM = [
  'Implement sector-specific exposure caps per updated risk appetite framework',
  'Accelerate NPA resolution through SARFAESI + NCLT proceedings for top 20 accounts',
  'Review and strengthen collateral valuation methodology for affected segments',
  'Update ECL model parameters to reflect current macro stress environment',
];

const INSURANCE_IMMEDIATE = [
  'Activate Special Investigation Unit surge capacity protocol',
  'Notify reinsurers per treaty obligations and begin loss accumulation tracking',
  'Escalate to IRDAI as per CAT event disclosure norms',
  'Initiate claims triage process and fast-track settlement for eligible cases',
];

const INSURANCE_MEDIUM = [
  'Review product pricing for affected lines of business at next rate revision',
  'Strengthen anti-fraud controls and network provider due diligence',
  'Model revised persistency assumptions into business plan and embedded value',
  'Engage actuarial team for reserve adequacy review and IBNR recalibration',
];

export function buildAiRecommendations(tenant: string, run: SimulationRun, asOf: Date): AiRecommendation {
  const rng = mulberry32(fnv1a(`${tenant}:${run.run_id}:ai:${dayKey(asOf)}`));

  const narratives = run.domain === 'insurance' ? INSURANCE_NARRATIVES : BANKING_NARRATIVES;
  const immediates = run.domain === 'insurance' ? INSURANCE_IMMEDIATE : BANKING_IMMEDIATE;
  const mediums = run.domain === 'insurance' ? INSURANCE_MEDIUM : BANKING_MEDIUM;

  const narrative = pick(narratives, rng);
  const immediate_actions = immediates.slice(0, Math.floor(2 + rng() * 2));
  const medium_term_actions = mediums.slice(0, Math.floor(2 + rng() * 2));

  const stressMultiplier = clamp(run.severity_pct / 100, 0, 3);
  const confidence_score = round(clamp(0.71 + (1 - stressMultiplier / 3) * 0.21 + (rng() - 0.5) * 0.06, 0.65, 0.97), 3);

  const appetiteNotes = [
    'Current scenario falls within the Board-approved risk appetite tolerance band. No framework revision required at this stage.',
    'Stress trajectory approaches the outer boundary of the risk appetite statement. Tactical risk appetite review recommended.',
    'Impact projections exceed risk appetite thresholds in 2 dimensions. Formal risk appetite breach escalation protocol to be initiated.',
  ];

  const risk_appetite_note = stressMultiplier < 0.5
    ? appetiteNotes[0]
    : stressMultiplier < 1.5
    ? appetiteNotes[1]
    : appetiteNotes[2];

  return {
    recommendation_id: `REC-${run.run_id}`,
    run_id: run.run_id,
    confidence_score,
    narrative,
    immediate_actions,
    medium_term_actions,
    risk_appetite_note,
    generated_at: asOf.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Workflow Timeline
// ─────────────────────────────────────────────────────────────────────────────

const ACTORS = ['risk_analyst', 'cro', 'supervisor', 'compliance_officer', 'board_member', 'admin'];
const COMMENTS: Record<WorkflowAction, string[]> = {
  submit_for_review: [
    'Scenario parameters validated. Submitting for CRO review.',
    'Stress test results reviewed by team. Ready for sign-off.',
    'Model outputs consistent with prior quarter. Submitting.',
  ],
  approve: [
    'Scenario approved for inclusion in board pack.',
    'Risk committee sign-off completed. Approved for use.',
    'CRO approved. Scenario may proceed to regulatory submission.',
  ],
  reject: [
    'Severity parameter requires recalibration against current macro outlook.',
    'Scenario assumptions not aligned with updated risk appetite statement.',
    'Model inputs require validation against latest market data.',
  ],
  archive: [
    'Superseded by updated scenario version.',
    'Archived following quarterly review cycle.',
    'No longer relevant per current business plan assumptions.',
  ],
  restore: ['Restored for comparison with current scenario run.', 'Reactivated per audit request.'],
  clone: ['Cloned as baseline for sensitivity analysis.', 'Cloned for parallel stress test comparison.'],
};

export function buildWorkflowTimeline(
  tenant: string,
  template_id: string,
  asOf: Date,
): WorkflowEvent[] {
  const rng = mulberry32(fnv1a(`${tenant}:${template_id}:workflow:${dayKey(asOf)}`));
  const scenario_id = `SCN-${tenant.slice(0, 3)}-${template_id.slice(-5)}`;

  const eventCount = Math.floor(2 + rng() * 4);
  const events: WorkflowEvent[] = [];

  const transitions: Array<{ action: WorkflowAction; from: ScenarioState; to: ScenarioState }> = [
    { action: 'submit_for_review', from: 'draft', to: 'review' },
    { action: 'approve', from: 'review', to: 'approved' },
    { action: 'archive', from: 'approved', to: 'archived' },
    { action: 'restore', from: 'archived', to: 'draft' },
    { action: 'submit_for_review', from: 'draft', to: 'review' },
  ];

  const msPerEvent = (7 * 24 * 60 * 60 * 1000) / eventCount;

  for (let i = 0; i < Math.min(eventCount, transitions.length); i++) {
    const t = transitions[i];
    const ts = new Date(asOf.getTime() - (eventCount - i) * msPerEvent);

    events.push({
      event_id: `EVT-${scenario_id}-${i + 1}`,
      scenario_id,
      action: t.action,
      actor: pick(ACTORS, rng),
      ts: ts.toISOString(),
      from_state: i === 0 ? null : t.from,
      to_state: t.to,
      comment: pick(COMMENTS[t.action], rng),
    });
  }

  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Saved Scenarios list
// ─────────────────────────────────────────────────────────────────────────────

const SCENARIO_STATES_DIST: ScenarioState[] = ['approved', 'approved', 'review', 'draft', 'archived'];

export function buildSavedScenarios(tenant: string, asOf: Date): SavedScenario[] {
  const rng = mulberry32(fnv1a(`${tenant}:scenarios:${dayKey(asOf)}`));

  return SCENARIO_TEMPLATES.map((template, i) => {
    const state = SCENARIO_STATES_DIST[i % SCENARIO_STATES_DIST.length];
    const run_count = Math.floor(1 + rng() * 8);
    const last_run_days_ago = Math.floor(rng() * 14);
    const last_run_at = state !== 'draft'
      ? new Date(asOf.getTime() - last_run_days_ago * 86400_000).toISOString()
      : null;
    const impact_levels: ImpactLevel[] = ['low', 'medium', 'high', 'critical'];
    const latest_impact_level = state !== 'draft'
      ? pick(impact_levels, rng)
      : null;

    return {
      scenario_id: `SCN-${tenant.slice(0, 3)}-${template.template_id.slice(-5)}`,
      name: template.name,
      template_id: template.template_id,
      domain: template.domain,
      kind: template.kind,
      severity_pct: template.default_severity_pct,
      horizon: template.default_horizon,
      state,
      created_by: pick(ACTORS, rng),
      created_at: new Date(asOf.getTime() - (20 + i * 5) * 86400_000).toISOString(),
      run_count,
      last_run_at,
      latest_impact_level,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Scenario Comparison
// ─────────────────────────────────────────────────────────────────────────────

export function buildScenarioComparison(
  tenant: string,
  run_a: SimulationRun,
  run_b: SimulationRun,
  asOf: Date,
): ScenarioComparison {
  const rng = mulberry32(fnv1a(`${tenant}:${run_a.run_id}:${run_b.run_id}:cmp:${dayKey(asOf)}`));

  const risk_delta_pp = round((rng() - 0.5) * 4, 2);
  const revenue_delta_inr = round((rng() - 0.5) * 200_000_000, 0);
  const compliance_delta_pp = round((rng() - 0.5) * 3, 2);
  const solvency_delta_pp = round((rng() - 0.5) * 5, 2);
  const npa_delta_pp = round((rng() - 0.5) * 2, 2);

  const adverseA = run_a.severity_pct;
  const adverseB = run_b.severity_pct;
  const winner: 'A' | 'B' | 'tie' =
    adverseA < adverseB - 5 ? 'A' : adverseB < adverseA - 5 ? 'B' : 'tie';

  return {
    comparison_id: `CMP-${run_a.run_id.slice(-4)}-${run_b.run_id.slice(-4)}`,
    scenario_a: run_a.name,
    scenario_b: run_b.name,
    risk_delta_pp,
    revenue_delta_inr,
    compliance_delta_pp,
    solvency_delta_pp,
    npa_delta_pp,
    winner,
    generated_at: asOf.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Board Reports
// ─────────────────────────────────────────────────────────────────────────────

const BOARD_PERIODS = ['Q1 FY 2025-26', 'Q4 FY 2024-25', 'Q3 FY 2024-25', 'Q2 FY 2024-25'];
const AUDIENCES: Record<BoardReportKind, string> = {
  board: 'Board of Directors + Executive Committee',
  risk_committee: 'Board Risk Committee (BRC)',
  audit_committee: 'Audit Committee + Internal Audit',
  regulatory: 'RBI / IRDAI Supervisory Review',
};
const SIGN_OFFS: Record<BoardReportKind, string[]> = {
  board: ['CEO', 'CRO', 'CFO'],
  risk_committee: ['CRO', 'Chief Risk Officer Designate'],
  audit_committee: ['CFO', 'Chief Internal Auditor', 'CRO'],
  regulatory: ['MD & CEO', 'CRO', 'CFO', 'Company Secretary'],
};

export function buildBoardReports(tenant: string, asOf: Date): BoardReport[] {
  const rng = mulberry32(fnv1a(`${tenant}:board-reports:${dayKey(asOf)}`));
  const formats: Array<'pdf' | 'excel' | 'csv'> = ['pdf', 'pdf', 'excel', 'csv'];

  return BOARD_REPORT_KINDS.map((kind, i) => {
    const scenarios_included = Math.floor(3 + rng() * 6);
    const high_impact_count = Math.floor(rng() * scenarios_included * 0.6);
    const download_size_kb = Math.floor(120 + rng() * 1880);

    return {
      report_id: `RPT-${tenant.slice(0, 3)}-${kind.toUpperCase().slice(0, 4)}-${dayKey(asOf).replace(/-/g, '')}`,
      kind,
      format: formats[i],
      period_label: BOARD_PERIODS[i],
      recipient_audience: AUDIENCES[kind],
      scenarios_included,
      high_impact_count,
      download_size_kb,
      sign_off_required_from: SIGN_OFFS[kind],
      generated_at: new Date(asOf.getTime() - i * 5 * 86400_000).toISOString(),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Dashboard KPIs
// ─────────────────────────────────────────────────────────────────────────────

export interface DigitalTwinKpis {
  active_scenarios: number;
  simulations_run_30d: number;
  high_critical_events: number;
  avg_confidence_score: number;
  approved_scenarios: number;
  pending_review: number;
  board_reports_generated: number;
  scenario_coverage_pct: number;
}

export function buildDigitalTwinKpis(tenant: string, asOf: Date): DigitalTwinKpis {
  const rng = mulberry32(fnv1a(`${tenant}:dt-kpis:${dayKey(asOf)}`));

  return {
    active_scenarios: Math.floor(6 + rng() * 6),
    simulations_run_30d: Math.floor(28 + rng() * 62),
    high_critical_events: Math.floor(2 + rng() * 8),
    avg_confidence_score: round(0.78 + rng() * 0.16, 2),
    approved_scenarios: Math.floor(4 + rng() * 4),
    pending_review: Math.floor(rng() * 4),
    board_reports_generated: Math.floor(2 + rng() * 6),
    scenario_coverage_pct: round(70 + rng() * 25),
  };
}
