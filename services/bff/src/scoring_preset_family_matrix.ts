// services/bff/src/scoring_preset_family_matrix.ts
//
// T6 M6.18 — Library weight preset × indicator family cross-tab matrix.
//
// M6.3 ships the 6 named library weight presets (conservative / balanced
// / aggressive × banking / insurance), each with a sparse
// `weight_multipliers` map. M6.10 ships the per-indicator effective
// weights view. M6.15 ships preset inventory by (mode × vertical).
// M6.16 ships per-preset multiplier histogram. M6.17 ships the
// inverted indicator → presets cross-reference index.
//
// M6.18 ships the orthogonal preset × indicator-family cross-tab
// matrix combining the M6.3 preset list with the M6.2 indicator
// catalog's family axis. Rows = N library presets (open-axis,
// canonical preset_id asc) × cols = 9 closed indicator families
// (canonical FIN → BEH → TXN → CRD banking + POL → CUS-INS → AGT →
// CLM → OPS insurance order, mirrors M4.16 canonical family order).
//
// Cells = how many indicators in that family have an EXPLICIT
// multiplier in that preset (deviation from default 1.0). Balanced
// presets have empty multiplier maps → all-zero rows. Conservative +
// aggressive presets ship overrides per indicator.
//
// Distinct from M6.10 (per-indicator effective weights for ONE
// preset) — M6.17 elevates to fleet-wide PRESET × FAMILY pivot
// answering "which preset is most opinionated about TXN indicators?"
// + "is FIN well-covered across every conservative preset?" type
// governance views.
//
// Mirror of M1.11 / M14.28 / M12.14 / M3.14 / M15.14 / M8.14 matrix
// pattern combining open-axis (presets — N can grow with M6.4 custom
// presets in a future M6.18) × closed-axis (families). Platform-static
// — same response across tenants since both WEIGHT_PRESETS and
// STUB_CATALOG are platform data.

import {
  WEIGHT_PRESETS,
  type WeightPreset,
  type WeightPresetMode,
} from './scoring_presets';
import { STUB_CATALOG } from './bil_scoring_v2';
import { familyOf } from './indicator_catalog_stats';
import type { ScoringVertical } from './bil_scoring_v2';

// ─── Public types ──────────────────────────────────────────────────────

/** Canonical family order: banking families first (FIN → BEH → TXN →
 *  CRD), then insurance (POL → CUS-INS → AGT → CLM → OPS). Mirrors
 *  M4.16 ordering. */
export const ALL_INDICATOR_FAMILIES: readonly string[] = [
  'FIN',
  'BEH',
  'TXN',
  'CRD',
  'POL',
  'CUS-INS',
  'AGT',
  'CLM',
  'OPS',
] as const;

export interface PresetFamilyRow {
  preset_id: string;
  preset_name: string;
  mode: WeightPresetMode;
  vertical: ScoringVertical;
  total_overrides: number;
  /** Per-family override count; every family key at 0 when absent
   *  (stable grid). */
  by_family: Record<string, number>;
  /** Families with by_family=0 (canonical order — coverage gap per preset). */
  families_without: string[];
  /** Distinct families touched (0..9). */
  distinct_families: number;
}

export interface PresetFamilyColumn {
  family: string;
  /** Σ override counts across every preset. */
  total_overrides: number;
  /** Per-preset override count; only presets with > 0 override in this
   *  family appear (compact). */
  by_preset: Record<string, number>;
  /** Presets with by_preset=0 (canonical preset_id order — coverage
   *  gap per family). */
  presets_without: string[];
  /** Distinct presets touching this family. */
  distinct_presets: number;
}

