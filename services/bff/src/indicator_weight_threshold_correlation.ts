// services/bff/src/indicator_weight_threshold_correlation.ts
//
// T6 M4.21 — Indicator weight vs threshold correlation.
//
// Combines the M6.2 STUB_CATALOG (severity_weight per indicator) with
// the M4.3 listThresholds() (red_at / orange_at / yellow_at) to surface
// how an indicator's weight aligns with its breach threshold settings.
//
// `red_at_weight_product = weight * red_at` — indicators with a high
// product are the "double-dangerous" signals: heavy weight + low trigger.
//
// Risk band classification:
//   high_weight_low_threshold  : weight > 0.7 AND red_at < 0.7
//   low_weight_high_threshold  : weight < 0.3 AND red_at > 0.7
//   balanced                   : everything else with both values present
//   unknown                    : indicator appears in only one table
//
// Route: GET /v1/indicators/weight-threshold-correlation
//   RBAC: audit:read (admin-only)
//   Platform-static. Mounted BEFORE /thresholds routes.

import { STUB_CATALOG } from './bil_scoring_v2';
import { listThresholds } from './indicator_thresholds';

// ─── Public types ──────────────────────────────────────────────────────

export type WeightThresholdRiskBand =
  | 'high_weight_low_threshold'
  | 'low_weight_high_threshold'
  | 'balanced'
  | 'unknown';

export interface WeightThresholdEntry {
  indicator_id: string;
  name: string;
  vertical: string;
  weight: number;
  red_at: number;
  orange_at: number;
  yellow_at: number;
  /** weight * red_at — higher = heavier combined severity signal. */
  red_at_weight_product: number;
  /** 1-based rank: 1 = highest product, n = lowest. */
  severity_weight_rank: number;
  risk_band: WeightThresholdRiskBand;
}

export interface IndicatorWeightThresholdCorrelation {
  generated_at: string;
  /** Indicators that exist in both STUB_CATALOG and listThresholds(). */
  total_indicators_with_both: number;
  /** Sorted by red_at_weight_product desc. */
  entries: WeightThresholdEntry[];
  high_weight_low_threshold_count: number;
  low_weight_high_threshold_count: number;
  balanced_count: number;
}

// ─── Thresholds ────────────────────────────────────────────────────────

const HIGH_WEIGHT = 0.7;
const LOW_WEIGHT  = 0.3;
const LOW_THRESHOLD  = 0.7;
const HIGH_THRESHOLD = 0.7;

// ─── Implementation ─────────────────────────────────────────────────────

export function buildWeightThresholdCorrelation(
  now: Date,
): IndicatorWeightThresholdCorrelation {
  const generated_at = now.toISOString();
  const thresholds = listThresholds();

  // Build a lookup: indicator_id → threshold
  const thresholdMap = new Map(thresholds.map(t => [t.indicator_id, t]));

  const raw: Omit<WeightThresholdEntry, 'severity_weight_rank'>[] = [];

  for (const [indicator_id, catalogEntry] of Object.entries(STUB_CATALOG)) {
    const threshold = thresholdMap.get(indicator_id);
    if (!threshold) continue;

    const weight = catalogEntry.weight;
    const red_at = threshold.red_at;
    const orange_at = threshold.orange_at;
    const yellow_at = threshold.yellow_at;
    const red_at_weight_product =
      Math.round(weight * red_at * 1e6) / 1e6;

    let risk_band: WeightThresholdRiskBand;
    if (weight > HIGH_WEIGHT && red_at < LOW_THRESHOLD) {
      risk_band = 'high_weight_low_threshold';
    } else if (weight < LOW_WEIGHT && red_at > HIGH_THRESHOLD) {
      risk_band = 'low_weight_high_threshold';
    } else {
      risk_band = 'balanced';
    }

    raw.push({
      indicator_id,
      name: catalogEntry.name,
      vertical: catalogEntry.vertical,
      weight,
      red_at,
      orange_at,
      yellow_at,
      red_at_weight_product,
      risk_band,
    });
  }

  // Sort by product desc
  raw.sort((a, b) => b.red_at_weight_product - a.red_at_weight_product);

  // Assign severity_weight_rank (1-based)
  const entries: WeightThresholdEntry[] = raw.map((e, i) => ({
    ...e,
    severity_weight_rank: i + 1,
  }));

  const high_weight_low_threshold_count = entries.filter(
    e => e.risk_band === 'high_weight_low_threshold',
  ).length;
  const low_weight_high_threshold_count = entries.filter(
    e => e.risk_band === 'low_weight_high_threshold',
  ).length;
  const balanced_count = entries.filter(
    e => e.risk_band === 'balanced',
  ).length;

  return {
    generated_at,
    total_indicators_with_both: entries.length,
    entries,
    high_weight_low_threshold_count,
    low_weight_high_threshold_count,
    balanced_count,
  };
}
