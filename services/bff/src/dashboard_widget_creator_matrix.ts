// services/bff/src/dashboard_widget_creator_matrix.ts
//
// T6 M11.17 — Dashboard widget × creator cross-tab matrix.
//
// M11.11 ships widget usage analytics (per-widget rollup). M11.15
// ships per-creator authorship rollup. M11.16 ships config-key
// cross-reference. M11.17 lands the proper 2D cross-tab combining
// the two open-axis-vs-closed-axis dimensions: rows = creators (open
// set, sorted by total_widgets desc + username asc tie-break) × cols
// = 7 canonical WidgetType (closed enum from M11.7 catalog).
//
// Each widget instance on a dashboard contributes 1 to the
// (creator, widget_type) cell. A creator with 3 dashboards × 4
// widgets each = 12 cell contributions (distributed across widget
// types).
//
// Mirror of M1.11 (api key creator × lifecycle) / M14.28 / M12.14 /
// M3.14 / M15.14 / M8.14 matrix pattern for the dashboards surface.
//
// Drives BIL ops "which user gravitates to which widget?" — useful
// for templating ("alice loves risk_score_histogram + tenant_kpi —
// suggest those to new analysts").
//
// Pure resolver — caller passes drained dashboard list.

import {
  WIDGET_TYPES,
  WIDGET_CATALOG,
  type CustomDashboard,
  type WidgetType,
} from './custom_dashboards';

// ─── Public types ──────────────────────────────────────────────────────

export interface DashboardWidgetCreatorRow {
  created_by: string;
  total_widgets: number;
  total_dashboards: number;
  /** Per-widget_type counts; every WidgetType key at 0 when absent. */
  by_widget_type: Record<WidgetType, number>;
  /** Widget types this creator hasn't used (canonical order). */
  widget_types_without: WidgetType[];
  /** Distinct widget types used (1..7). */
  distinct_widget_types: number;
  /** Newest updated_at across this creator's dashboards; null when none. */
  most_recent_at: string | null;
}

export interface DashboardWidgetCreatorColumn {
  widget_type: WidgetType;
  display_name: string;
  total_instances: number;
  /** Per-creator counts: array of {created_by, count} sorted desc
   *  + username asc tie-break, cap 10. */
  top_creators: Array<{ created_by: string; count: number }>;
  distinct_creators: number;
}

export interface DashboardWidgetCreatorMatrix {
  tenant_id: string;
  generated_at: string;
  total_dashboards: number;
  total_creators: number;
  total_widgets: number;
  total_widget_types: number;
  rows: DashboardWidgetCreatorRow[];
  columns: DashboardWidgetCreatorColumn[];
  /** Highest count cell; iteration is rows in total_widgets-desc order
   *  × cols in canonical WidgetType order; null when empty. */
  peak_cell: {
    created_by: string;
    widget_type: WidgetType;
    count: number;
  } | null;
  /** Creator with the most distinct widget_types used (most versatile). */
  most_versatile_creator: string | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByWidgetType(): Record<WidgetType, number> {
  const out = {} as Record<WidgetType, number>;
  for (const w of WIDGET_TYPES) out[w] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildDashboardWidgetCreatorMatrix(
  tenant_id: string,
  dashboards: readonly CustomDashboard[],
  now: Date,
): DashboardWidgetCreatorMatrix {
  type Bucket = {
    total_widgets: number;
    total_dashboards: number;
    by_widget_type: Record<WidgetType, number>;
    most_recent_at: string | null;
  };
  const buckets = new Map<string, Bucket>();

  const colTotals = emptyByWidgetType();
  const colCreators: Record<WidgetType, Map<string, number>> = {} as never;
  for (const w of WIDGET_TYPES) colCreators[w] = new Map<string, number>();

  let total_widgets = 0;

  for (const d of dashboards) {
    if (!d.created_by) continue;
    let b = buckets.get(d.created_by);
    if (!b) {
      b = {
        total_widgets: 0,
        total_dashboards: 0,
        by_widget_type: emptyByWidgetType(),
        most_recent_at: null,
      };
      buckets.set(d.created_by, b);
    }
    b.total_dashboards++;
    const updated = d.updated_at ?? d.created_at;
    if (updated && (!b.most_recent_at || updated > b.most_recent_at)) {
      b.most_recent_at = updated;
    }
    for (const w of d.widgets) {
      if (!(WIDGET_TYPES as readonly string[]).includes(w.widget_type)) continue;
      const wt = w.widget_type as WidgetType;
      b.total_widgets++;
      total_widgets++;
      b.by_widget_type[wt]++;
      colTotals[wt]++;
      colCreators[wt].set(
        d.created_by,
        (colCreators[wt].get(d.created_by) ?? 0) + 1,
      );
    }
  }

  // Rows — sort by total_widgets desc + created_by asc tie-break.
  const rows: DashboardWidgetCreatorRow[] = [...buckets.entries()]
    .map(([created_by, b]) => {
      const widget_types_without = WIDGET_TYPES.filter(
        (w) => b.by_widget_type[w] === 0,
      );
      const distinct_widget_types = WIDGET_TYPES.length - widget_types_without.length;
      return {
        created_by,
        total_widgets: b.total_widgets,
        total_dashboards: b.total_dashboards,
        by_widget_type: { ...b.by_widget_type },
        widget_types_without,
        distinct_widget_types,
        most_recent_at: b.most_recent_at,
      };
    })
    .sort((a, b) => {
      if (b.total_widgets !== a.total_widgets) {
        return b.total_widgets - a.total_widgets;
      }
      return a.created_by.localeCompare(b.created_by);
    });

  // Columns — every widget_type in canonical order.
  const columns: DashboardWidgetCreatorColumn[] = WIDGET_TYPES.map((w) => {
    const map = colCreators[w];
    const top = [...map.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, 10)
      .map(([created_by, count]) => ({ created_by, count }));
    return {
      widget_type: w,
      display_name: WIDGET_CATALOG[w].display_name,
      total_instances: colTotals[w],
      top_creators: top,
      distinct_creators: map.size,
    };
  });

  // peak_cell — highest cell count across the matrix.
  let peak_cell:
    | { created_by: string; widget_type: WidgetType; count: number }
    | null = null;
  let peakCount = 0;
  for (const row of rows) {
    for (const w of WIDGET_TYPES) {
      const c = row.by_widget_type[w];
      if (c > peakCount) {
        peakCount = c;
        peak_cell = { created_by: row.created_by, widget_type: w, count: c };
      }
    }
  }

  // most_versatile_creator — highest distinct_widget_types + username asc tie-break.
  let most_versatile_creator: string | null = null;
  let maxDistinct = 0;
  const sortedByVersatility = [...rows].sort((a, b) => {
    if (b.distinct_widget_types !== a.distinct_widget_types) {
      return b.distinct_widget_types - a.distinct_widget_types;
    }
    return a.created_by.localeCompare(b.created_by);
  });
  if (sortedByVersatility.length > 0 && sortedByVersatility[0].distinct_widget_types > 0) {
    most_versatile_creator = sortedByVersatility[0].created_by;
    maxDistinct = sortedByVersatility[0].distinct_widget_types;
  }
  void maxDistinct;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_dashboards: dashboards.filter((d) => !!d.created_by).length,
    total_creators: rows.length,
    total_widgets,
    total_widget_types: WIDGET_TYPES.length,
    rows,
    columns,
    peak_cell,
    most_versatile_creator,
  };
}
