// services/bff/src/scenario_magnitude.ts
//
// T6 M16.18 — Scenario library shock magnitude rollup.
//
// M16.15 ships radar-chart normalisation per axis onto [-1, 1].
// M16.18 ships the COMPLEMENTARY "single severity score" view:
// normalise each axis to [0, 1] against the library max-abs,
// average → magnitude_normalised ∈ [0, 1] per preset, then roll
// up to per-category aggregates (total + mean + worst preset).
//
// Drives the SPA's "shock severity ladder" — answers "which
// preset is the heaviest?" with ONE comparable number across
// preset categories and severities. Companion to M16.17 (coverage
// matrix counts) but axis = magnitude rather than presence.
//
// Pure rollup. Platform-static.

import {
  SCENARIO_PRESETS,
  type ScenarioCategory,
  type ScenarioPreset,
  type ScenarioSeverity,
} from './scenario_library';

// ─── Public types ─────────────────────────────────────────────────────

const CATEGORIES: readonly ScenarioCategory[] = [
  'baseline',
  'business',
  'regulatory',
  'black_swan',
] as const;

export interface ScenarioMagnitudeRow {
  preset_id: string;
  name: string;
  category: ScenarioCategory;
  severity: ScenarioSeverity;
  /** Raw absolute shock values. */
  gdp_abs: number;
  rate_abs: number;
  fx_abs: number;
  /** Per-axis normalised values in [0, 1] against the library max-abs. */
  gdp_norm: number;
  rate_norm: number;
  fx_norm: number;
  /** Mean of (gdp_norm, rate_norm, fx_norm). 0 = baseline-no-shock,
   *  1 = preset that simultaneously has the library max-abs on every
   *  axis (rarely reached in practice). */
  magnitude_normalised: number;
}

export interface CategoryMagnitudeRow {
  category: ScenarioCategory;
  preset_count: number;
  /** Sum of magnitude_normalised across presets in this category. */
  total_magnitude: number;
  /** total_magnitude / preset_count; null when preset_count=0. */
  mean_magnitude: number | null;
  /** preset_id with the highest magnitude_normalised in this category.
   *  null when preset_count=0. */
  max_magnitude_preset_id: string | null;
}

export interface ScenarioMagnitudeSummary {
  generated_at: string;
  total_presets: number;
  /** Denominators used for per-axis normalisation (library max-abs). */
  library_max_abs: { gdp: number; rate: number; fx: number };
  /** Per-preset rows sorted by magnitude_normalised desc with
   *  preset_id asc tie-break. */
  presets: ScenarioMagnitudeRow[];
  /** Per-category rows. Every category present even when empty;
   *  sorted by total_magnitude desc with category asc tie-break. */
  by_category: CategoryMagnitudeRow[];
  /** Highest-magnitude preset across the library. null when empty. */
  most_aggressive_preset: {
    preset_id: string;
    name: string;
    magnitude_normalised: number;
  } | null;
  /** Highest-total-magnitude category. null when empty. Tie-broken
   *  by category asc. */
  most_aggressive_category: ScenarioCategory | null;
}

// ─── Pure resolver ────────────────────────────────────────────────────

function maxAbs(values: number[]): number {
  let max = 0;
  for (const v of values) {
    const a = Math.abs(v);
    if (a > max) max = a;
  }
  return max;
}

function safeNorm(value: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.abs(value) / denom;
}

function emptyCategoryRow(category: ScenarioCategory): CategoryMagnitudeRow {
  return {
    category,
    preset_count: 0,
    total_magnitude: 0,
    mean_magnitude: null,
    max_magnitude_preset_id: null,
  };
}

export function buildScenarioMagnitudeSummary(
  now: Date,
  presets: readonly ScenarioPreset[] = SCENARIO_PRESETS,
): ScenarioMagnitudeSummary {
  // Compute library max-abs per axis to use as the denominators.
  const max_gdp = maxAbs(presets.map((p) => p.shocks.gdp));
  const max_rate = maxAbs(presets.map((p) => p.shocks.rate));
  const max_fx = maxAbs(presets.map((p) => p.shocks.fx));

  const rows: ScenarioMagnitudeRow[] = presets.map((p) => {
    const gdp_abs = Math.abs(p.shocks.gdp);
    const rate_abs = Math.abs(p.shocks.rate);
    const fx_abs = Math.abs(p.shocks.fx);
    const gdp_norm = safeNorm(p.shocks.gdp, max_gdp);
    const rate_norm = safeNorm(p.shocks.rate, max_rate);
    const fx_norm = safeNorm(p.shocks.fx, max_fx);
    const magnitude_normalised = (gdp_norm + rate_norm + fx_norm) / 3;
    return {
      preset_id: p.id,
      name: p.name,
      category: p.category,
      severity: p.severity,
      gdp_abs,
      rate_abs,
      fx_abs,
      gdp_norm,
      rate_norm,
      fx_norm,
      magnitude_normalised,
    };
  });

  rows.sort((a, b) => {
    if (b.magnitude_normalised !== a.magnitude_normalised) {
      return b.magnitude_normalised - a.magnitude_normalised;
    }
    return a.preset_id.localeCompare(b.preset_id);
  });

  // Per-category aggregates.
  const byCategoryMap = new Map<ScenarioCategory, CategoryMagnitudeRow>();
  for (const c of CATEGORIES) byCategoryMap.set(c, emptyCategoryRow(c));

  for (const row of rows) {
    const cat = byCategoryMap.get(row.category);
    if (!cat) continue; // unknown category — shouldn't happen
    cat.preset_count++;
    cat.total_magnitude += row.magnitude_normalised;
    if (
      cat.max_magnitude_preset_id === null
      || row.magnitude_normalised
        > rows.find((r) => r.preset_id === cat.max_magnitude_preset_id)!.magnitude_normalised
    ) {
      cat.max_magnitude_preset_id = row.preset_id;
    }
  }
  for (const cat of byCategoryMap.values()) {
    cat.mean_magnitude = cat.preset_count > 0 ? cat.total_magnitude / cat.preset_count : null;
  }

  const by_category = [...byCategoryMap.values()].sort((a, b) => {
    if (b.total_magnitude !== a.total_magnitude) return b.total_magnitude - a.total_magnitude;
    return a.category.localeCompare(b.category);
  });

  const most_aggressive_preset = rows.length > 0
    ? {
        preset_id: rows[0]!.preset_id,
        name: rows[0]!.name,
        magnitude_normalised: rows[0]!.magnitude_normalised,
      }
    : null;

  // Most aggressive category among those with ≥1 preset
  let most_aggressive_category: ScenarioCategory | null = null;
  for (const c of by_category) {
    if (c.preset_count > 0) {
      most_aggressive_category = c.category;
      break;
    }
  }

  return {
    generated_at: now.toISOString(),
    total_presets: rows.length,
    library_max_abs: { gdp: max_gdp, rate: max_rate, fx: max_fx },
    presets: rows,
    by_category,
    most_aggressive_preset,
    most_aggressive_category,
  };
}
