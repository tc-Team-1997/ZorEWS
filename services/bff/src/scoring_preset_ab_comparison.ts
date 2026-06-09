// services/bff/src/scoring_preset_ab_comparison.ts
//
// T6 M6.20 — Weight preset A/B effectiveness comparison.
//
// Answers "if I switch from preset A to preset B, how would scores
// change across a representative customer sample?" Fans 50 synthetic
// customers through both presets and compares score distributions.
//
// Distinct from M6.7 (2-preset compare on explicit indicator values):
// M6.7 takes a caller-supplied indicator set; M6.20 synthesises a
// representative 50-customer sample so no customer data is needed.
//
// Distinct from M6.9 (preset diff): M6.9 is a structural diff of the
// preset definitions; M6.20 is a forward-looking SCORING simulation.
//
// Uses FNV-1a + mulberry32 PRNG seeded by (preset_a_id, preset_b_id,
// today) for deterministic, reproducible results.

import {
  scoreByPreset,
  WeightPresetError,
} from './scoring_presets';
import {
  getEffectiveWeightPreset,
  type CustomWeightPresetStore,
} from './scoring_presets_custom';
import {
  defaultIndicatorWeightLookup,
} from './bil_scoring_v2';
import { linearPercentile } from './connector_run_analytics';

// ─── Constants ─────────────────────────────────────────────────────────

const SAMPLE_SIZE = 50;
// Indicator ids from the STUB_CATALOG used for synthesis
const SAMPLE_INDICATOR_IDS = [
  'FIN-001',
  'FIN-002',
  'FIN-003',
  'BEH-001',
  'TXN-001',
];

// ─── PRNG helpers (same pattern as adoption_metrics.ts) ─────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

function mulberry32(seed: number): () => number {
  let s = seed;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

// ─── Public types ──────────────────────────────────────────────────────

export interface PresetAbComparison {
  preset_a: { id: string; name: string; mode: string; vertical: string };
  preset_b: { id: string; name: string; mode: string; vertical: string };
  sample_size: number;
  /** mean(b_score - a_score) */
  score_delta_mean: number;
  /** median(b_score - a_score) */
  score_delta_p50: number;
  /** p95(|b_score - a_score|) */
  score_delta_p95: number;
  /** Count where preset B produced a higher score than A */
  a_higher_count: number;
  /** Count where preset A produced a higher score than B */
  b_higher_count: number;
  /** Count where both presets produced exactly the same score */
  tied_count: number;
  /** Fraction of sample where both produce same Low/Med/High band (0-1) */
  band_agreement_rate: number;
  /** Per-band band-shift breakdown */
  per_band_shift: {
    b_higher_band: number;
    b_same_band: number;
    b_lower_band: number;
  };
  /** Human-readable recommendation. */
  recommendation: string;
}

export class PresetAbComparisonError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PresetAbComparisonError';
  }
}

// ─── Band ordering helpers ─────────────────────────────────────────────

function bandOrdinal(cat: string): number {
  if (cat === 'low') return 0;
  if (cat === 'medium') return 1;
  return 2; // high
}

// ─── Implementation ─────────────────────────────────────────────────────

