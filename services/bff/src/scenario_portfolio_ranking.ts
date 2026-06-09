// services/bff/src/scenario_portfolio_ranking.ts
//
// T6 M16.25 — Scenario preset portfolio impact ranking.
//
// Ranks every scenario library preset by a normalised impact_index
// (0-1) derived from the three shock axes weighted 40/35/25 (GDP /
// rate / FX). Reference maxima are the RBI severely-adverse values
// (GDP 7 pp, rate 400 bps, FX 15 %) so the index is calibrated to
// the regulatory worst-case.
//
// Drives the SPA's "portfolio stress ladder" — a ranked table the
// risk committee can drop into the quarterly board pack. Platform-static.

import {
  SCENARIO_PRESETS,
  type ScenarioCategory,
  type ScenarioPreset,
  type ScenarioSeverity,
} from './scenario_library';

// ─── Normalisation reference maxima (RBI severely-adverse) ────────────

const GDP_MAX_ABS = 7;   // pp
const RATE_MAX_ABS = 400; // bps
const FX_MAX_ABS = 15;   // %

// ─── Public types ─────────────────────────────────────────────────────

export type PortfolioTier = 'catastrophic' | 'severe' | 'moderate' | 'mild';

export interface PortfolioRankingRow {
  rank: number;
  preset_id: string;
  name: string;
  category: ScenarioCategory;
  severity: ScenarioSeverity;
  gdp_shock: number;
  rate_shock: number;
  fx_shock: number;
  /** Weighted normalised impact index in [0, 1] (4 dp). */
  impact_index: number;
  /** Tier classification based on impact_index.
   *  catastrophic > 0.7, severe > 0.5, moderate > 0.3, mild otherwise. */
  portfolio_tier: PortfolioTier;
}

export interface ScenarioPortfolioRankingSummary {
  generated_at: string;
  total_presets: number;
  rankings: PortfolioRankingRow[];
  most_impactful: { preset_id: string; name: string; impact_index: number } | null;
  average_impact_index: number;
  catastrophic_count: number;
  zero_impact_count: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function computeImpactIndex(gdp: number, rate: number, fx: number): number {
  const g = Math.min(1, Math.abs(gdp) / GDP_MAX_ABS);
  const r = Math.min(1, Math.abs(rate) / RATE_MAX_ABS);
  const f = Math.min(1, Math.abs(fx) / FX_MAX_ABS);
  const idx = g * 0.4 + r * 0.35 + f * 0.25;
  return Math.round(idx * 10000) / 10000;
}

function tierFor(idx: number): PortfolioTier {
  if (idx > 0.7) return 'catastrophic';
  if (idx > 0.5) return 'severe';
  if (idx > 0.3) return 'moderate';
  return 'mild';
}

// ─── Main pure function ───────────────────────────────────────────────

export function buildScenarioPortfolioRanking(
  now: Date,
  presets: readonly ScenarioPreset[] = SCENARIO_PRESETS,
): ScenarioPortfolioRankingSummary {
  // Compute impact_index for each preset.
  const withIdx = presets.map((p) => ({
    preset: p,
    impact_index: computeImpactIndex(p.shocks.gdp, p.shocks.rate, p.shocks.fx),
  }));

  // Sort descending impact_index, then preset_id asc.
  withIdx.sort((a, b) => {
    if (b.impact_index !== a.impact_index) return b.impact_index - a.impact_index;
    return a.preset.id < b.preset.id ? -1 : a.preset.id > b.preset.id ? 1 : 0;
  });

  const rankings: PortfolioRankingRow[] = withIdx.map(({ preset, impact_index }, i) => ({
    rank: i + 1,
    preset_id: preset.id,
    name: preset.name,
    category: preset.category,
    severity: preset.severity,
    gdp_shock: preset.shocks.gdp,
    rate_shock: preset.shocks.rate,
    fx_shock: preset.shocks.fx,
    impact_index,
    portfolio_tier: tierFor(impact_index),
  }));

  const total_presets = rankings.length;
  const most_impactful = total_presets > 0
    ? { preset_id: rankings[0].preset_id, name: rankings[0].name, impact_index: rankings[0].impact_index }
    : null;

  const average_impact_index = total_presets > 0
    ? Math.round(rankings.reduce((s, r) => s + r.impact_index, 0) / total_presets * 10000) / 10000
    : 0;

  const catastrophic_count = rankings.filter((r) => r.portfolio_tier === 'catastrophic').length;
  const zero_impact_count = rankings.filter((r) => r.impact_index === 0).length;

  return {
    generated_at: now.toISOString(),
    total_presets,
    rankings,
    most_impactful,
    average_impact_index,
    catastrophic_count,
    zero_impact_count,
  };
}
