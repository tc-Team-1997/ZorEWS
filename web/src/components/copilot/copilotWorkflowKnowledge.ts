// copilotWorkflowKnowledge.ts
//
// ZorEWS Copilot — Workflow Trainer Knowledge Base
// Step-by-step workflow explanations for all platform workflows.
// Feeds the reasoning engine for "How does X work?" questions.
//
// 100% additive — no existing logic changed.

import type { CopilotResponse } from './copilotEngine';

export interface WorkflowKnowledge {
  id:          string;
  name:        string;
  keywords:    string[];
  keywords_hi: string[];
  summary:     string;
  summary_hinglish?: string;
  actors:      string[];
  steps:       Array<{
    no:    number;
    title: string;
    who:   string;
    what:  string;
    sla?:  string;
    tip?:  string;
  }>;
  outcome:     string;
  outcome_hi?: string;
  commonMistakes: string[];
  route:       string;
  module:      string;
}

// ─── Workflow Catalog ─────────────────────────────────────────────────────

export const WORKFLOW_KNOWLEDGE: WorkflowKnowledge[] = [

  {
    id: 'alert_lifecycle',
    name: 'Alert Lifecycle Workflow',
    keywords: ['alert lifecycle', 'alert workflow', 'alert process', 'how does alert work', 'alert flow', 'alert management workflow', 'alert to case'],
    keywords_hi: ['अलर्ट जीवनचक्र', 'अलर्ट वर्कफ्लो'],
    summary: `**Alert Lifecycle** — How a risk signal travels from detection to resolution.

Every alert in ZorEWS follows a structured lifecycle with SLA accountability at each stage.`,
    summary_hinglish: `**Alert Lifecycle** — Risk signal kaise detect hota hai aur resolve hota hai.

Har alert ka ek structured path hota hai — detection se resolution tak — SLA ke saath.`,
    actors: ['EWS Rule Engine', 'AI Model', 'Risk Analyst', 'Supervisor', 'Head of Risk'],
    steps: [
      {
        no: 1, title: 'Trigger (Rule/Model Fires)',
        who: 'EWS Engine',
        what: 'An EWS rule or AI model detects a risk condition (DPD > 30, PD > 0.75, fraud cluster, etc.). Alert created with severity: Red/Orange/Yellow/Green.',
        sla: '< 60 seconds from CBS data refresh',
        tip: 'Rules fire on indicator values — ensure CBS data is fresh'
      },
      {
        no: 2, title: 'Auto-Classification',
        who: 'Alert Engine',
        what: 'Alert classified by BIL framework: CRITICAL→Red (4h SLA), HIGH→Orange (24h SLA), MEDIUM→Yellow (72h SLA), LOW→Green (monitor only). Routing matrix assigns to correct queue.',
        tip: 'Classification drives SLA — wrong classification = wrong SLA'
      },
      {
        no: 3, title: 'Analyst Acknowledgment',
        who: 'Risk Analyst / Supervisor',
        what: 'Assigned analyst acknowledges the alert (marks as seen). This pauses the SLA timer. If NOT acknowledged within SLA → auto-escalation to next level.',
        sla: 'Red: 2h, Orange: 8h, Yellow: 24h',
        tip: 'Acknowledge first, investigate later — missing ack = SLA breach'
      },
      {
        no: 4, title: 'Triage & Assessment',
        who: 'Risk Analyst',
        what: 'Analyst reviews SHAP factors, account history, linked alerts. Decides: (a) False positive → Close with reason, (b) Valid → Initiate investigation, (c) Escalate → Route to supervisor.',
        tip: 'SHAP top-5 factors must be reviewed before marking false positive'
      },
      {
        no: 5, title: 'Investigation Created',
        who: 'Risk Analyst',
        what: 'For valid alerts: Case created in CMS. Alert linked to case. Investigation checklist initiated (8-step for fraud, 6-step for NPA). Customer 360 profile pulled.',
        sla: 'Within 4h of acknowledgment for Red alerts'
      },
      {
        no: 6, title: 'Evidence Collection',
        who: 'Risk Analyst / Field Officer',
        what: 'Complete investigation steps: AML screen, document review, site visit (GPS logged), financial analysis. All evidence uploaded to DMS vault.',
        sla: '24-72h depending on case type'
      },
      {
        no: 7, title: 'Maker-Checker Approval',
        who: 'Supervisor (Checker)',
        what: 'For case closure, write-off, SAR filing, or major action: Maker submits → Checker reviews evidence → Approves or Rejects. Self-approval is cryptographically blocked.',
        sla: 'Red/Critical: 4h, High: 24h',
        tip: 'Never rubber-stamp approvals — review full evidence'
      },
      {
        no: 8, title: 'Resolution & Closure',
        who: 'Analyst + Supervisor',
        what: 'Case closed with documented outcome: NPA prevented, Fraud confirmed/SAR filed, KYC refreshed, False positive cleared. All actions in immutable audit trail.',
      },
      {
        no: 9, title: 'Compliance Reporting',
        who: 'Compliance Officer',
        what: 'Resolved cases feed RBI/IRDAI reporting. SAR filings go to FIU-IND. Evidence packages auto-generated for regulatory submissions.',
      },
    ],
    outcome: 'Every risk signal is acknowledged, investigated, and resolved within SLA with full audit evidence.',
    outcome_hi: 'हर रिस्क सिग्नल SLA के भीतर स्वीकार, जांच और हल किया जाता है।',
    commonMistakes: [
      'Not acknowledging alert before investigating (SLA breach risk)',
      'Skipping SHAP review before false positive declaration',
      'Not completing CAS documentation before case closure',
      'Missing SAR 7-day filing deadline after fraud confirmation',
    ],
    route: '/alerts',
    module: 'Alert Management Center',
  },

  {
    id: 'case_workflow',
    name: 'Case Management Workflow',
    keywords: ['case workflow', 'case management workflow', 'how does case work', 'cms workflow', 'case lifecycle', 'case process', 'case flow'],
    keywords_hi: ['केस वर्कफ्लो', 'केस प्रबंधन'],
    summary: `**Case Management Workflow** — From alert to resolution with full audit trail.

ZorEWS CMS manages the complete lifecycle of every risk case through a structured, auditable process.`,
    summary_hinglish: `**Case Management Workflow** — Alert se case banao, investigate karo, close karo — sab audit-trail ke saath.`,
    actors: ['System', 'Risk Analyst', 'Supervisor', 'Head of Risk', 'Legal Team'],
    steps: [
      { no: 1, title: 'Case Creation', who: 'Analyst/System', what: 'Case created from alert flag, manual referral, or auto-trigger. Type assigned: Fraud / NPA / KYC / AML / Compliance. Priority set: P1-P4.', tip: 'Always link case to source alert for traceability' },
      { no: 2, title: 'Assignment', who: 'Supervisor', what: 'Case assigned to appropriate analyst based on type, workload, and expertise. Assignment triggers notification to analyst. SLA clock starts.', sla: 'Within 2h of case creation for P1 cases' },
      { no: 3, title: 'CAS (Causal Analysis Stage)', who: 'Lead Analyst', what: 'Root cause analysis: Why did this risk occur? What are the contributing factors? What is the severity? CAS submitted for Checker review.', tip: 'CAS is mandatory — regulator requires root cause for all material cases' },
      { no: 4, title: 'CAP (Corrective Action Plan)', who: 'Analyst + Supervisor', what: 'Corrective actions defined: Who owns, what to do, by when. CAP approved by Checker. Case CANNOT be closed until all CAP items are completed.', tip: 'CAP closure is a hard gate for case closure' },
      { no: 5, title: 'Evidence Collection', who: 'Analyst', what: 'Documents uploaded to evidence vault. Site visits logged with GPS. AML screening completed. Financial analysis documented.' },
      { no: 6, title: 'Action Execution', who: 'Analyst + Field Teams', what: 'Actions executed: restructuring offer, OTS negotiation, legal notice, account block. Every action logged with timestamp and actor.' },
      { no: 7, title: 'Maker-Checker (if required)', who: 'Maker + Checker', what: 'For sensitive actions (write-off > threshold, SAR filing, account closure): Maker submits with rationale → Checker approves/rejects.', tip: 'CRO approval needed for write-offs > ₹1Cr' },
      { no: 8, title: 'Case Closure', who: 'Analyst + Supervisor', what: 'Case closed with outcome: Resolved/Fraud Confirmed/Recovery Complete. All CAPs must be closed. CAS documented. Audit trail complete.' },
    ],
    outcome: 'Fully documented case record ready for regulatory examination, with complete audit trail from creation to closure.',
    commonMistakes: [
      'Closing case before all CAP items are completed',
      'Missing CAS documentation (regulatory compliance failure)',
      'Not linking SAR case to compliance reporting',
      'Insufficient evidence for fraud-confirmed closure',
    ],
    route: '/cms/cases',
    module: 'Case Management System',
  },

  {
    id: 'investigation_workflow',
    name: 'Investigation Workflow',
    keywords: ['investigation workflow', 'how does investigation work', 'investigation process', 'fraud investigation workflow', 'investigation steps', 'sar workflow'],
    keywords_hi: ['जांच वर्कफ्लो', 'Investigation workflow'],
    summary: `**Investigation Workflow** — BIL §17 standard 8-step structured investigation process.

Fraud and risk investigations in ZorEWS follow a regulated, evidence-based process designed to meet FIU-IND and RBI evidentiary standards.`,
    actors: ['Fraud Analyst', 'Risk Analyst', 'Field Officer', 'Supervisor', 'Compliance Officer'],
    steps: [
      { no: 1, title: 'Case Intake', who: 'System/Analyst', what: 'Investigation case opened from CMS. Type: Fraud/NPA/KYC/AML. Checklist assigned based on type.', tip: 'Type must be correct — each type has different checklist' },
      { no: 2, title: 'Identity Verification', who: 'Analyst', what: 'Verify: Aadhaar, PAN, passport, company registration. Cross-check against KYC records. Flag any discrepancies.', sla: '2h for P1 cases' },
      { no: 3, title: 'Account/Policy History', who: 'Analyst', what: 'Pull complete account history: loan performance, repayment, bureau report, prior alerts. Insurance: policy history, prior claims, persistency.', tip: 'Bureau report is mandatory for all fraud investigations' },
      { no: 4, title: 'AML Screening', who: 'Analyst + System', what: 'Run customer through: OFAC SDN list, UN sanctions, domestic blacklist (CIBIL default list), adverse media. Flag PEP status.', tip: 'AML screen is required BEFORE any SAR can be filed' },
      { no: 5, title: 'Document Review', who: 'Analyst', what: 'Review all documents in DMS vault: income proof, bank statements, property papers. Flag: missing docs, expired docs, suspected forgery.', tip: 'Send suspected forged docs to forensics — do not alert customer' },
      { no: 6, title: 'Red Flag Analysis', who: 'Analyst', what: 'Apply BIL red flag checklist: transaction velocity, related party circles, geographic anomaly, income vs credit mismatch, channel risk patterns.' },
      { no: 7, title: 'Site Inspection/Interview', who: 'Field Officer', what: 'Physical site visit with GPS log. Photograph premises. Customer/guarantor interview. Inventory check for collateral.', tip: 'GPS log is mandatory for field visit evidence — use mobile app' },
      { no: 8, title: 'Final Recommendation + SAR', who: 'Senior Analyst + Supervisor', what: 'Verdict: Fraud Confirmed / Unsubstantiated / Partial Fraud. If confirmed: SAR prepared and filed with FIU-IND within 7 days. Confidentiality maintained — customer NOT informed.', sla: 'SAR filing within 7 days of fraud confirmation', tip: 'SAR confidentiality is legally mandated — ANY disclosure is criminal' },
    ],
    outcome: 'Investigation closed with documented verdict, evidence package, and (if required) SAR filed with FIU-IND.',
    commonMistakes: [
      'Filing SAR without completing AML screening (Step 4 mandatory)',
      'Informing customer about SAR filing (criminal offence)',
      'Closing investigation without site inspection for large cases',
      'Missing 7-day SAR filing deadline',
    ],
    route: '/investigation-center',
    module: 'Investigation Center',
  },

  {
    id: 'compliance_workflow',
    name: 'Compliance Workflow',
    keywords: ['compliance workflow', 'how does compliance work', 'regulatory compliance workflow', 'rbi filing workflow', 'aml filing workflow', 'compliance process'],
    keywords_hi: ['अनुपालन वर्कफ्लो', 'Compliance workflow'],
    summary: `**Compliance Workflow** — From regulatory obligation to filed submission.

ZorEWS manages the complete compliance cycle for RBI, Basel, AML/KYC, and IRDAI obligations.`,
    summary_hinglish: `**Compliance Workflow** — Regulatory obligation identify karo → Data collect karo → Gap fix karo → Evidence package banao → File karo.`,
    actors: ['Regulatory Calendar', 'Compliance Officer', 'Data Team', 'Risk Analyst', 'CRO', 'CISO'],
    steps: [
      { no: 1, title: 'Obligation Identified', who: 'Regulatory Calendar', what: 'Filing deadline automatically surfaced in Regulatory Compliance Center calendar. Owner assigned. Countdown clock started.', tip: 'Subscribe to RBI/IRDAI circulars for new obligations' },
      { no: 2, title: 'Data Collection', who: 'System + Data Team', what: 'Platform auto-aggregates required data: loan book, NPA status, transaction flags, KYC status, solvency position. Data quality gated.', sla: 'Data ready 15 days before filing deadline' },
      { no: 3, title: 'Gap Assessment', who: 'Compliance Officer', what: 'Identify gaps: missing KYC documents, unresolved AML flags, incomplete evidence, threshold breaches. Gap report generated.', tip: 'Run gap assessment 20 days before deadline — not 5 days' },
      { no: 4, title: 'Remediation', who: 'Risk Analyst + Operations', what: 'Close gaps: KYC refresh initiated, AML investigations resolved, evidence collected, threshold actions taken. CAP if required.', sla: 'Remediation complete 7 days before filing' },
      { no: 5, title: 'Evidence Packaging', who: 'System + Compliance Officer', what: 'Evidence package assembled from audit trail, investigation records, and data outputs. SHA-256 hash generated for tamper-evidence.', tip: 'Use ZorEWS evidence packager — manual Word documents not accepted' },
      { no: 6, title: 'Internal Review', who: 'CRO + CISO + Compliance', what: 'Maker-Checker review: Compliance Officer (Maker) submits → CRO (Checker) reviews and approves. Readiness score must be ≥ 90%.', sla: '5 days before filing deadline' },
      { no: 7, title: 'Regulatory Submission', who: 'Compliance Officer', what: 'Package submitted via approved channel: RBI XBRL portal, FIU-IND portal, IRDAI system. Submission ID captured and stored.', tip: 'Screenshot submission confirmation — proof of timely filing' },
      { no: 8, title: 'Post-Submission Monitoring', who: 'Compliance Officer', what: 'Monitor for regulator queries, acknowledgment, follow-up requests. All responses logged in compliance center with audit trail.' },
    ],
    outcome: 'Filing submitted on time with evidence-backed package, zero gaps, and dual-approval sign-off.',
    commonMistakes: [
      'Starting data collection < 10 days before deadline (too late)',
      'Not using evidence packager (regulator rejects manual formats)',
      'Missing CRO sign-off before submission',
      'Not logging submission confirmation reference number',
    ],
    route: '/regulatory-compliance-center',
    module: 'Regulatory Compliance Center',
  },

  {
    id: 'recovery_workflow',
    name: 'Recovery & Collections Workflow',
    keywords: ['recovery workflow', 'collections workflow', 'how does recovery work', 'npa recovery workflow', 'debt collection workflow', 'recovery process'],
    keywords_hi: ['रिकवरी वर्कफ्लो', 'Recovery workflow'],
    summary: `**Recovery & Collections Workflow** — Systematic NPA recovery from soft outreach to asset resolution.`,
    summary_hinglish: `**Recovery Workflow** — NPA se maximum paisa wapas kaise layen — step by step.`,
    actors: ['Collection Officer', 'Relationship Manager', 'Legal Team', 'Field Officer', 'Recovery Manager', 'CRO'],
    steps: [
      { no: 1, title: 'NPA Identification', who: 'System + Risk Analyst', what: 'Account crosses DPD 90 → NPA classification. Recovery case created in CMS. Assigned to Collection Officer. Exposure and collateral value reviewed.' },
      { no: 2, title: 'Soft Recovery (0-30 days)', who: 'Collection Officer + RM', what: 'Phase 1: Outreach calls, WhatsApp reminders, email. Offer payment plans. Check customer willingness. Log every contact in case timeline.', tip: 'Success rate highest in first 30 days — prioritize' },
      { no: 3, title: 'Formal Notice', who: 'Legal Team', what: 'SARFAESI Section 13(2) demand notice issued. 60-day response window. Notice served via registered post + WhatsApp + email.', sla: 'Within 90 days of NPA classification' },
      { no: 4, title: 'OTS Negotiation', who: 'Recovery Manager', what: 'If customer responsive: OTS offer structured based on collateral value, customer repayment capacity. CRO approval if OTS > ₹1Cr. Board approval if > ₹10Cr.', tip: 'OTS board approval threshold varies by bank policy — check before offering' },
      { no: 5, title: 'Asset Valuation', who: 'Valuation Team', what: 'Collateral re-valued. Current market value vs original valuation. Haircut calculated. Recovery potential estimated.' },
      { no: 6, title: 'Legal Action (if non-responsive)', who: 'Legal Team', what: 'SARFAESI possession → Asset auction. DRT filing for > ₹20L. IBC/NCLT for corporate cases > ₹1Cr. Write-off authorization with board approval.' },
      { no: 7, title: 'Asset Resolution', who: 'Recovery Manager', what: 'Asset auctioned via approved platform. Proceeds recovered. Partial recovery booked. Write-off amount finalized and reported to board + RBI.' },
      { no: 8, title: 'Case Closure', who: 'Recovery Manager + Compliance', what: 'Recovery case closed with outcome. IFRS9 stage updated. Regulatory reporting completed (write-off in NPA schedule).', tip: 'Recovery of written-off amount in future → Book as income (reversal of provision)' },
    ],
    outcome: 'Maximum recovery from NPA portfolio with documented, compliant process. Recovery rate target: 65%+',
    commonMistakes: [
      'Starting OTS discussion without collateral valuation',
      'Missing 60-day SARFAESI notice window',
      'Write-off authorization without board approval',
      'Not logging customer contact attempts (legal evidence)',
    ],
    route: '/recovery-center',
    module: 'Recovery Center',
  },

  {
    id: 'maker_checker_workflow',
    name: 'Maker-Checker (4-Eyes) Workflow',
    keywords: ['maker checker workflow', 'how does maker checker work', 'maker checker process', '4 eyes workflow', 'four eyes workflow', 'dual control', 'segregation of duties workflow'],
    keywords_hi: ['मेकर-चेकर वर्कफ्लो', 'Maker checker kaise kaam karta hai'],
    summary: `**Maker-Checker Workflow** — Dual-control oversight for all sensitive decisions.

The 4-eyes principle ensures no single person can complete a sensitive action alone. RBI mandates this for all high-value and high-risk decisions.`,
    summary_hinglish: `**Maker-Checker** — Ek kaam karo, dusra approve kare. Khud approve nahi kar sakte.

RBI mandate: Sab sensitive decisions ke liye 4-eyes required.`,
    actors: ['Maker (initiating analyst)', 'Checker (approving supervisor)', 'System (enforcement)'],
    steps: [
      { no: 1, title: 'Maker Initiates Action', who: 'Risk Analyst / Officer (Maker)', what: 'Analyst initiates sensitive action: case closure, write-off, CAP approval, rule activation, model promotion, SAR filing. Provides rationale (mandatory, max 4000 chars).', tip: 'Rationale must be specific — "Close case" is NOT acceptable' },
      { no: 2, title: 'Action Queued (Pending)', who: 'System', what: 'Action placed in pending queue. Status: PENDING. Maker cannot execute — system blocks self-approval cryptographically.', sla: 'Checker notified within 2 minutes' },
      { no: 3, title: 'Checker Notified', who: 'System → Supervisor/Senior', what: 'Checker receives notification: email + push notification + in-app alert. Pending item appears in their approval queue with priority flag.', tip: 'Checker SLA: Critical actions 4h, High 24h, Standard 48h' },
      { no: 4, title: 'Checker Reviews Evidence', who: 'Supervisor / Head of Risk (Checker)', what: 'Checker reviews: Full case evidence, maker rationale, linked documents, audit trail. Can ask for more information before deciding.' },
      { no: 5, title: 'Checker Decision', who: 'Checker', what: 'APPROVE → Action executes immediately. REJECT → Maker notified with mandatory rejection reason. DEFER → Request more information.', tip: 'Rejection reason must be actionable — helps maker fix and resubmit' },
      { no: 6, title: 'Action Executed / Cancelled', who: 'System', what: 'Approved: Action executes. Case closed, write-off processed, rule activated. Rejected: Action cancelled, maker notified, counter reset.' },
      { no: 7, title: 'Audit Logged', who: 'System', what: 'Complete maker-checker record written to immutable audit chain: maker_username, checker_username, action, rationale, decision, decision_notes, timestamps.' },
    ],
    outcome: 'Sensitive decisions are executed only with dual approval. Complete audit trail for regulatory evidence.',
    commonMistakes: [
      'Rubber-stamping approvals without reviewing evidence (regulatory violation)',
      'Missing rejection reason (actionable feedback mandatory)',
      'Escalating to same-level approver (must be senior)',
      'Delaying approval beyond SLA (creates operational bottleneck)',
    ],
    route: '/cms/cases',
    module: 'Case Management System',
  },

  {
    id: 'npa_early_warning_workflow',
    name: 'NPA Early Warning Workflow',
    keywords: ['npa early warning workflow', 'ews workflow', 'early warning workflow', 'npa prevention workflow', 'how npa early warning works', 'npa alert process'],
    keywords_hi: ['NPA early warning workflow', 'EWS workflow'],
    summary: `**NPA Early Warning Workflow** — Detect and prevent NPA 30-90 days before DPD 90.

ZorEWS intercepts borrowers before they become NPA using AI scoring + rule-based triggers.`,
    actors: ['AI Model', 'EWS Rule Engine', 'Risk Analyst', 'Relationship Manager', 'Collection Officer'],
    steps: [
      { no: 1, title: 'Daily Data Refresh', who: 'System', what: 'CBS data loaded → DPD, utilization, repayment updated → Indicators recalculated → AI model rescored. Runs at 06:00 IST daily.', sla: 'Complete by 07:00 IST' },
      { no: 2, title: 'Risk Scoring', who: 'AI Model (XGBoost + SHAP)', what: 'Every borrower scored: PD (0-1), SMA classification (SMA-0/1/2), risk band (Low/Medium/High). Accounts with PD > 0.60 enter Early Warning List.', tip: 'PD threshold for EWL is configurable per segment' },
      { no: 3, title: 'Alert Generation', who: 'Rule Engine', what: 'SMA rule fires → Alert created (Orange/Red depending on SMA level). AI model crossing 0.75 → Red alert. Both link to customer profile.' },
      { no: 4, title: 'EWL Review', who: 'Risk Analyst', what: 'Morning review of Early Warning List. Prioritize by: PD level, exposure size, DPD trend. Assign to Relationship Manager / Collection Officer.', tip: 'Review EWL before 09:00 every morning' },
      { no: 5, title: 'Outreach (Within 5 Days)', who: 'Relationship Manager', what: 'Contact customer: phone call, branch visit. Understand reason for stress. Offer: restructuring, EMI holiday, top-up loan. Log contact in case.', sla: 'Within 5 days of EWL entry' },
      { no: 6, title: 'Escalation (If No Response)', who: 'Collection Officer', what: 'No response in 7 days → Escalate to senior collection team. Formal visit. Restructuring offer with legal notice warning.' },
      { no: 7, title: 'Case Creation (If Needed)', who: 'Risk Analyst', what: 'Account not responding, DPD accelerating → Create NPA Case in CMS. Full investigation workflow initiated.' },
      { no: 8, title: 'Outcome Capture', who: 'Analyst', what: 'Outcome logged: Cured (DPD normalized), Restructured (new repayment schedule), Escalated (NPA imminent), NPA Confirmed.' },
    ],
    outcome: 'Intervention within 5-7 days of early warning → 30-40% NPA prevention rate on EWL accounts.',
    commonMistakes: [
      'Not reviewing EWL daily (48h delay significantly reduces cure rate)',
      'Contacting customer via phone only (use SMS + email + visit)',
      'Offering restructuring without collateral valuation update',
      'Not logging contact attempts (breaks audit trail)',
    ],
    route: '/banking/npa-prediction',
    module: 'Predictive Risk Center',
  },
];

