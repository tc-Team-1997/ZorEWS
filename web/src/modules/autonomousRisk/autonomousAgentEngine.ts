/**
 * Autonomous Risk Operations Center — core agent orchestration engine.
 * Pure-function engine: no I/O, no React, no stores.
 * 13 AI agents: 4 banking + 4 insurance + 5 enterprise.
 * Phase 18 IA overlay — additive; every prior module untouched.
 */

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

// ── Closed enum arrays ────────────────────────────────────────────────────────

export const AGENT_TYPES = [
  'credit_risk',
  'fraud_detection',
  'collections',
  'portfolio_risk',
  'claims',
  'insurance_fraud',
  'policy_retention',
  'solvency',
  'compliance',
  'investigation',
  'executive_briefing',
  'recovery',
  'governance',
] as const;
export type AgentType = typeof AGENT_TYPES[number];

export const AGENT_STATES = ['active', 'idle', 'busy', 'escalated', 'suspended', 'offline'] as const;
export type AgentState = typeof AGENT_STATES[number];

export const AGENT_DOMAINS = ['banking', 'insurance', 'enterprise'] as const;
export type AgentDomain = typeof AGENT_DOMAINS[number];

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = typeof RISK_LEVELS[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'escalated'] as const;
export type ApprovalStatus = typeof APPROVAL_STATUSES[number];

export const BRIEFING_TYPES = ['daily', 'weekly', 'monthly'] as const;
export type BriefingType = typeof BRIEFING_TYPES[number];

export const COLLABORATION_TYPES = ['handoff', 'parallel', 'sequential', 'escalation'] as const;
export type CollaborationType = typeof COLLABORATION_TYPES[number];

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface AgentDefinition {
  agent_id: string;
  name: string;
  type: AgentType;
  domain: AgentDomain;
  description: string;
  responsibilities: string[];
  state: AgentState;
  last_execution: string;
  success_rate: number;
  escalation_count: number;
  avg_resolution_ms: number;
  is_enabled: boolean;
  version: string;
}

export interface AgentExecution {
  execution_id: string;
  agent_id: string;
  agent_name: string;
  tenant_id: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number;
  status: 'running' | 'completed' | 'failed' | 'escalated';
  input_summary: string;
  output_summary: string;
  confidence_score: number;
  risk_level: RiskLevel;
  escalated_to: string | null;
}

export interface AgentRecommendation {
  recommendation_id: string;
  agent_id: string;
  agent_name: string;
  tenant_id: string;
  generated_at: string;
  title: string;
  findings: string[];
  root_causes: string[];
  risk_drivers: string[];
  suggested_actions: string[];
  impact_assessment: string;
  confidence_score: number;
  risk_level: RiskLevel;
  requires_approval: boolean;
  approval_status: ApprovalStatus | null;
}

export interface HumanApprovalItem {
  item_id: string;
  agent_id: string;
  agent_name: string;
  action_description: string;
  risk_level: RiskLevel;
  generated_at: string;
  expires_at: string;
  status: ApprovalStatus;
  requested_by: string;
  reviewed_by: string | null;
  review_notes: string | null;
}

export interface AgentCollaboration {
  collaboration_id: string;
  from_agent_id: string;
  from_agent_name: string;
  to_agent_id: string;
  to_agent_name: string;
  collaboration_type: CollaborationType;
  started_at: string;
  message_count: number;
  status: 'active' | 'completed';
  outcome_summary: string;
}

export interface PerformanceDashboard {
  total_agents: number;
  active_agents: number;
  idle_agents: number;
  busy_agents: number;
  escalated_agents: number;
  overall_success_rate: number;
  recommendations_generated_24h: number;
  investigations_assisted_24h: number;
  compliance_findings_24h: number;
  risk_actions_24h: number;
  avg_confidence_score: number;
  pending_approvals: number;
}

export interface ExecutiveBriefing {
  briefing_id: string;
  type: BriefingType;
  generated_at: string;
  period_label: string;
  top_risks: Array<{ title: string; level: RiskLevel; agent_id: string; summary: string }>;
  emerging_risks: string[];
  compliance_risks: string[];
  investigation_status: { total_active: number; high_priority: number; avg_resolution_days: number };
  forecast_summary: string;
  risk_appetite_status: 'within_limits' | 'approaching_limit' | 'breach';
  confidence_score: number;
}

export interface AgentWorkbenchEntry {
  agent_id: string;
  name: string;
  type: AgentType;
  domain: AgentDomain;
  state: AgentState;
  last_execution: string;
  success_rate: number;
  escalation_count: number;
  avg_resolution_ms: number;
  is_enabled: boolean;
}

// ── RBAC ──────────────────────────────────────────────────────────────────────

export const AUTONOMOUS_RISK_ROLES: readonly string[] = [
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
  'coo',
  'board_member',
  'operations_manager',
  'investigation_officer',
  'country_head',
];

export function canAccessAutonomousRiskCenter(roles: readonly string[] | undefined): boolean {
  if (!roles || roles.length === 0) return false;
  const allowed = new Set(AUTONOMOUS_RISK_ROLES);
  for (const r of roles) {
    if (allowed.has(r)) return true;
  }
  return false;
}

// ── Agent Registry ────────────────────────────────────────────────────────────

