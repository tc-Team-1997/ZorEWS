// services/bff/src/indicator_override_vertical_family_matrix.ts
//
// T6 M4.17 — Indicator threshold override vertical × family cross-tab.
//
// M4.4 ships the per-tenant threshold override store. M4.12 ships
// drift analytics (per-override). M4.13 catalog stats. M4.14 band-gap
// scorecard. M4.15 weight histogram. M4.16 vertical × family matrix
// over the platform CATALOG.
//
// M4.17 ships the orthogonal vertical × family matrix over the per-
// tenant OVERRIDE store (vs M4.16's catalog surface). Same axes
// (CLOSED 2 ScoringVertical × CLOSED 9 IndicatorFamily) — different
// data source. Drives BIL ops "which (vertical, family) combinations
// do operators most often override? are there families that never
// see overrides at this tenant?" governance views.
//
// Per-row {vertical, total_overrides, by_family (9 keys at 0 — stable
// grid), families_without[] canonical, indicator_ids[] sorted asc,
// distinct_families}. Per-col {family, total_overrides, by_vertical
// (2 keys at 0), verticals_without[] canonical, indicator_ids[]
// sorted asc, distinct_verticals}.
//
// Envelope: peak_cell (canonical iteration tie-break) +
// most_overridden_family (most distinct verticals touching it) +
// most_active_vertical (most distinct families overridden under it) +
// empty_cells[] canonical. Defensive: indicators with unknown family
// surface in `unknown_families[]`.
//
// Mirror of M4.16 (catalog vertical × family) for the override surface.

import {
  type IndicatorThreshold,
  type ThresholdOverrideStore,
} from './indicator_thresholds';
import { ALL_INDICATOR_VERTICALS } from './indicator_catalog_stats';
import { familyOf } from './indicator_catalog_stats';
import { ALL_INDICATOR_FAMILIES } from './scoring_preset_family_matrix';
import type { ScoringVertical } from './bil_scoring_v2';

// ─── Public types ──────────────────────────────────────────────────────

export interface OverrideVerticalRow {
  vertical: ScoringVertical;
  total_overrides: number;
  by_family: Record<string, number>;
  families_without: string[];
  indicator_ids: string[];
  distinct_families: number;
}

export interface OverrideFamilyColumn {
  family: string;
  total_overrides: number;
  by_vertical: Record<ScoringVertical, number>;
  verticals_without: ScoringVertical[];
  indicator_ids: string[];
  distinct_verticals: number;
}

export interface IndicatorOverrideVerticalFamilyMatrix {
  tenant_id: string;
  generated_at: string;
  total_overrides: number;
  total_verticals: number; // = 2
  total_families: number; // = 9
  rows: OverrideVerticalRow[];
  columns: OverrideFamilyColumn[];
  /** Highest cell across the matrix; canonical iteration tie-break —
   *  verticals in ALL_INDICATOR_VERTICALS order × families in
   *  ALL_INDICATOR_FAMILIES order; null on empty. */
  peak_cell: {
    vertical: ScoringVertical;
    family: string;
    count: number;
  } | null;
  /** Family with most distinct non-zero by_vertical entries; canonical
   *  ALL_INDICATOR_FAMILIES tie-break; null on empty. */
  most_overridden_family: string | null;
  /** Vertical with most distinct non-zero by_family entries; canonical
   *  ALL_INDICATOR_VERTICALS tie-break; null on empty. */
  most_active_vertical: ScoringVertical | null;
  /** (vertical, family) cells with count=0 in canonical row-major
   *  order. */
  empty_cells: Array<{ vertical: ScoringVertical; family: string }>;
  /** indicator_ids with family prefix NOT in ALL_INDICATOR_FAMILIES —
   *  catalog drift detector. Sorted asc. */
  unknown_families: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByFamily(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of ALL_INDICATOR_FAMILIES) out[f] = 0;
  return out;
}

