// services/bff/src/scoring_preset_portfolio_impact.ts
// T6 M6.27 — Weight preset impact on portfolio.
// Computes risk scores for a synthetic 50-customer portfolio per preset.

import { WEIGHT_PRESETS } from './scoring_presets';
import { computeRiskScore } from './bil_scoring';
import { STUB_CATALOG } from './bil_scoring_v2';

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

export interface PresetPortfolioImpact {
  preset_id: string;
  name: string;
  mode: string;
  vertical: string;
  portfolio_high_risk_count: number;
  portfolio_medium_risk_count: number;
  portfolio_low_risk_count: number;
  high_risk_rate: number; // high / 50
  avg_score: number;
}

export interface ScoringPresetPortfolioImpactResult {
  tenant_id: string;
  generated_at: string;
  portfolio_size: 50;
  presets: PresetPortfolioImpact[];
  most_conservative_preset: string | null;
  most_lenient_preset: string | null;
}

const PORTFOLIO_SIZE = 50;

export function buildScoringPresetPortfolioImpact(
  tenant_id: string,
  now: Date,
): ScoringPresetPortfolioImpactResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const dayKey = Math.floor(now.getTime() / 86_400_000);

  // Build 50 synthetic customers: for each customer, generate indicator values
  // deterministically seeded by (tenant, customer_idx, day)
  const catalogKeys = Object.keys(STUB_CATALOG);

  const customerItems = Array.from({ length: PORTFOLIO_SIZE }, (_, cidx) => {
    const custSeed = fnv1a(`${tenant_id}:portfolio_cust:${cidx}:${dayKey}`);
    const rng = mulberry32(custSeed);
    return catalogKeys.map((indicator_id) => ({
      indicator_id,
      weight: STUB_CATALOG[indicator_id].weight,
      value: rng(), // [0,1]
    }));
  });

  const presets: PresetPortfolioImpact[] = WEIGHT_PRESETS.map((preset) => {
    let totalScore = 0;
    let high = 0;
    let medium = 0;
    let low = 0;

    for (const items of customerItems) {
      // Apply preset multipliers
      const adjustedItems = items.map((it) => {
        const multiplier = preset.weight_multipliers[it.indicator_id] ?? 1.0;
        const effective = Math.min(1, it.weight * multiplier);
        return { indicator_id: it.indicator_id, weight: effective, value: it.value };
      });

      const result = computeRiskScore(adjustedItems);
      totalScore += result.score;
      if (result.category === 'high') high++;
      else if (result.category === 'medium') medium++;
      else low++;
    }

    const avg_score = Math.round((totalScore / PORTFOLIO_SIZE) * 100) / 100;
    const high_risk_rate = Math.round((high / PORTFOLIO_SIZE) * 10000) / 10000;

    return {
      preset_id: preset.id,
      name: preset.name,
      mode: preset.mode,
      vertical: preset.vertical,
      portfolio_high_risk_count: high,
      portfolio_medium_risk_count: medium,
      portfolio_low_risk_count: low,
      high_risk_rate,
      avg_score,
    };
  });

  // Sort by high_risk_rate desc
  presets.sort((a, b) => b.high_risk_rate - a.high_risk_rate || a.preset_id.localeCompare(b.preset_id));

  const mostConservative = presets.length > 0 ? presets[0].preset_id : null;
  const mostLenient = presets.length > 0 ? presets[presets.length - 1].preset_id : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    portfolio_size: 50,
    presets,
    most_conservative_preset: mostConservative,
    most_lenient_preset: mostLenient,
  };
}
