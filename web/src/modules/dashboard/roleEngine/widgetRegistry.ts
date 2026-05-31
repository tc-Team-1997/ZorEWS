// web/src/modules/dashboard/roleEngine/widgetRegistry.ts
//
// Role-Based Dashboard Engine — extended widget registry.
//
// Layers on TOP of the existing WIDGET_CATALOGUE (7 widgets in
// DashboardWidgetsPage.tsx + the M11.7 8-widget custom dashboard catalog).
// Adds 8 executive KPIs + 8 banking + 8 insurance + 12 role-specialised
// widgets = 36 NET-NEW entries the role engine composes per (role, domain,
// country, tenant, branch).
//
// Pure data — no imports beyond types. Production swap: registry rows
// move to app_iam.role_dashboard_widgets (already exists from T4.23) +
// dashboard_layouts + dashboard_widget_preferences (migration 051).

export type WidgetCategory =
  | 'executive_kpi'
  | 'banking'
  | 'insurance'
  | 'governance'
  | 'security'
  | 'recovery'
  | 'ai'
  | 'audit'
  | 'role_specialised';

export type WidgetRole =
  | 'super_admin'
  | 'country_admin'
  | 'bank_admin'
  | 'insurance_admin'
  | 'risk_analyst'
  | 'fraud_analyst'
  | 'auditor'
  | 'executive'
  | 'admin'           // legacy backend role
  | 'supervisor'
  | 'collection_officer'
  | 'field_officer';

export type WidgetDomain = 'banking' | 'insurance' | 'both';

export type WidgetVisualKind =
  | 'kpi'
  | 'heatmap'
  | 'trend'
  | 'list'
  | 'leaderboard'
  | 'gauge'
  | 'donut'
  | 'insight_feed';

export interface WidgetDef {
  /** Stable id. Becomes the row key in app_iam.role_dashboard_widgets. */
  id: string;
  /** Display label rendered in the SPA + admin matrix. */
  label: string;
  /** One-line description for tooltips + the widget governance admin page. */
  description: string;
  /** Visual rendering kind — drives which component renders the widget. */
  kind: WidgetVisualKind;
  /** Category — used by the SPA to group widgets in the layout. */
  category: WidgetCategory;
  /** Roles that see this widget by default. SUPER_ADMIN always sees all. */
  default_roles: readonly WidgetRole[];
  /** Domain visibility — banking-only widgets hide for insurance users. */
  default_domain: WidgetDomain;
  /** Optional deep-link the widget header click navigates to. */
  drill_to?: string;
  /** Tile span on the 12-col grid (default 4 = quarter row). */
  default_span?: number;
  /** Whether the widget is governance-controlled (per-tenant overridable). */
  governance_controlled: boolean;
}

// ───────────────────────────────────────────────────────────────────────
// 8 Executive KPI tiles per the brief
// ───────────────────────────────────────────────────────────────────────

