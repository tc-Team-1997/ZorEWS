// services/bff/src/scoring_preset_effective_weights.ts
//
// T6 M6.10 — Weight preset effective weights view.
//
// M6.3 ships the preset → scoring path (`scoreByPreset` returns
// `effective_weights[]` as a side-effect of scoring N customers).
// M6.10 exposes the same transparency as a STANDALONE introspection
// surface — operators auditing "what weights does THIS preset
// actually apply?" don't need to score anything to see the chain.
//
// Mirrors the M4.9 resolution-chain shape for indicator thresholds:
// walks every indicator in the M6.2 catalog, applies the preset's
// sparse multiplier (or 1.0 for unlisted indicators), emits per-
// indicator `{catalog_weight, multiplier, effective_weight, source}`
// with both levels visible side-by-side.

import { STUB_CATALOG, type ScoringVertical, isScoringVertical } from './bil_scoring_v2';
import type { WeightPreset } from './scoring_presets';

// ─── Public types ─────────────────────────────────────────────────────

export type WeightSource = 'preset_multiplier' | 'catalog_default';

export interface EffectiveWeightEntry {
  indicator_id: string;
  name: string;
  vertical: ScoringVertical;
  /** Platform-static catalog weight. */
  catalog_weight: number;
  /** Multiplier applied by the preset (1.0 when not in the sparse map). */
  multiplier: number;
  /** catalog_weight × multiplier, clamped to [0, 1] per M6.3 semantics. */
  effective_weight: number;
  /** Which level set the multiplier — 'preset_multiplier' when the preset
   *  explicitly listed this indicator; 'catalog_default' otherwise. */
  source: WeightSource;
}

export interface EffectivePresetWeightsResult {
  preset_id: string;
  preset_name: string;
  /** Filter applied (null = all). */
  vertical: ScoringVertical | null;
  total: number;
  /** Indicators where the preset explicitly set a multiplier (≠ 1.0
   *  doesn't matter — presence in the map is what counts). */
  multiplier_count: number;
  /** Indicators using the catalog default (multiplier = 1.0). */
  default_count: number;
  /** Per-indicator effective weights, sorted by indicator_id asc. */
  entries: EffectiveWeightEntry[];
}

// ─── Pure resolver ────────────────────────────────────────────────────

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Pure resolver — walks the indicator catalog (filtered by vertical
 * if supplied) and produces the per-indicator effective weight given
 * the preset's multiplier map.
 */
export function resolveEffectivePresetWeights(
  preset: WeightPreset,
  vertical?: ScoringVertical,
): EffectivePresetWeightsResult {
  if (vertical !== undefined && !isScoringVertical(vertical)) {
    throw new Error('vertical must be banking|insurance');
  }
  const multipliers = preset.weight_multipliers;
  const entries: EffectiveWeightEntry[] = [];
  let multiplier_count = 0;
  let default_count = 0;

  for (const [id, entry] of Object.entries(STUB_CATALOG)) {
    if (vertical && entry.vertical !== vertical) continue;
    const hasMultiplier = Object.prototype.hasOwnProperty.call(multipliers, id);
    const multiplier = hasMultiplier ? multipliers[id]! : 1.0;
    const effective_weight = clamp01(entry.weight * multiplier);
    const source: WeightSource = hasMultiplier ? 'preset_multiplier' : 'catalog_default';
    if (hasMultiplier) multiplier_count += 1;
    else default_count += 1;
    entries.push({
      indicator_id: id,
      name: entry.name,
      vertical: entry.vertical,
      catalog_weight: entry.weight,
      multiplier,
      effective_weight,
      source,
    });
  }

  entries.sort((a, b) =>
    a.indicator_id < b.indicator_id ? -1 : a.indicator_id > b.indicator_id ? 1 : 0,
  );

  return {
    preset_id: preset.id,
    preset_name: preset.name,
    vertical: vertical ?? null,
    total: entries.length,
    multiplier_count,
    default_count,
    entries,
  };
}
