/**
 * Enterprise Reporting & Board Packs Center — core engine.
 *
 * Pure-function engine: no I/O, no React, no stores.
 * Deterministic for (tenant, day) via FNV-1a + Mulberry32.
 *
 * 12 sections: Board Pack Library, Executive Reporting, Board Dashboards,
 * Regulatory Reporting, AI Governance Reports, Compliance Reports,
 * Predictive Reporting, Digital Twin Reports, Autonomous AI Reports,
 * Board Pack Generator, Report Scheduler, Executive Intelligence Summary.
 *
 * Phase 21 IA overlay — additive; every prior module untouched.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dayKey(d: Date): string { return d.toISOString().slice(0, 10); }
function r2(v: number): number { return Math.round(v * 100) / 100; }
function r1(v: number): number { return Math.round(v * 10) / 10; }
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function pick<T>(arr: readonly T[], rng: () => number): T { return arr[Math.floor(rng() * arr.length)]; }
function addDays(d: Date, n: number): string { return new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10); }

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export const PACK_TYPES = ['board_risk', 'executive_risk', 'cro', 'ceo', 'cfo', 'audit_committee', 'risk_committee', 'compliance_committee', 'regulatory_filing'] as const;
export type PackType = typeof PACK_TYPES[number];

export const APPROVAL_STATUSES = ['draft', 'under_review', 'approved', 'distributed', 'archived'] as const;
export type ApprovalStatus = typeof APPROVAL_STATUSES[number];

export const REPORT_FORMATS = ['pdf', 'excel', 'csv'] as const;
export type ReportFormat = typeof REPORT_FORMATS[number];

export const SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'annual'] as const;
export type ScheduleFrequency = typeof SCHEDULE_FREQUENCIES[number];

export const REGULATORY_FRAMEWORKS = ['RBI', 'IRDAI', 'Basel', 'SEBI', 'PMLA', 'IFRS9'] as const;
export type RegulatoryFramework = typeof REGULATORY_FRAMEWORKS[number];

export const FORECAST_HORIZONS = ['30d', '60d', '90d', '180d'] as const;
export type ForecastHorizon = typeof FORECAST_HORIZONS[number];

export const TREND_DIRECTIONS = ['improving', 'stable', 'deteriorating'] as const;
export type TrendDirection = typeof TREND_DIRECTIONS[number];

// ─────────────────────────────────────────────────────────────────────────────
// RBAC
// ─────────────────────────────────────────────────────────────────────────────

export const BOARD_REPORTING_ROLES: readonly string[] = [
  'admin', 'supervisor', 'risk_analyst', 'super_admin', 'country_admin',
  'bank_admin', 'insurance_admin', 'fraud_analyst', 'auditor',
  'compliance_officer', 'executive', 'cdo', 'cro', 'ceo', 'coo', 'cfo',
  'board_member', 'operations_manager', 'country_head', 'company_secretary',
];
export function canAccessBoardReportingCenter(roles: readonly string[] | undefined): boolean {
  if (!roles || roles.length === 0) return false;
  const allowed = new Set(BOARD_REPORTING_ROLES);
  for (const r of roles) { if (allowed.has(r)) return true; }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — Board Pack Library
// ─────────────────────────────────────────────────────────────────────────────

export interface BoardPack {
  pack_id: string;
  pack_type: PackType;
  title: string;
  owner: string;
  version: string;
  approval_status: ApprovalStatus;
  last_generated: string;
  next_due: string;
  review_cycle: ScheduleFrequency;
  distribution_list: string[];
  pages_count: number;
  size_kb: number;
  sections: string[];
  approved_by: string | null;
  signed_off_at: string | null;
}

export const PACK_METADATA: Record<PackType, { title: string; owner: string; cycle: ScheduleFrequency; distribution: string[]; sections: string[] }> = {
  board_risk:           { title: 'Board Risk Pack',             owner: 'CRO Office',         cycle: 'quarterly', distribution: ['Board Members', 'MD & CEO', 'CRO', 'CFO'],                           sections: ['Executive Summary', 'Portfolio Risk', 'Emerging Risks', 'Regulatory Status', 'AI & Model Risk'] },
  executive_risk:       { title: 'Executive Risk Pack',         owner: 'Risk Analytics',     cycle: 'monthly',   distribution: ['CRO', 'CFO', 'COO', 'Chief Compliance Officer'],                   sections: ['Risk Dashboard', 'NPA Analysis', 'Fraud Summary', 'Compliance Status', 'Predictions'] },
  cro:                  { title: 'CRO Management Pack',         owner: 'Risk Analytics',     cycle: 'monthly',   distribution: ['CRO', 'Deputy CRO', 'Risk Heads'],                                  sections: ['Risk Scorecard', 'Model Performance', 'Portfolio Deep Dive', 'Collections', 'Recovery'] },
  ceo:                  { title: 'CEO Intelligence Pack',       owner: 'Strategy Office',    cycle: 'weekly',    distribution: ['MD & CEO', 'Executive Committee'],                                   sections: ['Business KPIs', 'Risk Snapshot', 'Compliance Highlights', 'AI Insights', 'Forecasts'] },
  cfo:                  { title: 'CFO Financial Risk Pack',     owner: 'Finance',            cycle: 'monthly',   distribution: ['CFO', 'Treasury Head', 'Chief Accountant'],                          sections: ['P&L Impact', 'ECL Provisions', 'Capital Adequacy', 'Liquidity Risk', 'Forex Exposure'] },
  audit_committee:      { title: 'Audit Committee Pack',        owner: 'Internal Audit',     cycle: 'quarterly', distribution: ['Audit Committee Members', 'Chief Internal Auditor', 'CEO'],          sections: ['Audit Findings', 'Compliance Breaches', 'Control Assessment', 'Fraud Incidents', 'Remediation'] },
  risk_committee:       { title: 'Risk Committee Pack',         owner: 'Risk Committee',     cycle: 'monthly',   distribution: ['Risk Committee Members', 'CRO', 'CFO', 'COO'],                      sections: ['Risk Appetite Status', 'Stress Tests', 'Digital Twin Results', 'Regulatory Outlook', 'AI Risk'] },
  compliance_committee: { title: 'Compliance Committee Pack',   owner: 'Compliance',         cycle: 'quarterly', distribution: ['Compliance Committee', 'CCO', 'General Counsel', 'CEO'],             sections: ['Regulatory Obligations', 'Breach Register', 'Audit Findings', 'Remediation Status', 'Filings'] },
  regulatory_filing:    { title: 'Regulatory Filing Pack',      owner: 'Compliance',         cycle: 'monthly',   distribution: ['CCO', 'RBI Desk', 'IRDAI Desk', 'Company Secretary'],                sections: ['RBI Returns', 'IRDAI Forms', 'AML STR', 'Basel Capital', 'IFRS 9 Staging'] },
};

const APPROVAL_DIST: ApprovalStatus[] = ['approved', 'approved', 'distributed', 'under_review', 'draft'];

export function buildBoardPackLibrary(tenant: string, asOf: Date): BoardPack[] {
  const rng = mulberry32(fnv1a(`${tenant}:packs:${dayKey(asOf)}`));
  return PACK_TYPES.map((type, i) => {
    const meta = PACK_METADATA[type];
    const status = APPROVAL_DIST[i % APPROVAL_DIST.length];
    const daysAgo = Math.floor(2 + rng() * 28);
    const last_generated = addDays(asOf, -daysAgo);
    const cycleMap: Record<ScheduleFrequency, number> = { daily: 1, weekly: 7, monthly: 30, quarterly: 90, annual: 365 };
    const next_due = addDays(asOf, cycleMap[meta.cycle] - daysAgo);
    const isApproved = status === 'approved' || status === 'distributed';

    return {
      pack_id: `PACK-${type.toUpperCase().slice(0, 4)}-${String(i + 1).padStart(2, '0')}`,
      pack_type: type,
      title: meta.title,
      owner: meta.owner,
      version: `v${Math.floor(2 + rng() * 8)}.${Math.floor(rng() * 10)}.${Math.floor(rng() * 3)}`,
      approval_status: status,
      last_generated,
      next_due,
      review_cycle: meta.cycle,
      distribution_list: meta.distribution,
      pages_count: Math.floor(8 + rng() * 42),
      size_kb: Math.floor(280 + rng() * 2720),
      sections: meta.sections,
      approved_by: isApproved ? pick(['MD & CEO', 'Board Chairman', 'CRO', 'Company Secretary', 'Audit Committee Chair'], rng) : null,
      signed_off_at: isApproved ? addDays(asOf, -Math.floor(rng() * daysAgo)) : null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — Executive KPIs
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecKpiItem {
  kpi: string;
  value: string;
  unit: string;
  trend: TrendDirection;
  change: string;
  threshold_status: 'within' | 'watch' | 'breach';
  benchmark: string;
  period: string;
}

export interface ExecutiveKpis {
  banking: ExecKpiItem[];
  insurance: ExecKpiItem[];
  enterprise: ExecKpiItem[];
  generated_at: string;
}

export function buildExecutiveKpis(tenant: string, asOf: Date): ExecutiveKpis {
  const rng = mulberry32(fnv1a(`${tenant}:exec-kpis:${dayKey(asOf)}`));

  const bk = (kpi: string, val: string, unit: string, trend: TrendDirection, change: string, status: 'within' | 'watch' | 'breach', bench: string): ExecKpiItem =>
    ({ kpi, value: val, unit, trend, change, threshold_status: status, benchmark: bench, period: 'Q' + Math.ceil((asOf.getMonth() + 1) / 3) + ' FY' + asOf.getFullYear().toString().slice(-2) });

  const npa = r2(2.8 + rng() * 2.2);
  const sma = r2(4.5 + rng() * 3.5);
  const delinq = r2(3.2 + rng() * 2.8);
  const recovery = r2(58 + rng() * 24);
  const claims = r2(68 + rng() * 18);
  const persist = r2(78 + rng() * 12);
  const solvency = r2(155 + rng() * 45);
  const riskScore = Math.floor(62 + rng() * 25);
  const compScore = Math.floor(74 + rng() * 22);
  const aiHealth = Math.floor(78 + rng() * 18);
  const dqScore = Math.floor(82 + rng() * 14);

  return {
    banking: [
      bk('Gross NPA Ratio', String(npa), '%', npa > 4 ? 'deteriorating' : npa < 3 ? 'improving' : 'stable', `${npa - 3.2 > 0 ? '+' + r1(npa - 3.2) : r1(npa - 3.2)}pp QoQ`, npa > 5 ? 'breach' : npa > 4 ? 'watch' : 'within', 'Industry: 3.8%'),
      bk('SMA Distribution', String(sma), '% of book', sma > 6 ? 'deteriorating' : 'stable', `${sma - 5.2 > 0 ? '+' + r1(sma - 5.2) : r1(sma - 5.2)}pp`, sma > 7 ? 'breach' : sma > 5.5 ? 'watch' : 'within', 'Peer: 5.5%'),
      bk('Delinquency Rate', String(delinq), '%', 'stable', `${r1(delinq - 3.5)}pp`, delinq > 5 ? 'watch' : 'within', 'Internal: 4.0%'),
      bk('Portfolio Risk Score', String(Math.floor(55 + rng() * 30)), '/100', 'stable', '+2pts', 'within', 'Target: 65'),
      bk('Recovery Rate', String(recovery), '%', recovery > 65 ? 'improving' : 'stable', `+${r1(rng() * 3)}pp`, 'within', 'Peer: 62%'),
      bk('Fraud Exposure', String(r2(28 + rng() * 22)), 'Cr', 'stable', '-₹2.4 Cr MoM', 'within', 'Budget: ₹55 Cr'),
    ],
    insurance: [
      bk('Claims Ratio', String(claims), '%', claims > 80 ? 'deteriorating' : 'stable', `${r1(claims - 72)}pp`, claims > 85 ? 'breach' : claims > 78 ? 'watch' : 'within', 'IRDAI Norm: 80%'),
      bk('Fraud Rate', String(r2(1.8 + rng() * 1.4)), '%', 'stable', '-0.2pp', 'within', 'Industry: 2.5%'),
      bk('Persistency (13M)', String(persist), '%', persist < 80 ? 'deteriorating' : 'stable', `${r1(persist - 82)}pp`, persist < 75 ? 'breach' : persist < 80 ? 'watch' : 'within', 'Target: 82%'),
      bk('Solvency Ratio', String(solvency), '%', solvency < 160 ? 'deteriorating' : 'improving', `${r1(solvency - 165)}pp`, solvency < 150 ? 'breach' : solvency < 160 ? 'watch' : 'within', 'IRDAI Min: 150%'),
      bk('Loss Ratio', String(r2(55 + rng() * 18)), '%', 'stable', '-1.2pp', 'within', 'Target: <75%'),
      bk('Underwriting Quality', String(Math.floor(72 + rng() * 22)), '/100', 'improving', '+3pts', 'within', 'Target: 75'),
    ],
    enterprise: [
      bk('Enterprise Risk Score', String(riskScore), '/100', riskScore < 65 ? 'deteriorating' : 'stable', '+2pts', riskScore < 55 ? 'breach' : riskScore < 65 ? 'watch' : 'within', 'Target: 72'),
      bk('Compliance Score', String(compScore), '/100', 'stable', '+1pt', compScore < 70 ? 'watch' : 'within', 'Target: 80'),
      bk('AI Health Score', String(aiHealth), '/100', aiHealth > 82 ? 'improving' : 'stable', '+3pts', aiHealth < 70 ? 'watch' : 'within', 'Target: 85'),
      bk('Data Quality Score', String(dqScore), '/100', 'improving', '+2pts', dqScore < 75 ? 'watch' : 'within', 'Target: 88'),
    ],
    generated_at: asOf.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — Board Dashboards
// ─────────────────────────────────────────────────────────────────────────────

export interface BoardDashboard {
  dashboard_id: string;
  title: string;
  category: string;
  description: string;
  kpi_count: number;
  alert_count: number;
  health_score: number;
  last_updated: string;
  viewers: string[];
  status: 'live' | 'scheduled' | 'maintenance';
}

const DASHBOARD_DEFS = [
  { id: 'STRAT-RISK', title: 'Strategic Risk Dashboard',     cat: 'Risk',       desc: 'Board-level strategic risk overview — portfolio quality, emerging risks, stress scenarios',  viewers: ['Board', 'CRO', 'CEO'] },
  { id: 'ENT-RISK',   title: 'Enterprise Risk Dashboard',    cat: 'Risk',       desc: 'Enterprise-wide risk aggregation — credit, market, operational, liquidity, strategic',       viewers: ['CRO', 'CFO', 'COO'] },
  { id: 'COMPLIANCE', title: 'Compliance Dashboard',         cat: 'Compliance', desc: 'Regulatory obligations, breach register, remediation status, upcoming filings',               viewers: ['CCO', 'Audit Committee', 'CEO'] },
  { id: 'OPS',        title: 'Operational Dashboard',        cat: 'Operations', desc: 'Operational KPIs — process efficiency, error rates, SLA compliance, headcount utilisation',   viewers: ['COO', 'Operations Heads'] },
  { id: 'AI-GOV',     title: 'AI Governance Dashboard',      cat: 'AI',         desc: 'Model health, drift monitoring, explainability scores, prediction accuracy tracking',         viewers: ['CDO', 'CRO', 'AI Committee'] },
  { id: 'VENDOR-RISK',title: 'Vendor Risk Dashboard',        cat: 'Risk',       desc: 'Third-party risk — vendor concentration, SLA breaches, contract renewal calendar',           viewers: ['COO', 'Procurement Head', 'CRO'] },
];

export function buildBoardDashboards(tenant: string, asOf: Date): BoardDashboard[] {
  const rng = mulberry32(fnv1a(`${tenant}:dashboards:${dayKey(asOf)}`));
  return DASHBOARD_DEFS.map((def, i) => ({
    dashboard_id: def.id,
    title: def.title,
    category: def.cat,
    description: def.desc,
    kpi_count: Math.floor(8 + rng() * 22),
    alert_count: Math.floor(rng() * 8),
    health_score: Math.floor(78 + rng() * 20),
    last_updated: new Date(asOf.getTime() - Math.floor(rng() * 6) * 3600000).toISOString(),
    viewers: def.viewers,
    status: i < 4 ? 'live' : rng() > 0.5 ? 'live' : 'scheduled',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — Regulatory Reporting
// ─────────────────────────────────────────────────────────────────────────────

export interface RegulatoryReport {
  report_id: string;
  framework: RegulatoryFramework;
  report_name: string;
  domain: 'banking' | 'insurance';
  frequency: ScheduleFrequency;
  submission_status: 'filed' | 'due_soon' | 'overdue' | 'in_preparation';
  due_date: string;
  last_filed: string;
  approval_status: 'approved' | 'pending' | 'requires_revision';
  filing_authority: string;
  penalty_risk: 'none' | 'low' | 'medium' | 'high';
}

const REGULATORY_DEFS: Array<{ framework: RegulatoryFramework; name: string; domain: 'banking' | 'insurance'; freq: ScheduleFrequency; auth: string }> = [
  { framework: 'RBI',    name: 'RBI Basic Statistical Return (BSR)',     domain: 'banking',   freq: 'monthly',   auth: 'RBI Department of Regulation' },
  { framework: 'RBI',    name: 'RBI Offsite Surveillance Return (OSS)',  domain: 'banking',   freq: 'quarterly', auth: 'RBI Department of Supervision' },
  { framework: 'RBI',    name: 'RBI Large Exposure Framework Report',    domain: 'banking',   freq: 'monthly',   auth: 'RBI Credit Regulation Department' },
  { framework: 'Basel',  name: 'Basel III Capital Adequacy Report',      domain: 'banking',   freq: 'quarterly', auth: 'RBI - Basel Coordination' },
  { framework: 'Basel',  name: 'Liquidity Coverage Ratio (LCR) Return', domain: 'banking',   freq: 'monthly',   auth: 'RBI Treasury Department' },
  { framework: 'PMLA',   name: 'PMLA Suspicious Transaction Report',     domain: 'banking',   freq: 'monthly',   auth: 'FIU-IND' },
  { framework: 'RBI',    name: 'KYC Compliance Certificate',             domain: 'banking',   freq: 'annual',    auth: 'RBI Central Office' },
  { framework: 'IRDAI',  name: 'IRDAI Annual Returns (Form KI)',         domain: 'insurance', freq: 'annual',    auth: 'IRDAI Actuarial Department' },
  { framework: 'IRDAI',  name: 'IRDAI Solvency Margin Report',          domain: 'insurance', freq: 'quarterly', auth: 'IRDAI Finance Department' },
  { framework: 'IRDAI',  name: 'IRDAI Claims Settlement Report',        domain: 'insurance', freq: 'monthly',   auth: 'IRDAI Consumer Affairs' },
  { framework: 'IRDAI',  name: 'IRDAI Fraud Monitoring Report',         domain: 'insurance', freq: 'quarterly', auth: 'IRDAI Fraud Monitoring Cell' },
  { framework: 'IFRS9',  name: 'IFRS 9 Stage Classification Report',    domain: 'banking',   freq: 'quarterly', auth: 'RBI Accounting Department' },
];

const SUB_STATUSES: Array<RegulatoryReport['submission_status']> = ['filed', 'filed', 'due_soon', 'in_preparation', 'filed', 'filed'];
const PENALTY_RISKS: Array<RegulatoryReport['penalty_risk']> = ['none', 'none', 'low', 'medium', 'none', 'none'];

export function buildRegulatoryReports(tenant: string, asOf: Date): RegulatoryReport[] {
  const rng = mulberry32(fnv1a(`${tenant}:reg-reports:${dayKey(asOf)}`));
  return REGULATORY_DEFS.map((def, i) => {
    const status = SUB_STATUSES[i % SUB_STATUSES.length];
    const daysToNext = status === 'due_soon' ? Math.floor(1 + rng() * 7) : Math.floor(8 + rng() * 22);
    const daysAgo = Math.floor(5 + rng() * 25);
    return {
      report_id: `REG-${def.framework}-${String(i + 1).padStart(3, '0')}`,
      framework: def.framework,
      report_name: def.name,
      domain: def.domain,
      frequency: def.freq,
      submission_status: status,
      due_date: addDays(asOf, daysToNext),
      last_filed: addDays(asOf, -daysAgo),
      approval_status: status === 'filed' ? 'approved' : 'pending',
      filing_authority: def.auth,
      penalty_risk: PENALTY_RISKS[i % PENALTY_RISKS.length],
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 5 — AI Governance Reports
// ─────────────────────────────────────────────────────────────────────────────

export interface AiGovernanceReport {
  report_id: string;
  report_type: 'model_performance' | 'drift' | 'explainability' | 'prediction_accuracy' | 'ai_risk';
  title: string;
  generated_at: string;
  period_label: string;
  overall_status: 'healthy' | 'watch' | 'action_required';
  summary: string;
  key_metrics: Array<{ metric: string; value: string; status: 'good' | 'fair' | 'poor' }>;
  recommendations: string[];
  next_review: string;
}

const AI_REPORT_DEFS: Array<{ type: AiGovernanceReport['report_type']; title: string }> = [
  { type: 'model_performance', title: 'Model Performance Summary Report' },
  { type: 'drift',             title: 'Model Drift & Data Distribution Report' },
  { type: 'explainability',   title: 'AI Explainability & Transparency Report' },
  { type: 'prediction_accuracy', title: 'Prediction Accuracy & Validation Report' },
  { type: 'ai_risk',          title: 'AI Risk & Ethics Assessment Report' },
];

const AI_SUMMARIES: Record<string, string> = {
  model_performance: 'Portfolio default model (PD-XGB-v3.2) performing at AUC 0.847 — within governance thresholds. Fraud model showing 3.2% accuracy improvement QoQ. Two models flagged for revalidation.',
  drift: 'PSI for PD model: 0.08 (acceptable). Input feature drift detected in txn_volume_zscore_90d for MSME segment. Monitoring alert triggered; retraining scheduled.',
  explainability: 'SHAP explainability coverage: 94% of production decisions. Average transparency score: 82/100. Three models require enhanced explanation documentation per board policy.',
  prediction_accuracy: 'Champion model hit rate: 91.3% on 30-day NPA prediction. Insurance fraud model F1: 0.87. Collections model precision: 78% — below 80% target; remediation in progress.',
  ai_risk: 'No critical AI risks identified this quarter. Three medium risks: model concentration (2 vendors), data bias in microfinance segment, governance gap in model approval turnaround time.',
};

export function buildAiGovernanceReports(tenant: string, asOf: Date): AiGovernanceReport[] {
  const rng = mulberry32(fnv1a(`${tenant}:ai-reports:${dayKey(asOf)}`));
  return AI_REPORT_DEFS.map((def, i) => ({
    report_id: `AI-RPT-${String(i + 1).padStart(3, '0')}`,
    report_type: def.type,
    title: def.title,
    generated_at: new Date(asOf.getTime() - Math.floor(rng() * 3) * 86400000).toISOString(),
    period_label: `Q${Math.ceil((asOf.getMonth() + 1) / 3)} FY${asOf.getFullYear().toString().slice(-2)}`,
    overall_status: i === 3 ? 'watch' : 'healthy',
    summary: AI_SUMMARIES[def.type],
    key_metrics: [
      { metric: 'Models Reviewed', value: String(Math.floor(6 + rng() * 8)), status: 'good' },
      { metric: 'Compliance Rate', value: `${Math.floor(88 + rng() * 11)}%`, status: 'good' },
      { metric: 'Drift Alerts', value: String(Math.floor(rng() * 4)), status: rng() > 0.6 ? 'fair' : 'good' },
      { metric: 'Retraining Backlog', value: String(Math.floor(rng() * 3)), status: 'good' },
    ],
    recommendations: [
      pick(['Accelerate model revalidation for flagged models', 'Enhance SHAP documentation for board submissions', 'Implement automated drift alerting pipeline', 'Conduct quarterly model ethics review'], rng),
      pick(['Update model governance policy to include LLM guidelines', 'Strengthen challenger model process for fraud detection', 'Add model performance KPIs to board pack', 'Schedule independent model audit by Q4'], rng),
    ],
    next_review: addDays(asOf, Math.floor(25 + rng() * 65)),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 6 — Compliance Reports
// ─────────────────────────────────────────────────────────────────────────────

export interface ComplianceReportSummary {
  open_obligations: number;
  breaches_active: number;
  breaches_resolved_30d: number;
  escalations_pending: number;
  remediation_plans_active: number;
  audit_findings_open: number;
  audit_findings_closed_30d: number;
  compliance_score: number;
  top_breaches: Array<{ obligation: string; severity: string; days_open: number; owner: string }>;
  upcoming_obligations: Array<{ obligation: string; due_date: string; risk: string }>;
  remediation_plans: Array<{ plan_id: string; description: string; target_date: string; status: 'on_track' | 'delayed' | 'completed' }>;
}

export function buildComplianceSummary(tenant: string, asOf: Date): ComplianceReportSummary {
  const rng = mulberry32(fnv1a(`${tenant}:compliance:${dayKey(asOf)}`));
  return {
    open_obligations: Math.floor(85 + rng() * 55),
    breaches_active: Math.floor(2 + rng() * 8),
    breaches_resolved_30d: Math.floor(1 + rng() * 6),
    escalations_pending: Math.floor(rng() * 5),
    remediation_plans_active: Math.floor(3 + rng() * 9),
    audit_findings_open: Math.floor(4 + rng() * 16),
    audit_findings_closed_30d: Math.floor(2 + rng() * 8),
    compliance_score: Math.floor(74 + rng() * 22),
    top_breaches: [
      { obligation: 'RBI KYC Annual Certification', severity: 'High', days_open: Math.floor(5 + rng() * 30), owner: 'CCO' },
      { obligation: 'IRDAI Agent Training Compliance', severity: 'Medium', days_open: Math.floor(3 + rng() * 20), owner: 'Distribution Head' },
      { obligation: 'Basel III LCR Daily Reporting', severity: 'Low', days_open: Math.floor(1 + rng() * 10), owner: 'Treasury' },
    ],
    upcoming_obligations: [
      { obligation: 'RBI Annual BSR Return', due_date: addDays(asOf, Math.floor(3 + rng() * 12)), risk: 'Medium' },
      { obligation: 'IRDAI Solvency Quarterly', due_date: addDays(asOf, Math.floor(8 + rng() * 22)), risk: 'Low' },
      { obligation: 'Basel ICAAP Board Sign-off', due_date: addDays(asOf, Math.floor(15 + rng() * 45)), risk: 'High' },
    ],
    remediation_plans: [
      { plan_id: 'RMP-001', description: 'Enhanced KYC data completeness drive for legacy accounts', target_date: addDays(asOf, 45), status: 'on_track' },
      { plan_id: 'RMP-002', description: 'AML system upgrade for improved STR detection', target_date: addDays(asOf, 90), status: 'delayed' },
      { plan_id: 'RMP-003', description: 'IRDAI agent commission reconciliation automation', target_date: addDays(asOf, 30), status: 'on_track' },
      { plan_id: 'RMP-004', description: 'Board cybersecurity awareness training completion', target_date: addDays(asOf, -10), status: 'completed' },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 7 — Predictive Reporting
// ─────────────────────────────────────────────────────────────────────────────

export interface PredictiveForecast {
  horizon: ForecastHorizon;
  domain: 'banking' | 'insurance' | 'enterprise';
  generated_at: string;
  confidence_score: number;
  banking_forecasts?: Array<{ metric: string; current: number; projected: number; change_pp: number; risk_flag: boolean }>;
  insurance_forecasts?: Array<{ metric: string; current: number; projected: number; change_pp: number; risk_flag: boolean }>;
  enterprise_forecasts?: Array<{ metric: string; current: number; projected: number; change_pp: number; risk_flag: boolean }>;
  key_risks: string[];
  scenario_label: string;
}

const FORECAST_SCENARIOS = ['Base Case', 'Mild Stress', 'Adverse', 'Severely Adverse'];

export function buildPredictiveForecasts(tenant: string, asOf: Date): PredictiveForecast[] {
  const results: PredictiveForecast[] = [];
  const domains: Array<'banking' | 'insurance' | 'enterprise'> = ['banking', 'insurance', 'enterprise'];

  FORECAST_HORIZONS.forEach(horizon => {
    domains.forEach(domain => {
      const rng = mulberry32(fnv1a(`${tenant}:forecast:${horizon}:${domain}:${dayKey(asOf)}`));
      const horizonMultiplier = { '30d': 1, '60d': 1.8, '90d': 2.5, '180d': 4.2 }[horizon];
      const conf = clamp(0.88 - (horizonMultiplier - 1) * 0.04, 0.62, 0.94);

      const mkForecast = (metric: string, current: number, stress: number, isAdverse = false) => {
        const change = r2(stress * horizonMultiplier * (0.5 + rng() * 0.5));
        return { metric, current, projected: r2(current + change), change_pp: change, risk_flag: isAdverse && change > current * 0.08 };
      };

      results.push({
        horizon,
        domain,
        generated_at: asOf.toISOString(),
        confidence_score: r2(conf),
        banking_forecasts: domain === 'banking' ? [
          mkForecast('Gross NPA Ratio (%)', 3.2, 0.4 * (rng() > 0.5 ? 1 : -0.2), true),
          mkForecast('SMA Ratio (%)', 5.1, 0.5 * (rng() > 0.4 ? 1 : -0.3), true),
          mkForecast('Recovery Rate (%)', 64, -2 * (0.5 + rng() * 0.5)),
          mkForecast('ECL Provision (₹ Cr)', 4850, 180 * (0.5 + rng() * 0.5)),
        ] : undefined,
        insurance_forecasts: domain === 'insurance' ? [
          mkForecast('Claims Ratio (%)', 71, 1.8 * (rng() > 0.4 ? 1 : -0.3), true),
          mkForecast('Persistency 13M (%)', 83, -1.5 * (0.5 + rng() * 0.5), true),
          mkForecast('Solvency Ratio (%)', 178, -8 * (0.5 + rng() * 0.5)),
          mkForecast('Fraud Rate (%)', 2.1, 0.3 * (rng() > 0.5 ? 1 : -0.2)),
        ] : undefined,
        enterprise_forecasts: domain === 'enterprise' ? [
          mkForecast('Risk Score (/100)', 72, -3 * (0.5 + rng() * 0.5)),
          mkForecast('Compliance Score (/100)', 81, -2 * (0.5 + rng() * 0.5)),
          mkForecast('AI Health (/100)', 84, 2 * (0.5 + rng() * 0.5)),
          mkForecast('Data Quality (/100)', 86, 1.5 * (0.5 + rng() * 0.5)),
        ] : undefined,
        key_risks: [
          pick(['MSME sector stress escalation', 'Bureau score compression', 'Claims inflation persistence', 'Regulatory tightening risk', 'AI model drift acceleration', 'Vendor concentration risk'], rng),
          pick(['Interest rate reversal impact', 'Persistency decline acceleration', 'Fraud syndicate expansion', 'Data quality degradation risk', 'AML false-positive spike', 'Reinsurance cost pressure'], rng),
        ],
        scenario_label: pick(FORECAST_SCENARIOS, rng),
      });
    });
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 8 — Digital Twin Reports
// ─────────────────────────────────────────────────────────────────────────────

export interface DigitalTwinReport {
  report_id: string;
  report_type: 'scenario_comparison' | 'stress_test' | 'impact_analysis' | 'board_simulation';
  title: string;
  generated_at: string;
  scenarios_included: number;
  worst_case_npa_impact_pp: number;
  worst_case_ecl_increase_cr: number;
  recommended_action: string;
  board_recommendation: string;
  confidence: number;
  stress_level: 'mild' | 'moderate' | 'severe';
}

const DT_REPORT_DEFS = [
  { type: 'scenario_comparison' as const, title: 'RBI Tri-Annual Stress Scenario Comparison',     stress: 'moderate' as const },
  { type: 'stress_test' as const,         title: 'IRDAI CAT Catastrophe Stress Test Report',     stress: 'severe' as const },
  { type: 'impact_analysis' as const,     title: 'Rate Hike +150bps Portfolio Impact Analysis',  stress: 'moderate' as const },
  { type: 'board_simulation' as const,    title: 'Board Quarterly Portfolio Simulation Summary', stress: 'mild' as const },
];

export function buildDigitalTwinReports(tenant: string, asOf: Date): DigitalTwinReport[] {
  const rng = mulberry32(fnv1a(`${tenant}:dt-reports:${dayKey(asOf)}`));
  return DT_REPORT_DEFS.map((def, i) => ({
    report_id: `DT-RPT-${String(i + 1).padStart(3, '0')}`,
    report_type: def.type,
    title: def.title,
    generated_at: new Date(asOf.getTime() - Math.floor(rng() * 7) * 86400000).toISOString(),
    scenarios_included: Math.floor(2 + rng() * 6),
    worst_case_npa_impact_pp: r2(0.5 + rng() * 2.5),
    worst_case_ecl_increase_cr: Math.floor(150 + rng() * 850),
    recommended_action: pick([
      'Maintain current provision levels; no capital action required at base case',
      'Pre-position additional ECL buffer of ₹120–180 Cr as risk mitigation',
      'Initiate sector-specific credit tightening for MSME exposure above ₹50 Cr',
      'Review reinsurance programme adequacy for catastrophe concentration',
    ], rng),
    board_recommendation: pick([
      'Board to note risk within appetite. Management to monitor monthly',
      'Board to approve contingency provision plan as stress buffer',
      'Board to endorse sector exit strategy for elevated-risk concentrations',
      'Risk Committee to review and approve revised stress scenario assumptions',
    ], rng),
    confidence: r2(0.82 + rng() * 0.14),
    stress_level: def.stress,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 9 — Autonomous AI Reports
// ─────────────────────────────────────────────────────────────────────────────

export interface AutonomousAiReport {
  period_label: string;
  total_agent_executions: number;
  automation_rate_pct: number;
  human_override_count: number;
  override_rate_pct: number;
  productivity_gain_hours: number;
  cost_savings_cr: number;
  avg_decision_confidence: number;
  agent_performance: Array<{ agent: string; executions: number; success_rate: number; escalations: number; avg_ms: number }>;
  top_automated_actions: Array<{ action: string; count: number; savings_hours: number }>;
  escalation_reasons: Array<{ reason: string; count: number; percentage: number }>;
}

const AGENT_NAMES = ['Credit Risk Agent', 'Fraud Detection Agent', 'Collections Agent', 'Portfolio Risk Agent', 'Claims Agent', 'Insurance Fraud Agent', 'Policy Retention Agent', 'Compliance Agent', 'Investigation Agent', 'Executive Briefing Agent'];

export function buildAutonomousAiReport(tenant: string, asOf: Date): AutonomousAiReport {
  const rng = mulberry32(fnv1a(`${tenant}:ai-auto:${dayKey(asOf)}`));
  const totalExec = Math.floor(48000 + rng() * 32000);
  const overrides = Math.floor(totalExec * 0.04 * (0.5 + rng() * 0.5));
  const automationRate = r2(((totalExec - overrides) / totalExec) * 100);

  return {
    period_label: `Month of ${asOf.toLocaleString('en-IN', { month: 'long' })} ${asOf.getFullYear()}`,
    total_agent_executions: totalExec,
    automation_rate_pct: automationRate,
    human_override_count: overrides,
    override_rate_pct: r2(100 - automationRate),
    productivity_gain_hours: Math.floor(1800 + rng() * 2200),
    cost_savings_cr: r2(8.5 + rng() * 11.5),
    avg_decision_confidence: r2(0.84 + rng() * 0.12),
    agent_performance: AGENT_NAMES.slice(0, 8).map(agent => {
      const execs = Math.floor(2000 + rng() * 8000);
      return {
        agent,
        executions: execs,
        success_rate: r2(0.88 + rng() * 0.11),
        escalations: Math.floor(rng() * 40),
        avg_ms: Math.floor(400 + rng() * 1200),
      };
    }),
    top_automated_actions: [
      { action: 'Credit risk alert triage + routing', count: Math.floor(8000 + rng() * 4000), savings_hours: Math.floor(400 + rng() * 200) },
      { action: 'Fraud signal investigation initiation', count: Math.floor(3000 + rng() * 2000), savings_hours: Math.floor(350 + rng() * 150) },
      { action: 'Collections priority ranking + assignment', count: Math.floor(5000 + rng() * 3000), savings_hours: Math.floor(280 + rng() * 120) },
      { action: 'Compliance obligation status update', count: Math.floor(2000 + rng() * 1500), savings_hours: Math.floor(180 + rng() * 80) },
    ],
    escalation_reasons: [
      { reason: 'Amount exceeds delegated authority', count: Math.floor(overrides * 0.4), percentage: 40 },
      { reason: 'Low model confidence (<70%)', count: Math.floor(overrides * 0.28), percentage: 28 },
      { reason: 'Policy exception required', count: Math.floor(overrides * 0.18), percentage: 18 },
      { reason: 'Conflicting agent recommendations', count: Math.floor(overrides * 0.14), percentage: 14 },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 10 — Board Pack Generator
// ─────────────────────────────────────────────────────────────────────────────

export interface PackGenerationRequest {
  request_id: string;
  pack_type: PackType;
  formats: ReportFormat[];
  requested_by: string;
  requested_at: string;
  status: 'queued' | 'generating' | 'ready' | 'failed';
  download_urls: Partial<Record<ReportFormat, string>>;
  size_kb: Partial<Record<ReportFormat, number>>;
  generation_time_ms: number;
  version: string;
}

export function buildRecentGenerations(tenant: string, asOf: Date): PackGenerationRequest[] {
  const rng = mulberry32(fnv1a(`${tenant}:gen-requests:${dayKey(asOf)}`));
  const requestors = ['CRO Office', 'Company Secretary', 'Risk Analytics', 'Compliance', 'Board Secretariat'];
  return PACK_TYPES.slice(0, 6).map((type, i) => ({
    request_id: `GEN-${String(i + 1).padStart(3, '0')}-${dayKey(asOf).replace(/-/g, '')}`,
    pack_type: type,
    formats: ['pdf', 'excel'] as ReportFormat[],
    requested_by: pick(requestors, rng),
    requested_at: new Date(asOf.getTime() - Math.floor(rng() * 48) * 3600000).toISOString(),
    status: i < 4 ? 'ready' : i === 4 ? 'generating' : 'queued',
    download_urls: i < 4 ? { pdf: `/downloads/${type}-pack.pdf`, excel: `/downloads/${type}-pack.xlsx` } : {},
    size_kb: i < 4 ? { pdf: Math.floor(280 + rng() * 1720), excel: Math.floor(120 + rng() * 680) } : {},
    generation_time_ms: Math.floor(4500 + rng() * 8500),
    version: `v${Math.floor(2 + rng() * 5)}.${Math.floor(rng() * 9)}.0`,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 11 — Report Scheduler
// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduledReport {
  schedule_id: string;
  report_name: string;
  pack_type: PackType;
  frequency: ScheduleFrequency;
  next_run: string;
  last_run: string;
  last_run_status: 'success' | 'failed' | 'skipped';
  success_rate_pct: number;
  failure_count_30d: number;
  recipients_count: number;
  is_active: boolean;
}

export function buildReportSchedules(tenant: string, asOf: Date): ScheduledReport[] {
  const rng = mulberry32(fnv1a(`${tenant}:schedules:${dayKey(asOf)}`));
  const freqMap: Record<ScheduleFrequency, number> = { daily: 1, weekly: 7, monthly: 30, quarterly: 90, annual: 365 };
  return PACK_TYPES.map((type, i) => {
    const freq = PACK_METADATA[type].cycle;
    const daysAgo = Math.floor(1 + rng() * (freqMap[freq] - 1));
    return {
      schedule_id: `SCH-${String(i + 1).padStart(3, '0')}`,
      report_name: PACK_METADATA[type].title,
      pack_type: type,
      frequency: freq,
      next_run: addDays(asOf, freqMap[freq] - daysAgo),
      last_run: addDays(asOf, -daysAgo),
      last_run_status: rng() > 0.1 ? 'success' : 'failed',
      success_rate_pct: r2(95 + rng() * 4.8),
      failure_count_30d: Math.floor(rng() * 2),
      recipients_count: PACK_METADATA[type].distribution.length,
      is_active: i < 7,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 12 — Executive Intelligence Summary
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecutiveIntelligenceSummary {
  generated_at: string;
  confidence_score: number;
  top_risks: Array<{ rank: number; title: string; domain: string; severity: 'critical' | 'high' | 'medium'; summary: string }>;
  top_opportunities: string[];
  emerging_threats: string[];
  compliance_concerns: string[];
  forecast_highlights: string[];
  recommended_actions: Array<{ action: string; priority: 'immediate' | 'this_week' | 'this_month'; owner: string }>;
  board_health_score: number;
  executive_narrative: string;
}

export function buildExecutiveIntelligenceSummary(tenant: string, asOf: Date): ExecutiveIntelligenceSummary {
  const rng = mulberry32(fnv1a(`${tenant}:exec-intel:${dayKey(asOf)}`));
  return {
    generated_at: asOf.toISOString(),
    confidence_score: r2(0.85 + rng() * 0.12),
    top_risks: [
      { rank: 1, title: 'MSME Sector Stress Intensification', domain: 'Banking', severity: 'high', summary: 'DPD migration in MSME book accelerating. Stage 2 book up 12% QoQ. Pre-NPA intervention required for 340 accounts.' },
      { rank: 2, title: 'Claims Inflation Persistence', domain: 'Insurance', severity: 'high', summary: 'Health claims frequency +18% YoY above model assumptions. Combined ratio approaching 98%. Pricing review needed.' },
      { rank: 3, title: 'AI Model Concentration Risk', domain: 'Enterprise', severity: 'medium', summary: '62% of credit decisions rely on one PD model vendor. Concentration limit of 50% exceeded. Challenger model deployment required.' },
    ],
    top_opportunities: [
      'Collections automation ROI: ₹12–18 Cr annual savings from AI-assisted prioritisation',
      'Cross-sell to low-risk customers: 28,000 eligible accounts identified with bureau score >750',
      'Digital insurance renewals: 15,000 at-risk policies with proven retention campaign effectiveness',
    ],
    emerging_threats: [
      'PMLA amendment: Enhanced beneficial ownership disclosure norms effective next quarter — IT system changes required',
      'RBI cybersecurity framework revision: Penetration testing and SOC upgrade compliance window: 6 months',
      'IRDAI health portability regulations: 45-day migration window impacts retention projections',
    ],
    compliance_concerns: [
      'KYC legacy account refresh overdue for 8,420 accounts — potential RBI notice risk',
      'Agent training compliance at 78% vs 90% IRDAI requirement — deadline: 45 days',
      'Basel III LCR daily return missed on 2 occasions this quarter — escalation required',
    ],
    forecast_highlights: [
      '30-day NPA outlook: Stable at 3.2% ± 0.2pp under base case, rising to 4.1% under RBI adverse scenario',
      '90-day solvency forecast: 178% → 162% under catastrophe stress scenario (minimum: 150% IRDAI floor)',
      '180-day enterprise risk score: 72 → 68 (mild deterioration driven by regulatory complexity increase)',
    ],
    recommended_actions: [
      { action: 'Initiate pre-NPA restructuring programme for 340 identified MSME accounts', priority: 'immediate', owner: 'CRO + Collections Head' },
      { action: 'Commission independent review of claims pricing model assumptions', priority: 'this_week', owner: 'Chief Actuary' },
      { action: 'Complete KYC refresh for 8,420 overdue accounts', priority: 'this_month', owner: 'CCO + Branch Banking Head' },
      { action: 'Present challenger PD model roadmap to Board Risk Committee', priority: 'this_month', owner: 'CDO + CRO' },
    ],
    board_health_score: Math.floor(74 + rng() * 18),
    executive_narrative: `The platform's AI intelligence layer has processed ${(48000 + Math.floor(rng() * 32000)).toLocaleString('en-IN')} decisions this month with ${r2(93 + rng() * 5)}% accuracy. Three priority areas require Board attention: MSME portfolio stress, insurance pricing adequacy, and AI governance concentration risk. The digital twin stress tests confirm that the portfolio is resilient under base and mild stress scenarios, but requires proactive intervention under RBI adverse scenarios to remain within risk appetite. Overall board health score: ${Math.floor(74 + rng() * 18)}/100 — within governance tolerance.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite dashboard KPIs
// ─────────────────────────────────────────────────────────────────────────────

export interface BoardReportingKpis {
  total_packs: number;
  approved_packs: number;
  pending_approval: number;
  overdue_regulatory: number;
  scheduled_reports: number;
  compliance_score: number;
  board_health_score: number;
  reports_generated_30d: number;
  ai_report_confidence: number;
  next_board_meeting: string;
}

export function buildBoardReportingKpis(tenant: string, asOf: Date): BoardReportingKpis {
  const rng = mulberry32(fnv1a(`${tenant}:br-kpis:${dayKey(asOf)}`));
  const packs = buildBoardPackLibrary(tenant, asOf);
  const regReports = buildRegulatoryReports(tenant, asOf);
  const overdue = regReports.filter(r => r.submission_status === 'overdue').length;
  return {
    total_packs: packs.length,
    approved_packs: packs.filter(p => p.approval_status === 'approved' || p.approval_status === 'distributed').length,
    pending_approval: packs.filter(p => p.approval_status === 'under_review').length,
    overdue_regulatory: overdue,
    scheduled_reports: PACK_TYPES.length,
    compliance_score: Math.floor(74 + rng() * 22),
    board_health_score: Math.floor(74 + rng() * 18),
    reports_generated_30d: Math.floor(42 + rng() * 38),
    ai_report_confidence: r2(0.85 + rng() * 0.12),
    next_board_meeting: addDays(asOf, Math.floor(5 + rng() * 25)),
  };
}
