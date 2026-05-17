// services/bff/src/indicator_threshold_band_gap.ts
//
// T6 M4.14 — Indicator threshold band-gap quality scorecard.
//
// M4.3 ships threshold breach detection. M4.4 ships per-tenant
// overrides. M4.9 ships effective view. M4.10 ships auto-tune.
// M4.11 ships usage map. M4.12 ships drift analytics.
//
// M4.14 lands the THRESHOLD QUALITY AUDIT — per-indicator scorecard
// that flags suspicious threshold shapes: bands that are too tight
// (yellow → orange or orange → red gap small), bands that look
// inverted (yellow_at > red_at — actual monotonicity violation), or
// bands clustering at extremes (yellow already > 0.8 → "everything
// triggers yellow"). Distinct from M4.12 (which compares effective
// vs default per tenant) — M4.14 audits the LIBRARY DEFAULTS
// themselves regardless of overrides.
//
// Pure resolver — operates over the static DEFAULTS array via
// `listThresholds()`. Platform-static. Mirror of M4.13 catalog-stats
// shape (envelope + leaderboards) but with per-indicator band-quality
// detail.

import {
  listThresholds,
  type IndicatorThreshold,
} from './indicator_thresholds';
import type { ScoringVertical } from './bil_scoring_v2';

// ─── Public types ─────────────────────────────────────────────────────

/** Width of each tier in the threshold ladder, computed as upper -
 *  lower (in the catalog's [0, 1] scale). */
export interface IndicatorThresholdBands {
  indicator_id: string;
  vertical: ScoringVertical;
  name: string;
  yellow_at: number;
  orange_at: number;
  red_at: number;
  /** orange_at − yellow_at — width of the yellow band (how big the
   *  "watchlist" zone is before escalation). */
  yellow_orange_gap: number;
  /** red_at − orange_at — width of the orange band. */
  orange_red_gap: number;
  /** red_at − yellow_at — total spread from first warning to red. */
  total_spread: number;
  /** True iff yellow_at <= orange_at <= red_at — should be true for
   *  every well-formed entry; the M4.3 loader validates this. */
  monotonic: boolean;
  /** Quality flags — heuristic warnings for the SPA to badge: */
  has_tight_yellow_orange_gap: boolean;
  has_tight_orange_red_gap: boolean;
  has_high_yellow_floor: boolean;
  has_low_red_ceiling: boolean;
  has_inverted_bands: boolean;
}

export interface IndicatorThresholdBandGapSummary {
  generated_at: string;
  total_indicators: number;
  rows: IndicatorThresholdBands[];
  /** Mean values across all indicators with monotonic bands. null
   *  when no indicators. */
  mean_yellow_orange_gap: number | null;
  mean_orange_red_gap: number | null;
  mean_total_spread: number | null;
  /** Indicator with the tightest yellow → orange gap. Canonical
   *  indicator_id asc tie-break. null when no indicators. */
  tightest_yellow_orange: { indicator_id: string; gap: number } | null;
  /** Indicator with the widest yellow → red total spread. Canonical
   *  indicator_id asc tie-break. null when no indicators. */
  widest_total_spread: { indicator_id: string; spread: number } | null;
  /** Per-vertical breakdown: count of indicators + count of
   *  indicators flagged with ANY quality issue. Every ScoringVertical
   *  key present. */
  by_vertical: Record<ScoringVertical, { count: number; flagged_count: number }>;
  /** Indicators with at least one quality flag set. Sorted by
   *  indicator_id asc. */
  flagged_indicators: IndicatorThresholdBands[];
}

// ─── Constants (heuristic thresholds for the audit) ──────────────────

/** Yellow → orange gap below this is flagged as "too tight". */
export const TIGHT_GAP_THRESHOLD = 0.10;
/** A yellow_at above this is flagged as "too high" — operators may
 *  end up with everything triggering yellow on first inspection. */
export const HIGH_YELLOW_THRESHOLD = 0.65;
/** A red_at below this is flagged as "too low" — high false-positive
 *  rate on red. */
