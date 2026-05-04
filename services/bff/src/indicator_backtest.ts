// services/bff/src/indicator_backtest.ts
//
// T6 M4.2 — Indicator backtest.
//
// BIL ops + risk committees need backtest evidence before any
// indicator goes live: "what would this indicator have fired on
// over the last 90 days, and what's the precision/recall against the
// observed-default labels?". M4.2 ships the simulation surface.
//
// The math is intentionally synthetic for the prototype — real
// backtests run against `mart.indicator_history` against `mart.label`.
// Production swaps the synthesis below for SQL aggregation; the
// response shape is identical.
//
// Determinism: same (tenant, indicator_id, asOf-day, days_param) input
// → same output. Lets the SPA cache results without staleness anxiety.
//
// Cross-module: the indicator catalog comes from M6.2's lookup so
// vertical filtering + name resolution stay shared.

import {
  type IndicatorWeightLookup,
  type ScoringVertical,
  isScoringVertical,
} from './bil_scoring_v2';

// ─── Public types ──────────────────────────────────────────────────────

export type CustomerSegment = 'all' | 'retail' | 'sme' | 'corporate';

export interface BacktestInput {
  indicator_id: string;
  vertical?: ScoringVertical;
  /** Trailing window in days. Clamped to [1, 365]. */
  days: number;
  /** Optional segment filter. Defaults to 'all'. */
  customer_segment?: CustomerSegment;
}

export interface BacktestDayBucket {
  day: string; // YYYY-MM-DD
  fires: number;
  /** Subset of fires that aligned with an observed default within
   *  the next 30 days — proxies for "true positive". */
  true_positives: number;
}

export interface BacktestResult {
  indicator_id: string;
  indicator_name: string;
  vertical: ScoringVertical | null;
  days: number;
  customer_segment: CustomerSegment;
  total_customers_evaluated: number;
  total_fires: number;
  /** Per-day breakdown, oldest-first. */
  daily: BacktestDayBucket[];
  /** Confusion-matrix cells. fires + non_fires = total_customers_evaluated × days. */
  confusion: {
    true_positive: number;
    false_positive: number;
    /** Defaulted but the indicator did NOT fire — the misses we care
     *  about for credit risk. */
    false_negative: number;
    /** Did not default + indicator did not fire. The big bucket. */
    true_negative: number;
  };
  /** Operator-friendly metrics. */
  metrics: {
    precision: number; // TP / (TP + FP)
    recall: number; // TP / (TP + FN)
    f1: number;
    /** Weighted score Σ(W × V) the indicator's catalog weight produces
     *  when value=mean_value. Lets the SPA pre-bucket the indicator
     *  into the M6.1 score it would contribute. */
    weighted_contribution: number;
  };
  /** Mean indicator value across all fires. 0..1. */
  mean_value: number;
  generated_at: string;
}

export class BacktestError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BacktestError';
  }
}

const VALID_SEGMENTS: CustomerSegment[] = ['all', 'retail', 'sme', 'corporate'];

export function isCustomerSegment(s: unknown): s is CustomerSegment {
  return typeof s === 'string' && VALID_SEGMENTS.includes(s as CustomerSegment);
}

// ─── Deterministic PRNG ────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function daysBefore(d: Date, n: number): Date {
  return new Date(d.getTime() - n * 86_400_000);
}

// ─── Synthesis ─────────────────────────────────────────────────────────

/** How many customers we evaluate per day, by segment. */
const SEGMENT_SIZES: Record<CustomerSegment, number> = {
  all: 5000,
  retail: 3500,
  sme: 1200,
  corporate: 300,
};

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ─── Validation ────────────────────────────────────────────────────────

export function validateInput(input: unknown): BacktestInput {
  if (!input || typeof input !== 'object') {
    throw new BacktestError('invalid_input', 'request body required');
  }
  const i = input as Partial<BacktestInput>;
  if (typeof i.indicator_id !== 'string' || !i.indicator_id.trim()) {
    throw new BacktestError('invalid_input', 'indicator_id is required');
  }
  if (typeof i.days !== 'number' || !Number.isFinite(i.days) || !Number.isInteger(i.days)) {
    throw new BacktestError('invalid_input', 'days must be an integer');
  }
  if (i.days < 1 || i.days > 365) {
    throw new BacktestError('invalid_days', 'days must be in [1, 365]');
  }
  if (i.vertical !== undefined && !isScoringVertical(i.vertical)) {
    throw new BacktestError('invalid_vertical', `invalid vertical: ${i.vertical}`);
  }
  if (i.customer_segment !== undefined && !isCustomerSegment(i.customer_segment)) {
    throw new BacktestError(
      'invalid_segment',
      `customer_segment must be one of ${VALID_SEGMENTS.join(',')}`,
    );
  }
  return {
    indicator_id: i.indicator_id,
    days: i.days,
    vertical: i.vertical,
    customer_segment: i.customer_segment ?? 'all',
  };
}

