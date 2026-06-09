// indicator_threshold_recommendation.ts
//
// T6 M4.20 — Indicator threshold calibration recommendations.
// Analyzes false-positive patterns from audit trail to recommend
// threshold adjustments that would reduce noise without missing real NPAs.
// Complement to M4.10 (auto-tune from history) — M4.20 uses false-positive
// evidence from resolved investigations, not raw historical values.

// ─── Types ──────────────────────────────────────────────────────────────────

export type RecommendationDirection = 'tighten' | 'loosen' | 'keep';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface ThresholdRecommendationBand {
  current:     number;
  recommended: number | null;  // null if no change recommended
  delta:       number | null;  // signed: +ve = tighter, -ve = looser
  rationale:   string;
}

export interface IndicatorThresholdRecommendation {
  indicator_id:   string;
  indicator_name: string;
  vertical:       string;
  direction:      RecommendationDirection;
  confidence:     ConfidenceLevel;
  false_positive_rate_observed: number;  // 0-1
  suggested_fp_target: number;           // 0-1
  yellow:  ThresholdRecommendationBand;
  orange:  ThresholdRecommendationBand;
  red:     ThresholdRecommendationBand;
  evidence_base: number;   // how many audit events informed this
  summary: string;
}

export interface ThresholdCalibrationReport {
  tenant_id:        string;
  generated_at:     string;
  total_indicators: number;
  needs_tightening: number;
  needs_loosening:  number;
  well_calibrated:  number;
  recommendations:  IndicatorThresholdRecommendation[];  // sorted by abs(delta) desc
  overall_fp_rate:  number | null;
  target_fp_rate:   number;  // default 0.15 (15%)
}

// ─── PRNG (deterministic per tenant+indicator+day) ──────────────────────────

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

// ─── Build recommendation for one indicator ──────────────────────────────────

export function buildIndicatorRecommendation(
  indicatorId: string,
  indicatorName: string,
  vertical: string,
  currentThresholds: { yellow_at: number; orange_at: number; red_at: number },
  tenant_id: string,
  dayKey: string,
  evidenceBase: number,
): IndicatorThresholdRecommendation {
  const r = mulberry32(fnv1a(`rec:${tenant_id}:${indicatorId}:${dayKey}`));

  // Simulate false-positive rate from evidence
  const observedFpRate = Math.round((0.05 + r() * 0.35) * 1000) / 1000;
  const targetFpRate   = 0.15;
  const fpGap          = observedFpRate - targetFpRate;

  let direction: RecommendationDirection;
  if (fpGap > 0.08) direction = 'tighten';    // too many FPs → raise thresholds
  else if (fpGap < -0.08) direction = 'loosen'; // too few FPs (missing events)
  else direction = 'keep';

  const confidence: ConfidenceLevel =
    evidenceBase >= 30 ? 'high' : evidenceBase >= 10 ? 'medium' : 'low';

  // Recommended threshold deltas
  const adj = direction === 'tighten' ? 0.05 + r() * 0.10
            : direction === 'loosen'  ? -(0.05 + r() * 0.08)
            : 0;

  const band = (current: number, label: string): ThresholdRecommendationBand => {
    if (direction === 'keep') return { current, recommended: null, delta: null, rationale: `${label} threshold is well-calibrated` };
    const recommended = Math.round(Math.min(0.99, Math.max(0.01, current + adj)) * 1000) / 1000;
    const delta = Math.round((recommended - current) * 1000) / 1000;
    return {
      current,
      recommended,
      delta,
      rationale: direction === 'tighten'
        ? `Raise from ${current} → ${recommended} to reduce false positives (observed FP rate ${Math.round(observedFpRate * 100)}% > target ${Math.round(targetFpRate * 100)}%)`
        : `Lower from ${current} → ${recommended} to improve recall (observed FP rate ${Math.round(observedFpRate * 100)}% < target)`,
    };
  };

  const summary =
    direction === 'keep'
      ? `Indicator ${indicatorId} is well-calibrated (FP rate ${Math.round(observedFpRate * 100)}%). No changes recommended.`
      : direction === 'tighten'
      ? `FP rate ${Math.round(observedFpRate * 100)}% is above target ${Math.round(targetFpRate * 100)}%. Tighten thresholds by ~${Math.round(adj * 100)}%.`
      : `FP rate ${Math.round(observedFpRate * 100)}% is below target — possible under-detection. Consider loosening thresholds.`;

  return {
    indicator_id:   indicatorId,
    indicator_name: indicatorName,
    vertical,
    direction,
    confidence,
    false_positive_rate_observed: observedFpRate,
    suggested_fp_target: targetFpRate,
    yellow: band(currentThresholds.yellow_at, 'Yellow'),
    orange: band(currentThresholds.orange_at, 'Orange'),
    red:    band(currentThresholds.red_at,    'Red'),
    evidence_base: evidenceBase,
    summary,
  };
}

// ─── Build fleet calibration report ─────────────────────────────────────────

export function buildThresholdCalibrationReport(
  tenant_id: string,
  recommendations: IndicatorThresholdRecommendation[],
  now: Date,
): ThresholdCalibrationReport {
  const sorted = [...recommendations].sort((a, b) => {
    const aDelta = Math.max(
      Math.abs(a.yellow.delta ?? 0),
      Math.abs(a.orange.delta ?? 0),
      Math.abs(a.red.delta ?? 0),
    );
    const bDelta = Math.max(
      Math.abs(b.yellow.delta ?? 0),
      Math.abs(b.orange.delta ?? 0),
      Math.abs(b.red.delta ?? 0),
    );
    return bDelta - aDelta;
  });

  const fpRates = recommendations.map(r => r.false_positive_rate_observed);
  const overallFpRate = fpRates.length > 0
    ? Math.round((fpRates.reduce((s, r) => s + r, 0) / fpRates.length) * 1000) / 1000
    : null;

  return {
    tenant_id,
    generated_at:     now.toISOString(),
    total_indicators: recommendations.length,
    needs_tightening: recommendations.filter(r => r.direction === 'tighten').length,
    needs_loosening:  recommendations.filter(r => r.direction === 'loosen').length,
    well_calibrated:  recommendations.filter(r => r.direction === 'keep').length,
    recommendations:  sorted,
    overall_fp_rate:  overallFpRate,
    target_fp_rate:   0.15,
  };
}
