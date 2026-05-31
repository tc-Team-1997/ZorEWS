// web/src/modules/dashboard/roleEngine/roleDashboardEngine.ts
//
// Pure resolver — turns (role, domain, country?, tenant?, branch?, prefs?)
// into the ordered widget list a user should see on /dashboards/role-based.
//
// Mirror of the M11 widgetResolver pattern but with 5-axis governance
// (role × domain × country × tenant × branch) and per-user pref overlay.
// No I/O — caller passes pre-fetched data. Production swap: prefs come
// from app_iam.dashboard_widget_preferences (migration 051).

import {
  WIDGET_REGISTRY,
  getWidget,
  type WidgetDef,
  type WidgetDomain,
  type WidgetRole,
} from './widgetRegistry';

export type DashboardDomain = WidgetDomain;

export interface DashboardContext {
  role: WidgetRole;
  domain: DashboardDomain;
  /** ISO country code (e.g. 'IN' / 'NP' / 'BT') OR null when caller is multi-country. */
  country: string | null;
  /** Tenant ID OR null when caller spans tenants (super_admin). */
  tenant_id: string | null;
  /** Branch slug OR null when caller spans branches. */
  branch_id: string | null;
}

export interface UserWidgetPreference {
  widget_id: string;
  /** Operator pinned this widget → forced to position 0..N regardless of default sort. */
  pinned: boolean;
  /** Operator hid this widget — engine drops it. */
  hidden: boolean;
  /** Operator-supplied sort position (lower = top). null falls back to default order. */
  sort_order: number | null;
}

export interface ResolvedDashboard {
  context: DashboardContext;
  /** Widget array in render order. */
  widgets: WidgetDef[];
  /** Per-widget governance flags so the SPA can render a small lock badge. */
  governance_locked: Record<string, boolean>;
  /** Widgets the registry knows about but the resolver chose to hide. */
  excluded: WidgetDef[];
  /** Reasons each excluded widget was hidden (role / domain / country / pref). */
  exclusion_reasons: Record<string, string>;
}

const SUPER_ROLES: readonly WidgetRole[] = ['super_admin'] as const;

function isSuperAdmin(role: WidgetRole): boolean {
  return SUPER_ROLES.includes(role);
}

function matchesDomain(widget: WidgetDef, domain: DashboardDomain): boolean {
  if (widget.default_domain === 'both') return true;
  return widget.default_domain === domain;
}

function matchesRole(widget: WidgetDef, role: WidgetRole): boolean {
  return widget.default_roles.includes(role);
}

/**
 * Pure resolver. Composes:
 *   1. Filter widgets the role + domain are entitled to see
 *   2. Layer per-user preferences (hide / pin / sort_order)
 *   3. Sort: pinned-first then sort_order then category then label
 *   4. Return both the rendered list AND the excluded list with reasons
 */
export function resolveDashboardWidgets(
  context: DashboardContext,
  preferences: readonly UserWidgetPreference[] = [],
  registry: readonly WidgetDef[] = WIDGET_REGISTRY,
): ResolvedDashboard {
  const prefByWidget = new Map(preferences.map((p) => [p.widget_id, p]));
  const included: WidgetDef[] = [];
  const excluded: WidgetDef[] = [];
  const exclusion_reasons: Record<string, string> = {};
  const governance_locked: Record<string, boolean> = {};

  for (const w of registry) {
    const pref = prefByWidget.get(w.id);

    // super_admin sees everything regardless of default_roles
    const roleOk = isSuperAdmin(context.role) || matchesRole(w, context.role);
    if (!roleOk) {
      excluded.push(w);
      exclusion_reasons[w.id] = `role ${context.role} not in default_roles`;
      continue;
    }

    // domain gate — banking-only widget never shown to insurance user (super_admin override)
    const domainOk = isSuperAdmin(context.role) || matchesDomain(w, context.domain);
    if (!domainOk) {
      excluded.push(w);
      exclusion_reasons[w.id] = `domain ${context.domain} doesn't match widget domain ${w.default_domain}`;
      continue;
    }

    // user hide preference overrides everything except pinned (pinned wins on conflict)
    if (pref?.hidden && !pref?.pinned) {
      excluded.push(w);
      exclusion_reasons[w.id] = 'hidden by user preference';
      continue;
    }

    included.push(w);
    governance_locked[w.id] = w.governance_controlled;
  }

  // Sort — pinned first (sort_order asc), then category iteration order, then label
  const categoryOrder = ['executive_kpi', 'governance', 'security', 'audit', 'banking', 'insurance', 'role_specialised', 'recovery', 'ai'];
  included.sort((a, b) => {
    const pa = prefByWidget.get(a.id);
    const pb = prefByWidget.get(b.id);
    if (pa?.pinned && !pb?.pinned) return -1;
    if (!pa?.pinned && pb?.pinned) return 1;
    if (pa?.pinned && pb?.pinned) {
      const aSort = pa.sort_order ?? 0;
      const bSort = pb.sort_order ?? 0;
      if (aSort !== bSort) return aSort - bSort;
    }
    if (pa?.sort_order != null && pb?.sort_order != null) {
      if (pa.sort_order !== pb.sort_order) return pa.sort_order - pb.sort_order;
    }
    const ca = categoryOrder.indexOf(a.category);
    const cb = categoryOrder.indexOf(b.category);
    if (ca !== cb) return ca - cb;
    return a.label.localeCompare(b.label);
  });

  return {
    context,
    widgets: included,
    governance_locked,
    excluded,
    exclusion_reasons,
  };
}

