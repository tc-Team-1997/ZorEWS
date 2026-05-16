// services/bff/src/custom_dashboard_authorship.ts
//
// T6 M11.15 — Custom dashboard authorship rollup.
//
// M11.11 ships widget usage analytics (pivots by widget_type).
// M11.14 ships fleet lint summary (pivots by error severity).
// M11.15 ships the COMPLEMENTARY axis: pivot by `created_by`
// to answer "who built which dashboards?" — useful for access
// reviews + onboarding new ops members ("here's what Alice has
// built; assign one to Bob as a template").
//
// Mirror of M15.8 (audit per-actor activity) + M12.12 (report
// per-requester) for the dashboards surface.
//
// Pure rollup. Caller passes the loaded CustomDashboard[].

import type { CustomDashboard, WidgetType } from './custom_dashboards';

// ─── Public types ─────────────────────────────────────────────────────

export interface AuthorRow {
  created_by: string;
  dashboard_count: number;
  /** Σ widgets.length across all this author's dashboards. */
  total_widgets: number;
  /** Distinct widget_types this author has used (deduped across
   *  dashboards + within-dashboard duplicates). */
  distinct_widget_types: number;
  /** dashboard_ids contributed by this author. Sorted asc. */
  dashboard_ids: string[];
  /** Newest created_at across this author's dashboards. */
  most_recent_created_at: string;
  /** Newest updated_at across this author's dashboards. */
  most_recent_updated_at: string;
}

export interface DashboardAuthorshipSummary {
  tenant_id: string;
  generated_at: string;
  total_authors: number;
  total_dashboards: number;
  /** Σ widgets across the whole tenant's dashboards. */
  total_widgets_across_fleet: number;
  /** Authors sorted dashboard_count desc + created_by asc tie-break
   *  — most prolific first. */
  authors: AuthorRow[];
  /** Top row by dashboard_count (most prolific). null when no
   *  dashboards. */
  most_prolific_author: {
    created_by: string;
    dashboard_count: number;
  } | null;
  /** Author with the highest total_widgets count (heaviest grid).
   *  Tie-broken by created_by asc. null when no dashboards. */
  most_widgets_author: {
    created_by: string;
    total_widgets: number;
  } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

interface AuthorBuilder {
  created_by: string;
  dashboard_count: number;
  total_widgets: number;
  widget_types: Set<WidgetType>;
  dashboard_ids: string[];
  most_recent_created_at: string | null;
  most_recent_updated_at: string | null;
}

function newBuilder(created_by: string): AuthorBuilder {
  return {
    created_by,
    dashboard_count: 0,
    total_widgets: 0,
    widget_types: new Set(),
    dashboard_ids: [],
    most_recent_created_at: null,
    most_recent_updated_at: null,
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeDashboardAuthorship(
  tenant_id: string,
  dashboards: readonly CustomDashboard[],
  now: Date,
): DashboardAuthorshipSummary {
  const byAuthor = new Map<string, AuthorBuilder>();
  let total_widgets_across_fleet = 0;

  for (const d of dashboards) {
    let b = byAuthor.get(d.created_by);
    if (!b) {
      b = newBuilder(d.created_by);
      byAuthor.set(d.created_by, b);
    }
    b.dashboard_count++;
    b.total_widgets += d.widgets.length;
    b.dashboard_ids.push(d.dashboard_id);
    for (const w of d.widgets) b.widget_types.add(w.widget_type);
    if (!b.most_recent_created_at || d.created_at > b.most_recent_created_at) {
      b.most_recent_created_at = d.created_at;
    }
    if (!b.most_recent_updated_at || d.updated_at > b.most_recent_updated_at) {
      b.most_recent_updated_at = d.updated_at;
    }
    total_widgets_across_fleet += d.widgets.length;
  }

  // Finalise rows: sort dashboard_ids asc + materialise distinct count.
  const authors: AuthorRow[] = [...byAuthor.values()].map((b) => ({
    created_by: b.created_by,
    dashboard_count: b.dashboard_count,
    total_widgets: b.total_widgets,
    distinct_widget_types: b.widget_types.size,
    dashboard_ids: [...b.dashboard_ids].sort(),
    most_recent_created_at: b.most_recent_created_at!,
    most_recent_updated_at: b.most_recent_updated_at!,
  }));

  authors.sort((a, b) => {
    if (b.dashboard_count !== a.dashboard_count) return b.dashboard_count - a.dashboard_count;
    return a.created_by.localeCompare(b.created_by);
  });

  const most_prolific_author = authors.length > 0
    ? {
        created_by: authors[0]!.created_by,
        dashboard_count: authors[0]!.dashboard_count,
      }
    : null;

  // most_widgets_author: highest total_widgets with created_by asc
  // tie-break. Iterate authors[] (already sorted by dashboard_count;
  // need a separate scan for total_widgets).
  let most_widgets_author: DashboardAuthorshipSummary['most_widgets_author'] = null;
  let mostWidgets = 0;
  // First pass: find max total_widgets.
  for (const row of authors) {
    if (row.total_widgets > mostWidgets) mostWidgets = row.total_widgets;
  }
  if (mostWidgets > 0) {
    // Second pass: pick the row with max total_widgets + asc tie-break.
    const candidates = authors
      .filter((r) => r.total_widgets === mostWidgets)
      .sort((a, b) => a.created_by.localeCompare(b.created_by));
    most_widgets_author = {
      created_by: candidates[0]!.created_by,
      total_widgets: mostWidgets,
    };
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_authors: authors.length,
    total_dashboards: dashboards.length,
    total_widgets_across_fleet,
    authors,
    most_prolific_author,
    most_widgets_author,
  };
}
