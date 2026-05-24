// services/bff/src/dq_score.ts
//
// Module 1.7 — Data Quality Score.
//
// Composite 0–100 score per source and per attribute, summarising DQ
// across 5 dimensions:
//   1. completeness  — % of non-null required values
//   2. validity      — % satisfying range/regex/enum
//   3. consistency   — % matching cross-source reference (here: stable
//                      mart join health proxy)
//   4. uniqueness    — % distinct keys
//   5. timeliness    — % rows within freshness SLO
//
// Acceptance (from spec):
//   - composite score is reproducible (deterministic per (tenant, source,
//     day) — same input → same number)
//   - weight of each dimension is configurable in Thresholds & Limits
//     (we read from the M13.1 admin config under the key
//     `scoring.dq.dimension_weights`)
//
// Distinct from M9 (existing dq/dq_engine.ts which is RULE-centric):
// this module computes the COMPOSITE score using the rule executions +
// catalog facts. Pure functions; the route layer composes against the
// shared `defaultDqStore` and `configStore`.

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// ── Closed enums ───────────────────────────────────────────────────────

export const DQ_DIMENSIONS = [
  'completeness',
  'validity',
  'consistency',
  'uniqueness',
  'timeliness',
] as const;
export type DqDimension = (typeof DQ_DIMENSIONS)[number];

export function isDqDimension(x: unknown): x is DqDimension {
  return typeof x === 'string' && (DQ_DIMENSIONS as readonly string[]).includes(x);
}

/** The 6 monitored data sources — same set the rest of the data-quality
 *  surfaces use (M3 connectors, M9 dq_engine, data_profiling). */
export const DQ_SCORE_SOURCES = [
  'cbs_loans',
  'cbs_repayments',
  'cbs_txns',
  'mart_customer_360',
  'mart_loan_360',
  'bureau_score',
] as const;
export type DqScoreSource = (typeof DQ_SCORE_SOURCES)[number];

export function isDqScoreSource(x: unknown): x is DqScoreSource {
  return typeof x === 'string' && (DQ_SCORE_SOURCES as readonly string[]).includes(x);
}

// ── Shapes ─────────────────────────────────────────────────────────────

export type DimensionWeights = Record<DqDimension, number>;

/** Default weights — sum to 1.0. Operators tune via /v1/admin/config
 *  under the key `scoring.dq.dimension_weights`. */
export const DEFAULT_DIMENSION_WEIGHTS: DimensionWeights = {
  completeness: 0.30,
  validity: 0.30,
  consistency: 0.15,
  uniqueness: 0.15,
  timeliness: 0.10,
};

export interface DqDimensionScore {
  dimension: DqDimension;
  score: number; // 0..100
  weight: number; // 0..1 (effective; from config or default)
  samples: number; // # rows / rules considered for this dimension
}

export interface DqSourceScore {
  source_id: DqScoreSource;
  composite_score: number; // 0..100, weighted mean
  dimensions: DqDimensionScore[];
  attributes: number; // count of attributes scored at the source
  last_evaluated_at: string;
  /** Sum of `samples` across the 5 dimensions — gives the "data volume"
   *  size in the SPA tooltip. */
  rows_evaluated: number;
}

export interface DqAttributeScore {
  source_id: DqScoreSource;
  attribute: string;
  composite_score: number;
  dimensions: DqDimensionScore[];
  last_evaluated_at: string;
  /** Format-detect signal from M1.2 data profiling, when applicable. */
  format_detected?: string | null;
}

export interface DqTrendPoint {
  date: string; // YYYY-MM-DD
  composite_score: number;
  dimensions: Record<DqDimension, number>;
}

export interface DqSourceTrend {
  source_id: DqScoreSource;
  window_days: number;
  trend: DqTrendPoint[];
  start_date: string;
  end_date: string;
}

export interface DqDashboardScoreOverlay {
  tenant_id: string;
  generated_at: string;
  weights: DimensionWeights;
  by_source: DqSourceScore[];
  /** Aggregate across all sources, weighted by attributes-count. */
  fleet_composite_score: number;
  worst_source: { source_id: DqScoreSource; composite_score: number } | null;
  best_source: { source_id: DqScoreSource; composite_score: number } | null;
}

// ── Pure helpers ───────────────────────────────────────────────────────

/** Compose a 0..100 score from per-dimension 0..100 values + weights.
 *  Weights are normalised so callers don't have to (handles configs
 *  that don't sum to 1.0 — pure-function safety net). */
export function composeScore(
  dimensionScores: Record<DqDimension, number>,
  weights: DimensionWeights,
): number {
  let weightSum = 0;
  let weighted = 0;
  for (const d of DQ_DIMENSIONS) {
    const w = Math.max(0, weights[d] ?? 0);
    if (w === 0) continue;
    const v = Math.max(0, Math.min(100, dimensionScores[d] ?? 0));
    weighted += v * w;
    weightSum += w;
  }
  if (weightSum === 0) return 0;
  return Math.round((weighted / weightSum) * 10) / 10;
}

