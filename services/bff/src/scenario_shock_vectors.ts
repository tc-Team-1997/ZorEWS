// services/bff/src/scenario_shock_vectors.ts
//
// T6 M16.15 — Scenario library shock-vector radar transform.
//
// Each library preset (M16.1) carries a `shocks: {gdp, rate, fx}`
// triple. The SPA wants a radar chart showing how all presets
// compare side-by-side, but the raw scales differ wildly (gdp in
// percentage points, rate in basis points, fx in percentage). This
// module normalises each preset's shocks onto [-1, 1] using the
// library-wide MIN/MAX of each shock dimension so the SPA can plot
// them on a unified radar.
//
// Pure — no I/O. Caller passes the presets (typically the M16.1
// library or M16.4 custom presets list).
//
// Normalisation rule:
//   If max_dim === min_dim (all presets share the same value on
//   that axis — only happens when the library has 1 preset OR the
//   axis is constant across all presets), every preset's normalized
//   value on that axis is 0.0 (no relative variation to plot).
//   Otherwise: value' = -1 + 2 * (value - min) / (max - min) so
//   the minimum maps to -1 and the maximum maps to +1.

import { listScenarioPresets, type ScenarioPreset } from './scenario_library';

// ─── Public types ─────────────────────────────────────────────────────

export interface NormalizedShockVector {
  preset_id: string;
  name: string;
  category: string;
  raw: { gdp: number; rate: number; fx: number };
  normalized: { gdp: number; rate: number; fx: number };
}

export interface ScenarioShockVectorReport {
  total_presets: number;
  /** Library-wide MIN/MAX per shock dim — what the normalisation
   *  used as anchors. Useful for the SPA to render axis labels. */
  ranges: {
    gdp: { min: number; max: number };
    rate: { min: number; max: number };
    fx: { min: number; max: number };
  };
  /** Sorted by preset_id asc for stable rendering. */
  vectors: NormalizedShockVector[];
}

// ─── Pure transformer ────────────────────────────────────────────────

function normaliseOne(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return -1 + (2 * (value - min)) / (max - min);
}

export function normaliseScenarioShockVectors(
  presets: readonly ScenarioPreset[] = listScenarioPresets(),
): ScenarioShockVectorReport {
  if (presets.length === 0) {
    return {
      total_presets: 0,
      ranges: {
        gdp: { min: 0, max: 0 },
        rate: { min: 0, max: 0 },
        fx: { min: 0, max: 0 },
      },
      vectors: [],
    };
  }
  const gdpValues = presets.map((p) => p.shocks.gdp);
  const rateValues = presets.map((p) => p.shocks.rate);
  const fxValues = presets.map((p) => p.shocks.fx);
  const ranges = {
    gdp: { min: Math.min(...gdpValues), max: Math.max(...gdpValues) },
    rate: { min: Math.min(...rateValues), max: Math.max(...rateValues) },
    fx: { min: Math.min(...fxValues), max: Math.max(...fxValues) },
  };
  const vectors: NormalizedShockVector[] = presets.map((p) => ({
    preset_id: p.id,
    name: p.name,
    category: p.category,
    raw: { ...p.shocks },
    normalized: {
      gdp: normaliseOne(p.shocks.gdp, ranges.gdp.min, ranges.gdp.max),
      rate: normaliseOne(p.shocks.rate, ranges.rate.min, ranges.rate.max),
      fx: normaliseOne(p.shocks.fx, ranges.fx.min, ranges.fx.max),
    },
  }));
  vectors.sort((a, b) => (a.preset_id < b.preset_id ? -1 : a.preset_id > b.preset_id ? 1 : 0));
  return {
    total_presets: vectors.length,
    ranges,
    vectors,
  };
}
