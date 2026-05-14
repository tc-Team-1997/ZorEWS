// services/bff/src/scoring_what_if.ts
//
// T6 M6.14 — Score "what-if" across all library presets.
//
// M6.7 ships a 2-preset side-by-side comparison; M6.14 widens
// to fan one indicator input set across EVERY library preset
// of a given vertical and rank by score. Lets the SPA show a
// "what would my score be under conservative vs balanced vs
// aggressive?" panel + answers "is my risk picture resilient
// across scoring profiles?".
//
// Pure resolver. Composes M6.3's scoreByPreset under the hood
// for every matching preset.

import {
  type WeightPreset,
  type WeightPresetMode,
  WEIGHT_PRESETS,
  WeightPresetError,
  scoreByPreset,
  type ScoreByPresetResult,
} from './scoring_presets';
import {
  type ByIndicatorItem,
  type ScoringVertical,
  type IndicatorWeightLookup,
} from './bil_scoring_v2';

// ─── Public types ─────────────────────────────────────────────────────

export interface ScoreWhatIfInput {
  /** Required — narrows the preset set + ensures indicator/preset
   *  vertical alignment for downstream scoreByPreset(). */
  vertical: ScoringVertical;
  items: ByIndicatorItem[];
}

export interface PresetScoreRow {
  preset_id: string;
  preset_name: string;
  preset_mode: WeightPresetMode;
  vertical: ScoringVertical;
  score: number;
  category: ScoreByPresetResult['category'];
  /** Score minus the BALANCED preset's score for this vertical.
   *  null when no balanced preset exists in the filtered set (e.g.
   *  caller passed an explicit mode filter that excluded balanced). */
  delta_vs_balanced: number | null;
}

export interface ScoreWhatIfResult {
  generated_at: string;
  vertical: ScoringVertical;
  items_count: number;
  total_presets_considered: number;
  /** Per-preset rows sorted by score desc with preset_id asc
   *  tie-break — highest risk band floats to the top. */
  presets: PresetScoreRow[];
  /** Highest-scoring preset. null when zero presets considered. */
  peak_preset: {
    preset_id: string;
    preset_name: string;
    score: number;
  } | null;
  /** Lowest-scoring preset. null when zero presets considered. */
  lowest_preset: {
    preset_id: string;
    preset_name: string;
    score: number;
  } | null;
  /** max(score) − min(score). 0 when only one preset matched. null
   *  when zero presets matched. */
  spread: number | null;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildScoreWhatIf(
  input: ScoreWhatIfInput,
  baseLookup: IndicatorWeightLookup,
  now: Date,
): ScoreWhatIfResult {
  if (!input || typeof input !== 'object') {
    throw new WeightPresetError('invalid_input', 'request body required');
  }
  if (input.vertical !== 'banking' && input.vertical !== 'insurance') {
    throw new WeightPresetError('invalid_input', "vertical must be 'banking' or 'insurance'");
  }
  if (!Array.isArray(input.items)) {
    throw new WeightPresetError('invalid_input', 'items must be an array');
  }

  const matching: WeightPreset[] = WEIGHT_PRESETS.filter((p) => p.vertical === input.vertical);

  // Score under each preset. We re-invoke scoreByPreset so the
  // per-preset `vertical` filter applies + the [0,1] clamp on
  // effective weights stays consistent with the M6.3 contract.
  const rows: PresetScoreRow[] = matching.map((p) => {
    const r = scoreByPreset(
      { preset_id: p.id, items: input.items },
      baseLookup,
    );
    return {
      preset_id: r.preset_id,
      preset_name: r.preset_name,
      preset_mode: r.preset_mode,
      vertical: p.vertical,
      score: r.score,
      category: r.category,
      delta_vs_balanced: null, // filled in below
    };
  });

  // Compute delta_vs_balanced now that all scores are known.
  const balanced = rows.find((r) => r.preset_mode === 'balanced');
  if (balanced) {
    for (const r of rows) {
      r.delta_vs_balanced = r.score - balanced.score;
    }
  }

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.preset_id.localeCompare(b.preset_id);
  });

  const peak_preset = rows.length > 0
    ? { preset_id: rows[0]!.preset_id, preset_name: rows[0]!.preset_name, score: rows[0]!.score }
    : null;
  const lowest_preset = rows.length > 0
    ? {
        preset_id: rows[rows.length - 1]!.preset_id,
        preset_name: rows[rows.length - 1]!.preset_name,
        score: rows[rows.length - 1]!.score,
      }
    : null;
  const spread = rows.length > 0
    ? rows[0]!.score - rows[rows.length - 1]!.score
    : null;

  return {
    generated_at: now.toISOString(),
    vertical: input.vertical,
    items_count: input.items.length,
    total_presets_considered: rows.length,
    presets: rows,
    peak_preset,
    lowest_preset,
    spread,
  };
}
