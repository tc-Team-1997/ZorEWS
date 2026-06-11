// services/bff/src/scoring_weight_drift.ts
//
// T6 M6.24 — Scoring weight drift from baseline.
//
// For each custom weight preset, compares its multipliers against the
// "balanced" library preset for the same vertical (all multipliers = 1.0).

import { type CustomWeightPresetStore } from './scoring_presets_custom';

// ─── Public types ──────────────────────────────────────────────────────

export type DriftDirection = 'tighten' | 'loosen' | 'mixed' | 'none';

export interface ScoringWeightDriftEntry {
  preset_id: string;
  name: string;
  mode: string;
  vertical: string;
  total_indicators_modified: number;
  avg_drift: number; // mean |multiplier - 1.0| across modified
  max_drift: number; // max |multiplier - 1.0|
  drift_direction: DriftDirection;
}

export interface ScoringWeightDriftResult {
  tenant_id: string;
  generated_at: string;
  presets: ScoringWeightDriftEntry[];
  most_drifted_preset: ScoringWeightDriftEntry | null;
  avg_drift_across_presets: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function computeDriftDirection(multipliers: Record<string, number>): DriftDirection {
  const values = Object.values(multipliers).filter((v) => v !== 1.0);
  if (values.length === 0) return 'none';

  const aboveCnt = values.filter((v) => v > 1.0).length;
  const belowCnt = values.filter((v) => v < 1.0).length;

  if (aboveCnt > 0 && belowCnt === 0) return 'tighten'; // boosted = tighten toward catching risk
  if (belowCnt > 0 && aboveCnt === 0) return 'loosen'; // dampened = loosen
  if (aboveCnt > 0 && belowCnt > 0) return 'mixed';
  return 'none';
}

// ─── Main function ────────────────────────────────────────────────────

export function computeScoringWeightDrift(
  tenant_id: string,
  store: CustomWeightPresetStore,
  now: Date,
): ScoringWeightDriftResult {
  const customPresets = store.list(tenant_id);
  const entries: ScoringWeightDriftEntry[] = [];

  for (const preset of customPresets) {
    const mults = preset.weight_multipliers ?? {};
    const modifiedKeys = Object.keys(mults).filter((k) => mults[k] !== 1.0);
    const total_indicators_modified = modifiedKeys.length;

    let avg_drift = 0;
    let max_drift = 0;

    if (modifiedKeys.length > 0) {
      const drifts = modifiedKeys.map((k) => Math.abs(mults[k] - 1.0));
      avg_drift = drifts.reduce((s, d) => s + d, 0) / drifts.length;
      max_drift = Math.max(...drifts);
    }

    entries.push({
      preset_id: preset.id,
      name: preset.name,
      mode: preset.mode,
      vertical: preset.vertical,
      total_indicators_modified,
      avg_drift: Math.round(avg_drift * 10000) / 10000,
      max_drift: Math.round(max_drift * 10000) / 10000,
      drift_direction: computeDriftDirection(mults),
    });
  }

  // Sort by avg_drift desc
  entries.sort((a, b) => b.avg_drift - a.avg_drift);

  const avg_drift_across_presets =
    entries.length > 0
      ? Math.round(
          (entries.reduce((s, e) => s + e.avg_drift, 0) / entries.length) * 10000,
        ) / 10000
      : 0;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    presets: entries,
    most_drifted_preset: entries.length > 0 ? entries[0] : null,
    avg_drift_across_presets,
  };
}
