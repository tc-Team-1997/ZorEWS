// services/bff/src/scoring_sensitivity.ts
//
// T6 M6.13 — Score sensitivity analysis.
//
// Given (preset, baseValues), perturb each indicator's value by
// ±delta and recompute the score. Surfaces which indicator the
// final score is most sensitive to — the partial-derivative
// attribution that lets ops answer "which lever moves my score
// the most?".
//
// Pure — no I/O. Composes the M6.5 `scoreByPreset` entry point
// once per indicator (×2 for +/-) so the partial-derivative is a
// 2-sided finite difference around the base point.

import { scoreByPreset } from './scoring_presets';
import {
  type ByIndicatorItem,
  type IndicatorWeightLookup,
  STUB_CATALOG,
  type ScoringVertical,
} from './bil_scoring_v2';

// ─── Public types ─────────────────────────────────────────────────────

export interface SensitivityInput {
  preset_id: string;
  items: ByIndicatorItem[];
  /** Perturbation magnitude in absolute value units. Default 0.05 (5%
   *  of the [0, 1] indicator scale). Caller can tune to taste; the
   *  computed sensitivity scales with the perturbation. */
  perturbation?: number;
}

export interface SensitivityRow {
  indicator_id: string;
  base_value: number;
  /** Perturbation amount that was applied (clamped to keep
   *  base_value ± perturbation within [0, 1]). */
  perturbation: number;
  /** Score when this indicator's value = base + perturbation
   *  (other items unchanged). */
  score_up: number;
  /** Score when this indicator's value = base - perturbation. */
  score_down: number;
  /** score_up - score_down — symmetric sensitivity (the "what's
   *  the score swing if I move this indicator a tick in either
   *  direction?" measure). */
  symmetric_delta: number;
  /** abs(symmetric_delta) — sort key. */
  sensitivity: number;
}

export interface SensitivityReport {
  preset_id: string;
  preset_name: string;
  base_score: number;
  base_category: 'low' | 'medium' | 'high';
  perturbation: number;
  /** Sorted by sensitivity desc — most-influential indicators first. */
  rows: SensitivityRow[];
  /** Strongest mover — first row, or null when items is empty. */
  most_sensitive_indicator: string | null;
}

export class SensitivityError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SensitivityError';
  }
}

const DEFAULT_PERTURBATION = 0.05;

// ─── Pure analyser ───────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function analyseScoreSensitivity(
  input: SensitivityInput,
  baseLookup: IndicatorWeightLookup,
): SensitivityReport {
  if (!input || typeof input !== 'object') {
    throw new SensitivityError('invalid_input', 'request body required');
  }
  if (!Array.isArray(input.items)) {
    throw new SensitivityError('invalid_input', 'items must be an array');
  }
  const perturbation = input.perturbation ?? DEFAULT_PERTURBATION;
  if (!Number.isFinite(perturbation) || perturbation <= 0 || perturbation > 0.5) {
    throw new SensitivityError(
      'invalid_input',
      'perturbation must be a finite number in (0, 0.5]',
    );
  }
  // Base score
  const base = scoreByPreset(
    { preset_id: input.preset_id, items: input.items },
    baseLookup,
  );
  const rows: SensitivityRow[] = [];
  for (let i = 0; i < input.items.length; i += 1) {
    const item = input.items[i]!;
    const upItems = input.items.map((x, idx) =>
      idx === i ? { ...x, value: clamp(x.value + perturbation, 0, 1) } : x,
    );
    const downItems = input.items.map((x, idx) =>
      idx === i ? { ...x, value: clamp(x.value - perturbation, 0, 1) } : x,
    );
    const up = scoreByPreset({ preset_id: input.preset_id, items: upItems }, baseLookup);
    const down = scoreByPreset({ preset_id: input.preset_id, items: downItems }, baseLookup);
    const symmetric_delta = up.score - down.score;
    rows.push({
      indicator_id: item.indicator_id,
      base_value: item.value,
      perturbation,
      score_up: up.score,
      score_down: down.score,
      symmetric_delta,
      sensitivity: Math.abs(symmetric_delta),
    });
  }
  rows.sort((a, b) => {
    if (b.sensitivity !== a.sensitivity) return b.sensitivity - a.sensitivity;
    return a.indicator_id < b.indicator_id ? -1 : a.indicator_id > b.indicator_id ? 1 : 0;
  });
  return {
    preset_id: base.preset_id,
    preset_name: base.preset_name,
    base_score: base.score,
    base_category: base.category,
    perturbation,
    rows,
    most_sensitive_indicator: rows[0]?.indicator_id ?? null,
  };
}

// Default catalog hook so tests/route can call without injection.
export const DEFAULT_BASE_LOOKUP: IndicatorWeightLookup = {
  getWeight(indicator_id: string, vertical?: ScoringVertical) {
    const entry = STUB_CATALOG[indicator_id];
    if (!entry) return null;
    if (vertical && entry.vertical !== vertical) return null;
    return { weight: entry.weight, name: entry.name };
  },
};
