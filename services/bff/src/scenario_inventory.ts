// services/bff/src/scenario_inventory.ts
//
// T6 M16.19 — Scenario inventory cross-tab (library + custom by category × severity).
//
// M16.17 ships the category × regulator coverage matrix.
// M16.19 ships the orthogonal category × SEVERITY view answering
// "do we have a severe-stress preset for every category?" + "where
// have ops added customs that the library missed?".
//
// Mirror of M6.15 preset inventory + M9.13 age × status pattern.
// Per-cell library + custom counts so the SPA can render library-
// coverage badges alongside tenant-custom badges in one grid.
//
// Pure rollup; library is platform-static + custom is tenant-scoped
// via the passed CustomPresetStore.

import { SCENARIO_PRESETS, type ScenarioPreset } from './scenario_library';
import type { CustomPresetStore } from './scenario_custom';

// ─── Constants ────────────────────────────────────────────────────────

export const ALL_SCENARIO_CATEGORIES: readonly ScenarioPreset['category'][] = [
  'regulatory',
  'business',
  'black_swan',
  'baseline',
] as const;

export const ALL_SCENARIO_SEVERITIES: readonly ScenarioPreset['severity'][] = [
  'mild',
  'moderate',
  'severe',
] as const;

type Category = (typeof ALL_SCENARIO_CATEGORIES)[number];
type Severity = (typeof ALL_SCENARIO_SEVERITIES)[number];

// ─── Public types ─────────────────────────────────────────────────────

export interface InventoryCell {
  category: Category;
  severity: Severity;
  library_count: number;
  custom_count: number;
  total_count: number;
  /** Library preset ids in this cell. Sorted asc. */
  library_preset_ids: string[];
  /** Custom preset ids in this cell. Sorted asc. */
  custom_preset_ids: string[];
}

export interface ScenarioInventorySummary {
  tenant_id: string;
  generated_at: string;
  total_library_presets: number;
  total_custom_presets: number;
  /** 12 cells in canonical row-major order (category major,
   *  severity minor). Always present. */
  cells: InventoryCell[];
  /** Per-category total (library + custom). 4 keys, all present. */
  by_category: Record<Category, number>;
  /** Per-severity total. 3 keys, all present. */
  by_severity: Record<Severity, number>;
  /** Highest total_count cell. Canonical row-major iteration
   *  tie-break (earlier category × earlier severity wins). null
   *  when no presets in the whole catalog. */
  most_populated_cell: {
    category: Category;
    severity: Severity;
    total_count: number;
  } | null;
  /** Category with the most custom presets. Canonical
   *  ALL_SCENARIO_CATEGORIES tie-break (regulatory wins). null
   *  when no customs. */
  most_customised_category: {
    category: Category;
    custom_count: number;
  } | null;
  /** Cells with library_count=0. Library coverage gaps that the
   *  catalog could fill. Canonical row-major order. */
  uncovered_cells: Array<{ category: Category; severity: Severity }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByCategory(): Record<Category, number> {
  return { regulatory: 0, business: 0, black_swan: 0, baseline: 0 };
}

function emptyBySeverity(): Record<Severity, number> {
  return { mild: 0, moderate: 0, severe: 0 };
}

function emptyCell(category: Category, severity: Severity): InventoryCell {
  return {
    category,
    severity,
    library_count: 0,
    custom_count: 0,
    total_count: 0,
    library_preset_ids: [],
    custom_preset_ids: [],
  };
}

function cellKey(c: Category, s: Severity): string {
  return `${c}|${s}`;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeScenarioInventory(
  tenant_id: string,
  customStore: CustomPresetStore,
  now: Date,
): ScenarioInventorySummary {
  // Build the 12 cells in canonical row-major order.
  const cellByKey = new Map<string, InventoryCell>();
  const cells: InventoryCell[] = [];
  for (const cat of ALL_SCENARIO_CATEGORIES) {
    for (const sev of ALL_SCENARIO_SEVERITIES) {
      const cell = emptyCell(cat, sev);
      cellByKey.set(cellKey(cat, sev), cell);
      cells.push(cell);
    }
  }

  // Tally library presets.
  for (const preset of SCENARIO_PRESETS) {
    const cell = cellByKey.get(cellKey(preset.category, preset.severity));
    if (!cell) continue;
    cell.library_count++;
    cell.library_preset_ids.push(preset.id);
  }

  // Tally tenant custom presets.
  const customPresets = customStore.list(tenant_id);
  for (const preset of customPresets) {
    const cell = cellByKey.get(cellKey(preset.category, preset.severity));
    if (!cell) continue;
    cell.custom_count++;
    cell.custom_preset_ids.push(preset.id);
  }

  // Finalise: sort ids + totals + marginals.
  const by_category = emptyByCategory();
  const by_severity = emptyBySeverity();
  for (const cell of cells) {
    cell.library_preset_ids.sort();
    cell.custom_preset_ids.sort();
    cell.total_count = cell.library_count + cell.custom_count;
    by_category[cell.category] += cell.total_count;
    by_severity[cell.severity] += cell.total_count;
  }

  // most_populated_cell: highest total_count, canonical iteration tie-break.
  let most_populated_cell: ScenarioInventorySummary['most_populated_cell'] = null;
  let peakTotal = 0;
  for (const cat of ALL_SCENARIO_CATEGORIES) {
    for (const sev of ALL_SCENARIO_SEVERITIES) {
      const cell = cellByKey.get(cellKey(cat, sev))!;
      if (cell.total_count > peakTotal) {
        peakTotal = cell.total_count;
        most_populated_cell = {
          category: cat,
          severity: sev,
          total_count: cell.total_count,
        };
      }
    }
  }
  if (peakTotal === 0) most_populated_cell = null;

  // most_customised_category: highest per-category custom count,
  // canonical ALL_SCENARIO_CATEGORIES tie-break.
  let most_customised_category: ScenarioInventorySummary['most_customised_category'] = null;
  let mostCustom = 0;
  for (const cat of ALL_SCENARIO_CATEGORIES) {
    let catCustom = 0;
    for (const sev of ALL_SCENARIO_SEVERITIES) {
      catCustom += cellByKey.get(cellKey(cat, sev))!.custom_count;
    }
    if (catCustom > mostCustom) {
      mostCustom = catCustom;
      most_customised_category = { category: cat, custom_count: catCustom };
    }
  }
  if (mostCustom === 0) most_customised_category = null;

  const uncovered_cells = cells
    .filter((c) => c.library_count === 0)
    .map((c) => ({ category: c.category, severity: c.severity }));

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_library_presets: SCENARIO_PRESETS.length,
    total_custom_presets: customPresets.length,
    cells,
    by_category,
    by_severity,
    most_populated_cell,
    most_customised_category,
    uncovered_cells,
  };
}
