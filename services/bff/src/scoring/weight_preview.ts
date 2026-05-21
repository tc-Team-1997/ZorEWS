// services/bff/src/scoring/weight_preview.ts
//
// PHASE E.3 — Drag-drop weight adjustment preview API. Closes the
// gap-analysis E.3 item ("Drag-drop weight adjustment — backend
// preview API").
//
// The SPA drag-drop UI lets ops slide weights up/down on the M6.x
// scoring preset editor. Before persisting via M6.4 CRUD, the UI
// calls this preview endpoint with:
//   - the BASELINE weight map (typically the catalog defaults)
//   - the CANDIDATE weight map (what the slider settled on)
//   - a SAMPLE of customer indicator-value vectors
//
// Backend computes both scores per sample, returns the side-by-side
// diff + summary stats (mean/max delta, # samples that crossed a
// category boundary). Lets ops gauge "how many customers would
// rebucket from low to medium if I bump weight X by 0.1?" without
// mutating any persisted state.
//
// Architecture choices (per execution rules):
//   - Additive only — composes M6.1 computeRiskScore (reused, never
//     mutated).
//   - PURE FUNCTION — no store, no AppDeps slot, no side-effects.
//   - Closed enum of category-boundary deltas for stable SPA filters.
//   - RBAC: customers:read_risk_profile (matches the existing M6.x
//     scoring read scope; this is a preview not a mutation).

import {
  computeRiskScore,
  DEFAULT_THRESHOLDS,
  type ScoringCategory,
  type ScoringItem,
  type ScoringResult,
  type ScoringThresholds,
  ScoringInputError,
} from '../bil_scoring';

export class WeightPreviewError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'empty_baseline'
      | 'empty_candidate'
      | 'empty_samples'
      | 'too_many_samples'
      | 'too_many_weights'
      | 'invalid_weight'
      | 'invalid_sample',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'WeightPreviewError';
  }
}

/** Per-indicator weight in a weight map. Keyed by indicator_id. */
export type WeightMap = Readonly<Record<string, number>>;

/** Caller-supplied per-customer sample: an id + the indicator-value
 *  vector for that customer. The weights come from the BASELINE +
 *  CANDIDATE maps, not the sample. */
export interface PreviewSample {
  /** Tenant-internal customer id — surfaces in the response so the
   *  SPA can render "customer X moved from low to medium" without a
   *  second lookup. */
  sample_id: string;
  /** Per-indicator value 0..1 (same semantics as ScoringItem.value). */
  values: Readonly<Record<string, number>>;
}

export interface PreviewInput {
  baseline: WeightMap;
  candidate: WeightMap;
  samples: readonly PreviewSample[];
  thresholds?: Partial<ScoringThresholds>;
}

/** Per-sample diff entry. */
export interface PreviewSampleResult {
  sample_id: string;
  baseline: { score: number; category: ScoringCategory };
  candidate: { score: number; category: ScoringCategory };
  /** candidate.score − baseline.score (signed). Positive = candidate
   *  is HIGHER risk than baseline. */
  delta: number;
  /** True iff candidate.category !== baseline.category. */
  category_changed: boolean;
  /** From → to direction. */
  category_movement: { from: ScoringCategory; to: ScoringCategory };
}

export interface WeightChangeEntry {
  indicator_id: string;
  baseline_weight: number;
  candidate_weight: number;
  delta: number;
  /** Indicator was added (not in baseline) / removed (not in candidate)
   *  / changed (both present, different value) / unchanged. */
  kind: 'added' | 'removed' | 'changed' | 'unchanged';
}

export interface PreviewSummary {
  total_samples: number;
  /** # of samples where category_changed=true. */
  category_changes: number;
  /** Among the changed: how many up vs down. */
  category_upgrades: number; // low→medium or medium→high
  category_downgrades: number; // high→medium or medium→low
  /** Score statistics over the sample (post-candidate). */
  mean_baseline_score: number;
  mean_candidate_score: number;
  mean_delta: number;
  max_abs_delta: number;
}

export interface WeightPreviewResult {
  thresholds: ScoringThresholds;
  total_weights_changed: number;
  weight_changes: WeightChangeEntry[];
  samples: PreviewSampleResult[];
  summary: PreviewSummary;
}

