// web/src/components/layout/navConfig.ts
//
// Sidebar navigation schema — single source of truth.
//
// Enterprise category-based structure per the EWS module brief:
//   1. DATA CLEANING
//   2. BANK — EARLY WARNING
//   3. ACTION CENTER
//   4. AI WORKBENCH
//   5. CONFIGURATION
//   6. ADMIN
//
// Rules:
//   - Every route mounted in App.tsx maps to exactly one group.
//   - Items flagged `featured: true` are the user-spec primary screens
//     for that category and render at the top of their group.
//   - Items without `requireRole` are visible to every signed-in user.
//   - When a group's filtered items list is empty (every entry role-gated
//     out for the viewer), AppShell hides the group entirely.
//   - Dashboard (/) lives outside the groups as the home link.

import {
  LayoutDashboard,
  Crown,
  Bell,
  Users,
  UsersRound,
  SlidersHorizontal,
  Network,
  Briefcase,
  FlaskConical,
  FileBarChart,
  Plug,
  ShieldCheck,
  Shield,
  History,
  Webhook,
  Building2,
  Key,
  Zap,
  Send,
  PlayCircle,
  BarChart3,
  Database,
  Gauge,
  BrainCircuit,
  TrendingUp,
  Activity,
  Sigma,
  ShieldAlert,
  GitBranch,
  Bot,
  Boxes,
  Microscope,
  FileSearch,
  Library,
  Cog,
  Workflow,
  Archive,
  UserCog,
  Settings2,
  Beaker,
  BookOpen,
  Umbrella,
  TrendingDown,
  HandCoins,
  Scale,
  Radar,
  Search,
  Gavel,
  Cable,
  Sparkles,
  ClipboardCheck,
  Cpu,
  Brain,
} from 'lucide-react';

export type LucideIcon = typeof LayoutDashboard;

export interface NavLeaf {
  /** Router path; must match a <Route> mounted in App.tsx. */
  to: string;
  /** Key in `nav.*` namespace (see web/src/lib/i18n.ts). */
  i18nKey: string;
  icon: LucideIcon;
  /** When set, only users whose roles include one of these see the entry. */
  requireRole?: ReadonlyArray<string>;
  /** Part of the user-spec curated category (renders ahead of extras). */
  featured?: boolean;
  /** Optional override testId; default `nav-link-${to}`. */
  testId?: string;
}

export interface NavGroup {
  /** Stable id used for collapse state persistence + tests. */
  id: string;
  /** Key in `nav.*` namespace — e.g. `cat_data_cleaning`. */
  i18nKey: string;
  icon: LucideIcon;
  items: ReadonlyArray<NavLeaf>;
  /** Optional domain gate. When set, the group is shown only when the
   *  active domain matches (or the user is a super-admin who sees both).
   *  Groups WITHOUT a domain (data-cleaning, action-center, admin, …) are
   *  always shown — they are cross-domain. */
  domain?: 'banking' | 'insurance';
}

// Home (sits above groups, always visible — no role gate).
export const NAV_HOME: NavLeaf = {
  to: '/',
  i18nKey: 'dashboard',
  icon: LayoutDashboard,
};

