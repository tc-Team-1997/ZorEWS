// services/bff/src/scenario_axis_severity_matrix.ts
//
// T6 M16.23 — Scenario shock-axis × severity cross-tab matrix.
//
// M16.19 ships category × severity; M16.21 ships regulator × severity
// (both one-cell-per-preset). M16.20 ships the per-axis magnitude
// histogram; M16.22 ships the per-axis direction distribution (neither
// stratified by severity).
//
// M16.23 ships the missing combination: shock-axis × severity. Rows =
// 3 ShockAxis (canonical gdp → rate → fx); cols = 3 ScenarioSeverity
// (canonical mild → moderate → severe) = 9 cells. A cell counts presets
// that EXERCISE that axis (raw shock ≠ 0) at that severity tier. Because
// a preset can exercise multiple axes, it can count in multiple ROWS,
// but only ever in ONE column (its single severity). So:
//   - row.total       = presets exercising this axis across all tiers
//   - col.total       = axis-exercises within this severity (≥ preset_count)
//   - col.preset_count= distinct presets at this severity (clean denominator)
//   - total_axis_exercises = Σ cells = Σ over presets of (# non-zero axes)
// The all-zero baseline preset exercises NO axis and contributes nothing.
//
// Mirror of the M8.14 / M14.30 "counts-in-multiple-rows" cross-tab
// pattern. Both axes are CLOSED (3 × 3).
//
// Drives BIL stress-test coverage analysis: "at the SEVERE tier, which
// shock dimensions do we actually exercise? do we stress FX only at
// severe, or across every tier? where are the axis × severity gaps?".

import {
  listScenarioPresets,
  type ScenarioPreset,
  type ScenarioSeverity,
} from './scenario_library';
import { ALL_SHOCK_AXES, type ShockAxis } from './scenario_shock_axis_histogram';

// Canonical severity order (kept local — mirrors how M16.21 declares
// its own ALL_SEVERITIES const rather than exporting a shared one).
export const ALL_SCENARIO_SEVERITIES: readonly ScenarioSeverity[] = [
  'mild',
  'moderate',
  'severe',
];

// ─── Public types ──────────────────────────────────────────────────────

export interface AxisSeverityRow {
  axis: ShockAxis;
  total: number;
  by_severity: Record<ScenarioSeverity, number>;
  /** Severities with by_severity=0 (canonical order). */
  severities_without: ScenarioSeverity[];
  /** Distinct severities at which this axis is exercised (0..3). */
  distinct_severities: number;
}

export interface AxisSeverityColumn {
  severity: ScenarioSeverity;
  total: number;
  by_axis: Record<ShockAxis, number>;
  /** Axes with by_axis=0 (canonical order). */
  axes_without: ShockAxis[];
  /** Distinct axes exercised at this severity (0..3). */
  distinct_axes: number;
  /** Distinct presets at this severity (regardless of axes) — the clean
   *  denominator, since the per-cell counts double-count multi-axis presets. */
  preset_count: number;
}

