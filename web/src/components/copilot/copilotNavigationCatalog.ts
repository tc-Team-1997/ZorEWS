// copilotNavigationCatalog.ts
//
// ZorEWS Copilot — Navigation Catalog
// Maps user intent to platform destinations.
// Answers questions like "Where can I manage rules?" or "Where is compliance?"
//
// 100% additive — no existing logic changed.

export interface NavEntry {
  label:       string;
  route:       string;
  description: string;
  keywords:    string[];
  category:    string;
  requiredRole?: string[];
}

export const NAV_CATALOG: NavEntry[] = [

  // ── CORE RISK ─────────────────────────────────────────────────────────
  { label: 'Dashboard', route: '/', description: 'Enterprise Risk Command Center — main risk intelligence hub', keywords: ['dashboard', 'home', 'main page', 'overview', 'command center'], category: 'risk' },
  { label: 'Alert Center', route: '/alerts', description: 'All active risk alerts by severity — acknowledge, escalate, investigate', keywords: ['alerts', 'alert center', 'risk alerts', 'notifications alerts', 'where alerts', 'critical alerts'], category: 'risk' },
  { label: 'Investigation Center', route: '/investigation-center', description: 'Manage fraud, NPA, and compliance investigations with evidence workflow', keywords: ['investigation', 'investigate', 'fraud investigation', 'where investigations', 'open investigation'], category: 'risk' },
  { label: 'Predictive Risk Center', route: '/predictive-risk-center', description: 'AI-powered NPA predictions, SMA classification, sector risk, and 90-day forecasts', keywords: ['predictive', 'npa prediction', 'forecast', 'predict', 'npa forecast', 'risk forecast', 'where npa'], category: 'risk' },
  { label: 'Case Management (CMS)', route: '/cms/cases', description: 'Full lifecycle case management — create, investigate, close with maker-checker', keywords: ['case management', 'cms', 'cases', 'open cases', 'where cases', 'manage cases'], category: 'risk' },
  { label: 'Borrower Watch', route: '/borrower-watch', description: 'Monitor high-risk borrowers with real-time portfolio signals', keywords: ['borrower watch', 'borrower monitoring', 'watch list', 'watchlist borrower'], category: 'risk' },
  { label: 'Account Behaviour', route: '/account-behaviour', description: 'Analyze account behavioral patterns and velocity anomalies', keywords: ['account behaviour', 'account behavior', 'transaction behavior', 'behavioral analysis'], category: 'risk' },
  { label: 'Financial Ratios', route: '/financial-ratios', description: 'Monitor financial health ratios across the lending portfolio', keywords: ['financial ratios', 'leverage ratio', 'financial health', 'ratio analysis'], category: 'risk' },
  { label: 'Fraud Signals', route: '/fraud-signals', description: 'Real-time fraud detection signals, clusters, and velocity patterns', keywords: ['fraud signals', 'fraud detection', 'where fraud', 'fraud alerts', 'fraud monitor'], category: 'risk' },
  { label: 'Sector Watch', route: '/banking/sectors', description: 'Monitor risk concentration by industry sector', keywords: ['sector watch', 'industry risk', 'sector risk', 'sector concentration'], category: 'risk' },
  { label: 'SMA Classification', route: '/banking/sma', description: 'Special Mention Accounts — DPD-based classification (SMA-0/1/2)', keywords: ['sma', 'sma classification', 'special mention accounts', 'dpd classification', 'where sma'], category: 'risk' },
  { label: 'NPA Prediction', route: '/banking/npa-prediction', description: 'ML-powered NPA probability scores and early warning list', keywords: ['npa prediction', 'npa score', 'pd score', 'probability of default', 'where npa prediction'], category: 'risk' },
  { label: 'Branch & Geography Risk', route: '/branch-heatmap', description: 'Geographic risk distribution and branch-level NPA heatmap', keywords: ['branch risk', 'geography risk', 'branch heatmap', 'location risk', 'branch monitoring'], category: 'risk' },
  { label: 'Collections Risk', route: '/collections-risk', description: 'Collection efficiency, SLA tracking, and recovery pipeline management', keywords: ['collections risk', 'collection management', 'recovery', 'where collections'], category: 'risk' },

  // ── EXECUTIVE / REPORTING ─────────────────────────────────────────────
  { label: 'Executive Risk Cockpit', route: '/executive-cockpit', description: 'C-suite risk dashboard — Enterprise Risk Index, portfolio health, board readiness', keywords: ['executive cockpit', 'board dashboard', 'c-suite view', 'cro dashboard', 'executive view', 'where executive'], category: 'executive' },
  { label: 'Board Reporting Center', route: '/board-reporting-center', description: 'Generate and schedule board packs, regulatory submissions, and executive reports', keywords: ['board reporting', 'board pack', 'board reports', 'executive reports', 'where board reporting'], category: 'reporting' },
  { label: 'Reports Center', route: '/reports', description: 'Self-service report builder — create, schedule, and export any platform report', keywords: ['reports', 'reporting', 'export report', 'report builder', 'where reports', 'schedule report'], category: 'reporting' },
  { label: 'Borrower Timeline', route: '/borrower-timeline', description: 'Complete historical timeline of a borrower\'s account events and risk changes', keywords: ['borrower timeline', 'account history', 'customer timeline', 'historical view'], category: 'risk' },
  { label: 'Customer Intelligence', route: '/customers', description: 'Full customer intelligence list with risk scores, exposure, and DPD metrics', keywords: ['customers', 'customer list', 'customer intelligence', 'where customers', 'high risk customers'], category: 'risk' },

  // ── COMPLIANCE ────────────────────────────────────────────────────────
  { label: 'Regulatory Compliance Center', route: '/regulatory-compliance-center', description: 'RBI, Basel, AML/KYC, and IRDAI compliance management and filing', keywords: ['compliance', 'regulatory', 'rbi compliance', 'aml', 'kyc', 'irdai', 'basel', 'where compliance', 'compliance gaps', 'compliance center'], category: 'compliance' },
  { label: 'Audit Center', route: '/audit-center', description: 'Immutable SHA-256 audit trail, evidence packaging, and compliance verification', keywords: ['audit', 'audit trail', 'audit log', 'audit center', 'where audit', 'evidence'], category: 'compliance' },

  // ── AI / ML ───────────────────────────────────────────────────────────
  { label: 'AI Governance Center', route: '/ai/governance', description: 'ML model registry, performance tracking, champion/challenger, and promotion workflow', keywords: ['ai governance', 'model governance', 'ml models', 'model registry', 'where models', 'ai models', 'model management'], category: 'ai' },
  { label: 'Autonomous Risk Operations', route: '/autonomous-risk-center', description: 'AI agent fleet for automated risk monitoring, recommendations, and decisioning', keywords: ['autonomous risk', 'ai agents', 'autonomous operations', 'risk agents', 'where autonomous'], category: 'ai' },
  { label: 'AI Decisioning Center', route: '/ai-decisioning-center', description: 'Unified AI decision engine with SHAP explainability and decision audit trail', keywords: ['ai decisioning', 'ai decisions', 'decisioning', 'where decisioning', 'decision center'], category: 'ai' },
  { label: 'Digital Twin Center', route: '/digital-twin-center', description: 'Scenario simulation and stress testing — RBI, IRDAI, and custom macroeconomic scenarios', keywords: ['digital twin', 'scenario simulation', 'stress test', 'where simulation', 'scenario center', 'rbi stress test'], category: 'ai' },
  { label: 'Predictive Risk Center', route: '/predictive-risk-center', description: 'AI-powered early warning — NPA, fraud, lapse predictions at 30/90/180-day horizons', keywords: ['predictive center', 'predictive risk', 'prediction center', 'where predictive'], category: 'ai' },

  // ── DATA ──────────────────────────────────────────────────────────────
  { label: 'Data Ingestion', route: '/data-ingestion', description: 'CBS, bureau, AML, IFRS9, and insurance data ingestion with pipeline health', keywords: ['data ingestion', 'data pipeline', 'where ingestion', 'ingestion center', 'data feeds'], category: 'data' },
  { label: 'Data Quality', route: '/dq-score', description: 'Data quality scores, violations, and remediation queues', keywords: ['data quality', 'dq score', 'quality issues', 'data violations', 'where data quality'], category: 'data' },
  { label: 'Data Profiling', route: '/data-profiling-ai', description: 'AI-powered statistical profiling of all platform datasets', keywords: ['data profiling', 'statistical profile', 'dataset profiling', 'where profiling'], category: 'data' },
  { label: 'Streaming Latency', route: '/admin/streaming-latency', description: 'Real-time streaming latency monitor — validate 60-second alert SLA', keywords: ['streaming latency', 'latency monitor', 'streaming sla', 'where streaming'], category: 'data' },
  { label: 'Data Fabric Center', route: '/data-fabric-center', description: 'Unified data management — lineage, governance, and pipeline orchestration', keywords: ['data fabric', 'lineage', 'data governance', 'where fabric', 'data lineage'], category: 'data' },
  { label: 'Anomaly Detection', route: '/anomaly-detection-ai', description: 'AI-powered anomaly detection across all platform data streams', keywords: ['anomaly detection', 'data anomalies', 'detect anomalies', 'where anomaly'], category: 'data' },
  { label: 'Data Reconciliation', route: '/reconciliation', description: 'Reconcile data across source systems and platform stores', keywords: ['reconciliation', 'data reconciliation', 'where reconciliation'], category: 'data' },

  // ── OPERATIONS / INTEGRATION ──────────────────────────────────────────
  { label: 'Integration Marketplace', route: '/integration-marketplace', description: 'CBS, bureau, AML, IFRS9, and third-party integration management and health', keywords: ['integration', 'connectors', 'integration marketplace', 'api integrations', 'where integrations', 'cbs connector'], category: 'integration' },
  { label: 'Event Streaming Center', route: '/event-streaming-center', description: 'Kafka-based real-time event streaming — topic health, latency, and consumer monitoring', keywords: ['event streaming', 'kafka', 'streaming center', 'where streaming', 'real-time events'], category: 'integration' },
  { label: 'Operations Center', route: '/operations-center', description: 'Production system health — uptime, API performance, incidents, and deployments', keywords: ['operations center', 'ops center', 'system health', 'platform health', 'uptime', 'incidents', 'where operations'], category: 'operations' },

  // ── ADMIN ─────────────────────────────────────────────────────────────
  { label: 'IAM Center', route: '/admin/iam', description: 'User management, roles, permissions, API keys, and access reviews', keywords: ['iam', 'user management', 'access control', 'rbac', 'where iam', 'manage users', 'user roles', 'permissions'], category: 'admin', requiredRole: ['admin', 'super_admin'] },
  { label: 'Governance Center', route: '/admin/governance', description: 'Domain policies, tenant governance, and cross-domain integrity', keywords: ['governance', 'governance center', 'tenant governance', 'domain control', 'where governance'], category: 'admin', requiredRole: ['admin', 'super_admin'] },
  { label: 'Security Center', route: '/admin/security', description: 'Security activity log, access anomaly detection, and threat monitoring', keywords: ['security center', 'security activity', 'access anomaly', 'where security', 'security log'], category: 'admin', requiredRole: ['admin', 'super_admin'] },
  { label: 'Recovery Center', route: '/recovery-center', description: 'Data recovery, soft-delete management, and purge scheduling', keywords: ['recovery center', 'data recovery', 'recover data', 'where recovery', 'restore data'], category: 'admin' },
  { label: 'Notification Center', route: '/admin/notifications', description: 'Email, SMS, push notification templates, channels, and delivery logs', keywords: ['notification center', 'notifications', 'alerts delivery', 'notification templates', 'where notifications'], category: 'admin' },
  { label: 'Rule Center', route: '/rule-center', description: 'Create, manage, simulate, and monitor EWS rules', keywords: ['rule center', 'rules', 'manage rules', 'where rules', 'rule engine', 'ews rules', 'configure rules'], category: 'admin' },
  { label: 'Master Setup', route: '/admin/master-setup', description: 'Platform-wide configuration — thresholds, templates, tenant settings', keywords: ['master setup', 'admin config', 'configuration', 'where admin settings', 'where configure', 'platform config'], category: 'admin', requiredRole: ['admin', 'super_admin'] },

  // ── INSURANCE ─────────────────────────────────────────────────────────
  { label: 'Insurance Dashboard', route: '/insurance/dashboard', description: 'Insurance portfolio risk dashboard — claims, lapse, underwriting risk', keywords: ['insurance dashboard', 'insurance overview', 'where insurance'], category: 'insurance' },
  { label: 'Policy Lapse Risk', route: '/insurance/policy-lapse', description: 'Policy persistency monitoring and lapse prediction', keywords: ['policy lapse', 'lapse risk', 'policy persistency', 'where policy lapse'], category: 'insurance' },
  { label: 'Claims Anomaly', route: '/insurance/claims-anomaly', description: 'Detect fraudulent and anomalous insurance claims', keywords: ['claims anomaly', 'insurance claims', 'claims fraud', 'where claims'], category: 'insurance' },
  { label: 'Underwriting Intelligence', route: '/insurance/underwriting', description: 'AI-powered underwriting risk assessment and proposal scoring', keywords: ['underwriting', 'insurance underwriting', 'proposal scoring', 'where underwriting'], category: 'insurance' },

  // ── ROLE DASHBOARD ────────────────────────────────────────────────────
  { label: 'Role-Based Dashboard', route: '/dashboards/role-based', description: 'AI-prioritized dashboard adapts to your role, domain, and current workload', keywords: ['role dashboard', 'my dashboard', 'personalized dashboard', 'role based dashboard', 'where role dashboard'], category: 'dashboard' },
];

// ─── Lookup helpers ───────────────────────────────────────────────────────

export function findNavEntry(query: string): NavEntry | undefined {
  const q = query.toLowerCase();
  return NAV_CATALOG.find(e => e.keywords.some(k => q.includes(k)));
}

export function searchNavEntries(query: string): NavEntry[] {
  const q = query.toLowerCase();
  return NAV_CATALOG.filter(e =>
    e.keywords.some(k => q.includes(k)) ||
    e.label.toLowerCase().includes(q) ||
    e.description.toLowerCase().includes(q)
  ).slice(0, 6);
}

export function getNavByCategory(category: string): NavEntry[] {
  return NAV_CATALOG.filter(e => e.category === category);
}

/** Format a nav response reply */
export function formatNavResponse(entries: NavEntry[]): string {
  return entries.map(e => `• **${e.label}** → \`${e.route}\`\n  ${e.description}`).join('\n\n');
}
