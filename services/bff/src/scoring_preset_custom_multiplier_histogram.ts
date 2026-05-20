// services/bff/src/scoring_preset_custom_multiplier_histogram.ts
//
// T6 M6.19 — Custom weight preset multiplier histogram.
//
// M6.16 ships the multiplier histogram over the platform-static
// WEIGHT_PRESETS LIBRARY. M6.19 ships the SAME shape over the M6.4
// per-tenant CUSTOM weight preset store — answers "what's the
// distribution of multipliers in MY tenant's custom presets?" view.
//
// Same bucket boundaries as M6.16 (4 canonical buckets via the
// exported STRONG_DAMPEN_THRESHOLD + STRONG_BOOST_THRESHOLD constants).
// Same row + envelope shape — only the data source differs (custom
// store vs WEIGHT_PRESETS library).
//
// Distinct from M6.16 (library-static) by being tenant-scoped. Drives
// BIL ops "are operators creating AGGRESSIVE customs vs balanced ones?
// which custom preset is the most extreme?" governance views.

import {
  STRONG_DAMPEN_THRESHOLD,
  STRONG_BOOST_THRESHOLD,
  ALL_MULTIPLIER_BUCKETS,
  type MultiplierBucket,
  type PresetMultiplierRow,
} from './scoring_preset_multiplier_histogram';
import {
  type CustomWeightPresetStore,
} from './scoring_presets_custom';
import type { WeightPreset } from './scoring_presets';

// ─── Public types ──────────────────────────────────────────────────────

export interface CustomPresetMultiplierHistogram {
  tenant_id: string;
  generated_at: string;
  total_presets: number;
  total_multipliers: number;
  rows: PresetMultiplierRow[];
  /** Preset with most total_multipliers; canonical preset_id asc
   *  tie-break; null on empty store. */
  most_active_preset: string | null;
  /** Preset with most multiplier > 1.0 entries (boosts); canonical
   *  tie-break; null when no boosts anywhere. */
  most_boosted_preset: string | null;
  /** Preset with most multiplier < 1.0 entries (dampens); canonical
   *  tie-break; null when no dampens anywhere. */
  most_dampened_preset: string | null;
  /** {preset_id, indicator_id, value} of the single highest multiplier
   *  across the tenant. canonical preset_id asc tie-break + indicator
   *  id asc; null on empty. */
  highest_multiplier: {
    preset_id: string;
    indicator_id: string;
    value: number;
  } | null;
  /** {preset_id, indicator_id, value} of the single lowest multiplier
   *  across the tenant. canonical tie-break; null on empty. */
  lowest_multiplier: {
    preset_id: string;
    indicator_id: string;
    value: number;
  } | null;
  /** Marginal totals across the tenant's custom presets. */
  by_bucket_totals: Record<MultiplierBucket, number>;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyBucketCounts(): Record<MultiplierBucket, number> {
  const out = {} as Record<MultiplierBucket, number>;
  for (const b of ALL_MULTIPLIER_BUCKETS) out[b] = 0;
  return out;
}

function bucketFor(multiplier: number): MultiplierBucket | null {
  if (multiplier < STRONG_DAMPEN_THRESHOLD) return 'strong_dampen';
  if (multiplier < 1.0) return 'mild_dampen';
  if (multiplier === 1.0) return null;
  if (multiplier <= STRONG_BOOST_THRESHOLD) return 'mild_boost';
  return 'strong_boost';
}

function computeRow(preset: WeightPreset): PresetMultiplierRow {
  const entries = Object.entries(preset.weight_multipliers);
  const by_bucket = emptyBucketCounts();
  let min_multiplier: number | null = null;
  let max_multiplier: number | null = null;
  let sum = 0;
  let boost_count = 0;
  let dampen_count = 0;
  for (const [, multiplier] of entries) {
    sum += multiplier;
    if (min_multiplier === null || multiplier < min_multiplier) min_multiplier = multiplier;
    if (max_multiplier === null || multiplier > max_multiplier) max_multiplier = multiplier;
    const bucket = bucketFor(multiplier);
    if (bucket === null) continue;
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

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildCustomPresetMultiplierHistogram(
  tenant_id: string,
  presets: readonly WeightPreset[],
  now: Date,
): CustomPresetMultiplierHistogram {
  const rows = [...presets]
    .map(computeRow)
    .sort((a, z) => a.preset_id.localeCompare(z.preset_id));

  let total_multipliers = 0;
  const by_bucket_totals = emptyBucketCounts();
  for (const row of rows) {
    total_multipliers += row.total_multipliers;
    for (const b of ALL_MULTIPLIER_BUCKETS) {
      by_bucket_totals[b] += row.by_bucket[b];
    }
  }

  // most_active_preset — highest total_multipliers + canonical asc tie-break.
  let most_active_preset: string | null = null;
  if (rows.length > 0) {
    const sorted = [...rows].sort((a, b) => {
      if (b.total_multipliers !== a.total_multipliers) {
        return b.total_multipliers - a.total_multipliers;
      }
      return a.preset_id.localeCompare(b.preset_id);
    });
    if (sorted[0].total_multipliers > 0) {
      most_active_preset = sorted[0].preset_id;
    }
  }

  // most_boosted_preset — highest boost_count + canonical asc tie-break.
  let most_boosted_preset: string | null = null;
  if (rows.length > 0) {
    const sorted = [...rows].sort((a, b) => {
      if (b.boost_count !== a.boost_count) return b.boost_count - a.boost_count;
      return a.preset_id.localeCompare(b.preset_id);
    });
    if (sorted[0].boost_count > 0) {
      most_boosted_preset = sorted[0].preset_id;
    }
  }

  // most_dampened_preset — highest dampen_count + canonical asc tie-break.
  let most_dampened_preset: string | null = null;
  if (rows.length > 0) {
    const sorted = [...rows].sort((a, b) => {
      if (b.dampen_count !== a.dampen_count) return b.dampen_count - a.dampen_count;
      return a.preset_id.localeCompare(b.preset_id);
    });
    if (sorted[0].dampen_count > 0) {
      most_dampened_preset = sorted[0].preset_id;
    }
  }

  // highest_multiplier + lowest_multiplier — single (preset, indicator, value).
  let highest_multiplier: CustomPresetMultiplierHistogram['highest_multiplier'] = null;
  let lowest_multiplier: CustomPresetMultiplierHistogram['lowest_multiplier'] = null;
  for (const preset of [...presets].sort((a, z) => a.id.localeCompare(z.id))) {
    const entries = Object.entries(preset.weight_multipliers).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [indicator_id, value] of entries) {
      if (
        highest_multiplier === null ||
        value > highest_multiplier.value
      ) {
        highest_multiplier = { preset_id: preset.id, indicator_id, value };
      }
      if (
        lowest_multiplier === null ||
        value < lowest_multiplier.value
      ) {
        lowest_multiplier = { preset_id: preset.id, indicator_id, value };
      }
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_presets: rows.length,
    total_multipliers,
    rows,
    most_active_preset,
    most_boosted_preset,
    most_dampened_preset,
    highest_multiplier,
    lowest_multiplier,
    by_bucket_totals,
  };
}

/** Convenience: drain the M6.4 custom preset store then summarize. */
export function buildCustomPresetMultiplierHistogramFromStore(
  store: CustomWeightPresetStore,
  tenant_id: string,
  now: Date,
): CustomPresetMultiplierHistogram {
  const presets = store.list(tenant_id);
  return buildCustomPresetMultiplierHistogram(tenant_id, presets, now);
}
