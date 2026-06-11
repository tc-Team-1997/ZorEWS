// services/bff/src/scenario_sensitivity_ranking.ts
//
// T6 M16.26 — Scenario preset sensitivity ranking by factor.
//
// Ranks presets by absolute shock magnitude per GDP/rate/fx axis.

import { listScenarioPresets, type ScenarioPreset } from './scenario_library';

// ─── Public types ──────────────────────────────────────────────────────

export interface SensitivityEntry {
  preset_id: string;
  name: string;
  shock: number;
  rank: number;
}

export interface SensitivityRanking {
  generated_at: string;
  total_presets: number;
  by_factor: {
    gdp: SensitivityEntry[];
    rate: SensitivityEntry[];
    fx: SensitivityEntry[];
  };
  most_gdp_sensitive: { preset_id: string; name: string; shock: number } | null;
  most_rate_sensitive: { preset_id: string; name: string; shock: number } | null;
  most_fx_sensitive: { preset_id: string; name: string; shock: number } | null;
  balanced_presets: string[];
}

// ─── Pure function ─────────────────────────────────────────────────────

export function buildScenarioSensitivityRanking(
  presets: ScenarioPreset[],
  now: Date,
): SensitivityRanking {
  const generated_at = now.toISOString();
  const total_presets = presets.length;

  function rankByFactor(factor: 'gdp' | 'rate' | 'fx'): SensitivityEntry[] {
    const sorted = [...presets].sort((a, b) => {
      return Math.abs(b.shocks[factor]) - Math.abs(a.shocks[factor]);
    });
    return sorted.map((p, i) => ({
      preset_id: p.id,
      name: p.name,
      shock: p.shocks[factor],
      rank: i + 1,
    }));
  }

  const gdp = rankByFactor('gdp');
  const rate = rankByFactor('rate');
  const fx = rankByFactor('fx');

  const most_gdp_sensitive = gdp[0] && Math.abs(gdp[0].shock) > 0
    ? { preset_id: gdp[0].preset_id, name: gdp[0].name, shock: gdp[0].shock }
    : null;
  const most_rate_sensitive = rate[0] && Math.abs(rate[0].shock) > 0
    ? { preset_id: rate[0].preset_id, name: rate[0].name, shock: rate[0].shock }
    : null;
  const most_fx_sensitive = fx[0] && Math.abs(fx[0].shock) > 0
    ? { preset_id: fx[0].preset_id, name: fx[0].name, shock: fx[0].shock }
    : null;

  // Balanced = all 3 factors have shock != 0
  const balanced_presets = presets
    .filter(p => p.shocks.gdp !== 0 && p.shocks.rate !== 0 && p.shocks.fx !== 0)
    .map(p => p.id)
    .sort();

  return {
    generated_at,
    total_presets,
    by_factor: { gdp, rate, fx },
    most_gdp_sensitive,
    most_rate_sensitive,
    most_fx_sensitive,
    balanced_presets,
  };
}

export function buildScenarioSensitivityRankingFromLibrary(now: Date): SensitivityRanking {
  return buildScenarioSensitivityRanking(listScenarioPresets(), now);
}
