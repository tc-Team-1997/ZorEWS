// services/bff/src/threshold_auto_tune.ts
//
// T6 M4.10 — Indicator threshold auto-tune suggestion.
//
// M4.3 ships the threshold breach detection. M4.4 lets tenants
// override per-indicator thresholds. M4.10 ships the third leg:
// given a historical sample of an indicator's observed values, suggest
// red/orange/yellow thresholds based on percentile derivation.
// Lets ops bootstrap a tenant's threshold overrides from real
// observed data instead of hand-picking numbers.
//
// Polarity:
//   higher_is_worse (default — DPD, repeat-claim, drift): red=p95,
//     orange=p75, yellow=p50. The worst 5% of observed values
//     become red — values that bad SHOULD fire.
//   lower_is_worse (customer health score, AUC-like signals where
//     higher = better): red=p5, orange=p25, yellow=p50. Bottom 5%
//     of observed values become red.
//
// Pure — no I/O. Caller passes the value array (typically pulled
// from the backtest mart or M4.2 backtest history).

import { linearPercentile } from './connector_run_analytics';

// ─── Public types ─────────────────────────────────────────────────────

export type ThresholdPolarity = 'higher_is_worse' | 'lower_is_worse';

export function isThresholdPolarity(s: unknown): s is ThresholdPolarity {
  return s === 'higher_is_worse' || s === 'lower_is_worse';
}

export interface SuggestedThresholds {
  yellow_at: number;
  orange_at: number;
  red_at: number;
}

export interface ThresholdSuggestion {
  /** null when sample_size < 5 (not enough data for a percentile). */
  suggested: SuggestedThresholds | null;
  sample_size: number;
  polarity: ThresholdPolarity;
  sample_min: number | null;
  sample_max: number | null;
  /** Reason the suggested envelope is null. Always set when suggested
   *  is null; null otherwise. */
  insufficient_reason: 'too_few_samples' | 'no_finite_values' | null;
}

export class ThresholdSuggestionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ThresholdSuggestionError';
  }
}

const MIN_SAMPLES = 5;

// ─── Pure auto-tune ───────────────────────────────────────────────────

/**
 * Suggest red/orange/yellow thresholds from a sample of observed
 * indicator values. Drops non-finite entries; refuses to suggest
 * with fewer than 5 finite samples.
 */
export function suggestThresholdsFromHistory(
  values: readonly number[],
  polarity: ThresholdPolarity = 'higher_is_worse',
): ThresholdSuggestion {
  if (!isThresholdPolarity(polarity)) {
    throw new ThresholdSuggestionError(
      'invalid_input',
      `polarity must be 'higher_is_worse' or 'lower_is_worse'`,
    );
  }
  const finite = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (finite.length === 0) {
    return {
      suggested: null,
      sample_size: 0,
      polarity,
      sample_min: null,
      sample_max: null,
      insufficient_reason: 'no_finite_values',
    };
  }
  if (finite.length < MIN_SAMPLES) {
    const sorted = [...finite].sort((a, b) => a - b);
    return {
      suggested: null,
      sample_size: finite.length,
      polarity,
      sample_min: sorted[0]!,
      sample_max: sorted[sorted.length - 1]!,
      insufficient_reason: 'too_few_samples',
    };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  let suggested: SuggestedThresholds;
  if (polarity === 'higher_is_worse') {
    suggested = {
      yellow_at: linearPercentile(sorted, 0.5)!,
      orange_at: linearPercentile(sorted, 0.75)!,
      red_at: linearPercentile(sorted, 0.95)!,
    };
  } else {
    // lower_is_worse: bottom-of-distribution = red.
    suggested = {
      yellow_at: linearPercentile(sorted, 0.5)!,
      orange_at: linearPercentile(sorted, 0.25)!,
      red_at: linearPercentile(sorted, 0.05)!,
    };
  }
  return {
    suggested,
    sample_size: finite.length,
    polarity,
    sample_min: min,
    sample_max: max,
    insufficient_reason: null,
  };
}
