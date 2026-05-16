// services/bff/src/indicator_catalog_stats.ts
//
// T6 M4.13 — Indicator catalog statistics.
//
// M4.1 ships the BIL insurance KRI catalogue. M6.2 ships the
// BFF-side STUB_CATALOG mirror that the scoring path uses. M4.13
// is the platform-static analytics view over that mirror: per
// vertical, surface count + per-family breakdown + weight stats
// + top-3 heaviest indicators.
//
// Use case: BIL ops opens the SPA's indicator catalogue panel and
// wants the at-a-glance "what indicators do we have available?"
// shape — 8 banking across 4 families, 9 insurance across 5
// families, heaviest indicator CLM-001 (repeat-claim 180d) at 0.85.
//
// Family extraction: parse the id prefix before the LAST hyphen-
// followed-by-digits, so:
//   - "FIN-001"     → family "FIN"
//   - "CUS-INS-001" → family "CUS-INS"
//   - "POL-002"     → family "POL"
// This handles the multi-segment "CUS-INS" insurance prefix
// correctly without hardcoding the catalog.
//
// Pure rollup; platform-static (same response per tenant).

import { STUB_CATALOG, type ScoringVertical } from './bil_scoring_v2';

// ─── Constants ────────────────────────────────────────────────────────

export const ALL_INDICATOR_VERTICALS: readonly ScoringVertical[] = [
  'banking',
  'insurance',
] as const;

const TOP_WEIGHTED_CAP = 3;

// ─── Public types ─────────────────────────────────────────────────────

export interface WeightStats {
  min: number;
  /** Mean to 4 decimal places. */
  mean: number;
  max: number;
}

export interface TopIndicatorRow {
  indicator_id: string;
  name: string;
  weight: number;
}

export interface IndicatorVerticalRow {
  vertical: ScoringVertical;
  count: number;
  /** Family → count. Family is the id prefix before -NNN. Insurance
   *  customer ids ("CUS-INS-001") deliberately retain the two-segment
   *  family "CUS-INS". */
  by_family: Record<string, number>;
  /** Number of distinct family prefixes. */
  distinct_families: number;
  /** Weight statistics across all indicators of this vertical.
   *  null when count = 0. */
  weight: WeightStats | null;
  /** Top-3 indicators by weight desc with id asc tie-break. */
  top_weighted: TopIndicatorRow[];
}

export interface IndicatorCatalogStatsSummary {
  generated_at: string;
  total_indicators: number;
  total_distinct_families: number;
  /** Every vertical in canonical ALL_INDICATOR_VERTICALS order even
   *  when zero-count. */
  verticals: IndicatorVerticalRow[];
  /** Highest count vertical. Canonical tie-break (banking wins over
   *  insurance at same count). null when no indicators. */
  most_populated_vertical: ScoringVertical | null;
  /** Highest-weight indicator across the entire catalog. Tie-broken
   *  by indicator_id asc. null when empty. */
  heaviest_indicator: TopIndicatorRow | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract the family prefix from an indicator id. Rule: strip the
 * trailing `-NNN…` numeric segment.
 *   "FIN-001"     → "FIN"
 *   "CUS-INS-001" → "CUS-INS"
 *   "BAD"         → "BAD"     (no numeric suffix; whole id is the family)
 */
export function familyOf(indicator_id: string): string {
  const match = indicator_id.match(/^(.+)-\d+$/);
  return match ? match[1]! : indicator_id;
}

function roundN(n: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeIndicatorCatalog(now: Date): IndicatorCatalogStatsSummary {
  // Group by vertical first.
  const byVertical = new Map<ScoringVertical, Array<{ id: string; name: string; weight: number }>>();
  for (const v of ALL_INDICATOR_VERTICALS) byVertical.set(v, []);

  for (const [id, entry] of Object.entries(STUB_CATALOG)) {
    const arr = byVertical.get(entry.vertical);
    if (!arr) continue;
    arr.push({ id, name: entry.name, weight: entry.weight });
  }

  const verticalsOutput: IndicatorVerticalRow[] = [];
  const allFamilies = new Set<string>();
  let heaviest: { id: string; name: string; weight: number } | null = null;

  for (const vertical of ALL_INDICATOR_VERTICALS) {
    const items = byVertical.get(vertical)!;
    const by_family: Record<string, number> = {};
    const familySet = new Set<string>();
    let minW = Infinity;
    let maxW = -Infinity;
    let sumW = 0;

    for (const item of items) {
      const fam = familyOf(item.id);
      by_family[fam] = (by_family[fam] ?? 0) + 1;
      familySet.add(fam);
      allFamilies.add(fam);
      if (item.weight < minW) minW = item.weight;
      if (item.weight > maxW) maxW = item.weight;
      sumW += item.weight;
      if (
        !heaviest
        || item.weight > heaviest.weight
        || (item.weight === heaviest.weight && item.id < heaviest.id)
      ) {
        heaviest = { id: item.id, name: item.name, weight: item.weight };
      }
    }

    const top_weighted = [...items]
      .sort((a, b) => {
        if (b.weight !== a.weight) return b.weight - a.weight;
        return a.id.localeCompare(b.id);
      })
      .slice(0, TOP_WEIGHTED_CAP)
      .map((it) => ({ indicator_id: it.id, name: it.name, weight: it.weight }));

    const weight: WeightStats | null = items.length > 0
      ? { min: minW, mean: roundN(sumW / items.length, 4), max: maxW }
      : null;

    verticalsOutput.push({
      vertical,
      count: items.length,
      by_family,
      distinct_families: familySet.size,
      weight,
      top_weighted,
    });
  }

  const total_indicators = verticalsOutput.reduce((acc, v) => acc + v.count, 0);

  // most_populated_vertical: highest count with canonical-order tie-break.
  let most_populated_vertical: ScoringVertical | null = null;
  let mostCount = 0;
  for (const v of ALL_INDICATOR_VERTICALS) {
    const row = verticalsOutput.find((r) => r.vertical === v)!;
    if (row.count > mostCount) {
      mostCount = row.count;
      most_populated_vertical = v;
    }
  }
  if (mostCount === 0) most_populated_vertical = null;

  return {
    generated_at: now.toISOString(),
    total_indicators,
    total_distinct_families: allFamilies.size,
    verticals: verticalsOutput,
    most_populated_vertical,
    heaviest_indicator: heaviest
      ? { indicator_id: heaviest.id, name: heaviest.name, weight: heaviest.weight }
      : null,
  };
}
