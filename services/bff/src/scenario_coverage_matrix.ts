// services/bff/src/scenario_coverage_matrix.ts
//
// T6 M16.17 — Scenario library category × regulator coverage matrix.
//
// M16.1 ships 10 scenario presets spanning 4 categories × 3 regulators.
// M16.17 surfaces the 4 × 3 = 12-cell coverage matrix so ops can spot
// gaps in the BIL regulatory stress-test inventory. E.g. if there are
// no `regulatory × IRDAI × severe` presets, the SPA shows "Add an
// IRDAI severe-stress preset" guidance.
//
// Pure rollup — single pass over SCENARIO_PRESETS. Platform-static.
// Companion shape to M5.14 (template indicator coverage) but
// surfaces a 2D matrix rather than a per-template status.

import {
  SCENARIO_PRESETS,
  type ScenarioCategory,
  type ScenarioRegulator,
} from './scenario_library';

// ─── Public types ─────────────────────────────────────────────────────

const CATEGORIES: readonly ScenarioCategory[] = [
  'baseline',
  'business',
  'regulatory',
  'black_swan',
] as const;

const REGULATORS: readonly ScenarioRegulator[] = ['RBI', 'IRDAI', 'INTERNAL'] as const;

/** Hand-calibrated minimum-count expectations. A regulatory cell
 *  needs at least 2 presets because RBI's stress framework mandates
 *  baseline + adverse + severely-adverse; if any cell drops below
 *  the minimum, M16.17 surfaces it as a gap so ops can act. Non-
 *  declared cells default to 0 (informational presence only). */
const EXPECTED_MIN_BY_CELL: Record<string, number> = {
  'regulatory.RBI': 2,
  'regulatory.IRDAI': 1,
  'black_swan.INTERNAL': 1,
  'baseline.INTERNAL': 1,
};

function cellKey(category: ScenarioCategory, regulator: ScenarioRegulator): string {
  return `${category}.${regulator}`;
}

export interface MatrixCell {
  category: ScenarioCategory;
  regulator: ScenarioRegulator;
  count: number;
  /** Preset ids in this cell, sorted asc for stable rendering. */
  preset_ids: string[];
  expected_min: number;
  /** True iff count < expected_min. Drives the SPA's gap warning. */
  is_gap: boolean;
}

export interface CoverageGap {
  category: ScenarioCategory;
  regulator: ScenarioRegulator;
  expected_min: number;
  actual: number;
  shortfall: number;
}

export interface ScenarioCoverageMatrix {
  total_presets: number;
  /** All 12 cells present even when empty. Ordered category major,
   *  regulator minor (each in declared order). */
  cells: MatrixCell[];
  /** Cells with actual < expected_min, sorted by shortfall desc with
   *  category asc then regulator asc tie-break. */
  gaps: CoverageGap[];
  /** Highest count cell. Ties broken by category asc then regulator
   *  asc (declared order). null when library is empty. */
  most_populated_cell: {
    category: ScenarioCategory;
    regulator: ScenarioRegulator;
    count: number;
  } | null;
  /** Aggregate per-axis: useful for SPA marginal totals. */
  by_category: Record<ScenarioCategory, number>;
  by_regulator: Record<ScenarioRegulator, number>;
}

// ─── Pure resolver ────────────────────────────────────────────────────

function emptyCategoryCounts(): Record<ScenarioCategory, number> {
  return {
    baseline: 0,
    business: 0,
    regulatory: 0,
    black_swan: 0,
  };
}

function emptyRegulatorCounts(): Record<ScenarioRegulator, number> {
  return {
    RBI: 0,
    IRDAI: 0,
    INTERNAL: 0,
  };
}

export function buildScenarioCoverageMatrix(): ScenarioCoverageMatrix {
  // Initialise the 12 cells.
  const cellByKey = new Map<string, MatrixCell>();
  for (const category of CATEGORIES) {
    for (const regulator of REGULATORS) {
      const key = cellKey(category, regulator);
      cellByKey.set(key, {
        category,
        regulator,
        count: 0,
        preset_ids: [],
        expected_min: EXPECTED_MIN_BY_CELL[key] ?? 0,
        is_gap: false,
      });
    }
  }

  const by_category = emptyCategoryCounts();
  const by_regulator = emptyRegulatorCounts();

  for (const preset of SCENARIO_PRESETS) {
    const key = cellKey(preset.category, preset.regulator);
    const cell = cellByKey.get(key);
    if (!cell) continue; // unknown enum — shouldn't happen
    cell.count++;
    cell.preset_ids.push(preset.id);
    by_category[preset.category]++;
    by_regulator[preset.regulator]++;
  }

  // Sort preset_ids + recompute is_gap.
  for (const cell of cellByKey.values()) {
    cell.preset_ids.sort();
    cell.is_gap = cell.expected_min > 0 && cell.count < cell.expected_min;
  }

  // Cells in declared order (category major, regulator minor).
  const cells: MatrixCell[] = [];
  for (const category of CATEGORIES) {
    for (const regulator of REGULATORS) {
      cells.push(cellByKey.get(cellKey(category, regulator))!);
    }
  }

  const gaps: CoverageGap[] = cells
    .filter((c) => c.is_gap)
    .map((c) => ({
      category: c.category,
      regulator: c.regulator,
      expected_min: c.expected_min,
      actual: c.count,
      shortfall: c.expected_min - c.count,
    }));
  // shortfall desc; tie-break category then regulator asc.
  gaps.sort((a, b) => {
    if (a.shortfall !== b.shortfall) return b.shortfall - a.shortfall;
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.regulator.localeCompare(b.regulator);
  });

  // Find most-populated cell.
  let mostPopulated: ScenarioCoverageMatrix['most_populated_cell'] = null;
  for (const cell of cells) {
    if (cell.count === 0) continue;
    if (!mostPopulated || cell.count > mostPopulated.count) {
      mostPopulated = {
        category: cell.category,
        regulator: cell.regulator,
        count: cell.count,
      };
    }
    // Iteration order is already declared-order so ties auto-resolve to
    // the first-seen cell, matching the documented "category asc then
    // regulator asc" rule.
  }

  return {
    total_presets: SCENARIO_PRESETS.length,
    cells,
    gaps,
    most_populated_cell: mostPopulated,
    by_category,
    by_regulator,
  };
}
