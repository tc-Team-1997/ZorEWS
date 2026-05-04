// services/bff/src/bil_scoring.ts
//
// BIL risk-scoring engine (T6 Module 6).
//
// Implements the formula from DataNetworks-EWS-Ver1.pdf §12:
//
//     Risk Score = Σ (KRI Weight × KRI Value)
//
//     Categories: Low (0-30) · Medium (31-70) · High (71-100)
//                 (configurable by BIL — operator can override the cutoffs
//                  via the `thresholds` field in the request)
//
// The engine is intentionally stateless — callers supply the (weight,
// value) tuples directly, so the scoring API does NOT need to know
// which catalog a given indicator_id belongs to. A future M6.2 can add
// a "look up weights from the catalog" convenience layer that wraps
// this primitive.
//
// Why pure: this lets the SPA, scenario-runner, the indicator engine
// itself, and any partner integration all reach the same result for the
// same inputs. No global state, no I/O.

export interface ScoringItem {
  /** Indicator identifier — surfaced in the breakdown so the caller
   *  can display "indicator X contributed Y points" without a second
   *  lookup. Validated as non-empty; not parsed against the catalog. */
  indicator_id: string;
  /** Severity weight 0..1 (catalog default). Higher = the indicator
   *  pulls the score up faster when it fires. */
  weight: number;
  /** Indicator value 0..1 (typically the breach intensity — e.g. a
   *  DPD-90 indicator might return value=0.85 for a customer 80 days
   *  past due). Caller is responsible for the 0-1 normalisation; the
   *  scoring engine clamps if out-of-range. */
  value: number;
}

export interface ScoringThresholds {
  /** Score in [0, low_max] → "low". Default 30. */
  low_max: number;
  /** Score in (low_max, medium_max] → "medium". Default 70.
   *  Score above medium_max → "high". */
  medium_max: number;
}

export const DEFAULT_THRESHOLDS: ScoringThresholds = { low_max: 30, medium_max: 70 };

export type ScoringCategory = 'low' | 'medium' | 'high';

export interface ScoringBreakdownEntry {
  indicator_id: string;
  weight: number;
  value: number;
  /** weight × value, rounded to 4 decimals. Sum across breakdown
   *  equals the raw score (pre-normalisation). */
  contribution: number;
}

export interface ScoringResult {
  /** Final score on a 0-100 scale. Σ(weight × value) / Σ(weight) × 100. */
  score: number;
  /** Bucketed using the thresholds (default 30 / 70). */
  category: ScoringCategory;
  /** Echo of the thresholds used (request override OR default). */
  thresholds: ScoringThresholds;
  /** Per-indicator contribution. Same order as the input items. */
  breakdown: ScoringBreakdownEntry[];
  /** Sum of weights across all items — useful for the SPA to render
   *  "this score was computed from N indicators with total weight W". */
  total_weight: number;
  /** Raw Σ(weight × value), no normalisation. score = raw_sum / total_weight × 100. */
  raw_sum: number;
}

export class ScoringInputError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ScoringInputError';
  }
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Compute the BIL risk score from a list of (weight, value) tuples.
 *
 * @throws ScoringInputError when items is empty, weights are out of range,
 * or thresholds violate the invariant 0 ≤ low_max ≤ medium_max ≤ 100.
 */
export function computeRiskScore(
  items: readonly ScoringItem[],
  thresholdsIn: Partial<ScoringThresholds> = {},
): ScoringResult {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ScoringInputError('empty_items', 'items must be a non-empty array');
  }

  // Validate + normalise the thresholds before validating items so the
  // caller sees the most-actionable error first.
  const thresholds: ScoringThresholds = {
    low_max: thresholdsIn.low_max ?? DEFAULT_THRESHOLDS.low_max,
    medium_max: thresholdsIn.medium_max ?? DEFAULT_THRESHOLDS.medium_max,
  };
  if (
    !Number.isFinite(thresholds.low_max) ||
    !Number.isFinite(thresholds.medium_max) ||
    thresholds.low_max < 0 ||
    thresholds.medium_max > 100 ||
    thresholds.low_max > thresholds.medium_max
  ) {
    throw new ScoringInputError(
      'invalid_thresholds',
      'thresholds must satisfy 0 ≤ low_max ≤ medium_max ≤ 100',
    );
  }

  // Validate each item.
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (!it || typeof it.indicator_id !== 'string' || !it.indicator_id.trim()) {
      throw new ScoringInputError('invalid_item', `item[${i}].indicator_id is required`);
    }
    if (typeof it.weight !== 'number' || !Number.isFinite(it.weight) || it.weight < 0 || it.weight > 1) {
      throw new ScoringInputError(
        'invalid_weight',
        `item[${i}] (${it.indicator_id}): weight must be a number in [0, 1]`,
      );
    }
    if (typeof it.value !== 'number' || !Number.isFinite(it.value)) {
      throw new ScoringInputError(
        'invalid_value',
        `item[${i}] (${it.indicator_id}): value must be a finite number`,
      );
    }
  }

  // Compute. Values are clamped to [0,1] so a poorly-normalised input
  // can't blow the upper bound. Weights with value 0 contribute zero.
  const breakdown: ScoringBreakdownEntry[] = items.map((it) => {
    const v = clamp01(it.value);
    const contribution = round4(it.weight * v);
    return {
      indicator_id: it.indicator_id,
      weight: it.weight,
      value: v,
      contribution,
    };
  });
  const raw_sum = round4(breakdown.reduce((s, e) => s + e.contribution, 0));
  const total_weight = round4(items.reduce((s, it) => s + it.weight, 0));

  // total_weight could be 0 (every item has weight 0). In that case the
  // score is undefined; return 0 + low rather than NaN.
  const score =
    total_weight === 0 ? 0 : round4((raw_sum / total_weight) * 100);

  const category: ScoringCategory =
    score <= thresholds.low_max ? 'low' : score <= thresholds.medium_max ? 'medium' : 'high';

  return { score, category, thresholds, breakdown, total_weight, raw_sum };
}
