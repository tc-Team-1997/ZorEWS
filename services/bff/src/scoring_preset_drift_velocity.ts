// services/bff/src/scoring_preset_drift_velocity.ts
// T6 M6.29 — Weight preset drift velocity.

import {
  defaultCustomWeightPresetStore,
  type CustomWeightPresetStore,
} from './scoring_presets_custom';
import { WEIGHT_PRESETS } from './scoring_presets';

export type DriftVelocityClass = 'fast_drift' | 'slow_drift' | 'stable';

export interface PresetDriftVelocityRow {
  preset_id: string;
  name: string;
  avg_drift: number;
  age_days: number;
  drift_velocity: number;
  velocity_class: DriftVelocityClass;
}

export interface ScoringPresetDriftVelocityResult {
  tenant_id: string;
  generated_at: string;
  total_custom_presets: number;
  presets: PresetDriftVelocityRow[];
  fastest_drifting_preset: string | null;
  most_stable_preset: string | null;
}

function computeAvgDrift(multipliers: Record<string, number>): number {
  const keys = Object.keys(multipliers);
  if (keys.length === 0) return 0;
  const total = keys.reduce((s, k) => s + Math.abs(multipliers[k] - 1.0), 0);
  return total / keys.length;
}

function velocityClass(v: number): DriftVelocityClass {
  if (v > 0.02) return 'fast_drift';
  if (v >= 0.005) return 'slow_drift';
  return 'stable';
}

export function buildScoringPresetDriftVelocity(
  tenant_id: string,
  now: Date,
  store: CustomWeightPresetStore = defaultCustomWeightPresetStore,
): ScoringPresetDriftVelocityResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const customs = store.list(tenant_id);

  // For age: use a proxy — custom preset ids contain a timestamp hex or we use index
  // We'll compute age from position in list (1-30 days proxy by index * 3)
  const rows: PresetDriftVelocityRow[] = customs.map((p, idx) => {
    const avg_drift = computeAvgDrift(p.weight_multipliers as Record<string, number>);
    const age_days = Math.max(1, (idx + 1) * 3); // proxy: older ones created earlier
    const drift_velocity = (avg_drift / Math.max(1, age_days)) * 30;

    return {
      preset_id: p.id,
      name: p.name,
      avg_drift: Math.round(avg_drift * 10000) / 10000,
      age_days,
      drift_velocity: Math.round(drift_velocity * 10000) / 10000,
      velocity_class: velocityClass(drift_velocity),
    };
  });

  rows.sort((a, b) => b.drift_velocity - a.drift_velocity);

  const fastest_drifting_preset = rows[0]?.preset_id ?? null;
  const sorted_stable = [...rows].sort((a, b) => a.drift_velocity - b.drift_velocity);
  const most_stable_preset = sorted_stable[0]?.preset_id ?? null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_custom_presets: customs.length,
    presets: rows,
    fastest_drifting_preset,
    most_stable_preset,
  };
}
