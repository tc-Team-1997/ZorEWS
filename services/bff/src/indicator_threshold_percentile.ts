// services/bff/src/indicator_threshold_percentile.ts
//
// T6 M4.22 — Indicator threshold percentile comparison.
//
// Computes fleet-wide percentiles (p25, p50, p75) across all
// platform indicator thresholds for each band (yellow_at,
// orange_at, red_at). Then ranks each indicator by its
// percentile position and flags outliers (tightest yellow,
// most lenient red).
//
// Distinct from M4.12 (per-tenant drift vs default), M4.14
// (band-gap quality scorecard), M4.9 (effective resolution chain).
//
// Pure resolver. Platform-static.

import { listThresholds } from './indicator_thresholds';

// ─── Public types ─────────────────────────────────────────────────────

export interface ThresholdPercentiles {
  p25: number;
  p50: number;
  p75: number;
}

export interface FleetPercentiles {
  yellow_at: ThresholdPercentiles;
  orange_at: ThresholdPercentiles;
  red_at: ThresholdPercentiles;
}

export interface IndicatorPercentileRow {
  indicator_id: string;
  name: string;
  vertical: string;
  yellow_at: number;
  orange_at: number;
  red_at: number;
  /** Percentile rank for yellow_at (0-100): what % of indicators have a lower yellow_at. */
  yellow_percentile_rank: number;
  orange_percentile_rank: number;
  red_percentile_rank: number;
  /** True when yellow_at is above the fleet p75 — unusually tight yellow threshold. */
  is_tightest_yellow: boolean;
  /** True when red_at is below the fleet p25 — unusually lenient red threshold. */
  is_most_lenient_red: boolean;
}

export interface IndicatorThresholdPercentileSummary {
  generated_at: string;
  total_indicators: number;
  fleet_percentiles: FleetPercentiles;
  indicators: IndicatorPercentileRow[];
  /** indicator_ids where is_tightest_yellow=true. */
  tightest_yellow_indicators: string[];
  /** indicator_ids where is_most_lenient_red=true. */
  most_lenient_red_indicators: string[];
}

// ─── Percentile helper ────────────────────────────────────────────────

function linearPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function percentileRank(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0;
  let below = 0;
  for (const v of sorted) {
    if (v < value) below++;
  }
  return Math.round((below / sorted.length) * 100);
}

// ─── Main pure function ───────────────────────────────────────────────

export function buildIndicatorThresholdPercentiles(
  now: Date,
): IndicatorThresholdPercentileSummary {
  const thresholds = listThresholds();
  const total_indicators = thresholds.length;

  const yellows = [...thresholds.map((t) => t.yellow_at)].sort((a, b) => a - b);
  const oranges = [...thresholds.map((t) => t.orange_at)].sort((a, b) => a - b);
  const reds = [...thresholds.map((t) => t.red_at)].sort((a, b) => a - b);

  const fleet_percentiles: FleetPercentiles = {
    yellow_at: {
      p25: Math.round(linearPercentile(yellows, 25) * 10000) / 10000,
      p50: Math.round(linearPercentile(yellows, 50) * 10000) / 10000,
      p75: Math.round(linearPercentile(yellows, 75) * 10000) / 10000,
    },
    orange_at: {
      p25: Math.round(linearPercentile(oranges, 25) * 10000) / 10000,
      p50: Math.round(linearPercentile(oranges, 50) * 10000) / 10000,
      p75: Math.round(linearPercentile(oranges, 75) * 10000) / 10000,
    },
    red_at: {
      p25: Math.round(linearPercentile(reds, 25) * 10000) / 10000,
      p50: Math.round(linearPercentile(reds, 50) * 10000) / 10000,
      p75: Math.round(linearPercentile(reds, 75) * 10000) / 10000,
    },
  };

  const indicators: IndicatorPercentileRow[] = thresholds
    .map((t) => {
      const yRank = percentileRank(yellows, t.yellow_at);
      const oRank = percentileRank(oranges, t.orange_at);
      const rRank = percentileRank(reds, t.red_at);
      const isTightestYellow = t.yellow_at > fleet_percentiles.yellow_at.p75;
      const isMostLenientRed = t.red_at < fleet_percentiles.red_at.p25;
      return {
        indicator_id: t.indicator_id,
        name: t.name,
        vertical: t.vertical,
        yellow_at: t.yellow_at,
        orange_at: t.orange_at,
        red_at: t.red_at,
        yellow_percentile_rank: yRank,
        orange_percentile_rank: oRank,
        red_percentile_rank: rRank,
        is_tightest_yellow: isTightestYellow,
        is_most_lenient_red: isMostLenientRed,
      };
    })
    .sort((a, b) => (a.indicator_id < b.indicator_id ? -1 : a.indicator_id > b.indicator_id ? 1 : 0));

  const tightest_yellow_indicators = indicators
    .filter((i) => i.is_tightest_yellow)
    .map((i) => i.indicator_id);
  const most_lenient_red_indicators = indicators
    .filter((i) => i.is_most_lenient_red)
    .map((i) => i.indicator_id);

  return {
    generated_at: now.toISOString(),
    total_indicators,
    fleet_percentiles,
    indicators,
    tightest_yellow_indicators,
    most_lenient_red_indicators,
  };
}
