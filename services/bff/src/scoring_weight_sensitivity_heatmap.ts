// services/bff/src/scoring_weight_sensitivity_heatmap.ts
// T6 M6.28 — Scoring weight sensitivity heatmap.

import { STUB_CATALOG } from './bil_scoring_v2';
import { listWeightPresets } from './scoring_presets';
import { computeRiskScore } from './bil_scoring';

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = ((r ^ (r >>> 15)) * (r | 1)) >>> 0;
    r = (r ^ (r + ((r ^ (r >>> 7)) * (r | 61)))) >>> 0;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const BOOST = 0.1;
const PORTFOLIO_SIZE = 20;

export interface IndicatorSensitivity {
  indicator_id: string;
  avg_sensitivity: number;
}

export interface PresetSensitivity {
  preset_id: string;
  avg_sensitivity: number;
}

export interface ScoringWeightSensitivityHeatmap {
  tenant_id: string;
  generated_at: string;
  indicators: IndicatorSensitivity[];
  presets: PresetSensitivity[];
  most_sensitive_indicator: string | null;
  most_sensitive_preset: string | null;
}

export function buildScoringWeightSensitivityHeatmap(
  tenant_id: string,
  now: Date,
): ScoringWeightSensitivityHeatmap {
  const dayStr = now.toISOString().slice(0, 10);
  const indicatorIds = Object.keys(STUB_CATALOG);
  const presets = listWeightPresets();

  // Synthetic portfolio
  const portfolio = Array.from({ length: PORTFOLIO_SIZE }, (_, i) => {
    const rng = mulberry32(fnv1a(`${tenant_id}:${dayStr}:portfolio:${i}`));
    return indicatorIds.map((id) => ({ indicator_id: id, weight: STUB_CATALOG[id].weight, value: rng() }));
  });

  // For each indicator, compute avg |score_change| when weight is boosted
  const indicatorSensitivities: IndicatorSensitivity[] = indicatorIds.map((indicator_id) => {
    let totalDelta = 0;
    for (const items of portfolio) {
      const baseline = computeRiskScore(items).score;
      const boosted = items.map((item) =>
        item.indicator_id === indicator_id
          ? { ...item, weight: Math.min(1, item.weight + BOOST) }
          : item,
      );
      const boostedScore = computeRiskScore(boosted).score;
      totalDelta += Math.abs(boostedScore - baseline);
    }
    return { indicator_id, avg_sensitivity: Math.round((totalDelta / PORTFOLIO_SIZE) * 10000) / 10000 };
  });
  indicatorSensitivities.sort((a, b) => b.avg_sensitivity - a.avg_sensitivity);

  // For each preset, compute avg sensitivity across all indicators
  const presetSensitivities: PresetSensitivity[] = presets.map((preset) => {
    const multipliers = preset.weight_multipliers ?? {};
    let totalDelta = 0;
    let count = 0;
    for (const indicator_id of indicatorIds) {
      const entry = STUB_CATALOG[indicator_id];
      for (const items of portfolio) {
        const baseItems = items.map((item) => ({
          ...item,
          weight: Math.min(1, Math.max(0, item.weight * (multipliers[item.indicator_id] ?? 1))),
        }));
        const baseline = computeRiskScore(baseItems).score;
        const boosted = baseItems.map((item) =>
          item.indicator_id === indicator_id
            ? { ...item, weight: Math.min(1, item.weight + BOOST) }
            : item,
        );
        const boostedScore = computeRiskScore(boosted).score;
        totalDelta += Math.abs(boostedScore - baseline);
        count++;
      }
    }
    return { preset_id: preset.id, avg_sensitivity: count > 0 ? Math.round((totalDelta / count) * 10000) / 10000 : 0 };
  });
  presetSensitivities.sort((a, b) => b.avg_sensitivity - a.avg_sensitivity);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    indicators: indicatorSensitivities,
    presets: presetSensitivities,
    most_sensitive_indicator: indicatorSensitivities.length > 0 ? indicatorSensitivities[0].indicator_id : null,
    most_sensitive_preset: presetSensitivities.length > 0 ? presetSensitivities[0].preset_id : null,
  };
}
