// services/bff/src/custom_dashboard_fleet_lint.ts
//
// T6 M11.14 — Custom dashboard fleet lint summary.
//
// M11.10 ships per-dashboard lint (5 issue types across 3
// severities). M11.14 widens to the fleet view: walks every
// saved dashboard in a tenant + aggregates lint results into a
// rollup that surfaces "what needs attention?" across the whole
// SPA dashboards page. Companion lens to M11.11 (widget usage
// analytics) — usage answers "what's popular?"; M11.14 answers
// "what's broken?".
//
// Pure resolver. Composes M11.10's lintDashboardLayout per
// dashboard, then aggregates.

import type { CustomDashboard, CustomDashboardStore } from './custom_dashboards';
import {
  lintDashboardLayout,
  type LintIssueType,
  type LintReport,
} from './custom_dashboard_lint';

// ─── Public types ─────────────────────────────────────────────────────

const ALL_ISSUE_TYPES: readonly LintIssueType[] = [
  'unknown_widget_type',
  'overlapping_widgets',
  'widget_extends_beyond_max_rows',
  'unrecognized_config_key',
  'empty_grid_region',
] as const;

export interface DashboardLintSummary {
  dashboard_id: string;
  name: string;
  total_widgets: number;
  errors_count: number;
  warnings_count: number;
  info_count: number;
  /** True iff errors_count===0 (mirrors M11.10's passes flag). */
  passes: boolean;
}

export interface FleetLintSummary {
  tenant_id: string;
  generated_at: string;
  total_dashboards: number;
  /** dashboards with errors_count===0. */
  passing_count: number;
  /** dashboards with errors_count > 0. */
  failing_count: number;
  /** dashboards with warnings_count > 0 (regardless of errors). */
  with_warnings_count: number;
  /** Aggregate counts across the whole fleet. */
  total_errors: number;
  total_warnings: number;
  total_infos: number;
  /** Per-issue-type aggregate counts across the fleet. Every
   *  LintIssueType key present (zero when absent) for stable SPA
   *  rendering. */
  by_issue_type: Record<LintIssueType, number>;
  /** Per-dashboard summary rows sorted by errors_count desc with
   *  warnings_count desc then dashboard_id asc tie-break. Worst
   *  offenders float to the top. */
  dashboards: DashboardLintSummary[];
  /** Dashboards with errors_count > 0. Subset of `dashboards`.
   *  Sorted with the same key as dashboards[]. */
  dashboards_with_errors: DashboardLintSummary[];
  /** Worst-offender dashboard by errors_count, tie-broken by
   *  warnings_count desc then dashboard_id asc. null when zero
   *  dashboards have errors. */
  worst_dashboard: DashboardLintSummary | null;
}

// ─── Pure helpers ─────────────────────────────────────────────────────

function emptyIssueTypeCounts(): Record<LintIssueType, number> {
  return {
    unknown_widget_type: 0,
    overlapping_widgets: 0,
    widget_extends_beyond_max_rows: 0,
    unrecognized_config_key: 0,
    empty_grid_region: 0,
  };
}

function toSummary(dashboard: CustomDashboard, report: LintReport): DashboardLintSummary {
  return {
    dashboard_id: dashboard.dashboard_id,
    name: dashboard.name,
    total_widgets: report.total_widgets,
    errors_count: report.errors_count,
    warnings_count: report.warnings_count,
    info_count: report.info_count,
    passes: report.passes,
  };
}

function dashboardSortKey(a: DashboardLintSummary, b: DashboardLintSummary): number {
  if (b.errors_count !== a.errors_count) return b.errors_count - a.errors_count;
  if (b.warnings_count !== a.warnings_count) return b.warnings_count - a.warnings_count;
  return a.dashboard_id.localeCompare(b.dashboard_id);
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildFleetLintSummary(
  store: CustomDashboardStore,
  tenant_id: string,
  now: Date,
): FleetLintSummary {
  const dashboards = store.list(tenant_id);
  const by_issue_type = emptyIssueTypeCounts();
  const summaries: DashboardLintSummary[] = [];
  let total_errors = 0;
  let total_warnings = 0;
  let total_infos = 0;
  let with_warnings_count = 0;

  for (const d of dashboards) {
    const report = lintDashboardLayout(d);
    summaries.push(toSummary(d, report));
    total_errors += report.errors_count;
    total_warnings += report.warnings_count;
    total_infos += report.info_count;
    if (report.warnings_count > 0) with_warnings_count++;
    for (const issue of report.issues) {
      if (ALL_ISSUE_TYPES.includes(issue.type)) {
        by_issue_type[issue.type]++;
      }
    }
  }

  summaries.sort(dashboardSortKey);

  const dashboards_with_errors = summaries
    .filter((s) => s.errors_count > 0);

  const worst_dashboard = dashboards_with_errors.length > 0
    ? dashboards_with_errors[0]!
    : null;

  const passing_count = summaries.filter((s) => s.errors_count === 0).length;
  const failing_count = summaries.length - passing_count;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_dashboards: summaries.length,
    passing_count,
    failing_count,
    with_warnings_count,
    total_errors,
    total_warnings,
    total_infos,
    by_issue_type,
    dashboards: summaries,
    dashboards_with_errors,
    worst_dashboard,
  };
}
