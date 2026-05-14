// services/bff/src/dashboard_widget_usage.ts
//
// T6 M11.11 — Custom dashboard widget usage analytics.
//
// M11.7 ships the custom dashboard CRUD + WIDGET_CATALOG. M11.8 ships
// the resolver. M11.9 ships export/import bundle. M11.10 ships the
// linter. M11.11 is the orthogonal cross-cut over a tenant's saved
// dashboards: for each widget_type in the platform catalog, how
// many of THIS tenant's dashboards use it + total widget instances
// + per-dashboard breakdown. Helps a tenant admin spot:
//   - which platform widgets are popular in their layout library
//   - which platform widgets are completely unused (candidate for
//     a future cleanup or guided tour)
//   - which dashboards rely most heavily on a given widget_type
//
// Always emits a row for every WIDGET_TYPES entry (even at count=0)
// so the SPA can render a complete "catalog adoption" table without
// post-processing.

import {
  WIDGET_TYPES,
  WIDGET_CATALOG,
  type CustomDashboard,
  type WidgetType,
} from './custom_dashboards';

// ─── Public types ─────────────────────────────────────────────────────

export interface DashboardWidgetUsagePerDashboard {
  dashboard_id: string;
  name: string;
  count: number;
}

export interface DashboardWidgetUsageEntry {
  widget_type: WidgetType;
  display_name: string;
  /** Number of distinct dashboards using this widget_type. */
  dashboard_count: number;
  /** Total widget instances across all dashboards (a single dashboard
   *  can include the same widget_type multiple times). */
  total_instances: number;
  /** Per-dashboard breakdown sorted by count desc then name asc. */
  dashboards: DashboardWidgetUsagePerDashboard[];
}

export interface DashboardWidgetUsage {
  total_dashboards: number;
  total_widgets: number;
  /** One entry per WIDGET_TYPES, sorted by total_instances desc with
   *  widget_type asc tie-break. Unused widgets surface at count=0. */
  by_widget_type: DashboardWidgetUsageEntry[];
}

// ─── Pure aggregator ──────────────────────────────────────────────────

interface PerDashboardAcc {
  dashboard_id: string;
  name: string;
  count: number;
}

interface PerWidgetAcc {
  dashboard_count: number;
  total_instances: number;
  perDashboard: Map<string, PerDashboardAcc>;
}

export function analyseDashboardWidgetUsage(
  dashboards: readonly CustomDashboard[],
): DashboardWidgetUsage {
  const acc = new Map<WidgetType, PerWidgetAcc>();
  // Seed an empty accumulator for every catalog widget_type so unused
  // widgets surface as count=0 entries.
  for (const wt of WIDGET_TYPES) {
    acc.set(wt, {
      dashboard_count: 0,
      total_instances: 0,
      perDashboard: new Map<string, PerDashboardAcc>(),
    });
  }
  let totalWidgets = 0;
  for (const d of dashboards) {
    // Track per-dashboard counts in this pass and roll them up at
    // the end so dashboard_count is "distinct dashboards using it"
    // (a dashboard with 3 alerts_by_class widgets counts once).
    const localPerWidget = new Map<WidgetType, number>();
    for (const w of d.widgets) {
      const wAcc = acc.get(w.widget_type);
      if (!wAcc) continue; // defensive — widget_type not in catalog
      wAcc.total_instances += 1;
      totalWidgets += 1;
      localPerWidget.set(w.widget_type, (localPerWidget.get(w.widget_type) ?? 0) + 1);
    }
    for (const [wt, count] of localPerWidget) {
      const wAcc = acc.get(wt)!;
      wAcc.dashboard_count += 1;
      wAcc.perDashboard.set(d.dashboard_id, {
        dashboard_id: d.dashboard_id,
        name: d.name,
        count,
      });
    }
  }

  const by_widget_type: DashboardWidgetUsageEntry[] = [];
  for (const wt of WIDGET_TYPES) {
    const wAcc = acc.get(wt)!;
    const entry = WIDGET_CATALOG[wt];
    const dashList = [...wAcc.perDashboard.values()].sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    by_widget_type.push({
      widget_type: wt,
      display_name: entry.display_name,
      dashboard_count: wAcc.dashboard_count,
      total_instances: wAcc.total_instances,
      dashboards: dashList,
    });
  }
  by_widget_type.sort((a, b) => {
    if (b.total_instances !== a.total_instances) return b.total_instances - a.total_instances;
    return a.widget_type < b.widget_type ? -1 : a.widget_type > b.widget_type ? 1 : 0;
  });

  return {
    total_dashboards: dashboards.length,
    total_widgets: totalWidgets,
    by_widget_type,
  };
}
