// services/bff/src/dashboard_layout_efficiency.ts
//
// T6 M11.24 — Dashboard layout efficiency score.
//
// For each custom dashboard, compute layout efficiency:
//   max_row = max(widget.position.row + widget.span.rows) or 1 if empty
//   total_widget_area = Σ(widget.span.rows * widget.span.cols)
//   grid_utilization = total_widget_area / (max_row * 12)  [grid width = 12]
//   widget_density = widget_count / max_row
//   efficiency_score = round(grid_utilization * 60 + widget_density * 40), capped 0-100
//   tier: dense(>=70) / balanced(40-69) / sparse(<40)
//
// Route: GET /v1/dashboards/custom/layout-efficiency
//   RBAC: audit:read (admin)

import { defaultCustomDashboardStore, type CustomDashboard } from './custom_dashboards';

// ─── Public types ─────────────────────────────────────────────────────

export type EfficiencyTier = 'dense' | 'balanced' | 'sparse';

export interface DashboardEfficiencyRow {
  dashboard_id: string;
  name: string;
  widget_count: number;
  efficiency_score: number;
  tier: EfficiencyTier;
  grid_utilization: number;
  widget_density: number;
}

export interface DashboardLayoutEfficiencyReport {
  tenant_id: string;
  generated_at: string;
  dashboards: DashboardEfficiencyRow[];
  avg_efficiency: number;
  most_efficient_dashboard: string | null;
  sparsest_dashboard: string | null;
}

const GRID_WIDTH = 12;

function tierFor(score: number): EfficiencyTier {
  if (score >= 70) return 'dense';
  if (score >= 40) return 'balanced';
  return 'sparse';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function computeDashboardEfficiency(d: CustomDashboard): DashboardEfficiencyRow {
  const widgets = d.widgets ?? [];
  const widget_count = widgets.length;

  if (widget_count === 0) {
    return {
      dashboard_id: d.dashboard_id,
      name: d.name,
      widget_count: 0,
      efficiency_score: 0,
      tier: 'sparse',
      grid_utilization: 0,
      widget_density: 0,
    };
  }

  let max_row = 0;
  let total_widget_area = 0;

  for (const w of widgets) {
    const bottom = (w.position?.row ?? 0) + (w.span?.rows ?? 1);
    if (bottom > max_row) max_row = bottom;
    total_widget_area += (w.span?.rows ?? 1) * (w.span?.cols ?? 1);
  }

  const effective_max_row = Math.max(max_row, 1);
  const grid_utilization = round2(total_widget_area / (effective_max_row * GRID_WIDTH));
  const widget_density = round2(widget_count / effective_max_row);

  const raw_score = grid_utilization * 60 + widget_density * 40;
  const efficiency_score = Math.min(100, Math.max(0, Math.round(raw_score)));

  return {
    dashboard_id: d.dashboard_id,
    name: d.name,
    widget_count,
    efficiency_score,
    tier: tierFor(efficiency_score),
    grid_utilization,
    widget_density,
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildDashboardLayoutEfficiency(
  store: typeof defaultCustomDashboardStore,
  tenant_id: string,
  now: Date,
): DashboardLayoutEfficiencyReport {
  if (!tenant_id) throw new Error('tenant_id is required');

  const dashboards = store.list(tenant_id);
  const rows = dashboards.map(computeDashboardEfficiency);

  const avg_efficiency =
    rows.length === 0
      ? 0
      : Math.round(rows.reduce((s, r) => s + r.efficiency_score, 0) / rows.length);

  let most_efficient_dashboard: string | null = null;
  let sparsest_dashboard: string | null = null;

  if (rows.length > 0) {
    const sorted_desc = [...rows].sort((a, b) => b.efficiency_score - a.efficiency_score);
    most_efficient_dashboard = sorted_desc[0].dashboard_id;

    const sorted_asc = [...rows].sort((a, b) => a.efficiency_score - b.efficiency_score);
    sparsest_dashboard = sorted_asc[0].dashboard_id;
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    dashboards: rows,
    avg_efficiency,
    most_efficient_dashboard,
    sparsest_dashboard,
  };
}
