// services/bff/src/indicator_threshold_shift_analysis.ts
//
// T6 M4.19 — Indicator threshold override band shift analysis.
//
// DIRECTION-aware view over per-tenant M4.4 threshold overrides.
// For each override + each band (yellow / orange / red), classify
// the shift vs platform default as raised | lowered | unchanged.
//
// Distinct from M4.12 (drift score — magnitude-only, no direction):
//   M4.12 says "your yellow_at differs from default by 0.15 (15%)"
//   M4.19 says "your yellow_at was RAISED by 0.15" or "LOWERED by 0.15"
//
// Operationally critical signal:
//   - RAISED yellow_at + RAISED orange_at + RAISED red_at = ops LOOSER
//     than platform → expect LOWER alert volume + LOWER precision
//   - LOWERED across bands = ops STRICTER than platform → expect
//     HIGHER alert volume + HIGHER false-positive rate
//   - MIXED = surgical per-band tuning (typical mature posture)
//
// Pairs with M4.12 (drift magnitude) + M4.10 (auto-tune suggestion)
// + M4.14 (band-gap quality) for the full threshold-tuning audit:
//   M4.10 — what threshold COULD this be (data-driven recommendation)?
//   M4.12 — how far HAVE you moved (magnitude)?
//   M4.14 — is the DEFAULT shape sensible (catalog hygiene)?
//   M4.19 — which DIRECTION did you move + by how much per band?

import type {
  IndicatorThreshold,
  ThresholdOverrideStore,
} from './indicator_thresholds';
import { getThreshold, listThresholds } from './indicator_thresholds';
import type { ScoringVertical } from './bil_scoring_v2';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

/** A shift smaller than this in absolute value is treated as
 *  "unchanged" (numeric noise rounding). 0.001 = 0.1pp on the
 *  [0,1] threshold scale — small enough to ignore floating-point
 *  drift but large enough to catch any meaningful operator edit. */
export const SHIFT_EPSILON = 0.001;

export type BandShiftDirection = 'raised' | 'lowered' | 'unchanged';
export const ALL_BAND_SHIFT_DIRECTIONS: readonly BandShiftDirection[] = [
  'raised',
  'lowered',
  'unchanged',
] as const;

export type OverallShiftDirection =
  | 'all_raised' // every band raised (ops loosening across the board)
  | 'all_lowered' // every band lowered (ops tightening across the board)
  | 'mixed' // some raised + some lowered (surgical tuning)
  | 'unchanged'; // every band unchanged (override redundant — equals default)

export const ALL_OVERALL_SHIFT_DIRECTIONS: readonly OverallShiftDirection[] = [
  'all_raised',
  'all_lowered',
  'mixed',
  'unchanged',
] as const;

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface BandShift {
  /** effective − default (signed). Positive = raised; negative = lowered. */
  delta: number;
  direction: BandShiftDirection;
  /** Absolute magnitude of the shift. */
  magnitude: number;
}

export interface IndicatorThresholdShiftRow {
  indicator_id: string;
  name: string;
  vertical: ScoringVertical;
  default_yellow_at: number;
  default_orange_at: number;
  default_red_at: number;
  effective_yellow_at: number;
  effective_orange_at: number;
  effective_red_at: number;
  yellow_shift: BandShift;
  orange_shift: BandShift;
  red_shift: BandShift;
  /** Overall direction across the 3 bands. */
  overall_direction: OverallShiftDirection;
  /** Sum of absolute magnitudes across 3 bands — proxy for "how
   *  aggressively did ops re-calibrate?" */
  total_magnitude: number;
  /**
   * Signed net direction = Σ delta across bands. Positive = net
   * loosening (raised more than lowered); negative = net tightening
   * (lowered more than raised); 0 = balanced or unchanged. */
  net_signed_delta: number;
}

