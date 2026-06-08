// dashboardBuilderEngine.ts
//
// ZorEWS Dashboard Builder Engine
// Core state machine for the drag-and-drop dashboard builder.
// Manages layout, widget placement, role templates, and persistence.
//
// Additive — no existing logic changed.

import type { MarketplaceWidget, WidgetConfig, WidgetSize } from './widgetMarketplace';

// ─── Types ────────────────────────────────────────────────────────────────

export type DashboardStatus = 'draft' | 'published' | 'archived';
export type DashboardAccess = 'private' | 'team' | 'org';

export interface PlacedWidget {
  /** Unique placement ID (not the widget catalog ID) */
  placement_id: string;
  /** Widget catalog ID */
  widget_id:    string;
  /** Grid column start (1-12) */
  col:          number;
  /** Grid row start (1-∞) */
  row:          number;
  /** Column span */
  col_span:     number;
  /** Row span */
  row_span:     number;
  /** Per-placement config overrides */
  config:       WidgetConfig;
  /** User-defined title override */
  title?:       string;
}

export interface DashboardLayout {
  id:           string;
  name:         string;
  description?: string;
  status:       DashboardStatus;
  access:       DashboardAccess;
  widgets:      PlacedWidget[];
  created_by:   string;
  created_at:   string;
  updated_at:   string;
  /** Template it was cloned from, if any */
  template_id?: string;
  /** Tags for search/filter */
  tags:         string[];
  /** Whether this layout is starred as favorite */
  is_favorite:  boolean;
  /** Thumbnail blob URL (from snapshot export) */
  thumbnail?:   string;
  /** Shared with these team IDs */
  shared_with?: string[];
}

export type RoleTemplateId =
  | 'cro_dashboard'
  | 'ceo_dashboard'
  | 'cfo_dashboard'
  | 'risk_analyst_dashboard'
  | 'compliance_dashboard'
  | 'recovery_dashboard'
  | 'fraud_analyst_dashboard'
  | 'executive_dashboard';

export interface RoleTemplate {
  id:          RoleTemplateId;
  name:        string;
  description: string;
  role:        string;
  icon:        string;
  widgets:     Array<{
    widget_id: string;
    col:       number;
    row:       number;
    col_span:  number;
    row_span:  number;
    config?:   WidgetConfig;
  }>;
  tags:        string[];
}

// ─── Persistence key ──────────────────────────────────────────────────────

const STORAGE_KEY = 'zorews.dashboard.builder.layouts';
const MAX_LAYOUTS = 20;

// ─── PRNG for placement IDs ───────────────────────────────────────────────

let _seq = 0;
export function newPlacementId(): string {
  return `wp-${Date.now()}-${++_seq}`;
}