export const AGENT_REGISTRY: readonly AgentDefinition[] = [
  {
    agent_id: 'agent-credit-risk',
    name: 'Credit Risk Analyst',
    type: 'credit_risk',
    domain: 'banking',
    description: 'Monitors loan portfolios, DPD trends, and early-warning signals for credit deterioration.',
    responsibilities: [
      'Track DPD movement across portfolio segments',
      'Trigger early-warning alerts for SMA / NPA migration',
      'Run monthly PD recalibration on challenger models',
      'Generate pre-delinquency intervention recommendations',
    ],
    state: 'active',
    last_execution: '2026-05-31T08:30:00.000Z',
    success_rate: 0.93,
    escalation_count: 5,
    avg_resolution_ms: 62000,
    is_enabled: true,
    version: '2.4.1',
  },
  {
    agent_id: 'agent-fraud-detection',
    name: 'Fraud Detection Sentinel',
    type: 'fraud_detection',
    domain: 'banking',
    description: 'Real-time transaction monitoring for velocity anomalies, geo-velocity, and channel fraud patterns.',
    responsibilities: [
      'Monitor transaction velocity and geo-velocity signals',
      'Flag unusual channel-switching behaviour',
      'Correlate CBS events with AML watchlist hits',
      'Auto-escalate high-confidence fraud cases to investigation',
    ],
    state: 'busy',
    last_execution: '2026-05-31T09:45:00.000Z',
    success_rate: 0.97,
    escalation_count: 14,
    avg_resolution_ms: 45000,
    is_enabled: true,
    version: '3.1.0',
  },
  {
    agent_id: 'agent-collections',
    name: 'Collections Orchestrator',
    type: 'collections',
    domain: 'banking',
    description: 'Optimises collection strategy selection, field officer assignment, and recovery sequencing.',
    responsibilities: [
      'Score accounts for optimal collection channel',
      'Assign field officers based on GPS proximity and case priority',
      'Trigger skip-tracing workflows for unresponsive borrowers',
      'Monitor promise-to-pay compliance and reschedule broken promises',
    ],
    state: 'active',
    last_execution: '2026-05-31T07:15:00.000Z',
    success_rate: 0.88,
    escalation_count: 7,
    avg_resolution_ms: 95000,
    is_enabled: true,
    version: '1.8.3',
  },
  {
    agent_id: 'agent-portfolio-risk',
    name: 'Portfolio Risk Monitor',
    type: 'portfolio_risk',
    domain: 'banking',
    description: 'Tracks concentration risk, IFRS 9 stage migrations, and ECL movements across the loan book.',
    responsibilities: [
      'Compute ECL delta on daily stage migration',
      'Flag concentration risk breaches by sector and geography',
      'Align capital buffer estimates with RBI norms',
      'Produce monthly risk appetite report for ALCO',
    ],
    state: 'idle',
    last_execution: '2026-05-30T23:00:00.000Z',
    success_rate: 0.91,
    escalation_count: 3,
    avg_resolution_ms: 120000,
    is_enabled: true,
    version: '2.0.5',
  },
  {
    agent_id: 'agent-claims',
    name: 'Claims Intelligence Agent',
    type: 'claims',
    domain: 'insurance',
    description: 'Analyses claim submissions for medical necessity, duplicate billing, and provider anomalies.',
    responsibilities: [
      'Validate claim amounts against treatment protocols',
      'Detect duplicate claim submissions across policy periods',
      'Flag outlier hospital TAT and abnormal procedure frequencies',
      'Route complex claims to human adjudicators with AI scoring',
    ],
    state: 'active',
    last_execution: '2026-05-31T10:00:00.000Z',
    success_rate: 0.89,
    escalation_count: 9,
    avg_resolution_ms: 78000,
    is_enabled: true,
    version: '1.5.2',
  },
  {
    agent_id: 'agent-insurance-fraud',
    name: 'Insurance Fraud Investigator',
    type: 'insurance_fraud',
    domain: 'insurance',
    description: 'Detects organised ring fraud, misrepresentation, and fictitious claim networks in insurance.',
    responsibilities: [
      'Build claim-to-claimant network graphs for ring detection',
      'Identify repeat claimants with suspiciously similar narratives',
      'Cross-reference policy inception dates against claim timing',
      'Coordinate with AML for insured-is-watchlisted scenarios',
    ],
    state: 'busy',
    last_execution: '2026-05-31T09:20:00.000Z',
    success_rate: 0.86,
    escalation_count: 11,
    avg_resolution_ms: 135000,
    is_enabled: true,
    version: '2.2.0',
  },
  {
    agent_id: 'agent-policy-retention',
    name: 'Policy Retention Optimizer',
    type: 'policy_retention',
    domain: 'insurance',
    description: 'Predicts lapse and surrender propensity to trigger proactive retention interventions.',
    responsibilities: [
      'Score active policies for 30/60/90-day lapse probability',
      'Recommend premium holiday or rider adjustments for at-risk policies',
      'Monitor agent persistency KPIs and flag underperformers',
      'Generate renewal campaign lists filtered by customer lifetime value',
    ],
    state: 'idle',
    last_execution: '2026-05-31T06:30:00.000Z',
    success_rate: 0.84,
    escalation_count: 4,
    avg_resolution_ms: 88000,
    is_enabled: true,
    version: '1.3.1',
  },
  {
    agent_id: 'agent-solvency',
    name: 'Solvency Stress Tester',
    type: 'solvency',
    domain: 'insurance',
    description: 'Runs IRDAI Form-K solvency scenarios and monitors surplus capital buffers.',
    responsibilities: [
      'Compute solvency margin under RBI/IRDAI stress scenarios',
      'Track movement in Available Solvency Margin vs Required',
      'Alert actuarial team when buffer falls within 20% of minimum',
      'Generate quarterly IRDAI statutory solvency report draft',
    ],
    state: 'active',
    last_execution: '2026-05-30T22:00:00.000Z',
    success_rate: 0.92,
    escalation_count: 2,
    avg_resolution_ms: 155000,
    is_enabled: true,
    version: '1.0.8',
  },
  {
    agent_id: 'agent-compliance',
    name: 'Regulatory Compliance Watcher',
    type: 'compliance',
    domain: 'enterprise',
    description: 'Monitors RBI/IRDAI directives, KYC expiries, AML thresholds, and audit-trail gaps.',
    responsibilities: [
      'Track KYC expiry calendar and trigger renewal workflows',
      'Enforce AML transaction-monitoring threshold compliance',
      'Monitor RBI/IRDAI circular implementations for overdue items',
      'Validate audit chain integrity on a rolling 200-event window',
    ],
    state: 'active',
    last_execution: '2026-05-31T08:00:00.000Z',
    success_rate: 0.95,
    escalation_count: 6,
    avg_resolution_ms: 58000,
    is_enabled: true,
    version: '2.7.0',
  },
  {
    agent_id: 'agent-investigation',
    name: 'Case Investigation Coordinator',
    type: 'investigation',
    domain: 'enterprise',
    description: 'Orchestrates multi-source evidence collection and coordinates cross-team investigations.',
    responsibilities: [
      'Open and track BIL §17 claim-fraud investigation checklists',
      'Correlate AML match hits with active fraud alerts',
      'Assign cases to the right investigation officer based on specialisation',
      'Monitor SLA compliance across all active investigations',
    ],
    state: 'active',
    last_execution: '2026-05-31T09:55:00.000Z',
    success_rate: 0.90,
    escalation_count: 8,
    avg_resolution_ms: 110000,
    is_enabled: true,
    version: '1.9.4',
  },
  {
    agent_id: 'agent-executive-briefing',
    name: 'Executive Briefing Engine',
    type: 'executive_briefing',
    domain: 'enterprise',
    description: 'Synthesises fleet-wide risk signals into board-ready briefings and ALCO packs.',
    responsibilities: [
      'Aggregate top-5 portfolio risks for daily CRO briefing',
      'Generate weekly ALCO pack with ECL, NPA, and capital metrics',
      'Produce monthly board risk appetite report in PDF format',
      'Summarise pending regulatory filings and deadlines',
    ],
    state: 'idle',
    last_execution: '2026-05-31T07:00:00.000Z',
    success_rate: 0.94,
    escalation_count: 2,
    avg_resolution_ms: 175000,
    is_enabled: true,
    version: '2.1.0',
  },
  {
    agent_id: 'agent-recovery',
    name: 'Recovery Strategy Planner',
    type: 'recovery',
    domain: 'enterprise',
    description: 'Models settlement scenarios, OTS eligibility, and debt restructuring pathways for NPA accounts.',
    responsibilities: [
      'Score NPA accounts for OTS eligibility based on security cover',
      'Model haircut scenarios and expected recovery timelines',
      'Recommend optimal legal vs non-legal recovery track per account',
      'Track SARFAESI and DRT proceedings and flag missed deadlines',
    ],
    state: 'offline',
    last_execution: '2026-05-29T14:00:00.000Z',
    success_rate: 0.82,
    escalation_count: 10,
    avg_resolution_ms: 142000,
    is_enabled: true,
    version: '1.2.0',
  },
  {
    agent_id: 'agent-governance',
    name: 'AI Governance Auditor',
    type: 'governance',
    domain: 'enterprise',
    description: 'Oversees model risk management, bias audits, and explainability reviews across all AI agents.',
    responsibilities: [
      'Run quarterly model drift audits across all deployed AI models',
      'Validate SHAP explanations for fairness and regulatory defensibility',
      'Track model promotion approvals and ensure 4-eyes compliance',
      'Generate model risk report for RBI IFRS 9 model validation',
    ],
    state: 'suspended',
    last_execution: '2026-05-28T12:00:00.000Z',
    success_rate: 0.87,
    escalation_count: 3,
    avg_resolution_ms: 168000,
    is_enabled: false,
    version: '0.9.1',
  },
];