const EXECUTIVE_KPIS: readonly WidgetDef[] = [
  {
    id: 'kpi_total_alerts',
    label: 'Total Alerts',
    description: 'Total open alerts across every severity in the tenant',
    kind: 'kpi',
    category: 'executive_kpi',
    default_roles: ['super_admin', 'country_admin', 'bank_admin', 'insurance_admin', 'executive', 'admin', 'supervisor'],
    default_domain: 'both',
    drill_to: '/alerts',
    default_span: 3,
    governance_controlled: true,
  },
  {
    id: 'kpi_open_cases',
    label: 'Open Cases',
    description: 'Cases in any non-closed state (open / assigned / in_action / monitored)',
    kind: 'kpi',
    category: 'executive_kpi',
    default_roles: ['super_admin', 'country_admin', 'bank_admin', 'insurance_admin', 'executive', 'admin', 'supervisor', 'risk_analyst'],
    default_domain: 'both',
    drill_to: '/cms/cases',
    default_span: 3,
    governance_controlled: true,
  },
  {
    id: 'kpi_high_risk_customers',
    label: 'High Risk Customers',
    description: 'Customers with PD ≥ 0.65 across the active book',
    kind: 'kpi',
    category: 'executive_kpi',
    default_roles: ['super_admin', 'bank_admin', 'executive', 'admin', 'risk_analyst'],
    default_domain: 'banking',
    drill_to: '/customers?level=High',
    default_span: 3,
    governance_controlled: true,
  },
  {
    id: 'kpi_fraud_exposure_kes',
    label: 'Fraud Exposure (KES)',
    description: 'Aggregate KES exposure on accounts flagged with fraud-family rules',
    kind: 'kpi',
    category: 'executive_kpi',
    default_roles: ['super_admin', 'bank_admin', 'fraud_analyst', 'executive', 'admin'],
    default_domain: 'both',
    default_span: 3,
    governance_controlled: true,
  },
  {
    id: 'kpi_recovery_rate',
    label: 'Recovery Rate',
    description: 'Restored vs deleted ratio over the trailing 30 days (Recovery Center)',
    kind: 'kpi',
    category: 'executive_kpi',
    default_roles: ['super_admin', 'admin', 'supervisor', 'executive'],
    default_domain: 'both',
    drill_to: '/recovery-center/analytics',
    default_span: 3,
    governance_controlled: true,
  },
  {
    id: 'kpi_compliance_score',
    label: 'Compliance Score',
    description: 'Composite score over audit chain integrity + maker-checker SLA + RBAC review timeliness',
    kind: 'kpi',
    category: 'executive_kpi',
    default_roles: ['super_admin', 'country_admin', 'auditor', 'executive', 'admin'],
    default_domain: 'both',
    drill_to: '/audit-center',
    default_span: 3,
    governance_controlled: true,
  },
  {
    id: 'kpi_ai_prediction_accuracy',
    label: 'AI Prediction Accuracy',
    description: 'Rolling 30-day champion-model AUC (PD model + fraud model averaged)',
    kind: 'kpi',
    category: 'executive_kpi',
    default_roles: ['super_admin', 'executive', 'admin', 'risk_analyst'],
    default_domain: 'both',
    drill_to: '/ai/governance/performance',
    default_span: 3,
    governance_controlled: true,
  },
  {
    id: 'kpi_portfolio_risk_score',
    label: 'Portfolio Risk Score',
    description: 'Composite Σ(weight × indicator value) across the active book',
    kind: 'kpi',
    category: 'executive_kpi',
    default_roles: ['super_admin', 'bank_admin', 'insurance_admin', 'executive', 'admin'],
    default_domain: 'both',
    default_span: 3,
    governance_controlled: true,
  },
];

// ───────────────────────────────────────────────────────────────────────
// 8 Banking-domain widgets
// ───────────────────────────────────────────────────────────────────────

