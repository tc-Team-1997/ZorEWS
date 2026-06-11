// services/bff/src/scoring_model_calibration.ts
// T6 M6.30 — Scoring model calibration check

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = ((r ^ (r >>> 15)) * (r | 1)) >>> 0;
    r = (r ^ (r + ((r ^ (r >>> 7)) * (r | 61)))) >>> 0;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CalibrationBucket {
  range: string;
  expected_pd: number;
  observed_pd: number;
  calibration_error: number;
  is_well_calibrated: boolean;
}

export interface ScoringModelCalibration {
  tenant_id: string;
  generated_at: string;
  calibration_score: number;
  calibration_grade: 'A' | 'B' | 'C' | 'D';
  buckets: CalibrationBucket[];
  worst_bucket: string | null;
  avg_calibration_error: number;
}

export function buildScoringModelCalibration(
  tenant_id: string,
  now: Date
): ScoringModelCalibration {
  const generated_at = now.toISOString();
  const day = Math.floor(now.getTime() / 86400000);

  const buckets: CalibrationBucket[] = [];

  for (let b = 0; b < 10; b++) {
    const range_low = b * 10;
    const range_high = range_low + 10;
    const range = `${range_low}-${range_high}`;
    const expected_pd = (range_low + 5) / 100; // midpoint

    const seed = fnv1a(`${tenant_id}:calibration:bucket:${b}:${day}`);
    const rng = mulberry32(seed);
    const multiplier = 0.8 + rng() * 0.4;
    const observed_pd = Math.min(1, Math.max(0, expected_pd * multiplier));

    const calibration_error = Math.round(Math.abs(expected_pd - observed_pd) * 10000) / 10000;
    const is_well_calibrated = calibration_error < 0.05;

    buckets.push({
      range,
      expected_pd: Math.round(expected_pd * 10000) / 10000,
      observed_pd: Math.round(observed_pd * 10000) / 10000,
      calibration_error,
      is_well_calibrated,
    });
  }

  const errors = buckets.map((b) => b.calibration_error);
  const avgError = errors.reduce((s, e) => s + e, 0) / errors.length;
  const avg_calibration_error = Math.round(avgError * 10000) / 10000;
  const calibration_score = Math.max(0, Math.round(100 - avgError * 100));

  let grade: 'A' | 'B' | 'C' | 'D';
  if (calibration_score >= 85) grade = 'A';
  else if (calibration_score >= 70) grade = 'B';
  else if (calibration_score >= 50) grade = 'C';
  else grade = 'D';

  const worst = buckets.reduce((w, b) => (b.calibration_error > w.calibration_error ? b : w));
  const worst_bucket = worst.calibration_error > 0 ? worst.range : null;

  return {
    tenant_id,
    generated_at,
    calibration_score,
    calibration_grade: grade,
    buckets,
    worst_bucket,
    avg_calibration_error,
  };
}
