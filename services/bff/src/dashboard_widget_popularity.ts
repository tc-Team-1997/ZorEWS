// services/bff/src/dashboard_widget_popularity.ts
//
// T6 M11.20 — Dashboard widget popularity ranking.
//
// Per-tenant popularity view across saved custom dashboards — counts
// each widget_type occurrence across all dashboards and ranks them by
// instance_count. Answers "which widgets are the most popular? which
// are underutilised (potential deprecation candidates)?"
//
// Distinct from:
//   M11.11 — widget usage analytics (same but per-usage per dashboard-count
//             + total instances; M11.20 adds ranking, pct, and bottom_widget)
//   M11.17 — widget × creator matrix (2D cross-tab)
//   M11.19 — widget-count histogram (bucketing by content density)
//
// Pure function + route. No new store or AppDeps slot needed.

import { WIDGET_CATALOG, WIDGET_TYPES, type CustomDashboardStore, type WidgetType } from './custom_dashboards';

// ─── Public types ─────────────────────────────────────────────────────

export interface WidgetPopularityRow {
  rank: number;
  widget_type: string;
  display_name: string;
  /** Total widget instances across all dashboards. */
  instance_count: number;
  /** Number of dashboards containing at least one widget of this type. */
  dashboard_count: number;
  /** instance_count / total_widget_instances (0–1). 0 when no instances. */
  pct_of_instances: number;
  /** dashboard_count / total_dashboards (0–1). 0 when no dashboards. */
  pct_of_dashboards: number;
}

export interface WidgetPopularityReport {
  tenant_id: string;
  generated_at: string;
  total_dashboards: number;
  total_widget_instances: number;
  /** Rankings sorted by instance_count desc + widget_type asc tie-break.
   *  EVERY widget_type in WIDGET_CATALOG is emitted (0-count types
   *  appear at the bottom for stable SPA grid rendering). */
  rankings: WidgetPopularityRow[];
  /** Highest-ranked widget (most instances). null when no instances. */
  top_widget: { widget_type: string; instance_count: number } | null;
  /** Least used widget AMONG USED widgets (>0 instances). null when no instances. */
  bottom_widget: { widget_type: string; instance_count: number } | null;
  /** Widget types with 0 instances across all dashboards. */
  unused_widget_types: string[];
}

// ─── Pure function ────────────────────────────────────────────────────

export function buildWidgetPopularityRanking(
  tenant_id: string,
  dashboards: import('./custom_dashboards').CustomDashboard[],
  now: Date,
): WidgetPopularityReport {
  if (!tenant_id) throw new Error('tenant_id is required');

  const total_dashboards = dashboards.length;

  // Count instances per widget_type and distinct dashboards per type
  const instanceCount = new Map<string, number>();
  const dashboardCount = new Map<string, number>();

  for (const dash of dashboards) {
    const typesInThisDash = new Set<string>();
    for (const widget of dash.widgets) {
      instanceCount.set(widget.widget_type, (instanceCount.get(widget.widget_type) ?? 0) + 1);
      typesInThisDash.add(widget.widget_type);
    }
    for (const t of typesInThisDash) {
      dashboardCount.set(t, (dashboardCount.get(t) ?? 0) + 1);
    }
  }

  const total_widget_instances = Array.from(instanceCount.values()).reduce((s, v) => s + v, 0);

  // Build rows for all widget types (catalog is the closed enum)
  const unsortedRows: Omit<WidgetPopularityRow, 'rank'>[] = [];
  for (const wt of WIDGET_TYPES) {
    const count = instanceCount.get(wt) ?? 0;
    const dc = dashboardCount.get(wt) ?? 0;
    const entry = WIDGET_CATALOG[wt as WidgetType];
    unsortedRows.push({
      widget_type: wt,
      display_name: entry.display_name,
      instance_count: count,
      dashboard_count: dc,
      pct_of_instances: total_widget_instances > 0
        ? Math.round((count / total_widget_instances) * 10000) / 10000
        : 0,
      pct_of_dashboards: total_dashboards > 0
        ? Math.round((dc / total_dashboards) * 10000) / 10000
        : 0,
    });
  }

  // Sort by instance_count desc, widget_type asc tie-break
  unsortedRows.sort((a, b) => {
    if (b.instance_count !== a.instance_count) return b.instance_count - a.instance_count;
    return a.widget_type < b.widget_type ? -1 : a.widget_type > b.widget_type ? 1 : 0;
  });

  // Assign ranks (tied counts share the same rank)
  let currentRank = 1;
  const rankings: WidgetPopularityRow[] = [];
  for (let i = 0; i < unsortedRows.length; i++) {
    if (i > 0 && unsortedRows[i].instance_count < unsortedRows[i - 1].instance_count) {
      currentRank = i + 1;
    }
    rankings.push({ rank: currentRank, ...unsortedRows[i] });
  }

  // top_widget: first non-zero entry after sort (highest count)
  const usedRows = rankings.filter(r => r.instance_count > 0);
  const top_widget = usedRows.length > 0
    ? { widget_type: usedRows[0].widget_type, instance_count: usedRows[0].instance_count }
    : null;

  // bottom_widget: last non-zero entry (lowest count among used)
  const bottom_widget = usedRows.length > 0
    ? { widget_type: usedRows[usedRows.length - 1].widget_type, instance_count: usedRows[usedRows.length - 1].instance_count }
    : null;

  const unused_widget_types = rankings
    .filter(r => r.instance_count === 0)
    .map(r => r.widget_type);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_dashboards,
    total_widget_instances,
    rankings,
    top_widget,
    bottom_widget,
    unused_widget_types,
  };
}

// ─── Store adapter ────────────────────────────────────────────────────

export function buildWidgetPopularityRankingFromStore(
  store: CustomDashboardStore,
  tenant_id: string,
  now: Date,
): WidgetPopularityReport {
  const dashboards = store.list(tenant_id);
  return buildWidgetPopularityRanking(tenant_id, dashboards, now);
}
