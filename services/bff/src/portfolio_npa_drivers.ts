// services/bff/src/portfolio_npa_drivers.ts
//
// M7.19 — Portfolio-level NPA driver aggregation.
//
// `GET /v1/banking/npa/portfolio-drivers?horizon=N` aggregates SHAP-style
// feature importance ACROSS every high-risk NPA prediction in the
// current horizon. M7.x ships per-customer explanations
// (banking_npa_prediction.ts → explainNpaPrediction); M7.19 lands the
// PORTFOLIO-level rollup so the CRO can ask "across our 63 high-risk
// accounts, what's driving the risk?" instead of clicking 63 Why-modals.
//
// Pure-function composition over the M7 surface:
//   buildNpaHighRisk(tenant, horizon, now) → rows[]
//   explainNpaPrediction(tenant, prediction_id, now) → per-prediction why
//   summarizePortfolioNpaDrivers — pivot by feature_name across all rows
//
// Per-driver row carries:
//   feature_name, display_name, total_contribution (Σ |weight| across
//   predictions where feature appeared), affected_predictions (count),
//   avg_weight (Σ signed weight / affected count), direction_split
//   (up vs down count), by_sector (Record<sector, count>), pct_of_total
//   (this feature's |weight| share of overall portfolio weight pool).
//
// Envelope ranks features by total_contribution desc with feature_name
// asc tie-break. Mirror of M11.11 / M5.16 / M3.13 / M14.27 1D pivot
// pattern, applied to the AI explainability surface.

import { buildNpaHighRisk, explainNpaPrediction, isNpaHorizon } from './banking_npa_prediction';
import type { NpaHorizon, NpaPredictionExplanation } from './banking_npa_prediction';

export class PortfolioDriversError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PortfolioDriversError';
  }
}

export interface PortfolioDriverRow {
  feature_name: string;
  total_contribution: number;        // Σ |weight| across affected predictions (signed magnitude sum)
  affected_predictions: number;      // distinct predictions where this feature appeared in top_features
  avg_weight: number;                // Σ signed weight / affected_predictions
  direction_split: { up: number; down: number };
  by_sector: Record<string, number>; // sector → count of affected predictions
  pct_of_total: number;              // |total_contribution| / Σ all features' |total_contribution|; rounded 4 decimals
}

export interface PortfolioDriverReport {
  tenant_id: string;
  generated_at: string;
  horizon_days: NpaHorizon;
  total_predictions_analyzed: number;   // == buildNpaHighRisk(...).total_high_risk
  total_drivers: number;                // distinct feature_name values
  drivers: PortfolioDriverRow[];        // sorted total_contribution desc + feature_name asc tie-break
  most_universal_driver: { feature_name: string; affected_predictions: number } | null;
}

const MAX_DRIVERS = 20;
const HARD_HIGH_RISK_CAP = 200; // protect from very large explain-loop runtime

export function summarizePortfolioNpaDrivers(
  tenant_id: string,
  horizon: NpaHorizon,
  now: Date,
): PortfolioDriverReport {
  if (!tenant_id) throw new PortfolioDriversError('invalid_input', 'tenant_id required');
  if (!isNpaHorizon(horizon))
    throw new PortfolioDriversError('invalid_horizon', `horizon must be 30/60/90/180`);

  // 1. Pull the high-risk cohort (already deterministic + tenant-scoped).
  const cohort = buildNpaHighRisk(tenant_id, horizon, now);
  const rowsToScan = cohort.rows.slice(0, HARD_HIGH_RISK_CAP);

  // 2. For each prediction, walk its top_features and accumulate.
  type Accumulator = {
    total_abs_weight: number;
    signed_sum: number;
    affected: Set<string>;
    up_count: number;
    down_count: number;
    by_sector: Map<string, number>;
  };
  const acc = new Map<string, Accumulator>();

  for (const row of rowsToScan) {
    const explanation: NpaPredictionExplanation = explainNpaPrediction(
      tenant_id,
      row.prediction_id,
      now,
    );
    for (const feat of explanation.top_features) {
      let bucket = acc.get(feat.feature_name);
      if (!bucket) {
        bucket = {
          total_abs_weight: 0,
          signed_sum: 0,
          affected: new Set(),
          up_count: 0,
          down_count: 0,
          by_sector: new Map(),
        };
        acc.set(feat.feature_name, bucket);
      }
      bucket.total_abs_weight += Math.abs(feat.weight);
      bucket.signed_sum += feat.weight;
      bucket.affected.add(row.prediction_id);
      if (feat.direction === 'up') bucket.up_count++;
      else bucket.down_count++;
      const sec = row.sector;
      bucket.by_sector.set(sec, (bucket.by_sector.get(sec) ?? 0) + 1);
    }
  }

  // 3. Compute pct_of_total denominator (Σ all features' |total_contribution|).
  let grand_total_abs = 0;
  for (const v of acc.values()) grand_total_abs += v.total_abs_weight;

  // 4. Materialise rows.
  const drivers: PortfolioDriverRow[] = [];
  acc.forEach((v, feature_name) => {
    const affected = v.affected.size;
    const by_sector: Record<string, number> = {};
    v.by_sector.forEach((count, sec) => (by_sector[sec] = count));
    drivers.push({
      feature_name,
      total_contribution: Math.round(v.total_abs_weight * 10000) / 10000,
      affected_predictions: affected,
      avg_weight: affected === 0 ? 0 : Math.round((v.signed_sum / affected) * 10000) / 10000,
      direction_split: { up: v.up_count, down: v.down_count },
      by_sector,
      pct_of_total:
        grand_total_abs === 0
          ? 0
          : Math.round((v.total_abs_weight / grand_total_abs) * 10000) / 10000,
    });
  });

  // 5. Sort: total_contribution desc, then feature_name asc.
  drivers.sort((a, b) =>
    b.total_contribution - a.total_contribution || a.feature_name.localeCompare(b.feature_name),
  );

  // 6. Most-universal driver = max affected_predictions; tie-break feature_name asc
  let mostUniversal: PortfolioDriverRow | null = null;
  for (const d of drivers) {
    if (
      !mostUniversal ||
      d.affected_predictions > mostUniversal.affected_predictions ||
      (d.affected_predictions === mostUniversal.affected_predictions &&
        d.feature_name < mostUniversal.feature_name)
    ) {
      mostUniversal = d;
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    horizon_days: horizon,
    total_predictions_analyzed: rowsToScan.length,
    total_drivers: drivers.length,
    drivers: drivers.slice(0, MAX_DRIVERS),
    most_universal_driver: mostUniversal
      ? { feature_name: mostUniversal.feature_name, affected_predictions: mostUniversal.affected_predictions }
      : null,
  };
}
