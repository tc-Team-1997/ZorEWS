// services/bff/src/scenario_shock_axis_histogram.ts
//
// T6 M16.20 — Scenario shock-axis magnitude histogram.
//
// M16.15 ships shock-vector radar transforms (normalised [-1, 1] per
// axis for plotting). M16.18 ships per-preset MAGNITUDE summary
// (single number per preset, comparable across axes). M16.20 lands
// the orthogonal AXIS-pivoted view: for each of the 3 shock axes
// (gdp/rate/fx), bucket the 10 library presets' |shock| values into
// 4 magnitude ranges (zero / mild / moderate / severe). Mirror of
// M6.16 multiplier histogram pattern but for scenario axes.
//
// Per-axis bucket thresholds are axis-aware since the 3 axes have
// different natural scales:
//   - GDP shock — percentage points (typical range -10 to +5)
//   - rate shock — basis points (typical range -100 to +500)
//   - fx shock — percentage move (typical range -5 to +20)
//
// Pure resolver — operates over SCENARIO_PRESETS. Platform-static —
// same response across tenants.
//
// Drives "do we cover the full range of GDP shocks? are FX shocks
// underrepresented at the severe end?".

import {
  SCENARIO_PRESETS,
  type ScenarioPreset,
} from './scenario_library';

// ─── Constants ────────────────────────────────────────────────────────

export type ShockAxis = 'gdp' | 'rate' | 'fx';

export const ALL_SHOCK_AXES: readonly ShockAxis[] = ['gdp', 'rate', 'fx'] as const;

export type ShockMagnitudeBucket = 'zero' | 'mild' | 'moderate' | 'severe';

export const ALL_SHOCK_MAGNITUDE_BUCKETS: readonly ShockMagnitudeBucket[] = [
  'zero',
  'mild',
  'moderate',
  'severe',
] as const;

/** Per-axis bucket boundaries — |shock| thresholds. */
interface AxisBuckets {
  /** mild < this; zero is exactly 0. */
  mild_max: number;
  /** moderate < this. */
  moderate_max: number;
  // severe: >= moderate_max
}

const AXIS_BUCKETS: Record<ShockAxis, AxisBuckets> = {
  gdp: { mild_max: 2, moderate_max: 5 },        // pp
  rate: { mild_max: 100, moderate_max: 250 },   // bps
  fx: { mild_max: 5, moderate_max: 12 },        // %
};

// ─── Public types ─────────────────────────────────────────────────────

export interface AxisHistogramRow {
  axis: ShockAxis;
  /** Bucket thresholds in effect for this axis. */
  thresholds: { mild_max: number; moderate_max: number };
  /** Per-bucket count. Every bucket key present at 0 when absent. */
  by_bucket: Record<ShockMagnitudeBucket, number>;
  /** Sum equals total_presets in the library. */
  total_presets: number;
  /** Min/max |shock| across the library for this axis. */
  min_abs: number;
  max_abs: number;
  /** Mean |shock|, rounded to 4 decimal places. */
  mean_abs: number;
  /** Count of presets with positive raw shock (gdp boom, rate hike,
   *  fx weakening — semantics axis-specific). */
  positive_count: number;
  /** Count of presets with negative raw shock (gdp contraction, rate
   *  cut, fx strengthening). */
  negative_count: number;
  /** Count of presets with exactly zero shock on this axis. */
  zero_count: number;
  /** Sample preset_ids for the SEVERE bucket — cap 3 sorted asc. */
  severe_examples: string[];
}