// ── Build functions ───────────────────────────────────────────────────────────

export function buildPerformanceDashboard(tenant: string, asOf: Date): PerformanceDashboard {
  const rng = mulberry32(fnv1a(tenant + ':perf:' + dayKey(asOf)));
  const active_agents = Math.floor(rng() * 4) + 7; // 7-10
  const idle_agents = Math.floor(rng() * 3) + 1;
  const busy_agents = Math.floor(rng() * 2) + 1;
  const escalated_agents = Math.floor(rng() * 2);
  return {
    total_agents: 13,
    active_agents,
    idle_agents,
    busy_agents,
    escalated_agents,
    overall_success_rate: round(clamp(0.88 + rng() * 0.06, 0.88, 0.94), 2),
    recommendations_generated_24h: Math.floor(rng() * 30) + 18,
    investigations_assisted_24h: Math.floor(rng() * 12) + 4,
    compliance_findings_24h: Math.floor(rng() * 8) + 2,
    risk_actions_24h: Math.floor(rng() * 20) + 10,
    avg_confidence_score: round(clamp(0.82 + rng() * 0.12, 0.80, 0.96), 2),
    pending_approvals: Math.floor(rng() * 6) + 2,
  };
}

export function buildAgentExecutions(tenant: string, asOf: Date, limit = 20): AgentExecution[] {
  const rng = mulberry32(fnv1a(tenant + ':exec:' + dayKey(asOf)));
  const statuses: Array<'completed' | 'escalated' | 'failed'> = ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'escalated', 'failed'];
  const inputSummaries = [
    'Customer portfolio batch — 1,240 accounts scanned',
    'Transaction feed — 8,552 events processed',
    'Claim submission queue — 143 claims evaluated',
    'Policy renewal batch — 2,100 policies scored',
    'Solvency stress run — 5 RBI scenarios applied',
    'Investigation queue — 34 active cases reviewed',
    'AML watchlist sync — 10,000 customer IDs screened',
    'Rule evaluation sweep — 30 active rules triggered',
    'IFRS 9 stage migration — 24,000 loan positions',
    'KYC expiry calendar — 890 records assessed',
  ];
  const outputSummaries = [
    'Identified 23 accounts for early intervention; 4 escalated to supervisor',
    'Flagged 7 high-velocity transactions; 2 auto-escalated to fraud team',
    'Approved 112 claims; rejected 18; 13 routed for human review',
    'Scored 387 lapse-risk policies; 42 recommended for retention call',
    'Solvency margin within limits; 1 scenario approaching buffer threshold',
    'Updated 28 case statuses; SLA breach flagged on 3 investigations',
    'Matched 4 customers against OFAC sanctions list; opened 2 new cases',
    'Fired 156 alerts; deduplicated to 89 unique customer events',
    'Stage 2 migrations up by 1.2%; ECL delta +KES 4.7M flagged for ALCO',
    'Triggered renewal workflows for 67 expiring KYC records',
  ];
  const executions: AgentExecution[] = [];
  const agentList = [...AGENT_REGISTRY];
  for (let i = 0; i < limit; i++) {
    const agent = agentList[i % agentList.length];
    const statusChoice = statuses[Math.floor(rng() * statuses.length)];
    const durationMs = Math.floor(rng() * 165000) + 15000;
    const startOffset = i * 3600000 + Math.floor(rng() * 1800000);
    const startedAt = new Date(asOf.getTime() - startOffset).toISOString();
    const finishedAt = statusChoice !== 'completed' && rng() > 0.7
      ? null
      : new Date(new Date(startedAt).getTime() + durationMs).toISOString();
    executions.push({
      execution_id: `exec-${fnv1a(tenant + i + dayKey(asOf)).toString(16).padStart(8, '0')}`,
      agent_id: agent.agent_id,
      agent_name: agent.name,
      tenant_id: tenant,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: durationMs,
      status: finishedAt ? statusChoice : 'running',
      input_summary: inputSummaries[i % inputSummaries.length],
      output_summary: outputSummaries[i % outputSummaries.length],
      confidence_score: round(clamp(0.72 + rng() * 0.24, 0.72, 0.96), 2),
      risk_level: pick([...RISK_LEVELS], rng),
      escalated_to: statusChoice === 'escalated' ? 'supervisor' : null,
    });
  }
  return executions;
}