export const LOW_RED_THRESHOLD = 0.65;

// ─── Pure resolver ────────────────────────────────────────────────────

function computeBands(t: IndicatorThreshold): IndicatorThresholdBands {
  const yellow_orange_gap = +(t.orange_at - t.yellow_at).toFixed(4);
  const orange_red_gap = +(t.red_at - t.orange_at).toFixed(4);
  const total_spread = +(t.red_at - t.yellow_at).toFixed(4);
  const monotonic = t.yellow_at <= t.orange_at && t.orange_at <= t.red_at;
  return {
    indicator_id: t.indicator_id,
    vertical: t.vertical,
    name: t.name,
    yellow_at: t.yellow_at,
    orange_at: t.orange_at,
    red_at: t.red_at,
    yellow_orange_gap,
    orange_red_gap,
    total_spread,
    monotonic,
    has_tight_yellow_orange_gap: yellow_orange_gap < TIGHT_GAP_THRESHOLD,
    has_tight_orange_red_gap: orange_red_gap < TIGHT_GAP_THRESHOLD,
    has_high_yellow_floor: t.yellow_at > HIGH_YELLOW_THRESHOLD,
    has_low_red_ceiling: t.red_at < LOW_RED_THRESHOLD,
    has_inverted_bands: !monotonic,
  };
}

function isFlagged(b: IndicatorThresholdBands): boolean {
  return (
    b.has_tight_yellow_orange_gap ||
    b.has_tight_orange_red_gap ||
    b.has_high_yellow_floor ||
    b.has_low_red_ceiling ||
    b.has_inverted_bands
  );
}

function emptyByVertical(): Record<ScoringVertical, { count: number; flagged_count: number }> {
  return {
    banking: { count: 0, flagged_count: 0 },
    insurance: { count: 0, flagged_count: 0 },
  };
}

export function buildIndicatorThresholdBandGap(
  now: Date,
): IndicatorThresholdBandGapSummary {
  const thresholds = listThresholds();
  const rows = thresholds
    .map(computeBands)
    .sort((a, z) => a.indicator_id.localeCompare(z.indicator_id));

  const monotonicRows = rows.filter((r) => r.monotonic);
  const mean = (values: number[]): number | null => {
    if (values.length === 0) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    return +(sum / values.length).toFixed(4);
  };

  const mean_yellow_orange_gap = mean(monotonicRows.map((r) => r.yellow_orange_gap));
  const mean_orange_red_gap = mean(monotonicRows.map((r) => r.orange_red_gap));
  const mean_total_spread = mean(monotonicRows.map((r) => r.total_spread));

  // tightest_yellow_orange — min yellow_orange_gap; canonical
  // indicator_id asc tie-break via stable iteration (rows already
  // sorted by indicator_id asc).
  let tightest: IndicatorThresholdBands | null = null;
  for (const row of rows) {
    if (!tightest || row.yellow_orange_gap < tightest.yellow_orange_gap) {
      tightest = row;
    }
  }

  // widest_total_spread — max total_spread; same tie-break.
  let widest: IndicatorThresholdBands | null = null;
  for (const row of rows) {
    if (!widest || row.total_spread > widest.total_spread) {
      widest = row;
    }
  }

  // by_vertical rollup
  const by_vertical = emptyByVertical();
  for (const row of rows) {
    by_vertical[row.vertical].count++;
    if (isFlagged(row)) by_vertical[row.vertical].flagged_count++;
  }

  const flagged_indicators = rows.filter(isFlagged);

  return {
    generated_at: now.toISOString(),
    total_indicators: rows.length,
    rows,
    mean_yellow_orange_gap,
    mean_orange_red_gap,
    mean_total_spread,
    tightest_yellow_orange: tightest
      ? { indicator_id: tightest.indicator_id, gap: tightest.yellow_orange_gap }
      : null,
    widest_total_spread: widest
      ? { indicator_id: widest.indicator_id, spread: widest.total_spread }
      : null,
    by_vertical,
    flagged_indicators,
  };
}
