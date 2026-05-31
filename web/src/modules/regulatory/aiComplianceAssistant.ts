// Regulatory Compliance Center — pure resolver. 13th IA overlay (additive).

import type { FindingSeverity, RegulatoryFramework } from './regulatoryFrameworkEngine';

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
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayIndex(asOf: Date): number {
  return Math.floor(asOf.getTime() / 86_400_000);
}

function isoTimestamp(asOf: Date): string {
  const y = asOf.getUTCFullYear();
  const mo = String(asOf.getUTCMonth() + 1).padStart(2, '0');
  const d = String(asOf.getUTCDate()).padStart(2, '0');
  const h = String(asOf.getUTCHours()).padStart(2, '0');
  const mi = String(asOf.getUTCMinutes()).padStart(2, '0');
  const s = String(asOf.getUTCSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
}

function isoDate(asOf: Date, dayOffset: number): string {
  const ms = asOf.getTime() + dayOffset * 86_400_000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}T00:00:00.000Z`;
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function pickInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const BANKING_FRAMEWORKS_LOCAL: readonly RegulatoryFramework[] = [
  'rbi',
  'basel_iii',
  'basel_iv',
  'aml',
  'kyc',
  'credit_risk',
  'operational_risk',
  'regulatory_filings',
];

const INSURANCE_FRAMEWORKS_LOCAL: readonly RegulatoryFramework[] = [
  'irdai',
  'solvency',
  'claims_governance',
  'policy_governance',
  'persistency',
  'fraud_compliance',
  'underwriting_compliance',
  'regulatory_filings_insurance',
];

const ALL_FRAMEWORKS_LOCAL: readonly RegulatoryFramework[] = [
  ...BANKING_FRAMEWORKS_LOCAL,
  ...INSURANCE_FRAMEWORKS_LOCAL,
];

const FINDING_SEVERITIES_LOCAL: readonly FindingSeverity[] = [
  'low',
  'moderate',
  'high',
  'severe',
  'critical',
];

const GAP_NARRATIVES: Record<RegulatoryFramework, { title: string; description: string; obligations: string[]; owner: string }[]> = {
  rbi: [
    {
      title: 'Incomplete RBI quarterly capital adequacy submission',
      description: 'Tier-1 capital ratio worksheet missing supporting reconciliation against general ledger.',
      obligations: ['rbi-cap-adq-q1', 'rbi-cap-adq-recon'],
      owner: 'finance.compliance',
    },
    {
      title: 'NPA classification override log gap',
      description: 'Manual overrides on SMA-2 to NPA reclassification lack maker-checker evidence for 14 accounts.',
      obligations: ['rbi-npa-override', 'rbi-mc-trail'],
      owner: 'credit.compliance',
    },
  ],
  basel_iii: [
    {
      title: 'LCR stress scenario coverage gap',
      description: 'Liquidity Coverage Ratio stress test omits HQLA haircut sensitivity for 30-day adverse window.',
      obligations: ['basel-lcr-stress', 'basel-hqla-haircut'],
      owner: 'treasury.risk',
    },
  ],
  basel_iv: [
    {
      title: 'Standardised approach risk-weight mapping outdated',
      description: 'Corporate exposure risk-weights still reference Basel III tables; Basel IV mapping refresh pending.',
      obligations: ['basel-iv-rw-corp', 'basel-iv-mapping-refresh'],
      owner: 'risk.policy',
    },
  ],
  aml: [
    {
      title: 'Sanctions screening cadence gap',
      description: 'Daily OFAC screening missed for 3 business days in the rolling 30-day window.',
      obligations: ['aml-sanctions-daily', 'aml-screening-attest'],
      owner: 'aml.officer',
    },
  ],
  kyc: [
    {
      title: 'Periodic CDD refresh overdue for high-risk customers',
      description: '47 high-risk relationships exceed the 12-month CDD refresh window without remediation plan.',
      obligations: ['kyc-cdd-refresh', 'kyc-hr-attestation'],
      owner: 'kyc.team_lead',
    },
  ],
  credit_risk: [
    {
      title: 'Probability of default model validation overdue',
      description: 'Wholesale PD model validation cycle exceeded 14 months; model risk register flags this as breach.',
      obligations: ['cr-pd-validate', 'cr-model-register'],
      owner: 'model.validation',
    },
  ],
  operational_risk: [
    {
      title: 'Operational loss data threshold reporting incomplete',
      description: 'Events above 1M reporting threshold missing root-cause classification for the previous quarter.',
      obligations: ['op-loss-class', 'op-root-cause'],
      owner: 'op.risk.lead',
    },
  ],
  regulatory_filings: [
    {
      title: 'Form A annual return submission risk',
      description: 'Filing checklist 73% complete with 12 business days remaining; signatory queue not yet routed.',
      obligations: ['reg-form-a', 'reg-form-a-signoff'],
      owner: 'regulatory.affairs',
    },
  ],
  irdai: [
    {
      title: 'IRDAI Form-K solvency submission gap',
      description: 'Solvency ratio worksheet missing reinsurance recoverable reconciliation for two treaties.',
      obligations: ['irdai-form-k', 'irdai-reins-recon'],
      owner: 'actuarial.compliance',
    },
  ],
  solvency: [
    {
      title: 'Required solvency margin headroom narrowing',
      description: 'Available solvency margin trending towards 1.6x; IRDAI early-warning at 1.5x within 60 days.',
      obligations: ['sol-asm-monitor', 'sol-corrective-plan'],
      owner: 'cfo.office',
    },
  ],
  claims_governance: [
    {
      title: 'Claims TAT breach pattern in Health segment',
      description: 'Cashless claim turnaround exceeded 7-day regulatory limit in 9% of cases over last 30 days.',
      obligations: ['claims-tat-monitor', 'claims-root-cause'],
      owner: 'claims.governance',
    },
  ],
  policy_governance: [
    {
      title: 'Free-look cancellation audit gap',
      description: 'Sample audit of 30 free-look cancellations missing premium refund traceability for 4 records.',
      obligations: ['policy-freelook-audit', 'policy-refund-trace'],
      owner: 'policy.ops',
    },
  ],
  persistency: [
    {
      title: '13th-month persistency below regulatory threshold',
      description: 'Persistency at 64% versus 70% IRDAI guidance; remediation plan not yet circulated to board.',
      obligations: ['pers-13m-monitor', 'pers-board-plan'],
      owner: 'distribution.head',
    },
  ],
  fraud_compliance: [
    {
      title: 'Fraud investigation closure SLA breaches',
      description: 'Average closure cycle 71 days against 60-day internal SLA; IRDAI quarterly disclosure pending.',
      obligations: ['fraud-closure-sla', 'fraud-irdai-disclosure'],
      owner: 'fraud.investigations',
    },
  ],
  underwriting_compliance: [
    {
      title: 'Underwriting override evidence gap',
      description: 'Medical underwriting overrides above 5L sum-insured missing checker sign-off in 11 cases.',
      obligations: ['uw-override-evidence', 'uw-checker-signoff'],
      owner: 'chief.underwriter',
    },
  ],
  regulatory_filings_insurance: [
    {
      title: 'IRDAI public disclosure refresh overdue',
      description: 'Quarterly public disclosure on website lags by 11 days against IRDAI master circular timeline.',
      obligations: ['ins-pub-disclosure', 'ins-web-refresh'],
      owner: 'company.secretary',
    },
  ],
};

const RISK_NARRATIVES: Record<RegulatoryFramework, { title: string; description: string; mitigation: string }[]> = {
  rbi: [
    {
      title: 'RBI inspection readiness gap',
      description: 'Annual RBI inspection window opening in 60-90 days; mock inspection findings not yet remediated.',
      mitigation: 'Run targeted mock inspection on credit + treasury domains; close top-10 findings within 30 days.',
    },
  ],
  basel_iii: [
    {
      title: 'LCR breach probability under stressed funding',
      description: 'Wholesale funding concentration risk could push LCR below 100% in adverse 30-day scenario.',
      mitigation: 'Increase HQLA buffer by 8% via additional G-Sec holdings; diversify wholesale funding tenors.',
    },
  ],
  basel_iv: [
    {
      title: 'Output floor capital impact under-modelled',
      description: 'Basel IV output floor phase-in could compress CET1 by 60-90bps over next 4 quarters.',
      mitigation: 'Refresh capital plan with phase-in trajectory; pre-position retained earnings buffer.',
    },
  ],
  aml: [
    {
      title: 'Sanctions list refresh latency exposure',
      description: 'Sanctions list refresh window above 24h on 12% of recent updates; transaction screening at risk.',
      mitigation: 'Move to event-driven sanctions ingestion within 30 days; add 4h SLA monitoring alert.',
    },
  ],
  kyc: [
    {
      title: 'Periodic CDD backlog growing',
      description: 'CDD refresh backlog growing at 18% MoM; high-risk customers may breach refresh window in 60 days.',
      mitigation: 'Surge resource plan: deploy 6 additional analysts for 8 weeks; auto-prioritise high-risk bucket.',
    },
  ],
  credit_risk: [
    {
      title: 'Concentration risk in real-estate exposure',
      description: 'Real-estate exposure approaching 18% of total advances; internal threshold is 20%, RBI advisory at 25%.',
      mitigation: 'Pause new real-estate sanctions above 50Cr; rebalance via SME book growth over next 2 quarters.',
    },
  ],
  operational_risk: [
    {
      title: 'Third-party vendor outage exposure',
      description: 'Critical payment processor SLA breaches indicate elevated operational risk in next 30 days.',
      mitigation: 'Activate secondary processor failover testing; escalate to vendor governance committee.',
    },
  ],
  regulatory_filings: [
    {
      title: 'Quarterly DSB return submission risk',
      description: 'Filing checklist below 70% completion at T-15 days; signatory routing not initiated.',
      mitigation: 'Lock filing freeze 5 days before deadline; daily standup with finance + compliance owners.',
    },
  ],
  irdai: [
    {
      title: 'Form IIB submission deadline approaching',
      description: 'IRDAI Form IIB filing window closes in 45 days; data extraction from new policy system unverified.',
      mitigation: 'Complete UAT on extraction utility within 2 weeks; dry-run filing 10 days before deadline.',
    },
  ],
  solvency: [
    {
      title: 'Solvency margin breach probability',
      description: 'New product launches could compress required solvency margin below 1.5x in adverse scenario.',
      mitigation: 'Stage product launches; pre-position Tier-2 capital raise to maintain 1.6x buffer.',
    },
  ],
  claims_governance: [
    {
      title: 'Claims ombudsman complaint trend',
      description: 'Health claim complaints to ombudsman up 22% YoY; pattern points to TPA performance issues.',
      mitigation: 'Issue 30-day cure notice to underperforming TPAs; activate secondary network coverage.',
    },
  ],
  policy_governance: [
    {
      title: 'Policy issuance TAT regulatory exposure',
      description: 'Average policy issuance TAT at 6.2 days; IRDAI guidance is 7 days but trend is deteriorating.',
      mitigation: 'Workflow audit of underwriting → issuance handoff; eliminate top 3 bottleneck steps.',
    },
  ],
  persistency: [
    {
      title: '25th-month persistency declining',
      description: '25th-month persistency trending down to 52% from 56%; IRDAI guidance is 55%.',
      mitigation: 'Activate winback campaign for 13th-19th month policies; review distribution incentive structure.',
    },
  ],
  fraud_compliance: [
    {
      title: 'Health insurance fraud cluster',
      description: 'Emerging fraud cluster in Tier-2 city hospital network; ~80 claims with similar pattern detected.',
      mitigation: 'Enhanced investigation for impacted network; coordinate with IIB fraud bureau within 14 days.',
    },
  ],
  underwriting_compliance: [
    {
      title: 'Medical UW guideline drift',
      description: 'Medical UW deviations above tolerance in 14% of sample audit; guideline refresh overdue.',
      mitigation: 'Roll out refreshed medical UW manual within 30 days; mandatory training for UW team.',
    },
  ],
  regulatory_filings_insurance: [
    {
      title: 'Annual report disclosure completeness risk',
      description: 'Annual report MD&A section pending sign-off from 3 of 5 senior leaders; T-21 days to filing.',
      mitigation: 'Daily sign-off tracker with company secretary; escalation matrix activated at T-14.',
    },
  ],
};

const RECOMMENDATION_POOLS = [
  {
    title: 'Roll out unified compliance evidence vault',
    description: 'Centralise compliance evidence across RBI + IRDAI in tamper-evident store with chain-of-custody.',
    priority: 'high' as const,
    category: 'control' as const,
  },
  {
    title: 'Quarterly compliance training refresh',
    description: 'Mandatory training cycle for compliance + frontline staff covering refreshed regulatory expectations.',
    priority: 'medium' as const,
    category: 'training' as const,
  },
  {
    title: 'Establish regulatory change horizon-scanning cell',
    description: 'Dedicated 2-person cell to monitor RBI + IRDAI master directions and impact-assess within 5 days.',
    priority: 'high' as const,
    category: 'policy' as const,
  },
  {
    title: 'Automate AML sanctions evidence capture',
    description: 'Move from manual attestation to automated evidence capture for daily sanctions screening.',
    priority: 'high' as const,
    category: 'control' as const,
  },
  {
    title: 'Compliance KPI dashboard for board reporting',
    description: 'Standardised dashboard tracking obligations, findings, breaches, and remediation for board pack.',
    priority: 'medium' as const,
    category: 'policy' as const,
  },
  {
    title: 'Internal audit independent review of model risk',
    description: 'Trigger independent audit cycle on top 5 risk models given regulatory focus on model governance.',
    priority: 'medium' as const,
    category: 'audit' as const,
  },
  {
    title: 'Pre-filing peer review for regulatory submissions',
    description: 'Mandatory peer review by independent compliance officer 5 days before any RBI / IRDAI filing.',
    priority: 'high' as const,
    category: 'filing' as const,
  },
  {
    title: 'Refresh CDD policy with risk-tiered cadence',
    description: 'Update CDD refresh cadence: high-risk 6 months, medium 12 months, low 24 months with auto-tickets.',
    priority: 'medium' as const,
    category: 'policy' as const,
  },
  {
    title: 'Claims TAT breach root-cause war-room',
    description: 'Standing weekly war-room on claims TAT breach drivers with TPA + operations + IT representation.',
    priority: 'high' as const,
    category: 'control' as const,
  },
  {
    title: 'Pre-audit readiness simulation for RBI inspection',
    description: 'Run 2 mock inspections per year with external advisory firm; close findings within 60 days.',
    priority: 'medium' as const,
    category: 'audit' as const,
  },
];

const EXCEPTION_REASON_NARRATIVES: Record<
  'data_gap' | 'process_failure' | 'system_outage' | 'regulatory_change' | 'training_gap',
  string
> = {
  data_gap: 'Source data incomplete from upstream system; remediate via reconciliation control.',
  process_failure: 'Manual handoff failed to capture evidence; redesign process with automated checkpoint.',
  system_outage: 'System unavailability during processing window; activate backup processing path.',
  regulatory_change: 'New regulatory expectation not yet codified into control; update policy and refresh training.',
  training_gap: 'Operator not trained on updated procedure; mandatory training refresh required.',
};

const EXCEPTION_REASONS: readonly ('data_gap' | 'process_failure' | 'system_outage' | 'regulatory_change' | 'training_gap')[] = [
  'data_gap',
  'process_failure',
  'system_outage',
  'regulatory_change',
  'training_gap',
];

export interface ComplianceGap {
  gap_id: string;
  framework: RegulatoryFramework;
  domain: 'banking' | 'insurance';
  title: string;
  description: string;
  severity: FindingSeverity;
  missing_obligations: string[];
  recommended_owner: string;
}

export interface UpcomingComplianceRisk {
  risk_id: string;
  framework: RegulatoryFramework;
  title: string;
  description: string;
  probability: number;
  impact: FindingSeverity;
  horizon_days: 7 | 30 | 60 | 90;
  mitigation_recommendation: string;
}

export interface AIComplianceRecommendation {
  recommendation_id: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  category: 'policy' | 'training' | 'control' | 'filing' | 'audit';
  target_framework: RegulatoryFramework | null;
}

export interface ExceptionAnalysisRow {
  exception_id: string;
  obligation_id: string;
  framework: RegulatoryFramework;
  reason: 'data_gap' | 'process_failure' | 'system_outage' | 'regulatory_change' | 'training_gap';
  frequency_30d: number;
  first_seen_at: string;
  last_seen_at: string;
  recommended_action: string;
}

export interface AIComplianceReport {
  tenant_id: string;
  generated_at: string;
  confidence: number;
  model_id: 'compliance-llm';
  model_version: '1.0.0';
  compliance_gaps: ComplianceGap[];
  upcoming_risks: UpcomingComplianceRisk[];
  recommendations: AIComplianceRecommendation[];
  exception_analysis: ExceptionAnalysisRow[];
}

function frameworkDomain(fw: RegulatoryFramework): 'banking' | 'insurance' {
  return BANKING_FRAMEWORKS_LOCAL.includes(fw) ? 'banking' : 'insurance';
}

function severityFromProbability(p: number): FindingSeverity {
  if (p >= 0.85) return 'critical';
  if (p >= 0.7) return 'severe';
  if (p >= 0.5) return 'high';
  if (p >= 0.3) return 'moderate';
  return 'low';
}

function buildComplianceGaps(rng: () => number, asOf: Date): ComplianceGap[] {
  const count = pickInt(rng, 4, 7);
  const out: ComplianceGap[] = [];
  const pool: { fw: RegulatoryFramework; entry: typeof GAP_NARRATIVES[RegulatoryFramework][number] }[] = [];
  for (const fw of ALL_FRAMEWORKS_LOCAL) {
    for (const entry of GAP_NARRATIVES[fw]) {
      pool.push({ fw, entry });
    }
  }
  for (let i = 0; i < count; i++) {
    const choice = pool[Math.floor(rng() * pool.length)];
    const sev = FINDING_SEVERITIES_LOCAL[Math.floor(rng() * FINDING_SEVERITIES_LOCAL.length)];
    out.push({
      gap_id: `gap-${dayIndex(asOf)}-${i}`,
      framework: choice.fw,
      domain: frameworkDomain(choice.fw),
      title: choice.entry.title,
      description: choice.entry.description,
      severity: sev,
      missing_obligations: [...choice.entry.obligations],
      recommended_owner: choice.entry.owner,
    });
  }
  return out;
}

function buildUpcomingRisks(rng: () => number, asOf: Date): UpcomingComplianceRisk[] {
  const count = pickInt(rng, 4, 7);
  const out: UpcomingComplianceRisk[] = [];
  const horizons: (7 | 30 | 60 | 90)[] = [7, 30, 60, 90];
  const pool: { fw: RegulatoryFramework; entry: typeof RISK_NARRATIVES[RegulatoryFramework][number] }[] = [];
  for (const fw of ALL_FRAMEWORKS_LOCAL) {
    for (const entry of RISK_NARRATIVES[fw]) {
      pool.push({ fw, entry });
    }
  }
  for (let i = 0; i < count; i++) {
    const choice = pool[Math.floor(rng() * pool.length)];
    const probability = round2(0.25 + rng() * 0.65);
    out.push({
      risk_id: `risk-${dayIndex(asOf)}-${i}`,
      framework: choice.fw,
      title: choice.entry.title,
      description: choice.entry.description,
      probability,
      impact: severityFromProbability(probability),
      horizon_days: horizons[Math.floor(rng() * horizons.length)],
      mitigation_recommendation: choice.entry.mitigation,
    });
  }
  return out;
}

function buildRecommendations(rng: () => number, asOf: Date): AIComplianceRecommendation[] {
  const count = pickInt(rng, 5, 8);
  const out: AIComplianceRecommendation[] = [];
  const used = new Set<number>();
  for (let i = 0; i < count; i++) {
    let idx = Math.floor(rng() * RECOMMENDATION_POOLS.length);
    let guard = 0;
    while (used.has(idx) && guard < RECOMMENDATION_POOLS.length) {
      idx = (idx + 1) % RECOMMENDATION_POOLS.length;
      guard++;
    }
    used.add(idx);
    const entry = RECOMMENDATION_POOLS[idx];
    const targetFramework =
      rng() < 0.7 ? ALL_FRAMEWORKS_LOCAL[Math.floor(rng() * ALL_FRAMEWORKS_LOCAL.length)] : null;
    out.push({
      recommendation_id: `rec-${dayIndex(asOf)}-${i}`,
      title: entry.title,
      description: entry.description,
      priority: entry.priority,
      category: entry.category,
      target_framework: targetFramework,
    });
  }
  return out;
}

function buildExceptionAnalysis(rng: () => number, asOf: Date): ExceptionAnalysisRow[] {
  const count = pickInt(rng, 4, 7);
  const out: ExceptionAnalysisRow[] = [];
  for (let i = 0; i < count; i++) {
    const fw = pick(rng, ALL_FRAMEWORKS_LOCAL);
    const reason = pick(rng, EXCEPTION_REASONS);
    const frequency = pickInt(rng, 3, 28);
    const firstOffset = -pickInt(rng, 20, 29);
    const lastOffset = -pickInt(rng, 0, Math.max(0, Math.abs(firstOffset) - 1));
    out.push({
      exception_id: `ex-${dayIndex(asOf)}-${i}`,
      obligation_id: `${fw}-obl-${pickInt(rng, 100, 999)}`,
      framework: fw,
      reason,
      frequency_30d: frequency,
      first_seen_at: isoDate(asOf, firstOffset),
      last_seen_at: isoDate(asOf, lastOffset),
      recommended_action: EXCEPTION_REASON_NARRATIVES[reason],
    });
  }
  return out;
}

export function buildAIComplianceReport(tenant_id: string, asOf?: Date): AIComplianceReport {
  const resolvedAsOf = asOf ?? new Date();
  const di = dayIndex(resolvedAsOf);
  const seed = fnv1a(`${tenant_id}|ai-compliance|${di}`);
  const rng = mulberry32(seed);
  const confidence = round2(0.65 + rng() * 0.27);
  return {
    tenant_id,
    generated_at: isoTimestamp(resolvedAsOf),
    confidence,
    model_id: 'compliance-llm',
    model_version: '1.0.0',
    compliance_gaps: buildComplianceGaps(rng, resolvedAsOf),
    upcoming_risks: buildUpcomingRisks(rng, resolvedAsOf),
    recommendations: buildRecommendations(rng, resolvedAsOf),
    exception_analysis: buildExceptionAnalysis(rng, resolvedAsOf),
  };
}

export interface ExecutiveComplianceDashboard {
  tenant_id: string;
  generated_at: string;
  compliance_health_score: number;
  regulatory_risk_score: number;
  open_findings: number;
  pending_actions: number;
  upcoming_deadlines_count: number;
  audit_readiness: 'ready' | 'needs_attention' | 'not_ready';
  top_obligations_at_risk: Array<{
    obligation_id: string;
    regulation: string;
    framework: RegulatoryFramework;
    domain: 'banking' | 'insurance';
    priority: 'low' | 'medium' | 'high' | 'critical';
    days_until_due: number;
  }>;
  compliance_trend_30d: Array<{
    day_offset: number;
    health_score: number;
    risk_score: number;
  }>;
  regulator_breakdown: Array<{
    regulator: string;
    total_obligations: number;
    open_findings: number;
    breaches: number;
  }>;
}

const REGULATION_LABELS: Record<RegulatoryFramework, string> = {
  rbi: 'RBI Master Direction',
  basel_iii: 'Basel III',
  basel_iv: 'Basel IV',
  aml: 'PMLA / AML',
  kyc: 'KYC Master Direction',
  credit_risk: 'RBI Credit Risk Guidance',
  operational_risk: 'RBI Operational Risk Guidance',
  regulatory_filings: 'RBI Regulatory Filings',
  irdai: 'IRDAI Regulations',
  solvency: 'IRDAI Solvency Margin Rules',
  claims_governance: 'IRDAI Claims Governance',
  policy_governance: 'IRDAI Policy Governance',
  persistency: 'IRDAI Persistency Guidance',
  fraud_compliance: 'IRDAI Fraud Monitoring',
  underwriting_compliance: 'IRDAI Underwriting Norms',
  regulatory_filings_insurance: 'IRDAI Public Disclosures',
};

function buildTopObligations(
  rng: () => number,
  asOf: Date,
): ExecutiveComplianceDashboard['top_obligations_at_risk'] {
  const priorities: ('low' | 'medium' | 'high' | 'critical')[] = ['low', 'medium', 'high', 'critical'];
  const out: ExecutiveComplianceDashboard['top_obligations_at_risk'] = [];
  for (let i = 0; i < 5; i++) {
    const fw = pick(rng, ALL_FRAMEWORKS_LOCAL);
    out.push({
      obligation_id: `obl-${dayIndex(asOf)}-${i}`,
      regulation: REGULATION_LABELS[fw],
      framework: fw,
      domain: frameworkDomain(fw),
      priority: pick(rng, priorities),
      days_until_due: pickInt(rng, 1, 45),
    });
  }
  return out;
}

function buildComplianceTrend(
  rng: () => number,
  baseHealth: number,
  baseRisk: number,
): ExecutiveComplianceDashboard['compliance_trend_30d'] {
  const out: ExecutiveComplianceDashboard['compliance_trend_30d'] = [];
  for (let i = 0; i < 30; i++) {
    const offset = -29 + i;
    const healthDrift = (rng() - 0.5) * 6;
    const riskDrift = (rng() - 0.5) * 6;
    const health = Math.max(0, Math.min(100, Math.round(baseHealth + healthDrift)));
    const risk = Math.max(0, Math.min(100, Math.round(baseRisk + riskDrift)));
    out.push({ day_offset: offset, health_score: health, risk_score: risk });
  }
  return out;
}

function buildRegulatorBreakdown(
  rng: () => number,
): ExecutiveComplianceDashboard['regulator_breakdown'] {
  const regulators = ['RBI', 'IRDAI', 'Basel Committee', 'Internal'];
  return regulators.map((reg) => ({
    regulator: reg,
    total_obligations: pickInt(rng, 18, 65),
    open_findings: pickInt(rng, 2, 14),
    breaches: pickInt(rng, 0, 5),
  }));
}

function readinessFromScore(score: number): 'ready' | 'needs_attention' | 'not_ready' {
  if (score >= 80) return 'ready';
  if (score >= 50) return 'needs_attention';
  return 'not_ready';
}

export function buildExecutiveComplianceDashboard(
  tenant_id: string,
  asOf?: Date,
): ExecutiveComplianceDashboard {
  const resolvedAsOf = asOf ?? new Date();
  const di = dayIndex(resolvedAsOf);
  const seed = fnv1a(`${tenant_id}|exec-compliance|${di}`);
  const rng = mulberry32(seed);
  const compliance_health_score = pickInt(rng, 45, 95);
  const regulatory_risk_score = pickInt(rng, 15, 75);
  return {
    tenant_id,
    generated_at: isoTimestamp(resolvedAsOf),
    compliance_health_score,
    regulatory_risk_score,
    open_findings: pickInt(rng, 8, 48),
    pending_actions: pickInt(rng, 6, 40),
    upcoming_deadlines_count: pickInt(rng, 4, 22),
    audit_readiness: readinessFromScore(compliance_health_score),
    top_obligations_at_risk: buildTopObligations(rng, resolvedAsOf),
    compliance_trend_30d: buildComplianceTrend(rng, compliance_health_score, regulatory_risk_score),
    regulator_breakdown: buildRegulatorBreakdown(rng),
  };
}