export function buildPresetAbComparison(
  preset_a_id: string,
  preset_b_id: string,
  now: Date,
  tenant_id: string,
  customStore: CustomWeightPresetStore,
): PresetAbComparison {
  if (
    typeof preset_a_id !== 'string' ||
    !preset_a_id.trim() ||
    typeof preset_b_id !== 'string' ||
    !preset_b_id.trim()
  ) {
    throw new PresetAbComparisonError('invalid_input', 'preset_a and preset_b are required');
  }
  if (preset_a_id === preset_b_id) {
    throw new PresetAbComparisonError('same_preset', 'preset_a and preset_b must be different');
  }

  const presetA = getEffectiveWeightPreset(customStore, tenant_id, preset_a_id);
  const presetB = getEffectiveWeightPreset(customStore, tenant_id, preset_b_id);

  if (!presetA) {
    throw new WeightPresetError('unknown_preset', `unknown preset: ${preset_a_id}`);
  }
  if (!presetB) {
    throw new WeightPresetError('unknown_preset', `unknown preset: ${preset_b_id}`);
  }

  // Synthesise 50 customer indicator sets
  const seed = fnv1a(`ab|${preset_a_id}|${preset_b_id}|${dayKey(now)}`);
  const rng = mulberry32(seed);

  const deltas: number[] = [];
  const absDeltas: number[] = [];
  let a_higher_count = 0;
  let b_higher_count = 0;
  let tied_count = 0;
  let b_higher_band = 0;
  let b_same_band = 0;
  let b_lower_band = 0;

  for (let i = 0; i < SAMPLE_SIZE; i++) {
    const items = SAMPLE_INDICATOR_IDS.map(indicator_id => ({
      indicator_id,
      value: rng(),
    }));

    let scoreA = 0;
    let scoreB = 0;
    let catA = 'low';
    let catB = 'low';

    try {
      const rA = scoreByPreset(
        { preset_id: preset_a_id, items },
        defaultIndicatorWeightLookup,
      );
      scoreA = rA.score;
      catA = rA.category;
    } catch {
      // preset may have vertical restrictions; use 0
    }

    try {
      const rB = scoreByPreset(
        { preset_id: preset_b_id, items },
        defaultIndicatorWeightLookup,
      );
      scoreB = rB.score;
      catB = rB.category;
    } catch {
      // use 0
    }

    const delta = scoreB - scoreA;
    deltas.push(delta);
    absDeltas.push(Math.abs(delta));

    if (scoreB > scoreA) b_higher_count++;
    else if (scoreA > scoreB) a_higher_count++;
    else tied_count++;

    const ordA = bandOrdinal(catA);
    const ordB = bandOrdinal(catB);
    if (ordB > ordA) b_higher_band++;
    else if (ordB === ordA) b_same_band++;
    else b_lower_band++;
  }

  const mean = deltas.reduce((a, b) => a + b, 0) / SAMPLE_SIZE;
  const sortedDeltas = [...deltas].sort((a, b) => a - b);
  const sortedAbsDeltas = [...absDeltas].sort((a, b) => a - b);

  const p50 = linearPercentile(sortedDeltas, 0.5) ?? 0;
  const p95 = linearPercentile(sortedAbsDeltas, 0.95) ?? 0;

  const band_agreement_rate =
    Math.round((b_same_band / SAMPLE_SIZE) * 10_000) / 10_000;

  let recommendation: string;
  const roundedMean = Math.round(mean * 10) / 10;
  if (Math.abs(roundedMean) < 1) {
    recommendation = `Preset B produces effectively the same scores as Preset A (mean delta ${roundedMean > 0 ? '+' : ''}${roundedMean}pt across ${SAMPLE_SIZE} synthetic customers). Safe to swap.`;
  } else if (roundedMean > 0) {
    recommendation = `Preset B produces ${roundedMean}pt higher scores on average. Consider for conservative portfolios where higher sensitivity is desired.`;
  } else {
    recommendation = `Preset B produces ${Math.abs(roundedMean)}pt lower scores on average. Consider for portfolios where alert volume needs to be reduced.`;
  }

  return {
    preset_a: {
      id: presetA.id,
      name: presetA.name,
      mode: presetA.mode as string,
      vertical: presetA.vertical as string,
    },
    preset_b: {
      id: presetB.id,
      name: presetB.name,
      mode: presetB.mode as string,
      vertical: presetB.vertical as string,
    },
    sample_size: SAMPLE_SIZE,
    score_delta_mean: Math.round(mean * 100) / 100,
    score_delta_p50: Math.round(p50 * 100) / 100,
    score_delta_p95: Math.round(p95 * 100) / 100,
    a_higher_count,
    b_higher_count,
    tied_count,
    band_agreement_rate,
    per_band_shift: {
      b_higher_band,
      b_same_band,
      b_lower_band,
    },
    recommendation,
  };
}
