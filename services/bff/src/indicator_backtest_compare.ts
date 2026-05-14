// services/bff/src/indicator_backtest_compare.ts
//
// T6 M4.8 — Indicator backtest result comparison.
//
// M4.2 ships the backtest engine — given (indicator_id, days,
// segment) it returns fires, confusion matrix, precision/recall/F1,
// and a per-day fire breakdown. M4.8 closes the evaluation loop on
// the risk-committee side: before approving a threshold tweak, an
// analyst wants to see "what would change if I move the threshold
// from 0.6 to 0.7?". They run two backtests (baseline + candidate)
// and need a structural diff.
//
// Design:
//  - Pure function. Takes two BacktestResult objects + returns the
//    delta envelope. No store coupling — caller runs both backtests
//    via /v1/indicators/backtest and hands the results in.
//  - All deltas are b - a (so positive delta = candidate fires more,
//    has higher precision, etc. — direction follows the comparison
//    "from baseline to candidate").
//  - per_day_fires_delta aligns by day; days present in only one
//    side are surfaced as `a_only` / `b_only` (caller's window choices
//    might not match). Days present in both produce `delta`.
//  - same_indicator / same_segment are surfaced as bools so the SPA
//    can warn when an analyst accidentally compares apples to
//    oranges — the comparison still produces meaningful numbers,
//    but the warning is real.

import type { BacktestResult } from './indicator_backtest';

// ─── Public types ─────────────────────────────────────────────────────

export interface PerDayDelta {
  day: string;
  a_fires: number;
  b_fires: number;
  /** b_fires - a_fires. Positive = candidate fires more on this day. */
  delta: number;
}

export interface ConfusionDelta {
  /** Each cell is b - a (candidate minus baseline). */
  true_positive: number;
  false_positive: number;
  false_negative: number;
  true_negative: number;
}

export interface BacktestCompareResult {
  /** All metric + confusion deltas are zero AND fire counts match. */
  identical: boolean;
  /** Warns when callers compare two backtests of different indicators. */
  same_indicator: boolean;
  /** Warns when callers compare two backtests on different segments. */
  same_segment: boolean;
  a_indicator_id: string;
  b_indicator_id: string;
  a_segment: string;
  b_segment: string;
  fires_delta: number;
  precision_delta: number;
  recall_delta: number;
  f1_delta: number;
  mean_value_delta: number;
  confusion_delta: ConfusionDelta;
  /** Per-day breakdown over the union of day sets, oldest-first. */
  per_day_fires_delta: PerDayDelta[];
  /** Days present in only `a`, oldest-first. Pair with per_day for full picture. */
  a_only_days: string[];
  /** Days present in only `b`, oldest-first. */
  b_only_days: string[];
}

export class BacktestCompareError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BacktestCompareError';
  }
}

// ─── Validation ───────────────────────────────────────────────────────

/** Spot-check a BacktestResult shape — caller usually passes one that
 *  came straight from /v1/indicators/backtest, but route-side input
 *  is unknown until we look. */
function check(label: string, v: unknown): BacktestResult {
  if (!v || typeof v !== 'object') {
    throw new BacktestCompareError('invalid_input', `${label} must be a BacktestResult object`);
  }
  const r = v as Record<string, unknown>;
  if (typeof r.indicator_id !== 'string' || !r.indicator_id.trim()) {
    throw new BacktestCompareError('invalid_input', `${label}.indicator_id required`);
  }
  if (typeof r.total_fires !== 'number' || !Number.isFinite(r.total_fires)) {
    throw new BacktestCompareError('invalid_input', `${label}.total_fires required`);
  }
  if (!r.confusion || typeof r.confusion !== 'object') {
    throw new BacktestCompareError('invalid_input', `${label}.confusion required`);
  }
  if (!r.metrics || typeof r.metrics !== 'object') {
    throw new BacktestCompareError('invalid_input', `${label}.metrics required`);
  }
  if (!Array.isArray(r.daily)) {
    throw new BacktestCompareError('invalid_input', `${label}.daily[] required`);
  }
  return v as BacktestResult;
}

// ─── Pure compare ─────────────────────────────────────────────────────

/**
 * Structural diff between two backtest results. Pure-function;
 * caller is responsible for running both backtests and passing the
 * resolved results in.
 */
export function compareBacktestResults(
  a: BacktestResult,
  b: BacktestResult,
): BacktestCompareResult {
  const fires_delta = b.total_fires - a.total_fires;
  const precision_delta = b.metrics.precision - a.metrics.precision;
  const recall_delta = b.metrics.recall - a.metrics.recall;
  const f1_delta = b.metrics.f1 - a.metrics.f1;
  const mean_value_delta = b.mean_value - a.mean_value;
  const confusion_delta: ConfusionDelta = {
    true_positive: b.confusion.true_positive - a.confusion.true_positive,
    false_positive: b.confusion.false_positive - a.confusion.false_positive,
    false_negative: b.confusion.false_negative - a.confusion.false_negative,
    true_negative: b.confusion.true_negative - a.confusion.true_negative,
  };

  // Align daily buckets by day.
  const byDayA = new Map<string, number>();
  for (const d of a.daily) byDayA.set(d.day, d.fires);
  const byDayB = new Map<string, number>();
  for (const d of b.daily) byDayB.set(d.day, d.fires);

  const allDays = new Set([...byDayA.keys(), ...byDayB.keys()]);
  const per_day_fires_delta: PerDayDelta[] = [];
  const a_only_days: string[] = [];
  const b_only_days: string[] = [];

  for (const day of allDays) {
    const inA = byDayA.has(day);
    const inB = byDayB.has(day);
    if (inA && inB) {
      const af = byDayA.get(day)!;
      const bf = byDayB.get(day)!;
      per_day_fires_delta.push({ day, a_fires: af, b_fires: bf, delta: bf - af });
    } else if (inA) {
      a_only_days.push(day);
    } else {
      b_only_days.push(day);
    }
  }
  per_day_fires_delta.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
  a_only_days.sort();
  b_only_days.sort();

  const identical =
    fires_delta === 0 &&
    precision_delta === 0 &&
    recall_delta === 0 &&
    f1_delta === 0 &&
    mean_value_delta === 0 &&
    confusion_delta.true_positive === 0 &&
    confusion_delta.false_positive === 0 &&
    confusion_delta.false_negative === 0 &&
    confusion_delta.true_negative === 0 &&
    a_only_days.length === 0 &&
    b_only_days.length === 0 &&
    per_day_fires_delta.every((p) => p.delta === 0);

  return {
    identical,
    same_indicator: a.indicator_id === b.indicator_id,
    same_segment: a.customer_segment === b.customer_segment,
    a_indicator_id: a.indicator_id,
    b_indicator_id: b.indicator_id,
    a_segment: a.customer_segment,
    b_segment: b.customer_segment,
    fires_delta,
    precision_delta,
    recall_delta,
    f1_delta,
    mean_value_delta,
    confusion_delta,
    per_day_fires_delta,
    a_only_days,
    b_only_days,
  };
}

// ─── Input-validating entry point ─────────────────────────────────────

/** Route-level entry point that validates the two BacktestResult
 *  shapes before delegating to the pure comparator. */
export function compareFromUnknown(input: unknown): BacktestCompareResult {
  if (!input || typeof input !== 'object') {
    throw new BacktestCompareError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  const a = check('a', i.a);
  const b = check('b', i.b);
  return compareBacktestResults(a, b);
}