// ─── Lookup helpers ───────────────────────────────────────────────────────

export function findWorkflowKnowledge(query: string): WorkflowKnowledge | undefined {
  const q = query.toLowerCase();
  return WORKFLOW_KNOWLEDGE.find(w =>
    w.keywords.some(k => q.includes(k)) ||
    w.keywords_hi.some(k => query.includes(k)) ||
    w.name.toLowerCase().includes(q)
  );
}

export function formatWorkflowKnowledgeResponse(
  wf: WorkflowKnowledge,
  lang: 'en' | 'hi' | 'hinglish',
): CopilotResponse {
  const summary = lang === 'hinglish' && wf.summary_hinglish
    ? wf.summary_hinglish
    : wf.summary;

  const stepLines = wf.steps.map(s => {
    const slaStr = s.sla ? ` *(SLA: ${s.sla})*` : '';
    const tipStr = s.tip ? `\n   💡 *${s.tip}*` : '';
    return `**Step ${s.no}: ${s.title}** — ${s.who}\n${s.what}${slaStr}${tipStr}`;
  }).join('\n\n');

  const outcome = lang === 'hi' && wf.outcome_hi ? wf.outcome_hi : wf.outcome;
  const actorsStr = wf.actors.join(' → ');

  const fullReply = `${summary}\n\n**Actors:** ${actorsStr}\n\n${stepLines}\n\n**Outcome:** ${outcome}`;

  return {
    reply: fullReply,
    suggestions: [
      `Open ${wf.module}`,
      `What are common mistakes in ${wf.name}?`,
      `What is the SLA for each step?`,
      `Who are the key actors?`,
    ],
    sections: [
      {
        title: 'Common Mistakes to Avoid',
        type: 'bullets',
        items: wf.commonMistakes,
      },
    ],
    actions: [
      { label: `Open ${wf.module}`, href: wf.route, icon: 'external-link' },
    ],
  };
}
