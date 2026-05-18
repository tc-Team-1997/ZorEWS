// services/bff/src/indicator_vertical_family_matrix.ts
//
// T6 M4.16 — Indicator vertical × family cross-tab matrix.
//
// M4.13 ships catalog statistics with by_family NESTED inside each
// vertical row. M4.16 elevates this to a proper 2D pivot: rows =
// 2 ScoringVerticals (banking + insurance) × cols = 9 declared
// families (FIN, BEH, TXN, CRD on banking side; POL, CUS-INS, AGT,
// CLM, OPS on insurance side) = 18 cells.
//
// Each indicator in STUB_CATALOG lives in exactly one cell (its
// vertical + its family prefix). The cross-tab makes "which family is
// only used by banking?" and "are there banking-side claim
// indicators?" questions answerable in one round-trip.
//
// Family extraction uses the same regex as M4.13 (`^(.+)-\d+$` —
// strips trailing `-NNN`; handles multi-segment prefixes like
// CUS-INS-001).
//
// Mirror of M14.28 / M12.14 / M3.14 / M5.17 / M7.14 / M8.14 / M15.14
// matrix pattern for the indicator catalog surface.
//
// Platform-static — same response across tenants.

import { STUB_CATALOG, type ScoringVertical } from './bil_scoring_v2';

// ─── Canonical enums ───────────────────────────────────────────────────

const ALL_VERTICALS: readonly ScoringVertical[] = ['banking', 'insurance'] as const;

/** Canonical family order — banking families first (in declared M4.13
 *  order), then insurance families. New families would be appended
 *  here; out-of-enum families surface in `unknown_families[]`. */