export const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  // ────────────────────────────────────────────────────────────────────
  // 1. DATA CLEANING
  // ────────────────────────────────────────────────────────────────────
  {
    id: 'data-cleaning',
    i18nKey: 'cat_data_cleaning',
    icon: Database,
    items: [
      { to: '/admin/ingestion',         i18nKey: 'data_ingestion',     icon: Database,     requireRole: ['admin', 'supervisor'], featured: true },
      { to: '/admin/data-profiling',    i18nKey: 'data_profiling',     icon: BrainCircuit, requireRole: ['admin', 'supervisor'], featured: true },
      // Validation Rules + Standardisation: spec-required slots; pages not yet shipped.
      // The closest live equivalents are surfaced under CONFIGURATION (/rules*).
      { to: '/admin/anomalies',         i18nKey: 'anomaly_detection',  icon: Activity,     requireRole: ['admin', 'supervisor'], featured: true },
      { to: '/admin/reconciliation',    i18nKey: 'reconciliation',     icon: Database,     requireRole: ['admin', 'supervisor'], featured: true },
      { to: '/admin/dq-score',          i18nKey: 'dq_score',           icon: Gauge,        requireRole: ['admin', 'supervisor'], featured: true },
      // Pipeline observability — auxiliary entry
      { to: '/admin/streaming-latency', i18nKey: 'streaming_latency',  icon: Gauge,        requireRole: ['admin', 'supervisor'] },
      { to: '/admin/integration-readiness', i18nKey: 'integration_readiness', icon: Activity, requireRole: ['admin', 'supervisor'], featured: true },
    ],
  },

  // ────────────────────────────────────────────────────────────────────
  // 2. BANK — EARLY WARNING
  // ────────────────────────────────────────────────────────────────────
  {
    id: 'bank-ews',
    i18nKey: 'cat_bank_ews',
    icon: TrendingUp,
    domain: 'banking',
    items: [
      { to: '/borrower-watch',         i18nKey: 'borrower_watch',     icon: TrendingUp,   featured: true },
      { to: '/account-behaviour',      i18nKey: 'account_behaviour',  icon: Activity,     featured: true },
      { to: '/financial-ratios',       i18nKey: 'financial_ratios',   icon: Sigma,        featured: true },
      { to: '/banking/sma',            i18nKey: 'sma_classification', icon: TrendingUp,   requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      { to: '/banking/npa-prediction', i18nKey: 'npa_prediction',     icon: BrainCircuit, requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      { to: '/fraud-signals',          i18nKey: 'fraud_signals',      icon: ShieldAlert,  featured: true },
      { to: '/banking/sectors',        i18nKey: 'sector_watch',       icon: BarChart3,    requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      { to: '/collections-risk',       i18nKey: 'collections_risk',   icon: HandCoins,    requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer'], featured: true },
      { to: '/borrower-timeline',      i18nKey: 'borrower_timeline',  icon: History,      requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      { to: '/branch-heatmap',         i18nKey: 'branch_heatmap',     icon: BarChart3,    requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      // Customers list — supporting drill-through anchor for Bank-EWS workflows
      { to: '/customers',              i18nKey: 'customers',          icon: Users },
    ],
  },

  // ────────────────────────────────────────────────────────────────────
  // 2b. INSURANCE — EARLY WARNING
  //     7-module Insurance EWS (Policy Lapse, Claims Anomaly, Fraud,
  //     Solvency, Persistency, Underwriting, Channel Risk). Leaves are
  //     added as each module's SPA page ships — the navConfig contract
  //     requires every leaf to map to a mounted route.
  // ────────────────────────────────────────────────────────────────────
  {
    id: 'insurance-ews',
    i18nKey: 'cat_insurance_ews',
    icon: Umbrella,
    domain: 'insurance',
    items: [
      { to: '/insurance/policy-lapse', i18nKey: 'insurance_policy_lapse', icon: TrendingDown, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'], featured: true },
      { to: '/insurance/claims-anomaly', i18nKey: 'insurance_claims_anomaly', icon: ShieldAlert, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'], featured: true },
      { to: '/insurance/fraud', i18nKey: 'insurance_fraud', icon: GitBranch, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'], featured: true },
      { to: '/insurance/solvency', i18nKey: 'insurance_solvency', icon: Gauge, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'], featured: true },
      { to: '/insurance/persistency', i18nKey: 'insurance_persistency', icon: Activity, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'], featured: true },
      { to: '/insurance/underwriting', i18nKey: 'insurance_underwriting', icon: SlidersHorizontal, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'], featured: true },
      { to: '/insurance/channel-risk', i18nKey: 'insurance_channel_risk', icon: Network, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'], featured: true },
      { to: '/insurance/claim-investigation', i18nKey: 'insurance_claim_investigation', icon: FileSearch, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'], featured: true },
      { to: '/insurance/policy-timeline', i18nKey: 'insurance_policy_timeline', icon: History, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'], featured: true },
      { to: '/insurance/heatmaps', i18nKey: 'insurance_heatmaps', icon: BarChart3, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'], featured: true },
    ],
  },

  // ────────────────────────────────────────────────────────────────────
  // 3. ACTION CENTER
  // ────────────────────────────────────────────────────────────────────
  {
    id: 'action-center',
    i18nKey: 'cat_action_center',
    icon: Bell,
    items: [
      // Role-Based Dashboard Engine — featured entry (top of Action Center).
      // Resolves widgets per (role × domain × country × tenant × branch).
      // Existing "/" Dashboard untouched.
      { to: '/dashboards/role-based',        i18nKey: 'role_based_dashboard',    icon: LayoutDashboard, featured: true },
      { to: '/dashboards/builder',           i18nKey: 'dashboard_builder',       icon: LayoutDashboard, requireRole: ['admin', 'supervisor', 'risk_analyst'] },
      // Executive Risk Cockpit — gated inside the page to 7 executive personas.
      // Sidebar entry visible to admin + supervisor so they discover it; the
      // page itself bounces non-executive roles via canAccessExecutiveCockpit.
      { to: '/executive-cockpit',            i18nKey: 'executive_cockpit',       icon: Crown,           requireRole: ['admin', 'supervisor'], featured: true },
      // Predictive Risk Center — gated inside the page; open to risk + fraud analysts too.
      // Sidebar visible to admin/supervisor/risk_analyst for discoverability.
      { to: '/predictive-risk-center',       i18nKey: 'predictive_risk_center',  icon: Radar,           requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      // Investigation Center — gated inside the page; analyst-level discovery.
      { to: '/investigation-center',         i18nKey: 'investigation_center',    icon: Search,          requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      // Regulatory Compliance Center — gated inside the page; analyst-level discovery.
      { to: '/regulatory-compliance-center', i18nKey: 'regulatory_compliance_center', icon: Gavel,      requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      // Data Fabric Center — gated inside the page; analyst-level discovery.
      { to: '/data-fabric-center',           i18nKey: 'data_fabric_center',      icon: Cable,           requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      // Enterprise Demo Foundation — gated inside the page; analyst-level discovery.
      { to: '/enterprise-demo-center',       i18nKey: 'enterprise_demo_center',  icon: Sparkles,        requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      // Demo Readiness Center — gated inside the page; analyst-level discovery.
      { to: '/demo-readiness-center',        i18nKey: 'demo_readiness_center',   icon: ClipboardCheck,  requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      // Digital Twin Risk Simulation Center — Phase 17 overlay.
      { to: '/digital-twin-center',          i18nKey: 'digital_twin_center',     icon: Cpu,             requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      // Autonomous Risk Operations Center — AI agents (Phase 18 overlay).
      { to: '/autonomous-risk-center',       i18nKey: 'autonomous_risk_center',  icon: Bot,             requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      // Advanced AI Decisioning Center — Phase 19 orchestration overlay.
      { to: '/ai-decisioning-center', i18nKey: 'ai_decisioning_center', icon: BrainCircuit, requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      // Enterprise Integration Marketplace — Phase 20 overlay.
      { to: '/integration-marketplace', i18nKey: 'integration_marketplace', icon: Plug, requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      // Board Reporting & Board Packs Center — Phase 21 overlay.
      { to: '/board-reporting-center', i18nKey: 'board_reporting_center', icon: FileBarChart, requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      // Real-Time Event Streaming Center — Phase 22 overlay.
      { to: '/event-streaming-center', i18nKey: 'event_streaming_center', icon: Activity, requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      // Production Operations Center — Phase 23 overlay.
      { to: '/operations-center', i18nKey: 'operations_center', icon: Cog, requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      // Risk Intelligence Hub — live risk signals, high-risk customer watch, case intelligence.
      { to: '/risk-intelligence', i18nKey: 'risk_intelligence', icon: Brain, requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      { to: '/alerts',                       i18nKey: 'alerts',                  icon: Bell,           featured: true },
      { to: '/cms/cases',                    i18nKey: 'cms_cases',               icon: Briefcase,      featured: true },
      { to: '/cms/workflow',                 i18nKey: 'case_workflow',           icon: GitBranch,      requireRole: ['admin', 'supervisor', 'risk_analyst', 'case_owner'], featured: true },
      { to: '/reports',                      i18nKey: 'reports',                 icon: FileBarChart,   featured: true },
      // Action Center extras
      { to: '/reports/builder',              i18nKey: 'report_builder',          icon: FileBarChart,   requireRole: ['admin', 'supervisor', 'risk_analyst'] },
      { to: '/analytics',                    i18nKey: 'analytics',               icon: FileBarChart,   requireRole: ['admin', 'supervisor', 'risk_analyst'] },
      { to: '/scenario',                     i18nKey: 'scenario',                icon: FlaskConical },
      { to: '/admin/case-scenarios',         i18nKey: 'case_scenarios',          icon: Zap,            requireRole: ['admin', 'supervisor'] },
      { to: '/admin/notification-dispatches', i18nKey: 'notification_dispatches', icon: Send,           requireRole: ['admin', 'supervisor'] },
      // recovery_analytics moved into the unified Recovery Center (see admin group below).
    ],
  },

  // ────────────────────────────────────────────────────────────────────
  // 4. AI WORKBENCH
  // ────────────────────────────────────────────────────────────────────
  {
    id: 'ai-workbench',
    i18nKey: 'cat_ai_workbench',
    icon: Bot,
    items: [
      { to: '/ai/workbench',                 i18nKey: 'ai_workbench',     icon: Bot,        requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      // Explainability moved under AI Workbench (brief: "Move Explainability under
      // AI Workbench"). Legacy /ai/explainability still resolves (App.tsx untouched).
      { to: '/ai/workbench/explainability',  i18nKey: 'explainability',   icon: Microscope, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'], featured: true },
      { to: '/ai/registry',                  i18nKey: 'model_registry',   icon: Boxes,      requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      { to: '/ai/experiments',               i18nKey: 'experiment_tracking', icon: FlaskConical, requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      { to: '/ai/drift',                     i18nKey: 'drift_detection',  icon: Activity,   requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      { to: '/ai/insights',                  i18nKey: 'ai_insights',      icon: BrainCircuit, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'], featured: true },
      // Feature store underpins every model — surface here as the supporting tool
      { to: '/admin/feature-store',          i18nKey: 'feature_store',    icon: Database,   requireRole: ['admin', 'supervisor', 'risk_analyst'] },
      // ── Enterprise AI Governance Layer (additive) ──────────────
      // Composes M7.x model registry + performance + drift +
      // promotions + M15.1 audit into a single MRM-tier governance
      // tree. Every legacy /ai/* URL still works.
      { to: '/ai/governance',                i18nKey: 'ai_governance',                icon: ShieldCheck,  requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
    ],
  },

  // ────────────────────────────────────────────────────────────────────
  // 5. CONFIGURATION
  // ────────────────────────────────────────────────────────────────────
  {
    id: 'configuration',
    i18nKey: 'cat_configuration',
    icon: Cog,
    items: [
      { to: '/admin/master-setup',         i18nKey: 'master_setup',         icon: Library,             requireRole: ['admin'], featured: true },
      // ── Enterprise Governance Center (additive) ───────────────
      // Layers 11 governance sections over the existing Master Setup
      // + Tenant + Branch + RBAC + IAM surface. Every legacy URL still
      // resolves — this is purely additive navigation.
      { to: '/admin/governance',                  i18nKey: 'governance_center',                 icon: Settings2,    requireRole: ['admin', 'supervisor'], featured: true },
      // Phase 9 T11 — reusable master entity CRUD framework
      // Enterprise Permission Matrix (049 overlay) — role × module × action editor
      // Tenant Governance (051 overlay) — branch registry + compliance rules
      { to: '/admin/risk-score-config',    i18nKey: 'risk_score_config',    icon: Scale,               requireRole: ['admin'], featured: true },
      { to: '/admin/alert-classification', i18nKey: 'alert_classification', icon: ShieldAlert,         requireRole: ['admin'], featured: true },
      { to: '/admin/case-types',           i18nKey: 'case_type_setup',      icon: Briefcase,           requireRole: ['admin'], featured: true },
      { to: '/admin/job-scheduler',        i18nKey: 'job_scheduler',        icon: PlayCircle,          requireRole: ['admin'], featured: true },
      { to: '/admin/access-control',       i18nKey: 'access_control',       icon: Key,                 requireRole: ['admin'], featured: true },
      // ── Unified Rule Center (additive) ───────────────────────────
      // Single entry-point that consolidates the 4 previously-
      // scattered rule surfaces (rules_engine / rules / ews_rules /
      // rule_reports). The legacy URLs still resolve to the same
      // pages — see web/src/App.tsx — so bookmarks + tests keep
      // working. Sidebar exposes only the /rule-center/* hierarchy.
      { to: '/rule-center',                i18nKey: 'rule_center',                  icon: Cog,           requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      { to: '/admin/thresholds-limits',    i18nKey: 'thresholds_limits',    icon: Gauge,               requireRole: ['admin'], featured: true },
      { to: '/admin/workflows',            i18nKey: 'workflows',            icon: Workflow,            requireRole: ['admin'], featured: true },
      // Integration plumbing
      { to: '/admin/integrations',         i18nKey: 'integrations',         icon: Plug,                requireRole: ['admin', 'supervisor'] },
      { to: '/admin/webhooks',             i18nKey: 'webhooks',             icon: Webhook,             requireRole: ['admin'] },
    ],
  },

  // ────────────────────────────────────────────────────────────────────
  // 6. ADMIN
  // ────────────────────────────────────────────────────────────────────
  {
    id: 'admin',
    i18nKey: 'cat_admin',
    icon: ShieldCheck,
    items: [
      { to: '/admin/users',                i18nKey: 'users',                 icon: UsersRound, requireRole: ['admin'], featured: true },
      // ── Security Activity Center (additive) ────────────────────
      // Layered security-monitoring view over the existing Admin Activity /
      // Audit Trail / IAM / Sessions surface. Adds risk scoring + dashboard
      // KPI strip + 11-section index. Every legacy URL still resolves.
      { to: '/admin/security',                  i18nKey: 'security_center',               icon: ShieldCheck, requireRole: ['admin', 'supervisor'], featured: true },
      // ── Enterprise IAM Center (additive) ───────────────────────
      // Layered IAM tree: 6 sub-sections over the existing User /
      // Session / RBAC / DBAC / Tenant surface. Legacy /admin/users +
      // /admin/users/new + /admin/sessions URLs still resolve.
      { to: '/admin/iam',                       i18nKey: 'iam_center',                    icon: UserCog,     requireRole: ['admin', 'supervisor'], featured: true },
      // ── Unified Audit Center (additive) ────────────────────────
      // Single entry-point that consolidates 4 previously-scattered
      // audit surfaces (audit_trail / audit_log / admin_activity /
      // admin_sessions) + 2 new landings (export + compliance).
      // The legacy /admin/audit-* + /admin/activity + /admin/sessions
      // URLs still resolve — see web/src/App.tsx.
      { to: '/audit-center',                   i18nKey: 'audit_center',                 icon: Shield,      requireRole: ['admin', 'supervisor'], featured: true },
      { to: '/admin/testing-hub',          i18nKey: 'testing_hub',           icon: Beaker,     requireRole: ['admin'], featured: true },
      { to: '/glossary',                   i18nKey: 'glossary',              icon: BookOpen,   featured: true },
      // Admin extras
      { to: '/admin/tenants',              i18nKey: 'tenants',               icon: Building2, requireRole: ['admin'] },
      { to: '/admin/service-clients',      i18nKey: 'service_clients',       icon: Key,       requireRole: ['admin'] },
      { to: '/admin/user-access-override', i18nKey: 'user_access_override',  icon: ShieldCheck, requireRole: ['admin', 'supervisor'] },
      { to: '/admin/escalation-worker',    i18nKey: 'escalation_worker',     icon: PlayCircle, requireRole: ['admin', 'supervisor'] },
      // ── Unified Recovery Center (additive) ─────────────────────
      // Consolidates recycle_bin + recovery_analytics into one tree
      // with 4 intent-focused sub-sections. /admin/recycle-bin +
      // /admin/recovery-analytics still resolve to the same pages.
      { to: '/recovery-center',                i18nKey: 'recovery_center',              icon: Archive,     requireRole: ['admin'], featured: true },
      // Enterprise Recovery Management Center — additive overlay (4 net-new pages)
    ],
  },
];

/** Returns the union of every route surfaced via NAV_GROUPS + NAV_HOME. */
export function listAllNavRoutes(): string[] {
  const out: string[] = [NAV_HOME.to];
  for (const group of NAV_GROUPS) {
    for (const leaf of group.items) out.push(leaf.to);
  }
  return out;
}

/** Filter a group's items by the viewer's roles. Empty array when role-gated out. */
export function visibleItems(
  group: NavGroup,
  userRoles: ReadonlyArray<string> | undefined,
): NavLeaf[] {
  return group.items.filter(
    (item) => !item.requireRole || item.requireRole.some((r) => userRoles?.includes(r)),
  );
}