export function buildAgentRecommendations(
  tenant: string,
  asOf: Date,
  riskFilter?: RiskLevel
): AgentRecommendation[] {
  const rng = mulberry32(fnv1a(tenant + ':rec:' + dayKey(asOf)));

  const templates: Array<{
    agent_id: string;
    agent_name: string;
    title: string;
    findings: string[];
    root_causes: string[];
    risk_drivers: string[];
    suggested_actions: string[];
    impact_assessment: string;
    risk_level: RiskLevel;
  }> = [
    {
      agent_id: 'agent-credit-risk',
      agent_name: 'Credit Risk Analyst',
      title: 'Elevated DPD 30+ Concentration in MSME Segment',
      findings: [
        'DPD 30+ in MSME segment increased 1.8pp month-on-month to 6.4%',
        'Geographic cluster identified in Tier-3 cities with >10% DPD concentration',
        '23 accounts show simultaneous CBS payment failure and bureau score drop',
        'Seasonal stress pattern correlates with Q4 procurement cycle delays',
      ],
      root_causes: [
        'Cash-flow mismatch due to delayed GST refunds in MSME segment',
        'Seasonal revenue dip in manufacturing sub-sector',
      ],
      risk_drivers: ['DPD movement', 'bureau score deterioration', 'geographic concentration'],
      suggested_actions: [
        'Initiate outbound call campaign for 23 flagged accounts within 48 hours',
        'Place 61 MSME accounts in enhanced monitoring with weekly bureau refresh',
        'Propose provisional moratorium for 12 accounts showing genuine stress',
        'Escalate 8 repeat-defaulters to Collections Orchestrator for field visits',
      ],
      impact_assessment: 'Unaddressed, this cluster could migrate 41 accounts to SMA-1 within 30 days, increasing Stage 2 ECL by an estimated KES 12.4M.',
      risk_level: 'high',
    },
    {
      agent_id: 'agent-fraud-detection',
      agent_name: 'Fraud Detection Sentinel',
      title: 'Coordinated Account Takeover Pattern Detected',
      findings: [
        '14 accounts show device-change followed by high-value transfer within 60 minutes',
        'New device geo-locations cluster in two cities not matching customer home address',
        'OTP success rate anomaly on affected accounts: 100% first-attempt on new devices',
        'Transaction amounts clustered just below reporting threshold — structuring signal',
      ],
      root_causes: [
        'Phishing campaign targeting mobile banking credentials identified via OSINT',
        'SIM-swap facilitation at two telecom outlets flagged by AML',
      ],
      risk_drivers: ['device fingerprint anomaly', 'geo-velocity breach', 'structuring pattern'],
      suggested_actions: [
        'Freeze 14 affected accounts pending owner verification call within 2 hours',
        'Trigger mandatory step-up authentication for all high-value transfers in affected region',
        'Report to FIU-IND under STR within 24 hours for 6 accounts with confirmed exposure',
        'Block originating IPs and device hashes across the network immediately',
      ],
      impact_assessment: 'Immediate exposure estimated at KES 8.7M across 14 accounts. Rapid freeze limits realised loss to KES 2.1M already transferred.',
      risk_level: 'critical',
    },
    {
      agent_id: 'agent-collections',
      agent_name: 'Collections Orchestrator',
      title: 'Field Visit Optimisation for DPD 60+ Bucket',
      findings: [
        '78 accounts in DPD 60-90 without a confirmed field contact in the past 15 days',
        'Existing promise-to-pay break rate at 41% — above the acceptable 30% threshold',
        '12 field officers have sub-optimal territory coverage based on GPS data',
        'Evening contact slots (5-8pm) show 2.3× higher contact success rate',
      ],
      root_causes: [
        'Inefficient territory assignment causing excessive travel time per visit',
        'Morning-only scheduling policy not aligned with borrower availability',
      ],
      risk_drivers: ['contact rate', 'promise break rate', 'territory efficiency'],
      suggested_actions: [
        'Reassign 12 officers using GPS-optimised territory clusters',
        'Shift 40% of field visits to 5-8pm window for corporate-employee borrowers',
        'Escalate 18 non-responsive accounts to legal notice issuance',
        'Introduce digital proof-of-visit for all field contacts to improve audit trail',
      ],
      impact_assessment: 'Territory optimisation expected to increase monthly contacts by 34%, improving bucket resolution rate from 18% to an estimated 27%.',
      risk_level: 'medium',
    },
    {
      agent_id: 'agent-portfolio-risk',
      agent_name: 'Portfolio Risk Monitor',
      title: 'Sector Concentration Breach: Real Estate Approaching RBI Limit',
      findings: [
        'Real estate exposure at 22.1% of total credit portfolio, approaching 25% RBI threshold',
        'CRE sub-segment grew 3.2% in the quarter on back of 8 large LAP disbursements',
        'Stressed CRE accounts (DPD 30+) at 4.8%, above residential at 2.1%',
        'GNPA in real estate segment projected to reach 5.5% if 3 large accounts default',
      ],
      root_causes: [
        'Aggressive LAP disbursement strategy in Q3 without adequate sector cap monitoring',
        'Under-estimation of CRE stress in macro model inputs',
      ],
      risk_drivers: ['sector concentration', 'CRE stress', 'GNPA trajectory'],
      suggested_actions: [
        'Pause new CRE disbursements until sector exposure drops below 20%',
        'Place 3 large LAP accounts under enhanced monitoring with quarterly LTV review',
        'Rebalance pipeline towards MSME and retail segments for next quarter',
        'Escalate sector concentration breach to ALCO in next monthly meeting',
      ],
      impact_assessment: 'Continued growth at current pace will breach RBI sector cap within 45 days, triggering mandatory reporting and potential supervisory action.',
      risk_level: 'high',
    },
    {
      agent_id: 'agent-claims',
      agent_name: 'Claims Intelligence Agent',
      title: 'Provider-Level Anomaly: Inflated Procedure Billing Pattern',
      findings: [
        'Provider ID PRV-0234 shows average bill 3.1× above peer group median for cardiac procedures',
        '94% of claims from this provider are for procedures requiring pre-authorisation',
        'Same 6 diagnostic codes appear in 87% of claims — pattern inconsistent with treatment diversity',
        'Provider pre-auth approval rate at 99.3% versus network average of 84.7%',
      ],
      root_causes: [
        'Pre-authorisation desk may have implicit approval relationship with this provider',
        'Diagnostic code gaming to maximise reimbursable procedure scope',
      ],
      risk_drivers: ['billing anomaly', 'pre-auth abuse', 'diagnostic code pattern'],
      suggested_actions: [
        'Place PRV-0234 on enhanced scrutiny list requiring dual-sign pre-authorisation',
        'Retrospective audit of last 90 days of claims from this provider',
        'Engage investigation team to conduct on-site medical record review',
        'Recover overpayments on 14 identified claims pending audit outcome',
      ],
      impact_assessment: 'Estimated overpayment exposure of KES 3.8M across 68 claims if billing pattern confirmed as fraudulent.',
      risk_level: 'high',
    },
    {
      agent_id: 'agent-insurance-fraud',
      agent_name: 'Insurance Fraud Investigator',
      title: 'Organised Ring Fraud Suspected — Personal Accident Cluster',
      findings: [
        '9 claims filed within 21 days share the same doctor, hospital, and agent code',
        'All 9 claimants have policies inception-dated within 3 months of claim',
        'Network graph analysis reveals 6 of 9 claimants share a common broker referral chain',
        'Claim narratives show textual similarity score of 0.91 (cosine) — scripted language suspected',
      ],
      root_causes: [
        'Agent-facilitated fraud ring using newly issued policies with short waiting period exploitation',
        'Weak inception-to-claim time controls in the underwriting workflow',
      ],
      risk_drivers: ['network linkage', 'timing pattern', 'narrative similarity'],
      suggested_actions: [
        'Suspend all 9 claims pending field investigation within 5 business days',
        'Refer agent code to compliance for mis-selling and fraudulent submission review',
        'Blacklist hospital and doctor pending investigation outcome',
        'File FIR with local police and report to IRDAI under fraud reporting obligation',
      ],
      impact_assessment: 'Total claims exposure of KES 6.2M. Precedent case in 2024 similar ring resulted in full recovery via FIR-backed attachment of assets.',
      risk_level: 'critical',
    },
    {
      agent_id: 'agent-policy-retention',
      agent_name: 'Policy Retention Optimizer',
      title: 'High Lapse Risk Cohort: ULIP Policies — Anniversary Month',
      findings: [
        '342 ULIP policies in lapse-risk quintile approaching their 3rd-year anniversary',
        'Fund value underperformance vs benchmark in the last 6 months for 67% of this cohort',
        'Agent contact rate for this cohort dropped to 23% in the past 90 days',
        'Surrender enquiry rate on digital channels 2.8× above cohort baseline this week',
      ],
      root_causes: [
        'Market underperformance reducing perceived product value',
        'Agent attrition in Q2 left 120 policies without an active servicing agent',
      ],
      risk_drivers: ['fund performance', 'agent contact gap', 'surrender intent signal'],
      suggested_actions: [
        'Assign 120 orphan policies to active agents within 5 days',
        'Launch personalised "fund switch" advisory campaign for 230 underperforming ULIPs',
        'Offer premium holiday of 3 months for 85 policies showing hardship signals',
        'Schedule retention manager calls for 42 highest-value policies in the cohort',
      ],
      impact_assessment: 'If unaddressed, estimated 18% lapse rate in this cohort would reduce renewal premium income by KES 41M and trigger adverse persistency reporting.',
      risk_level: 'medium',
    },
    {
      agent_id: 'agent-solvency',
      agent_name: 'Solvency Stress Tester',
      title: 'Solvency Margin Compression Under Pandemic Stress Scenario',
      findings: [
        'Available Solvency Margin (ASM) at 184% of Required — above 150% regulatory floor',
        'Pandemic scenario (-7% GDP, claims surge +40%) reduces ASM to 157% — approaching floor',
        'Reinsurance recoverable constitutes 38% of ASM — counterparty concentration risk',
        'Investment portfolio mark-to-market down 4.2% due to equity market stress assumptions',
      ],
      root_causes: [
        'Heavy reliance on single reinsurer for treaty cover',
        'Equity-heavy investment portfolio amplifies stress scenario impact',
      ],
      risk_drivers: ['solvency buffer', 'reinsurance concentration', 'investment portfolio stress'],
      suggested_actions: [
        'Diversify reinsurance panel by onboarding a second treaty reinsurer in Q3',
        'Review investment guidelines to reduce equity allocation from 28% to 22%',
        'Increase contingency reserves by KES 50M to provide a 15pp solvency buffer',
        'File proactive communication with IRDAI under early warning obligation',
      ],
      impact_assessment: 'Without action, a materialised pandemic stress could require emergency capital raise of KES 180M to stay above the 150% regulatory floor.',
      risk_level: 'high',
    },
    {
      agent_id: 'agent-compliance',
      agent_name: 'Regulatory Compliance Watcher',
      title: 'KYC Expiry Surge — 890 Renewals Due Within 30 Days',
      findings: [
        '890 customer KYC records expire within the next 30 days across 3 tenants',
        '214 of these are for accounts with outstanding loan balances above KES 1M',
        'Digital KYC completion rate in last cycle was only 61% — 39% required physical visits',
        'RBI circular mandates automated account freeze if KYC not renewed within 30 days of expiry',
      ],
      root_causes: [
        'Bulk KYC renewals deferred from Q2 now creating concentration',
        'Low digital channel adoption among older borrower segments',
      ],
      risk_drivers: ['KYC expiry', 'account freeze risk', 'compliance deadline'],
      suggested_actions: [
        'Trigger digital KYC re-verification campaign for 676 mobile-active customers immediately',
        'Schedule physical KYC camps for 214 rural branches in next 20 days',
        'Place 890 accounts on watch with auto-freeze scheduled for day 28',
        'Report KYC compliance status to RBI as part of monthly regulatory returns',
      ],
      impact_assessment: 'Failure to renew 214 high-value accounts risks operational freeze, customer friction, and potential RBI supervisory remarks in next inspection.',
      risk_level: 'critical',
    },
    {
      agent_id: 'agent-investigation',
      agent_name: 'Case Investigation Coordinator',
      title: 'SLA Breach Imminent — 11 High-Priority Investigations',
      findings: [
        '11 active investigations approaching the 72-hour SLA for gathering_evidence stage',
        '4 investigations have incomplete BIL §17 checklists with missing evidence steps',
        'Cross-case AML match detected: 3 investigations share a common transaction beneficiary',
        'Investigation officer availability reduced 30% due to annual leave in the current week',
      ],
      root_causes: [
        'Resource crunch from concurrent leave requests not being managed against active case load',
        'Evidence collection dependency on external party responses with no escalation path',
      ],
      risk_drivers: ['SLA breach', 'resource constraint', 'cross-case linkage'],
      suggested_actions: [
        'Reassign 6 cases to available officers within 4 hours to prevent SLA breach',
        'Escalate 3 linked investigations to senior investigator for consolidated review',
        'Trigger external evidence request reminders for 7 pending third-party responses',
        'Open maker-checker approval for 2 cases requiring case closure with partial evidence',
      ],
      impact_assessment: 'SLA breach on 11 cases will require regulatory explanation in next quarterly submission and impacts the team\'s compliance metrics.',
      risk_level: 'high',
    },
    {
      agent_id: 'agent-recovery',
      agent_name: 'Recovery Strategy Planner',
      title: 'OTS Opportunity Window Identified for 8 Large NPA Accounts',
      findings: [
        '8 NPA accounts with outstanding of KES 340M collectively show improved repayment intent signals',
        'Security cover at 1.4× outstanding — favourable haircut space for OTS settlement',
        'Borrowers in 3 of 8 accounts have approached relationship managers informally',
        'Legal track for 5 of 8 accounts has stalled at DRT for >18 months',
      ],
      root_causes: [
        'DRT backlog making legal recovery timeline unfavourable vs negotiated settlement',
        'Borrower businesses showing signs of revival post-pandemic stress',
      ],
      risk_drivers: ['recovery timeline', 'security cover', 'borrower intent'],
      suggested_actions: [
        'Open formal OTS dialogue with borrowers for all 8 accounts within 2 weeks',
        'Model three settlement scenarios (30/40/50% haircut) for board approval',
        'Suspend active legal proceedings for 5 DRT-stalled accounts while OTS is explored',
        'Flag KES 340M exposure to ALCO for provisioning release if OTS is accepted',
      ],
      impact_assessment: 'Conservative 40% haircut scenario would recover KES 204M, releasing KES 68M in provisions and improving GNPA ratio by 0.3pp.',
      risk_level: 'medium',
    },
    {
      agent_id: 'agent-governance',
      agent_name: 'AI Governance Auditor',
      title: 'Model Drift Alert — PD Model Challenger Requires Recalibration',
      findings: [
        'PD challenger model shows PSI of 0.28 on bureau_score feature — above 0.25 monitoring threshold',
        'Model AUC on rolling 90-day validation window dropped from 0.88 to 0.81',
        'SHAP feature importance ranking shifted — repayment_delay_streak overtook dpd_max_90d as top driver',
        'Calibration curve deviation of 12% in high-risk band (PD > 0.5)',
      ],
      root_causes: [
        'Population shift in borrower risk profile post-pandemic recovery normalisation',
        'Feature distribution drift in bureau score due to bureau methodology update in Q4',
      ],
      risk_drivers: ['PSI breach', 'AUC degradation', 'calibration drift'],
      suggested_actions: [
        'Trigger full model recalibration using latest 12 months of performance data',
        'Retain synthetic-trained champion until challenger recalibration is validated',
        'File model change notification with RBI model risk team',
        'Update SHAP explanation templates to reflect new top-feature ranking',
      ],
      impact_assessment: 'Uncalibrated model may under-score 8-12% of high-risk accounts, resulting in under-provisioning and delayed intervention for those borrowers.',
      risk_level: 'low',
    },
  ];

  const filtered = riskFilter
    ? templates.filter(t => t.risk_level === riskFilter)
    : templates;

  return filtered.map((tmpl, i) => ({
    recommendation_id: `rec-${fnv1a(tenant + tmpl.agent_id + i + dayKey(asOf)).toString(16).padStart(8, '0')}`,
    agent_id: tmpl.agent_id,
    agent_name: tmpl.agent_name,
    tenant_id: tenant,
    generated_at: new Date(asOf.getTime() - i * 1800000).toISOString(),
    title: tmpl.title,
    findings: tmpl.findings,
    root_causes: tmpl.root_causes,
    risk_drivers: tmpl.risk_drivers,
    suggested_actions: tmpl.suggested_actions,
    impact_assessment: tmpl.impact_assessment,
    confidence_score: round(clamp(0.78 + rng() * 0.18, 0.78, 0.96), 2),
    risk_level: tmpl.risk_level,
    requires_approval: tmpl.risk_level === 'critical' || tmpl.risk_level === 'high',
    approval_status: (tmpl.risk_level === 'critical' || tmpl.risk_level === 'high') ? 'pending' : null,
  }));
}