export const ALL_INDICATOR_FAMILIES = [
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

export type IndicatorFamily = (typeof ALL_INDICATOR_FAMILIES)[number];

const FAMILY_SET = new Set<string>(ALL_INDICATOR_FAMILIES);

function familyOf(indicator_id: string): string | null {
  const match = /^(.+)-\d+$/.exec(indicator_id);
  return match ? match[1] : null;
}

// ─── Public types ──────────────────────────────────────────────────────

export interface IndicatorVerticalFamilyRow {
  vertical: ScoringVertical;
  total: number;
  /** Per-family counts; every canonical family present at 0 when absent. */
  by_family: Record<IndicatorFamily, number>;
  /** Families with by_family=0 for this vertical, in canonical order. */
  families_without: IndicatorFamily[];
}

export interface IndicatorVerticalFamilyColumn {
  family: IndicatorFamily;
  total: number;
  /** Per-vertical counts; every vertical present at 0 when absent. */
  by_vertical: Record<ScoringVertical, number>;
  /** Verticals with by_vertical=0 for this family. */
  verticals_without: ScoringVertical[];
}

export interface IndicatorVerticalFamilyCell {
  vertical: ScoringVertical;
  family: IndicatorFamily;
}

export interface IndicatorVerticalFamilyPeakCell extends IndicatorVerticalFamilyCell {
  count: number;
  /** Indicator ids contributing to this cell (sorted asc, no cap). */
  indicator_ids: string[];
}

export interface IndicatorVerticalFamilyMatrix {
  generated_at: string;
  total_indicators: number;
  total_verticals: number;
  total_families: number;
  rows: IndicatorVerticalFamilyRow[];
  columns: IndicatorVerticalFamilyColumn[];
  /** Highest-count cell; canonical iteration tie-break (vertical major
   *  in ALL_VERTICALS order × family minor in ALL_INDICATOR_FAMILIES);
   *  null on empty catalog. */
  peak_cell: IndicatorVerticalFamilyPeakCell | null;
  /** Cells with count=0 in canonical vertical × family row-major order. */
  empty_cells: IndicatorVerticalFamilyCell[];
  /** Vertical with the most distinct non-zero families; canonical
   *  vertical-order tie-break: banking beats insurance at tied span. */
  most_diverse_vertical: ScoringVertical | null;
  /** Family with the most distinct non-zero verticals; canonical
   *  family-order tie-break. */
  most_universal_family: IndicatorFamily | null;
  /** Indicator IDs with a family prefix NOT in ALL_INDICATOR_FAMILIES
   *  (defensive — would catch catalog drift). Sorted asc. */
  unknown_families: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByFamily(): Record<IndicatorFamily, number> {
  const out = {} as Record<IndicatorFamily, number>;
  for (const f of ALL_INDICATOR_FAMILIES) out[f] = 0;
  return out;
}

function emptyByVertical(): Record<ScoringVertical, number> {
  return { banking: 0, insurance: 0 };
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildIndicatorVerticalFamilyMatrix(
  now: Date,
): IndicatorVerticalFamilyMatrix {
  // cellCounts[vertical][family] = count
  // cellIds[vertical][family] = indicator_ids[] (collected for peak_cell)
  const cellCounts: Record<ScoringVertical, Record<IndicatorFamily, number>> = {
    banking: emptyByFamily(),
    insurance: emptyByFamily(),
  };
  const cellIds: Record<ScoringVertical, Record<IndicatorFamily, string[]>> = {
    banking: {} as Record<IndicatorFamily, string[]>,
    insurance: {} as Record<IndicatorFamily, string[]>,
  };
  for (const v of ALL_VERTICALS) {
    for (const f of ALL_INDICATOR_FAMILIES) {
      cellIds[v][f] = [];
    }
  }

  const unknown_families_set = new Set<string>();
  let total_indicators = 0;

  for (const [id, entry] of Object.entries(STUB_CATALOG)) {
    if (!ALL_VERTICALS.includes(entry.vertical)) continue;
    const fam = familyOf(id);
    if (!fam || !FAMILY_SET.has(fam)) {
      unknown_families_set.add(id);
      continue;
    }
    const family = fam as IndicatorFamily;
    cellCounts[entry.vertical][family]++;
    cellIds[entry.vertical][family].push(id);
    total_indicators++;
  }

  // Per-row projections.
  const rows: IndicatorVerticalFamilyRow[] = ALL_VERTICALS.map((v) => {
    const by_family = cellCounts[v];
    const total = ALL_INDICATOR_FAMILIES.reduce(
      (acc, f) => acc + by_family[f],
      0,
    );
    const families_without = ALL_INDICATOR_FAMILIES.filter(
      (f) => by_family[f] === 0,
    );
    return { vertical: v, total, by_family: { ...by_family }, families_without };
  });

  // Per-column projections.
  const columns: IndicatorVerticalFamilyColumn[] = ALL_INDICATOR_FAMILIES.map((f) => {
    const by_vertical = emptyByVertical();
    let total = 0;
    for (const v of ALL_VERTICALS) {
      by_vertical[v] = cellCounts[v][f];
      total += by_vertical[v];
    }
    const verticals_without = ALL_VERTICALS.filter(
      (v) => by_vertical[v] === 0,
    );
    return { family: f, total, by_vertical, verticals_without };
  });

  // peak_cell — highest count + canonical iteration tie-break.
  let peak_cell: IndicatorVerticalFamilyPeakCell | null = null;
  let peakCount = 0;
  for (const v of ALL_VERTICALS) {
    for (const f of ALL_INDICATOR_FAMILIES) {
      const c = cellCounts[v][f];
      if (c > peakCount) {
        peakCount = c;
        peak_cell = {
          vertical: v,
          family: f,
          count: c,
          indicator_ids: [...cellIds[v][f]].sort(),
        };
      }
    }
  }
  if (peakCount === 0) peak_cell = null;

  // empty_cells — canonical row-major order.
  const empty_cells: IndicatorVerticalFamilyCell[] = [];
  for (const v of ALL_VERTICALS) {
    for (const f of ALL_INDICATOR_FAMILIES) {
      if (cellCounts[v][f] === 0) {
        empty_cells.push({ vertical: v, family: f });
      }
    }
  }

  // most_diverse_vertical — vertical with most non-zero by_family entries.
  let most_diverse_vertical: ScoringVertical | null = null;
  let maxSpan = 0;
  for (const v of ALL_VERTICALS) {
    const span = ALL_INDICATOR_FAMILIES.filter((f) => cellCounts[v][f] > 0).length;
    if (span > maxSpan) {
      maxSpan = span;
      most_diverse_vertical = v;
    }
  }
  if (maxSpan === 0) most_diverse_vertical = null;

  // most_universal_family — family with most non-zero by_vertical entries.
  let most_universal_family: IndicatorFamily | null = null;
  let maxFamSpan = 0;
  for (const f of ALL_INDICATOR_FAMILIES) {
    const span = ALL_VERTICALS.filter((v) => cellCounts[v][f] > 0).length;
    if (span > maxFamSpan) {
      maxFamSpan = span;
      most_universal_family = f;
    }
  }
  if (maxFamSpan === 0) most_universal_family = null;

  return {
    generated_at: now.toISOString(),
    total_indicators,
    total_verticals: ALL_VERTICALS.length,
    total_families: ALL_INDICATOR_FAMILIES.length,
    rows,
    columns,
    peak_cell,
    empty_cells,
    most_diverse_vertical,
    most_universal_family,
    unknown_families: [...unknown_families_set].sort(),
  };
}
