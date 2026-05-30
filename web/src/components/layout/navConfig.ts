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
  Smartphone,
  ScrollText,
  History,
  Webhook,
  Building2,
  Key,
  Mail,
  ArrowUpFromLine,
  Zap,
  Send,
  PlayCircle,
  Trash2,
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
  Wand2,
  GitCompare,
  KeyRound,
  FileBadge,
  Undo2,
  Download,
  Archive,
  Beaker,
  BookOpen,
  Umbrella,
  TrendingDown,
  HandCoins,
  Scale,
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
      { to: '/ai/workbench',       i18nKey: 'ai_workbench',     icon: Bot,        requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      { to: '/ai/registry',        i18nKey: 'model_registry',   icon: Boxes,      requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      { to: '/ai/explainability',  i18nKey: 'explainability',   icon: Microscope, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'], featured: true },
      { to: '/ai/experiments',     i18nKey: 'experiment_tracking', icon: FlaskConical, requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      { to: '/ai/drift',           i18nKey: 'drift_detection',  icon: Activity,   requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      { to: '/ai/insights',        i18nKey: 'ai_insights',      icon: BrainCircuit, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'], featured: true },
      // Feature store underpins every model — surface here as the supporting tool
      { to: '/admin/feature-store', i18nKey: 'feature_store',   icon: Database,   requireRole: ['admin', 'supervisor', 'risk_analyst'] },
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
      // Phase 9 T11 — reusable master entity CRUD framework
      { to: '/admin/masters',              i18nKey: 'master_data',          icon: Library,             requireRole: ['admin'] },
      // Enterprise Permission Matrix (049 overlay) — role × module × action editor
      { to: '/admin/permission-matrix',    i18nKey: 'permission_matrix',    icon: ShieldCheck,         requireRole: ['admin'] },
      // Tenant Governance (051 overlay) — branch registry + compliance rules
      { to: '/admin/governance/branches',           i18nKey: 'branches',           icon: Building2,    requireRole: ['admin'] },
      { to: '/admin/governance/compliance-rules',   i18nKey: 'compliance_rules',   icon: ScrollText,   requireRole: ['admin'] },
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
      { to: '/rule-center/builder',        i18nKey: 'rule_center_builder',          icon: Wand2,         requireRole: ['admin', 'supervisor', 'risk_analyst'] },
      { to: '/rule-center/library',        i18nKey: 'rule_center_library',          icon: Library,       requireRole: ['admin', 'supervisor', 'risk_analyst'] },
      { to: '/rule-center/testing',        i18nKey: 'rule_center_testing',          icon: FlaskConical,  requireRole: ['admin', 'supervisor', 'risk_analyst'] },
      { to: '/rule-center/reports',        i18nKey: 'rule_center_reports',          icon: FileBarChart,  requireRole: ['admin', 'supervisor', 'risk_analyst'] },
      { to: '/rule-center/history',        i18nKey: 'rule_center_history',          icon: History,       requireRole: ['admin', 'supervisor', 'risk_analyst'] },
      { to: '/rule-center/comparison',     i18nKey: 'rule_center_comparison',       icon: GitCompare,    requireRole: ['admin', 'supervisor', 'risk_analyst'] },
      { to: '/admin/thresholds-limits',    i18nKey: 'thresholds_limits',    icon: Gauge,               requireRole: ['admin'], featured: true },
      { to: '/admin/workflows',            i18nKey: 'workflows',            icon: Workflow,            requireRole: ['admin'], featured: true },
      // Integration plumbing
      { to: '/admin/integrations',         i18nKey: 'integrations',         icon: Plug,                requireRole: ['admin', 'supervisor'] },
      { to: '/admin/webhooks',             i18nKey: 'webhooks',             icon: Webhook,             requireRole: ['admin'] },
      { to: '/admin/sla-config',           i18nKey: 'sla_config',           icon: ScrollText,          requireRole: ['admin', 'supervisor'] },
      { to: '/admin/notification-templates', i18nKey: 'notification_templates', icon: Mail,            requireRole: ['admin', 'supervisor'] },
      { to: '/admin/escalation-matrix',    i18nKey: 'escalation_matrix',    icon: ArrowUpFromLine,     requireRole: ['admin', 'supervisor'] },
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
      // ── Unified Audit Center (additive) ────────────────────────
      // Single entry-point that consolidates 4 previously-scattered
      // audit surfaces (audit_trail / audit_log / admin_activity /
      // admin_sessions) + 2 new landings (export + compliance).
      // The legacy /admin/audit-* + /admin/activity + /admin/sessions
      // URLs still resolve — see web/src/App.tsx.
      { to: '/audit-center',                   i18nKey: 'audit_center',                 icon: Shield,      requireRole: ['admin', 'supervisor'], featured: true },
      { to: '/audit-center/trail',             i18nKey: 'audit_center_trail',           icon: Shield,      requireRole: ['admin', 'supervisor'] },
      { to: '/audit-center/login-audit',       i18nKey: 'audit_center_login_audit',     icon: KeyRound,    requireRole: ['admin'] },
      { to: '/audit-center/activity',          i18nKey: 'audit_center_activity',        icon: ScrollText,  requireRole: ['admin', 'supervisor'] },
      { to: '/audit-center/export',            i18nKey: 'audit_center_export',          icon: Download,    requireRole: ['admin', 'supervisor'] },
      { to: '/audit-center/compliance',        i18nKey: 'audit_center_compliance',      icon: FileBadge,   requireRole: ['admin', 'supervisor'] },
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
      { to: '/recovery-center/deleted',        i18nKey: 'recovery_center_deleted',      icon: Trash2,      requireRole: ['admin'] },
      { to: '/recovery-center/restore',        i18nKey: 'recovery_center_restore',      icon: Undo2,       requireRole: ['admin'] },
      { to: '/recovery-center/permanent-delete', i18nKey: 'recovery_center_permanent_delete', icon: ShieldAlert, requireRole: ['admin'] },
      { to: '/recovery-center/analytics',      i18nKey: 'recovery_center_analytics',    icon: BarChart3,   requireRole: ['admin'] },
      { to: '/profile/sessions',           i18nKey: 'my_sessions',           icon: Smartphone },
      { to: '/profile/activity',           i18nKey: 'my_activity',           icon: History },
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
