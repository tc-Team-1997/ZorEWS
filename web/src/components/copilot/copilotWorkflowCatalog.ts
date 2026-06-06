// copilotWorkflowCatalog.ts
//
// ZorEWS Copilot — Workflow Explainability Catalog
// Explains every major platform workflow step-by-step.
// Used by the copilot engine to answer workflow questions.
//
// 100% additive — no existing logic changed.

export interface WorkflowStep {
  step:        number;
  title:       string;
  actor:       string;
  description: string;
  system?:     string;
  sla?:        string;
}

export interface WorkflowEntry {
  id:          string;
  name:        string;
  keywords:    string[];
  objective:   string;
  actors:      string[];
  steps:       WorkflowStep[];
  outcome:     string;
  relatedModule: string;
  route:       string;
  notes?:      string;
}

// ─── Workflow Catalog ─────────────────────────────────────────────────────

export const WORKFLOW_CATALOG: WorkflowEntry[] = [

  {
    id: 'alert_lifecycle',
    name: 'Alert Lifecycle Workflow',
    keywords: ['alert lifecycle', 'how does alert work', 'alert workflow', 'alert process', 'alert flow'],
    objective: 'Route a risk signal from detection to resolution with full SLA accountability.',
    actors: ['EWS Rule Engine', 'AI Model', 'Risk Analyst', 'Supervisor', 'Head of Risk'],
    steps: [
      { step: 1, title: 'Rule/Model Fires', actor: 'EWS Engine', description: 'A configured EWS rule or AI model detects a risk condition (e.g., DPD-30+ crossed, PD > 0.75). Alert is generated with severity classification.', system: 'Rule Center + AI Governance', sla: '< 60 seconds from data update' },
      { step: 2, title: 'Alert Classified', actor: 'EWS Engine', description: 'Alert is classified: Critical → Red, High → Orange, Medium → Yellow, Low → Green. Classification drives SLA and routing.', system: 'Alert Management Center' },
      { step: 3, title: 'Auto-Routing', actor: 'System', description: 'Alert is routed to the appropriate queue based on classification: Red → Head of Risk queue (4h SLA), Orange → Supervisor queue (24h SLA), Yellow → Analyst queue (72h SLA).', system: 'Alert Routing Engine', sla: 'Auto-assigned within 2 minutes' },
      { step: 4, title: 'Analyst Acknowledgment', actor: 'Risk Analyst / Supervisor', description: 'Assigned analyst acknowledges the alert (marks as seen). If acknowledgment missed within SLA window, auto-escalation triggers.', system: 'Alert Management Center', sla: 'Critical: 2h, High: 8h, Medium: 24h' },
      { step: 5, title: 'Investigation Initiated', actor: 'Risk Analyst', description: 'Analyst creates an investigation case from the alert. Case linked to customer, loan, and all correlated alerts.', system: 'Investigation Center + CMS' },
      { step: 6, title: 'Evidence Collection', actor: 'Risk Analyst', description: '8-step BIL investigation checklist completed: identity verification, AML screen, document review, red flag check, interview, site inspection, final recommendation.', system: 'Investigation Center', sla: '24-72h depending on case type' },
      { step: 7, title: 'Maker-Checker Approval', actor: 'Supervisor (Checker)', description: 'Case closure, escalation, or override requires 4-eyes approval. Maker submits, Checker approves/rejects. Self-approval blocked.', system: 'CMS Maker-Checker', sla: '4h for Critical, 24h for High' },
      { step: 8, title: 'Resolution & Closure', actor: 'Supervisor / Risk Analyst', description: 'Case closed with documented outcome: fraud confirmed, NPA actioned, KYC remediated, or false positive cleared. All actions logged in audit trail.', system: 'CMS + Audit Center' },
      { step: 9, title: 'Compliance Reporting', actor: 'System + Compliance Officer', description: 'Resolved cases feed into regulatory reports (AML filing, RBI MIS, IRDAI returns). Evidence packages auto-generated.', system: 'Regulatory Compliance Center' },
    ],
    outcome: 'Every risk signal is acknowledged, investigated, actioned, and documented with a complete audit trail within SLA.',
    relatedModule: 'alert_management',
    route: '/alerts',
    notes: 'SLA breach triggers automatic escalation to next-level role. All transitions are logged in the immutable audit chain.',
  },

  {
    id: 'investigation_workflow',
    name: 'Investigation Workflow (Fraud / NPA / Compliance)',
    keywords: ['investigation workflow', 'how investigation works', 'investigation process', 'fraud investigation', 'how to investigate'],
    objective: 'Conduct a structured, evidence-based investigation that meets regulatory documentation standards.',
    actors: ['Fraud Analyst', 'Risk Analyst', 'Supervisor', 'Compliance Officer'],
    steps: [
      { step: 1, title: 'Case Opened', actor: 'Risk Analyst / System', description: 'Investigation case created from an alert, manual referral, or auto-escalation. Case type assigned: Fraud, NPA, KYC, AML, or Compliance.' },
      { step: 2, title: 'Identity Verification', actor: 'Analyst', description: 'Verify customer identity using KYC documents, bureau records, and biometric data. Flag discrepancies.', sla: '2 hours' },
      { step: 3, title: 'Policy / Loan History Review', actor: 'Analyst', description: 'Pull complete account history: loan performance, repayment behavior, bureau score trends, prior alerts.', system: 'Predictive Risk Center + Integration Marketplace' },
      { step: 4, title: 'AML Screening', actor: 'Analyst + System', description: 'Run customer through AML watchlist (OFAC, UN, domestic). Flag PEP status, adverse media, sanctions matches.', system: 'Integration Marketplace (AML)' },
      { step: 5, title: 'Document Review', actor: 'Analyst', description: 'Review all submitted documents in the DMS vault. Flag missing, expired, or suspicious documents.' },
      { step: 6, title: 'Red Flag Analysis', actor: 'Analyst', description: 'Apply the BIL red flag checklist: transaction velocity, geographic anomaly, circular fund flow, industry mismatch.' },
      { step: 7, title: 'Interview / Site Inspection', actor: 'Field Officer / Analyst', description: 'If required: customer interview or physical site visit with GPS-tagged visit log.' },
      { step: 8, title: 'Final Recommendation', actor: 'Senior Analyst / Supervisor', description: 'Document final investigation verdict: Fraud Confirmed / Unsubstantiated / Partial Fraud / Data Quality Issue.' },
      { step: 9, title: 'Maker-Checker Sign-Off', actor: 'Supervisor (Checker)', description: '4-eyes approval required for: Fraud Confirmation, SAR filing, Case Closure, Write-off Authorization.' },
      { step: 10, title: 'Regulatory Submission', actor: 'Compliance Officer', description: 'If SAR required: file with FIU-IND within 7 days of confirmation. Evidence package generated and archived.' },
    ],
    outcome: 'Investigation closed with documented verdict, evidence package archived, and regulatory submissions completed within deadlines.',
    relatedModule: 'investigation_center',
    route: '/investigation-center',
  },

  {
    id: 'maker_checker_workflow',
    name: 'Maker-Checker (4-Eyes Approval) Workflow',
    keywords: ['maker checker', '4 eyes', 'four eyes', 'approval workflow', 'segregation of duties', 'maker checker work', 'how maker checker'],
    objective: 'Enforce dual-control oversight on all high-risk decisions to meet RBI segregation of duties requirements.',
    actors: ['Maker (initiating analyst)', 'Checker (approving supervisor)'],
    steps: [
      { step: 1, title: 'Maker Submits Action', actor: 'Risk Analyst / Collection Officer (Maker)', description: 'Analyst submits a sensitive action: case close, account write-off, CAP approval, rule change, model promotion, or recovery action. Must include rationale (max 4000 chars).' },
      { step: 2, title: 'Action Queued for Review', actor: 'System', description: 'Action placed in the checker approval queue. Pending status set. Maker cannot self-approve — system blocks same-user approval.', sla: 'Critical: 4h, High: 24h, Standard: 48h' },
      { step: 3, title: 'Checker Notified', actor: 'System → Supervisor', description: 'Designated checker (supervisor or above) receives notification via email/push. Queue shows pending action with context.' },
      { step: 4, title: 'Checker Reviews', actor: 'Supervisor / Head of Risk (Checker)', description: 'Checker reviews the submitted action, evidence, and rationale. Can view full audit trail of related events.' },
      { step: 5, title: 'Checker Approves or Rejects', actor: 'Supervisor (Checker)', description: 'Checker approves (action executes) or rejects (action cancelled, maker notified with rejection reason). Decision notes mandatory for rejections.' },
      { step: 6, title: 'Action Executed', actor: 'System', description: 'If approved: action executed immediately. Case closed, CAP confirmed, write-off processed, rule promoted, model deployed.' },
      { step: 7, title: 'Audit Logged', actor: 'System', description: 'Full maker-checker record written to immutable audit chain: who submitted, who approved/rejected, when, and why.' },
    ],
    outcome: 'Sensitive decisions require dual-control approval with full audit evidence. Self-approval is cryptographically prevented.',
    relatedModule: 'case_management',
    route: '/cms/cases',
    notes: 'Applies to: case closure, write-off authorization, CAP approval, model promotion, rule activation, recovery actions, regulatory submissions.',
  },

  {
    id: 'compliance_workflow',
    name: 'Regulatory Compliance Workflow',
    keywords: ['compliance workflow', 'how compliance works', 'regulatory process', 'rbi filing', 'aml filing', 'compliance process'],
    objective: 'Ensure all regulatory obligations (RBI, Basel, AML/KYC, IRDAI) are met on time with evidence-backed submissions.',
    actors: ['Compliance Officer', 'Risk Analyst', 'Data Team', 'Auditor', 'CRO'],
    steps: [
      { step: 1, title: 'Obligation Identified', actor: 'Regulatory Calendar + Compliance Officer', description: 'Filing deadline identified from the regulatory calendar (RBI quarterly, AML monthly, IRDAI H1, Basel annual). Assigned to compliance owner.' },
      { step: 2, title: 'Data Collection', actor: 'System + Data Team', description: 'Platform auto-aggregates required data: loan performance, NPA ratios, transaction flags, KYC status, capital ratios.' },
      { step: 3, title: 'Gap Assessment', actor: 'Compliance Officer', description: 'Compliance gaps identified: missing KYC documents, unresolved AML flags, incomplete evidence, threshold breaches.' },
      { step: 4, title: 'Remediation', actor: 'Risk Analyst / Operations Team', description: 'Gaps remediated: KYC refresh, AML investigation resolution, document collection, threshold compliance actions.' },
      { step: 5, title: 'Evidence Packaging', actor: 'System + Compliance Officer', description: 'Evidence package assembled from audit trail, investigation records, and data outputs. SHA-256 hash generated for tamper-evidence.' },
      { step: 6, title: 'Internal Review', actor: 'Compliance Officer + CRO', description: '4-eyes review of submission package. Final readiness score calculated. CRO sign-off obtained.' },
      { step: 7, title: 'Regulatory Submission', actor: 'Compliance Officer', description: 'Package submitted to regulator via approved channel (RBI XBRL, FIU-IND portal, IRDAI system). Submission ID captured.' },
      { step: 8, title: 'Post-Submission Monitoring', actor: 'Compliance Officer', description: 'Monitor for regulator queries, acknowledgment, and follow-up requests. All responses logged in audit trail.' },
    ],
    outcome: 'All regulatory filings completed on time with full evidence backing and tamper-evident audit trail.',
    relatedModule: 'regulatory_compliance',
    route: '/regulatory-compliance-center',
  },

  {
    id: 'npa_early_warning_workflow',
    name: 'NPA Early Warning Workflow',
    keywords: ['npa early warning', 'npa workflow', 'npa process', 'early warning process', 'dpd workflow', 'sma workflow'],
    objective: 'Detect potential NPAs before they become actual NPAs and initiate recovery actions within the regulatory SMA/NPA timeline.',
    actors: ['AI Model', 'Risk Analyst', 'Collection Officer', 'Relationship Manager'],
    steps: [
      { step: 1, title: 'Indicator Calculation', actor: 'EWS Engine', description: 'Daily: Financial indicators calculated (DPD, utilization, EMI bounce rate, bureau score). Any breach triggers candidate flag.', sla: '< 60 seconds from data refresh' },
      { step: 2, title: 'AI Scoring', actor: 'Predictive Risk AI', description: 'ML model calculates 90-day NPA probability. Accounts with PD > 0.60 enter Early Warning List (EWL). SHAP factors explain drivers.', system: 'Predictive Risk Center' },
      { step: 3, title: 'SMA Classification', actor: 'System + Risk Analyst', description: 'SMA-0 (0-30 DPD), SMA-1 (31-60 DPD), SMA-2 (61-90 DPD). RBI mandates reporting from SMA-0. EWL includes pre-SMA accounts.' },
      { step: 4, title: 'Alert Generation', actor: 'EWS Alert Engine', description: 'Critical alert generated for each EWL account. Routed to respective collection officer and relationship manager.' },
      { step: 5, title: 'Customer Outreach', actor: 'Relationship Manager + Collection Officer', description: 'Contact customer within SLA: call, site visit, payment reminder. Visit logged with GPS in mobile app. Outcome recorded.' },
      { step: 6, title: 'Recovery Plan', actor: 'Collection Officer + Supervisor', description: 'Restructuring or recovery plan created if customer responsive. CAP (Corrective Action Plan) documented in CMS.' },
      { step: 7, title: 'Escalation (if non-responsive)', actor: 'Supervisor → Head of Credit', description: 'Unresponsive accounts escalated. Legal team notified if SMA-2+. Provision increase triggered.' },
      { step: 8, title: 'IFRS9 Stage Migration', actor: 'System + Compliance Officer', description: 'Account migrates IFRS9 stage (1→2→3) based on performance. ECL provision adjusted. Regulatory reporting updated.' },
    ],
    outcome: 'Early intervention before NPA crystallization. Recovery rate improved. Regulatory NPA ratio minimized.',
    relatedModule: 'predictive_risk',
    route: '/banking/npa-prediction',
  },

  {
    id: 'data_ingestion_workflow',
    name: 'Data Ingestion & Quality Workflow',
    keywords: ['data ingestion workflow', 'how data flows', 'data pipeline', 'how data enters zorews', 'ingestion process'],
    objective: 'Ensure reliable, validated, and timely data flow from all source systems to risk intelligence.',
    actors: ['Data Pipeline', 'Data Engineer', 'Data Steward', 'Risk Analyst'],
    steps: [
      { step: 1, title: 'Source System Extract', actor: 'Connector / CBS / Bureau', description: 'Data extracted from source: CBS (batch/real-time), Bureau (daily pull), AML watchlist (hourly), IFRS9 (daily), Insurance (real-time via API).' },
      { step: 2, title: 'Schema Validation', actor: 'Data Ingestion Engine', description: 'Every record validated against registered schema. Field types, required fields, and value ranges checked. Violations flagged.' },
      { step: 3, title: 'Data Quality Scoring', actor: 'DQ Engine', description: 'Quality metrics calculated: null rates, referential integrity, statistical outliers, duplicate detection. DQ score assigned (0-100).' },
      { step: 4, title: 'Quality Gate', actor: 'System + Data Steward', description: 'If DQ score < threshold → data quarantined, team notified. If score acceptable → data promoted to staging.' },
      { step: 5, title: 'Transformation', actor: 'dbt / ETL Pipeline', description: 'Raw data transformed into business-ready format: Customer 360, Loan 360, Transaction Features. Business logic applied.' },
      { step: 6, title: 'Indicator Calculation', actor: 'EWS Indicator Engine', description: 'Financial indicators calculated from transformed data (DPD, utilization, bureau score, velocity). Published to kafka topic.' },
      { step: 7, title: 'Model Scoring', actor: 'AI Models', description: 'Indicator values consumed by ML models. PD scores, fraud scores updated. Model confidence tracked.' },
      { step: 8, title: 'Alert Trigger', actor: 'Rule Engine', description: 'Updated indicator values evaluated against rules. Alerts generated for any breaches. SLA < 60 seconds from source update.' },
    ],
    outcome: 'Reliable, quality-validated data powers all risk decisions within 60 seconds of source system update.',
    relatedModule: 'data_ingestion',
    route: '/data-ingestion',
  },

  {
    id: 'ai_model_promotion_workflow',
    name: 'AI Model Promotion Workflow',
    keywords: ['model promotion', 'champion challenger', 'model lifecycle', 'how model promoted', 'ai model workflow', 'model deployment'],
    objective: 'Deploy AI models to production through a governed, validated, maker-checker approved process per RBI model risk management guidelines.',
    actors: ['Data Scientist', 'Model Risk Manager', 'CRO', 'IT Team'],
    steps: [
      { step: 1, title: 'Model Developed', actor: 'Data Scientist', description: 'ML model trained on historical data. Performance validated: AUC, precision, recall, PSI, Gini, KS statistic calculated. Model card authored.' },
      { step: 2, title: 'Experimental Registration', actor: 'Data Scientist', description: 'Model registered in AI Governance Center as Experimental. Artifacts uploaded (model file, metrics, SHAP explainability, backtests).' },
      { step: 3, title: 'Staging Promotion', actor: 'Model Risk Manager', description: 'After validation against holdout data: model promoted to Staging. Shadow scoring begins alongside production model.' },
      { step: 4, title: 'Champion/Challenger A/B', actor: 'Risk Team + System', description: 'Challenger model scored in parallel with champion. Performance compared: AUC delta, drift, decision distribution. Min 30-day shadow period.' },
      { step: 5, title: 'Promotion Request', actor: 'Data Scientist (Maker)', description: 'Promotion to Production requested. Business justification, performance evidence, and risk assessment submitted.' },
      { step: 6, title: 'Model Risk Review', actor: 'Model Risk Manager (Checker)', description: '4-eyes review: challenger outperforms champion? Documentation complete? Regulatory requirements met? Approval or rejection with reasoning.' },
      { step: 7, title: 'Production Deployment', actor: 'IT + Model Risk', description: 'Approved model deployed to production. Previous champion demoted to retired or archived. All alert rules updated to use new model scores.' },
      { step: 8, title: 'Ongoing Monitoring', actor: 'AI Governance System', description: 'Production model monitored for drift (PSI, KS, performance degradation). Drift alert triggers re-validation cycle.' },
    ],
    outcome: 'Production AI models are validated, approved, and continuously monitored with full RBI MRM compliance.',
    relatedModule: 'ai_governance',
    route: '/ai/governance',
  },

  {
    id: 'recovery_workflow',
    name: 'Recovery & Collection Workflow',
    keywords: ['recovery workflow', 'collection workflow', 'how recovery works', 'debt collection', 'recovery process', 'npa recovery'],
    objective: 'Maximize recovery from NPA accounts through systematic outreach, legal action, and asset resolution.',
    actors: ['Collection Officer', 'Legal Team', 'Field Officer', 'Recovery Manager'],
    steps: [
      { step: 1, title: 'NPA Identification', actor: 'System + Risk Analyst', description: 'Account classified NPA (DPD > 90). Recovery case created in CMS. Assigned to collection officer with exposure and asset details.' },
      { step: 2, title: 'Soft Recovery Attempt', actor: 'Collection Officer', description: 'Phase 1: Outreach calls, payment reminders, restructuring proposals. Target: 30 days. Visit log maintained with GPS.' },
      { step: 3, title: 'Formal Notice', actor: 'Legal Team + Collection Officer', description: 'Section 13(2) / SARFAESI demand notice issued. 60-day response window begins. All notices logged in evidence vault.' },
      { step: 4, title: 'Asset Assessment', actor: 'Valuation Team', description: 'Collateral re-valued. Haircut calculated. Recovery potential estimated. OTS (One-Time Settlement) threshold determined.' },
      { step: 5, title: 'OTS / Restructuring', actor: 'Recovery Manager + CRO', description: 'If customer responsive: OTS offer structured. Board approval required for write-off > threshold. CAP documented in CMS.' },
      { step: 6, title: 'Legal Action (if non-responsive)', actor: 'Legal Team', description: 'DRT filing, SARFAESI possession, ARC transfer, or write-off authorization. Maker-checker approval required for write-offs.' },
      { step: 7, title: 'Asset Resolution', actor: 'Recovery Manager', description: 'Asset auctioned, proceeds recovered. Partial recovery booked. Write-off amount reported to regulator.' },
      { step: 8, title: 'Case Closure', actor: 'Recovery Manager + Compliance', description: 'Recovery case closed with outcome documented. IFRS9 stage updated. Regulatory reporting completed.' },
    ],
    outcome: 'Maximum recovery from NPA portfolio with documented, compliant, auditable collection process.',
    relatedModule: 'recovery_center',
    route: '/recovery-center',
  },

];

// ─── Lookup helpers ───────────────────────────────────────────────────────

export function findWorkflow(query: string): WorkflowEntry | undefined {
  const q = query.toLowerCase();
  return WORKFLOW_CATALOG.find(w =>
    w.keywords.some(k => q.includes(k)) ||
    w.name.toLowerCase().includes(q)
  );
}

export function searchWorkflows(query: string): WorkflowEntry[] {
  const q = query.toLowerCase();
  return WORKFLOW_CATALOG.filter(w =>
    w.keywords.some(k => q.includes(k)) ||
    w.name.toLowerCase().includes(q) ||
    w.objective.toLowerCase().includes(q)
  );
}

export function formatWorkflowResponse(w: WorkflowEntry): string {
  const stepLines = w.steps.map(s => {
    const slaStr = s.sla ? ` *(SLA: ${s.sla})*` : '';
    return `**Step ${s.step}: ${s.title}** — ${s.actor}\n${s.description}${slaStr}`;
  }).join('\n\n');

  return `**${w.name}**\n\n*Objective:* ${w.objective}\n\n*Actors:* ${w.actors.join(', ')}\n\n${stepLines}\n\n**Outcome:** ${w.outcome}`;
}