export interface ScenarioAxisSeverityMatrix {
  generated_at: string;
  total_presets: number;
  /** Σ cells = Σ over presets of (# non-zero shock axes). */
  total_axis_exercises: number;
  total_axes: number; // = 3
  total_severities: number; // = 3
  rows: AxisSeverityRow[];
  columns: AxisSeverityColumn[];
  /** Highest-count cell; canonical iteration tie-break — axes in
   *  ALL_SHOCK_AXES order × severities in ALL_SCENARIO_SEVERITIES order;
   *  null when no axis exercised anywhere. */
  peak_cell: {
    axis: ShockAxis;
    severity: ScenarioSeverity;
    count: number;
  } | null;
  /** Axis with the highest row total — the dimension the library
   *  stresses across the most presets; canonical axis-order tie-break;
   *  null on empty. */
  most_exercised_axis: ShockAxis | null;
  /** Severity with most distinct non-zero by_axis entries — the tier
   *  exercising the widest shock-dimension coverage; canonical
   *  severity-order tie-break; null on empty. */
  severity_with_widest_axis_coverage: ScenarioSeverity | null;
  /** (axis, severity) cells with count=0 — canonical row-major order
   *  (axis outer × severity inner). */
  empty_cells: Array<{ axis: ShockAxis; severity: ScenarioSeverity }>;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyBySeverity(): Record<ScenarioSeverity, number> {
  const out = {} as Record<ScenarioSeverity, number>;
  for (const s of ALL_SCENARIO_SEVERITIES) out[s] = 0;
  return out;
}

function emptyByAxis(): Record<ShockAxis, number> {
  const out = {} as Record<ShockAxis, number>;
  for (const a of ALL_SHOCK_AXES) out[a] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildScenarioAxisSeverityMatrix(
  now: Date,
  presets: readonly ScenarioPreset[] = listScenarioPresets(),
): ScenarioAxisSeverityMatrix {
  // cell[axis][severity] = count of presets exercising axis at severity.
  const cell: Record<ShockAxis, Record<ScenarioSeverity, number>> = {} as never;
  for (const a of ALL_SHOCK_AXES) cell[a] = emptyBySeverity();

  // Distinct preset count per severity (denominator).
  const presetCountBySeverity = emptyBySeverity();

  let total_axis_exercises = 0;

  for (const preset of presets) {
    const sev = preset.severity;
    // Defensive: skip presets carrying an out-of-enum severity.
    if (!ALL_SCENARIO_SEVERITIES.includes(sev)) continue;
    presetCountBySeverity[sev]++;
    for (const axis of ALL_SHOCK_AXES) {
      if (preset.shocks[axis] !== 0) {
        cell[axis][sev]++;
        total_axis_exercises++;
      }
    }
  }

  // Rows — canonical axis order.
  const rows: AxisSeverityRow[] = ALL_SHOCK_AXES.map((axis) => {
    const by_severity = { ...cell[axis] };
    let total = 0;
    for (const s of ALL_SCENARIO_SEVERITIES) total += by_severity[s];
    const severities_without = ALL_SCENARIO_SEVERITIES.filter((s) => by_severity[s] === 0);
    return {
      axis,
      total,
      by_severity,
      severities_without,
      distinct_severities: ALL_SCENARIO_SEVERITIES.length - severities_without.length,
    };
  });

  // Columns — canonical severity order.
  const columns: AxisSeverityColumn[] = ALL_SCENARIO_SEVERITIES.map((severity) => {
    const by_axis = emptyByAxis();
    let total = 0;
    for (const axis of ALL_SHOCK_AXES) {
      by_axis[axis] = cell[axis][severity];
      total += by_axis[axis];
    }
    const axes_without = ALL_SHOCK_AXES.filter((a) => by_axis[a] === 0);
    return {
      severity,
      total,
      by_axis,
      axes_without,
      distinct_axes: ALL_SHOCK_AXES.length - axes_without.length,
      preset_count: presetCountBySeverity[severity],
    };
  });

  // peak_cell — highest count; canonical iteration (axes × severities).
  let peak_cell:
    | { axis: ShockAxis; severity: ScenarioSeverity; count: number }
    | null = null;
  let peakCount = 0;
  for (const axis of ALL_SHOCK_AXES) {
    for (const severity of ALL_SCENARIO_SEVERITIES) {
      const c = cell[axis][severity];
      if (c > peakCount) {
        peakCount = c;
        peak_cell = { axis, severity, count: c };
      }
    }
  }

  // most_exercised_axis — highest row total; canonical axis-order tie-break.
  let most_exercised_axis: ShockAxis | null = null;
  let bestRowTotal = 0;
  for (const row of rows) {
    if (row.total > bestRowTotal) {
      bestRowTotal = row.total;
      most_exercised_axis = row.axis;
    }
  }

  // severity_with_widest_axis_coverage — highest distinct_axes; canonical tie-break.
  let severity_with_widest_axis_coverage: ScenarioSeverity | null = null;
  let bestDistinct = 0;
  for (const col of columns) {
    if (col.distinct_axes > bestDistinct) {
      bestDistinct = col.distinct_axes;
      severity_with_widest_axis_coverage = col.severity;
    }
  }

  // empty_cells — canonical axis × severity row-major order.
  const empty_cells: Array<{ axis: ShockAxis; severity: ScenarioSeverity }> = [];
  for (const axis of ALL_SHOCK_AXES) {
    for (const severity of ALL_SCENARIO_SEVERITIES) {
      if (cell[axis][severity] === 0) empty_cells.push({ axis, severity });
    }
  }

  return {
    generated_at: now.toISOString(),
    total_presets: presets.length,
    total_axis_exercises,
    total_axes: ALL_SHOCK_AXES.length,
    total_severities: ALL_SCENARIO_SEVERITIES.length,
    rows,
    columns,
    peak_cell,
    most_exercised_axis,
    severity_with_widest_axis_coverage,
    empty_cells,
  };
}
