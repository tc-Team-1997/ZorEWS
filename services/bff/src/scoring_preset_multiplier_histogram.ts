// services/bff/src/scoring_preset_multiplier_histogram.ts
//
// T6 M6.16 — Library preset multiplier histogram.
//
// M6.3 ships the 6 library presets (3 modes × 2 verticals). M6.4
// ships per-tenant custom CRUD. M6.9 ships preset definition diff.
// M6.10 ships effective weights view (resolves catalog × multiplier).
// M6.15 ships mode × vertical inventory cross-tab.
//
// M6.16 lands per-preset MULTIPLIER HISTOGRAM analytics: for each
// library preset, bucket its explicit `weight_multipliers` values
// into 4 ranges (strong_dampen / mild_dampen / mild_boost /
// strong_boost) plus min/mean/max stats. Answers "which presets are
// most aggressive on the upside? which dampen most heavily?".
//
// Pure resolver — operates over the static WEIGHT_PRESETS catalog.
// Platform-static — same response across tenants. Distinct shape
// from the matrix family — this is a per-preset histogram + ranked
// leaderboards, not a 2D cross-tab.

import {
  WEIGHT_PRESETS,
  type WeightPreset,
  type WeightPresetMode,
} from './scoring_presets';
import type { ScoringVertical } from './bil_scoring_v2';

// ─── Constants (bucket boundaries) ───────────────────────────────────

/** Multipliers < this are "strong dampen". */
export const STRONG_DAMPEN_THRESHOLD = 0.5;
/** Multipliers > this are "strong boost". */
export const STRONG_BOOST_THRESHOLD = 1.5;

export type MultiplierBucket =
  | 'strong_dampen'
  | 'mild_dampen'
  | 'mild_boost'
  | 'strong_boost';

export const ALL_MULTIPLIER_BUCKETS: readonly MultiplierBucket[] = [
  'strong_dampen',
  'mild_dampen',
  'mild_boost',
  'strong_boost',
] as const;

// ─── Public types ─────────────────────────────────────────────────────

export interface PresetMultiplierRow {
  preset_id: string;
  name: string;
  mode: WeightPresetMode;
  vertical: ScoringVertical;
  /** Count of explicit multipliers in `weight_multipliers`. Equals
   *  Object.keys(weight_multipliers).length. */
  total_multipliers: number;
  /** Per-bucket counts. Every bucket key present at 0 when absent. */
  by_bucket: Record<MultiplierBucket, number>;
  /** Min/mean/max across explicit multipliers. All null when
   *  total_multipliers=0 (balanced presets with empty map). Mean
   *  rounded to 4 decimal places. */
  min_multiplier: number | null;
  mean_multiplier: number | null;
  max_multiplier: number | null;
  /** boost_count + dampen_count partition (excludes exact 1.0). */
  boost_count: number;
  dampen_count: number;
}

