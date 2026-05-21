// services/bff/src/scenario_shock_direction.ts
//
// T6 M16.22 — Scenario library shock-direction distribution per axis.
//
// Pivots over the M16.1 library by SIGN of each axis's shock. Distinct
// from M16.18 (single magnitude score per preset) and M16.20 (per-axis
// magnitude histogram, sign-agnostic) — M16.22 surfaces DIRECTION:
//
//   - positive — preset stresses upward on this axis (e.g. +5% GDP =
//                growth boom; +200bps = rate hike; +10% FX = INR
//                appreciation)
//   - negative — downward (e.g. -3% GDP = recession; -50bps = rate cut;
//                -8% FX = INR depreciation)
//   - zero    — no shock on this axis (baseline or single-axis stress)
//
// Sign matters operationally: a +10% GDP scenario tests the boom side
// of the cycle; a -10% GDP scenario stresses the recession side. Most
// stress-test frameworks (RBI Severely Adverse, Pandemic) lean
// downward on GDP + upward on rates + downward on FX — surfacing this
// helps ops confirm the library is balanced.
//
// Pure resolver — operates over SCENARIO_PRESETS. Platform-static —
// same response across tenants.

import {
  listScenarioCategories,
  SCENARIO_PRESETS,
  type ScenarioCategory,
  type ScenarioPreset,
} from './scenario_library';
import { ALL_SHOCK_AXES, type ShockAxis } from './scenario_shock_axis_histogram';

// ─── Constants ───────────────────────────────────────────────────────

export type ShockDirection = 'positive' | 'negative' | 'zero';

export const ALL_SHOCK_DIRECTIONS: readonly ShockDirection[] = [
  'positive',
  'negative',
  'zero',
] as const;

export function isShockDirection(s: unknown): s is ShockDirection {
  return typeof s === 'string' && ALL_SHOCK_DIRECTIONS.includes(s as ShockDirection);
}

/** Sign-classify a raw shock value. Zero (exactly) is its own bucket;
 *  any non-zero finite number lands in positive/negative. NaN/Infinity
 *  defensively → zero (shouldn't happen in the catalog). */
export function directionForShock(raw: number): ShockDirection {
  if (!Number.isFinite(raw)) return 'zero';
  if (raw > 0) return 'positive';
  if (raw < 0) return 'negative';
  return 'zero';
}

// ─── Output shapes ────────────────────────────────────────────────────

export interface ShockDirectionPresetSample {
  preset_id: string;
  name: string;
  category: ScenarioCategory;
  raw: number;
}

export interface ShockAxisDirectionRow {
  axis: ShockAxis;
  positive_count: number;
  negative_count: number;
  zero_count: number;
  total: number;
  /** Per-category breakdown across the 4 ScenarioCategory values
   *  (each carries positive/negative/zero counts). Every category key
   *  always present for stable SPA rendering. */
  by_category: Record<
    ScenarioCategory,
    { positive: number; negative: number; zero: number }
  >;
  positive_examples: ShockDirectionPresetSample[];
  negative_examples: ShockDirectionPresetSample[];
}

export interface ShockDirectionReport {
  generated_at: string;
  total_presets: number;
  rows: ShockAxisDirectionRow[];
  /** Axis with the highest positive-count; canonical ALL_SHOCK_AXES
   *  tie-break (gdp wins over rate at same count); null on empty
   *  catalog. */
  most_positive_axis: ShockAxis | null;
  /** Axis with the highest negative-count; canonical tie-break; null
   *  on empty catalog. */
  most_negative_axis: ShockAxis | null;
  /** Axis with the highest zero-count — surfaces "which axis is most
   *  often untouched?". Canonical tie-break; null on empty. */
  most_neutral_axis: ShockAxis | null;
  /** Marginal totals across all axes — total {positive, negative,
   *  zero} sums across the 3 axes (= 3 × total_presets). */
  by_direction_totals: { positive: number; negative: number; zero: number };
}

// ─── Builder ─────────────────────────────────────────────────────────

const SAMPLES_CAP = 3;

function shockOnAxis(preset: ScenarioPreset, axis: ShockAxis): number {
  return preset.shocks[axis];
}

export function buildScenarioShockDirectionReport(
  now: Date,
  presets: readonly ScenarioPreset[] = SCENARIO_PRESETS,
): ShockDirectionReport {
  const rows: ShockAxisDirectionRow[] = [];
  const totals = { positive: 0, negative: 0, zero: 0 };

  for (const axis of ALL_SHOCK_AXES) {
    let positive_count = 0;
    let negative_count = 0;
    let zero_count = 0;
    const by_category: Record<
      ScenarioCategory,
      { positive: number; negative: number; zero: number }
    > = {} as Record<
      ScenarioCategory,
      { positive: number; negative: number; zero: number }
    >;
    for (const cat of listScenarioCategories()) {
      by_category[cat] = { positive: 0, negative: 0, zero: 0 };
    }

    const positive_examples: ShockDirectionPresetSample[] = [];
    const negative_examples: ShockDirectionPresetSample[] = [];

    for (const p of presets) {
      const raw = shockOnAxis(p, axis);
      const dir = directionForShock(raw);
      if (dir === 'positive') {
        positive_count += 1;
        by_category[p.category].positive += 1;
        positive_examples.push({
          preset_id: p.id,
          name: p.name,
          category: p.category,
          raw,
        });
      } else if (dir === 'negative') {
        negative_count += 1;
        by_category[p.category].negative += 1;
        negative_examples.push({
          preset_id: p.id,
          name: p.name,
          category: p.category,
          raw,
        });
      } else {
        zero_count += 1;
        by_category[p.category].zero += 1;
      }
    }

    // Sort positive samples by raw desc (biggest boost first);
    // negative samples by raw asc (biggest drop first — most-negative
    // wins). Preset_id asc tie-break.
    positive_examples.sort((a, b) =>
      b.raw - a.raw || (a.preset_id < b.preset_id ? -1 : a.preset_id > b.preset_id ? 1 : 0),
    );
    negative_examples.sort((a, b) =>
      a.raw - b.raw || (a.preset_id < b.preset_id ? -1 : a.preset_id > b.preset_id ? 1 : 0),
    );

    rows.push({
      axis,
      positive_count,
      negative_count,
      zero_count,
      total: positive_count + negative_count + zero_count,
      by_category,
      positive_examples: positive_examples.slice(0, SAMPLES_CAP),
      negative_examples: negative_examples.slice(0, SAMPLES_CAP),
    });

    totals.positive += positive_count;
    totals.negative += negative_count;
    totals.zero += zero_count;
  }

  function leaderForDirection(dir: ShockDirection): ShockAxis | null {
    if (presets.length === 0) return null;
    let best: ShockAxis | null = null;
    let bestCount = -1;
    for (const row of rows) {
      const count =
        dir === 'positive'
          ? row.positive_count
          : dir === 'negative'
            ? row.negative_count
            : row.zero_count;
      if (count > bestCount) {
        bestCount = count;
        best = row.axis;
      }
    }
    return best;
  }

  return {
    generated_at: now.toISOString(),
    total_presets: presets.length,
    rows,
    most_positive_axis: leaderForDirection('positive'),
    most_negative_axis: leaderForDirection('negative'),
    most_neutral_axis: leaderForDirection('zero'),
    by_direction_totals: totals,
  };
}
