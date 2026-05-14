// services/bff/src/dashboard_starter_packs.ts
//
// T6 M11.13 — Custom dashboard starter pack suggestions.
//
// New BIL tenants land on the dashboards screen with an empty board.
// M11.7 lets them author from scratch; M11.12 seeds widget defaults.
// M11.13 ships the missing piece: 3 hand-curated "starter pack"
// layouts they can adopt with one click. Lets a new tenant go from
// zero to "operationally useful dashboards" without designing one
// from scratch.
//
// Pure — static catalogue. Same response across tenants.

import {
  WIDGET_CATALOG,
  type DashboardWidget,
  type WidgetType,
} from './custom_dashboards';

// ─── Public types ─────────────────────────────────────────────────────

export interface StarterPack {
  pack_id: string;
  name: string;
  description: string;
  /** Audience the pack is calibrated for. */
  audience: 'ops' | 'executive' | 'audit';
  widgets: DashboardWidget[];
}

export interface StarterPackCatalog {
  total_packs: number;
  packs: StarterPack[];
}

// ─── Helper: build a default widget instance ─────────────────────────

const DEFAULT_CONFIG_BY_WIDGET: Readonly<Record<WidgetType, Readonly<Record<string, unknown>>>> = {
  risk_score_histogram: { vertical: 'banking', bucket_count: 10, segment_filter: 'all' },
  alerts_by_class: { since_hours: 24 },
  open_cases: { status_filter: 'all_open', limit: 20 },
  connector_health: { show_paused: false },
  top_breaches: { vertical: 'banking', limit: 10 },
  audit_recent: { limit: 25, severity_filter: 'all' },
  tenant_kpi: { metric: 'open_alerts_total', comparison_window: '7d' },
};

function widget(
  widget_type: WidgetType,
  row: number,
  col: number,
  configOverride: Record<string, unknown> = {},
): DashboardWidget {
  const span = WIDGET_CATALOG[widget_type].default_span;
  return {
    widget_type,
    position: { row, col },
    span: { rows: span.rows, cols: span.cols },
    config: { ...DEFAULT_CONFIG_BY_WIDGET[widget_type], ...configOverride },
  };
}

// ─── Hand-curated packs ──────────────────────────────────────────────

const STARTER_PACKS: readonly StarterPack[] = [
  {
    pack_id: 'daily_ops',
    name: 'Daily ops',
    description:
      'What ops looks at first thing in the morning: live alerts, open cases, fleet health.',
    audience: 'ops',
    widgets: [
      widget('alerts_by_class', 0, 0),
      widget('open_cases', 1, 0),
      widget('connector_health', 3, 0),
    ],
  },
  {
    pack_id: 'executive_overview',
    name: 'Executive overview',
    description:
      'Single-page exec dashboard: portfolio KPI, risk distribution, top breaches.',
    audience: 'executive',
    widgets: [
      widget('tenant_kpi', 0, 0),
      widget('risk_score_histogram', 1, 0),
      widget('top_breaches', 3, 0),
    ],
  },
  {
    pack_id: 'audit_compliance',
    name: 'Audit + compliance',
    description:
      'Compliance officer view: recent audit events, open cases, KPI snapshot.',
    audience: 'audit',
    widgets: [
      widget('audit_recent', 0, 0),
      widget('open_cases', 3, 0, { status_filter: 'review' }),
      widget('tenant_kpi', 5, 0),
    ],
  },
];

// ─── Pure accessors ──────────────────────────────────────────────────

export function listStarterPacks(): StarterPackCatalog {
  // Deep-copy widgets so SPA mutations don't pollute the singleton.
  const packs: StarterPack[] = STARTER_PACKS.map((pack) => ({
    pack_id: pack.pack_id,
    name: pack.name,
    description: pack.description,
    audience: pack.audience,
    widgets: pack.widgets.map((w) => ({
      widget_type: w.widget_type,
      position: { ...w.position },
      span: { ...w.span },
      config: { ...w.config },
    })),
  }));
  return {
    total_packs: packs.length,
    packs,
  };
}

export function getStarterPack(pack_id: string): StarterPack | null {
  const found = STARTER_PACKS.find((p) => p.pack_id === pack_id);
  if (!found) return null;
  return {
    pack_id: found.pack_id,
    name: found.name,
    description: found.description,
    audience: found.audience,
    widgets: found.widgets.map((w) => ({
      widget_type: w.widget_type,
      position: { ...w.position },
      span: { ...w.span },
      config: { ...w.config },
    })),
  };
}