// ─── Backtest entry point ──────────────────────────────────────────────

export function runBacktest(
  tenant_id: string,
  input: BacktestInput,
  lookup: IndicatorWeightLookup,
  now: Date,
): BacktestResult {
  const validated = validateInput(input);
  const meta = lookup.getWeight(validated.indicator_id, validated.vertical);
  if (!meta) {
    const where = validated.vertical ? ` in vertical '${validated.vertical}'` : '';
    throw new BacktestError(
      'unknown_indicator',
      `indicator_id '${validated.indicator_id}' not found in catalog${where}`,
    );
  }

  const segment = validated.customer_segment ?? 'all';
  const customers_per_day = SEGMENT_SIZES[segment];
  const total_customers_evaluated = customers_per_day; // same cohort each day

  // Per-(tenant, indicator, day_of_now, days, segment) seed so the
  // simulation is stable across SPA polls but varies meaningfully if
  // any input changes.
  const seed = fnv1a(
    `bt|${tenant_id}|${validated.indicator_id}|${dayOf(now)}|${validated.days}|${segment}`,
  );
  const r = rng(seed);

  // Base fire-rate biased by indicator weight — heavier-weight
  // indicators tend to be tighter (lower false-positive rate, higher
  // precision). Calibrated for realism: ~1-3% fire-rate per day.
  const base_fire_rate = 0.005 + (1 - meta.weight) * 0.04;

  const daily: BacktestDayBucket[] = [];
  let total_fires = 0;
  let true_positive = 0;
  let false_positive = 0;
  let false_negative = 0;
  let true_negative = 0;
  let value_sum = 0;
  let value_count = 0;

  for (let i = validated.days - 1; i >= 0; i--) {
    const day = dayOf(daysBefore(now, i));
    // Per-day fire count drawn around base_fire_rate with mild noise.
    const day_rate = clamp01(base_fire_rate + (r() - 0.5) * 0.005);
    const fires_today = Math.floor(day_rate * customers_per_day);
    // Of fires today, what fraction subsequently default (true positives)?
    // Heavier-weight indicators have higher precision (45-75%); lighter
    // ones (15-40%).
    const precision_today = clamp01(0.15 + meta.weight * 0.6 + (r() - 0.5) * 0.05);
    const tp_today = Math.floor(fires_today * precision_today);
    const fp_today = fires_today - tp_today;

    // Of customers who DID default but the indicator did NOT fire
    // (false negatives) — assume base default rate ~1.5% across the
    // cohort, minus the TPs we already counted.
    const observed_defaults_today = Math.floor(0.015 * customers_per_day);
    const fn_today = Math.max(0, observed_defaults_today - tp_today);
    const non_fires_today = customers_per_day - fires_today;
    const tn_today = Math.max(0, non_fires_today - fn_today);

    daily.push({ day, fires: fires_today, true_positives: tp_today });
    total_fires += fires_today;
    true_positive += tp_today;
    false_positive += fp_today;
    false_negative += fn_today;
    true_negative += tn_today;

    if (fires_today > 0) {
      // Mean value across firing customers — biased toward high values
      // for heavier-weight indicators.
      const mv_today = clamp01(0.35 + meta.weight * 0.4 + (r() - 0.5) * 0.05);
      value_sum += mv_today * fires_today;
      value_count += fires_today;
    }
  }

  const precision =
    true_positive + false_positive > 0
      ? round4(true_positive / (true_positive + false_positive))
      : 0;
  const recall =
    true_positive + false_negative > 0
      ? round4(true_positive / (true_positive + false_negative))
      : 0;
  const f1 = precision + recall > 0 ? round4((2 * precision * recall) / (precision + recall)) : 0;
  const mean_value = value_count > 0 ? round4(value_sum / value_count) : 0;
  const weighted_contribution = round4(meta.weight * mean_value);

  return {
    indicator_id: validated.indicator_id,
    indicator_name: meta.name,
    vertical: validated.vertical ?? null,
    days: validated.days,
    customer_segment: segment,
    total_customers_evaluated,
    total_fires,
    daily,
    confusion: { true_positive, false_positive, false_negative, true_negative },
    metrics: { precision, recall, f1, weighted_contribution },
    mean_value,
    generated_at: now.toISOString(),
  };
}
