// copilotKnowledgeRegistry.ts
//
// ZorEWS Copilot — Platform Knowledge Registry
// Central registry of every module in the platform.
// Used by the copilot engine for module explainability, navigation,
// screen awareness, and smart fallback responses.
//
// 100% additive — no existing copilot logic changed.

export interface ModuleEntry {
  id:              string;
  name:            string;
  category:        ModuleCategory;
  purpose:         string;
  businessObjective: string;
  users:           string[];
  inputs:          string[];
  outputs:         string[];
  kpis:            string[];
  keyScreens:      string[];
  relatedModules:  string[];
  route:           string | string[];
  /** URL path patterns that map to this module (for screen-aware detection) */
  routePatterns:   string[];
  exampleQuestions: string[];
  dependencies:    string[];
  summary:         string;
}

export type ModuleCategory =
  | 'data'
  | 'risk'
  | 'compliance'
  | 'ai'
  | 'operations'
  | 'admin'
  | 'reporting'
  | 'integration'
  | 'case_management'
  | 'dashboard';

// ─── Master Module Registry ───────────────────────────────────────────────

export const MODULE_REGISTRY: ModuleEntry[] = [

  // ── DATA MODULES ──────────────────────────────────────────────────────
  {
    id: 'data_ingestion',
    name: 'Data Ingestion Center',
    category: 'data',
    purpose: 'Ingest raw data from CBS, core insurance, bureau, AML, IFRS9, and external feeds into the ZorEWS platform.',
    businessObjective: 'Ensure continuous, reliable, and validated data flow from all source systems to power early warning calculations.',
    users: ['Data Engineer', 'Platform Admin', 'Risk Analyst'],
    inputs: ['CBS loan files', 'Bureau reports', 'AML watchlists', 'IFRS9 feeds', 'Insurance policy data'],
    outputs: ['Validated datasets', 'Data quality scores', 'Ingestion logs', 'Failure alerts'],
    kpis: ['Ingestion success rate', 'Data freshness (hours)', 'Schema violations count', 'Pipeline throughput'],
    keyScreens: ['Connector registry', 'Pipeline health dashboard', 'Run history', 'Schema validator'],
    relatedModules: ['data_quality', 'data_fabric', 'data_catalog'],
    route: '/data-ingestion',
    routePatterns: ['/data-ingestion', '/data/ingestion', '/ingestion'],
    exampleQuestions: ['What is Data Ingestion?', 'How does data flow into ZorEWS?', 'What connectors are available?', 'Why is CBS feed failing?'],
    dependencies: ['CBS connector', 'Bureau API', 'AML feed', 'IFRS9 gateway'],
    summary: 'Data Ingestion Center connects ZorEWS to all source systems (CBS, Bureau, AML, IFRS9, Insurance) via validated pipelines with schema enforcement, quality gates, and failure alerting.',
  },

  {
    id: 'data_quality',
    name: 'Data Quality Center',
    category: 'data',
    purpose: 'Monitor, measure, and enforce data quality across all ingested datasets to ensure risk calculations are based on accurate data.',
    businessObjective: 'Prevent bad data from flowing into risk models and indicators. Catch schema violations, null rates, and statistical anomalies before they impact decisions.',
    users: ['Data Steward', 'Risk Analyst', 'Compliance Officer'],
    inputs: ['Ingested raw data', 'Schema definitions', 'Quality rules', 'Threshold configurations'],
    outputs: ['DQ score per dataset', 'Violation reports', 'Remediation queues', 'Audit logs'],
    kpis: ['Overall DQ score (%)', 'Critical violations count', 'Fields with null rate > threshold', 'DQ trend (7-day)'],
    keyScreens: ['DQ scorecard', 'Violation explorer', 'Rule management', 'Dataset profiler'],
    relatedModules: ['data_ingestion', 'data_profiling', 'data_catalog'],
    route: '/dq-score',
    routePatterns: ['/dq-score', '/data-quality', '/dq'],
    exampleQuestions: ['What is Data Quality?', 'How is DQ score calculated?', 'What are current violations?', 'Why is indicator data unreliable?'],
    dependencies: ['data_ingestion'],
    summary: 'Data Quality Center monitors data accuracy, completeness, and consistency across all ingested datasets. It provides violation reports and quality scores that gate data into risk models.',
  },

  {
    id: 'data_profiling',
    name: 'Data Profiling Center',
    category: 'data',
    purpose: 'Automatically profile dataset statistics, distributions, and anomalies to provide deep understanding of data characteristics.',
    businessObjective: 'Give data teams and analysts visibility into dataset health, value distributions, and structural patterns — enabling better model training and indicator calibration.',
    users: ['Data Scientist', 'Risk Analyst', 'Data Engineer'],
    inputs: ['Any ingested dataset', 'Historical snapshots'],
    outputs: ['Statistical profiles', 'Distribution charts', 'Anomaly reports', 'Correlation matrices'],
    kpis: ['Datasets profiled', 'Anomalous columns detected', 'Profile freshness', 'Coverage rate'],
    keyScreens: ['Dataset explorer', 'Column statistics', 'Distribution charts', 'Anomaly heatmap'],
    relatedModules: ['data_quality', 'data_catalog', 'data_ingestion'],
    route: '/data-profiling-ai',
    routePatterns: ['/data-profiling', '/profiling', '/data-profiling-ai'],
    exampleQuestions: ['What is Data Profiling?', 'How do I explore dataset statistics?', 'What columns have anomalies?'],
    dependencies: ['data_ingestion', 'data_quality'],
    summary: 'Data Profiling Center uses AI to automatically generate statistical profiles for every dataset — distributions, outliers, correlations — helping analysts understand data before building models or indicators.',
  },

  {
    id: 'data_catalog',
    name: 'Data Catalog',
    category: 'data',
    purpose: 'Provide a searchable, documented catalog of all datasets, fields, lineage, and business definitions across the platform.',
    businessObjective: 'Enable data discovery and governance. Analysts can find the right dataset for any use case; compliance teams can trace data lineage for regulatory evidence.',
    users: ['Data Steward', 'Risk Analyst', 'Compliance Officer', 'Data Scientist'],
    inputs: ['All platform datasets', 'Business glossary', 'Lineage metadata'],
    outputs: ['Searchable data catalog', 'Field-level lineage', 'Business definitions', 'Dataset ownership'],
    kpis: ['Cataloged datasets', 'Documented fields (%)', 'Lineage depth (hops)', 'Search queries answered'],
    keyScreens: ['Dataset search', 'Field explorer', 'Lineage graph', 'Business glossary'],
    relatedModules: ['data_fabric', 'data_quality', 'data_profiling'],
    route: '/data-catalog',
    routePatterns: ['/data-catalog', '/catalog'],
    exampleQuestions: ['What is Data Catalog?', 'Where can I find the customer 360 definition?', 'What is data lineage?'],
    dependencies: ['data_ingestion', 'data_fabric'],
    summary: 'Data Catalog is the knowledge base of all platform data — searchable definitions, lineage, ownership, and quality scores for every dataset and field.',
  },

  {
    id: 'data_fabric',
    name: 'Data Fabric Center',
    category: 'data',
    purpose: 'Unified data management layer that connects all data pipelines, enforces governance, and provides a single access point for all platform data.',
    businessObjective: 'Eliminate data silos. All risk indicators, models, and dashboards consume data through a governed, versioned, lineage-tracked fabric.',
    users: ['Data Architect', 'Platform Admin', 'Risk Analyst'],
    inputs: ['Multi-source raw data', 'Transformation rules', 'Schema registry'],
    outputs: ['Unified data products', 'Data lineage graphs', 'API data access', 'Quality metrics'],
    kpis: ['Active pipelines', 'Data freshness SLA compliance', 'Lineage coverage (%)', 'API data access latency'],
    keyScreens: ['Pipeline topology', 'Lineage explorer', 'Data product catalog', 'Schema registry'],
    relatedModules: ['data_ingestion', 'data_catalog', 'data_quality'],
    route: '/data-fabric-center',
    routePatterns: ['/data-fabric', '/fabric'],
    exampleQuestions: ['What is Data Fabric?', 'Why do we need Data Fabric?', 'How does lineage work?', 'What is the schema registry?'],
    dependencies: ['data_ingestion', 'data_catalog'],
    summary: 'Data Fabric Center is the backbone of all data in ZorEWS — a governed, lineage-aware layer that connects raw sources to risk intelligence consumers via validated, versioned pipelines.',
  },

  // ── RISK MODULES ──────────────────────────────────────────────────────
  {
    id: 'alert_management',
    name: 'Alert Management Center',
    category: 'risk',
    purpose: 'Centralized hub for all risk alerts generated by EWS rules, AI models, and external triggers.',
    businessObjective: 'Ensure no risk signal is missed. Prioritize, route, and track every alert from generation to resolution with full SLA accountability.',
    users: ['Risk Analyst', 'Fraud Analyst', 'Supervisor', 'Collection Officer'],
    inputs: ['EWS rule firings', 'AI model scores', 'Manual flags', 'External system events'],
    outputs: ['Triaged alert queue', 'SLA tracking', 'Investigation initiations', 'Escalation chains'],
    kpis: ['Critical alerts count', 'SLA breach rate (%)', 'Mean time to acknowledge (mins)', 'Alert resolution rate'],
    keyScreens: ['Alert list with severity filter', 'Alert detail + evidence', 'SLA tracking', 'Escalation panel'],
    relatedModules: ['investigation_center', 'rule_center', 'predictive_risk'],
    route: '/alerts',
    routePatterns: ['/alerts'],
    exampleQuestions: ['How does alert lifecycle work?', 'What is alert SLA?', 'How to acknowledge an alert?', 'What triggers a critical alert?'],
    dependencies: ['rule_center', 'ai_governance'],
    summary: 'Alert Management Center is the primary response surface for all risk events — with Red/Orange/Yellow classification, SLA tracking, maker-checker escalation, and direct investigation creation.',
  },

  {
    id: 'case_management',
    name: 'Case Management System (CMS)',
    category: 'case_management',
    purpose: 'Manage the full lifecycle of risk cases from alert creation through investigation, action, approval, and closure.',
    businessObjective: 'Provide a structured, auditable case workflow that ensures every risk event is properly investigated, documented, and resolved with maker-checker oversight.',
    users: ['Risk Analyst', 'Fraud Analyst', 'Collection Officer', 'Supervisor', 'Compliance Officer'],
    inputs: ['Alert flags', 'Investigation requests', 'Evidence documents', 'External referrals'],
    outputs: ['Case records', 'Action logs', 'CAS records', 'CAP plans', 'Closure reports'],
    kpis: ['Open cases', 'Cases closed today', 'Avg resolution time (hours)', 'SLA breach rate'],
    keyScreens: ['Case list with filters', 'Case detail with timeline', 'Evidence vault', 'Maker-checker approval queue'],
    relatedModules: ['investigation_center', 'alert_management', 'recovery_center'],
    route: ['/cms/cases', '/cms'],
    routePatterns: ['/cms', '/cms/cases'],
    exampleQuestions: ['How does case workflow work?', 'What is CAS and CAP?', 'How does maker-checker work in CMS?', 'What is the case SLA?'],
    dependencies: ['alert_management'],
    summary: 'CMS manages all risk cases — from alert creation to investigation, evidence collection, corrective action plans (CAP), causal analysis (CAS), and 4-eyes maker-checker closure.',
  },

  {
    id: 'investigation_center',
    name: 'Investigation Center',
    category: 'case_management',
    purpose: 'Specialized module for conducting structured fraud and risk investigations with evidence management, checklist workflows, and escalation.',
    businessObjective: 'Ensure every suspected fraud, NPA, or compliance breach is investigated with a documented, auditable process meeting regulatory evidence standards.',
    users: ['Fraud Analyst', 'Risk Analyst', 'Compliance Officer', 'Supervisor'],
    inputs: ['Case referrals', 'Alert evidence', 'Bureau data', 'AML flags', 'Document vault'],
    outputs: ['Investigation reports', 'Evidence packages', 'SAR filings', 'Closure verdicts', 'Regulatory submissions'],
    kpis: ['Active investigations', 'Avg investigation duration', 'Escalated count', 'SAR filing rate'],
    keyScreens: ['Investigation queue', 'Evidence explorer', '8-step BIL checklist', 'Escalation panel', 'Case timeline'],
    relatedModules: ['case_management', 'alert_management', 'regulatory_compliance'],
    route: '/investigation-center',
    routePatterns: ['/investigation-center', '/investigation'],
    exampleQuestions: ['What does Investigation Center do?', 'How does investigation workflow work?', 'What is the 8-step checklist?', 'How to file a SAR?'],
    dependencies: ['case_management', 'alert_management'],
    summary: 'Investigation Center provides a structured 8-step workflow for fraud/risk investigations — from evidence gathering and AML screening to SAR filing and regulatory submission, with full audit trail.',
  },

  {
    id: 'predictive_risk',
    name: 'Predictive Risk Center',
    category: 'risk',
    purpose: 'AI-powered predictive intelligence for forecasting NPA, fraud, claims, and portfolio risk over 30/90/180-day horizons.',
    businessObjective: 'Move from reactive to proactive risk management. Identify borrowers and accounts that will become problematic before they show traditional early warning signals.',
    users: ['Risk Analyst', 'CRO', 'Portfolio Manager', 'Executive'],
    inputs: ['Customer financial data', 'Bureau scores', 'Behavioral signals', 'Market data', 'Model predictions'],
    outputs: ['NPA probability scores', 'Risk forecasts', 'Portfolio outlook', 'Recommended actions'],
    kpis: ['Model AUC', 'NPA prediction accuracy', 'False positive rate', 'PD score distribution'],
    keyScreens: ['NPA prediction list', 'SMA classification', 'Sector risk watch', 'AI forecast dashboard', 'Borrower timeline'],
    relatedModules: ['alert_management', 'digital_twin', 'ai_governance'],
    route: '/predictive-risk-center',
    routePatterns: ['/predictive-risk-center', '/banking/npa-prediction', '/banking/sma', '/banking/sectors', '/borrower-watch'],
    exampleQuestions: ['What is Predictive Risk Center?', 'How does NPA prediction work?', 'What is the 90-day forecast?', 'What is SMA classification?'],
    dependencies: ['data_fabric', 'ai_governance'],
    summary: 'Predictive Risk Center uses ML models (XGBoost + SHAP explainability) to forecast NPA probability, fraud likelihood, and portfolio deterioration at 30/90/180-day horizons.',
  },

  {
    id: 'digital_twin',
    name: 'Digital Twin Center (Scenario Simulation)',
    category: 'risk',
    purpose: 'Simulate portfolio behavior under macroeconomic stress scenarios (RBI mandated, IRDAI, custom shocks) to quantify potential losses before they occur.',
    businessObjective: 'Enable proactive stress testing. Regulators (RBI, IRDAI) require institutions to demonstrate resilience under adverse scenarios. Digital Twin provides real-time simulation capability.',
    users: ['CRO', 'Risk Analyst', 'Compliance Officer', 'Actuary'],
    inputs: ['Scenario parameters (GDP, rate, FX)', 'Portfolio composition', 'Model weights'],
    outputs: ['ECL impact estimates', 'NPA migration tables', 'Segment risk heatmaps', 'Board-ready reports'],
    kpis: ['ECL under severely adverse (%)', 'Portfolio resilience score', 'Stage migration rate', 'Scenario coverage'],
    keyScreens: ['Scenario library', 'Stress test runner', 'Portfolio impact dashboard', 'ECL drill-down', 'Report export'],
    relatedModules: ['predictive_risk', 'regulatory_compliance', 'board_reporting'],
    route: '/digital-twin-center',
    routePatterns: ['/digital-twin', '/scenario', '/scenario-simulation'],
    exampleQuestions: ['What is Digital Twin?', 'How does scenario simulation work?', 'What is ECL impact?', 'How to run RBI stress test?'],
    dependencies: ['data_fabric', 'predictive_risk'],
    summary: 'Digital Twin simulates your entire portfolio under RBI/IRDAI macroeconomic stress scenarios — GDP shock, rate hike, FX devaluation — generating ECL impact, stage migration matrices, and regulatory submission reports.',
  },

  // ── COMPLIANCE & GOVERNANCE ───────────────────────────────────────────
  {
    id: 'regulatory_compliance',
    name: 'Regulatory Compliance Center',
    category: 'compliance',
    purpose: 'Centralized compliance management for RBI, Basel III, AML/KYC, IRDAI, and internal policy obligations.',
    businessObjective: 'Ensure the institution meets all regulatory obligations with zero gaps. Track filing deadlines, remediate compliance gaps, and generate regulator-ready evidence packages.',
    users: ['Compliance Officer', 'Risk Analyst', 'Auditor', 'Executive'],
    inputs: ['Regulatory calendar', 'Policy obligations', 'Data from all risk modules', 'Document vault'],
    outputs: ['Compliance readiness score', 'Filing submissions', 'Gap reports', 'Evidence packages', 'Audit trails'],
    kpis: ['Overall compliance readiness (%)', 'Overdue obligations', 'AML filing completion', 'KYC review backlog'],
    keyScreens: ['Compliance scorecard', 'Filing calendar', 'Gap explorer', 'Evidence builder', 'Audit trail'],
    relatedModules: ['investigation_center', 'governance_center', 'board_reporting'],
    route: '/regulatory-compliance-center',
    routePatterns: ['/regulatory-compliance-center', '/compliance', '/regulatory'],
    exampleQuestions: ['What is Regulatory Compliance Center?', 'How does compliance workflow work?', 'What is AML filing status?', 'How to generate RBI evidence?'],
    dependencies: ['audit_center', 'governance_center'],
    summary: 'Regulatory Compliance Center tracks all RBI, Basel, AML/KYC, and IRDAI obligations — with real-time readiness scores, filing deadline calendars, evidence packaging, and audit-ready documentation.',
  },

  {
    id: 'audit_center',
    name: 'Audit Center',
    category: 'compliance',
    purpose: 'Immutable, tamper-evident audit trail for all platform actions, decisions, and data changes.',
    businessObjective: 'Provide regulators and internal auditors with a complete, cryptographically verified record of all system activity.',
    users: ['Auditor', 'Compliance Officer', 'CISO', 'Executive'],
    inputs: ['All platform events', 'User actions', 'System decisions', 'Data changes'],
    outputs: ['SHA-256 hash-chained audit log', 'Evidence packages', 'Audit reports', 'Integrity verification'],
    kpis: ['Events logged today', 'Chain integrity status', 'Evidence packages generated', 'Audit query response time'],
    keyScreens: ['Event timeline', 'Audit search with 7-axis filter', 'Evidence packager', 'Chain verification', 'Audit report'],
    relatedModules: ['regulatory_compliance', 'governance_center', 'iam_center'],
    route: '/audit-center',
    routePatterns: ['/audit-center', '/audit'],
    exampleQuestions: ['What is Audit Center?', 'How does the hash chain work?', 'How to generate evidence package?', 'What events are logged?'],
    dependencies: ['iam_center'],
    summary: 'Audit Center maintains a cryptographically secured, SHA-256 hash-chained log of every platform action. Evidence packages can be generated for regulatory submissions with tamper detection built in.',
  },

  {
    id: 'governance_center',
    name: 'Governance Center',
    category: 'admin',
    purpose: 'Enterprise-level governance policy management — domain controls, tenant policies, cross-domain integrity checks.',
    businessObjective: 'Ensure proper separation between banking and insurance data, consistent policy enforcement across tenants, and complete auditability of governance decisions.',
    users: ['Platform Admin', 'Compliance Officer', 'CISO', 'CRO'],
    inputs: ['Governance policies', 'Domain configurations', 'Tenant settings', 'Access rules'],
    outputs: ['Governance audit reports', 'Policy enforcement logs', 'Domain integrity status'],
    kpis: ['Active governance policies', 'Policy violations', 'Tenant isolation health', 'Cross-domain integrity'],
    keyScreens: ['Governance dashboard', 'Policy manager', 'Domain access viewer', 'Tenant configuration'],
    relatedModules: ['iam_center', 'audit_center', 'regulatory_compliance'],
    route: '/admin/governance',
    routePatterns: ['/admin/governance', '/governance'],
    exampleQuestions: ['What is Governance Center?', 'What is domain governance?', 'How is tenant isolation enforced?'],
    dependencies: ['iam_center', 'audit_center'],
    summary: 'Governance Center manages enterprise policies, domain access controls, and tenant isolation — ensuring banking and insurance data stays separated with full audit compliance.',
  },

  // ── AI / ML MODULES ───────────────────────────────────────────────────
  {
    id: 'ai_governance',
    name: 'AI Governance Center',
    category: 'ai',
    purpose: 'Model lifecycle management — from development and validation through champion/challenger deployment and drift monitoring.',
    businessObjective: 'Ensure all AI models used in risk decisions are fair, explainable, well-monitored, and meet RBI/IRDAI model risk management guidelines.',
    users: ['Data Scientist', 'Risk Analyst', 'CRO', 'Compliance Officer'],
    inputs: ['ML model artifacts', 'Performance metrics', 'Drift indicators', 'Challenger model results'],
    outputs: ['Model registry', 'Performance dashboards', 'Drift alerts', 'Explainability reports', 'Model cards'],
    kpis: ['Production model AUC', 'PSI drift score', 'Model approval SLA', 'Champion vs challenger delta'],
    keyScreens: ['Model registry', 'Performance tracker', 'A/B comparison', 'Drift monitor', 'Promotion workflow'],
    relatedModules: ['predictive_risk', 'autonomous_risk', 'ai_decisioning'],
    route: '/ai/governance',
    routePatterns: ['/ai/governance', '/ai-governance', '/model-governance'],
    exampleQuestions: ['What is AI Governance Center?', 'How does model promotion work?', 'What is model drift?', 'What is champion/challenger?'],
    dependencies: ['data_fabric'],
    summary: 'AI Governance Center manages the full ML model lifecycle — training, validation, A/B testing, promotion via 4-eyes maker-checker, and continuous drift monitoring with RBI MRM compliance.',
  },

  {
    id: 'autonomous_risk',
    name: 'Autonomous Risk Operations Center',
    category: 'ai',
    purpose: 'AI agents that autonomously monitor, analyze, and recommend risk actions across credit, fraud, compliance, and claims domains.',
    businessObjective: 'Scale risk operations beyond human analyst capacity. AI agents continuously scan the portfolio 24/7, surface anomalies, and generate recommendations that analysts can approve or override.',
    users: ['CRO', 'Risk Analyst', 'Operations Team'],
    inputs: ['Real-time data streams', 'Rule engine outputs', 'Model predictions', 'Alert queue'],
    outputs: ['Agent recommendations', 'Auto-triggered workflows', 'Human review queues', 'Performance dashboards'],
    kpis: ['Active agents', 'Recommendations generated', 'Auto-approved vs human-reviewed', 'Agent accuracy rate'],
    keyScreens: ['Agent fleet dashboard', 'Recommendation queue', 'Agent performance', 'Human override log'],
    relatedModules: ['ai_governance', 'ai_decisioning', 'alert_management'],
    route: '/autonomous-risk-center',
    routePatterns: ['/autonomous-risk-center', '/autonomous'],
    exampleQuestions: ['What is Autonomous Risk Operations?', 'What do AI agents do?', 'How does autonomous risk work?', 'Which agents are running?'],
    dependencies: ['ai_governance', 'data_fabric'],
    summary: 'Autonomous Risk Operations runs a fleet of AI agents (credit, fraud, compliance, claims) that continuously monitor the portfolio, generate recommendations, and automate routine risk decisions with human oversight.',
  },

  {
    id: 'ai_decisioning',
    name: 'Advanced AI Decisioning Center',
    category: 'ai',
    purpose: 'Unified AI decision engine for credit approval, fraud flagging, claim assessment, and collection strategy decisions.',
    businessObjective: 'Accelerate high-volume risk decisions with explainable AI. Every decision includes a SHAP explanation, confidence score, and regulatory audit trail.',
    users: ['Risk Analyst', 'Collection Officer', 'Claims Assessor', 'Credit Officer'],
    inputs: ['Application data', 'Customer 360 profile', 'Model predictions', 'Decision rules'],
    outputs: ['Decision outcomes', 'SHAP explanations', 'Decision audit trail', 'Override logs'],
    kpis: ['Decisions/day', 'Auto-approval rate', 'Model confidence average', 'Human override rate'],
    keyScreens: ['Decision dashboard', 'Decision audit trail', 'SHAP explainer', 'Override management', 'Performance analytics'],
    relatedModules: ['ai_governance', 'autonomous_risk', 'regulatory_compliance'],
    route: '/ai-decisioning-center',
    routePatterns: ['/ai-decisioning', '/ai-decisioning-center'],
    exampleQuestions: ['What is AI Decisioning?', 'How does AI make decisions?', 'What is SHAP explainability?', 'How to review AI decisions?'],
    dependencies: ['ai_governance'],
    summary: 'Advanced AI Decisioning Center automates credit, fraud, claims, and collection decisions at scale — every decision has a SHAP explanation and is logged in a tamper-evident audit trail.',
  },

  // ── EXECUTIVE / REPORTING ─────────────────────────────────────────────
  {
    id: 'executive_cockpit',
    name: 'Executive Risk Cockpit',
    category: 'dashboard',
    purpose: 'Board-level risk intelligence dashboard providing a single, real-time view of enterprise risk posture for CRO and C-suite executives.',
    businessObjective: 'Give senior leadership a single source of truth for risk appetite, portfolio health, regulatory readiness, and strategic risk exposure without drilling into operational details.',
    users: ['CRO', 'CEO', 'CFO', 'Board Member', 'Risk Executive'],
    inputs: ['All enterprise risk data', 'Regulatory readiness', 'Portfolio metrics', 'AI forecasts'],
    outputs: ['Enterprise Risk Index', 'Board-ready visualizations', 'Risk appetite dashboard', 'Strategic risk summary'],
    kpis: ['Enterprise Risk Index (0-100)', 'Portfolio NPA %', 'Regulatory readiness %', 'Active critical alerts'],
    keyScreens: ['Risk index gauge', 'Portfolio health strip', 'Regulatory radar', 'AI forecast panel', 'Board scorecard'],
    relatedModules: ['predictive_risk', 'regulatory_compliance', 'board_reporting'],
    route: '/executive-cockpit',
    routePatterns: ['/executive-cockpit'],
    exampleQuestions: ['What is Executive Risk Cockpit?', 'What is Enterprise Risk Index?', 'How to read the board dashboard?', 'What does the cockpit show?'],
    dependencies: ['predictive_risk', 'regulatory_compliance'],
    summary: 'Executive Risk Cockpit is the C-suite dashboard — showing the Enterprise Risk Index, portfolio health, regulatory readiness, and strategic risk signals in a board-ready format.',
  },

  {
    id: 'board_reporting',
    name: 'Board Reporting Center',
    category: 'reporting',
    purpose: 'Generate, schedule, and deliver board-grade risk reports including executive summaries, regulatory submissions, and compliance packs.',
    businessObjective: 'Eliminate manual report preparation. Automate board pack generation with live data, approved templates, and one-click regulatory submission formats.',
    users: ['CRO', 'Compliance Officer', 'Executive', 'Risk Analyst'],
    inputs: ['Enterprise risk data', 'Regulatory data', 'Portfolio metrics', 'Report templates'],
    outputs: ['Board packs (PDF/Excel)', 'Regulatory submissions', 'Executive summaries', 'Scheduled reports'],
    kpis: ['Reports generated/month', 'Board pack completion %', 'Filing submission rate', 'Report delivery SLA'],
    keyScreens: ['Report catalog', 'Schedule manager', 'Board pack builder', 'Regulatory submissions', 'Export center'],
    relatedModules: ['executive_cockpit', 'regulatory_compliance', 'audit_center'],
    route: '/board-reporting-center',
    routePatterns: ['/board-reporting-center', '/board-reporting'],
    exampleQuestions: ['What is Board Reporting Center?', 'How to generate a board pack?', 'How to schedule reports?', 'What report formats are available?'],
    dependencies: ['executive_cockpit', 'regulatory_compliance'],
    summary: 'Board Reporting Center automates board pack and regulatory report generation — with live data integration, scheduled delivery, and PDF/Excel/CSV export in regulatory submission formats.',
  },

  {
    id: 'reporting_center',
    name: 'Reports & Export Center',
    category: 'reporting',
    purpose: 'Self-service report builder and export center for all operational and analytical reports across the platform.',
    businessObjective: 'Enable any authorized user to generate, schedule, and export reports without IT involvement.',
    users: ['Risk Analyst', 'Compliance Officer', 'Operations Team', 'Supervisor'],
    inputs: ['Platform data sources', 'Report definitions', 'User-defined filters'],
    outputs: ['Custom reports (PDF/Excel/CSV)', 'Scheduled report deliveries', 'Ad-hoc data exports'],
    kpis: ['Reports/day', 'Scheduled reports active', 'Export formats used', 'Report completion time'],
    keyScreens: ['Report catalog', 'Report builder', 'Schedule manager', 'Export center'],
    relatedModules: ['board_reporting', 'data_fabric'],
    route: '/reports',
    routePatterns: ['/reports'],
    exampleQuestions: ['What is the Reporting Center?', 'How to generate a report?', 'How to schedule daily reports?', 'What export formats are available?'],
    dependencies: ['data_fabric'],
    summary: 'Reports & Export Center provides a self-service report builder and scheduler — generate any operational report in PDF/Excel/CSV and schedule automated delivery.',
  },

  // ── OPERATIONS / ADMIN ────────────────────────────────────────────────
  {
    id: 'iam_center',
    name: 'IAM Center (Identity & Access Management)',
    category: 'admin',
    purpose: 'Manage user identities, roles, permissions, and access control across all platform modules.',
    businessObjective: 'Enforce least-privilege access, enable quarterly access reviews per RBI requirements, and prevent unauthorized access to sensitive risk data.',
    users: ['Platform Admin', 'CISO', 'Compliance Officer'],
    inputs: ['User onboarding requests', 'Role definitions', 'Access policies'],
    outputs: ['User accounts', 'Role assignments', 'Access logs', 'Quarterly review reports'],
    kpis: ['Active users', 'Dormant accounts (>90 days)', 'MFA enrollment rate', 'Quarterly review completion'],
    keyScreens: ['User management', 'Role assignment', 'Access review', 'Session monitoring', 'API key management'],
    relatedModules: ['audit_center', 'governance_center', 'security_center'],
    route: '/admin/iam',
    routePatterns: ['/admin/iam', '/iam', '/admin/users'],
    exampleQuestions: ['What is IAM Center?', 'How to manage user access?', 'What is RBAC?', 'How to conduct access review?'],
    dependencies: ['audit_center'],
    summary: 'IAM Center manages all user identities, role-based access control (RBAC), API keys, and quarterly access reviews — with dormant account detection and MFA enforcement.',
  },

  {
    id: 'security_center',
    name: 'Security Activity Center',
    category: 'admin',
    purpose: 'Monitor platform security events, detect anomalies, and investigate suspicious access patterns.',
    businessObjective: 'Protect the platform against insider threats, compromised credentials, and unauthorized access. Provide security operations with real-time threat visibility.',
    users: ['CISO', 'Security Analyst', 'Platform Admin'],
    inputs: ['Login events', 'API access logs', 'Session data', 'Geographic patterns'],
    outputs: ['Security alerts', 'Anomaly reports', 'Access investigation queue', 'Security score'],
    kpis: ['Security score (0-100)', 'Anomalous events', 'Failed auth attempts (24h)', 'After-hours access count'],
    keyScreens: ['Security dashboard', 'Event timeline', 'Anomaly explorer', 'Access log', 'Threat indicators'],
    relatedModules: ['iam_center', 'audit_center'],
    route: '/admin/security',
    routePatterns: ['/admin/security', '/security'],
    exampleQuestions: ['What is Security Activity Center?', 'What security events are monitored?', 'How to investigate an anomaly?', 'What is the security score?'],
    dependencies: ['iam_center', 'audit_center'],
    summary: 'Security Activity Center monitors all login, session, and API access events — detecting after-hours access, geographic anomalies, and brute-force attempts with real-time alerting.',
  },

  {
    id: 'recovery_center',
    name: 'Recovery Center',
    category: 'admin',
    purpose: 'Manage soft-deleted records, recovery workflows, and purge schedules across all platform data stores.',
    businessObjective: 'Enable compliant data recovery with maker-checker oversight. Prevent accidental data loss while enforcing retention policies.',
    users: ['Platform Admin', 'Data Steward', 'Compliance Officer'],
    inputs: ['Deletion requests', 'Recovery requests', 'Purge schedules'],
    outputs: ['Recovered records', 'Purge logs', 'Recovery audit trail'],
    kpis: ['Pending recovery approvals', 'Records restored today', 'Purge schedule compliance', 'Recovery SLA'],
    keyScreens: ['Recovery queue', 'Purge scheduler', 'Recovery audit', 'Approval workflow'],
    relatedModules: ['audit_center', 'iam_center'],
    route: '/recovery-center',
    routePatterns: ['/recovery-center', '/recovery'],
    exampleQuestions: ['What is Recovery Center?', 'How to recover deleted data?', 'What is the purge schedule?', 'How does maker-checker work in recovery?'],
    dependencies: ['audit_center'],
    summary: 'Recovery Center manages soft-deleted records with maker-checker approval workflows, scheduled purges, and full audit trail — preventing data loss while meeting retention compliance.',
  },

  {
    id: 'operations_center',
    name: 'Production Operations Center',
    category: 'operations',
    purpose: 'Monitor platform health, performance metrics, deployments, and production incidents in real time.',
    businessObjective: 'Maintain 99.5% platform availability with proactive anomaly detection, SLA monitoring, and incident management.',
    users: ['DevOps Engineer', 'Platform Admin', 'CTO'],
    inputs: ['System metrics', 'API performance', 'Error rates', 'Deployment events'],
    outputs: ['Uptime dashboards', 'Incident tickets', 'Performance reports', 'SLA compliance reports'],
    kpis: ['Platform uptime (%)', 'API p95 latency (ms)', 'Active incidents', 'Deploy success rate'],
    keyScreens: ['System health dashboard', 'API performance monitor', 'Incident tracker', 'Deployment history'],
    relatedModules: ['integration_marketplace', 'data_fabric'],
    route: '/operations-center',
    routePatterns: ['/operations-center', '/operations'],
    exampleQuestions: ['What is Operations Center?', 'How to monitor platform health?', 'What is the current uptime?', 'How to raise an incident?'],
    dependencies: [],
    summary: 'Production Operations Center provides real-time monitoring of all platform services — API latency, uptime, error rates, and deployment health — with incident management and SLA tracking.',
  },

  {
    id: 'integration_marketplace',
    name: 'Integration Marketplace',
    category: 'integration',
    purpose: 'Manage all external system integrations — CBS, bureau, AML watchlist, IFRS9, Core Insurance, and third-party APIs.',
    businessObjective: 'Provide a governed, monitored marketplace of all integrations with health tracking, SLA monitoring, and versioned API contracts.',
    users: ['Integration Engineer', 'Platform Admin', 'Risk Analyst'],
    inputs: ['API configurations', 'Connector settings', 'Integration health checks'],
    outputs: ['Integration health status', 'Data sync reports', 'SLA compliance', 'API audit logs'],
    kpis: ['Active integrations', 'Healthy connectors (%)', 'Avg latency (ms)', 'SLA breach rate'],
    keyScreens: ['Integration catalog', 'Health dashboard', 'Connector settings', 'SLA tracker', 'API logs'],
    relatedModules: ['data_ingestion', 'data_fabric', 'operations_center'],
    route: '/integration-marketplace',
    routePatterns: ['/integration-marketplace', '/integrations'],
    exampleQuestions: ['What is Integration Marketplace?', 'How does CBS connector work?', 'What integrations are available?', 'How to check IFRS9 feed status?'],
    dependencies: ['data_fabric'],
    summary: 'Integration Marketplace manages all external system connections — with health monitoring, SLA tracking, and versioned API contracts for CBS, Bureau, AML, IFRS9, and Insurance feeds.',
  },

  {
    id: 'event_streaming',
    name: 'Event Streaming Center',
    category: 'data',
    purpose: 'Real-time event streaming infrastructure for all risk events, alerts, and data updates across the platform.',
    businessObjective: 'Enable sub-60-second alert generation from data ingestion to risk action. Real-time streaming ensures no risk signal is delayed.',
    users: ['Platform Admin', 'Data Engineer', 'Risk Operations'],
    inputs: ['Real-time data feeds', 'Kafka topics', 'Event schemas'],
    outputs: ['Processed event streams', 'Alert triggers', 'Real-time dashboards'],
    kpis: ['Events/second', 'Stream latency (p95 ms)', 'Consumer lag', 'Dead letter queue size'],
    keyScreens: ['Topic explorer', 'Consumer health', 'Latency metrics', 'Schema registry', 'Dead letter queue'],
    relatedModules: ['data_ingestion', 'alert_management', 'operations_center'],
    route: '/event-streaming-center',
    routePatterns: ['/event-streaming-center', '/streaming'],
    exampleQuestions: ['What is Event Streaming Center?', 'How does real-time streaming work?', 'What is Kafka latency?', 'What is dead letter queue?'],
    dependencies: ['data_ingestion'],
    summary: 'Event Streaming Center manages the Kafka-based real-time event backbone — enabling sub-60-second alert generation from raw data ingestion to risk action with full schema governance.',
  },

  {
    id: 'notification_center',
    name: 'Notification Center',
    category: 'operations',
    purpose: 'Multi-channel notification management for all risk alerts, case updates, compliance reminders, and system events.',
    businessObjective: 'Ensure the right person receives the right alert through the right channel at the right time — with SLA tracking and delivery confirmation.',
    users: ['Platform Admin', 'Risk Analyst', 'Operations Team'],
    inputs: ['Alert triggers', 'Notification templates', 'User preferences', 'Channel configurations'],
    outputs: ['Email/SMS/Push notifications', 'Delivery logs', 'Channel performance reports'],
    kpis: ['Notifications sent/day', 'Delivery success rate', 'Channel breakdown', 'Alert-to-notification latency'],
    keyScreens: ['Template manager', 'Channel settings', 'Delivery log', 'Preference center', 'Analytics dashboard'],
    relatedModules: ['alert_management', 'case_management', 'iam_center'],
    route: '/admin/notifications',
    routePatterns: ['/admin/notifications', '/notifications'],
    exampleQuestions: ['What is Notification Center?', 'How are alerts delivered?', 'What channels are supported?', 'How to manage notification preferences?'],
    dependencies: ['alert_management'],
    summary: 'Notification Center manages multi-channel (Email, SMS, Push) delivery of all platform alerts and updates — with template management, delivery tracking, and user preference control.',
  },

  {
    id: 'rule_center',
    name: 'Rule Engine Center',
    category: 'risk',
    purpose: 'Create, manage, simulate, and monitor EWS rules that trigger risk alerts based on configured conditions.',
    businessObjective: 'Enable risk teams to define, test, and deploy early warning rules without code changes. Rules should fire within 60 seconds of data updates.',
    users: ['Risk Analyst', 'Compliance Officer', 'Platform Admin'],
    inputs: ['Indicator values', 'Threshold configurations', 'Rule DSL definitions'],
    outputs: ['Alert triggers', 'Rule performance reports', 'False positive analysis', 'Simulation results'],
    kpis: ['Active rules', 'Rules fired today', 'False positive rate (%)', 'Avg firing latency (ms)'],
    keyScreens: ['Rule list', 'Rule builder', 'Simulation runner', 'Performance dashboard', 'Maker-checker approval'],
    relatedModules: ['alert_management', 'predictive_risk', 'ai_governance'],
    route: '/rule-center',
    routePatterns: ['/rule-center', '/rules', '/ews-rules'],
    exampleQuestions: ['What is Rule Engine Center?', 'How to create a rule?', 'What is false positive rate?', 'How does rule simulation work?'],
    dependencies: ['data_fabric', 'alert_management'],
    summary: 'Rule Engine Center manages all EWS detection rules — from creation and simulation to deployment and performance monitoring — with 4-eyes maker-checker approval for production rules.',
  },

  // ── DASHBOARD ─────────────────────────────────────────────────────────
  {
    id: 'role_based_dashboard',
    name: 'Role-Based Dashboard Engine',
    category: 'dashboard',
    purpose: 'Intelligent role-aware dashboard that adapts widget layout, priority, and content based on the viewer\'s role, domain, and current risk context.',
    businessObjective: 'Eliminate dashboard noise. Each user sees exactly the widgets and information relevant to their role and current workload — automatically prioritized by AI.',
    users: ['All platform users'],
    inputs: ['User role', 'Domain (Banking/Insurance)', 'Risk context', 'Workload signals', 'Personalization preferences'],
    outputs: ['Role-optimized widget layout', 'Priority-scored widgets', 'AI briefing', 'Executive scorecard'],
    kpis: ['Widgets resolved for role', 'Priority score distribution', 'User personalization rate', 'Dashboard load time'],
    keyScreens: ['Role dashboard', 'Widget grid', 'AI briefing card', 'Scorecard strip', 'Named views'],
    relatedModules: ['executive_cockpit', 'alert_management', 'predictive_risk'],
    route: '/dashboards/role-based',
    routePatterns: ['/dashboards/role-based', '/dashboards'],
    exampleQuestions: ['What is Role-Based Dashboard?', 'How does the dashboard adapt to my role?', 'What is widget prioritization?', 'How do I personalize my dashboard?'],
    dependencies: [],
    summary: 'Role-Based Dashboard Engine uses 6-axis AI scoring (role, risk, workload, activity, domain, trend) to show each user their most relevant widgets — with named views, pin/hide personalization, and live risk elevation.',
  },

  {
    id: 'main_dashboard',
    name: 'Enterprise Risk Command Center (Main Dashboard)',
    category: 'dashboard',
    purpose: 'Enterprise-wide risk command center providing a unified view of portfolio health, emerging risks, AI forecasts, and regulatory readiness.',
    businessObjective: 'One screen for the complete risk picture — from critical alerts and emerging threats to predictive outlook and board readiness.',
    users: ['Risk Analyst', 'Supervisor', 'Executive', 'CRO'],
    inputs: ['All risk module outputs', 'AI model predictions', 'Compliance status'],
    outputs: ['Risk command view', 'KPI strips', 'Emerging risk panels', 'Forecast dashboards'],
    kpis: ['Critical alerts', 'Open cases', 'High-risk accounts', 'SLA breaches', 'Compliance readiness'],
    keyScreens: ['KPI strip', 'Emerging risks panel', 'AI forecast', 'Portfolio PD trend', 'Alert radar', 'Board readiness'],
    relatedModules: ['executive_cockpit', 'alert_management', 'predictive_risk'],
    route: '/',
    routePatterns: ['/', '/dashboard'],
    exampleQuestions: ['What is this dashboard?', 'What does the main dashboard show?', 'How to read risk KPIs?', 'What is the Enterprise Risk Index?'],
    dependencies: [],
    summary: 'Enterprise Risk Command Center is the central intelligence hub — showing real-time risk KPIs, emerging threats, AI predictions, portfolio health, and regulatory readiness in one unified view.',
  },

  // ── MASTER SETUP / ADMIN ──────────────────────────────────────────────
  {
    id: 'master_setup',
    name: 'Master Setup Center',
    category: 'admin',
    purpose: 'Configure all platform-wide master data — indicator thresholds, rule templates, scoring weights, tenant configurations, and system defaults.',
    businessObjective: 'Provide administrators with a single control plane for all platform configuration without requiring code changes.',
    users: ['Platform Admin', 'Risk Operations Lead'],
    inputs: ['Configuration parameters', 'Master data definitions', 'Tenant settings'],
    outputs: ['Platform configuration', 'Tenant settings', 'Master data updates'],
    kpis: ['Config items managed', 'Override count', 'Config change audit events'],
    keyScreens: ['Config dashboard', 'Indicator thresholds', 'Rule templates', 'Tenant config', 'System defaults'],
    relatedModules: ['governance_center', 'iam_center', 'rule_center'],
    route: '/admin/master-setup',
    routePatterns: ['/admin/master-setup', '/master-setup', '/admin/config'],
    exampleQuestions: ['What is Master Setup?', 'How to configure indicator thresholds?', 'How to manage tenant settings?', 'What is admin configuration?'],
    dependencies: ['governance_center'],
    summary: 'Master Setup Center is the platform configuration control plane — managing indicator thresholds, rule templates, scoring weights, tenant settings, and all system-level defaults.',
  },

  {
    id: 'streaming_latency',
    name: 'Streaming Latency Monitor',
    category: 'operations',
    purpose: 'Monitor end-to-end latency from data ingestion to alert generation — ensuring the 60-second p95 SLA is met.',
    businessObjective: 'Validate and continuously monitor the real-time alert path SLA. Detect latency degradation before it impacts risk response times.',
    users: ['Platform Admin', 'Operations Team'],
    inputs: ['Streaming event timestamps', 'Processing logs'],
    outputs: ['Latency metrics', 'SLA compliance report', 'Performance dashboard'],
    kpis: ['p95 latency (target: <60s)', 'p50 median latency', 'SLA breaches', 'Throughput (events/sec)'],
    keyScreens: ['Latency dashboard', 'SLA compliance', 'Indicator rollup', 'Recent events'],
    relatedModules: ['event_streaming', 'operations_center'],
    route: '/admin/streaming-latency',
    routePatterns: ['/admin/streaming-latency', '/streaming-latency'],
    exampleQuestions: ['What is Streaming Latency Monitor?', 'What is the streaming SLA?', 'How to check latency?'],
    dependencies: ['event_streaming'],
    summary: 'Streaming Latency Monitor tracks end-to-end latency from data ingestion to alert generation — with p50/p95 metrics and SLA compliance tracking against the 60-second target.',
  },

];

// ─── Lookup helpers ───────────────────────────────────────────────────────

export function findModuleByRoute(path: string): ModuleEntry | undefined {
  return MODULE_REGISTRY.find(m => {
    const patterns = m.routePatterns;
    return patterns.some(p => {
      if (p === '/') return path === '/';
      return path.startsWith(p);
    });
  });
}

export function findModuleById(id: string): ModuleEntry | undefined {
  return MODULE_REGISTRY.find(m => m.id === id);
}

export function searchModules(query: string): ModuleEntry[] {
  const q = query.toLowerCase();
  return MODULE_REGISTRY.filter(m =>
    m.name.toLowerCase().includes(q) ||
    m.summary.toLowerCase().includes(q) ||
    m.purpose.toLowerCase().includes(q) ||
    m.id.includes(q.replace(/\s+/g, '_')) ||
    m.exampleQuestions.some(eq => eq.toLowerCase().includes(q))
  );
}

export function getModulesByCategory(category: ModuleCategory): ModuleEntry[] {
  return MODULE_REGISTRY.filter(m => m.category === category);
}