const PREVIEW_MAX_SAMPLES = 200;
const PREVIEW_MAX_WEIGHTS = 500;

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function validateWeightMap(map: unknown, label: 'baseline' | 'candidate'): WeightMap {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new WeightPreviewError(
      'invalid_input',
      `${label} must be a plain object keyed by indicator_id`,
    );
  }
  const keys = Object.keys(map);
  if (keys.length === 0) {
    throw new WeightPreviewError(
      label === 'baseline' ? 'empty_baseline' : 'empty_candidate',
      `${label} must contain at least one indicator weight`,
    );
  }
  if (keys.length > PREVIEW_MAX_WEIGHTS) {
    throw new WeightPreviewError(
      'too_many_weights',
      `${label} contains ${keys.length} entries; cap is ${PREVIEW_MAX_WEIGHTS}`,
    );
  }
  for (const k of keys) {
    const v = (map as Record<string, unknown>)[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new WeightPreviewError(
        'invalid_weight',
        `${label}.${k} must be a finite number in [0, 1]`,
      );
    }
  }
  return map as WeightMap;
}

function validateSamples(samples: unknown): readonly PreviewSample[] {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new WeightPreviewError(
      'empty_samples',
      'samples must be a non-empty array',
    );
  }
  if (samples.length > PREVIEW_MAX_SAMPLES) {
    throw new WeightPreviewError(
      'too_many_samples',
      `samples contains ${samples.length} entries; cap is ${PREVIEW_MAX_SAMPLES}`,
    );
  }
  const seen = new Set<string>();
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw new WeightPreviewError(
        'invalid_sample',
        `samples[${i}] must be an object`,
      );
    }
    if (typeof s.sample_id !== 'string' || s.sample_id.trim().length === 0) {
      throw new WeightPreviewError(
        'invalid_sample',
        `samples[${i}].sample_id must be a non-empty string`,
      );
    }
    if (seen.has(s.sample_id)) {
      throw new WeightPreviewError(
        'invalid_sample',
        `samples[${i}].sample_id duplicate: ${s.sample_id}`,
      );
    }
    seen.add(s.sample_id);
    if (!s.values || typeof s.values !== 'object' || Array.isArray(s.values)) {
      throw new WeightPreviewError(
        'invalid_sample',
        `samples[${i}].values must be a plain object`,
      );
    }
    for (const [vk, vv] of Object.entries(s.values)) {
      if (typeof vv !== 'number' || !Number.isFinite(vv) || vv < 0 || vv > 1) {
        throw new WeightPreviewError(
          'invalid_sample',
          `samples[${i}].values.${vk} must be a finite number in [0, 1]`,
        );
      }
    }
  }
  return samples;
}

/** Build the ScoringItem[] for a given sample using a specific weight map.
 *  Indicators present in the weight map but missing from the sample are
 *  treated as value=0 (no contribution); indicators present in the sample
 *  but missing from the weight map are dropped (no weight = no contribution).
 *  This mirrors the M6.1 contract where Σ(weight × value) / Σ(weight) is the
 *  normalisation. */
function buildItems(weights: WeightMap, values: Readonly<Record<string, number>>): ScoringItem[] {
  const items: ScoringItem[] = [];
  for (const [indicator_id, weight] of Object.entries(weights)) {
    if (weight === 0) continue; // skip — would be a no-op
    const value = values[indicator_id] ?? 0;
    items.push({ indicator_id, weight, value });
  }
  return items;
}

function categoryRank(c: ScoringCategory): number {
  if (c === 'low') return 0;
  if (c === 'medium') return 1;
  return 2;
}

/** Diff two weight maps. Returns one entry per indicator that appears
 *  in EITHER map (sorted by abs(delta) desc, then indicator_id asc). */