export interface ScenarioShockAxisHistogram {
  generated_at: string;
  total_presets: number;
  rows: AxisHistogramRow[];
  /** Axis with the most distinct severe-bucket presets — the axis
   *  where the library has the strongest stress coverage. Canonical
   *  axis-order tie-break. null when no severe entries on any axis. */
  most_severe_axis: { axis: ShockAxis; severe_count: number } | null;
  /** Axis with the highest mean_abs. Canonical-order tie-break. null
   *  when library is empty. */
  highest_mean_axis: { axis: ShockAxis; mean_abs: number } | null;
  /** Axis with the lowest mean_abs. Canonical-order tie-break. null
   *  when library is empty. */
  lowest_mean_axis: { axis: ShockAxis; mean_abs: number } | null;
  /** Marginal per-bucket totals across all 3 axes. */
  by_bucket_totals: Record<ShockMagnitudeBucket, number>;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyBucketCounts(): Record<ShockMagnitudeBucket, number> {
  return { zero: 0, mild: 0, moderate: 0, severe: 0 };
}

export function bucketForShock(axis: ShockAxis, raw: number): ShockMagnitudeBucket {
  const abs = Math.abs(raw);
  const thresholds = AXIS_BUCKETS[axis];
  if (abs === 0) return 'zero';
  if (abs < thresholds.mild_max) return 'mild';
  if (abs < thresholds.moderate_max) return 'moderate';
  return 'severe';
}

function computeRow(axis: ShockAxis, presets: readonly ScenarioPreset[]): AxisHistogramRow {
  const by_bucket = emptyBucketCounts();
  const thresholds = AXIS_BUCKETS[axis];
  let min_abs = Infinity;
  let max_abs = -Infinity;
  let sum = 0;
  let positive_count = 0;
  let negative_count = 0;
  let zero_count = 0;
  const severe_examples_full: string[] = [];

  for (const preset of presets) {
    const raw = preset.shocks[axis];
    const abs = Math.abs(raw);
    if (abs < min_abs) min_abs = abs;
    if (abs > max_abs) max_abs = abs;
    sum += abs;
    const bucket = bucketForShock(axis, raw);
    by_bucket[bucket]++;
    if (raw > 0) positive_count++;
    else if (raw < 0) negative_count++;
    else zero_count++;
    if (bucket === 'severe') severe_examples_full.push(preset.id);
  }

  const severe_examples = severe_examples_full
    .sort((a, z) => a.localeCompare(z))
    .slice(0, 3);

  const total_presets = presets.length;
  const mean_abs = total_presets > 0 ? +(sum / total_presets).toFixed(4) : 0;
  return {
    axis,
    thresholds: { mild_max: thresholds.mild_max, moderate_max: thresholds.moderate_max },
    by_bucket,
    total_presets,
    min_abs: total_presets > 0 ? min_abs : 0,
    max_abs: total_presets > 0 ? max_abs : 0,
    mean_abs,
    positive_count,
    negative_count,
    zero_count,
    severe_examples,
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildScenarioShockAxisHistogram(
  now: Date,
): ScenarioShockAxisHistogram {
  const presets = SCENARIO_PRESETS;
  const rows: AxisHistogramRow[] = ALL_SHOCK_AXES.map((axis) => computeRow(axis, presets));

  const by_bucket_totals = emptyBucketCounts();
  for (const row of rows) {
    for (const b of ALL_SHOCK_MAGNITUDE_BUCKETS) {
      by_bucket_totals[b] += row.by_bucket[b];
    }
  }

  // most_severe_axis — highest severe count. Canonical-axis-order tie-break.
  let most_severe_axis: { axis: ShockAxis; severe_count: number } | null = null;
  for (const row of rows) {
    const sev = row.by_bucket.severe;
    if (sev > 0 && (!most_severe_axis || sev > most_severe_axis.severe_count)) {
      most_severe_axis = { axis: row.axis, severe_count: sev };
    }
  }

  // highest_mean_axis / lowest_mean_axis.
  let highest_mean_axis: { axis: ShockAxis; mean_abs: number } | null = null;
  let lowest_mean_axis: { axis: ShockAxis; mean_abs: number } | null = null;
  if (presets.length > 0) {
    for (const row of rows) {
      if (!highest_mean_axis || row.mean_abs > highest_mean_axis.mean_abs) {
        highest_mean_axis = { axis: row.axis, mean_abs: row.mean_abs };
      }
      if (!lowest_mean_axis || row.mean_abs < lowest_mean_axis.mean_abs) {
        lowest_mean_axis = { axis: row.axis, mean_abs: row.mean_abs };
      }
    }
  }

  return {
    generated_at: now.toISOString(),
    total_presets: presets.length,
    rows,
    most_severe_axis,
    highest_mean_axis,
    lowest_mean_axis,
    by_bucket_totals,
  };
}
