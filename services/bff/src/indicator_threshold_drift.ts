// services/bff/src/indicator_threshold_drift.ts
//
// T6 M4.12 — Indicator threshold drift analytics.
//
// M4.3 ships per-indicator library thresholds; M4.4 ships per-
// tenant overrides; M4.9 returns the effective view with source
// annotation; M4.10 suggests thresholds from history. M4.12 ships
// the DRIFT METRIC: for each tenant override, measure how far each
// of the 3 band values (yellow_at / orange_at / red_at) sits from
// the library default + roll up to a single per-indicator drift
// score.
//
// Lets the SPA rank "which thresholds did ops customise most
// aggressively?" — useful for periodic threshold review + alert
// flood post-mortems ("why is yellow firing more often this
// quarter? — because someone dropped yellow_at by 40%").
//
// Pure resolver over the M4.4 override store + M4.3 library.

import {
  getThreshold,
  type IndicatorThreshold,
  type ThresholdOverrideStore,
} from './indicator_thresholds';

// ─── Public types ─────────────────────────────────────────────────────

export interface BandDelta {
  /** Library default value for this band. */
  default_value: number;
  /** Tenant override value. */
  effective_value: number;
  /** effective_value - default_value (signed). */
  delta_abs: number;
  /** |delta_abs| / |default_value|; null when default_value=0 (avoids
   *  divide-by-zero). 0.5 means the override is 50% off the default. */
  delta_rel: number | null;
}

export interface IndicatorDriftRow {
  indicator_id: string;
  name: string;
  vertical: IndicatorThreshold['vertical'];
  yellow: BandDelta;
  orange: BandDelta;
  red: BandDelta;
  /** Mean of |delta_rel| across the 3 bands, omitting null entries.
   *  null only when every band has null delta_rel (every default=0,
   *  which shouldn't happen for declared thresholds). 0 = no change. */
  drift_score: number | null;
  /** Largest |delta_rel| across the 3 bands (peak drift). null when
   *  every band is null. */
  peak_band_drift: number | null;
  /** The band with peak_band_drift. null when peak_band_drift is null. */
  peak_band: 'yellow' | 'orange' | 'red' | null;
}

export interface ThresholdDriftSummary {
  tenant_id: string;
  generated_at: string;
  total_overrides: number;
  /** Of total_overrides, how many have a non-zero drift_score (i.e.
   *  at least one band actually differs). */
  total_with_drift: number;
  /** Of total_overrides, how many have drift_score=0 (override exists
   *  but every band equals the default — operationally a redundant
   *  override that could be cleared). */
  total_zero_drift: number;
  /** Mean drift_score across overrides with non-null drift_score.
   *  null when total_overrides=0 OR every drift_score is null. */
  mean_drift_score: number | null;
  /** Indicator with the highest drift_score. Ties broken by
   *  indicator_id asc. null when no overrides. */
  most_drifted_indicator: {
    indicator_id: string;
    name: string;
    drift_score: number;
  } | null;
  /** Per-indicator rows sorted by drift_score desc (nulls last) with
   *  indicator_id asc tie-break. */
  indicators: IndicatorDriftRow[];
}

// ─── Pure resolver ────────────────────────────────────────────────────

function buildBand(def: number, eff: number): BandDelta {
  const delta_abs = eff - def;
  const delta_rel = def === 0 ? null : Math.abs(delta_abs) / Math.abs(def);
  return { default_value: def, effective_value: eff, delta_abs, delta_rel };
}

function meanNonNull(values: Array<number | null>): number | null {
  const filtered = values.filter((v): v is number => v !== null);
  if (filtered.length === 0) return null;
  const sum = filtered.reduce((a, b) => a + b, 0);
  return sum / filtered.length;
}

function pickPeak(
  yellow: BandDelta,
  orange: BandDelta,
  red: BandDelta,
): { peak_band_drift: number | null; peak_band: 'yellow' | 'orange' | 'red' | null } {
  const candidates: Array<{ band: 'yellow' | 'orange' | 'red'; rel: number }> = [];
  if (yellow.delta_rel !== null) candidates.push({ band: 'yellow', rel: yellow.delta_rel });
  if (orange.delta_rel !== null) candidates.push({ band: 'orange', rel: orange.delta_rel });
  if (red.delta_rel !== null) candidates.push({ band: 'red', rel: red.delta_rel });
  if (candidates.length === 0) return { peak_band_drift: null, peak_band: null };
  candidates.sort((a, b) => b.rel - a.rel);
  return { peak_band_drift: candidates[0]!.rel, peak_band: candidates[0]!.band };
}

function buildRow(override: IndicatorThreshold): IndicatorDriftRow | null {
  const lib = getThreshold(override.indicator_id);
  if (!lib) return null; // orphan override — indicator no longer in catalog
  const yellow = buildBand(lib.yellow_at, override.yellow_at);
  const orange = buildBand(lib.orange_at, override.orange_at);
  const red = buildBand(lib.red_at, override.red_at);
  const drift_score = meanNonNull([yellow.delta_rel, orange.delta_rel, red.delta_rel]);
  const { peak_band_drift, peak_band } = pickPeak(yellow, orange, red);
  return {
    indicator_id: override.indicator_id,
    name: override.name,
    vertical: override.vertical,
    yellow,
    orange,
    red,
    drift_score,
    peak_band_drift,
    peak_band,
  };
}

export function buildIndicatorThresholdDrift(
  store: ThresholdOverrideStore,
  tenant_id: string,
  now: Date,
): ThresholdDriftSummary {
  const overrides = store.listOverrides(tenant_id);
  const rows: IndicatorDriftRow[] = [];
  for (const ov of overrides) {
    const row = buildRow(ov);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => {
    const av = a.drift_score ?? -Infinity;
    const bv = b.drift_score ?? -Infinity;
    if (av !== bv) return bv - av;
    return a.indicator_id.localeCompare(b.indicator_id);
  });

  const total_overrides = rows.length;
  let total_with_drift = 0;
  let total_zero_drift = 0;
  for (const r of rows) {
    if (r.drift_score === null) continue;
    if (r.drift_score > 0) total_with_drift++;
    else if (r.drift_score === 0) total_zero_drift++;
  }
  const mean_drift_score = meanNonNull(rows.map((r) => r.drift_score));

  let most_drifted_indicator: ThresholdDriftSummary['most_drifted_indicator'] = null;
  for (const r of rows) {
    if (r.drift_score === null) continue;
    if (!most_drifted_indicator || r.drift_score > most_drifted_indicator.drift_score) {
      most_drifted_indicator = {
        indicator_id: r.indicator_id,
        name: r.name,
        drift_score: r.drift_score,
      };
    }
    // Iteration order is sorted drift_score desc + id asc → ties auto-
    // resolve to first-seen (matches documented tie-break rule).
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_overrides,
    total_with_drift,
    total_zero_drift,
    mean_drift_score,
    most_drifted_indicator,
    indicators: rows,
  };
}