const BANKING_WIDGETS: readonly WidgetDef[] = [
  { id: 'bw_borrower_watch',       label: 'Borrower Watch',        description: 'Top deteriorating borrowers by PD delta', kind: 'list',        category: 'banking', default_roles: ['super_admin', 'bank_admin', 'risk_analyst', 'admin', 'supervisor'], default_domain: 'banking', drill_to: '/borrower-watch',       default_span: 6, governance_controlled: true },
  { id: 'bw_account_behaviour',    label: 'Account Behaviour',     description: 'Cash-flow + transaction anomaly score by account', kind: 'trend',       category: 'banking', default_roles: ['super_admin', 'bank_admin', 'risk_analyst', 'admin', 'supervisor'], default_domain: 'banking', drill_to: '/account-behaviour',    default_span: 6, governance_controlled: true },
  { id: 'bw_financial_ratios',     label: 'Financial Ratios',      description: 'DSCR / CCC / current-ratio outliers across SME book', kind: 'list',        category: 'banking', default_roles: ['super_admin', 'bank_admin', 'risk_analyst', 'admin', 'supervisor'], default_domain: 'banking', drill_to: '/financial-ratios',     default_span: 6, governance_controlled: true },
  { id: 'bw_sma_classification',   label: 'SMA Classification',    description: 'SMA0 / SMA1 / SMA2 movement chart (RBI signal)', kind: 'trend',       category: 'banking', default_roles: ['super_admin', 'bank_admin', 'risk_analyst', 'admin', 'supervisor'], default_domain: 'banking', drill_to: '/banking/sma',          default_span: 6, governance_controlled: true },
  { id: 'bw_npa_prediction',       label: 'NPA Prediction',        description: 'Forecast NPA additions next quarter (XGBoost PD model)', kind: 'gauge',       category: 'banking', default_roles: ['super_admin', 'bank_admin', 'risk_analyst', 'admin', 'supervisor', 'executive'], default_domain: 'banking', drill_to: '/banking/npa-prediction', default_span: 6, governance_controlled: true },
  { id: 'bw_fraud_signals',        label: 'Fraud Signals',         description: 'Real-time fraud signal feed (FRD-001..004 firings)', kind: 'insight_feed', category: 'banking', default_roles: ['super_admin', 'bank_admin', 'fraud_analyst', 'admin', 'supervisor'], default_domain: 'banking', drill_to: '/fraud-signals',        default_span: 6, governance_controlled: true },
  { id: 'bw_sector_watch',         label: 'Sector Watch',          description: 'Top-5 sectors by aggregate PD movement', kind: 'leaderboard', category: 'banking', default_roles: ['super_admin', 'bank_admin', 'risk_analyst', 'admin', 'supervisor', 'executive'], default_domain: 'banking', drill_to: '/banking/sectors',      default_span: 6, governance_controlled: true },
  { id: 'bw_branch_risk_heatmap',  label: 'Branch Risk Heatmap',   description: 'Branch × risk-class heatmap (geographic ops view)', kind: 'heatmap',     category: 'banking', default_roles: ['super_admin', 'bank_admin', 'risk_analyst', 'admin', 'supervisor', 'executive'], default_domain: 'banking', drill_to: '/branch-heatmap',       default_span: 12, governance_controlled: true },
];

// ───────────────────────────────────────────────────────────────────────
// 8 Insurance-domain widgets
// ───────────────────────────────────────────────────────────────────────