export interface PresetMultiplierHistogram {
  generated_at: string;
  total_presets: number;
  /** Σ explicit multipliers across all presets. */
  total_multipliers: number;
  /** Rows sorted by preset_id asc. */
  rows: PresetMultiplierRow[];
  /** Preset with the most explicit multipliers (most-customised).
   *  Canonical preset_id asc tie-break. null when no presets. */
  most_active_preset: { preset_id: string; total_multipliers: number } | null;
  /** Preset with the highest boost_count (most aggressive on the
   *  upside). Canonical preset_id asc tie-break. null when no boost
   *  entries anywhere. */
  most_boosted_preset: { preset_id: string; boost_count: number } | null;
  /** Preset with the highest dampen_count (most aggressive on the
   *  downside). Canonical preset_id asc tie-break. null when no
   *  dampen entries anywhere. */
  most_dampened_preset: { preset_id: string; dampen_count: number } | null;
  /** Highest single multiplier across the library. Canonical preset_id
   *  asc tie-break. null when no presets carry multipliers. */
  highest_multiplier: { preset_id: string; indicator_id: string; multiplier: number } | null;
  /** Lowest single multiplier (strongest dampen). Canonical preset_id
   *  asc tie-break. null when no presets carry multipliers. */
  lowest_multiplier: { preset_id: string; indicator_id: string; multiplier: number } | null;
  /** Marginal totals across the catalog. */
  by_bucket_totals: Record<MultiplierBucket, number>;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyBucketCounts(): Record<MultiplierBucket, number> {
  return {
    strong_dampen: 0,
    mild_dampen: 0,
    mild_boost: 0,
    strong_boost: 0,
  };
}

function bucketFor(multiplier: number): MultiplierBucket | null {
  if (multiplier < STRONG_DAMPEN_THRESHOLD) return 'strong_dampen';
  if (multiplier < 1.0) return 'mild_dampen';
  if (multiplier === 1.0) return null; // exactly 1.0 is a no-op; defensive
  if (multiplier <= STRONG_BOOST_THRESHOLD) return 'mild_boost';
  return 'strong_boost';
}

function computeRow(preset: WeightPreset): PresetMultiplierRow {
  const entries = Object.entries(preset.weight_multipliers);
  const by_bucket = emptyBucketCounts();
  let min_multiplier: number | null = null;
  let max_multiplier: number | null = null;
  let sum = 0;
  let nonNeutral = 0;
  let boost_count = 0;
  let dampen_count = 0;
  for (const [, multiplier] of entries) {
    sum += multiplier;
    if (min_multiplier === null || multiplier < min_multiplier) min_multiplier = multiplier;
    if (max_multiplier === null || multiplier > max_multiplier) max_multiplier = multiplier;
    const bucket = bucketFor(multiplier);
    if (bucket === null) continue;
    nonNeutral++;
    by_bucket[bucket]++;
    if (multiplier > 1.0) boost_count++;
    else dampen_count++;
  }
  const mean_multiplier =
    entries.length > 0 ? +(sum / entries.length).toFixed(4) : null;
  return {
    preset_id: preset.id,
    name: preset.name,
    mode: preset.mode,
    vertical: preset.vertical,
    total_multipliers: entries.length,
    by_bucket,
    min_multiplier,
    mean_multiplier,
    max_multiplier,
    boost_count,
    dampen_count,
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildPresetMultiplierHistogram(
  now: Date,
): PresetMultiplierHistogram {
  const rows = [...WEIGHT_PRESETS]
    .map(computeRow)
    .sort((a, z) => a.preset_id.localeCompare(z.preset_id));

  const total_multipliers = rows.reduce((acc, r) => acc + r.total_multipliers, 0);

  const by_bucket_totals = emptyBucketCounts();
  for (const row of rows) {
    for (const b of ALL_MULTIPLIER_BUCKETS) {
      by_bucket_totals[b] += row.by_bucket[b];
    }
  }

  // most_active_preset — highest total_multipliers; canonical preset_id
  // asc tie-break via stable iteration (rows already sorted asc).
  let mostActive: PresetMultiplierRow | null = null;
  for (const row of rows) {
    if (!mostActive || row.total_multipliers > mostActive.total_multipliers) {
      mostActive = row;
    }
  }
  const most_active_preset = mostActive && mostActive.total_multipliers > 0
    ? { preset_id: mostActive.preset_id, total_multipliers: mostActive.total_multipliers }
    : null;

  // most_boosted_preset
  let mostBoosted: PresetMultiplierRow | null = null;
  for (const row of rows) {
    if (row.boost_count === 0) continue;
    if (!mostBoosted || row.boost_count > mostBoosted.boost_count) {
      mostBoosted = row;
    }
  }
  const most_boosted_preset = mostBoosted
    ? { preset_id: mostBoosted.preset_id, boost_count: mostBoosted.boost_count }
    : null;

  // most_dampened_preset
  let mostDampened: PresetMultiplierRow | null = null;
  for (const row of rows) {
    if (row.dampen_count === 0) continue;
    if (!mostDampened || row.dampen_count > mostDampened.dampen_count) {
      mostDampened = row;
    }
  }
  const most_dampened_preset = mostDampened
    ? { preset_id: mostDampened.preset_id, dampen_count: mostDampened.dampen_count }
    : null;

  // highest_multiplier — walk every (preset, multiplier) pair; canonical
  // preset_id asc tie-break via iteration order.
  let highest: { preset_id: string; indicator_id: string; multiplier: number } | null = null;
  let lowest: { preset_id: string; indicator_id: string; multiplier: number } | null = null;
  for (const preset of [...WEIGHT_PRESETS].sort((a, z) => a.id.localeCompare(z.id))) {
    for (const [indicator_id, multiplier] of Object.entries(preset.weight_multipliers)) {
      if (!highest || multiplier > highest.multiplier) {
        highest = { preset_id: preset.id, indicator_id, multiplier };
      }
      if (!lowest || multiplier < lowest.multiplier) {
        lowest = { preset_id: preset.id, indicator_id, multiplier };
      }
    }
  }

  return {
    generated_at: now.toISOString(),
    total_presets: rows.length,
    total_multipliers,
    rows,
    most_active_preset,
    most_boosted_preset,
    most_dampened_preset,
    highest_multiplier: highest,
    lowest_multiplier: lowest,
    by_bucket_totals,
  };
}
