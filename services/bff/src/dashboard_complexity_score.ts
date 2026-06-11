// services/bff/src/dashboard_complexity_score.ts
//
// T6 M11.21 — Dashboard layout complexity score.
//
// For each saved custom dashboard, computes a complexity_score that
// captures widget density, row span depth, and widget-type variety.
// Ops can use this to identify dashboards that may be slow to render
// or hard to maintain.

import type { CustomDashboard } from './custom_dashboards';

// ─── Public types ──────────────────────────────────────────────────────

export type ComplexityTier = 'simple' | 'moderate' | 'complex';

export interface DashboardComplexityRow {
  dashboard_id: string;
  name: string;
  widget_count: number;
  distinct_widget_types: number;
  max_row_span: number;
  complexity_score: number;
  tier: ComplexityTier;
}

export interface DashboardComplexityScores {
  tenant_id: string;
  generated_at: string;
  total_dashboards: number;
  /** Sorted complexity_score desc. */
  scores: DashboardComplexityRow[];
  most_complex: { dashboard_id: string; name: string; complexity_score: number } | null;
  avg_complexity: number;
  tier_distribution: { simple: number; moderate: number; complex: number };
}

// ─── Pure function ─────────────────────────────────────────────────────

function computeTier(score: number): ComplexityTier {
  if (score < 30) return 'simple';
  if (score <= 70) return 'moderate';
  return 'complex';
}

/**
 * buildDashboardComplexityScores
 *
 * @param tenant_id   caller's tenant
 * @param dashboards  CustomDashboard[] from customDashboardStore.list
 * @param now         current Date
 */
export function buildDashboardComplexityScores(
  tenant_id: string,
  dashboards: readonly CustomDashboard[],
  now: Date,
): DashboardComplexityScores {
  const rows: DashboardComplexityRow[] = [];

  for (const d of dashboards) {
    if (d.tenant_id !== tenant_id) continue;

    const widget_count = d.widgets.length;
    const distinctTypes = new Set(d.widgets.map((w) => w.widget_type)).size;

    let max_row_span = 0;
    for (const w of d.widgets) {
      const rowSpan = (w.position?.row ?? 0) + (w.span?.rows ?? 1);
      if (rowSpan > max_row_span) max_row_span = rowSpan;
    }

    const complexity_score =
      widget_count * 10 + max_row_span * 5 + distinctTypes * 8;

    rows.push({
      dashboard_id: d.dashboard_id,
      name: d.name,
      widget_count,
      distinct_widget_types: distinctTypes,
      max_row_span,
      complexity_score,
      tier: computeTier(complexity_score),
    });
  }

  // Sort: complexity_score desc, then dashboard_id asc tie-break
  rows.sort((a, b) => {
    if (b.complexity_score !== a.complexity_score) return b.complexity_score - a.complexity_score;
    return a.dashboard_id < b.dashboard_id ? -1 : 1;
  });

  const most_complex =
    rows.length > 0
      ? {
          dashboard_id: rows[0].dashboard_id,
          name: rows[0].name,
          complexity_score: rows[0].complexity_score,
        }
      : null;

  const avg_complexity =
    rows.length > 0
      ? Math.round((rows.reduce((s, r) => s + r.complexity_score, 0) / rows.length) * 100) / 100
      : 0;

  const tier_distribution = {
    simple: rows.filter((r) => r.tier === 'simple').length,
    moderate: rows.filter((r) => r.tier === 'moderate').length,
    complex: rows.filter((r) => r.tier === 'complex').length,
  };

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_dashboards: rows.length,
    scores: rows,
    most_complex,
    avg_complexity,
    tier_distribution,
  };
}