/** Validate + normalise a partial weights override. Missing dimensions
 *  fall back to defaults. Negatives clamp to 0. */
export function normaliseWeights(raw: unknown): DimensionWeights {
  const result: DimensionWeights = { ...DEFAULT_DIMENSION_WEIGHTS };
  if (!raw || typeof raw !== 'object') return result;
  const obj = raw as Record<string, unknown>;
  for (const d of DQ_DIMENSIONS) {
    const v = obj[d];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      result[d] = v;
    }
  }
  return result;
}

// ── Synthesis ──────────────────────────────────────────────────────────
//
// Deterministic per (tenant, source, day) — same call yields the same
// scores. Production swap: read real DQ rule execution outcomes from
// the dq_engine store + the data_profiling stats and compute the
// dimension scores from real data.

/** Per-source baseline scores: bias toward 88-99 for mart tables
 *  (curated), 80-95 for CBS (cleaner upstream), 70-90 for bureau (3rd
 *  party flakiness). */
function baselineBiasFor(source: DqScoreSource): { center: number; spread: number } {
  if (source.startsWith('mart_')) return { center: 93, spread: 6 };
  if (source.startsWith('cbs_')) return { center: 88, spread: 8 };
  return { center: 80, spread: 10 }; // bureau / external
}

function scoreInBand(rng: () => number, source: DqScoreSource): number {
  const { center, spread } = baselineBiasFor(source);
  // Spread around center, clamped to 60..99.
  const raw = center + (rng() - 0.5) * 2 * spread;
  return Math.round(Math.max(60, Math.min(99, raw)) * 10) / 10;
}

/** Deterministic per-dimension scores for (tenant, source, day). */
export function syntheticDimensionScores(
  tenant_id: string,
  source_id: DqScoreSource,
  day: string,
): Record<DqDimension, { score: number; samples: number }> {
  const out = {} as Record<DqDimension, { score: number; samples: number }>;
  for (const d of DQ_DIMENSIONS) {
    const rng = mulberry32(fnv1a(`${tenant_id}|${source_id}|${d}|${day}`));
    out[d] = {
      score: scoreInBand(rng, source_id),
      samples: Math.round(10_000 + rng() * 90_000),
    };
  }
  return out;
}

/** Build the per-attribute breakdown for a source on a given day. */
export function syntheticAttributeScores(
  tenant_id: string,
  source_id: DqScoreSource,
  weights: DimensionWeights,
  now: Date,
): DqAttributeScore[] {
  const day = now.toISOString().slice(0, 10);
  // Static attribute catalog per source — mirrors data_profiling.ts.
  const ATTRIBUTES_BY_SOURCE: Record<DqScoreSource, ReadonlyArray<{ name: string; format?: string | null }>> = {
    cbs_loans: [
      { name: 'loan_id' },
      { name: 'customer_id', format: 'numeric_id' },
      { name: 'product_code' },
      { name: 'sanctioned_amount' },
      { name: 'outstanding' },
      { name: 'worst_dpd' },
      { name: 'onboarded_at', format: 'iso_date' },
      { name: 'has_npa' },
    ],
    cbs_repayments: [
      { name: 'repayment_id' },
      { name: 'loan_id' },
      { name: 'paid_at', format: 'iso_date' },
      { name: 'amount' },
      { name: 'dpd_at_payment' },
    ],
    cbs_txns: [
      { name: 'txn_id' },
      { name: 'account_id' },
      { name: 'txn_at', format: 'iso_datetime' },
      { name: 'amount' },
      { name: 'channel' },
    ],
    mart_customer_360: [
      { name: 'customer_id' },
      { name: 'pan', format: 'pan' },
      { name: 'phone', format: 'phone_in' },
      { name: 'email', format: 'email' },
      { name: 'risk_rating' },
      { name: 'monthly_income' },
    ],
    mart_loan_360: [
      { name: 'loan_id' },
      { name: 'customer_id' },
      { name: 'product_code' },
      { name: 'outstanding' },
      { name: 'worst_dpd' },
      { name: 'has_npa' },
    ],
    bureau_score: [
      { name: 'customer_id' },
      { name: 'score' },
      { name: 'reported_at', format: 'iso_date' },
    ],
  };
  const attrs = ATTRIBUTES_BY_SOURCE[source_id] ?? [];
  return attrs.map((attr) => {
    // Each attribute carries its own dimension scores (per-attribute drill).
    const dimScores = {} as Record<DqDimension, { score: number; samples: number }>;
    for (const d of DQ_DIMENSIONS) {
      const rng = mulberry32(fnv1a(`${tenant_id}|${source_id}|${attr.name}|${d}|${day}`));
      dimScores[d] = {
        score: scoreInBand(rng, source_id),
        samples: Math.round(1_000 + rng() * 9_000),
      };
    }
    const dimensions: DqDimensionScore[] = DQ_DIMENSIONS.map((d) => ({
      dimension: d,
      score: dimScores[d].score,
      weight: weights[d],
      samples: dimScores[d].samples,
    }));
    const scoresForCompose = {} as Record<DqDimension, number>;
    for (const d of DQ_DIMENSIONS) scoresForCompose[d] = dimScores[d].score;
    return {
      source_id,
      attribute: attr.name,
      composite_score: composeScore(scoresForCompose, weights),
      dimensions,
      last_evaluated_at: now.toISOString(),
      format_detected: attr.format ?? null,
    } satisfies DqAttributeScore;
  });
}