export function diffWeights(baseline: WeightMap, candidate: WeightMap): WeightChangeEntry[] {
  const ids = new Set<string>([...Object.keys(baseline), ...Object.keys(candidate)]);
  const out: WeightChangeEntry[] = [];
  for (const id of ids) {
    const b = baseline[id];
    const c = candidate[id];
    const hasB = b !== undefined;
    const hasC = c !== undefined;
    if (hasB && hasC) {
      const bn = b as number;
      const cn = c as number;
      if (bn === cn) {
        out.push({
          indicator_id: id,
          baseline_weight: bn,
          candidate_weight: cn,
          delta: 0,
          kind: 'unchanged',
        });
      } else {
        out.push({
          indicator_id: id,
          baseline_weight: bn,
          candidate_weight: cn,
          delta: round4(cn - bn),
          kind: 'changed',
        });
      }
    } else if (hasC) {
      out.push({
        indicator_id: id,
        baseline_weight: 0,
        candidate_weight: c as number,
        delta: round4(c as number),
        kind: 'added',
      });
    } else {
      out.push({
        indicator_id: id,
        baseline_weight: b as number,
        candidate_weight: 0,
        delta: round4(0 - (b as number)),
        kind: 'removed',
      });
    }
  }
  out.sort((a, z) => {
    const am = Math.abs(a.delta);
    const zm = Math.abs(z.delta);
    if (am !== zm) return zm - am;
    return a.indicator_id.localeCompare(z.indicator_id);
  });
  return out;
}

/** Top-level pure-function preview. */
export function previewWeightChange(input: PreviewInput): WeightPreviewResult {
  if (!input || typeof input !== 'object') {
    throw new WeightPreviewError('invalid_input', 'request body must be an object');
  }
  const baseline = validateWeightMap(input.baseline, 'baseline');
  const candidate = validateWeightMap(input.candidate, 'candidate');
  const samples = validateSamples(input.samples);

  // Defer threshold validation to computeRiskScore so the existing
  // M6.1 invariant (0 ≤ low_max ≤ medium_max ≤ 100) is the single
  // source of truth. Use DEFAULT_THRESHOLDS when not supplied.
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;

  const sampleResults: PreviewSampleResult[] = [];
  let totalCategoryChanges = 0;
  let upgrades = 0;
  let downgrades = 0;
  let sumBaseline = 0;
  let sumCandidate = 0;
  let sumDelta = 0;
  let maxAbsDelta = 0;
  let effectiveThresholds: ScoringThresholds | null = null;

  for (const s of samples) {
    const baselineItems = buildItems(baseline, s.values);
    const candidateItems = buildItems(candidate, s.values);
    let baselineResult: ScoringResult;
    let candidateResult: ScoringResult;
    try {
      baselineResult = computeRiskScore(baselineItems, thresholds);
      candidateResult = computeRiskScore(candidateItems, thresholds);
    } catch (e) {
      if (e instanceof ScoringInputError) {
        // Re-raise as preview's invalid_sample so the caller's error
        // routing is uniform.
        throw new WeightPreviewError(
          'invalid_sample',
          `sample ${s.sample_id} failed scoring: ${e.message}`,
        );
      }
      throw e;
    }
    if (effectiveThresholds === null) effectiveThresholds = baselineResult.thresholds;
    const delta = round4(candidateResult.score - baselineResult.score);
    const category_changed = baselineResult.category !== candidateResult.category;
    if (category_changed) {
      totalCategoryChanges++;
      if (categoryRank(candidateResult.category) > categoryRank(baselineResult.category)) {
        upgrades++;
      } else {
        downgrades++;
      }
    }
    sampleResults.push({
      sample_id: s.sample_id,
      baseline: { score: baselineResult.score, category: baselineResult.category },
      candidate: { score: candidateResult.score, category: candidateResult.category },
      delta,
      category_changed,
      category_movement: {
        from: baselineResult.category,
        to: candidateResult.category,
      },
    });
    sumBaseline += baselineResult.score;
    sumCandidate += candidateResult.score;
    sumDelta += delta;
    const absDelta = Math.abs(delta);
    if (absDelta > maxAbsDelta) maxAbsDelta = absDelta;
  }

  const total = samples.length;
  const changes = diffWeights(baseline, candidate);
  const total_weights_changed = changes.filter((c) => c.kind !== 'unchanged').length;

  return {
    thresholds: effectiveThresholds ?? { ...DEFAULT_THRESHOLDS, ...(thresholds ?? {}) },
    total_weights_changed,
    weight_changes: changes,
    samples: sampleResults,
    summary: {
      total_samples: total,
      category_changes: totalCategoryChanges,
      category_upgrades: upgrades,
      category_downgrades: downgrades,
      mean_baseline_score: round4(sumBaseline / total),
      mean_candidate_score: round4(sumCandidate / total),
      mean_delta: round4(sumDelta / total),
      max_abs_delta: round4(maxAbsDelta),
    },
  };
}
