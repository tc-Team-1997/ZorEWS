// services/bff/src/scoring_preset_multiplier_drift.ts
//
// T6 M6.22 — Scoring weight preset multiplier drift from defaults.
//
// For each custom weight preset, compares the explicit weight_multipliers
// to the implicit default (1.0 for every indicator). The drift_score
// is the mean absolute deviation from 1.0 across all explicit multipliers.

import type { WeightPreset } from './scoring_presets';

// ─── Public types ──────────────────────────────────────────────────────

export interface PresetMultiplierDriftRow {
  preset_id: string;
  name: string;
  mode: string;
  vertical: string;
  /** Number of explicit multipliers in the preset's sparse map. */
  total_multipliers: number;
  /** Mean |multiplier - 1.0| across all explicit multipliers. 0 when none. */
  drift_score: number;
  /** Highest |multiplier - 1.0| across all explicit multipliers. 0 when none. */
  max_deviation: number;
  min_multiplier: number | null;
  max_multiplier: number | null;
}

export interface ScoringPresetMultiplierDrift {
  generated_at: string;
  total_custom_presets: number;
  /** sorted drift_score desc + preset_id asc tie-break */
  presets: PresetMultiplierDriftRow[];
  most_drifted: { preset_id: string; name: string; drift_score: number } | null;
  fleet_avg_drift: number;
}

// ─── Pure function ─────────────────────────────────────────────────────

/**
 * buildScoringPresetMultiplierDrift
 *
 * @param customPresets  array of WeightPreset (typically the per-tenant custom store items)
 * @param now  current Date (for generated_at)
 */
export function buildScoringPresetMultiplierDrift(
  customPresets: readonly WeightPreset[],
  now: Date,
): ScoringPresetMultiplierDrift {
  const rows: PresetMultiplierDriftRow[] = [];

  for (const preset of customPresets) {
    const multipliers = Object.values(preset.weight_multipliers ?? {}) as number[];
    const n = multipliers.length;

    let drift_score = 0;
    let max_deviation = 0;
    let min_multiplier: number | null = null;
    let max_multiplier: number | null = null;

    if (n > 0) {
      let sumDev = 0;
      for (const m of multipliers) {
        const dev = Math.abs(m - 1.0);
        sumDev += dev;
        if (dev > max_deviation) max_deviation = dev;
        if (min_multiplier === null || m < min_multiplier) min_multiplier = m;
        if (max_multiplier === null || m > max_multiplier) max_multiplier = m;
      }
      drift_score = Math.round((sumDev / n) * 10000) / 10000;
      max_deviation = Math.round(max_deviation * 10000) / 10000;
    }

    // WeightPreset uses 'id' as the identifier field
    const presetId = preset.id;
    rows.push({
      preset_id: presetId,
      name: preset.name,
      mode: preset.mode,
      vertical: preset.vertical,
      total_multipliers: n,
      drift_score,
      max_deviation,
      min_multiplier,
      max_multiplier,
    });
  }

  // Sort: drift_score desc, then preset_id asc tie-break
  rows.sort((a, b) => {
    if (b.drift_score !== a.drift_score) return b.drift_score - a.drift_score;
    return a.preset_id < b.preset_id ? -1 : a.preset_id > b.preset_id ? 1 : 0;
  });

  const most_drifted =
    rows.length > 0 && rows[0].total_multipliers > 0 && rows[0].drift_score > 0
      ? { preset_id: rows[0].preset_id, name: rows[0].name, drift_score: rows[0].drift_score }
      : null;

  const fleet_avg_drift =
    rows.length > 0
      ? Math.round(rows.reduce((s, r) => s + r.drift_score, 0) / rows.length * 10000) / 10000
      : 0;

  return {
    generated_at: now.toISOString(),
    total_custom_presets: rows.length,
    presets: rows,
    most_drifted,
    fleet_avg_drift,
  };
}
