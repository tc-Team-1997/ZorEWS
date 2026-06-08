// copilotModuleKnowledge.ts
//
// ZorEWS Copilot — Module Screen Awareness Knowledge
// Detailed per-module + per-screen knowledge for "What does this page do?"
// Covers every ZorEWS module with KPIs, workflows, actions, outcomes.
//
// 100% additive — no existing logic changed.

import type { CopilotResponse } from './copilotEngine';

export interface ModuleScreen {
  id:           string;
  name:         string;
  routePatterns: string[];
  keywords:     string[];
  description:  string;
  description_hi?: string;
  description_hinglish?: string;
  kpis:         string[];
  actions:      string[];
  outcomes:     string[];
  users:        string[];
  tips:         string[];
  relatedScreens: string[];
  route:        string;
}

// ─── Complete Module Screen Catalog ──────────────────────────────────────

export const MODULE_SCREENS: ModuleScreen[] = [

  {
    id: 'data_ingestion',
    name: 'Data Ingestion Center',
    routePatterns: ['/data-ingestion'],
    keywords: ['data ingestion', 'ingestion center', 'data pipeline', 'connector', 'cbs connector', 'bureau connector', 'ingestion health'],
    description: `**Data Ingestion Center** — Your gateway for all source system data flowing into ZorEWS.

**What this page does:**
This module manages all data connectors (CBS, Bureau, AML, IFRS9, Insurance) and monitors their health, run history, and data quality.

**Key Widgets:**
• Connector registry — 8 source system connectors with live status
• Pipeline health — Success rate, last run time, records processed
• Run history — Last 200 runs per connector with failure analysis
• Schema validator — Validates incoming data against registered schemas

**Actions you can take:**
• Trigger ad-hoc run → Force a connector to pull latest data
• Pause/Resume connector → Stop a failing connector without losing config
• View failure patterns → See AI-clustered error root causes
• Monitor freshness → Check if data is within SLA window

**SLA:** p95 indicator latency < 60 seconds from data arrival to alert generation`,
    description_hinglish: `**Data Ingestion Center** — Yahan se sab source systems ka data ZorEWS mein aata hai.

**Kya hai yahan:**
CBS, Bureau, AML, IFRS9 ke connectors manage karo. Health monitor karo, run history dekho.

**Key actions:**
• Ad-hoc run trigger karo
• Failing connector pause karo
• Schema violations check karo
• Data freshness verify karo`,
    kpis: ['Connector health %', 'Records/day', 'Schema violations', 'Data freshness SLA'],
    actions: ['Trigger manual run', 'Pause/Resume connector', 'View run history', 'Schema validation'],
    outcomes: ['Fresh data for risk models', 'Early detection of source failures', 'Quality-gated risk calculations'],
    users: ['Data Engineer', 'Platform Admin', 'Risk Analyst'],
    tips: ['Check CBS connector first thing every morning — it drives NPA calculations', 'Set up alerts for connectors with > 5% failure rate'],
    relatedScreens: ['Data Quality', 'Data Fabric Center', 'Streaming Latency'],
    route: '/data-ingestion',
  },

  {
    id: 'data_quality',
    name: 'Data Quality Center',
    routePatterns: ['/dq-score', '/data-quality'],
    keywords: ['data quality', 'dq score', 'data quality center', 'dq', 'quality score', 'violations', 'null rate', 'completeness'],
    description: `**Data Quality Center** — Monitor data accuracy, completeness, and consistency across all ingested datasets.

**What this page does:**
Scores every dataset on quality dimensions (completeness, accuracy, consistency, timeliness) and surfaces violations that could corrupt risk calculations.

**Key Widgets:**
• DQ Scorecard — Per-dataset DQ score (0-100%). Below 85% = risk model gating
• Violation Explorer — Null rates, schema mismatches, outlier values
• Rule Management — Configure DQ thresholds per dataset
• Dataset Profiler — Statistical distribution per field

**Quality Dimensions Measured:**
• Completeness → % of required fields populated
• Accuracy → Values within expected ranges
• Consistency → No duplicate records, referential integrity
• Timeliness → Data arrived within expected window

**DQ Gate:** If DQ score < 85%, data is quarantined and risk indicators are NOT recalculated until the issue is resolved.`,
    kpis: ['Overall DQ score %', 'Critical violations', 'Fields with null > threshold', 'Quarantined datasets'],
    actions: ['View violations', 'Trigger quality check', 'Configure thresholds', 'Export DQ report'],
    outcomes: ['Reliable risk calculations', 'Regulatory data integrity', 'Prevented model input errors'],
    users: ['Data Steward', 'Risk Analyst', 'Compliance Officer'],
    tips: ['Any DQ score below 85% should be escalated to data engineering immediately', 'CBS customer data DQ is critical — impacts 100% of credit risk models'],
    relatedScreens: ['Data Ingestion', 'Data Profiling', 'Data Fabric'],
    route: '/dq-score',
  },

  {
    id: 'data_profiling',
    name: 'Data Profiling Center',
    routePatterns: ['/data-profiling-ai', '/data-profiling'],
    keywords: ['data profiling', 'profiling', 'statistical profile', 'distribution', 'anomaly detection ai', 'column statistics'],
    description: `**Data Profiling Center** — AI-powered statistical profiling of all platform datasets.

Automatically generates distribution charts, outlier detection, and correlation matrices for every ingested dataset. Helps analysts understand data characteristics before using it in models.

**Key Features:**
• Column statistics — min, max, mean, median, std dev, null %
• Distribution charts — Histogram, box plot per field
• Anomaly heatmap — Fields with statistical anomalies highlighted
• Correlation matrix — Feature-to-feature relationships for ML prep
• Time-series drift — How distributions change over time`,
    kpis: ['Datasets profiled', 'Anomalous columns', 'Profile freshness', 'Correlation strength'],
    actions: ['Run new profile', 'Compare profiles', 'Export statistics', 'Flag anomalies'],
    outcomes: ['Better model training', 'Data issue discovery', 'Feature engineering insights'],
    users: ['Data Scientist', 'Risk Analyst', 'Data Engineer'],
    tips: ['Run profiling on CBS data after each major schema change', 'Correlation matrix helps identify redundant features before model training'],
    relatedScreens: ['Data Quality', 'Data Ingestion', 'AI Governance'],
    route: '/data-profiling-ai',
  },

  {
    id: 'alert_management',
    name: 'Alert Management Center',
    routePatterns: ['/alerts'],
    keywords: ['alert management', 'alert center', 'alerts page', 'risk alerts', 'alert list', 'alert queue'],
    description: `**Alert Management Center** — Primary risk response surface for all EWS-generated alerts.

**What this page does:**
Displays all risk alerts generated by rules, AI models, and external triggers. Allows triage, acknowledgment, investigation creation, and SLA tracking.

**Alert Classification (BIL Framework):**
• 🔴 **Red (Critical)** — Immediate action. SLA: 4 hours. Route: Head of Risk
• 🟠 **Orange (High)** — Same day. SLA: 24 hours. Route: Supervisor
• 🟡 **Yellow (Medium)** — This week. SLA: 72 hours. Route: Analyst
• 🟢 **Green (Low)** — Monitor only. No SLA

**Key Actions:**
• Acknowledge alert → Marks as seen, pauses SLA timer
• Create investigation → Opens Investigation Center case
• Escalate → Routes to next-level approver
• Mark false positive → Feeds model retraining
• View SHAP factors → Why AI flagged this customer

**Filters available:** Severity, Assignee, Domain (Banking/Insurance), Status, Date range`,
    description_hinglish: `**Alert Management Center** — Sab risk alerts yahan aate hain.

**Alert colors:** 🔴 Critical (4h SLA) → 🟠 High (24h) → 🟡 Medium (72h) → 🟢 Low (monitor)

**Main actions:**
• Alert acknowledge karo
• Investigation create karo
• SHAP factors se samjho kyon flagged hua
• False positive mark karo`,
    kpis: ['Critical alerts', 'SLA breach %', 'Ack time (median)', 'False positive rate'],
    actions: ['Acknowledge alert', 'Create investigation', 'Escalate', 'Mark false positive', 'View SHAP'],
    outcomes: ['Timely risk response', 'SLA compliance', 'Reduced false positive rate'],
    users: ['Risk Analyst', 'Fraud Analyst', 'Supervisor', 'Collection Officer'],
    tips: ['Filter by Critical first — these are your immediate priorities', 'Use SHAP factors to validate AI decision before actioning'],
    relatedScreens: ['Investigation Center', 'Rule Center', 'Predictive Risk'],
    route: '/alerts',
  },

  {
    id: 'case_management',
    name: 'Case Management System (CMS)',
    routePatterns: ['/cms', '/cms/cases'],
    keywords: ['case management', 'cms', 'cases page', 'case list', 'open cases', 'case queue', 'case workflow'],
    description: `**Case Management System (CMS)** — Full lifecycle case management for all risk cases.

**Case Lifecycle:**
Alert Created → Case Opened → Assigned → Investigation → Evidence Collection → Maker-Checker Approval → Closed

**Case Types:**
• Fraud Investigation
• NPA Early Warning
• KYC/AML Review
• Compliance Breach
• Loan Restructuring
• Recovery Action

**Key Features:**
• Case timeline with all actions logged
• Evidence vault with document management
• CAS (Causal Analysis Stage) — Root cause documentation
• CAP (Corrective Action Plan) — Remediation steps
• **Maker-Checker** — 4-eyes approval for sensitive actions
• SLA tracking — Breach alerts with auto-escalation
• GPS-tagged field visit logs

**Maker-Checker applies to:**
Case closure, write-off authorization, CAP approval, escalation to Head of Risk`,
    description_hinglish: `**CMS** — Sab risk cases yahan manage hote hain.

**Case flow:** Alert → Case Open → Assign → Investigate → Evidence → Maker-Checker → Close

**Important features:**
• CAS (Causal Analysis) — Kyon hua root cause
• CAP (Corrective Action Plan) — Remediation steps
• Maker-Checker — Sensitive decisions ke liye 4-eyes approval
• SLA tracking — Breach hone par auto-escalate`,
    kpis: ['Open cases', 'Avg resolution time', 'SLA breach %', 'Cases closed/day'],
    actions: ['Create case', 'Assign to analyst', 'Add evidence', 'Submit for approval', 'Close case'],
    outcomes: ['Structured risk resolution', 'Audit-ready case records', 'Regulatory compliance'],
    users: ['Risk Analyst', 'Fraud Analyst', 'Supervisor', 'Collection Officer'],
    tips: ['Always create CAS before closing a case — RBI requires root cause documentation', 'CAP closure is required before case can be closed (maker-checker gate)'],
    relatedScreens: ['Investigation Center', 'Alert Management', 'Recovery Center'],
    route: '/cms/cases',
  },

  {
    id: 'investigation_center',
    name: 'Investigation Center',
    routePatterns: ['/investigation-center'],
    keywords: ['investigation center', 'investigation', 'investigation queue', 'fraud investigation', 'open investigation', 'evidence'],
    description: `**Investigation Center** — Structured fraud and risk investigation with evidence management.

**BIL §17 Standard 8-Step Investigation Checklist:**
1. ✅ Verify Identity — KYC documents, Aadhaar/PAN
2. ✅ Pull Policy/Loan History — Account history, bureau report
3. ✅ AML Screening — Watchlist (OFAC, UN, domestic)
4. ✅ Review Documents — DMS vault check, flag anomalies
5. ✅ Red Flag Analysis — Transaction velocity, geographic anomaly
6. ✅ Interview/Site Inspection — GPS-tagged field visit
7. ✅ Final Recommendation — Fraud confirmed/unsubstantiated
8. ✅ Maker-Checker Sign-off — SAR filing authorization

**SAR Filing from Investigation Center:**
Fraud confirmed → SAR prepared → Filed with FIU-IND within 7 days → Confirmation received

**Investigation Outcomes:**
• Fraud Confirmed → SAR filing + case referred to law enforcement
• Fraud Unsubstantiated → Case closed with documentation
• Partial Fraud → Selective action + monitoring`,
    description_hinglish: `**Investigation Center** — Fraud ya risk investigation ka structured process.

**8-step checklist (BIL §17):**
Identity verify → Loan history pull → AML screen → Document review → Red flag analysis → Site visit → Final recommendation → Maker-Checker

**SAR filing:** Fraud confirm hone ke 7 din mein FIU-IND ko report karo.`,
    kpis: ['Active investigations', 'Avg investigation time', 'SAR filing rate', 'Escalation count'],
    actions: ['Open investigation', 'Complete checklist step', 'Add evidence', 'File SAR', 'Escalate', 'Close with verdict'],
    outcomes: ['Regulatory-compliant fraud documentation', 'SAR filings', 'Evidence packages for courts'],
    users: ['Fraud Analyst', 'Risk Analyst', 'Compliance Officer', 'Supervisor'],
    tips: ['Never close an investigation with incomplete checklist steps', 'AML screening (Step 3) is mandatory before SAR filing'],
    relatedScreens: ['Case Management', 'Alert Management', 'Regulatory Compliance'],
    route: '/investigation-center',
  },

  {
    id: 'regulatory_compliance',
    name: 'Regulatory Compliance Center',
    routePatterns: ['/regulatory-compliance-center'],
    keywords: ['regulatory compliance', 'compliance center', 'rbi compliance', 'aml compliance', 'kyc compliance', 'irdai compliance', 'compliance gaps', 'filing status'],
    description: `**Regulatory Compliance Center** — Centralized compliance management for all regulatory obligations.

**Regulators Covered:**
• **RBI** — Quarterly CRAR, monthly SMA, annual ICAAP, AML/KYC
• **Basel III** — Capital adequacy, LCR, NSFR reporting
• **IRDAI** — Solvency Form-K (quarterly), persistency, annual returns
• **FIU-IND** — SAR filing, CTR (Cash Transaction Report)
• **SEBI** — For listed bank/insurer disclosures

**Compliance Dashboard:**
• Readiness score (0-100%) — Overall compliance posture
• Filing calendar — Upcoming deadlines with days remaining
• Gap explorer — Specific items needing remediation
• Evidence builder — Auto-assembles regulatory packages

**Evidence Packaging:**
Select filters → Platform auto-aggregates audit events → SHA-256 hash generated → Package ready for regulator submission

**AML Filing Monthly Workflow:**
Data collection (Day 1-10) → Reconciliation (Day 11-20) → Review (Day 21-25) → Submission by 25th`,
    description_hinglish: `**Regulatory Compliance Center** — RBI, IRDAI, AML sab compliance yahan manage hote hain.

**Dashboard mein:**
• Compliance readiness score
• Upcoming filing deadlines
• Gap items jo abhi fix karne hain
• Evidence package builder (SHA-256 secure)

**AML filing:** Har mahine 25 tarikh tak submit karna zaroori.`,
    kpis: ['Compliance readiness %', 'Overdue filings', 'AML completion %', 'KYC backlog'],
    actions: ['View filing calendar', 'Generate evidence package', 'Remediate gap', 'Submit filing', 'Download compliance report'],
    outcomes: ['Zero overdue filings', 'Regulatory examination readiness', 'Reduced compliance risk'],
    users: ['Compliance Officer', 'Risk Analyst', 'Auditor', 'Executive'],
    tips: ['Start AML filing preparation on Day 1 of the month, not Day 15', 'Use evidence packager — manual exports are not accepted by regulators'],
    relatedScreens: ['Audit Center', 'Board Reporting', 'Investigation Center'],
    route: '/regulatory-compliance-center',
  },

  {
    id: 'predictive_risk',
    name: 'Predictive Risk Center',
    routePatterns: ['/predictive-risk-center', '/banking/npa-prediction', '/banking/sma', '/banking/sectors', '/borrower-watch'],
    keywords: ['predictive risk', 'npa prediction', 'sma classification', 'sector risk', 'borrower watch', 'risk forecast', 'pd score', 'early warning'],
    description: `**Predictive Risk Center** — AI-powered forward-looking risk intelligence.

**Sub-modules:**
• **NPA Prediction** — XGBoost model scores all borrowers on 90-day NPA probability
• **SMA Classification** — Real-time SMA-0/1/2 classification with migration tracking
• **Sector Watch** — Industry concentration risk and sector-level stress signals
• **Borrower Watch** — High-risk borrower monitoring with relationship manager assignment

**AI Model Details:**
• Model: XGBoost + SHAP explainability
• AUC: 0.89 (validated on holdout data)
• Features: DPD, utilization, EMI bounce, bureau score, velocity, tenure
• Update: Daily, post-CBS data refresh (06:00 IST)

**How to use:**
1. Filter by PD > 0.60 → Your early warning list
2. Drill into customer → SHAP factors show WHY they're high risk
3. Assign to Relationship Manager → Start outreach
4. Log outcome → Feed model retraining

**NPA Prevention Playbook:**
PD 0.60-0.75 → Contact within 5 days → Restructuring offer
PD 0.75+ → Immediate escalation → Recovery team engagement`,
    description_hinglish: `**Predictive Risk Center** — AI se 90 din pehle NPA predict karta hai.

**Sub-modules:**
• NPA Prediction — PD score 0-1 (1 = definite NPA)
• SMA Classification — DPD ke basis par SMA-0/1/2
• Sector Watch — Industry concentration risk
• Borrower Watch — High-risk borrowers list

**Use kaise karo:**
1. PD > 0.60 filter karo → Tumhara early warning list
2. Customer drill-in karo → SHAP se samjho kyon flagged
3. RM ko assign karo → Outreach shuru karo`,
    kpis: ['High PD accounts (>0.60)', 'NPA prediction accuracy %', 'SMA migration rate', 'Early intervention success %'],
    actions: ['Filter by PD threshold', 'Drill into customer', 'Assign to RM', 'Create alert', 'Run sector stress', 'Export watchlist'],
    outcomes: ['30-90 day NPA prevention', 'Targeted collections outreach', 'Portfolio quality improvement'],
    users: ['Risk Analyst', 'Collection Officer', 'Portfolio Manager', 'CRO'],
    tips: ['Review NPA prediction list every morning before team standup', 'SHAP top-5 factors must be reviewed before any restructuring decision'],
    relatedScreens: ['Alert Management', 'Digital Twin', 'Collections Risk'],
    route: '/predictive-risk-center',
  },

  {
    id: 'executive_cockpit',
    name: 'Executive Risk Cockpit',
    routePatterns: ['/executive-cockpit'],
    keywords: ['executive cockpit', 'executive dashboard', 'board dashboard', 'cro dashboard', 'enterprise risk', 'risk index', 'board view'],
    description: `**Executive Risk Cockpit** — C-suite risk intelligence in one screen.

**Enterprise Risk Index (0-100):**
• 0-30: Normal (green) — Portfolio healthy
• 31-50: Elevated (amber) — Monitor closely
• 51-70: High (orange) — Immediate attention required
• 71-100: Critical (red) — Board escalation needed

**Dashboard Sections:**
• **Risk Index Gauge** — Single number summarizing enterprise risk
• **Portfolio Health Strip** — NPA%, SMA%, ECL provision vs limit
• **Regulatory Radar** — 6-axis compliance readiness (RBI, Basel, AML, KYC, IRDAI, FATF)
• **AI Forecast Panel** — 90-day NPA trajectory, fraud outlook
• **Board Scorecard** — KPIs vs regulatory thresholds

**Board Presentation Use:**
This screen generates the data for board presentations. Use Board Reporting Center to export as PDF/PowerPoint.

**Frequency:** Review daily (2 minutes). Deep review weekly. Board report monthly.`,
    description_hinglish: `**Executive Risk Cockpit** — CRO aur CEO ke liye ek screen mein sab kuch.

**Enterprise Risk Index:**
0-30 = Normal | 31-50 = Elevated | 51-70 = High | 71-100 = Critical

**Kya dekhte hain:**
• Risk Index gauge
• NPA%, SMA%, ECL provision
• Compliance radar (RBI, Basel, IRDAI)
• AI forecast (90-day NPA trajectory)`,
    kpis: ['Enterprise Risk Index', 'Portfolio NPA %', 'Regulatory readiness %', 'Active critical alerts'],
    actions: ['View risk index trend', 'Drill into regulatory radar', 'Download board pack', 'Approve pending decisions', 'Run stress test'],
    outcomes: ['Board-ready risk view', 'Regulatory confidence', 'Strategic risk oversight'],
    users: ['CRO', 'CEO', 'CFO', 'Board Member'],
    tips: ['Run executive cockpit as first check every morning', 'Enterprise Risk Index > 50 should trigger immediate briefing to CRO'],
    relatedScreens: ['Predictive Risk', 'Regulatory Compliance', 'Board Reporting'],
    route: '/executive-cockpit',
  },

  {
    id: 'digital_twin',
    name: 'Digital Twin (Scenario Simulation)',
    routePatterns: ['/digital-twin-center'],
    keywords: ['digital twin', 'scenario simulation', 'stress test', 'scenario center', 'rbi stress test', 'irdai stress', 'ecl simulation', 'portfolio stress'],
    description: `**Digital Twin Center** — Simulate your entire portfolio under macroeconomic stress scenarios.

**Available Scenarios (Library):**
• RBI Baseline (zero shock)
• RBI Adverse (GDP -3%, Rate +200bps, FX +8%)
• RBI Severely Adverse (GDP -7%, Rate +400bps, FX +15%)
• IRDAI Solvency Stress
• Pandemic Scenario (GDP -7%, Rate -100bps, FX +15%)
• Stagflation (GDP -3%, Rate +400bps, FX +8%)

**Simulation Outputs:**
• ECL impact (₹ Cr) — Additional provision needed
• NPA migration (Stage 1→2→3 movement)
• Capital impact — CRAR drop under stress
• Segment risk heatmap — Which segment most stressed
• Time-series ECL curve — 12-month projection

**How to Use:**
1. Select scenario from library
2. Click "Run Simulation" → Results in 5 seconds
3. Compare scenarios side-by-side
4. Export as PDF/Excel for board/regulator`,
    description_hinglish: `**Digital Twin** — Portfolio ka virtual simulation stress scenarios mein.

**RBI ke 3 main scenarios:**
• Baseline (no shock)
• Adverse (GDP -3%, Rate +200bps)
• Severely Adverse (GDP -7%, Rate +400bps) — Sabse tough

**Output:** ECL impact, NPA migration, CRAR drop, segment heatmap.

**Use:** Quarterly RBI/IRDAI submission se pehle run karo.`,
    kpis: ['ECL under adverse (₹Cr)', 'CRAR impact (%)', 'Stage migration %', 'Portfolio resilience score'],
    actions: ['Select scenario', 'Run simulation', 'Compare scenarios', 'Export report', 'Save for board'],
    outcomes: ['Capital planning', 'Regulatory stress test submission', 'Board risk appetite discussions'],
    users: ['CRO', 'Risk Analyst', 'Compliance Officer', 'Actuary'],
    tips: ['Run severely adverse scenario quarterly before RBI submission', 'Compare last 4 quarters to see if portfolio is more/less resilient'],
    relatedScreens: ['Executive Cockpit', 'Regulatory Compliance', 'Predictive Risk'],
    route: '/digital-twin-center',
  },

  {
    id: 'autonomous_risk',
    name: 'Autonomous Risk Operations',
    routePatterns: ['/autonomous-risk-center'],
    keywords: ['autonomous risk', 'ai agents', 'autonomous operations', 'risk agents', 'autonomous ai', 'agent fleet', 'ai recommendations'],
    description: `**Autonomous Risk Operations** — AI agent fleet that monitors risk 24/7 without fatigue.

**Active AI Agents:**
• **Credit Risk Agent** — Monitors DPD, utilization, bureau trends across all borrowers
• **Fraud Detection Agent** — Scans transaction patterns for velocity anomalies, clusters
• **Compliance Agent** — Tracks filing deadlines, data completeness for regulatory prep
• **Claims Agent** — Reviews insurance claims for fraud indicators
• **Collections Agent** — Prioritizes collection queue by predicted recovery probability

**Human-in-the-Loop Design:**
Agents generate recommendations → Analyst reviews → Approve/Override with reasoning → Outcome feeds agent learning

**Agent Performance Metrics:**
• Recommendations accepted vs overridden (accuracy signal)
• Time saved vs manual review
• False positive rate per agent

**When to intervene:**
• Compliance Agent warning → Verify data completeness immediately
• Credit Risk Agent "Critical" flag → Override requires senior analyst
• Fraud Agent cluster alert → Do NOT discuss with customer (SAR confidentiality)`,
    kpis: ['Active agents', 'Recommendations/day', 'Auto-approval rate', 'Agent accuracy %'],
    actions: ['Review recommendations', 'Approve/Override', 'Configure agent thresholds', 'View agent performance'],
    outcomes: ['24/7 risk monitoring', 'Scaled operations', 'Consistent rule application'],
    users: ['CRO', 'Risk Analyst', 'Operations Team'],
    tips: ['Review agent recommendation queue every morning before alerts', 'Never auto-approve without reading agent reasoning for critical flags'],
    relatedScreens: ['AI Governance', 'Alert Management', 'AI Decisioning'],
    route: '/autonomous-risk-center',
  },

  {
    id: 'ai_decisioning',
    name: 'Advanced AI Decisioning Center',
    routePatterns: ['/ai-decisioning-center'],
    keywords: ['ai decisioning', 'ai decisions', 'decisioning center', 'decision engine', 'credit decision', 'shap decision', 'model decisions'],
    description: `**AI Decisioning Center** — Automated risk decisions with full explainability.

**Decision Types Handled:**
• Credit approval/decline (loan applications)
• Fraud flag → Block/Allow (transaction level)
• Claims approval/investigation (insurance)
• Collection strategy assignment (soft/legal)
• KYC risk classification (High/Medium/Low)

**SHAP Explainability on Every Decision:**
Every AI decision includes:
• Top 5 factors (positive and negative)
• Confidence score
• Regulatory compliance flag
• Override option with mandatory reasoning

**Audit Trail:**
Every decision is logged with: timestamp, model version, input features, output, SHAP, human override (if any)

**RBI Model Risk Management Compliance:**
• Model approved → Maker-checker sign-off
• SHAP explanation stored → 5 years retention
• Drift monitoring → Auto-retrain if PSI > 0.25`,
    kpis: ['Decisions/day', 'Auto-approval rate', 'Model confidence avg', 'Human override rate'],
    actions: ['View decision detail', 'Review SHAP factors', 'Override decision', 'Audit decision trail', 'Flag model drift'],
    outcomes: ['Faster credit decisions', 'Consistent rule application', 'Regulatory explainability'],
    users: ['Risk Analyst', 'Credit Officer', 'Collection Officer'],
    tips: ['Always read SHAP factors before overriding AI decision — overrides are audited', 'If override rate > 20%, review model calibration'],
    relatedScreens: ['AI Governance', 'Autonomous Risk', 'Predictive Risk'],
    route: '/ai-decisioning-center',
  },

  {
    id: 'integration_marketplace',
    name: 'Integration Marketplace',
    routePatterns: ['/integration-marketplace'],
    keywords: ['integration marketplace', 'connectors', 'api integrations', 'cbs connector', 'bureau integration', 'aml integration', 'integration health'],
    description: `**Integration Marketplace** — Manage all external system connections and monitor their health.

**Live Integrations:**
• CBS (Core Banking System) — Loan/repayment/account data
• Credit Bureau (CIBIL/CRIF/Experian/Equifax) — Daily bureau pulls
• AML Watchlist (OFAC, UN, domestic) — Hourly sync
• IFRS9 Feed — Daily stage/ECL data
• Core Insurance — Real-time policy/claims data
• Agent System (SAP/Salesforce) — Agent productivity

**Health Monitoring:**
• Green → p95 latency within SLA
• Yellow → Latency elevated, monitor
• Red (Degraded) → SLA breach, escalate to integration team

**SLA Targets:**
• CBS: < 2s response, 99.5% uptime
• Bureau: Daily batch by 06:00 IST
• AML: < 30 min refresh
• IFRS9: Daily batch by 08:00 IST`,
    kpis: ['Healthy connectors %', 'Avg latency (ms)', 'SLA compliance %', 'Failed jobs/day'],
    actions: ['Check connector health', 'Trigger manual sync', 'View SLA metrics', 'Configure alert', 'Review API logs'],
    outcomes: ['Reliable data flows', 'SLA compliance', 'Early detection of upstream issues'],
    users: ['Integration Engineer', 'Platform Admin', 'Risk Operations'],
    tips: ['CBS connector health impacts 100% of credit risk calculations — priority monitoring', 'IFRS9 feed delay > 2h should auto-escalate to risk team'],
    relatedScreens: ['Data Ingestion', 'Operations Center', 'Data Fabric'],
    route: '/integration-marketplace',
  },

  {
    id: 'governance_center',
    name: 'Governance Center',
    routePatterns: ['/admin/governance'],
    keywords: ['governance', 'governance center', 'tenant governance', 'domain governance', 'data governance', 'access governance'],
    description: `**Governance Center** — Enterprise governance policy management for domains, tenants, and data access.

**Governance Dimensions:**
• Domain separation — Banking vs Insurance data isolation
• Tenant policies — Per-tenant configuration overrides
• Cross-domain integrity — No data leakage between verticals
• Policy version control — Audit trail on all policy changes

**Key Governance Rules in ZorEWS:**
• Banking analysts cannot access insurance customer data (domain isolation)
• Tenant A data never visible to Tenant B (tenant isolation)
• Admin configuration changes require maker-checker
• Model promotions require dual approval

**Governance Audit Report:**
Generated monthly for CISO review — covers all policy changes, access anomalies, cross-domain queries`,
    kpis: ['Active policies', 'Policy violations', 'Cross-domain integrity', 'Tenant isolation health'],
    actions: ['View governance policies', 'Audit policy changes', 'Check tenant isolation', 'Generate governance report'],
    outcomes: ['Regulatory data separation', 'Reduced governance risk', 'Audit-ready governance records'],
    users: ['CISO', 'Platform Admin', 'Compliance Officer'],
    tips: ['Run tenant isolation check after any new tenant onboarding', 'Policy changes without maker-checker are a compliance breach'],
    relatedScreens: ['IAM Center', 'Audit Center', 'Regulatory Compliance'],
    route: '/admin/governance',
  },

  {
    id: 'iam_center',
    name: 'IAM Center',
    routePatterns: ['/admin/iam'],
    keywords: ['iam', 'iam center', 'user management', 'access control', 'rbac', 'roles', 'api keys', 'user roles', 'user access', 'permissions'],
    description: `**IAM Center (Identity & Access Management)** — Manage who can access what in ZorEWS.

**Core Features:**
• **User Management** — Create, activate, deactivate accounts
• **Role Assignment** — Assign: Risk Analyst, Fraud Analyst, Collection Officer, Supervisor, CRO, Auditor, Admin
• **API Key Management** — Service accounts for system integrations
• **Session Monitoring** — Active sessions, geographic anomalies
• **Quarterly Access Review** — RBI mandatory process

**RBAC Roles in ZorEWS:**
| Role | Access Level |
|---|---|
| Admin | Full platform access |
| Supervisor | All except IAM/Governance |
| Risk Analyst | Alerts, Cases, Predictive, Compliance (read/write) |
| Fraud Analyst | Fraud, Investigations, AML |
| Collection Officer | Cases, Recovery, Collections |
| Auditor | Read-only + Audit Center |

**Quarterly Access Review Process:**
Run access_review.py → Compare vs HR roster → Flag dormant accounts → CRO/CISO sign-off → Commit to audit trail`,
    kpis: ['Active users', 'Dormant accounts', 'MFA enrollment %', 'Failed logins (24h)'],
    actions: ['Create user', 'Assign role', 'Create API key', 'Review access', 'Revoke access', 'Export user report'],
    outcomes: ['Least-privilege access', 'RBI access review compliance', 'Reduced insider risk'],
    users: ['Platform Admin', 'CISO'],
    tips: ['Disable dormant accounts (> 90 days) immediately — RBI requirement', 'Force MFA for all admin-level accounts'],
    relatedScreens: ['Audit Center', 'Security Center', 'Governance Center'],
    route: '/admin/iam',
  },

  {
    id: 'recovery_center',
    name: 'Recovery Center',
    routePatterns: ['/recovery-center'],
    keywords: ['recovery center', 'data recovery', 'recover data', 'soft delete', 'purge', 'restore', 'recovery queue'],
    description: `**Recovery Center** — Manage soft-deleted records, recovery approvals, and purge schedules.

**Recovery Workflow:**
Record deleted → Soft-deleted (30-day window) → Recovery requested → Maker-Checker approval → Restored

**Purge Schedule:**
After 30 days soft-delete window → Permanent purge with audit log entry → Cannot be recovered

**Maker-Checker on Recovery:**
All recovery actions require dual approval — prevents accidental/malicious restoration of deleted records

**Use Cases:**
• Accidentally deleted case → Recover within 30 days
• Regulatory audit requires old record → Request recovery with reason
• Cleanup of test data → Schedule purge with admin approval

**Audit Trail:**
Every recovery and purge action is logged in the immutable audit chain with SHA-256 hash.`,
    kpis: ['Pending recovery approvals', 'Records restored today', 'Purge queue size', 'Recovery SLA (hrs)'],
    actions: ['Request recovery', 'Approve recovery', 'Schedule purge', 'View audit log', 'Export recovery report'],
    outcomes: ['Data loss prevention', 'Regulatory compliance', 'Controlled data lifecycle'],
    users: ['Platform Admin', 'Data Steward', 'Compliance Officer'],
    tips: ['Recovery requests > 25 days old are urgent — purge window closing', 'Always document reason when recovering deleted records'],
    relatedScreens: ['Audit Center', 'IAM Center'],
    route: '/recovery-center',
  },
];

