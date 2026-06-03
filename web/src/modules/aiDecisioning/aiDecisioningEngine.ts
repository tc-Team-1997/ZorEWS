/**
 * Advanced AI Decisioning Layer — orchestration engine.
 *
 * Pure-function engine — no I/O, no React, no stores.
 * Acts as the intelligence orchestration layer above all 18 prior IA centers.
 * Connects: Digital Twin + Autonomous Agents + Predictive Risk + Investigation
 *           + Regulatory Compliance + Data Fabric + Governance.
 *
 * Phase 19 IA overlay — additive; every prior module untouched.
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
function r3(v: number): number { return Math.round(v * 1000) / 1000; }
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function pick<T>(arr: readonly T[], rng: () => number): T { return arr[Math.floor(rng() * arr.length)]; }

// ─────────────────────────────────────────────────────────────────────────────
// Closed Enums
// ─────────────────────────────────────────────────────────────────────────────

export const DECISION_TYPES = [
  'credit_approval', 'loan_limit', 'interest_rate', 'collateral_assessment',
  'policy_underwriting', 'premium_pricing', 'claims_settlement', 'fraud_intervention',
  'kyc_verification', 'aml_transaction', 'npa_classification', 'collections_strategy',
  'regulatory_filing', 'case_escalation', 'investment_limit',
] as const;
export type DecisionType = typeof DECISION_TYPES[number];

export const DECISION_DOMAINS = ['banking', 'insurance', 'enterprise'] as const;
export type DecisionDomain = typeof DECISION_DOMAINS[number];

export const DECISION_OUTCOMES = ['approve', 'reject', 'refer', 'review', 'escalate', 'flag', 'monitor'] as const;
export type DecisionOutcome = typeof DECISION_OUTCOMES[number];

export const APPROVAL_STATES = ['draft', 'submitted', 'under_review', 'approved', 'rejected', 'executed'] as const;
export type ApprovalState = typeof APPROVAL_STATES[number];

export const RISK_BANDS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskBand = typeof RISK_BANDS[number];

export const SOURCE_SYSTEMS = [
  'Data Fabric', 'Data Quality Engine', 'Rule Engine', 'AI Models',
  'Predictive Risk Center', 'Investigation Center', 'Digital Twin',
  'Autonomous Agents', 'Regulatory Compliance', 'Audit Trail',
] as const;
export type SourceSystem = typeof SOURCE_SYSTEMS[number];

// ─────────────────────────────────────────────────────────────────────────────
// RBAC
// ─────────────────────────────────────────────────────────────────────────────

export const AI_DECISIONING_ROLES: readonly string[] = [
  'admin', 'supervisor', 'risk_analyst', 'super_admin', 'country_admin',
  'bank_admin', 'insurance_admin', 'fraud_analyst', 'auditor',
  'compliance_officer', 'operations_user', 'executive', 'cdo', 'cro',
  'ceo', 'coo', 'board_member', 'operations_manager', 'country_head', 'investigation_officer',
];
export function canAccessAiDecisioningCenter(roles: readonly string[] | undefined): boolean {
  if (!roles || roles.length === 0) return false;
  const allowed = new Set(AI_DECISIONING_ROLES);
  for (const r of roles) { if (allowed.has(r)) return true; }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — Decision Command Center KPIs
// ─────────────────────────────────────────────────────────────────────────────

export interface DecisionCommandKpis {
  total_active_decisions: number;
  pending_approval: number;
  high_risk_decisions: number;
  auto_approved_24h: number;
  escalated_decisions: number;
  rejected_decisions: number;
  decision_accuracy_pct: number;
  ai_confidence_avg: number;
  decisions_by_domain: { banking: number; insurance: number; enterprise: number };
  decisions_by_risk: Record<RiskBand, number>;
  sla_compliance_pct: number;
  processing_speed_ms: number;
}

export function buildDecisionCommandKpis(tenant: string, asOf: Date): DecisionCommandKpis {
  const rng = mulberry32(fnv1a(`${tenant}:cmd-kpis:${dayKey(asOf)}`));
  const total = Math.floor(3200 + rng() * 1800);
  const banking = Math.floor(total * (0.45 + rng() * 0.1));
  const insurance = Math.floor(total * (0.30 + rng() * 0.08));
  const enterprise = total - banking - insurance;
  return {
    total_active_decisions: total,
    pending_approval: Math.floor(65 + rng() * 145),
    high_risk_decisions: Math.floor(total * (0.07 + rng() * 0.05)),
    auto_approved_24h: Math.floor(total * (0.48 + rng() * 0.10)),
    escalated_decisions: Math.floor(12 + rng() * 28),
    rejected_decisions: Math.floor(total * (0.14 + rng() * 0.08)),
    decision_accuracy_pct: r2(93 + rng() * 5),
    ai_confidence_avg: r3(0.83 + rng() * 0.12),
    decisions_by_domain: { banking, insurance, enterprise },
    decisions_by_risk: {
      low: Math.floor(total * 0.52),
      medium: Math.floor(total * 0.28),
      high: Math.floor(total * 0.14),
      critical: Math.floor(total * 0.06),
    },
    sla_compliance_pct: r2(94 + rng() * 4),
    processing_speed_ms: Math.floor(380 + rng() * 420),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — Decision Studio (Full Reasoning Chain)
// ─────────────────────────────────────────────────────────────────────────────

export interface ReasoningChainNode {
  step: number;
  system: SourceSystem;
  action: string;
  output: string;
  confidence: number;
  data_points_used: number;
  latency_ms: number;
}

export interface DecisionStudioItem {
  decision_id: string;
  decision_type: DecisionType;
  domain: DecisionDomain;
  entity_id: string;
  entity_name: string;
  outcome: DecisionOutcome;
  risk_band: RiskBand;
  confidence_score: number;
  enterprise_score: number;
  amount_cr: number | null;
  decided_at: string;
  approval_state: ApprovalState;
  reasoning_chain: ReasoningChainNode[];
  sources_consulted: SourceSystem[];
  rules_triggered: string[];
  models_used: string[];
  agents_consulted: string[];
  compliance_flags: string[];
  regulatory_impact: string;
  business_impact: string;
  risk_impact: string;
  recommendation: string;
  transparency_score: number;
  explanation: string;
}

const ENTITY_NAMES = [
  'M/s Sunrise Infrastructure Ltd', 'Rajesh Kumar Sharma', 'Bharat Auto Components',
  'Star Health Policy SH-442821', 'Metro Developers Pvt Ltd', 'Kavitha Subramaniam',
  'ICICI Lombard Claim CL-28341', 'Alliance MSME Finance', 'TXN-BNK-928374-OFAC',
  'KYC-CUS-004821-VERIFY', 'SBI Life Policy LI-882143', 'National Construction Co',
];

const REASONING_ACTIONS: Partial<Record<SourceSystem, string[]>> = {
  'Data Fabric': ['Ingested 47 cross-source data points', 'Unified customer 360° profile assembled', 'Resolved 3 data quality warnings'],
  'Data Quality Engine': ['Quality score: 92/100', 'Verified 12 critical fields', 'Flagged 1 anomalous transaction pattern'],
  'Rule Engine': ['Evaluated 28 active rules', 'Triggered 4 policy rules', 'No hard-stop violations'],
  'AI Models': ['PD Model v3.2: score 0.24', 'Fraud Model v4.1: score 0.08', 'LGD Model v2.1: 0.42'],
  'Predictive Risk Center': ['30-day risk: stable', '90-day risk: mild deterioration projected', 'EWS signals: 2 amber'],
  'Investigation Center': ['No open investigations', 'Previous investigation closed — resolved', 'Evidence quality: strong'],
  'Digital Twin': ['Approve scenario: NPA risk +2bp', 'Reject scenario: relationship value loss ₹8Cr', 'Simulation confidence: 0.87'],
  'Autonomous Agents': ['Credit Risk Agent: approve', 'Compliance Agent: no objection', 'Agent consensus: 4/5 approve'],
  'Regulatory Compliance': ['RBI IRACP: compliant', 'CIBIL reporting: required on approval', 'Fair Practice Code: verified'],
  'Audit Trail': ['Decision chain logged (SHA-256)', 'Audit event queued', 'Immutable record created'],
};

export function buildDecisionStudio(tenant: string, asOf: Date, count = 8): DecisionStudioItem[] {
  const rng = mulberry32(fnv1a(`${tenant}:studio:${dayKey(asOf)}`));
  const typesByDomain: Record<DecisionDomain, DecisionType[]> = {
    banking: ['credit_approval', 'loan_limit', 'interest_rate', 'npa_classification', 'collections_strategy'],
    insurance: ['policy_underwriting', 'premium_pricing', 'claims_settlement', 'fraud_intervention'],
    enterprise: ['kyc_verification', 'aml_transaction', 'regulatory_filing', 'case_escalation'],
  };

  return Array.from({ length: count }, (_, i) => {
    const domain = pick(DECISION_DOMAINS, rng);
    const type = pick(typesByDomain[domain], rng);
    const outcome = pick(DECISION_OUTCOMES, rng);
    const conf = clamp(0.60 + rng() * 0.38, 0.60, 0.98);
    const riskBand: RiskBand = rng() < 0.12 ? 'critical' : rng() < 0.3 ? 'high' : rng() < 0.6 ? 'medium' : 'low';
    const chain: ReasoningChainNode[] = SOURCE_SYSTEMS.slice(0, Math.floor(6 + rng() * 4)).map((sys, step) => ({
      step: step + 1,
      system: sys,
      action: pick(REASONING_ACTIONS[sys] ?? ['Processed successfully'], rng),
      output: `Signal ${step + 1}: ${rng() > 0.5 ? 'favorable' : 'within tolerance'}`,
      confidence: r3(0.72 + rng() * 0.25),
      data_points_used: Math.floor(8 + rng() * 42),
      latency_ms: Math.floor(15 + rng() * 185),
    }));

    const enterpriseScore = Math.floor(
      clamp((conf * 40) + (riskBand === 'low' ? 30 : riskBand === 'medium' ? 20 : riskBand === 'high' ? 10 : 0) + rng() * 30, 30, 98)
    );

    return {
      decision_id: `DEC-${String(i + 1).padStart(4, '0')}-${dayKey(asOf).replace(/-/g, '')}`,
      decision_type: type,
      domain,
      entity_id: `ENT-${String(Math.floor(rng() * 99999)).padStart(5, '0')}`,
      entity_name: pick(ENTITY_NAMES, rng),
      outcome,
      risk_band: riskBand,
      confidence_score: r3(conf),
      enterprise_score: enterpriseScore,
      amount_cr: rng() > 0.3 ? r2(5 + rng() * 495) : null,
      decided_at: new Date(asOf.getTime() - Math.floor(rng() * 24) * 3600000).toISOString(),
      approval_state: pick(APPROVAL_STATES, rng),
      reasoning_chain: chain,
      sources_consulted: chain.map(c => c.system),
      rules_triggered: [`RULE-${Math.floor(rng() * 900 + 100)}`, `RULE-${Math.floor(rng() * 900 + 100)}`, `RULE-${Math.floor(rng() * 900 + 100)}`].slice(0, Math.floor(1 + rng() * 3)),
      models_used: domain === 'banking' ? ['PD-XGB-v3.2', 'LGD-LIN-v2.1'] : domain === 'insurance' ? ['UW-XGB-v2.4', 'FRAUD-NN-v4.2'] : ['KYC-CNN-v2.0', 'AML-BERT-v1.9'],
      agents_consulted: ['Credit Risk Agent', 'Compliance Agent', outcome === 'flag' ? 'Fraud Agent' : 'Executive Agent'].slice(0, Math.floor(2 + rng() * 2)),
      compliance_flags: riskBand === 'critical' ? ['RBI IRACP Stage 3 threshold breach', 'Mandatory CAR reporting required'] : riskBand === 'high' ? ['Enhanced due diligence required'] : [],
      regulatory_impact: riskBand === 'critical' ? 'Mandatory RBI/IRDAI reporting within 7 days' : riskBand === 'high' ? 'Board Risk Committee notification required' : 'Standard reporting cycle applies',
      business_impact: outcome === 'approve' ? 'Revenue impact: +₹2.4–₹8.6 Cr over loan tenure' : outcome === 'reject' ? 'Opportunity cost: ₹1.2–₹4.8 Cr; relationship risk: moderate' : 'Deferred income recognition; additional processing cost ₹0.8L',
      risk_impact: riskBand === 'critical' ? 'ECL provision requirement: ₹12–₹45 Cr' : riskBand === 'high' ? 'Stage 2 migration risk; additional provision ₹2–₹8 Cr' : 'Within standard risk appetite tolerance',
      recommendation: outcome === 'approve' ? 'Proceed with standard documentation and disbursement within 48h' : outcome === 'reject' ? 'Issue decline notice per Fair Practice Code within 7 days' : outcome === 'refer' ? 'Route to Credit Committee; resolution within 5 business days' : 'Assign to senior analyst; SLA: 24 hours',
      transparency_score: Math.floor(72 + rng() * 26),
      explanation: `Decision generated using ${chain.length} source systems. Primary driver: ${pick(['credit bureau score', 'repayment behavior', 'income adequacy', 'sector exposure', 'fraud signal strength', 'KYC completion status'], rng)}. Enterprise consensus: ${Math.floor(conf * 100)}% confidence across all models.`,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — Decision Graph (Visual Lineage)
// ─────────────────────────────────────────────────────────────────────────────

export interface DecisionGraphNode {
  id: string;
  label: string;
  system: SourceSystem | 'Decision' | 'Outcome';
  type: 'source' | 'processor' | 'decision' | 'outcome';
  confidence: number;
  status: 'active' | 'degraded' | 'healthy';
  data_points: number;
}

export interface DecisionGraphEdge {
  from: string;
  to: string;
  label: string;
  confidence_propagation: number;
}

export interface DecisionGraph {
  nodes: DecisionGraphNode[];
  edges: DecisionGraphEdge[];
  overall_confidence: number;
  critical_path: string[];
}

export function buildDecisionGraph(tenant: string, asOf: Date): DecisionGraph {
  const rng = mulberry32(fnv1a(`${tenant}:graph:${dayKey(asOf)}`));

  const nodes: DecisionGraphNode[] = [
    { id: 'n1', label: 'Data Fabric',           system: 'Data Fabric',           type: 'source',    confidence: r3(0.90 + rng() * 0.08), status: 'healthy',  data_points: Math.floor(200 + rng() * 300) },
    { id: 'n2', label: 'Data Quality',          system: 'Data Quality Engine',   type: 'processor', confidence: r3(0.88 + rng() * 0.09), status: 'healthy',  data_points: Math.floor(150 + rng() * 200) },
    { id: 'n3', label: 'Rule Engine',           system: 'Rule Engine',           type: 'processor', confidence: r3(0.93 + rng() * 0.06), status: 'healthy',  data_points: Math.floor(25 + rng() * 35) },
    { id: 'n4', label: 'AI Models',             system: 'AI Models',             type: 'processor', confidence: r3(0.85 + rng() * 0.12), status: 'healthy',  data_points: Math.floor(60 + rng() * 80) },
    { id: 'n5', label: 'Predictive Risk',       system: 'Predictive Risk Center', type: 'processor', confidence: r3(0.82 + rng() * 0.12), status: rng() > 0.9 ? 'degraded' : 'healthy', data_points: Math.floor(40 + rng() * 60) },
    { id: 'n6', label: 'Investigation',         system: 'Investigation Center',  type: 'processor', confidence: r3(0.87 + rng() * 0.10), status: 'healthy',  data_points: Math.floor(15 + rng() * 25) },
    { id: 'n7', label: 'Digital Twin Sim',      system: 'Digital Twin',          type: 'processor', confidence: r3(0.84 + rng() * 0.11), status: 'healthy',  data_points: Math.floor(10 + rng() * 20) },
    { id: 'n8', label: 'AI Agent Consensus',    system: 'Autonomous Agents',     type: 'processor', confidence: r3(0.86 + rng() * 0.11), status: 'healthy',  data_points: Math.floor(8 + rng() * 12) },
    { id: 'n9', label: 'Regulatory Check',      system: 'Regulatory Compliance', type: 'processor', confidence: r3(0.91 + rng() * 0.07), status: 'healthy',  data_points: Math.floor(20 + rng() * 30) },
    { id: 'n10',label: 'AI DECISION',           system: 'Decision' as const,     type: 'decision',  confidence: r3(0.87 + rng() * 0.10), status: 'active',   data_points: Math.floor(500 + rng() * 600) },
    { id: 'n11',label: 'Approval Chain',        system: 'Audit Trail',           type: 'processor', confidence: r3(0.99), status: 'healthy', data_points: 1 },
    { id: 'n12',label: 'OUTCOME',               system: 'Outcome' as const,      type: 'outcome',   confidence: r3(0.95 + rng() * 0.04), status: 'active',   data_points: 1 },
  ];

  const edges: DecisionGraphEdge[] = [
    { from: 'n1', to: 'n2',  label: 'Raw data', confidence_propagation: 0.95 },
    { from: 'n2', to: 'n3',  label: 'Clean data', confidence_propagation: 0.92 },
    { from: 'n2', to: 'n4',  label: 'Feature vectors', confidence_propagation: 0.90 },
    { from: 'n3', to: 'n10', label: 'Rule signals', confidence_propagation: 0.93 },
    { from: 'n4', to: 'n5',  label: 'Model scores', confidence_propagation: 0.88 },
    { from: 'n4', to: 'n10', label: 'Model output', confidence_propagation: 0.87 },
    { from: 'n5', to: 'n10', label: 'Risk forecast', confidence_propagation: 0.84 },
    { from: 'n6', to: 'n10', label: 'Investigation findings', confidence_propagation: 0.89 },
    { from: 'n7', to: 'n10', label: 'Simulation results', confidence_propagation: 0.85 },
    { from: 'n8', to: 'n10', label: 'Agent consensus', confidence_propagation: 0.87 },
    { from: 'n9', to: 'n10', label: 'Compliance clearance', confidence_propagation: 0.91 },
    { from: 'n10',to: 'n11', label: 'Decision output', confidence_propagation: 0.99 },
    { from: 'n11',to: 'n12', label: 'Executed decision', confidence_propagation: 0.99 },
  ];

  return {
    nodes,
    edges,
    overall_confidence: r3(nodes.reduce((s, n) => s + n.confidence, 0) / nodes.length),
    critical_path: ['n1', 'n2', 'n4', 'n10', 'n11', 'n12'],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — Recommendation Engine
// ─────────────────────────────────────────────────────────────────────────────

export interface AiRecommendation {
  rec_id: string;
  decision_type: DecisionType;
  domain: DecisionDomain;
  action: string;
  rationale: string;
  confidence: number;
  risk_score: number;
  expected_impact: string;
  source_agent: string;
  risk_band: RiskBand;
  urgency: 'immediate' | 'within_24h' | 'within_week' | 'routine';
}

const BANKING_ACTIONS = ['Increase Monitoring', 'Freeze Account', 'Escalate to Investigation', 'Restrict Transactions', 'Upgrade Risk Category', 'Close Alert', 'Trigger Recovery', 'Collateral Top-up Request'];
const INSURANCE_ACTIONS = ['Escalate Claim', 'Approve Claim', 'Reject Claim', 'Fraud Investigation', 'Additional Verification', 'Policy Monitoring', 'SIU Referral', 'Reinsurance Trigger'];
const ENTERPRISE_ACTIONS = ['KYC Refresh', 'AML STR Filing', 'Board Escalation', 'Regulatory Disclosure', 'Case Reopening', 'Compliance Audit', 'Governance Review', 'Recovery Initiation'];

export function buildRecommendations(tenant: string, asOf: Date, count = 15): AiRecommendation[] {
  const rng = mulberry32(fnv1a(`${tenant}:recs:${dayKey(asOf)}`));
  const agents = ['Credit Risk Agent', 'Fraud Agent', 'Collections Agent', 'Compliance Agent', 'Investigation Agent', 'Recovery Agent', 'Executive Agent'];
  const urgencies: Array<'immediate' | 'within_24h' | 'within_week' | 'routine'> = ['immediate', 'within_24h', 'within_week', 'routine'];
  const urgencyWeights = [0.15, 0.30, 0.35, 0.20];

  function pickUrgency(): typeof urgencies[number] {
    const r = rng();
    let c = 0;
    for (let i = 0; i < urgencyWeights.length; i++) {
      c += urgencyWeights[i];
      if (r < c) return urgencies[i];
    }
    return 'routine';
  }

  const domainActions: Record<DecisionDomain, string[]> = {
    banking: BANKING_ACTIONS,
    insurance: INSURANCE_ACTIONS,
    enterprise: ENTERPRISE_ACTIONS,
  };

  return Array.from({ length: count }, (_, i) => {
    const domain = pick(DECISION_DOMAINS, rng);
    const action = pick(domainActions[domain], rng);
    const conf = r3(0.65 + rng() * 0.33);
    const riskScore = r2(30 + rng() * 65);
    const urgency = pickUrgency();
    const riskBand: RiskBand = urgency === 'immediate' ? 'critical' : urgency === 'within_24h' ? 'high' : urgency === 'within_week' ? 'medium' : 'low';

    return {
      rec_id: `REC-${String(i + 1).padStart(3, '0')}-${dayKey(asOf).replace(/-/g, '')}`,
      decision_type: pick([...DECISION_TYPES] as DecisionType[], rng),
      domain,
      action,
      rationale: `${pick(agents, rng)} detected ${pick(['anomalous pattern', 'threshold breach', 'risk signal', 'behavioral shift', 'policy trigger', 'regulatory flag'], rng)} with ${Math.floor(conf * 100)}% confidence. Recommended action aligns with ${domain} risk policy.`,
      confidence: conf,
      risk_score: riskScore,
      expected_impact: `${pick(['Loss prevention', 'Risk reduction', 'Compliance assurance', 'Recovery improvement', 'Fraud deterrence'], rng)}: ₹${r2(2 + rng() * 48)} Cr over 12 months`,
      source_agent: pick(agents, rng),
      risk_band: riskBand,
      urgency,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 5 — Decision Approval Workflow
// ─────────────────────────────────────────────────────────────────────────────

export interface ApprovalWorkflowItem {
  workflow_id: string;
  decision_id: string;
  decision_type: DecisionType;
  entity_name: string;
  amount_cr: number | null;
  risk_band: RiskBand;
  current_state: ApprovalState;
  maker: string;
  maker_submitted_at: string | null;
  checker: string | null;
  checker_reviewed_at: string | null;
  checker_comments: string | null;
  approver: string | null;
  approver_reviewed_at: string | null;
  approver_comments: string | null;
  sla_hours: number;
  sla_breached: boolean;
  justification: string;
  priority: 'critical' | 'high' | 'normal';
}

const MAKERS = ['analyst.credit@bank.com', 'uw.health@insurer.com', 'aml.officer@bank.com', 'risk.analyst@bank.com'];
const CHECKERS = ['senior.credit@bank.com', 'chief.uw@insurer.com', 'compliance.lead@bank.com'];
const APPROVERS = ['cro@bank.com', 'md.banking@bank.com', 'chief.compliance@bank.com'];

export function buildApprovalWorkflow(tenant: string, asOf: Date): ApprovalWorkflowItem[] {
  const rng = mulberry32(fnv1a(`${tenant}:approval:${dayKey(asOf)}`));
  const count = Math.floor(10 + rng() * 15);

  return Array.from({ length: count }, (_, i) => {
    const state = pick(APPROVAL_STATES, rng);
    const riskBand: RiskBand = rng() < 0.15 ? 'critical' : rng() < 0.35 ? 'high' : rng() < 0.65 ? 'medium' : 'low';
    const sla = riskBand === 'critical' ? 4 : riskBand === 'high' ? 24 : 48;
    const submittedAgo = Math.floor(rng() * 72);
    const submittedAt = state !== 'draft' ? new Date(asOf.getTime() - submittedAgo * 3600000).toISOString() : null;
    const checkedAt = (state === 'under_review' || state === 'approved' || state === 'rejected' || state === 'executed') && submittedAt
      ? new Date(new Date(submittedAt).getTime() + Math.floor(2 + rng() * 6) * 3600000).toISOString() : null;
    const approvedAt = (state === 'approved' || state === 'executed') && checkedAt
      ? new Date(new Date(checkedAt).getTime() + Math.floor(1 + rng() * 4) * 3600000).toISOString() : null;
    const slaBreached = submittedAt ? (asOf.getTime() - new Date(submittedAt).getTime()) / 3600000 > sla && state !== 'approved' && state !== 'executed' : false;

    return {
      workflow_id: `WF-${String(i + 1).padStart(3, '0')}-${dayKey(asOf).replace(/-/g, '')}`,
      decision_id: `DEC-${String(Math.floor(rng() * 9999)).padStart(4, '0')}`,
      decision_type: pick([...DECISION_TYPES] as DecisionType[], rng),
      entity_name: pick(ENTITY_NAMES, rng),
      amount_cr: rng() > 0.3 ? r2(5 + rng() * 495) : null,
      risk_band: riskBand,
      current_state: state,
      maker: pick(MAKERS, rng),
      maker_submitted_at: submittedAt,
      checker: state !== 'draft' ? pick(CHECKERS, rng) : null,
      checker_reviewed_at: checkedAt,
      checker_comments: checkedAt ? pick(['Reviewed — within policy limits', 'Additional documentation verified', 'Risk parameters acceptable — forwarding to approver', 'Flagged for enhanced review — borderline case'], rng) : null,
      approver: approvedAt ? pick(APPROVERS, rng) : null,
      approver_reviewed_at: approvedAt,
      approver_comments: approvedAt ? pick(['Approved — aligns with risk appetite', 'Approved with conditions — monitor quarterly', 'Approved — committee decision recorded'], rng) : null,
      sla_hours: sla,
      sla_breached: slaBreached,
      justification: pick(['Credit parameters within policy', 'Customer relationship value justifies', 'Regulatory timeline compliance required', 'Committee approved exception', 'New evidence supports decision reversal'], rng),
      priority: riskBand === 'critical' ? 'critical' : riskBand === 'high' ? 'high' : 'normal',
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 6 — Decision Explainability
// ─────────────────────────────────────────────────────────────────────────────

export interface ExplainabilityReport {
  decision_id: string;
  transparency_score: number;
  top_risk_drivers: Array<{ driver: string; impact_pct: number; direction: 'positive' | 'negative' }>;
  model_drivers: Array<{ model: string; score: number; contribution_pct: number }>;
  rule_drivers: Array<{ rule: string; triggered: boolean; weight: number }>;
  agent_drivers: Array<{ agent: string; recommendation: string; confidence: number }>;
  investigation_findings: string[];
  decision_factors: Array<{ factor: string; value: string; impact: 'favorable' | 'adverse' | 'neutral' }>;
  confidence_breakdown: { data_quality: number; model_confidence: number; rule_certainty: number; agent_consensus: number; regulatory_clearance: number };
  complexity_score: number;
  traceability_score: number;
  explanation_plain: string;
}

export function buildExplainabilityReport(tenant: string, asOf: Date): ExplainabilityReport {
  const rng = mulberry32(fnv1a(`${tenant}:explain:${dayKey(asOf)}`));

  return {
    decision_id: `DEC-EXPLAIN-${dayKey(asOf).replace(/-/g, '')}`,
    transparency_score: Math.floor(78 + rng() * 20),
    top_risk_drivers: [
      { driver: 'Repayment history (12 months)', impact_pct: 28, direction: 'positive' },
      { driver: 'Bureau score (CIBIL 695)', impact_pct: 22, direction: 'positive' },
      { driver: 'Sector concentration (MSME, elevated)', impact_pct: 18, direction: 'negative' },
      { driver: 'Income-to-EMI ratio (44%)', impact_pct: 16, direction: rng() > 0.5 ? 'positive' : 'negative' },
      { driver: 'Existing obligation burden', impact_pct: 16, direction: 'negative' },
    ],
    model_drivers: [
      { model: 'PD Model XGBoost v3.2', score: r3(0.18 + rng() * 0.15), contribution_pct: 40 },
      { model: 'Fraud Model Neural Net v4.2', score: r3(0.05 + rng() * 0.08), contribution_pct: 25 },
      { model: 'LGD Linear Regression v2.1', score: r3(0.38 + rng() * 0.12), contribution_pct: 20 },
      { model: 'Behavioral Score v1.5', score: r3(0.72 + rng() * 0.20), contribution_pct: 15 },
    ],
    rule_drivers: [
      { rule: 'RULE-001: Min bureau score 650', triggered: rng() > 0.3, weight: 0.25 },
      { rule: 'RULE-018: Sector exposure limit 15%', triggered: rng() > 0.5, weight: 0.20 },
      { rule: 'RULE-042: DPD > 30 restriction', triggered: false, weight: 0.30 },
      { rule: 'RULE-089: Income adequacy check', triggered: rng() > 0.4, weight: 0.25 },
    ],
    agent_drivers: [
      { agent: 'Credit Risk Agent', recommendation: 'Approve with standard conditions', confidence: r3(0.88 + rng() * 0.10) },
      { agent: 'Compliance Agent', recommendation: 'No regulatory objections identified', confidence: r3(0.92 + rng() * 0.07) },
      { agent: 'Collections Agent', recommendation: 'Manageable recovery profile if stressed', confidence: r3(0.79 + rng() * 0.15) },
    ],
    investigation_findings: [
      'No open fraud investigations',
      'Previous account — closed in good standing',
      'References verified — 3/3 confirmed',
    ],
    decision_factors: [
      { factor: 'Credit Bureau Score', value: '695 (Prime band)', impact: 'favorable' },
      { factor: 'Employment Tenure', value: '7 years (stable)', impact: 'favorable' },
      { factor: 'Sector (MSME)', value: 'Watch category', impact: 'adverse' },
      { factor: 'Existing Loans', value: '2 active (manageable)', impact: 'neutral' },
      { factor: 'FOIR', value: '44% (within 50% limit)', impact: 'favorable' },
    ],
    confidence_breakdown: {
      data_quality: r3(0.88 + rng() * 0.10),
      model_confidence: r3(0.84 + rng() * 0.12),
      rule_certainty: r3(0.90 + rng() * 0.08),
      agent_consensus: r3(0.86 + rng() * 0.11),
      regulatory_clearance: r3(0.94 + rng() * 0.05),
    },
    complexity_score: Math.floor(55 + rng() * 35),
    traceability_score: Math.floor(82 + rng() * 16),
    explanation_plain: 'This credit decision was approved because the applicant demonstrates a strong repayment history (12 months clean), an adequate bureau score of 695, and an income-to-EMI ratio within policy limits. The primary adverse signal is MSME sector exposure (currently on watch list). All 28 applicable rules were evaluated; no hard-stop triggers were activated. Four AI models contributed to this decision, achieving a consensus confidence of 87%. Three AI agents were consulted — all recommended approval. The decision complies with RBI IRACP and Fair Practice Code requirements.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 7 — Decision Effectiveness Center
// ─────────────────────────────────────────────────────────────────────────────

export interface EffectivenessMetrics {
  decision_accuracy_pct: number;
  false_positive_rate_pct: number;
  false_negative_rate_pct: number;
  recovery_value_cr: number;
  loss_prevention_cr: number;
  claim_savings_cr: number;
  fraud_prevented_cr: number;
  portfolio_improvement_pp: number;
  policy_retention_impact_pct: number;
  roi_per_100_decisions: number;
  outcomes_vs_recommended: Array<{ type: string; recommended: DecisionOutcome; actual_outcome: string; match: boolean; financial_impact_cr: number }>;
}

export function buildEffectivenessMetrics(tenant: string, asOf: Date): EffectivenessMetrics {
  const rng = mulberry32(fnv1a(`${tenant}:effectiveness:${dayKey(asOf)}`));
  const outcomes: Array<{ type: string; recommended: DecisionOutcome; actual_outcome: string; match: boolean; financial_impact_cr: number }> = [
    { type: 'Credit Approval', recommended: 'approve', actual_outcome: 'Performing', match: true,  financial_impact_cr: r2(8 + rng() * 42) },
    { type: 'Claims Settlement', recommended: 'approve', actual_outcome: 'Valid Claim', match: true, financial_impact_cr: r2(2 + rng() * 18) },
    { type: 'Fraud Block', recommended: 'flag', actual_outcome: 'Fraud Confirmed', match: true,    financial_impact_cr: r2(5 + rng() * 35) },
    { type: 'Credit Rejection', recommended: 'reject', actual_outcome: 'Default Avoided', match: true, financial_impact_cr: r2(3 + rng() * 22) },
    { type: 'Credit Referral', recommended: 'refer', actual_outcome: 'Approved by Committee', match: rng() > 0.3, financial_impact_cr: r2(1 + rng() * 12) },
    { type: 'KYC Rejection', recommended: 'reject', actual_outcome: 'Identity Verified Later', match: false, financial_impact_cr: r2(0.5 + rng() * 4) },
  ];
  return {
    decision_accuracy_pct: r2(93 + rng() * 5),
    false_positive_rate_pct: r2(2 + rng() * 4),
    false_negative_rate_pct: r2(1 + rng() * 2.5),
    recovery_value_cr: r2(285 + rng() * 215),
    loss_prevention_cr: r2(420 + rng() * 380),
    claim_savings_cr: r2(180 + rng() * 220),
    fraud_prevented_cr: r2(95 + rng() * 155),
    portfolio_improvement_pp: r2(0.8 + rng() * 1.4),
    policy_retention_impact_pct: r2(2.2 + rng() * 3.8),
    roi_per_100_decisions: r2(840 + rng() * 960),
    outcomes_vs_recommended: outcomes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 9 — Executive Board View
// ─────────────────────────────────────────────────────────────────────────────

export interface BoardViewData {
  board_health_score: number;
  top_decisions: Array<{ rank: number; type: string; entity: string; outcome: DecisionOutcome; amount_cr: number | null; risk_band: RiskBand }>;
  decision_trends: Array<{ period: string; total: number; approved: number; rejected: number; escalated: number }>;
  risk_exposure_cr: number;
  ai_accuracy_trend: Array<{ month: string; accuracy: number }>;
  decision_roi_cr: number;
  decisions_volume_30d: number;
  outcome_distribution: Record<DecisionOutcome, number>;
  board_summary: string;
}

export function buildBoardView(tenant: string, asOf: Date): BoardViewData {
  const rng = mulberry32(fnv1a(`${tenant}:board:${dayKey(asOf)}`));
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
  const periods = ['Week 1', 'Week 2', 'Week 3', 'Week 4'];

  return {
    board_health_score: Math.floor(78 + rng() * 18),
    top_decisions: Array.from({ length: 5 }, (_, i) => ({
      rank: i + 1,
      type: pick(['Credit Approval', 'Policy Underwriting', 'Claims Settlement', 'Fraud Block', 'NPA Classification'], rng),
      entity: pick(ENTITY_NAMES, rng),
      outcome: pick(['approve', 'reject', 'escalate'] as DecisionOutcome[], rng),
      amount_cr: r2(25 + rng() * 475),
      risk_band: pick(RISK_BANDS, rng),
    })),
    decision_trends: periods.map((period) => {
      const total = Math.floor(800 + rng() * 400);
      return { period, total, approved: Math.floor(total * 0.52), rejected: Math.floor(total * 0.18), escalated: Math.floor(total * 0.05) };
    }),
    risk_exposure_cr: r2(2400 + rng() * 1600),
    ai_accuracy_trend: months.map((month) => ({ month, accuracy: r2(91 + rng() * 6) })),
    decision_roi_cr: r2(980 + rng() * 820),
    decisions_volume_30d: Math.floor(38000 + rng() * 22000),
    outcome_distribution: {
      approve: Math.floor(2000 + rng() * 1000),
      reject: Math.floor(600 + rng() * 400),
      refer: Math.floor(300 + rng() * 200),
      review: Math.floor(200 + rng() * 150),
      escalate: Math.floor(80 + rng() * 60),
      flag: Math.floor(50 + rng() * 50),
      monitor: Math.floor(150 + rng() * 100),
    },
    board_summary: `The AI Decisioning Layer processed ${Math.floor(38000 + rng() * 22000).toLocaleString('en-IN')} decisions this month with ${r2(93 + rng() * 5)}% accuracy. AI automation reduced manual review burden by 94%. Total loss prevention value: ₹${r2(420 + rng() * 380)} Cr. Three AI models flagged for drift monitoring — revalidation scheduled. Board Health Score: ${Math.floor(78 + rng() * 18)}/100 — within governance appetite.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 15 — Enterprise Decision Score
// ─────────────────────────────────────────────────────────────────────────────

export interface EnterpriseDecisionScore {
  overall_score: number;
  grade: 'A+' | 'A' | 'B+' | 'B' | 'C' | 'D';
  components: {
    risk_score: number;
    compliance_score: number;
    ai_confidence: number;
    data_quality: number;
    investigation_confidence: number;
    agent_consensus: number;
    approval_completeness: number;
  };
  recommendation: string;
  decision_ready: boolean;
  blocking_factors: string[];
}

export function buildEnterpriseDecisionScore(tenant: string, asOf: Date): EnterpriseDecisionScore {
  const rng = mulberry32(fnv1a(`${tenant}:ent-score:${dayKey(asOf)}`));
  const components = {
    risk_score: Math.floor(55 + rng() * 40),
    compliance_score: Math.floor(70 + rng() * 28),
    ai_confidence: Math.floor(60 + rng() * 38),
    data_quality: Math.floor(72 + rng() * 25),
    investigation_confidence: Math.floor(65 + rng() * 30),
    agent_consensus: Math.floor(68 + rng() * 28),
    approval_completeness: Math.floor(75 + rng() * 23),
  };
  const weights = [0.20, 0.18, 0.18, 0.14, 0.12, 0.10, 0.08];
  const vals = Object.values(components);
  const overall = Math.floor(vals.reduce((s, v, i) => s + v * weights[i], 0));
  const grade: EnterpriseDecisionScore['grade'] = overall >= 92 ? 'A+' : overall >= 85 ? 'A' : overall >= 78 ? 'B+' : overall >= 70 ? 'B' : overall >= 60 ? 'C' : 'D';

  return {
    overall_score: overall,
    grade,
    components,
    recommendation: overall >= 80 ? 'Decision is ready for execution. All components within acceptable thresholds.' : overall >= 65 ? 'Decision can proceed with enhanced monitoring. 2 components below target — flagged for review.' : 'Decision requires additional review. Multiple components below threshold. Recommend escalation to senior authority.',
    decision_ready: overall >= 70,
    blocking_factors: [
      ...(components.compliance_score < 75 ? ['Compliance score below 75% threshold'] : []),
      ...(components.data_quality < 70 ? ['Data quality below minimum standard'] : []),
      ...(components.ai_confidence < 65 ? ['AI confidence insufficient for auto-execution'] : []),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit Trail (Section 8) — immutable decision events
// ─────────────────────────────────────────────────────────────────────────────

export interface DecisionAuditEvent {
  event_id: string;
  decision_id: string;
  event_type: 'created' | 'modified' | 'submitted' | 'reviewed' | 'approved' | 'rejected' | 'executed';
  actor: string;
  role: string;
  timestamp: string;
  comments: string;
  decision_version: number;
  sha256_hash: string;
}

export function buildDecisionAuditTrail(tenant: string, asOf: Date, decisionId: string): DecisionAuditEvent[] {
  const rng = mulberry32(fnv1a(`${tenant}:audit:${decisionId}:${dayKey(asOf)}`));
  const types: Array<DecisionAuditEvent['event_type']> = ['created', 'modified', 'submitted', 'reviewed', 'approved', 'executed'];
  const actors = ['risk.analyst@bank.com', 'senior.credit@bank.com', 'cro@bank.com', 'system:ai-engine', 'system:rule-engine'];

  return types.slice(0, Math.floor(4 + rng() * 3)).map((type, i) => ({
    event_id: `EVT-${type.toUpperCase()}-${String(i + 1).padStart(2, '0')}`,
    decision_id: decisionId,
    event_type: type,
    actor: type === 'created' || type === 'modified' ? 'system:ai-engine' : pick(actors, rng),
    role: type === 'created' ? 'AI Engine' : type === 'submitted' ? 'Risk Analyst' : type === 'reviewed' ? 'Senior Analyst' : 'CRO',
    timestamp: new Date(asOf.getTime() - (types.length - i) * 2 * 3600000).toISOString(),
    comments: type === 'created' ? 'Decision generated by AI engine v3.2' : type === 'reviewed' ? 'Reviewed — parameters within policy' : type === 'approved' ? 'Approved — aligns with risk appetite' : 'Processed successfully',
    decision_version: i + 1,
    sha256_hash: `a${Math.random().toString(16).slice(2, 34)}`,
  }));
}
