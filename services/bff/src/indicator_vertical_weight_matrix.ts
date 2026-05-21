// services/bff/src/indicator_vertical_weight_matrix.ts
//
// T6 M4.18 — Indicator vertical × weight-bucket cross-tab matrix.
//
// M4.13 ships catalog statistics with weight stats nested per vertical.
// M4.15 ships the WEIGHT histogram (1D bucket-by-magnitude).
// M4.16 ships the vertical × FAMILY matrix (2D).
//
// M4.18 elevates M4.15's bucketing into the orthogonal 2D pivot:
// rows = 2 ScoringVerticals (banking + insurance) × cols = 5 declared
// weight buckets (low, low_medium, medium, high, critical) = 10 cells.
//
// Each indicator in STUB_CATALOG lives in exactly one cell (its
// vertical × its weight bucket). The cross-tab answers "which vertical
// owns our heaviest signals? are insurance indicators top-heavy on
// critical or skewed to medium?" in one round-trip.
//
// Same strict-< upper bound semantics as M4.15 (critical is inclusive
// at 1.0; all others strict-< on max). ALL_INDICATOR_WEIGHT_BUCKETS
// re-exported from M4.15 for consumers.
//
// Mirror of M4.16 / M14.28 / M12.14 / M3.14 / M5.17 / M7.14 / M8.14 /
// M15.14 matrix pattern for the indicator catalog surface.
//
// Platform-static — same response across tenants.

import { STUB_CATALOG, type ScoringVertical } from './bil_scoring_v2';
import {
  ALL_INDICATOR_WEIGHT_BUCKETS,
  type IndicatorWeightBucket,
} from './indicator_weight_histogram';

// ─── Canonical enums ───────────────────────────────────────────────────

const ALL_VERTICALS: readonly ScoringVertical[] = ['banking', 'insurance'] as const;

interface BucketDef {
  bucket: IndicatorWeightBucket;
  label: string;
  min: number;
  max: number;
  max_inclusive: boolean;
}

const BUCKET_DEFS: Record<IndicatorWeightBucket, BucketDef> = {
  low: { bucket: 'low', label: 'Low (0..0.2)', min: 0, max: 0.2, max_inclusive: false },
  low_medium: { bucket: 'low_medium', label: 'Low-medium (0.2..0.4)', min: 0.2, max: 0.4, max_inclusive: false },
  medium: { bucket: 'medium', label: 'Medium (0.4..0.6)', min: 0.4, max: 0.6, max_inclusive: false },
  high: { bucket: 'high', label: 'High (0.6..0.8)', min: 0.6, max: 0.8, max_inclusive: false },
  critical: { bucket: 'critical', label: 'Critical (0.8..1.0)', min: 0.8, max: 1.0, max_inclusive: true },
};

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

// ─── Public types ──────────────────────────────────────────────────────

export interface IndicatorVerticalWeightRow {
  vertical: ScoringVertical;
  total: number;
  /** Per-bucket counts; every canonical bucket present at 0 when absent. */
  by_bucket: Record<IndicatorWeightBucket, number>;
  /** Buckets with by_bucket=0 for this vertical, in canonical order. */
  buckets_without: IndicatorWeightBucket[];
  /** Mean weight across this vertical's indicators (rounded 4 decimals).
   *  null when total=0. */
  mean_weight: number | null;
  /** Min/max weight within this vertical; null on empty vertical. */
  min_weight: number | null;
  max_weight: number | null;
}

export interface IndicatorVerticalWeightColumn {
  bucket: IndicatorWeightBucket;
  label: string;
  min: number;
  max: number;
  max_inclusive: boolean;
  total: number;
  /** Per-vertical counts; every vertical present at 0 when absent. */
  by_vertical: Record<ScoringVertical, number>;
  /** Verticals with by_vertical=0 for this bucket. */
  verticals_without: ScoringVertical[];
}

export interface IndicatorVerticalWeightCell {
  vertical: ScoringVertical;
  bucket: IndicatorWeightBucket;
}

export interface IndicatorVerticalWeightPeakCell extends IndicatorVerticalWeightCell {
  count: number;
  /** Indicator ids in this cell (sorted asc, cap 5). */
  sample_indicator_ids: string[];
}

