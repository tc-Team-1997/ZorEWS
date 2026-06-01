/**
 * Enterprise AI Agents Engine — Compliance + Investigation + Executive + Recovery + Governance.
 * Pure-function. Deterministic via FNV-1a + Mulberry32. Phase 18 overlay.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
function dayKey(d: Date): string { return d.toISOString().slice(0, 10); }
function round(v: number, dec = 0): number { return Math.round(v * Math.pow(10, dec)) / Math.pow(10, dec); }
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function pick<T>(arr: T[], rng: () => number): T { return arr[Math.floor(rng() * arr.length)]; }

function rng(tenant: string, tag: string, asOf: Date): () => number {
  return mulberry32(fnv1a(`${tenant}:${tag}:${dayKey(asOf)}`));
}
function isoOffset(base: Date, days: number): string {
  const d = new Date(base.getTime() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

// ─── 1. Compliance Agent ─────────────────────────────────────────────────────

export interface ComplianceAgentReport {
  generated_at: string;
  total_obligations_monitored: number;
  breached_count: number;
  at_risk_count: number;
  compliant_count: number;
  compliance_score: number;
  confidence_score: number;
  regulatory_frameworks: Array<{
    framework: string;
    status: 'compliant' | 'at_risk' | 'breach';
    obligations_count: number;
    gap_count: number;
    next_filing: string;
  }>;
  upcoming_deadlines: Array<{
    obligation: string;
    deadline: string;
    days_remaining: number;
    risk_level: string;
  }>;
  key_findings: string[];
  compliance_actions: string[];
}

const FRAMEWORKS = [
  'RBI Master Directions',
  'IRDAI Guidelines',
  'SEBI Circulars',
  'Companies Act 2013',
  'IBC 2016',
];
const FRAMEWORK_STATUSES: Array<'compliant' | 'at_risk' | 'breach'> = ['compliant', 'at_risk', 'breach'];
const OBLIGATION_NAMES = [
  'KYC Periodic Update Filing',
  'NPA Classification Report',
  'Capital Adequacy Return (CAR)',
  'AML Transaction Monitoring',
  'Credit Information Bureau Submission',
  'ALM Reporting',
  'Fraud Monitoring & Reporting',
  'Interest Rate Risk Disclosure',
  'Liquidity Coverage Ratio Filing',
  'Board Governance Certificate',
];
const RISK_LEVELS = ['critical', 'high', 'medium', 'low'];

const COMPLIANCE_FINDINGS = [
  'KYC refresh compliance at 84% — 16% of accounts require updated documentation.',
  'NPA provisioning gap detected in SME loan book; RBI threshold at risk.',
  'CAR buffer above minimum; Tier-1 capital adequacy holding firm at 13.2%.',
  'AML transaction screening flagged 23 suspicious patterns pending review.',
  'Credit bureau submission lag identified for Q2; rectification in progress.',
  'ALM report shows mild maturity mismatch in 1–3 year bucket.',
  'Fraud monitoring thresholds recalibrated; alert volume decreased 18%.',
  'Three IRDAI solvency filings pending sign-off by CFO.',
];
const COMPLIANCE_ACTIONS = [
  'Escalate KYC refresh programme to Branch Operations for immediate action.',
  'Schedule emergency provision review with Risk Committee by next fortnight.',
  'File capital adequacy attestation with RBI ahead of quarterly deadline.',
  'Assign AML flagged cases to Compliance Investigation team within 48 hours.',
  'Rectify credit bureau submission backlog via automated batch upload.',
  'Submit ALM correction note to Treasury and ALM desk for reconciliation.',
  'Deploy updated fraud rules to production after UAT sign-off.',
  'Obtain CFO sign-off on IRDAI solvency submissions by end of week.',
];

export function buildComplianceAgentReport(tenant: string, asOf: Date): ComplianceAgentReport {
  const r = rng(tenant, 'compliance', asOf);
  const total = Math.floor(clamp(r() * 60 + 85, 85, 145));
  const breached = Math.floor(r() * 8 + 2);
  const at_risk = Math.floor(r() * 18 + 5);
  const compliant = total - breached - at_risk;
  const compliance_score = round(clamp(r() * 19 + 72, 72, 91), 1);
  const confidence_score = round(clamp(r() * 10 + 82, 82, 92), 1);

  const frameworks = FRAMEWORKS.map((fw) => {
    const fr2 = mulberry32(fnv1a(`${tenant}:fw:${fw}:${dayKey(asOf)}`));
    const status = FRAMEWORK_STATUSES[Math.floor(fr2() * FRAMEWORK_STATUSES.length)];
    const obligations_count = Math.floor(fr2() * 25 + 10);
    const gap_count = status === 'compliant' ? 0 : Math.floor(fr2() * 6 + 1);
    const filing_days = Math.floor(fr2() * 90 + 5);
    return {
      framework: fw,
      status,
      obligations_count,
      gap_count,
      next_filing: isoOffset(asOf, filing_days),
    };
  });

  const upcoming_deadlines = OBLIGATION_NAMES.slice(0, 5).map((obligation, idx) => {
    const dr = mulberry32(fnv1a(`${tenant}:dl:${obligation}:${dayKey(asOf)}`));
    const days_remaining = Math.floor(dr() * 60 + 3 + idx * 5);
    return {
      obligation,
      deadline: isoOffset(asOf, days_remaining),
      days_remaining,
      risk_level: days_remaining < 10 ? 'critical' : days_remaining < 20 ? 'high' : days_remaining < 40 ? 'medium' : 'low',
    };
  });

  const findings_idx = Math.floor(r() * (COMPLIANCE_FINDINGS.length - 3));
  const actions_idx = Math.floor(r() * (COMPLIANCE_ACTIONS.length - 3));

  return {
    generated_at: asOf.toISOString(),
    total_obligations_monitored: total,
    breached_count: breached,
    at_risk_count: at_risk,
    compliant_count: compliant,
    compliance_score,
    confidence_score,
    regulatory_frameworks: frameworks,
    upcoming_deadlines,
    key_findings: COMPLIANCE_FINDINGS.slice(findings_idx, findings_idx + 4),
    compliance_actions: COMPLIANCE_ACTIONS.slice(actions_idx, actions_idx + 4),
  };
}

// ─── 2. Investigation Agent ───────────────────────────────────────────────────

export interface InvestigationAgentReport {
  generated_at: string;
  active_investigations: number;
  high_priority_count: number;
  investigations_completed_7d: number;
  avg_resolution_days: number;
  evidence_gaps_identified: number;
  recommendations_pending_approval: number;
  confidence_score: number;
  investigation_summaries: Array<{
    case_id: string;
    title: string;
    status: 'open' | 'in_progress' | 'pending_approval' | 'closed';
    risk_level: string;
    evidence_collected: number;
    next_action: string;
    confidence_score: number;
  }>;
  key_findings: string[];
}

const INV_STATUSES: Array<'open' | 'in_progress' | 'pending_approval' | 'closed'> = [
  'open', 'in_progress', 'pending_approval', 'closed',
];
const INV_TITLES = [
  'Suspicious Large Cash Withdrawal — Branch Mumbai North',
  'Repeat Claim Pattern — Policy Cluster INS-4401',
  'Identity Mismatch Detected — KYC Batch Q2',
  'Abnormal DPD Spike — SME Portfolio Segment',
  'AML Hit — Wire Transfer to Flagged Jurisdiction',
  'Duplicate Loan Application — CBS Inconsistency',
  'Collateral Overvaluation — Real Estate Loan Book',
  'Agent Misconduct Report — Premium Diversion Risk',
  'Fraudulent Surrender Claim — Life Insurance',
  'Cybersecurity Incident — Credential Stuffing Attempt',
];
const INV_ACTIONS = [
  'Schedule forensic audit with internal team.',
  'Request additional evidence from branch manager.',
  'Escalate to MLRO for AML sign-off.',
  'Cross-reference with bureau and CBS data.',
  'Await legal clearance before proceeding.',
  'Submit regulatory SAR before next deadline.',
  'Close case with documented no-action finding.',
  'Obtain board approval before further disclosure.',
];
const INV_FINDINGS = [
  'Three active investigations require immediate forensic evidence collection.',
  'Average case resolution time improved 12% compared to previous quarter.',
  'AML-linked investigations show 40% higher evidence gap rate than credit cases.',
  'Two cases pending MLRO sign-off are approaching regulatory reporting deadlines.',
  'Pattern recognition engine flagged repeat claimant networks across 5 case clusters.',
  'Digital evidence trail in 4 cyber-related cases shows strong prosecutability.',
];

export function buildInvestigationAgentReport(tenant: string, asOf: Date): InvestigationAgentReport {
  const r = rng(tenant, 'investigation', asOf);
  const active_investigations = Math.floor(clamp(r() * 33 + 12, 12, 45));
  const high_priority_count = Math.floor(r() * (active_investigations * 0.4) + 2);
  const investigations_completed_7d = Math.floor(r() * 10 + 2);
  const avg_resolution_days = round(clamp(r() * 20 + 14, 14, 34), 1);
  const evidence_gaps_identified = Math.floor(r() * 15 + 3);
  const recommendations_pending_approval = Math.floor(r() * 8 + 1);
  const confidence_score = round(clamp(r() * 12 + 80, 80, 92), 1);

  const summary_count = Math.min(active_investigations, 6);
  const investigation_summaries = Array.from({ length: summary_count }, (_, idx) => {
    const sr = mulberry32(fnv1a(`${tenant}:inv:${idx}:${dayKey(asOf)}`));
    const title = INV_TITLES[idx % INV_TITLES.length];
    const status = INV_STATUSES[Math.floor(sr() * INV_STATUSES.length)];
    const risk_level = pick(RISK_LEVELS, sr);
    const evidence_collected = Math.floor(sr() * 20 + 3);
    const next_action = pick(INV_ACTIONS, sr);
    const cs = round(clamp(sr() * 20 + 68, 68, 95), 1);
    return {
      case_id: `INV-${2024 + Math.floor(sr() * 2)}-${String(1000 + idx * 37).padStart(4, '0')}`,
      title,
      status,
      risk_level,
      evidence_collected,
      next_action,
      confidence_score: cs,
    };
  });

  const fi = Math.floor(r() * (INV_FINDINGS.length - 3));
  return {
    generated_at: asOf.toISOString(),
    active_investigations,
    high_priority_count,
    investigations_completed_7d,
    avg_resolution_days,
    evidence_gaps_identified,
    recommendations_pending_approval,
    confidence_score,
    investigation_summaries,
    key_findings: INV_FINDINGS.slice(fi, fi + 3),
  };
}

// ─── 3. Executive Briefing Agent ──────────────────────────────────────────────

export interface ExecutiveBriefingAgentReport {
  generated_at: string;
  briefing_period: string;
  total_risk_events: number;
  critical_events: number;
  high_events: number;
  risk_appetite_status: 'within_limits' | 'approaching_limit' | 'breach';
  confidence_score: number;
  top_3_risks: Array<{
    rank: number;
    title: string;
    domain: 'banking' | 'insurance' | 'enterprise';
    level: string;
    description: string;
    recommended_ceo_action: string;
  }>;
  emerging_threats: string[];
  strategic_recommendations: string[];
  kpi_summary: Array<{
    metric: string;
    value: string;
    trend: 'improving' | 'stable' | 'deteriorating';
    signal: string;
  }>;
}

const EXEC_RISK_TITLES = [
  'NPA Concentration in MSME Loan Book',
  'Cyber Threat Escalation — Phishing Campaigns',
  'Liquidity Stress under Rising Interest Rate Scenario',
  'Regulatory Fine Exposure — AML Compliance Gap',
  'Claim Frequency Spike — Motor Insurance Portfolio',
  'Credit Rating Downgrade Risk — Counterparty Exposure',
  'Operational Disruption — Core Banking Migration',
];
const EXEC_DOMAINS: Array<'banking' | 'insurance' | 'enterprise'> = ['banking', 'insurance', 'enterprise'];
const EXEC_CEO_ACTIONS = [
  'Convene emergency Risk Committee to review provisioning strategy.',
  'Authorise enhanced cybersecurity investment from contingency budget.',
  'Direct Treasury to increase liquid asset buffer to 130% LCR.',
  'Commission independent AML audit and engage regulator proactively.',
  'Instruct actuarial review of motor claims reserving assumptions.',
  'Initiate counterparty exposure reduction programme with limits.',
  'Approve dedicated migration project office with dedicated risk oversight.',
];
const EMERGING_THREATS = [
  'AI-generated deepfake fraud in KYC verification processes is increasing.',
  'Cross-border regulatory arbitrage risks arising from new FATF guidelines.',
  'Climate-related credit risk materialising faster than Basel IV timelines.',
  'Geopolitical instability affecting correspondent banking relationships.',
  'Talent attrition in risk functions creating knowledge concentration risk.',
  'Third-party vendor concentration risk in cloud infrastructure providers.',
];
const STRATEGIC_RECS = [
  'Accelerate digital KYC refresh to reduce regulatory exposure by Q3.',
  'Establish a dedicated Climate Risk function reporting to CRO.',
  'Increase risk technology budget allocation by 15% in next annual plan.',
  'Formalise board-level AI governance policy before next board meeting.',
  'Expand stress testing scenarios to include geopolitical disruption.',
  'Create cross-functional task force for CBS migration risk management.',
];
const KPI_METRICS = [
  { metric: 'Gross NPA Ratio', signal: 'vs 5.8% peer median' },
  { metric: 'Capital Adequacy Ratio', signal: 'vs 11.5% regulatory minimum' },
  { metric: 'Alert Resolution Rate (30d)', signal: 'vs 78% prior quarter' },
  { metric: 'Compliance Breach Count (QTD)', signal: 'vs 4 prior quarter' },
  { metric: 'Fraud Loss Ratio', signal: 'vs 0.12% industry benchmark' },
  { metric: 'Model AUC (PD Champion)', signal: 'vs 0.78 threshold' },
];
const APPETITE_STATUSES: Array<'within_limits' | 'approaching_limit' | 'breach'> = [
  'within_limits', 'approaching_limit', 'breach',
];
const TRENDS: Array<'improving' | 'stable' | 'deteriorating'> = ['improving', 'stable', 'deteriorating'];

export function buildExecutiveBriefingAgentReport(tenant: string, asOf: Date): ExecutiveBriefingAgentReport {
  const r = rng(tenant, 'executive', asOf);
  const total_risk_events = Math.floor(r() * 200 + 80);
  const critical_events = Math.floor(r() * 12 + 3);
  const high_events = Math.floor(r() * 35 + 10);
  const risk_appetite_status = pick(APPETITE_STATUSES, r);
  const confidence_score = round(clamp(r() * 10 + 85, 85, 95), 1);
  const period_start = isoOffset(asOf, -30);
  const briefing_period = `${period_start} to ${dayKey(asOf)}`;

  const top_3_risks = EXEC_RISK_TITLES.slice(0, 3).map((title, i) => {
    const rr = mulberry32(fnv1a(`${tenant}:exrisk:${i}:${dayKey(asOf)}`));
    return {
      rank: i + 1,
      title,
      domain: pick(EXEC_DOMAINS, rr),
      level: i === 0 ? 'critical' : i === 1 ? 'high' : 'medium',
      description: `Risk event concentration detected in ${title.toLowerCase()} requiring executive attention.`,
      recommended_ceo_action: EXEC_CEO_ACTIONS[i % EXEC_CEO_ACTIONS.length],
    };
  });

  const et_start = Math.floor(r() * (EMERGING_THREATS.length - 3));
  const sr_start = Math.floor(r() * (STRATEGIC_RECS.length - 3));

  const kpi_summary = KPI_METRICS.map((kpi) => {
    const kr = mulberry32(fnv1a(`${tenant}:kpi:${kpi.metric}:${dayKey(asOf)}`));
    const raw_val = kr() * 10 + 2;
    return {
      metric: kpi.metric,
      value: `${round(raw_val, 2)}%`,
      trend: pick(TRENDS, kr),
      signal: kpi.signal,
    };
  });

  return {
    generated_at: asOf.toISOString(),
    briefing_period,
    total_risk_events,
    critical_events,
    high_events,
    risk_appetite_status,
    confidence_score,
    top_3_risks,
    emerging_threats: EMERGING_THREATS.slice(et_start, et_start + 3),
    strategic_recommendations: STRATEGIC_RECS.slice(sr_start, sr_start + 3),
    kpi_summary,
  };
}

// ─── 4. Recovery Agent ────────────────────────────────────────────────────────

export interface RecoveryAgentReport {
  generated_at: string;
  total_recovery_cases: number;
  active_restoration_actions: number;
  completed_7d: number;
  success_rate_pct: number;
  system_health_score: number;
  confidence_score: number;
  recovery_timeline: Array<{
    case_type: string;
    cases_pending: number;
    avg_days_remaining: number;
    priority_actions: string[];
  }>;
  critical_pending_actions: Array<{
    action_id: string;
    description: string;
    deadline: string;
    risk_if_delayed: string;
    requires_approval: boolean;
  }>;
  key_findings: string[];
}

const RECOVERY_CASE_TYPES = [
  'Delinquency Recovery — Retail Loans',
  'Legal Recovery — NPA Accounts (DRT)',
  'OTS Settlement — SME Portfolio',
  'IBC Resolution — Corporate Accounts',
  'Insurance Reinstatement — Lapsed Policies',
  'Premium Recovery — Arrears Portfolio',
];
const RECOVERY_PRIORITY_ACTIONS = [
  ['Dispatch field recovery team to top-20 accounts.', 'Issue formal demand notice via legal counsel.'],
  ['File DRT application for accounts above ₹20L.', 'Engage empanelled lawyers for hearing schedule.'],
  ['Obtain board approval for OTS haircut policy.', 'Send OTS proposals to shortlisted borrowers.'],
  ['Coordinate with IRP for information submission.', 'Attend NCLT hearing scheduled this fortnight.'],
  ['Send reinstatement offer letters to lapsed policyholders.', 'Enable digital reinstatement workflow on portal.'],
  ['Initiate premium drive via agent network.', 'Escalate high-value arrears to collection agency.'],
];
const CRITICAL_ACTION_DESCRIPTIONS = [
  'Submit DRT petition for 8 NPA accounts before court deadline.',
  'Obtain CFO sign-off on OTS haircut above 30% for SME cluster.',
  'Complete IBC resolution plan submission to NCLT by filing date.',
  'Activate insurance reinstatement campaign for Q2 lapsed cohort.',
  'Release held recovery funds after KYC verification of 45 accounts.',
  'Escalate 12 stalled recovery files to Senior Management for intervention.',
];
const RISK_IF_DELAYED = [
  'DRT filing window lapses — statutory recovery right forfeited.',
  'OTS window closes — full recovery litigation required.',
  'IBC resolution timeline breach — liquidation proceedings triggered.',
  'Reinstatement window closes — permanent policy lapse for 2,400 policyholders.',
  'Regulatory inquiry triggered if recovery hold exceeds 90 days.',
  'Regulatory escalation risk if senior management intervention is delayed.',
];
const RECOVERY_FINDINGS = [
  'DRT pipeline accelerating — 14 new accounts added in past 30 days.',
  'OTS recovery rate improved 8 percentage points in SME segment.',
  'IBC resolution timelines running 22 days ahead of NCLT schedule.',
  'Premium recovery drive achieved 91% contact rate in lapsed cohort.',
  'Field recovery team efficiency increased 17% after route optimisation.',
  'Legal recovery costs reduced 12% through panel lawyer renegotiation.',
];

export function buildRecoveryAgentReport(tenant: string, asOf: Date): RecoveryAgentReport {
  const r = rng(tenant, 'recovery', asOf);
  const total_recovery_cases = Math.floor(r() * 300 + 120);
  const active_restoration_actions = Math.floor(r() * 40 + 15);
  const completed_7d = Math.floor(r() * 25 + 5);
  const success_rate_pct = round(clamp(r() * 16 + 68, 68, 84), 1);
  const system_health_score = round(clamp(r() * 15 + 74, 74, 89), 1);
  const confidence_score = round(clamp(r() * 10 + 81, 81, 91), 1);

  const recovery_timeline = RECOVERY_CASE_TYPES.map((case_type, i) => {
    const tr = mulberry32(fnv1a(`${tenant}:rct:${i}:${dayKey(asOf)}`));
    return {
      case_type,
      cases_pending: Math.floor(tr() * 50 + 10),
      avg_days_remaining: Math.floor(tr() * 45 + 10),
      priority_actions: RECOVERY_PRIORITY_ACTIONS[i],
    };
  });

  const cpa_count = 4;
  const critical_pending_actions = Array.from({ length: cpa_count }, (_, i) => {
    const ar = mulberry32(fnv1a(`${tenant}:cpa:${i}:${dayKey(asOf)}`));
    return {
      action_id: `REC-ACT-${String(100 + i).padStart(3, '0')}`,
      description: CRITICAL_ACTION_DESCRIPTIONS[i % CRITICAL_ACTION_DESCRIPTIONS.length],
      deadline: isoOffset(asOf, Math.floor(ar() * 21 + 3)),
      risk_if_delayed: RISK_IF_DELAYED[i % RISK_IF_DELAYED.length],
      requires_approval: ar() > 0.5,
    };
  });

  const fi = Math.floor(r() * (RECOVERY_FINDINGS.length - 3));
  return {
    generated_at: asOf.toISOString(),
    total_recovery_cases,
    active_restoration_actions,
    completed_7d,
    success_rate_pct,
    system_health_score,
    confidence_score,
    recovery_timeline,
    critical_pending_actions,
    key_findings: RECOVERY_FINDINGS.slice(fi, fi + 3),
  };
}

// ─── 5. Governance Agent ──────────────────────────────────────────────────────

export interface GovernanceAgentReport {
  generated_at: string;
  policy_violations_detected: number;
  unresolved_violations: number;
  governance_score: number;
  board_policy_compliance_pct: number;
  escalation_required: boolean;
  pending_policy_reviews: number;
  confidence_score: number;
  violation_breakdown: Array<{
    category: string;
    count: number;
    severity: string;
    trend: 'increasing' | 'stable' | 'decreasing';
  }>;
  top_governance_concerns: string[];
  key_findings: string[];
  governance_actions: string[];
}

const GOV_VIOLATION_CATEGORIES = [
  'Credit Approval Authority Breach',
  'Delegation of Power Violation',
  'Conflict of Interest — Related Party',
  'Policy Exception without Approval',
  'Data Privacy and Security Control Gap',
  'Segregation of Duties Failure',
  'Board Mandate Override',
];
const GOV_TRENDS: Array<'increasing' | 'stable' | 'decreasing'> = ['increasing', 'stable', 'decreasing'];
const GOV_CONCERNS = [
  'Board attendance below quorum threshold in 2 of last 4 meetings.',
  'Related party disclosures incomplete for 3 senior management transactions.',
  'Policy exception approvals increased 28% quarter-on-quarter without trend analysis.',
  'Segregation of duties violations concentrated in trade finance operations.',
  'Data classification policy adherence at 74% — below 85% governance threshold.',
  'Whistle-blower mechanism utilisation declining — awareness gap suspected.',
  'IT governance controls for AI model deployment require formal policy.',
];
const GOV_FINDINGS = [
  'Policy exception approval process lacks adequate second-line oversight.',
  'Board reporting pack timeliness improved but quality metrics still below target.',
  'Conflict of interest declarations not refreshed annually for 11% of officers.',
  'Governance score trending upward 3 points quarter-on-quarter.',
  'Credit authority delegation matrix requires revision after CBS upgrade.',
  'Three board-approved policies lapsed without renewal — immediate action needed.',
];
const GOV_ACTIONS = [
  'Implement mandatory second-line review for all policy exceptions above threshold.',
  'Update board pack quality scorecard and enforce submission timelines.',
  'Launch annual conflict of interest declaration drive before end of month.',
  'Revise credit authority delegation matrix to align with post-migration structure.',
  'Renew three lapsed board policies and obtain formal board ratification.',
  'Commission governance maturity assessment by external reviewer this quarter.',
  'Introduce AI governance policy for board approval at next scheduled meeting.',
  'Strengthen whistle-blower programme with anonymous digital reporting channel.',
];

export function buildGovernanceAgentReport(tenant: string, asOf: Date): GovernanceAgentReport {
  const r = rng(tenant, 'governance', asOf);
  const policy_violations_detected = Math.floor(r() * 30 + 8);
  const unresolved_violations = Math.floor(r() * (policy_violations_detected * 0.5) + 2);
  const governance_score = round(clamp(r() * 14 + 78, 78, 92), 1);
  const board_policy_compliance_pct = round(clamp(r() * 15 + 80, 80, 95), 1);
  const escalation_required = r() > 0.55;
  const pending_policy_reviews = Math.floor(r() * 12 + 3);
  const confidence_score = round(clamp(r() * 10 + 82, 82, 92), 1);

  const violation_breakdown = GOV_VIOLATION_CATEGORIES.map((category, i) => {
    const vr = mulberry32(fnv1a(`${tenant}:gov:${i}:${dayKey(asOf)}`));
    return {
      category,
      count: Math.floor(vr() * 8 + 1),
      severity: pick(RISK_LEVELS, vr),
      trend: pick(GOV_TRENDS, vr),
    };
  });

  const gc_start = Math.floor(r() * (GOV_CONCERNS.length - 4));
  const fi = Math.floor(r() * (GOV_FINDINGS.length - 3));
  const ai = Math.floor(r() * (GOV_ACTIONS.length - 4));

  return {
    generated_at: asOf.toISOString(),
    policy_violations_detected,
    unresolved_violations,
    governance_score,
    board_policy_compliance_pct,
    escalation_required,
    pending_policy_reviews,
    confidence_score,
    violation_breakdown,
    top_governance_concerns: GOV_CONCERNS.slice(gc_start, gc_start + 4),
    key_findings: GOV_FINDINGS.slice(fi, fi + 3),
    governance_actions: GOV_ACTIONS.slice(ai, ai + 4),
  };
}

// ─── Enterprise Agents Summary ────────────────────────────────────────────────

export interface EnterpriseAgentsSummary {
  generated_at: string;
  tenant_id: string;
  overall_enterprise_health_score: number;
  agents_deployed: number;
  compliance: ComplianceAgentReport;
  investigation: InvestigationAgentReport;
  executive_briefing: ExecutiveBriefingAgentReport;
  recovery: RecoveryAgentReport;
  governance: GovernanceAgentReport;
  aggregate_signals: {
    total_open_actions: number;
    escalation_required: boolean;
    highest_risk_domain: string;
    next_critical_deadline: string;
  };
}

export function buildEnterpriseAgentsSummary(tenant: string, asOf: Date): EnterpriseAgentsSummary {
  const compliance = buildComplianceAgentReport(tenant, asOf);
  const investigation = buildInvestigationAgentReport(tenant, asOf);
  const executive_briefing = buildExecutiveBriefingAgentReport(tenant, asOf);
  const recovery = buildRecoveryAgentReport(tenant, asOf);
  const governance = buildGovernanceAgentReport(tenant, asOf);

  const scores = [
    compliance.compliance_score,
    investigation.confidence_score,
    executive_briefing.confidence_score,
    recovery.system_health_score,
    governance.governance_score,
  ];
  const overall_enterprise_health_score = round(
    scores.reduce((a, b) => a + b, 0) / scores.length,
    1
  );

  const total_open_actions =
    compliance.compliance_actions.length +
    investigation.recommendations_pending_approval +
    recovery.active_restoration_actions +
    governance.unresolved_violations;

  const escalation_required =
    governance.escalation_required ||
    executive_briefing.risk_appetite_status === 'breach' ||
    compliance.breached_count > 5;

  const domain_scores: Record<string, number> = {
    compliance: compliance.compliance_score,
    investigation: investigation.confidence_score,
    recovery: recovery.system_health_score,
    governance: governance.governance_score,
  };
  const highest_risk_domain = Object.entries(domain_scores).sort(([, a], [, b]) => a - b)[0][0];

  const all_deadlines = compliance.upcoming_deadlines.map((d) => d.deadline);
  all_deadlines.sort();
  const next_critical_deadline = all_deadlines[0] ?? isoOffset(asOf, 30);

  return {
    generated_at: asOf.toISOString(),
    tenant_id: tenant,
    overall_enterprise_health_score,
    agents_deployed: 5,
    compliance,
    investigation,
    executive_briefing,
    recovery,
    governance,
    aggregate_signals: {
      total_open_actions,
      escalation_required,
      highest_risk_domain,
      next_critical_deadline,
    },
  };
}
