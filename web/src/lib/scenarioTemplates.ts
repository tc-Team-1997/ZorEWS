// Pre-defined scenario templates surfaced as one-click buttons above the
// macro shock sliders. The values are illustrative — they should be
// calibrated against historical macro/PD time series in production. The
// goal of the prototype is to spare the analyst from re-typing common
// stress combinations and to anchor conversations ("show me the COVID
// shock again, but with rates +200 bps on top").
//
// Sources / rationale (documented inline so a CRO can audit):
//   - mild:   ~half a typical RBI mild stress (paired with rate hike)
//   - severe: combines the worst single-quarter India macro shifts seen
//             in the 2008 GFC + 2013 taper tantrum (rough magnitudes)
//   - covid:  India FY21 actuals — GDP -7.3%, repo down 75 bps, INR -3%
//   - rbi:    matches the 2024 RBI scenario-2 ("severe") guidance shape

import type { ShockInputs } from './api';

export interface ScenarioTemplate {
  id: string;
  label: string;
  description: string;
  inputs: ShockInputs;
}

export const SCENARIO_TEMPLATES: ReadonlyArray<ScenarioTemplate> = [
  {
    id: 'baseline',
    label: 'Baseline',
    description: 'No shock — verify the engine returns identity numbers.',
    inputs: { gdp: 0, rate: 0, fx: 0 },
  },
  {
    id: 'mild',
    label: 'Mild recession',
    description: 'GDP -2%, rate +50 bps, FX +3% — moderate slowdown.',
    inputs: { gdp: -2, rate: 50, fx: 3 },
  },
  {
    id: 'severe',
    label: 'Severe recession',
    description: 'GDP -5%, rate +200 bps, FX +8% — sharp contraction.',
    inputs: { gdp: -5, rate: 200, fx: 8 },
  },
  {
    id: 'covid',
    label: 'COVID-like shock',
    description: 'GDP -7%, rate -75 bps, FX +5% — pandemic-style demand cliff.',
    // Rate slider min is -200 so -75 is in range.
    inputs: { gdp: -7, rate: -75, fx: 5 },
  },
  {
    id: 'rbi',
    label: 'RBI mandated stress',
    description: 'GDP -3%, rate +200 bps, FX +10% — matches RBI scenario-2 shape.',
    inputs: { gdp: -3, rate: 200, fx: 10 },
  },
] as const;