function emptyByVertical(): Record<ScoringVertical, number> {
  const out = {} as Record<ScoringVertical, number>;
  for (const v of ALL_INDICATOR_VERTICALS) out[v] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildIndicatorOverrideVerticalFamilyMatrix(
  tenant_id: string,
  overrides: readonly IndicatorThreshold[],
  now: Date,
): IndicatorOverrideVerticalFamilyMatrix {
  // cellCounts[vertical][family] = { count, indicator_ids: string[] }
  type Cell = { count: number; indicator_ids: string[] };
  const cellCounts: Record<ScoringVertical, Record<string, Cell>> = {} as never;
  for (const v of ALL_INDICATOR_VERTICALS) {
    cellCounts[v] = {} as Record<string, Cell>;
    for (const f of ALL_INDICATOR_FAMILIES) {
      cellCounts[v][f] = { count: 0, indicator_ids: [] };
    }
  }

  const unknown_families_set = new Set<string>();
  let total_overrides = 0;

  for (const ov of overrides) {
    if (!ALL_INDICATOR_VERTICALS.includes(ov.vertical)) continue;
    const family = familyOf(ov.indicator_id);
    if (!ALL_INDICATOR_FAMILIES.includes(family)) {
      unknown_families_set.add(ov.indicator_id);
      continue;
    }
    total_overrides++;
    const cell = cellCounts[ov.vertical][family];
    cell.count++;
    cell.indicator_ids.push(ov.indicator_id);
  }

  // Build rows in canonical vertical order.
  const rows: OverrideVerticalRow[] = ALL_INDICATOR_VERTICALS.map((vertical) => {
    const by_family = emptyByFamily();
    let total = 0;
    const indicator_ids: string[] = [];
    for (const family of ALL_INDICATOR_FAMILIES) {
      const cell = cellCounts[vertical][family];
      by_family[family] = cell.count;
      total += cell.count;
      indicator_ids.push(...cell.indicator_ids);
    }
    indicator_ids.sort((a, b) => a.localeCompare(b));
    const families_without = ALL_INDICATOR_FAMILIES.filter(
      (f) => by_family[f] === 0,
    );
    return {
      vertical,
      total_overrides: total,
      by_family,
      families_without,
      indicator_ids,
      distinct_families: ALL_INDICATOR_FAMILIES.length - families_without.length,
    };
  });

  // Build columns in canonical family order.
  const columns: OverrideFamilyColumn[] = ALL_INDICATOR_FAMILIES.map((family) => {
    const by_vertical = emptyByVertical();
    let total = 0;
    const indicator_ids: string[] = [];
    for (const vertical of ALL_INDICATOR_VERTICALS) {
      const cell = cellCounts[vertical][family];
      by_vertical[vertical] = cell.count;
      total += cell.count;
      indicator_ids.push(...cell.indicator_ids);
    }
    indicator_ids.sort((a, b) => a.localeCompare(b));
    const verticals_without = ALL_INDICATOR_VERTICALS.filter(
      (v) => by_vertical[v] === 0,
    );
    return {
      family,
      total_overrides: total,
      by_vertical,
      verticals_without,
      indicator_ids,
      distinct_verticals: ALL_INDICATOR_VERTICALS.length - verticals_without.length,
    };
  });

  // peak_cell — canonical iteration tie-break.
  let peak_cell:
    | { vertical: ScoringVertical; family: string; count: number }
    | null = null;
  let peakCount = 0;
  for (const vertical of ALL_INDICATOR_VERTICALS) {
    for (const family of ALL_INDICATOR_FAMILIES) {
      const c = cellCounts[vertical][family].count;
      if (c > peakCount) {
        peakCount = c;
        peak_cell = { vertical, family, count: c };
      }
    }
  }

  // most_overridden_family — most distinct non-zero by_vertical entries.
  let most_overridden_family: string | null = null;
  let bestFam = 0;
  for (const col of columns) {
    const distinct = ALL_INDICATOR_VERTICALS.filter(
      (v) => col.by_vertical[v] > 0,
    ).length;
    if (distinct > bestFam) {
      bestFam = distinct;
      most_overridden_family = col.family;
    }
  }

  // most_active_vertical — most distinct non-zero by_family entries.
  let most_active_vertical: ScoringVertical | null = null;
  let bestVert = 0;
  for (const row of rows) {
    const distinct = ALL_INDICATOR_FAMILIES.filter(
      (f) => row.by_family[f] > 0,
    ).length;
    if (distinct > bestVert) {
      bestVert = distinct;
      most_active_vertical = row.vertical;
    }
  }

  // empty_cells — canonical vertical × family row-major.
  const empty_cells: Array<{ vertical: ScoringVertical; family: string }> = [];
  for (const vertical of ALL_INDICATOR_VERTICALS) {
    for (const family of ALL_INDICATOR_FAMILIES) {
      if (cellCounts[vertical][family].count === 0) {
        empty_cells.push({ vertical, family });
      }
    }
  }

  const unknown_families = [...unknown_families_set].sort((a, b) =>
    a.localeCompare(b),
  );

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_overrides,
    total_verticals: ALL_INDICATOR_VERTICALS.length,
    total_families: ALL_INDICATOR_FAMILIES.length,
    rows,
    columns,
    peak_cell,
    most_overridden_family,
    most_active_vertical,
    empty_cells,
    unknown_families,
  };
}

/** Convenience: drain the M4.4 override store then summarize. */
export function buildIndicatorOverrideVerticalFamilyMatrixFromStore(
  store: ThresholdOverrideStore,
  tenant_id: string,
  now: Date,
): IndicatorOverrideVerticalFamilyMatrix {
  const overrides = store.listOverrides(tenant_id);
  return buildIndicatorOverrideVerticalFamilyMatrix(tenant_id, overrides, now);
}
