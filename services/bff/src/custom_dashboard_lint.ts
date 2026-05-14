// services/bff/src/custom_dashboard_lint.ts
//
// T6 M11.10 — Custom dashboard layout linting.
//
// M11.7 ships the dashboard CRUD with save-time validation
// (overlap detection, span bounds, config-key whitelist). M11.9
// adds import/export bundles. But layouts can ALSO arrive via:
//  - a bundle imported from an older tenant (config_keys catalog
//    may have evolved)
//  - a future cross-tenant migration path
//  - a developer/SPA constructing a layout client-side then
//    POSTing — bugs slip through the validation gate occasionally
// So an explicit `lint` pass is useful as a separate health-check
// surface that doesn't refuse to save, just reports issues for
// the operator to review.
//
// Design:
//  - Pure function. Takes a `CustomDashboard` + returns a
//    structured issues report. No I/O, no store coupling.
//  - 5 issue types across 3 severities:
//      ERROR: unknown_widget_type, overlapping_widgets
//      WARNING: widget_extends_beyond_max_rows, unrecognized_config_key
//      INFO: empty_grid_region (gap > 5 rows between widgets)
//  - The error checks are intentionally defensive — M11.7's save
//    path already catches them. But an imported bundle could have
//    slipped through an older validator, and the lint surface gives
//    operators a "go/no-go" verdict before deploying a dashboard.

import {
  WIDGET_CATALOG,
  detectOverlaps,
  isWidgetType,
  type CustomDashboard,
  type DashboardWidget,
} from './custom_dashboards';

// ─── Public types ─────────────────────────────────────────────────────

export type LintSeverity = 'error' | 'warning' | 'info';

export type LintIssueType =
  | 'unknown_widget_type'
  | 'overlapping_widgets'
  | 'widget_extends_beyond_max_rows'
  | 'unrecognized_config_key'
  | 'empty_grid_region';

export interface LintIssue {
  type: LintIssueType;
  severity: LintSeverity;
  message: string;
  /** 0-based widget index when the issue is tied to one widget. */
  widget_index?: number;
  /** Set on `overlapping_widgets` — the second widget's index. */
  widget_index_b?: number;
}

export interface LintReport {
  dashboard_id: string;
  total_widgets: number;
  errors_count: number;
  warnings_count: number;
  info_count: number;
  /** True iff errors_count === 0. SPA gates a "deploy" affordance on this. */
  passes: boolean;
  issues: LintIssue[];
}

// ─── Constants ────────────────────────────────────────────────────────

/** Rows past this threshold likely indicate a config error rather
 *  than an intentionally tall widget. Tunable. */
export const MAX_REASONABLE_ROWS = 50;
/** Vertical gap between consecutive widget rectangles past this
 *  threshold is surfaced as an `empty_grid_region` info. */
export const EMPTY_REGION_ROWS = 5;

// ─── Lint passes ──────────────────────────────────────────────────────

function bottomRow(w: DashboardWidget): number {
  return w.position.row + w.span.rows - 1;
}

/** Compute the vertical extent of a widget rectangle as
 *  [topRow, bottomRow]. */
function vertical(w: DashboardWidget): [number, number] {
  return [w.position.row, bottomRow(w)];
}

/** Pure-function lint pass. */
export function lintDashboardLayout(dashboard: CustomDashboard): LintReport {
  const issues: LintIssue[] = [];

  // 1. Unknown widget_type — defensive vs the M11.7 save validator,
  //    important when a layout was imported from a future schema.
  for (let i = 0; i < dashboard.widgets.length; i++) {
    const w = dashboard.widgets[i]!;
    if (!isWidgetType(w.widget_type)) {
      issues.push({
        type: 'unknown_widget_type',
        severity: 'error',
        message: `widget[${i}].widget_type '${w.widget_type}' is not in the platform catalog`,
        widget_index: i,
      });
    }
  }

  // 2. Overlapping widgets — defensive. M11.7's `detectOverlaps`
  //    is the same fn the store uses on save, but post-import or
  //    cross-tenant clones may have side-stepped a save call.
  const overlap = detectOverlaps(dashboard.widgets);
  if (overlap) {
    issues.push({
      type: 'overlapping_widgets',
      severity: 'error',
      message: `widget[${overlap.a}] and widget[${overlap.b}] overlap on the grid`,
      widget_index: overlap.a,
      widget_index_b: overlap.b,
    });
  }

  // 3. Tall widgets — span.rows + position.row past MAX_REASONABLE_ROWS
  //    is almost always a config error.
  for (let i = 0; i < dashboard.widgets.length; i++) {
    const w = dashboard.widgets[i]!;
    const bottom = bottomRow(w);
    if (bottom + 1 > MAX_REASONABLE_ROWS) {
      issues.push({
        type: 'widget_extends_beyond_max_rows',
        severity: 'warning',
        message: `widget[${i}] extends to row ${bottom} (max reasonable: ${MAX_REASONABLE_ROWS - 1})`,
        widget_index: i,
      });
    }
  }

  // 4. Unrecognized config_key — widget.config keys not in the
  //    catalog's config_keys whitelist.
  for (let i = 0; i < dashboard.widgets.length; i++) {
    const w = dashboard.widgets[i]!;
    if (!isWidgetType(w.widget_type)) continue; // already errored
    const allowed = new Set(WIDGET_CATALOG[w.widget_type].config_keys);
    for (const key of Object.keys(w.config)) {
      if (!allowed.has(key)) {
        issues.push({
          type: 'unrecognized_config_key',
          severity: 'warning',
          message: `widget[${i}].config has unknown key '${key}' for ${w.widget_type} (allowed: ${[...allowed].join(', ')})`,
          widget_index: i,
        });
      }
    }
  }

  // 5. Empty grid region — vertical gap larger than threshold between
  //    consecutive non-overlapping widget extents indicates wasted space.
  if (dashboard.widgets.length >= 2) {
    const extents = dashboard.widgets
      .map((w, i) => ({ i, top: vertical(w)[0], bottom: vertical(w)[1] }))
      .sort((a, b) => a.top - b.top);
    for (let k = 1; k < extents.length; k++) {
      const prevBottom = extents[k - 1]!.bottom;
      const nextTop = extents[k]!.top;
      const gap = nextTop - (prevBottom + 1);
      if (gap > EMPTY_REGION_ROWS) {
        issues.push({
          type: 'empty_grid_region',
          severity: 'info',
          message: `${gap}-row gap between widget[${extents[k - 1]!.i}] (ends row ${prevBottom}) and widget[${extents[k]!.i}] (starts row ${nextTop})`,
        });
      }
    }
  }

  let errors_count = 0;
  let warnings_count = 0;
  let info_count = 0;
  for (const it of issues) {
    if (it.severity === 'error') errors_count += 1;
    else if (it.severity === 'warning') warnings_count += 1;
    else info_count += 1;
  }
  return {
    dashboard_id: dashboard.dashboard_id,
    total_widgets: dashboard.widgets.length,
    errors_count,
    warnings_count,
    info_count,
    passes: errors_count === 0,
    issues,
  };
}