export interface IndicatorVerticalWeightMatrix {
  generated_at: string;
  total_indicators: number;
  total_verticals: number;
  total_buckets: number;
  rows: IndicatorVerticalWeightRow[];
  columns: IndicatorVerticalWeightColumn[];
  /** Highest-count cell; canonical iteration tie-break (vertical major
   *  in ALL_VERTICALS order × bucket minor in
   *  ALL_INDICATOR_WEIGHT_BUCKETS); null on empty catalog. */
  peak_cell: IndicatorVerticalWeightPeakCell | null;
  /** Cells with count=0 in canonical vertical × bucket row-major order. */
  empty_cells: IndicatorVerticalWeightCell[];
  /** Vertical with the most distinct non-zero buckets; canonical
   *  vertical-order tie-break: banking beats insurance at tied span. */
  most_diverse_vertical: ScoringVertical | null;
  /** Vertical whose heaviest indicators lean toward `critical`.
   *  Picked by highest count in the critical bucket; canonical
   *  vertical-order tie-break; null when neither has critical
   *  indicators. */
  heaviest_vertical: ScoringVertical | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByBucket(): Record<IndicatorWeightBucket, number> {
  const out = {} as Record<IndicatorWeightBucket, number>;
  for (const b of ALL_INDICATOR_WEIGHT_BUCKETS) out[b] = 0;
  return out;
}

function emptyByVertical(): Record<ScoringVertical, number> {
  return { banking: 0, insurance: 0 };
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildIndicatorVerticalWeightMatrix(
  now: Date,
): IndicatorVerticalWeightMatrix {
  // cellCounts[vertical][bucket] = count
  // cellIds[vertical][bucket] = indicator_ids[] (for sample collection)
  const cellCounts: Record<ScoringVertical, Record<IndicatorWeightBucket, number>> = {
    banking: emptyByBucket(),
    insurance: emptyByBucket(),
  };
  const cellIds: Record<ScoringVertical, Record<IndicatorWeightBucket, string[]>> = {
    banking: {} as Record<IndicatorWeightBucket, string[]>,
    insurance: {} as Record<IndicatorWeightBucket, string[]>,
  };
  for (const v of ALL_VERTICALS) {
    for (const b of ALL_INDICATOR_WEIGHT_BUCKETS) {
      cellIds[v][b] = [];
    }
  }

  // Per-vertical weight stats (accumulators).
  const weightStats: Record<
    ScoringVertical,
    { sum: number; min: number | null; max: number | null; count: number }
  > = {
    banking: { sum: 0, min: null, max: null, count: 0 },
    insurance: { sum: 0, min: null, max: null, count: 0 },
  };

  let total_indicators = 0;

  for (const [id, entry] of Object.entries(STUB_CATALOG)) {
    if (!ALL_VERTICALS.includes(entry.vertical)) continue;
    const bucket = classifyWeight(entry.weight);
    if (!bucket) continue;
    cellCounts[entry.vertical][bucket]++;
    cellIds[entry.vertical][bucket].push(id);
    const stats = weightStats[entry.vertical];
    stats.sum += entry.weight;
    stats.count++;
    if (stats.min === null || entry.weight < stats.min) stats.min = entry.weight;
    if (stats.max === null || entry.weight > stats.max) stats.max = entry.weight;
    total_indicators++;
  }

  // Per-row projections.
  const rows: IndicatorVerticalWeightRow[] = ALL_VERTICALS.map((v) => {
    const by_bucket = cellCounts[v];
    const total = ALL_INDICATOR_WEIGHT_BUCKETS.reduce(
      (acc, b) => acc + by_bucket[b],
      0,
    );
    const buckets_without = ALL_INDICATOR_WEIGHT_BUCKETS.filter(
      (b) => by_bucket[b] === 0,
    );
    const stats = weightStats[v];
    const mean_weight =
      stats.count === 0
        ? null
        : Math.round((stats.sum / stats.count) * 10000) / 10000;
    return {
      vertical: v,
      total,
      by_bucket: { ...by_bucket },
      buckets_without,
      mean_weight,
      min_weight: stats.min,
      max_weight: stats.max,
    };
  });

  // Per-column projections.
  const columns: IndicatorVerticalWeightColumn[] = ALL_INDICATOR_WEIGHT_BUCKETS.map(
    (b) => {
      const def = BUCKET_DEFS[b];
      const by_vertical = emptyByVertical();
      let total = 0;
      for (const v of ALL_VERTICALS) {
        by_vertical[v] = cellCounts[v][b];
        total += by_vertical[v];
      }
      const verticals_without = ALL_VERTICALS.filter(
        (v) => by_vertical[v] === 0,
      );
      return {
        bucket: b,
        label: def.label,
        min: def.min,
        max: def.max,
        max_inclusive: def.max_inclusive,
        total,
        by_vertical,
        verticals_without,
      };
    },
  );

  // peak_cell — highest count + canonical iteration tie-break.
  let peak_cell: IndicatorVerticalWeightPeakCell | null = null;
  let peakCount = 0;
  for (const v of ALL_VERTICALS) {
    for (const b of ALL_INDICATOR_WEIGHT_BUCKETS) {
      const c = cellCounts[v][b];
      if (c > peakCount) {
        peakCount = c;
        const ids = [...cellIds[v][b]].sort();
        peak_cell = {
          vertical: v,
          bucket: b,
          count: c,
          sample_indicator_ids: ids.slice(0, 5),
        };
      }
    }
  }
  if (peakCount === 0) peak_cell = null;

  // empty_cells — canonical vertical × bucket row-major order.
  const empty_cells: IndicatorVerticalWeightCell[] = [];
  for (const v of ALL_VERTICALS) {
    for (const b of ALL_INDICATOR_WEIGHT_BUCKETS) {
      if (cellCounts[v][b] === 0) {
        empty_cells.push({ vertical: v, bucket: b });
      }
    }
  }

  // most_diverse_vertical — vertical with most non-zero buckets.
  let most_diverse_vertical: ScoringVertical | null = null;
  let maxSpan = 0;
  for (const v of ALL_VERTICALS) {
    const span = ALL_INDICATOR_WEIGHT_BUCKETS.filter(
      (b) => cellCounts[v][b] > 0,
    ).length;
    if (span > maxSpan) {
      maxSpan = span;
      most_diverse_vertical = v;
    }
  }
  if (maxSpan === 0) most_diverse_vertical = null;

  // heaviest_vertical — vertical with highest count in `critical` bucket.
  let heaviest_vertical: ScoringVertical | null = null;
  let maxCritical = 0;
  for (const v of ALL_VERTICALS) {
    const c = cellCounts[v].critical;
    if (c > maxCritical) {
      maxCritical = c;
      heaviest_vertical = v;
    }
  }
  if (maxCritical === 0) heaviest_vertical = null;

  return {
    generated_at: now.toISOString(),
    total_indicators,
    total_verticals: ALL_VERTICALS.length,
    total_buckets: ALL_INDICATOR_WEIGHT_BUCKETS.length,
    rows,
    columns,
    peak_cell,
    empty_cells,
    most_diverse_vertical,
    heaviest_vertical,
  };
}
