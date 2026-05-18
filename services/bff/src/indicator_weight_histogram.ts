// services/bff/src/indicator_weight_histogram.ts
//
// T6 M4.15 — Indicator catalog weight distribution histogram.
//
// M4.13 ships catalog statistics with weight {min, mean, max} per
// vertical. M4.14 ships threshold band-gap quality scorecard.
//
// M4.15 lands the WEIGHT DISTRIBUTION HISTOGRAM view: bucket all
// indicators in the STUB_CATALOG by their weight into 5 canonical
// magnitude buckets (low / low-medium / medium / high / critical)
// with strict-< upper bound semantics. Per-bucket: count +
// by_vertical breakdown + indicator_ids sample.
//
// Distinct from M4.13 (per-vertical aggregates) by being the
// histogram view — answers "what's the SHAPE of our indicator weight
// distribution? are we top-heavy on critical signals?" in one call.
//
// Mirror of M9.11 (case age buckets) / M8.12 (alert ack-time histogram)
// pattern for the indicator catalog surface. Platform-static — same
// response across tenants.
//
// Pure resolver — reads the M6.2 STUB_CATALOG directly.

import { STUB_CATALOG, type ScoringVertical } from './bil_scoring_v2';

// ─── Canonical buckets ─────────────────────────────────────────────────

export type IndicatorWeightBucket =
  | 'low'             // [0, 0.2)
  | 'low_medium'      // [0.2, 0.4)
  | 'medium'          // [0.4, 0.6)
  | 'high'            // [0.6, 0.8)
  | 'critical';       // [0.8, 1.0]

export const ALL_INDICATOR_WEIGHT_BUCKETS: readonly IndicatorWeightBucket[] = [
  'low',
  'low_medium',
  'medium',
  'high',
  'critical',
] as const;

const ALL_VERTICALS: readonly ScoringVertical[] = ['banking', 'insurance'] as const;

interface BucketDef {
  bucket: IndicatorWeightBucket;
  label: string;
  min: number;
  max: number;
  /** Whether `max` is inclusive (critical bucket includes 1.0). */
  max_inclusive: boolean;
}

const BUCKET_DEFS: Record<IndicatorWeightBucket, BucketDef> = {
  low: { bucket: 'low', label: 'Low (0..0.2)', min: 0, max: 0.2, max_inclusive: false },
  low_medium: { bucket: 'low_medium', label: 'Low-medium (0.2..0.4)', min: 0.2, max: 0.4, max_inclusive: false },
  medium: { bucket: 'medium', label: 'Medium (0.4..0.6)', min: 0.4, max: 0.6, max_inclusive: false },
  high: { bucket: 'high', label: 'High (0.6..0.8)', min: 0.6, max: 0.8, max_inclusive: false },
  critical: { bucket: 'critical', label: 'Critical (0.8..1.0)', min: 0.8, max: 1.0, max_inclusive: true },
};

// ─── Public types ──────────────────────────────────────────────────────

export interface IndicatorWeightBucketRow {
  bucket: IndicatorWeightBucket;
  label: string;
  min: number;
  max: number;
  max_inclusive: boolean;
  count: number;
  /** Per-vertical breakdown (every vertical present at 0 when absent). */
  by_vertical: Record<ScoringVertical, number>;
  /** Sample indicator_ids in this bucket (sorted asc, cap 5). */
  sample_indicator_ids: string[];
}

export interface IndicatorWeightHistogramSummary {
  generated_at: string;
  total_indicators: number;
  buckets: IndicatorWeightBucketRow[];
  /** Highest-count bucket; canonical-order tie-break via iteration
   *  (low first, critical last); null when no indicators. */
  peak_bucket: IndicatorWeightBucket | null;
  peak_count: number;
  /** Mean weight across the entire catalog (rounded to 4 decimals).
   *  null when total_indicators=0. */
  mean_weight: number | null;
  /** Min + max weight across the catalog; null on empty. */
  min_weight: number | null;
  max_weight: number | null;
  /** Buckets with count=0 in canonical order. */
  empty_buckets: IndicatorWeightBucket[];
}

// ─── Helpers ───────────────────────────────────────────────────────────

function classifyWeight(weight: number): IndicatorWeightBucket | null {
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) return null;
  for (const b of ALL_INDICATOR_WEIGHT_BUCKETS) {
    const def = BUCKET_DEFS[b];
    if (def.max_inclusive) {
      if (weight >= def.min && weight <= def.max) return b;
    } else {
      if (weight >= def.min && weight < def.max) return b;
    }
  }
  return null;
}

function emptyByVertical(): Record<ScoringVertical, number> {
  return { banking: 0, insurance: 0 };
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildIndicatorWeightHistogram(
  now: Date,
): IndicatorWeightHistogramSummary {
  const entries = Object.entries(STUB_CATALOG);

  // Initialise buckets in canonical order.
  const buckets: Record<IndicatorWeightBucket, IndicatorWeightBucketRow> = {} as never;
  for (const b of ALL_INDICATOR_WEIGHT_BUCKETS) {
    const def = BUCKET_DEFS[b];
    buckets[b] = {
      bucket: b,
      label: def.label,
      min: def.min,
      max: def.max,
      max_inclusive: def.max_inclusive,
      count: 0,
      by_vertical: emptyByVertical(),
      sample_indicator_ids: [],
    };
  }

  // Bucket candidate pools for sampling.
  const candidates: Record<IndicatorWeightBucket, string[]> = {} as never;
  for (const b of ALL_INDICATOR_WEIGHT_BUCKETS) candidates[b] = [];

  let weight_sum = 0;
  let min_weight: number | null = null;
  let max_weight: number | null = null;

  for (const [id, entry] of entries) {
    const bucket = classifyWeight(entry.weight);
    if (!bucket) continue;
    const row = buckets[bucket];
    row.count++;
    if (ALL_VERTICALS.includes(entry.vertical)) {
      row.by_vertical[entry.vertical]++;
    }
    candidates[bucket].push(id);
    weight_sum += entry.weight;
    if (min_weight === null || entry.weight < min_weight) min_weight = entry.weight;
    if (max_weight === null || entry.weight > max_weight) max_weight = entry.weight;
  }

  // Finalize samples (sorted asc, cap 5).
  for (const b of ALL_INDICATOR_WEIGHT_BUCKETS) {
    candidates[b].sort();
    buckets[b].sample_indicator_ids = candidates[b].slice(0, 5);
  }

  // peak_bucket — highest count; canonical iteration tie-break.
  let peak_bucket: IndicatorWeightBucket | null = null;
  let peak_count = 0;
  for (const b of ALL_INDICATOR_WEIGHT_BUCKETS) {
    if (buckets[b].count > peak_count) {
      peak_count = buckets[b].count;
      peak_bucket = b;
    }
  }
  if (peak_count === 0) peak_bucket = null;

  // empty_buckets — canonical-order zero-count subset.
  const empty_buckets = ALL_INDICATOR_WEIGHT_BUCKETS.filter((b) => buckets[b].count === 0);

  const total_indicators = entries.length;
  const mean_weight =
    total_indicators === 0
      ? null
      : Math.round((weight_sum / total_indicators) * 10000) / 10000;

  return {
    generated_at: now.toISOString(),
    total_indicators,
    buckets: ALL_INDICATOR_WEIGHT_BUCKETS.map((b) => buckets[b]),
    peak_bucket,
    peak_count,
    mean_weight,
    min_weight,
    max_weight,
    empty_buckets,
  };
}