const INSURANCE_WIDGETS: readonly WidgetDef[] = [
  { id: 'iw_policy_lapse',         label: 'Policy Lapse Risk',     description: 'Policies trending toward lapse in the next 60 days', kind: 'list',        category: 'insurance', default_roles: ['super_admin', 'insurance_admin', 'risk_analyst', 'admin', 'supervisor'], default_domain: 'insurance', drill_to: '/insurance/policy-lapse',         default_span: 6, governance_controlled: true },
  { id: 'iw_claims_anomaly',       label: 'Claims Anomaly',        description: 'Anomalous claim patterns flagged this week', kind: 'list',        category: 'insurance', default_roles: ['super_admin', 'insurance_admin', 'fraud_analyst', 'admin', 'supervisor'], default_domain: 'insurance', drill_to: '/insurance/claims-anomaly',       default_span: 6, governance_controlled: true },
  { id: 'iw_fraud_detection',      label: 'Fraud Detection',       description: 'Insurance fraud signals — repeat claims, hospital cluster, agent cluster', kind: 'insight_feed', category: 'insurance', default_roles: ['super_admin', 'insurance_admin', 'fraud_analyst', 'admin', 'supervisor'], default_domain: 'insurance', drill_to: '/insurance/fraud',                default_span: 6, governance_controlled: true },
  { id: 'iw_solvency_watch',       label: 'Solvency Status',       description: 'Solvency ratio + early-warning bands per IRDAI Form-K', kind: 'gauge',       category: 'insurance', default_roles: ['super_admin', 'insurance_admin', 'executive', 'admin', 'supervisor'], default_domain: 'insurance', drill_to: '/insurance/solvency',             default_span: 6, governance_controlled: true },
  { id: 'iw_persistency_watch',    label: 'Persistency Watch',     description: '13/25/37/61 month persistency by product + channel', kind: 'trend',       category: 'insurance', default_roles: ['super_admin', 'insurance_admin', 'risk_analyst', 'admin', 'supervisor', 'executive'], default_domain: 'insurance', drill_to: '/insurance/persistency',          default_span: 6, governance_controlled: true },
  { id: 'iw_underwriting_dev',     label: 'Underwriting Deviation', description: 'Underwriters exceeding the deviation threshold this month', kind: 'leaderboard', category: 'insurance', default_roles: ['super_admin', 'insurance_admin', 'risk_analyst', 'admin', 'supervisor'], default_domain: 'insurance', drill_to: '/insurance/underwriting',         default_span: 6, governance_controlled: true },
  { id: 'iw_channel_risk',         label: 'Channel Risk',          description: 'Per-channel persistency + lapse-rate ranking', kind: 'leaderboard', category: 'insurance', default_roles: ['super_admin', 'insurance_admin', 'risk_analyst', 'admin', 'supervisor', 'executive'], default_domain: 'insurance', drill_to: '/insurance/channel-risk',         default_span: 6, governance_controlled: true },
  { id: 'iw_insurance_heatmap',    label: 'Insurance Heatmap',     description: 'Branch × policy-class heatmap (geographic ops view)', kind: 'heatmap',     category: 'insurance', default_roles: ['super_admin', 'insurance_admin', 'risk_analyst', 'admin', 'supervisor', 'executive'], default_domain: 'insurance', drill_to: '/insurance/heatmaps',             default_span: 12, governance_controlled: true },
];

// ───────────────────────────────────────────────────────────────────────
// Role-specialised widgets (Auditor / Fraud / Country admin / etc.)
// ───────────────────────────────────────────────────────────────────────