export interface MostAggressiveRow {
  indicator_id: string;
  name: string;
  vertical: ScoringVertical;
  net_signed_delta: number;
  total_magnitude: number;
  overall_direction: OverallShiftDirection;
}

export interface IndicatorThresholdShiftAnalysis {
  tenant_id: string;
  generated_at: string;
  /** Total overrides analyzed (overrides for indicators present in
   *  the platform catalog — orphan overrides silently skipped). */
  total_overrides: number;
  /** Defensive count of overrides skipped because their indicator
   *  isn't in the platform catalog (catalog drift). */
  total_orphan_overrides: number;
  /** Per-band classification across all overrides:
   *  by_band_direction.yellow.raised = count of overrides where
   *  yellow_at was raised. */
  by_band_direction: Record<
    'yellow' | 'orange' | 'red',
    Record<BandShiftDirection, number>
  >;
  /** Overall direction rollup across overrides. */
  by_overall_direction: Record<OverallShiftDirection, number>;
  /** All shift rows sorted total_magnitude desc + indicator_id asc tie-break. */
  shifts: IndicatorThresholdShiftRow[];
  /**
   * Most aggressive TIGHTENING: largest negative net_signed_delta
   * (= largest net lowering across bands). Surfaces "ops getting
   * stricter — alert volume should rise" signal. null when no
   * overrides or no net-negative shifts.
   */
  most_aggressive_tightening: MostAggressiveRow | null;
  /**
   * Most aggressive LOOSENING: largest positive net_signed_delta.
   * Surfaces "ops getting laxer — alert volume should drop" signal.
   * null when no net-positive shifts.
   */
  most_aggressive_loosening: MostAggressiveRow | null;
  /**
   * Indicator with the highest total_magnitude (regardless of
   * direction). Surfaces "most-recalibrated indicator" — useful for
   * "why was this one tuned heavily?" investigations. null on empty.
   */
  most_recalibrated_indicator: MostAggressiveRow | null;
}

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

function classifyShift(delta: number): BandShiftDirection {
  if (Math.abs(delta) < SHIFT_EPSILON) return 'unchanged';
  return delta > 0 ? 'raised' : 'lowered';
}

function bandShift(effective: number, defaultValue: number): BandShift {
  const delta = effective - defaultValue;
  return {
    delta,
    direction: classifyShift(delta),
    magnitude: Math.abs(delta),
  };
}

function classifyOverall(
  yellow: BandShiftDirection,
  orange: BandShiftDirection,
  red: BandShiftDirection,
): OverallShiftDirection {
  const dirs = [yellow, orange, red];
  if (dirs.every((d) => d === 'unchanged')) return 'unchanged';
  if (dirs.every((d) => d === 'raised' || d === 'unchanged') && dirs.some((d) => d === 'raised'))
    return 'all_raised';
  if (dirs.every((d) => d === 'lowered' || d === 'unchanged') && dirs.some((d) => d === 'lowered'))
    return 'all_lowered';
  return 'mixed';
}

function zeroByBandDirection(): Record<
  'yellow' | 'orange' | 'red',
  Record<BandShiftDirection, number>
> {
  return {
    yellow: { raised: 0, lowered: 0, unchanged: 0 },
    orange: { raised: 0, lowered: 0, unchanged: 0 },
    red: { raised: 0, lowered: 0, unchanged: 0 },
  };
}

function zeroByOverallDirection(): Record<OverallShiftDirection, number> {
  return { all_raised: 0, all_lowered: 0, mixed: 0, unchanged: 0 };
}

function toMostAggressiveRow(row: IndicatorThresholdShiftRow): MostAggressiveRow {
  return {
    indicator_id: row.indicator_id,
    name: row.name,
    vertical: row.vertical,
    net_signed_delta: row.net_signed_delta,
    total_magnitude: row.total_magnitude,
    overall_direction: row.overall_direction,
  };
}

// ---------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------