export function buildHumanApprovalQueue(tenant: string, asOf: Date): HumanApprovalItem[] {
  void mulberry32(fnv1a(tenant + ':approval:' + dayKey(asOf))); // seed for future deterministic extension
  const items: Array<{
    agent_id: string;
    agent_name: string;
    action_description: string;
    risk_level: RiskLevel;
    status: ApprovalStatus;
    reviewed_by: string | null;
    review_notes: string | null;
  }> = [
    {
      agent_id: 'agent-fraud-detection',
      agent_name: 'Fraud Detection Sentinel',
      action_description: 'Freeze 14 accounts suspected in coordinated account takeover campaign pending owner verification',
      risk_level: 'critical',
      status: 'pending',
      reviewed_by: null,
      review_notes: null,
    },
    {
      agent_id: 'agent-insurance-fraud',
      agent_name: 'Insurance Fraud Investigator',
      action_description: 'Suspend 9 claims and refer agent code for fraudulent submission review to compliance',
      risk_level: 'critical',
      status: 'escalated',
      reviewed_by: 'senior.investigator',
      review_notes: 'Escalated to Head of Fraud for sign-off before FIR filing',
    },
    {
      agent_id: 'agent-compliance',
      agent_name: 'Regulatory Compliance Watcher',
      action_description: 'Initiate auto-freeze schedule for 214 high-value accounts with KYC expiry in 28 days',
      risk_level: 'critical',
      status: 'pending',
      reviewed_by: null,
      review_notes: null,
    },
    {
      agent_id: 'agent-credit-risk',
      agent_name: 'Credit Risk Analyst',
      action_description: 'Grant provisional moratorium to 12 MSME accounts showing genuine cash-flow stress',
      risk_level: 'high',
      status: 'approved',
      reviewed_by: 'risk.supervisor',
      review_notes: 'Approved — accounts meet board-approved moratorium criteria for seasonal stress',
    },
    {
      agent_id: 'agent-portfolio-risk',
      agent_name: 'Portfolio Risk Monitor',
      action_description: 'Pause new CRE disbursements until sector exposure drops below 20% of total portfolio',
      risk_level: 'high',
      status: 'pending',
      reviewed_by: null,
      review_notes: null,
    },
    {
      agent_id: 'agent-recovery',
      agent_name: 'Recovery Strategy Planner',
      action_description: 'Open formal OTS negotiation and suspend active DRT proceedings for 5 accounts',
      risk_level: 'high',
      status: 'pending',
      reviewed_by: null,
      review_notes: null,
    },
  ];

  return items.map((item, i) => {
    const generatedAt = new Date(asOf.getTime() - i * 7200000);
    const expiresAt = new Date(generatedAt.getTime() + 86400000);
    return {
      item_id: `appr-${fnv1a(tenant + item.agent_id + i + dayKey(asOf)).toString(16).padStart(8, '0')}`,
      agent_id: item.agent_id,
      agent_name: item.agent_name,
      action_description: item.action_description,
      risk_level: item.risk_level,
      generated_at: generatedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      status: item.status,
      requested_by: item.agent_name,
      reviewed_by: item.reviewed_by,
      review_notes: item.review_notes,
    };
  });
}

