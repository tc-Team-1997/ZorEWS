// services/bff/src/scenario_stress_contribution.ts
//
// T6 M16.27 — Scenario stress factor contribution.
//
// For each scenario preset in the M16.1 library, decompose the
// total stress into factor contributions:
//   gdp_contribution  = |gdp|  / (|gdp| + |rate| + |fx| + ε) * 100
//   rate_contribution = |rate| / (same) * 100
//   fx_contribution   = |fx|   / (same) * 100
// Where ε=0.001 to avoid division by zero.
// For the all-zero baseline: all contributions = 33.33.
// dominant_factor = highest contribution.

import { listScenarioPresets, type ScenarioPreset } from './scenario_library';

const EPSILON = 0.001;

type ShockAxis = 'gdp' | 'rate' | 'fx';

export interface StressContributionRow {
  preset_id: string;
  name: string;
  category: ScenarioPreset['category'];
  severity: ScenarioPreset['severity'];
  gdp_contribution: number;
  rate_contribution: number;
  fx_contribution: number;
  dominant_factor: ShockAxis;
}

export interface ScenarioStressContributionResult {
  generated_at: string;
  total_presets: number;
  presets: StressContributionRow[];
  by_dominant_factor: Record<ShockAxis, number>;
}

export function buildScenarioStressContribution(now: Date): ScenarioStressContributionResult {
  const presets = listScenarioPresets();

  const rows: StressContributionRow[] = presets.map((p) => {
    const absGdp = Math.abs(p.shocks.gdp);
    const absRate = Math.abs(p.shocks.rate);
    const absFx = Math.abs(p.shocks.fx);
    const rawTotal = absGdp + absRate + absFx;

    // All-zero baseline → equal 33.33% split across 3 axes
    let gdp_contribution: number;
    let rate_contribution: number;
    let fx_contribution: number;
    if (rawTotal === 0) {
      gdp_contribution = 33.33;
      rate_contribution = 33.33;
      fx_contribution = 33.34; // rounds to ~33.33 but sums to 100
    } else {
      const total = rawTotal + EPSILON;
      gdp_contribution = Math.round((absGdp / total) * 100 * 100) / 100;
      rate_contribution = Math.round((absRate / total) * 100 * 100) / 100;
      fx_contribution = Math.round((absFx / total) * 100 * 100) / 100;
    }

    let dominant_factor: ShockAxis = 'gdp';
    if (rate_contribution > gdp_contribution && rate_contribution >= fx_contribution) dominant_factor = 'rate';
    else if (fx_contribution > gdp_contribution && fx_contribution > rate_contribution) dominant_factor = 'fx';

    return {
      preset_id: p.id,
      name: p.name,
      category: p.category,
      severity: p.severity,
      gdp_contribution,
      rate_contribution,
      fx_contribution,
      dominant_factor,
    };
  });

  rows.sort((a, b) => a.preset_id.localeCompare(b.preset_id));

  const by_dominant_factor: Record<ShockAxis, number> = { gdp: 0, rate: 0, fx: 0 };
  for (const r of rows) {
    by_dominant_factor[r.dominant_factor]++;
  }

  return {
    generated_at: now.toISOString(),
    total_presets: rows.length,
    presets: rows,
    by_dominant_factor,
  };
}