/**
 * Convenience helper that resolves AND validates each widget_id in a
 * preset (e.g. ROLE_PRESETS below) against the registry — drops unknown
 * ids defensively.
 */
export function resolvePresetWidgets(
  widget_ids: readonly string[],
  context: DashboardContext,
): WidgetDef[] {
  const out: WidgetDef[] = [];
  for (const id of widget_ids) {
    const w = getWidget(id);
    if (!w) continue;
    // Re-check role + domain so super-admin-only widgets don't leak via a preset
    const roleOk = isSuperAdmin(context.role) || matchesRole(w, context.role);
    const domainOk = isSuperAdmin(context.role) || matchesDomain(w, context.domain);
    if (roleOk && domainOk) out.push(w);
  }
  return out;
}

/**
 * Curated presets per the brief — these are the FALLBACK layouts when a
 * user has zero pinned preferences. Each role's list is the recommended
 * default ordering for that role's dashboard.
 */
export const ROLE_PRESETS: Record<WidgetRole, readonly string[]> = {
  super_admin: [
    'rs_platform_health', 'rs_active_users', 'rs_tenant_summary', 'rs_country_summary',
    'rs_governance_status', 'rs_security_alerts', 'rs_recovery_statistics',
    'rs_ai_model_status', 'rs_audit_activity', 'kpi_total_alerts', 'kpi_open_cases',
    'kpi_compliance_score',
  ],
  country_admin: [
    'rs_country_risk_overview', 'rs_country_users', 'rs_country_alerts',
    'rs_country_compliance', 'rs_country_performance', 'kpi_total_alerts',
    'kpi_compliance_score',
  ],
  bank_admin: [
    'rs_banking_portfolio', 'bw_sma_classification', 'bw_npa_prediction',
    'bw_fraud_signals', 'rs_branch_risk_ranking', 'rs_recovery_performance',
    'bw_branch_risk_heatmap', 'kpi_high_risk_customers', 'kpi_total_alerts',
  ],
  insurance_admin: [
    'iw_policy_lapse', 'iw_claims_anomaly', 'iw_fraud_detection',
    'iw_persistency_watch', 'iw_solvency_watch', 'iw_channel_risk',
    'iw_insurance_heatmap', 'kpi_total_alerts',
  ],
  risk_analyst: [
    'rs_high_risk_accounts', 'rs_active_alerts_list', 'rs_case_queue',
    'rs_risk_heatmaps', 'rs_ai_predictions', 'kpi_open_cases',
    'kpi_high_risk_customers',
  ],
  fraud_analyst: [
    'bw_fraud_signals', 'rs_fraud_investigation_queue', 'rs_high_risk_entities',
    'rs_network_analysis', 'rs_suspicious_activity', 'iw_fraud_detection',
    'kpi_fraud_exposure_kes',
  ],
  auditor: [
    'rs_audit_exceptions', 'rs_compliance_violations', 'rs_user_activity_feed',
    'rs_security_events', 'rs_recovery_actions_feed', 'kpi_compliance_score',
  ],
  executive: [
    'rs_enterprise_risk_score', 'rs_portfolio_health', 'rs_top_exposures',
    'rs_strategic_kpis', 'rs_executive_heatmap', 'rs_trend_analytics',
    'kpi_portfolio_risk_score', 'kpi_recovery_rate', 'kpi_ai_prediction_accuracy',
  ],
  admin: [],          // backend role — uses super_admin preset when active
  supervisor: [],     // backend role — falls through to default
  collection_officer: [], // backend role — falls through to default
  field_officer: [],  // backend role — falls through to default
};

/**
 * If preferences are empty AND the role has a curated preset → emit
 * the preset's widget order. Otherwise fall back to the standard
 * resolveDashboardWidgets ordering.
 */
export function resolveRoleDefaultDashboard(
  context: DashboardContext,
  preferences: readonly UserWidgetPreference[] = [],
): ResolvedDashboard {
  if (preferences.length === 0 && ROLE_PRESETS[context.role]?.length > 0) {
    const presetWidgets = resolvePresetWidgets(ROLE_PRESETS[context.role], context);
    const governance_locked: Record<string, boolean> = {};
    for (const w of presetWidgets) governance_locked[w.id] = w.governance_controlled;

    // Compute excluded as registry MINUS preset
    const presetIds = new Set(presetWidgets.map((w) => w.id));
    const excluded = WIDGET_REGISTRY.filter((w) => !presetIds.has(w.id));
    const exclusion_reasons: Record<string, string> = {};
    for (const w of excluded) exclusion_reasons[w.id] = 'not in role preset';

    return {
      context,
      widgets: presetWidgets,
      governance_locked,
      excluded,
      exclusion_reasons,
    };
  }
  return resolveDashboardWidgets(context, preferences);
}
