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
  Library,
  Cog,
  Workflow,
  Beaker,
  BookOpen,
  Umbrella,
  TrendingDown,
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
    items: [
      { to: '/borrower-watch',         i18nKey: 'borrower_watch',     icon: TrendingUp,   featured: true },
      { to: '/account-behaviour',      i18nKey: 'account_behaviour',  icon: Activity,     featured: true },
      { to: '/financial-ratios',       i18nKey: 'financial_ratios',   icon: Sigma,        featured: true },
      { to: '/banking/sma',            i18nKey: 'sma_classification', icon: TrendingUp,   requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      { to: '/banking/npa-prediction', i18nKey: 'npa_prediction',     icon: BrainCircuit, requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      { to: '/fraud-signals',          i18nKey: 'fraud_signals',      icon: ShieldAlert,  featured: true },
      { to: '/banking/sectors',        i18nKey: 'sector_watch',       icon: BarChart3,    requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
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
    items: [
      { to: '/insurance/policy-lapse', i18nKey: 'insurance_policy_lapse', icon: TrendingDown, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'], featured: true },
      { to: '/insurance/claims-anomaly', i18nKey: 'insurance_claims_anomaly', icon: ShieldAlert, requireRole: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'], featured: true },
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
      { to: '/admin/recovery-analytics',     i18nKey: 'recovery_analytics',      icon: BarChart3,      requireRole: ['admin'] },
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
      { to: '/rules/engine',               i18nKey: 'rules_engine',         icon: Cog,                 requireRole: ['admin', 'supervisor', 'risk_analyst'], featured: true },
      { to: '/admin/thresholds-limits',    i18nKey: 'thresholds_limits',    icon: Gauge,               requireRole: ['admin'], featured: true },
      { to: '/admin/workflows',            i18nKey: 'workflows',            icon: Workflow,            requireRole: ['admin'], featured: true },
      // Rules surfaces — Rules library + EWS DSL builder live here too
      { to: '/rules',                      i18nKey: 'rules',                icon: SlidersHorizontal },
      { to: '/rules/ews',                  i18nKey: 'ews_rules',            icon: SlidersHorizontal },
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
      { to: '/admin/audit-trail',          i18nKey: 'audit_trail',           icon: Shield,     requireRole: ['admin', 'supervisor'], featured: true },
      { to: '/admin/testing-hub',          i18nKey: 'testing_hub',           icon: Beaker,     requireRole: ['admin'], featured: true },
      { to: '/glossary',                   i18nKey: 'glossary',              icon: BookOpen,   featured: true },
      // Admin extras
      { to: '/admin/tenants',              i18nKey: 'tenants',               icon: Building2, requireRole: ['admin'] },
      { to: '/admin/service-clients',      i18nKey: 'service_clients',       icon: Key,       requireRole: ['admin'] },
      { to: '/admin/user-access-override', i18nKey: 'user_access_override',  icon: ShieldCheck, requireRole: ['admin', 'supervisor'] },
      { to: '/admin/audit-log',            i18nKey: 'audit_log',             icon: ScrollText, requireRole: ['admin', 'supervisor'] },
      { to: '/admin/activity',             i18nKey: 'admin_activity',        icon: ScrollText, requireRole: ['admin', 'supervisor'] },
      { to: '/admin/escalation-worker',    i18nKey: 'escalation_worker',     icon: PlayCircle, requireRole: ['admin', 'supervisor'] },
      { to: '/admin/recycle-bin',          i18nKey: 'recycle_bin',           icon: Trash2,     requireRole: ['admin'] },
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