export interface ScoringPresetFamilyMatrix {
  generated_at: string;
  total_presets: number;
  total_families: number;
  total_overrides: number;
  /** Per-preset rows in canonical preset_id asc order. */
  rows: PresetFamilyRow[];
  /** Per-family columns in canonical ALL_INDICATOR_FAMILIES order. */
  columns: PresetFamilyColumn[];
  /** Highest-count cell across the matrix; iteration: presets in
   *  canonical preset_id asc × families in canonical ALL_INDICATOR_FAMILIES
   *  order; null when zero overrides anywhere. */
  peak_cell: {
    preset_id: string;
    family: string;
    count: number;
  } | null;
  /** Preset with most distinct_families touched (most-focused preset
   *  surface); canonical preset_id asc tie-break; null when no overrides. */
  most_focused_preset: string | null;
  /** Family with most distinct presets touching it; canonical
   *  ALL_INDICATOR_FAMILIES order tie-break; null when no overrides. */
  most_overridden_family: string | null;
  /** Families with 0 overrides across ALL presets (canonical order —
   *  truly untouched families across the entire library). */
  unused_families: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByFamily(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of ALL_INDICATOR_FAMILIES) out[f] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildScoringPresetFamilyMatrix(
  now: Date,
): ScoringPresetFamilyMatrix {
  // Pre-compute family for each indicator in the catalog.
  const familyByIndicator: Record<string, string> = {};
  for (const indicator_id of Object.keys(STUB_CATALOG)) {
    familyByIndicator[indicator_id] = familyOf(indicator_id);
  }

  // cellCounts[preset_id][family] = count of overrides
  const cellCounts: Record<string, Record<string, number>> = {};

  // Sort presets by preset_id asc for canonical row order.
  const sortedPresets = [...WEIGHT_PRESETS].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  let total_overrides = 0;

  for (const preset of sortedPresets) {
    cellCounts[preset.id] = emptyByFamily();
    for (const indicator_id of Object.keys(preset.weight_multipliers)) {
      const family = familyByIndicator[indicator_id];
      if (!family) continue; // indicator not in catalog — skip defensively
      if (!ALL_INDICATOR_FAMILIES.includes(family)) continue;
      cellCounts[preset.id]![family]++;
      total_overrides++;
    }
  }

  // Build rows in canonical preset_id asc order.
  const rows: PresetFamilyRow[] = sortedPresets.map((preset) => {
    const cells = cellCounts[preset.id]!;
    const rowTotal = ALL_INDICATOR_FAMILIES.reduce(
      (acc, f) => acc + cells[f]!,
      0,
    );
    const families_without = ALL_INDICATOR_FAMILIES.filter(
      (f) => cells[f] === 0,
    );
    const distinct_families = ALL_INDICATOR_FAMILIES.length - families_without.length;
    return {
      preset_id: preset.id,
      preset_name: preset.name,
      mode: preset.mode,
      vertical: preset.vertical,
      total_overrides: rowTotal,
      by_family: { ...cells },
      families_without,
      distinct_families,
    };
  });

  // Build columns in canonical family order.
  const columns: PresetFamilyColumn[] = ALL_INDICATOR_FAMILIES.map((family) => {
    const by_preset: Record<string, number> = {};
    let total = 0;
    for (const preset of sortedPresets) {
      const c = cellCounts[preset.id]![family]!;
      if (c > 0) by_preset[preset.id] = c;
      total += c;
    }
    const presets_without = sortedPresets
      .filter((p) => (cellCounts[p.id]![family] ?? 0) === 0)
      .map((p) => p.id);
    const distinct_presets = Object.keys(by_preset).length;
    return {
      family,
      total_overrides: total,
      by_preset,
      presets_without,
      distinct_presets,
    };
  });

  // peak_cell — canonical preset asc × family canonical order iteration.
  let peak_cell: { preset_id: string; family: string; count: number } | null =
    null;
  let peakCount = 0;
  for (const preset of sortedPresets) {
    for (const family of ALL_INDICATOR_FAMILIES) {
      const c = cellCounts[preset.id]![family]!;
      if (c > peakCount) {
        peakCount = c;
        peak_cell = { preset_id: preset.id, family, count: c };
      }
    }
  }

  // most_focused_preset — highest distinct_families with canonical
  // preset_id asc tie-break.
  let most_focused_preset: string | null = null;
  if (total_overrides > 0) {
    const sortedByFocus = [...rows].sort((a, b) => {
      if (b.distinct_families !== a.distinct_families) {
        return b.distinct_families - a.distinct_families;
      }
      return a.preset_id.localeCompare(b.preset_id);
    });
    if (sortedByFocus[0].distinct_families > 0) {
      most_focused_preset = sortedByFocus[0].preset_id;
    }
  }

  // most_overridden_family — highest distinct_presets with canonical
  // family-order tie-break (already in canonical order via iteration).
  let most_overridden_family: string | null = null;
  if (total_overrides > 0) {
    let bestSpan = 0;
    for (const col of columns) {
      if (col.distinct_presets > bestSpan) {
        bestSpan = col.distinct_presets;
        most_overridden_family = col.family;
      }
    }
  }

  // unused_families — families with total=0 across ALL presets.
  const unused_families = columns
    .filter((c) => c.total_overrides === 0)
    .map((c) => c.family);

  return {
    generated_at: now.toISOString(),
    total_presets: sortedPresets.length,
    total_families: ALL_INDICATOR_FAMILIES.length,
    total_overrides,
    rows,
    columns,
    peak_cell,
    most_focused_preset,
    most_overridden_family,
    unused_families,
  };
}