export function summarizeIndicatorThresholdShifts(
  store: ThresholdOverrideStore,
  tenant_id: string,
  now: Date,
): IndicatorThresholdShiftAnalysis {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new Error('summarizeIndicatorThresholdShifts: tenant_id required');
  }

  const overrides = store.listOverrides(tenant_id);
  let total_orphan_overrides = 0;
  const by_band_direction = zeroByBandDirection();
  const by_overall_direction = zeroByOverallDirection();
  const shifts: IndicatorThresholdShiftRow[] = [];

  for (const override of overrides) {
    const def = getThreshold(override.indicator_id);
    if (!def) {
      total_orphan_overrides += 1;
      continue;
    }
    const yShift = bandShift(override.yellow_at, def.yellow_at);
    const oShift = bandShift(override.orange_at, def.orange_at);
    const rShift = bandShift(override.red_at, def.red_at);
    const overall_direction = classifyOverall(
      yShift.direction,
      oShift.direction,
      rShift.direction,
    );
    by_band_direction.yellow[yShift.direction] += 1;
    by_band_direction.orange[oShift.direction] += 1;
    by_band_direction.red[rShift.direction] += 1;
    by_overall_direction[overall_direction] += 1;

    shifts.push({
      indicator_id: override.indicator_id,
      name: def.name,
      vertical: def.vertical,
      default_yellow_at: def.yellow_at,
      default_orange_at: def.orange_at,
      default_red_at: def.red_at,
      effective_yellow_at: override.yellow_at,
      effective_orange_at: override.orange_at,
      effective_red_at: override.red_at,
      yellow_shift: yShift,
      orange_shift: oShift,
      red_shift: rShift,
      overall_direction,
      total_magnitude: yShift.magnitude + oShift.magnitude + rShift.magnitude,
      net_signed_delta: yShift.delta + oShift.delta + rShift.delta,
    });
  }

  // Sort: total_magnitude desc + indicator_id asc tie-break
  shifts.sort((a, b) => {
    if (b.total_magnitude !== a.total_magnitude) {
      return b.total_magnitude - a.total_magnitude;
    }
    return a.indicator_id.localeCompare(b.indicator_id);
  });

  // Leaderboards
  let most_aggressive_tightening: IndicatorThresholdShiftRow | null = null;
  let most_aggressive_loosening: IndicatorThresholdShiftRow | null = null;
  let most_recalibrated_indicator: IndicatorThresholdShiftRow | null = null;

  for (const row of shifts) {
    if (row.net_signed_delta < 0) {
      // strict < to break ties by indicator_id asc (first-seen wins
      // since shifts is already sorted)
      if (
        !most_aggressive_tightening ||
        row.net_signed_delta < most_aggressive_tightening.net_signed_delta
      ) {
        most_aggressive_tightening = row;
      }
    }
    if (row.net_signed_delta > 0) {
      if (
        !most_aggressive_loosening ||
        row.net_signed_delta > most_aggressive_loosening.net_signed_delta
      ) {
        most_aggressive_loosening = row;
      }
    }
    if (
      !most_recalibrated_indicator ||
      row.total_magnitude > most_recalibrated_indicator.total_magnitude
    ) {
      most_recalibrated_indicator = row;
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_overrides: shifts.length,
    total_orphan_overrides,
    by_band_direction,
    by_overall_direction,
    shifts,
    most_aggressive_tightening:
      most_aggressive_tightening !== null
        ? toMostAggressiveRow(most_aggressive_tightening)
        : null,
    most_aggressive_loosening:
      most_aggressive_loosening !== null
        ? toMostAggressiveRow(most_aggressive_loosening)
        : null,
    most_recalibrated_indicator:
      most_recalibrated_indicator !== null
        ? toMostAggressiveRow(most_recalibrated_indicator)
        : null,
  };
}

// Re-export for downstream consumer convenience.
export { getThreshold, listThresholds };
export type { IndicatorThreshold, ThresholdOverrideStore };
