// services/bff/src/dashboard_widget_defaults.ts
//
// T6 M11.12 — Dashboard widget config defaults seed.
//
// M11.7 ships the widget catalog with `config_keys[]` per widget
// type; M11.8 ships the resolver; M11.10 the lint; M11.11 the usage
// analytics. M11.12 is the missing piece for the SPA's "Add widget"
// wizard: a per-widget DEFAULT config object that pre-fills the form.
// Currently the SPA shows an empty form and the user has to know
// which keys + values are sensible. With M11.12 it ships with
// {vertical: 'banking', bucket_count: 10, ...} already populated.
//
// Pure — no I/O. Defaults are hand-calibrated platform-static
// constants. SPA renders them as starting points; the operator
// then tweaks before saving.

import {
  WIDGET_TYPES,
  type WidgetType,
} from './custom_dashboards';

// ─── Default config per widget type ─────────────────────────────────

const DEFAULT_CONFIG_BY_WIDGET: Readonly<Record<WidgetType, Readonly<Record<string, unknown>>>> = {
  risk_score_histogram: {
    vertical: 'banking',
    bucket_count: 10,
    segment_filter: 'all',
  },
  alerts_by_class: {
    since_hours: 24,
  },
  open_cases: {
    status_filter: 'all_open',
    limit: 20,
  },
  connector_health: {
    show_paused: false,
  },
  top_breaches: {
    vertical: 'banking',
    limit: 10,
  },
  audit_recent: {
    limit: 25,
    severity_filter: 'all',
  },
  tenant_kpi: {
    metric: 'open_alerts_total',
    comparison_window: '7d',
  },
};

// ─── Public types ─────────────────────────────────────────────────────

export interface WidgetDefaultEntry {
  widget_type: WidgetType;
  default_config: Record<string, unknown>;
}

export interface WidgetDefaultsReport {
  total_widget_types: number;
  defaults: WidgetDefaultEntry[];
}

// ─── Pure helpers ────────────────────────────────────────────────────

/**
 * Returns the default config for a single widget type, or null when
 * the type is unknown.
 */
export function getWidgetDefaultConfig(
  widget_type: WidgetType,
): Readonly<Record<string, unknown>> | null {
  return DEFAULT_CONFIG_BY_WIDGET[widget_type] ?? null;
}

/**
 * Returns the full catalog of defaults — one entry per widget type.
 * Sorted by widget_type asc for stable rendering. Each entry's
 * default_config is spread-copied so SPA mutations don't pollute
 * the singleton DEFAULT_CONFIG_BY_WIDGET map.
 */
export function listWidgetDefaults(): WidgetDefaultsReport {
  const defaults: WidgetDefaultEntry[] = WIDGET_TYPES.map((wt) => ({
    widget_type: wt,
    default_config: { ...(DEFAULT_CONFIG_BY_WIDGET[wt] ?? {}) },
  }));
  defaults.sort((a, b) => (a.widget_type < b.widget_type ? -1 : a.widget_type > b.widget_type ? 1 : 0));
  return {
    total_widget_types: defaults.length,
    defaults,
  };
}
