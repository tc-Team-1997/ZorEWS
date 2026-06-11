/**
 * M6.25 — Preset scoring variance analysis
 * Computes score variance for a synthetic 20-customer portfolio across all presets.
 */

import { WEIGHT_PRESETS } from './scoring_presets';
import { STUB_CATALOG } from './bil_scoring_v2';
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

const PORTFOLIO_SIZE = 20;

export interface PresetVarianceResult {
  preset_id: string;
  name: string;
  mode: string;
  vertical: string;
  scores: number[];
  mean_score: number;
  std_dev: number;
  min_score: number;
  max_score: number;
  variance_coefficient: number;
}

export interface ScoringPresetVarianceReport {
  tenant_id: string;
  generated_at: string;
  portfolio_size: number;
  presets: PresetVarianceResult[];
  most_volatile_preset: string | null;
  most_stable_preset: string | null;
}

function buildPortfolioItems(
  tenant_id: string,
  customer_idx: number,
  vertical: string,
): Array<{ indicator_id: string; weight: number; value: number }> {
  const items: Array<{ indicator_id: string; weight: number; value: number }> = [];

  for (const [indicator_id, entry] of Object.entries(STUB_CATALOG)) {
    const ev: string = entry.vertical;
    if (vertical !== 'both' && ev !== 'both' && ev !== vertical) continue;
    const seed = fnv1a(`${tenant_id}:${customer_idx}:${indicator_id}`);
    const rng = mulberry32(seed);
    const value = rng();
    items.push({ indicator_id, weight: entry.weight, value });
  }
  return items;
}

export function buildScoringPresetVariance(
  tenant_id: string,
  now: Date = new Date(),
): ScoringPresetVarianceReport {
  if (!tenant_id) throw new Error('tenant_id required');

  const presets: PresetVarianceResult[] = [];

  for (const preset of WEIGHT_PRESETS) {
    const scores: number[] = [];

    for (let i = 0; i < PORTFOLIO_SIZE; i++) {
      const baseItems = buildPortfolioItems(tenant_id, i, preset.vertical);
      // Apply multipliers
      const items = baseItems.map((item) => {
        const multiplier = preset.weight_multipliers[item.indicator_id] ?? 1.0;
        const effective_weight = Math.min(1, Math.max(0, item.weight * multiplier));
        return { indicator_id: item.indicator_id, weight: effective_weight, value: item.value };
      });

      if (items.length === 0) {
        scores.push(0);
        continue;
      }

      const result = computeRiskScore(items);
      scores.push(result.score);
    }

    const mean_score = scores.reduce((s, v) => s + v, 0) / scores.length;
    const variance = scores.reduce((s, v) => s + (v - mean_score) ** 2, 0) / scores.length;
    const std_dev = Math.sqrt(variance);
    const min_score = Math.min(...scores);
    const max_score = Math.max(...scores);
    const variance_coefficient = mean_score > 0 ? std_dev / mean_score : 0;

    presets.push({
      preset_id: preset.id,
      name: preset.name,
      mode: preset.mode,
      vertical: preset.vertical,
      scores,
      mean_score,
      std_dev,
      min_score,
      max_score,
      variance_coefficient,
    });
  }

  // Sort by variance_coefficient desc
  presets.sort((a, b) => b.variance_coefficient - a.variance_coefficient);

  const most_volatile_preset = presets.length > 0 ? presets[0].preset_id : null;
  const most_stable_preset = presets.length > 0 ? presets[presets.length - 1].preset_id : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    portfolio_size: PORTFOLIO_SIZE,
    presets,
    most_volatile_preset,
    most_stable_preset,
  };
}
