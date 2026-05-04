// services/bff/src/scenario_library.ts
//
// T6 M16.1 — BIL named scenario library.
//
// Module 16 (Scenario Simulation) had T4.2 surface (`/v1/scenario/run`
// taking raw `{gdp, rate, fx}` shocks) and T4.18 saved scenarios
// (per-user save/list/delete). What was missing: a *platform-wide*
// library of pre-built BIL-flavoured scenarios admins can run instantly
// without configuring shocks manually.
//
// Mirrors the M5.1 rule-template approach: read-only, declared at the
// platform level, every tenant sees the same library; cloning into a
// user-saved scenario is a separate op via T4.18.

// ─── Public types ──────────────────────────────────────────────────────

export type ScenarioCategory = 'regulatory' | 'business' | 'black_swan' | 'baseline';

export type ScenarioRegulator = 'RBI' | 'IRDAI' | 'INTERNAL';

export type ScenarioSeverity = 'mild' | 'moderate' | 'severe';

export interface ScenarioShocks {
  /** GDP growth shock — percentage points (negative = contraction). */
  gdp: number;
  /** Interest-rate shock — basis points. */
  rate: number;
  /** FX shock — percentage move (positive = local-currency depreciation). */
  fx: number;
}

export interface ScenarioPreset {
  id: string;
  name: string;
  description: string;
  category: ScenarioCategory;
  regulator: ScenarioRegulator;
  severity: ScenarioSeverity;
  shocks: ScenarioShocks;
  /** BIL pitch / regulator citation for audit. */
  source_doc: string;
}

const VALID_CATEGORIES: ScenarioCategory[] = ['regulatory', 'business', 'black_swan', 'baseline'];
const VALID_REGULATORS: ScenarioRegulator[] = ['RBI', 'IRDAI', 'INTERNAL'];
const VALID_SEVERITIES: ScenarioSeverity[] = ['mild', 'moderate', 'severe'];

export function isScenarioCategory(s: unknown): s is ScenarioCategory {
  return typeof s === 'string' && VALID_CATEGORIES.includes(s as ScenarioCategory);
}
export function isScenarioRegulator(s: unknown): s is ScenarioRegulator {
  return typeof s === 'string' && VALID_REGULATORS.includes(s as ScenarioRegulator);
}
export function isScenarioSeverity(s: unknown): s is ScenarioSeverity {
  return typeof s === 'string' && VALID_SEVERITIES.includes(s as ScenarioSeverity);
}

// ─── Seed library ──────────────────────────────────────────────────────
//
// 10 BIL scenarios drawn from RBI stress-test framework + IRDAI Form-K
// solvency reserve scenarios + the BIL pitch §13 black-swan playbook.

export const SCENARIO_PRESETS: readonly ScenarioPreset[] = [
  // baseline
  {
    id: 'preset_baseline_no_shock',
    name: 'Baseline — no shock',
    description: 'Sanity-check baseline; expects ECL delta to be near zero',
    category: 'baseline',
    regulator: 'INTERNAL',
    severity: 'mild',
    shocks: { gdp: 0, rate: 0, fx: 0 },
    source_doc: 'Internal QA',
  },

  // regulatory — RBI
  {
    id: 'preset_rbi_baseline_stress',
    name: 'RBI Baseline Stress',
    description: 'RBI annual stress-test baseline scenario — mild macro contraction',
    category: 'regulatory',
    regulator: 'RBI',
    severity: 'mild',
    shocks: { gdp: -1, rate: 50, fx: 3 },
    source_doc: 'RBI Stress-Test Framework §3.1',
  },
  {
    id: 'preset_rbi_adverse_stress',
    name: 'RBI Adverse Stress',
    description: 'RBI annual stress-test adverse scenario — moderate recession',
    category: 'regulatory',
    regulator: 'RBI',
    severity: 'moderate',
    shocks: { gdp: -2.5, rate: 150, fx: 7 },
    source_doc: 'RBI Stress-Test Framework §3.2',
  },
  {
    id: 'preset_rbi_severely_adverse',
    name: 'RBI Severely Adverse',
    description: 'RBI annual stress-test severe scenario — recession + currency stress',
    category: 'regulatory',
    regulator: 'RBI',
    severity: 'severe',
    shocks: { gdp: -4, rate: 300, fx: 12 },
    source_doc: 'RBI Stress-Test Framework §3.3',
  },

  // regulatory — IRDAI
  {
    id: 'preset_irdai_solvency_stress',
    name: 'IRDAI Solvency Stress',
    description: 'IRDAI Form-K reserve stress scenario for life + general insurance',
    category: 'regulatory',
    regulator: 'IRDAI',
    severity: 'moderate',
    shocks: { gdp: -2, rate: 100, fx: 5 },
    source_doc: 'IRDAI Form-K Solvency Annex',
  },

  // business
  {
    id: 'preset_rate_hike_200bps',
    name: 'Rate hike +200bps',
    description: 'Single-shock rate hike — repricing risk on the loan book',
    category: 'business',
    regulator: 'INTERNAL',
    severity: 'mild',
    shocks: { gdp: 0, rate: 200, fx: 0 },
    source_doc: 'BIL pitch §13',
  },
  {
    id: 'preset_fx_devaluation_10',
    name: 'FX devaluation 10%',
    description: 'Single-shock currency devaluation — import-dependent sectors hit hardest',
    category: 'business',
    regulator: 'INTERNAL',
    severity: 'moderate',
    shocks: { gdp: 0, rate: 0, fx: 10 },
    source_doc: 'BIL pitch §13',
  },
  {
    id: 'preset_growth_optimistic',
    name: 'Growth — optimistic',
    description: 'Strong GDP growth + rate cut — upside scenario for portfolio quality',
    category: 'business',
    regulator: 'INTERNAL',
    severity: 'mild',
    shocks: { gdp: 2, rate: -50, fx: -2 },
    source_doc: 'BIL pitch §13',
  },

  // black_swan
  {
    id: 'preset_pandemic_stress',
    name: 'Pandemic stress',
    description: 'Deep contraction with rate-cut response — pandemic-style shock',
    category: 'black_swan',
    regulator: 'INTERNAL',
    severity: 'severe',
    shocks: { gdp: -7, rate: -100, fx: 8 },
    source_doc: 'BIL pitch §13 / 2020 calibration',
  },
  {
    id: 'preset_stagflation',
    name: 'Stagflation',
    description: 'Negative growth + sharply higher rates + currency stress',
    category: 'black_swan',
    regulator: 'INTERNAL',
    severity: 'severe',
    shocks: { gdp: -3, rate: 400, fx: 15 },
    source_doc: 'BIL pitch §13',
  },
];

const PRESETS_BY_ID = new Map<string, ScenarioPreset>(SCENARIO_PRESETS.map((p) => [p.id, p]));

export interface PresetFilter {
  category?: ScenarioCategory;
  regulator?: ScenarioRegulator;
  severity?: ScenarioSeverity;
}

export function listScenarioPresets(filter: PresetFilter = {}): ScenarioPreset[] {
  return SCENARIO_PRESETS.filter((p) => {
    if (filter.category && p.category !== filter.category) return false;
    if (filter.regulator && p.regulator !== filter.regulator) return false;
    if (filter.severity && p.severity !== filter.severity) return false;
    return true;
  });
}

export function getScenarioPreset(id: string): ScenarioPreset | null {
  return PRESETS_BY_ID.get(id) ?? null;
}

export function listScenarioCategories(): ScenarioCategory[] {
  return [...VALID_CATEGORIES];
}