const ROLE_SPECIALISED: readonly WidgetDef[] = [
  { id: 'rs_platform_health',          label: 'Platform Health',          description: 'BFF + auth-svc + cases-svc heartbeats + chain integrity',     kind: 'gauge',        category: 'governance',       default_roles: ['super_admin'],                  default_domain: 'both', drill_to: '/audit-center',         default_span: 6, governance_controlled: false },
  { id: 'rs_active_users',             label: 'Active Users',             description: 'Sessions active in the last 60 minutes across the platform',  kind: 'kpi',          category: 'security',         default_roles: ['super_admin', 'admin'],         default_domain: 'both', drill_to: '/admin/iam',            default_span: 3, governance_controlled: false },
  { id: 'rs_tenant_summary',           label: 'Tenant Summary',           description: 'Per-tenant scorecard (counts of alerts/cases/users/recoveries)', kind: 'list',         category: 'governance',       default_roles: ['super_admin'],                  default_domain: 'both', drill_to: '/admin/tenants',        default_span: 12, governance_controlled: false },
  { id: 'rs_country_summary',          label: 'Country Summary',          description: 'Cross-country KPI rollup (country_admin sees own only)',      kind: 'list',         category: 'governance',       default_roles: ['super_admin', 'country_admin'], default_domain: 'both', drill_to: '/admin/governance',     default_span: 12, governance_controlled: true  },
  { id: 'rs_country_risk_overview',    label: 'Country Risk Overview',    description: 'Cross-tenant risk-score heatmap scoped to country',           kind: 'heatmap',      category: 'governance',       default_roles: ['country_admin', 'super_admin'], default_domain: 'both', default_span: 12, governance_controlled: true  },
  { id: 'rs_country_compliance',       label: 'Country Compliance',       description: 'Regulator compliance posture per tenant in country',          kind: 'gauge',        category: 'governance',       default_roles: ['country_admin', 'super_admin', 'auditor'], default_domain: 'both', drill_to: '/audit-center/compliance', default_span: 6, governance_controlled: true  },
  { id: 'rs_high_risk_accounts',       label: 'High Risk Accounts',       description: 'Top 10 accounts by composite risk score',                     kind: 'list',         category: 'role_specialised', default_roles: ['risk_analyst', 'super_admin'],  default_domain: 'banking', drill_to: '/customers?level=High', default_span: 6, governance_controlled: true  },
  { id: 'rs_active_alerts_list',       label: 'Active Alerts',            description: 'Live alert feed sorted by criticality + age',                 kind: 'insight_feed', category: 'role_specialised', default_roles: ['risk_analyst', 'fraud_analyst', 'collection_officer'], default_domain: 'both', drill_to: '/alerts',               default_span: 6, governance_controlled: true  },
  { id: 'rs_case_queue',               label: 'Case Queue',               description: 'My + my-team open cases sorted by SLA breach risk',           kind: 'list',         category: 'role_specialised', default_roles: ['risk_analyst', 'fraud_analyst', 'collection_officer', 'supervisor'], default_domain: 'both', drill_to: '/cms/cases',          default_span: 6, governance_controlled: true  },
  { id: 'rs_fraud_investigation_queue', label: 'Fraud Investigation Queue', description: 'Open fraud investigations + suspect entity counts',            kind: 'list',         category: 'role_specialised', default_roles: ['fraud_analyst', 'super_admin', 'admin'], default_domain: 'both', drill_to: '/cms/cases',           default_span: 6, governance_controlled: true  },
  { id: 'rs_network_analysis',         label: 'Network Analysis',         description: 'Suspect-entity network graph (high-risk relationships)',      kind: 'heatmap',      category: 'role_specialised', default_roles: ['fraud_analyst', 'super_admin'], default_domain: 'both', drill_to: '/insurance/fraud',     default_span: 12, governance_controlled: true  },
  { id: 'rs_audit_exceptions',         label: 'Audit Exceptions',         description: 'Audit chain breaks + unresolved compliance violations',        kind: 'list',         category: 'audit',            default_roles: ['auditor', 'super_admin'],       default_domain: 'both', drill_to: '/audit-center/trail',   default_span: 6, governance_controlled: false },
  { id: 'rs_compliance_violations',    label: 'Compliance Violations',    description: 'RBI / IRDAI compliance breaches detected in last 7 days',     kind: 'list',         category: 'audit',            default_roles: ['auditor', 'super_admin', 'country_admin'], default_domain: 'both', drill_to: '/audit-center/compliance', default_span: 6, governance_controlled: true  },
  { id: 'rs_security_alerts',          label: 'Security Alerts',          description: 'Security Activity Center critical-actor feed',                kind: 'insight_feed', category: 'security',         default_roles: ['super_admin', 'admin', 'auditor'], default_domain: 'both', drill_to: '/admin/security',     default_span: 6, governance_controlled: false },
  { id: 'rs_user_activity_feed',       label: 'User Activity',            description: 'Recent auth + admin activity events',                         kind: 'insight_feed', category: 'audit',            default_roles: ['auditor', 'super_admin', 'admin'], default_domain: 'both', drill_to: '/audit-center/activity', default_span: 6, governance_controlled: false },
  { id: 'rs_recovery_actions_feed',    label: 'Recovery Actions',         description: 'Restore + purge + approval timeline (last 7 days)',           kind: 'insight_feed', category: 'recovery',         default_roles: ['auditor', 'super_admin', 'admin'], default_domain: 'both', drill_to: '/recovery-center/history', default_span: 6, governance_controlled: false },
  { id: 'rs_recovery_statistics',      label: 'Recovery Statistics',      description: 'Restore rate / purge rate / breach quarantine ratio',         kind: 'gauge',        category: 'recovery',         default_roles: ['super_admin', 'admin'],         default_domain: 'both', drill_to: '/recovery-center/analytics', default_span: 6, governance_controlled: false },
  { id: 'rs_ai_model_status',          label: 'AI Model Status',          description: 'Production / shadow / staging model summary per type',        kind: 'list',         category: 'ai',               default_roles: ['super_admin', 'risk_analyst', 'admin'], default_domain: 'both', drill_to: '/ai/governance',     default_span: 6, governance_controlled: false },
  { id: 'rs_ai_predictions',           label: 'AI Predictions',           description: 'Latest top-K AI-flagged customers + explainer reasons',       kind: 'list',         category: 'ai',               default_roles: ['risk_analyst', 'super_admin', 'admin'], default_domain: 'both', drill_to: '/ai/insights',       default_span: 6, governance_controlled: true  },
  { id: 'rs_audit_activity',           label: 'Audit Activity',           description: 'Audit-event volume by severity (last 30 days)',               kind: 'trend',        category: 'audit',            default_roles: ['super_admin', 'auditor', 'admin'], default_domain: 'both', drill_to: '/audit-center/activity', default_span: 6, governance_controlled: false },
  { id: 'rs_executive_heatmap',        label: 'Executive Heatmap',        description: 'Enterprise risk heatmap (segment × risk-class)',              kind: 'heatmap',      category: 'executive_kpi',    default_roles: ['executive', 'super_admin'],     default_domain: 'both', drill_to: '/analytics',           default_span: 12, governance_controlled: true  },
  { id: 'rs_top_exposures',            label: 'Top Exposures',            description: 'Top 20 exposures by KES amount across the active book',        kind: 'leaderboard',  category: 'executive_kpi',    default_roles: ['executive', 'super_admin', 'bank_admin', 'insurance_admin'], default_domain: 'both', drill_to: '/customers',          default_span: 6, governance_controlled: true  },
  { id: 'rs_strategic_kpis',           label: 'Strategic KPIs',           description: 'CXO-tier strategic KPI summary card',                         kind: 'kpi',          category: 'executive_kpi',    default_roles: ['executive', 'super_admin'],     default_domain: 'both', drill_to: '/analytics',           default_span: 6, governance_controlled: true  },
  { id: 'rs_trend_analytics',          label: 'Trend Analytics',          description: '13/26/52-week trend chart (alerts / cases / recoveries)',     kind: 'trend',        category: 'executive_kpi',    default_roles: ['executive', 'super_admin', 'risk_analyst'], default_domain: 'both', drill_to: '/analytics',     default_span: 12, governance_controlled: true  },
  { id: 'rs_branch_risk_ranking',      label: 'Branch Risk Ranking',      description: 'Top + bottom 10 branches by composite risk score',            kind: 'leaderboard',  category: 'banking',          default_roles: ['bank_admin', 'super_admin', 'admin', 'supervisor'], default_domain: 'banking', drill_to: '/branch-heatmap', default_span: 6, governance_controlled: true  },
  { id: 'rs_recovery_performance',     label: 'Recovery Performance',     description: 'Recovery rate trend by entity_type (last 90 days)',            kind: 'trend',        category: 'recovery',         default_roles: ['bank_admin', 'super_admin', 'admin'], default_domain: 'both', drill_to: '/recovery-center/analytics', default_span: 6, governance_controlled: true  },
  { id: 'rs_risk_heatmaps',            label: 'Risk Heatmaps',            description: 'Segment × risk-class heatmap with drill-down',                kind: 'heatmap',      category: 'role_specialised', default_roles: ['risk_analyst', 'super_admin', 'admin'], default_domain: 'both', drill_to: '/analytics',         default_span: 12, governance_controlled: true  },
  { id: 'rs_country_users',            label: 'Country Users',            description: 'Active user roster + role mix per country',                   kind: 'list',         category: 'governance',       default_roles: ['country_admin', 'super_admin'], default_domain: 'both', drill_to: '/admin/users',         default_span: 6, governance_controlled: true  },
  { id: 'rs_country_alerts',           label: 'Country Alerts',           description: 'Country-scoped alert mix by severity',                         kind: 'donut',        category: 'governance',       default_roles: ['country_admin', 'super_admin'], default_domain: 'both', drill_to: '/alerts',             default_span: 6, governance_controlled: true  },
  { id: 'rs_country_performance',      label: 'Country Performance',      description: 'KPI trendline for the assigned country',                       kind: 'trend',        category: 'governance',       default_roles: ['country_admin', 'super_admin'], default_domain: 'both', drill_to: '/analytics',           default_span: 12, governance_controlled: true  },
  { id: 'rs_governance_status',        label: 'Governance Status',        description: 'Maker-checker SLA compliance + access-review currency',       kind: 'gauge',        category: 'governance',       default_roles: ['super_admin', 'auditor'],       default_domain: 'both', drill_to: '/admin/governance',    default_span: 6, governance_controlled: false },
  { id: 'rs_banking_portfolio',        label: 'Banking Portfolio Overview', description: 'Outstanding KES / NPA% / interest yield rolled up',           kind: 'kpi',          category: 'banking',          default_roles: ['bank_admin', 'super_admin', 'executive', 'admin'], default_domain: 'banking', drill_to: '/banking/sectors', default_span: 6, governance_controlled: true  },
  { id: 'rs_suspicious_activity',      label: 'Suspicious Activity',      description: 'AML + fraud cross-feed (sanctions + repeat-claim)',           kind: 'insight_feed', category: 'role_specialised', default_roles: ['fraud_analyst', 'super_admin'], default_domain: 'both', drill_to: '/insurance/fraud',     default_span: 6, governance_controlled: true  },
  { id: 'rs_high_risk_entities',       label: 'High-Risk Entities',       description: 'Entities (customers / agents / hospitals) with active flags', kind: 'list',         category: 'role_specialised', default_roles: ['fraud_analyst', 'super_admin'], default_domain: 'both', default_span: 6, governance_controlled: true  },
  { id: 'rs_portfolio_health',         label: 'Portfolio Health',         description: 'Composite health bar (PD / DPD / coverage)',                   kind: 'gauge',        category: 'executive_kpi',    default_roles: ['executive', 'super_admin'],     default_domain: 'both', drill_to: '/analytics',           default_span: 6, governance_controlled: true  },
  { id: 'rs_enterprise_risk_score',    label: 'Enterprise Risk Score',    description: 'Single-number CXO risk score 0..100 with band',               kind: 'kpi',          category: 'executive_kpi',    default_roles: ['executive', 'super_admin'],     default_domain: 'both', default_span: 6, governance_controlled: true  },
  { id: 'rs_security_events',          label: 'Security Events',          description: 'Audit Center critical-event feed (last 72h)',                 kind: 'insight_feed', category: 'security',         default_roles: ['auditor', 'super_admin', 'admin'], default_domain: 'both', drill_to: '/admin/security',     default_span: 6, governance_controlled: false },
];

// ───────────────────────────────────────────────────────────────────────
// Unified registry — concat of the 4 source arrays
// ───────────────────────────────────────────────────────────────────────

export const WIDGET_REGISTRY: readonly WidgetDef[] = [
  ...EXECUTIVE_KPIS,
  ...BANKING_WIDGETS,
  ...INSURANCE_WIDGETS,
  ...ROLE_SPECIALISED,
];

export function getWidget(id: string): WidgetDef | undefined {
  return WIDGET_REGISTRY.find((w) => w.id === id);
}

export function widgetsByCategory(): Record<WidgetCategory, WidgetDef[]> {
  const out: Record<string, WidgetDef[]> = {};
  for (const w of WIDGET_REGISTRY) {
    if (!out[w.category]) out[w.category] = [];
    out[w.category].push(w);
  }
  return out as Record<WidgetCategory, WidgetDef[]>;
}

export const ALL_WIDGET_KINDS: readonly WidgetVisualKind[] = [
  'kpi', 'heatmap', 'trend', 'list', 'leaderboard', 'gauge', 'donut', 'insight_feed',
] as const;