// ─── Role Templates ───────────────────────────────────────────────────────

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    id: 'cro_dashboard',
    name: 'CRO Dashboard',
    description: 'Chief Risk Officer — enterprise risk index, compliance radar, stress tests, AI briefing',
    role: 'executive',
    icon: 'gauge',
    tags: ['executive', 'risk', 'cro'],
    widgets: [
      { widget_id: 'kpi_enterprise_risk_index',  col: 1, row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_critical_alerts',        col: 4, row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_compliance_readiness',   col: 7, row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_portfolio_npa',          col: 10, row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'executive_briefing',         col: 1, row: 2, col_span: 6, row_span: 2 },
      { widget_id: 'compliance_radar',           col: 7, row: 2, col_span: 3, row_span: 2 },
      { widget_id: 'stress_test_results',        col: 10, row: 2, col_span: 3, row_span: 2 },
      { widget_id: 'portfolio_pd_trend',         col: 1, row: 4, col_span: 6, row_span: 2 },
      { widget_id: 'npa_prediction_list',        col: 7, row: 4, col_span: 6, row_span: 2 },
    ],
  },
  {
    id: 'ceo_dashboard',
    name: 'CEO Dashboard',
    description: 'Chief Executive Officer — board scorecard, financial ratios, strategic risk view',
    role: 'executive',
    icon: 'briefcase',
    tags: ['executive', 'ceo', 'board'],
    widgets: [
      { widget_id: 'kpi_enterprise_risk_index',  col: 1,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_compliance_readiness',   col: 4,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_portfolio_npa',          col: 7,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_recovery_rate',          col: 10, row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'board_scorecard',            col: 1,  row: 2, col_span: 6, row_span: 2 },
      { widget_id: 'executive_briefing',         col: 7,  row: 2, col_span: 6, row_span: 2 },
      { widget_id: 'portfolio_pd_trend',         col: 1,  row: 4, col_span: 6, row_span: 2 },
      { widget_id: 'compliance_radar',           col: 7,  row: 4, col_span: 6, row_span: 2 },
    ],
  },
  {
    id: 'risk_analyst_dashboard',
    name: 'Risk Analyst Dashboard',
    description: 'Daily risk monitoring — alerts, NPA predictions, SMA tracker, AI insights',
    role: 'risk_analyst',
    icon: 'activity',
    tags: ['risk analyst', 'npa', 'alerts', 'daily'],
    widgets: [
      { widget_id: 'kpi_critical_alerts',        col: 1,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_high_risk_accounts',     col: 4,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_sla_breaches',           col: 7,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_open_cases',             col: 10, row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'alert_live_feed',            col: 1,  row: 2, col_span: 6, row_span: 2 },
      { widget_id: 'npa_prediction_list',        col: 7,  row: 2, col_span: 6, row_span: 2 },
      { widget_id: 'sma_migration',              col: 1,  row: 4, col_span: 4, row_span: 2 },
      { widget_id: 'alert_trend_chart',          col: 5,  row: 4, col_span: 8, row_span: 2 },
    ],
  },
  {
    id: 'compliance_dashboard',
    name: 'Compliance Dashboard',
    description: 'Compliance officer — filing calendar, AML gaps, KYC backlog, compliance radar',
    role: 'auditor',
    icon: 'shield-check',
    tags: ['compliance', 'rbi', 'aml', 'kyc'],
    widgets: [
      { widget_id: 'kpi_compliance_readiness',   col: 1,  row: 1, col_span: 4, row_span: 1 },
      { widget_id: 'sar_filing_status',          col: 5,  row: 1, col_span: 4, row_span: 1 },
      { widget_id: 'kyc_backlog',                col: 9,  row: 1, col_span: 4, row_span: 1 },
      { widget_id: 'compliance_calendar',        col: 1,  row: 2, col_span: 7, row_span: 2 },
      { widget_id: 'compliance_radar',           col: 8,  row: 2, col_span: 5, row_span: 2 },
      { widget_id: 'aml_gaps',                   col: 1,  row: 4, col_span: 4, row_span: 1 },
      { widget_id: 'investigation_queue',        col: 5,  row: 4, col_span: 8, row_span: 2 },
    ],
  },
  {
    id: 'recovery_dashboard',
    name: 'Recovery Dashboard',
    description: 'Collections & recovery team — queue, pipeline, SLA, recovery metrics',
    role: 'collection_officer',
    icon: 'rotate-ccw',
    tags: ['recovery', 'collections', 'npa', 'sla'],
    widgets: [
      { widget_id: 'kpi_recovery_rate',          col: 1,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_sla_breaches',           col: 4,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_open_cases',             col: 7,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_high_risk_accounts',     col: 10, row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'collections_queue',          col: 1,  row: 2, col_span: 7, row_span: 2 },
      { widget_id: 'recovery_funnel',            col: 8,  row: 2, col_span: 5, row_span: 2 },
      { widget_id: 'branch_heatmap',             col: 1,  row: 4, col_span: 6, row_span: 2 },
      { widget_id: 'alert_sla_panel',            col: 7,  row: 4, col_span: 6, row_span: 1 },
    ],
  },
  {
    id: 'fraud_analyst_dashboard',
    name: 'Fraud Analyst Dashboard',
    description: 'Fraud & AML — investigation queue, clusters, SAR status, AI recommendations',
    role: 'fraud_analyst',
    icon: 'shield-alert',
    tags: ['fraud', 'aml', 'investigations', 'sar'],
    widgets: [
      { widget_id: 'kpi_critical_alerts',        col: 1,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'sar_filing_status',          col: 4,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_open_cases',             col: 7,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'aml_gaps',                   col: 10, row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'investigation_queue',        col: 1,  row: 2, col_span: 6, row_span: 2 },
      { widget_id: 'fraud_cluster_map',          col: 7,  row: 2, col_span: 6, row_span: 2 },
      { widget_id: 'ai_recommendations',         col: 1,  row: 4, col_span: 6, row_span: 2 },
      { widget_id: 'investigation_funnel',       col: 7,  row: 4, col_span: 6, row_span: 2 },
    ],
  },
  {
    id: 'executive_dashboard',
    name: 'Executive Overview',
    description: 'C-suite overview — enterprise index, AI briefing, board scorecard, model performance',
    role: 'executive',
    icon: 'bar-chart',
    tags: ['executive', 'overview', 'board'],
    widgets: [
      { widget_id: 'kpi_enterprise_risk_index',  col: 1,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_portfolio_npa',          col: 4,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_compliance_readiness',   col: 7,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_critical_alerts',        col: 10, row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'executive_briefing',         col: 1,  row: 2, col_span: 6, row_span: 2 },
      { widget_id: 'board_scorecard',            col: 7,  row: 2, col_span: 6, row_span: 2 },
      { widget_id: 'model_performance',          col: 1,  row: 4, col_span: 4, row_span: 2 },
      { widget_id: 'portfolio_pd_trend',         col: 5,  row: 4, col_span: 8, row_span: 2 },
    ],
  },
  {
    id: 'cfo_dashboard',
    name: 'CFO Dashboard',
    description: 'Chief Financial Officer — capital adequacy, ECL provisions, stress tests, sector risk',
    role: 'executive',
    icon: 'dollar-sign',
    tags: ['cfo', 'capital', 'ecl', 'financial'],
    widgets: [
      { widget_id: 'kpi_portfolio_npa',          col: 1,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_enterprise_risk_index',  col: 4,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_compliance_readiness',   col: 7,  row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'kpi_recovery_rate',          col: 10, row: 1, col_span: 3, row_span: 1 },
      { widget_id: 'stress_test_results',        col: 1,  row: 2, col_span: 5, row_span: 2 },
      { widget_id: 'board_scorecard',            col: 6,  row: 2, col_span: 7, row_span: 2 },
      { widget_id: 'sector_concentration',       col: 1,  row: 4, col_span: 6, row_span: 2 },
      { widget_id: 'portfolio_pd_trend',         col: 7,  row: 4, col_span: 6, row_span: 2 },
    ],
  },
];

// ─── Layout persistence ───────────────────────────────────────────────────

export function loadLayouts(): DashboardLayout[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as DashboardLayout[];
  } catch { /* corrupt */ }
  return [];
}

export function saveLayouts(layouts: DashboardLayout[]): void {
  try {
    const capped = layouts.slice(0, MAX_LAYOUTS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(capped));
  } catch { /* quota */ }
}

function timestamp(): string { return new Date().toISOString(); }

export function createLayout(
  name: string,
  creator: string,
  templateId?: RoleTemplateId,
): DashboardLayout {
  const template = templateId ? ROLE_TEMPLATES.find(t => t.id === templateId) : undefined;

  const widgets: PlacedWidget[] = (template?.widgets ?? []).map(w => ({
    placement_id: newPlacementId(),
    widget_id:    w.widget_id,
    col:          w.col,
    row:          w.row,
    col_span:     w.col_span,
    row_span:     w.row_span,
    config:       w.config ?? {},
  }));

  return {
    id:          `layout-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    status:      'draft',
    access:      'private',
    widgets,
    created_by:  creator,
    created_at:  timestamp(),
    updated_at:  timestamp(),
    template_id: templateId,
    tags:        template?.tags ?? [],
    is_favorite: false,
  };
}

export function addWidget(
  layout: DashboardLayout,
  widget: MarketplaceWidget,
  col = 1,
  row = 1,
): DashboardLayout {
  const [colSpan, rowSpan] = sizeToSpan(widget.size);
  const placed: PlacedWidget = {
    placement_id: newPlacementId(),
    widget_id:    widget.id,
    col,
    row,
    col_span:     colSpan,
    row_span:     rowSpan,
    config:       { ...widget.defaultConfig },
  };
  return { ...layout, widgets: [...layout.widgets, placed], updated_at: timestamp() };
}

export function removeWidget(layout: DashboardLayout, placementId: string): DashboardLayout {
  return {
    ...layout,
    widgets: layout.widgets.filter(w => w.placement_id !== placementId),
    updated_at: timestamp(),
  };
}

export function updateWidgetConfig(
  layout: DashboardLayout,
  placementId: string,
  config: Partial<WidgetConfig>,
  title?: string,
): DashboardLayout {
  return {
    ...layout,
    widgets: layout.widgets.map(w =>
      w.placement_id === placementId
        ? { ...w, config: { ...w.config, ...config }, title: title ?? w.title }
        : w
    ),
    updated_at: timestamp(),
  };
}

export function moveWidget(
  layout: DashboardLayout,
  placementId: string,
  col: number,
  row: number,
): DashboardLayout {
  return {
    ...layout,
    widgets: layout.widgets.map(w =>
      w.placement_id === placementId ? { ...w, col, row } : w
    ),
    updated_at: timestamp(),
  };
}

export function resizeWidget(
  layout: DashboardLayout,
  placementId: string,
  colSpan: number,
  rowSpan: number,
): DashboardLayout {
  return {
    ...layout,
    widgets: layout.widgets.map(w =>
      w.placement_id === placementId ? { ...w, col_span: colSpan, row_span: rowSpan } : w
    ),
    updated_at: timestamp(),
  };
}

export function duplicateLayout(layout: DashboardLayout, creator: string): DashboardLayout {
  return {
    ...layout,
    id:         `layout-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name:       `${layout.name} (Copy)`,
    status:     'draft',
    access:     'private',
    created_by: creator,
    created_at: timestamp(),
    updated_at: timestamp(),
    is_favorite: false,
    widgets:    layout.widgets.map(w => ({ ...w, placement_id: newPlacementId() })),
  };
}

export function toggleFavorite(layout: DashboardLayout): DashboardLayout {
  return { ...layout, is_favorite: !layout.is_favorite, updated_at: timestamp() };
}

export function publishLayout(layout: DashboardLayout, access: DashboardAccess = 'org'): DashboardLayout {
  return { ...layout, status: 'published', access, updated_at: timestamp() };
}

export function resetToTemplate(layout: DashboardLayout): DashboardLayout {
  const template = layout.template_id ? ROLE_TEMPLATES.find(t => t.id === layout.template_id) : undefined;
  if (!template) return layout;
  const freshWidgets: PlacedWidget[] = template.widgets.map(w => ({
    placement_id: newPlacementId(),
    widget_id:    w.widget_id,
    col:          w.col,
    row:          w.row,
    col_span:     w.col_span,
    row_span:     w.row_span,
    config:       w.config ?? {},
  }));
  return { ...layout, widgets: freshWidgets, updated_at: timestamp() };
}

// ─── Grid helpers ─────────────────────────────────────────────────────────

export function sizeToSpan(size: WidgetSize): [number, number] {
  const map: Record<WidgetSize, [number, number]> = {
    '1x1': [1, 1],
    '2x1': [3, 1],
    '3x1': [4, 1],
    '4x1': [6, 1],
    '2x2': [3, 2],
    '4x2': [6, 2],
    '3x2': [4, 2],
  };
  return map[size] ?? [4, 1];
}

/** Find the next available row for new widget (below all current widgets) */
export function nextAvailableRow(layout: DashboardLayout): number {
  if (layout.widgets.length === 0) return 1;
  return Math.max(...layout.widgets.map(w => w.row + w.row_span));
}

/** Check if two widgets overlap on the grid */
export function widgetsOverlap(a: PlacedWidget, b: PlacedWidget): boolean {
  const aRight  = a.col + a.col_span;
  const bRight  = b.col + b.col_span;
  const aBottom = a.row + a.row_span;
  const bBottom = b.row + b.row_span;
  return a.col < bRight && aRight > b.col && a.row < bBottom && aBottom > b.row;
}