/** Build the source-level composite score for the given tenant + day. */
export function buildSourceScore(
  tenant_id: string,
  source_id: DqScoreSource,
  weights: DimensionWeights,
  now: Date,
): DqSourceScore {
  if (!isDqScoreSource(source_id)) {
    throw new Error(`unknown source: ${source_id}`);
  }
  const day = now.toISOString().slice(0, 10);
  const raw = syntheticDimensionScores(tenant_id, source_id, day);
  const dimensions: DqDimensionScore[] = DQ_DIMENSIONS.map((d) => ({
    dimension: d,
    score: raw[d].score,
    weight: weights[d],
    samples: raw[d].samples,
  }));
  const scoresForCompose = {} as Record<DqDimension, number>;
  for (const d of DQ_DIMENSIONS) scoresForCompose[d] = raw[d].score;
  const composite = composeScore(scoresForCompose, weights);
  // attribute count varies by source — read from the same static catalog.
  const attrs = syntheticAttributeScores(tenant_id, source_id, weights, now);
  const rows_evaluated = dimensions.reduce((acc, d) => acc + d.samples, 0);
  return {
    source_id,
    composite_score: composite,
    dimensions,
    attributes: attrs.length,
    last_evaluated_at: now.toISOString(),
    rows_evaluated,
  };
}

/** Build the full dashboard overlay — 1 score per source plus rollups. */
export function buildDqScoreDashboard(
  tenant_id: string,
  weights: DimensionWeights,
  now: Date,
): DqDashboardScoreOverlay {
  const by_source = DQ_SCORE_SOURCES.map((s) => buildSourceScore(tenant_id, s, weights, now));
  // Weighted by attributes-count so larger sources matter more.
  let weightSum = 0;
  let weighted = 0;
  for (const s of by_source) {
    weightSum += s.attributes;
    weighted += s.composite_score * s.attributes;
  }
  const fleet = weightSum === 0 ? 0 : Math.round((weighted / weightSum) * 10) / 10;
  let worst: DqDashboardScoreOverlay['worst_source'] = null;
  let best: DqDashboardScoreOverlay['best_source'] = null;
  for (const s of by_source) {
    if (!worst || s.composite_score < worst.composite_score) worst = { source_id: s.source_id, composite_score: s.composite_score };
    if (!best || s.composite_score > best.composite_score) best = { source_id: s.source_id, composite_score: s.composite_score };
  }
  return {
    tenant_id,
    generated_at: now.toISOString(),
    weights,
    by_source,
    fleet_composite_score: fleet,
    worst_source: worst,
    best_source: best,
  };
}

/** Build the 30-day (configurable, capped 90) trend for one source. */
export function buildSourceTrend(
  tenant_id: string,
  source_id: DqScoreSource,
  windowDays: number,
  weights: DimensionWeights,
  now: Date,
): DqSourceTrend {
  const days = Math.max(1, Math.min(90, Math.floor(windowDays)));
  const start = new Date(now.getTime() - (days - 1) * 86_400_000);
  const trend: DqTrendPoint[] = [];
  for (let i = 0; i < days; i++) {
    const dayDate = new Date(start.getTime() + i * 86_400_000);
    const day = dayDate.toISOString().slice(0, 10);
    const raw = syntheticDimensionScores(tenant_id, source_id, day);
    const scoresForCompose = {} as Record<DqDimension, number>;
    const dims = {} as Record<DqDimension, number>;
    for (const d of DQ_DIMENSIONS) {
      scoresForCompose[d] = raw[d].score;
      dims[d] = raw[d].score;
    }
    trend.push({
      date: day,
      composite_score: composeScore(scoresForCompose, weights),
      dimensions: dims,
    });
  }
  return {
    source_id,
    window_days: days,
    trend,
    start_date: start.toISOString().slice(0, 10),
    end_date: now.toISOString().slice(0, 10),
  };
}

// ── Errors ─────────────────────────────────────────────────────────────

export type DqScoreErrorCode =
  | 'invalid_input'
  | 'invalid_source'
  | 'invalid_attribute'
  | 'invalid_window'
  | 'unknown_source';

export class DqScoreError extends Error {
  constructor(public code: DqScoreErrorCode, message: string) {
    super(message);
    this.name = 'DqScoreError';
  }
}