export function buildAgentCollaborations(tenant: string, asOf: Date): AgentCollaboration[] {
  const rng = mulberry32(fnv1a(tenant + ':collab:' + dayKey(asOf)));
  const pairs: Array<{
    from_agent_id: string;
    from_agent_name: string;
    to_agent_id: string;
    to_agent_name: string;
    collaboration_type: CollaborationType;
    status: 'active' | 'completed';
    outcome_summary: string;
  }> = [
    {
      from_agent_id: 'agent-fraud-detection',
      from_agent_name: 'Fraud Detection Sentinel',
      to_agent_id: 'agent-investigation',
      to_agent_name: 'Case Investigation Coordinator',
      collaboration_type: 'handoff',
      status: 'active',
      outcome_summary: 'Fraud signals for 7 high-confidence accounts handed off for formal investigation with full evidence package',
    },
    {
      from_agent_id: 'agent-claims',
      from_agent_name: 'Claims Intelligence Agent',
      to_agent_id: 'agent-compliance',
      to_agent_name: 'Regulatory Compliance Watcher',
      collaboration_type: 'parallel',
      status: 'active',
      outcome_summary: 'Joint review of provider PRV-0234 billing anomaly for IRDAI reporting requirement',
    },
    {
      from_agent_id: 'agent-credit-risk',
      from_agent_name: 'Credit Risk Analyst',
      to_agent_id: 'agent-executive-briefing',
      to_agent_name: 'Executive Briefing Engine',
      collaboration_type: 'sequential',
      status: 'completed',
      outcome_summary: 'MSME DPD analysis packaged into daily CRO briefing with actionable intervention summary',
    },
    {
      from_agent_id: 'agent-portfolio-risk',
      from_agent_name: 'Portfolio Risk Monitor',
      to_agent_id: 'agent-governance',
      to_agent_name: 'AI Governance Auditor',
      collaboration_type: 'sequential',
      status: 'active',
      outcome_summary: 'CRE concentration data forwarded to governance for inclusion in next model risk report',
    },
    {
      from_agent_id: 'agent-insurance-fraud',
      from_agent_name: 'Insurance Fraud Investigator',
      to_agent_id: 'agent-investigation',
      to_agent_name: 'Case Investigation Coordinator',
      collaboration_type: 'escalation',
      status: 'active',
      outcome_summary: 'PA ring fraud case escalated to senior investigation officer for coordinated FIR filing',
    },
    {
      from_agent_id: 'agent-compliance',
      from_agent_name: 'Regulatory Compliance Watcher',
      to_agent_id: 'agent-executive-briefing',
      to_agent_name: 'Executive Briefing Engine',
      collaboration_type: 'parallel',
      status: 'completed',
      outcome_summary: 'KYC expiry risk summary incorporated into weekly ALCO pack for board awareness',
    },
    {
      from_agent_id: 'agent-recovery',
      from_agent_name: 'Recovery Strategy Planner',
      to_agent_id: 'agent-governance',
      to_agent_name: 'AI Governance Auditor',
      collaboration_type: 'handoff',
      status: 'completed',
      outcome_summary: 'OTS scenario models reviewed by governance for model risk compliance before board submission',
    },
  ];

  return pairs.map((pair, i) => ({
    collaboration_id: `collab-${fnv1a(tenant + pair.from_agent_id + i + dayKey(asOf)).toString(16).padStart(8, '0')}`,
    from_agent_id: pair.from_agent_id,
    from_agent_name: pair.from_agent_name,
    to_agent_id: pair.to_agent_id,
    to_agent_name: pair.to_agent_name,
    collaboration_type: pair.collaboration_type,
    started_at: new Date(asOf.getTime() - i * 5400000 - Math.floor(rng() * 3600000)).toISOString(),
    message_count: Math.floor(rng() * 10) + 3,
    status: pair.status,
    outcome_summary: pair.outcome_summary,
  }));
}

