// services/bff/src/scoring_preset_inventory.ts
//
// T6 M6.15 — Preset inventory cross-tab (library + custom by mode × vertical).
//
// M6.3 ships 6 named library presets (conservative/balanced/aggressive
// × banking/insurance). M6.4 ships per-tenant custom CRUD. M6.15 lands
// the 2D inventory pivot: rows = WeightPresetMode, cols = ScoringVertical,
// per-cell library + custom counts.
//
// Use case: BIL ops opens the scoring presets panel and wants to
// answer "is the catalogue balanced across modes/verticals? have ops
// added custom presets in cells the library already covers, or in
// cells the library misses?" Answers both questions in one round-trip.
//
// Mirror of M3.11 type matrix + M9.13 age × status matrix pattern.
// Pure rollup; reads library at import-time + custom from passed store.

import type { CustomWeightPresetStore } from './scoring_presets_custom';
import {
  VALID_PRESET_MODES,
  WEIGHT_PRESETS,
  type WeightPreset,
  type WeightPresetMode,
} from './scoring_presets';
import type { ScoringVertical } from './bil_scoring_v2';

// ─── Constants ────────────────────────────────────────────────────────

export const ALL_PRESET_VERTICALS: readonly ScoringVertical[] = [
  'banking',
  'insurance',
] as const;

// ─── Public types ─────────────────────────────────────────────────────

export interface PresetInventoryCell {
  mode: WeightPresetMode;
  vertical: ScoringVertical;
  library_count: number;
  custom_count: number;
  total_count: number;
  /** Library preset ids contributing to this cell. Sorted asc. */
  library_preset_ids: string[];
  /** Custom preset ids contributing to this cell. Sorted asc. */
  custom_preset_ids: string[];
}

export interface PresetInventorySummary {
  tenant_id: string;
  generated_at: string;
  total_library_presets: number;
  total_custom_presets: number;
  /** Always 6 entries: 3 modes × 2 verticals in canonical row-major
   *  (mode major, vertical minor) order. */
  cells: PresetInventoryCell[];
  /** Per-mode total (library + custom). 3 keys, all present. */
  by_mode: Record<WeightPresetMode, number>;
  /** Per-vertical total. 2 keys, all present. */
  by_vertical: Record<ScoringVertical, number>;
  /** Mode with the most custom presets. Tie-broken by canonical
   *  VALID_PRESET_MODES order (conservative wins). null when no
   *  custom presets in the tenant. */
  most_customised_mode: {
    mode: WeightPresetMode;
    custom_count: number;
  } | null;
  /** Cells with library_count=0. Should be empty for a complete catalog.
   *  Sorted by canonical (mode, vertical) order. */
  uncovered_cells: Array<{ mode: WeightPresetMode; vertical: ScoringVertical }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByMode(): Record<WeightPresetMode, number> {
  return { conservative: 0, balanced: 0, aggressive: 0 };
}

function emptyByVertical(): Record<ScoringVertical, number> {
  return { banking: 0, insurance: 0 };
}

function emptyCell(mode: WeightPresetMode, vertical: ScoringVertical): PresetInventoryCell {
  return {
    mode,
    vertical,
    library_count: 0,
    custom_count: 0,
    total_count: 0,
    library_preset_ids: [],
    custom_preset_ids: [],
  };
}

function cellKey(mode: WeightPresetMode, vertical: ScoringVertical): string {
  return `${mode}|${vertical}`;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizePresetInventory(
  tenant_id: string,
  customStore: CustomWeightPresetStore,
  now: Date,
): PresetInventorySummary {
  // Initialise the 6 cells in canonical row-major order (mode major,
  // vertical minor) so the SPA renders a stable 2D grid.
  const cellByKey = new Map<string, PresetInventoryCell>();
  const cells: PresetInventoryCell[] = [];
  for (const mode of VALID_PRESET_MODES) {
    for (const vertical of ALL_PRESET_VERTICALS) {
      const cell = emptyCell(mode, vertical);
      cellByKey.set(cellKey(mode, vertical), cell);
      cells.push(cell);
    }
  }

  // Tally library presets.
  for (const preset of WEIGHT_PRESETS) {
    const cell = cellByKey.get(cellKey(preset.mode, preset.vertical));
    if (!cell) continue; // unknown mode/vertical — shouldn't happen
    cell.library_count++;
    cell.library_preset_ids.push(preset.id);
  }

  // Tally tenant custom presets.
  const customPresets = customStore.list(tenant_id);
  for (const preset of customPresets) {
    const cell = cellByKey.get(cellKey(preset.mode, preset.vertical));
    if (!cell) continue;
    cell.custom_count++;
    cell.custom_preset_ids.push(preset.id);
  }

  // Finalise per-cell: totals + sort ids asc.
  const by_mode = emptyByMode();
  const by_vertical = emptyByVertical();
  for (const cell of cells) {
    cell.library_preset_ids.sort();
    cell.custom_preset_ids.sort();
    cell.total_count = cell.library_count + cell.custom_count;
    by_mode[cell.mode] += cell.total_count;
    by_vertical[cell.vertical] += cell.total_count;
  }

  // most_customised_mode: highest custom-count mode (canonical tie-break).
  let most_customised_mode: PresetInventorySummary['most_customised_mode'] = null;
  let mostCustom = 0;
  for (const mode of VALID_PRESET_MODES) {
    let modeCustom = 0;
    for (const vertical of ALL_PRESET_VERTICALS) {
      modeCustom += cellByKey.get(cellKey(mode, vertical))!.custom_count;
    }
    if (modeCustom > mostCustom) {
      mostCustom = modeCustom;
      most_customised_mode = { mode, custom_count: modeCustom };
    }
  }
  if (mostCustom === 0) most_customised_mode = null;

  const uncovered_cells = cells
    .filter((c) => c.library_count === 0)
    .map((c) => ({ mode: c.mode, vertical: c.vertical }));

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_library_presets: WEIGHT_PRESETS.length,
    total_custom_presets: customPresets.length,
    cells,
    by_mode,
    by_vertical,
    most_customised_mode,
    uncovered_cells,
  };
}