// ─── Lookup helpers ───────────────────────────────────────────────────────

export function findModuleScreen(pathOrQuery: string): ModuleScreen | undefined {
  const q = pathOrQuery.toLowerCase();

  // Route match first
  const byRoute = MODULE_SCREENS.find(s =>
    s.routePatterns.some(p => q.includes(p) || p.includes(q.replace('/', '')))
  );
  if (byRoute) return byRoute;

  // Keyword match
  return MODULE_SCREENS.find(s =>
    s.keywords.some(k => q.includes(k)) ||
    s.name.toLowerCase().includes(q)
  );
}

export function formatModuleScreenResponse(screen: ModuleScreen, lang: 'en' | 'hi' | 'hinglish'): CopilotResponse {
  const body = lang === 'hinglish' && screen.description_hinglish
    ? screen.description_hinglish
    : screen.description;

  const kpiLine = `\n\n**Key Metrics:** ${screen.kpis.join(' · ')}`;
  const actionsLine = `\n**Quick Actions:** ${screen.actions.slice(0, 4).join(' · ')}`;

  const suggestions = [
    ...screen.actions.slice(0, 2).map(a => a),
    `How does ${screen.name} workflow work?`,
    `Show related modules`,
  ];

  return {
    reply: `${body}${kpiLine}${actionsLine}`,
    suggestions,
    sections: [
      { title: 'Who uses this', type: 'bullets', items: screen.users },
      { title: 'Pro Tips', type: 'bullets', items: screen.tips },
    ],
    actions: [
      { label: `Open ${screen.name}`, href: screen.route, icon: 'external-link' },
      ...screen.relatedScreens.slice(0, 2).map(rs => {
        const related = MODULE_SCREENS.find(s => s.name === rs);
        return { label: rs, href: related?.route ?? '/', icon: 'arrow-right' };
      }),
    ],
  };
}