export function buildExecutiveBriefing(tenant: string, briefingType: BriefingType, asOf: Date): ExecutiveBriefing {
  const rng = mulberry32(fnv1a(tenant + ':brief:' + briefingType + ':' + dayKey(asOf)));
  const periodLabel = briefingType === 'daily' ? 'Today' : briefingType === 'weekly' ? 'This Week' : 'This Month';
  const riskAppetiteOptions: Array<'within_limits' | 'approaching_limit' | 'breach'> = ['within_limits', 'within_limits', 'approaching_limit'];

  return {
    briefing_id: `brief-${fnv1a(tenant + briefingType + dayKey(asOf)).toString(16).padStart(8, '0')}`,
    type: briefingType,
    generated_at: asOf.toISOString(),
    period_label: periodLabel,
    top_risks: [
      {
        title: 'KYC Expiry Compliance Deadline',
        level: 'critical',
        agent_id: 'agent-compliance',
        summary: '890 KYC records expire within 30 days; 214 high-value accounts at risk of mandatory freeze if not renewed.',
      },
      {
        title: 'Coordinated Account Takeover Campaign',
        level: 'critical',
        agent_id: 'agent-fraud-detection',
        summary: '14 accounts under suspected coordinated takeover; KES 8.7M exposure with KES 2.1M already at risk.',
      },
      {
        title: 'Real Estate Sector Concentration Approaching Regulatory Limit',
        level: 'high',
        agent_id: 'agent-portfolio-risk',
        summary: 'CRE exposure at 22.1% approaching the 25% RBI cap; disbursement pause recommended.',
      },
    ],
    emerging_risks: [
      'Solvency margin compression under pandemic scenario — ASM at 157% under stress vs 184% base',
      'PD model drift detected — challenger model AUC declined 8pp in rolling 90-day window',
      'MSME DPD 30+ cluster in Tier-3 cities — seasonal stress expected to peak in Q4',
      'Insurance fraud ring pattern emerging in personal accident segment — FIR filing pending',
    ],
    compliance_risks: [
      'AML STR filing due within 24 hours for 6 confirmed account takeover accounts',
      'IRDAI provider fraud reporting obligation triggered for PRV-0234 investigation',
      'RBI IFRS 9 model validation report overdue by 15 days — governance agent offline',
      'PA ring fraud requires FIR and IRDAI notification within 48 hours of confirmation',
    ],
    investigation_status: {
      total_active: Math.floor(rng() * 20) + 28,
      high_priority: Math.floor(rng() * 8) + 8,
      avg_resolution_days: round(clamp(4.5 + rng() * 3, 4, 8), 1),
    },
    forecast_summary: `${periodLabel} outlook: portfolio stress indicators are elevated in MSME and CRE segments. Fraud signals require immediate human intervention. Compliance calendar is critical with KYC batch expiry creating operational risk. Solvency buffers remain above regulatory minimums but require proactive management. AI agents have generated ${Math.floor(rng() * 15) + 20} actionable recommendations; ${Math.floor(rng() * 5) + 4} require human approval within 24 hours.`,
    risk_appetite_status: riskAppetiteOptions[Math.floor(rng() * riskAppetiteOptions.length)],
    confidence_score: round(clamp(0.84 + rng() * 0.10, 0.84, 0.94), 2),
  };
}

export function buildAgentWorkbench(tenant: string, asOf: Date): AgentWorkbenchEntry[] {
  const rng = mulberry32(fnv1a(tenant + ':workbench:' + dayKey(asOf)));
  return AGENT_REGISTRY.map(agent => ({
    agent_id: agent.agent_id,
    name: agent.name,
    type: agent.type,
    domain: agent.domain,
    state: agent.state,
    last_execution: agent.last_execution,
    success_rate: round(clamp(agent.success_rate + (rng() - 0.5) * 0.04, 0.70, 0.99), 2),
    escalation_count: agent.escalation_count,
    avg_resolution_ms: agent.avg_resolution_ms,
    is_enabled: agent.is_enabled,
  }));
}
