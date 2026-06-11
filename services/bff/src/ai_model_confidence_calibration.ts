// services/bff/src/ai_model_confidence_calibration.ts
//
// T6 M7.23 — AI model confidence calibration analysis.
//
// Simulates a calibration curve: for each probability bucket (0-10%,
// 10-20%, …, 90-100%), what % of predictions in that bucket actually
// defaulted (observed_rate). Perfect calibration = observed_rate equals
// predicted midpoint.

// ─── Public types ──────────────────────────────────────────────────────

export interface CalibrationBucket {
  predicted_range: string;
  count: number;
  predicted_midpoint: number;
  observed_rate: number;
  calibration_error: number;
}

export interface ModelConfidenceCalibration {
  model_id: string;
  tenant_id: string;
  generated_at: string;
  calibration_error: number;
  calibration_buckets: CalibrationBucket[];
  is_well_calibrated: boolean;
  overconfident_buckets: number;
  underconfident_buckets: number;
}

// ─── Deterministic RNG helpers ──────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = ((h * 0x01000193) ^ 0) >>> 0;
  }
  return h;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = t ^ (t >>> 15);
    t = (t * (t | 1)) | 0;
    t = t ^ (t + ((t ^ (t >>> 7)) * (t | 61)));
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// ─── Pure function ─────────────────────────────────────────────────────

export function buildModelConfidenceCalibration(
  model_id: string,
  tenant_id: string,
  now: Date,
): ModelConfidenceCalibration {
  const generated_at = now.toISOString();
  const dayKey = now.toISOString().slice(0, 10);
  const seed = fnv1a(`${tenant_id}|${model_id}|calibration|${dayKey}`);
  const rng = mulberry32(seed);

  const BUCKETS = 10;
  const calibration_buckets: CalibrationBucket[] = [];
  let total_error = 0;
  let overconfident_buckets = 0;
  let underconfident_buckets = 0;

  for (let i = 0; i < BUCKETS; i++) {
    const low = i / BUCKETS;
    const high = (i + 1) / BUCKETS;
    const predicted_midpoint = (low + high) / 2;

    // Synthetic count: 50-200 predictions per bucket
    const count = 50 + Math.floor(rng() * 150);

    // Observed rate: close to predicted midpoint with some calibration error
    // Slightly miscalibrated model for realism
    const noise = (rng() - 0.5) * 0.12;
    const observed_rate = Math.max(0, Math.min(1, predicted_midpoint + noise));

    const calibration_error = Math.abs(predicted_midpoint - observed_rate);

    calibration_buckets.push({
      predicted_range: `${(low * 100).toFixed(0)}-${(high * 100).toFixed(0)}%`,
      count,
      predicted_midpoint: Math.round(predicted_midpoint * 1000) / 1000,
      observed_rate: Math.round(observed_rate * 1000) / 1000,
      calibration_error: Math.round(calibration_error * 1000) / 1000,
    });

    total_error += calibration_error;

    if (predicted_midpoint > observed_rate + 0.02) overconfident_buckets++;
    else if (observed_rate > predicted_midpoint + 0.02) underconfident_buckets++;
  }

  const calibration_error = Math.round((total_error / BUCKETS) * 10000) / 10000;
  const is_well_calibrated = calibration_error < 0.05;

  return {
    model_id,
    tenant_id,
    generated_at,
    calibration_error,
    calibration_buckets,
    is_well_calibrated,
    overconfident_buckets,
    underconfident_buckets,
  };
}
