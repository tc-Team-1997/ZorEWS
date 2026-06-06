// copilotRoleGuideCatalog.ts
//
// ZorEWS Copilot — Role-Based Training Catalog
// Provides personalized platform training based on user role.
// Answers "I am a Risk Analyst, what should I focus on?"
//
// 100% additive — no existing logic changed.

export interface RoleGuide {
  role:               string;
  keywords:           string[];
  title:              string;
  description:        string;
  responsibilities:   string[];
  primaryScreens:     Array<{ label: string; route: string; reason: string }>;
  kpis:               string[];
  dailyWorkflow:      string[];
  weeklyWorkflow:     string[];
  keyWorkflows:       string[];
  bestPractices:      string[];
  suggestedQuestions: string[];
}

export const ROLE_GUIDES: RoleGuide[] = [

  {
    role: 'risk_analyst',
    keywords: ['risk analyst', 'i am a risk analyst', 'risk analysis', 'credit risk analyst', 'portfolio risk analyst'],
    title: 'Risk Analyst',
    description: 'Risk Analysts are the frontline of the EWS platform — monitoring portfolio health, investigating alerts, managing NPA early warning, and initiating cases.',
    responsibilities: [
      'Monitor and acknowledge risk alerts within SLA',
      'Conduct NPA early warning reviews for high-PD accounts',
      'Initiate and manage investigations for fraud and credit cases',
      'Review SHAP explainability for AI risk decisions',
      'Maintain SMA-0/1/2 classification accuracy',
      'Prepare evidence for regulatory submissions',
    ],
    primaryScreens: [
      { label: 'Alert Center', route: '/alerts', reason: 'Your primary queue — acknowledge and triage all risk alerts daily' },
      { label: 'Predictive Risk Center', route: '/predictive-risk-center', reason: 'Check NPA predictions, early warning list, and AI forecasts' },
      { label: 'Investigation Center', route: '/investigation-center', reason: 'Manage active investigations with the 8-step evidence checklist' },
      { label: 'CMS Cases', route: '/cms/cases', reason: 'Full case lifecycle management with maker-checker approvals' },
      { label: 'Customer Intelligence', route: '/customers', reason: 'Deep-dive into high-risk customer profiles with SHAP factors' },
      { label: 'NPA Prediction', route: '/banking/npa-prediction', reason: 'Your AI-powered early warning list — review daily' },
      { label: 'SMA Classification', route: '/banking/sma', reason: 'Monitor DPD-based SMA migration — regulatory requirement' },
    ],
    kpis: [
      'Alerts acknowledged within SLA (%)',
      'Cases resolved per day',
      'Investigation closure rate (%)',
      'NPA early warning accounts actioned',
      'False positive rate on raised alerts',
    ],
    dailyWorkflow: [
      '1. Review alert queue — acknowledge all Critical and High alerts within SLA',
      '2. Check NPA Early Warning List — review AI predictions for accounts > PD 0.60',
      '3. Update open investigations — add evidence, complete checklist steps',
      '4. Review CMS case queue — action pending items before SLA breach',
      '5. Generate daily briefing — review Executive Summary in Copilot',
    ],
    weeklyWorkflow: [
      'SMA review — verify DPD classifications match CBS data',
      'Predictive forecast review — check 90-day NPA trajectory',
      'Fraud signals audit — review and clear false positives',
      'Investigation KPI review — measure closure rate vs targets',
      'Rule performance check — ensure firing rates and FP% within thresholds',
    ],
    keyWorkflows: ['Alert Lifecycle', 'Investigation Workflow', 'NPA Early Warning', 'Maker-Checker Approval'],
    bestPractices: [
      'Always acknowledge alerts within SLA — escalation happens automatically at breach',
      'Use SHAP explainability to verify AI risk scores before actioning',
      'Complete all 8 investigation steps — partial evidence is not submission-ready',
      'Correlate alerts before opening separate cases — check for linked customers',
      'Log every customer interaction in the case timeline with GPS when applicable',
    ],
    suggestedQuestions: [
      'Show critical alerts in my queue',
      'Who are the top 10 high-risk borrowers today?',
      'NPA early warning accounts',
      'Why is this customer score high?',
      'Show open investigations needing action',
    ],
  },

  {
    role: 'fraud_analyst',
    keywords: ['fraud analyst', 'i am a fraud analyst', 'fraud detection', 'fraud investigator', 'aml analyst'],
    title: 'Fraud Analyst',
    description: 'Fraud Analysts detect, investigate, and report fraudulent activities including synthetic identity fraud, AML violations, and transaction manipulation.',
    responsibilities: [
      'Monitor real-time fraud signals and velocity alerts',
      'Investigate fraud clusters and synthetic identity patterns',
      'Conduct AML/KYC screening and due diligence',
      'File Suspicious Activity Reports (SARs) with FIU-IND',
      'Manage watch-listed accounts and AML cases',
      'Collaborate with law enforcement when required',
    ],
    primaryScreens: [
      { label: 'Fraud Signals', route: '/fraud-signals', reason: 'Your primary fraud detection dashboard — real-time signals' },
      { label: 'Alert Center (Critical/High)', route: '/alerts', reason: 'Fraud-related critical alerts require immediate triage' },
      { label: 'Investigation Center', route: '/investigation-center', reason: 'All fraud investigations managed here with SAR workflow' },
      { label: 'Account Behaviour', route: '/account-behaviour', reason: 'Behavioral anomaly detection for fraud pattern identification' },
      { label: 'Regulatory Compliance', route: '/regulatory-compliance-center', reason: 'AML filing compliance and FIU-IND SAR submission tracking' },
      { label: 'Customer Intelligence', route: '/customers', reason: 'Customer 360 for fraud cluster analysis' },
    ],
    kpis: [
      'Fraud alerts triaged within 2h SLA (%)',
      'SAR filings completed on time (%)',
      'Fraud cluster investigations closed',
      'AML screening coverage rate (%)',
      'False positive rate for fraud alerts',
    ],
    dailyWorkflow: [
      '1. Review fraud signals dashboard — check new clusters and velocity anomalies',
      '2. Acknowledge all Critical fraud alerts within 2-hour SLA',
      '3. Update active fraud investigations — add evidence, complete AML screens',
      '4. Check AML watchlist updates — review new matches against customer base',
      '5. Review SAR filing queue — ensure on-time submission to FIU-IND',
    ],
    weeklyWorkflow: [
      'Fraud model performance review — check AUC and precision metrics',
      'Cluster analysis — identify emerging fraud patterns across portfolio',
      'AML monthly filing preparation — reconcile flagged transactions',
      'Peer review of open investigations — escalation decisions',
    ],
    keyWorkflows: ['Alert Lifecycle', 'Investigation Workflow (Fraud)', 'Compliance Workflow (AML/SAR)', 'Maker-Checker Approval'],
    bestPractices: [
      'Always correlate fraud alerts — synthetic identity rings span multiple accounts',
      'Complete AML screening (Step 4) before advancing investigation — required for SAR',
      'Document every finding with timestamp — FIU-IND requires date-accurate evidence',
      'Use AI clustering to find connected accounts before filing individual SARs',
      'Coordinate with legal before making any external disclosure of fraud findings',
    ],
    suggestedQuestions: [
      'Show current fraud clusters',
      'AML filing status this month',
      'Open fraud investigations',
      'Accounts with suspicious transaction velocity',
      'SAR filings pending approval',
    ],
  },

  {
    role: 'collection_officer',
    keywords: ['collection officer', 'i am a collection officer', 'recovery officer', 'collections', 'debt collection'],
    title: 'Collection Officer',
    description: 'Collection Officers manage NPA recovery operations — from early-stage outreach to formal legal action, ensuring maximum recovery from defaulted accounts.',
    responsibilities: [
      'Manage assigned NPA recovery cases end-to-end',
      'Conduct customer outreach (calls, visits, notices)',
      'Log all customer interactions with GPS evidence',
      'Negotiate OTS and restructuring proposals',
      'Track legal proceedings and SARFAESI actions',
      'Maintain SLA compliance on recovery cases',
    ],
    primaryScreens: [
      { label: 'CMS Cases (My Queue)', route: '/cms/cases', reason: 'Your primary work queue — all assigned recovery cases' },
      { label: 'Collections Risk', route: '/collections-risk', reason: 'Portfolio-level collection efficiency and SLA tracking' },
      { label: 'Recovery Center', route: '/recovery-center', reason: 'Recovery pipeline — from NPA to write-off or OTS resolution' },
      { label: 'Borrower Watch', route: '/borrower-watch', reason: 'Monitor assigned high-risk accounts before NPA' },
      { label: 'Borrower Timeline', route: '/borrower-timeline', reason: 'Complete account history for every assigned borrower' },
    ],
    kpis: [
      'Recovery rate (%)',
      'Cases resolved within SLA (%)',
      'Average case resolution time (days)',
      'OTS proposals accepted',
      'SLA breach rate (%)',
    ],
    dailyWorkflow: [
      '1. Review case queue — identify SLA breaches that need immediate action',
      '2. Customer outreach — calls and follow-ups per daily plan',
      '3. Log all interactions — visit logs with GPS, call outcomes in case timeline',
      '4. Update case status — pending legal, restructuring offer, etc.',
      '5. Submit recovery plan approvals — maker-checker queue before EOD',
    ],
    weeklyWorkflow: [
      'Weekly recovery rate review — compare against 68% target',
      'Legal case status update — check court dates, DRT filings',
      'Collateral valuation review — update haircut estimates',
      'Escalation decisions — move non-responsive accounts to legal',
    ],
    keyWorkflows: ['Recovery & Collection Workflow', 'NPA Early Warning Workflow', 'Maker-Checker Approval'],
    bestPractices: [
      'Log every customer contact within 2 hours — SLA evidence',
      'Use GPS visit logging on mobile app — required for site visit evidence',
      'Escalate non-responsive accounts before SMA-2 → NPA transition',
      'Coordinate with legal team 7 days before court dates',
      'Document OTS negotiation details in CAP — required for board approval',
    ],
    suggestedQuestions: [
      'Show my cases with SLA breaches',
      'Recovery rate this month',
      'Cases pending maker-checker approval',
      'High-exposure NPA accounts',
      'Legal cases due for court hearing',
    ],
  },

  {
    role: 'supervisor',
    keywords: ['supervisor', 'i am a supervisor', 'team supervisor', 'senior analyst', 'team manager'],
    title: 'Supervisor / Team Manager',
    description: 'Supervisors oversee risk analyst teams, approve sensitive decisions through maker-checker, and ensure team SLA compliance and quality.',
    responsibilities: [
      'Review and approve sensitive case actions (maker-checker)',
      'Monitor team SLA compliance and workload distribution',
      'Escalate high-priority cases to head of risk',
      'Review investigation quality and completeness',
      'Approve OTS proposals, CAPs, and write-off requests',
      'Conduct team performance reviews',
    ],
    primaryScreens: [
      { label: 'CMS Maker-Checker Queue', route: '/cms/cases?status=PENDING_APPROVAL', reason: 'Your primary queue — approve or reject pending sensitive actions' },
      { label: 'Alert Center', route: '/alerts', reason: 'Monitor team alert queue — SLA compliance oversight' },
      { label: 'Investigation Center', route: '/investigation-center', reason: 'Review and approve investigation closures' },
      { label: 'Dashboard (Main)', route: '/', reason: 'Enterprise risk overview — escalations and portfolio status' },
      { label: 'Collections Risk', route: '/collections-risk', reason: 'Team collection performance and SLA tracking' },
    ],
    kpis: [
      'Team SLA compliance (%)',
      'Maker-checker queue cleared daily',
      'Cases escalated to Head of Risk',
      'Team case resolution rate',
      'Pending approvals count',
    ],
    dailyWorkflow: [
      '1. Clear maker-checker approval queue — approve/reject within SLA',
      '2. Review team dashboard — identify SLA breaches and overdue items',
      '3. Monitor critical alert queue — ensure team is responding within SLA',
      '4. Review investigation quality — check completeness before closure',
      '5. Daily team briefing — communicate priorities and escalations',
    ],
    weeklyWorkflow: [
      'Team performance review — case closure rate vs targets',
      'SLA breach analysis — identify systemic bottlenecks',
      'Escalation decisions — cases requiring Head of Risk involvement',
      'Maker-checker audit — review all approved/rejected decisions',
    ],
    keyWorkflows: ['Maker-Checker Approval', 'Alert Lifecycle', 'Investigation Workflow'],
    bestPractices: [
      'Never rubber-stamp approvals — review the full case evidence before approving',
      'Reject with clear documented reasoning — the maker needs to understand what to fix',
      'Escalate any case with > ₹50 Cr exposure immediately to Head of Risk',
      'Monitor SLA breach rate daily — address before end of week',
      'Conduct random quality checks on 10% of closed investigations weekly',
    ],
    suggestedQuestions: [
      'Show pending maker-checker approvals',
      'Team SLA compliance today',
      'Cases escalated this week',
      'High-priority pending decisions',
      'SLA breaches in my team',
    ],
  },

  {
    role: 'executive',
    keywords: ['cro', 'ceo', 'executive', 'chief risk officer', 'board member', 'i am a cro', 'i am a ceo', 'i am an executive', 'management'],
    title: 'CRO / Executive Leadership',
    description: 'Executives and CROs use ZorEWS for strategic risk oversight — portfolio-level risk appetite, regulatory compliance, and board-level reporting.',
    responsibilities: [
      'Monitor enterprise risk index and risk appetite framework',
      'Approve high-stakes decisions (write-offs, large OTS)',
      'Review regulatory compliance and filing status',
      'Oversee AI model governance and model risk',
      'Present risk dashboard to board',
      'Sign off on major strategic risk decisions',
    ],
    primaryScreens: [
      { label: 'Executive Risk Cockpit', route: '/executive-cockpit', reason: 'Your primary screen — Enterprise Risk Index, portfolio health, board readiness' },
      { label: 'Board Reporting Center', route: '/board-reporting-center', reason: 'Generate board packs, regulatory submissions, and presentations' },
      { label: 'Predictive Risk Center', route: '/predictive-risk-center', reason: 'AI-powered 90-180 day risk outlook for strategic decisions' },
      { label: 'Digital Twin Center', route: '/digital-twin-center', reason: 'Stress test portfolio under RBI/IRDAI scenarios for board discussions' },
      { label: 'Regulatory Compliance', route: '/regulatory-compliance-center', reason: 'Compliance readiness dashboard for regulatory oversight' },
      { label: 'AI Governance Center', route: '/ai/governance', reason: 'Oversight of all AI models in production use' },
    ],
    kpis: [
      'Enterprise Risk Index (0-100)',
      'Portfolio NPA ratio (%)',
      'Regulatory compliance readiness (%)',
      'ECL under severely adverse scenario',
      'Active critical alerts requiring CRO attention',
    ],
    dailyWorkflow: [
      '1. Review Enterprise Risk Index — check for material changes from yesterday',
      '2. AI daily briefing — review top 3 strategic risks from Copilot',
      '3. Check regulatory calendar — any submissions due within 14 days?',
      '4. Approve any decisions at CRO threshold (write-offs, large exposures)',
    ],
    weeklyWorkflow: [
      'Board readiness review — update board pack progress',
      'AI model performance — check AUC and drift metrics',
      'Stress test review — run updated RBI severely adverse scenario',
      'Regulatory compliance — resolve any gaps before filing deadlines',
    ],
    keyWorkflows: ['Maker-Checker Approval (CRO level)', 'Compliance Workflow', 'AI Model Promotion Workflow'],
    bestPractices: [
      'Use the Executive Risk Cockpit daily — it\'s your single source of truth',
      'Board pack prep: start 14 days before board meeting using Board Reporting Center',
      'Stress test: run quarterly RBI scenario before each regulatory filing',
      'Any model with AUC drop > 0.05 should trigger re-validation — enforce this',
      'Review AI decisions for bias monthly — RBI MRM requirement',
    ],
    suggestedQuestions: [
      'Executive risk summary',
      'Enterprise Risk Index today',
      'Regulatory compliance status',
      'Board pack readiness',
      'Run RBI severely adverse stress test',
      'Top 5 risks requiring board attention',
    ],
  },

  {
    role: 'compliance_officer',
    keywords: ['compliance officer', 'i am a compliance officer', 'compliance manager', 'regulatory officer', 'aml compliance'],
    title: 'Compliance Officer',
    description: 'Compliance Officers ensure the institution meets all regulatory obligations — RBI, Basel III, AML/KYC, and IRDAI — with documented, evidence-backed submissions.',
    responsibilities: [
      'Monitor and meet all regulatory filing deadlines',
      'Manage AML/KYC compliance gaps and remediation',
      'Generate evidence packages for regulatory submissions',
      'Coordinate with risk teams on compliance data needs',
      'Maintain compliance readiness score above threshold',
      'Conduct periodic KYC reviews and refresh',
    ],
    primaryScreens: [
      { label: 'Regulatory Compliance Center', route: '/regulatory-compliance-center', reason: 'Your primary screen — all regulatory obligations, gaps, and filing calendar' },
      { label: 'Audit Center', route: '/audit-center', reason: 'Evidence packaging and tamper-evident audit trail for submissions' },
      { label: 'Board Reporting Center', route: '/board-reporting-center', reason: 'Generate regulatory submissions and compliance reports' },
      { label: 'Investigation Center', route: '/investigation-center', reason: 'SAR filing management and AML investigation oversight' },
    ],
    kpis: [
      'Overall compliance readiness (%)',
      'Overdue regulatory filings',
      'AML flagged transactions resolved (%)',
      'KYC periodic review completion (%)',
      'Evidence packages generated',
    ],
    dailyWorkflow: [
      '1. Check compliance dashboard — any new gaps or violations?',
      '2. Review filing calendar — filings due within 14 days',
      '3. Update AML/KYC status — resolve queued flags from investigation team',
      '4. Review audit trail — confirm all yesterday\'s actions are logged correctly',
    ],
    weeklyWorkflow: [
      'Filing preparation — data collection and quality verification',
      'KYC review batch — identify accounts requiring refresh',
      'Gap remediation — work with risk team to close compliance gaps',
      'Evidence packaging — build submission packages for upcoming filings',
    ],
    keyWorkflows: ['Compliance Workflow', 'Investigation Workflow (AML/SAR)', 'Alert Lifecycle'],
    bestPractices: [
      'Never wait until filing deadline — start preparation 30 days before',
      'Always use the evidence packager — SHA-256 tamper-proof packages are required by RBI',
      'AML filing: reconcile transaction flags before the 15th of each month',
      'KYC periodic review: complete 100 accounts per week to clear the backlog',
      'Keep audit trail integrity verification running daily — one hash break is non-compliant',
    ],
    suggestedQuestions: [
      'Compliance readiness score today',
      'AML filing status this month',
      'Upcoming regulatory deadlines',
      'KYC review backlog',
      'Generate evidence package for RBI',
    ],
  },

  {
    role: 'auditor',
    keywords: ['auditor', 'i am an auditor', 'internal audit', 'external auditor', 'audit manager'],
    title: 'Auditor',
    description: 'Auditors use ZorEWS to verify platform integrity, review the immutable audit trail, generate evidence packages, and ensure regulatory compliance.',
    responsibilities: [
      'Verify audit trail integrity and hash-chain completeness',
      'Review user access logs and role assignments',
      'Generate evidence packages for regulatory examinations',
      'Audit AI model decisions for bias and accuracy',
      'Review compliance filing documentation',
      'Conduct quarterly access reviews per RBI',
    ],
    primaryScreens: [
      { label: 'Audit Center', route: '/audit-center', reason: 'SHA-256 hash-chained audit log — your primary evidence source' },
      { label: 'Regulatory Compliance Center', route: '/regulatory-compliance-center', reason: 'Compliance status verification and gap analysis' },
      { label: 'IAM Center', route: '/admin/iam', reason: 'Access rights audit and dormant account identification' },
      { label: 'AI Governance Center', route: '/ai/governance', reason: 'AI model audit — performance, bias, and decision audit trail' },
    ],
    kpis: [
      'Audit trail integrity (%)',
      'Evidence packages generated',
      'Access review completion (%)',
      'Compliance gaps identified',
      'AI decisions audited',
    ],
    dailyWorkflow: [
      '1. Verify audit chain integrity — run hash verification check',
      '2. Review flagged audit events — unusual access patterns, after-hours activity',
      '3. Generate evidence package requests — for ongoing regulatory inquiries',
    ],
    weeklyWorkflow: [
      'Access review batch — verify active users vs HR records',
      'AI decision audit — sample review of model decisions for bias',
      'Compliance evidence review — verify submission documentation completeness',
    ],
    keyWorkflows: ['Compliance Workflow', 'Maker-Checker Approval'],
    bestPractices: [
      'Run audit chain integrity check daily — SHA-256 verification is the first control',
      'Access review: cross-reference active users against HR termination list weekly',
      'For any regulatory examination: use the evidence packager, never manual exports',
      'AI audit: review decisions from highest-confidence automated approvals first',
      'Document all audit findings in the audit center with timestamps',
    ],
    suggestedQuestions: [
      'Is the audit chain intact?',
      'Who accessed the platform after hours?',
      'Generate evidence package',
      'Compliance readiness score',
      'Dormant accounts list',
    ],
  },

  {
    role: 'admin',
    keywords: ['admin', 'platform admin', 'system admin', 'administrator', 'i am an admin'],
    title: 'Platform Administrator',
    description: 'Platform Admins manage user access, system configuration, integrations, and platform health across all tenants.',
    responsibilities: [
      'Manage user accounts, roles, and API keys',
      'Monitor platform health and integration status',
      'Configure indicator thresholds and rule templates',
      'Manage tenant settings and governance policies',
      'Review security events and access anomalies',
      'Coordinate quarterly access reviews',
    ],
    primaryScreens: [
      { label: 'IAM Center', route: '/admin/iam', reason: 'User management, roles, API keys — your primary admin tool' },
      { label: 'Security Center', route: '/admin/security', reason: 'Security events, anomaly detection, and access log review' },
      { label: 'Operations Center', route: '/operations-center', reason: 'Platform health, API performance, and incident management' },
      { label: 'Integration Marketplace', route: '/integration-marketplace', reason: 'Monitor and manage all external system integrations' },
      { label: 'Master Setup', route: '/admin/master-setup', reason: 'Platform configuration — thresholds, templates, tenant settings' },
      { label: 'Governance Center', route: '/admin/governance', reason: 'Domain policies and tenant governance management' },
    ],
    kpis: [
      'Platform uptime (%)',
      'Integration health (%)',
      'Dormant accounts count',
      'API key expiry alerts',
      'Security events resolved',
    ],
    dailyWorkflow: [
      '1. Check platform health — operations center (uptime, API latency, errors)',
      '2. Review integration status — check all CBS, bureau, AML connectors',
      '3. Review security events — any after-hours access or anomalies?',
      '4. Check user access requests — pending provisioning queue',
    ],
    weeklyWorkflow: [
      'Access review — dormant accounts (>90 days), expiring API keys',
      'Integration SLA check — latency and availability vs targets',
      'Configuration audit — any unauthorized config changes?',
      'Platform performance review — p95 API latency trends',
    ],
    keyWorkflows: ['IAM Workflow', 'Governance Workflow', 'Recovery Workflow'],
    bestPractices: [
      'Review dormant accounts weekly — disable after 90 days per policy',
      'API key rotation: enforce 90-day rotation policy for all service accounts',
      'Never grant admin role without CRO + CISO dual approval',
      'Monitor integration latency daily — CBS connector latency > 2s is SLA breach',
      'Run security event digest every morning before 09:00',
    ],
    suggestedQuestions: [
      'Platform health status',
      'Dormant user accounts',
      'Integration health report',
      'Security events today',
      'API keys expiring soon',
    ],
  },

];

// ─── Lookup helpers ───────────────────────────────────────────────────────

export function findRoleGuide(query: string): RoleGuide | undefined {
  const q = query.toLowerCase();
  return ROLE_GUIDES.find(r =>
    r.keywords.some(k => q.includes(k)) ||
    r.role === q
  );
}

export function formatRoleGuideResponse(guide: RoleGuide): string {
  const screens = guide.primaryScreens.slice(0, 5).map(s => `• **${s.label}** (\`${s.route}\`) — ${s.reason}`).join('\n');
  const responsibilities = guide.responsibilities.map(r => `• ${r}`).join('\n');
  const daily = guide.dailyWorkflow.map(d => `${d}`).join('\n');
  const kpis = guide.kpis.map(k => `• ${k}`).join('\n');
  const practices = guide.bestPractices.slice(0, 4).map(p => `• ${p}`).join('\n');

  return `**Platform Guide: ${guide.title}**\n\n${guide.description}\n\n**Your Responsibilities:**\n${responsibilities}\n\n**Primary Screens:**\n${screens}\n\n**Key KPIs:**\n${kpis}\n\n**Daily Workflow:**\n${daily}\n\n**Best Practices:**\n${practices}`;
}
