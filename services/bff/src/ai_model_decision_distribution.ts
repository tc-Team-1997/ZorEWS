// ai_model_decision_distribution.ts
//
// T6 M7.20 — AI model decision score distribution.
// Analyzes the distribution of model scores across defined bands
// to surface concentration risk (e.g., 80% of accounts in Medium band
// may indicate poor model discrimination or threshold calibration).
// Mirror of M6.15 (preset inventory cross-tab) pattern for AI scoring surface.

// ─── Types ──────────────────────────────────────────────────────────────────

export type ScoreBand = 'very_low' | 'low' | 'medium' | 'high' | 'very_high';

export const ALL_SCORE_BANDS: readonly ScoreBand[] = [
  'very_low', 'low', 'medium', 'high', 'very_high',
];

export interface ScoreBandMeta {
  band:      ScoreBand;
  label:     string;
  min_score: number;
  max_score: number;
}

export const SCORE_BAND_META: Record<ScoreBand, ScoreBandMeta> = {
  very_low:  { band: 'very_low',  label: 'Very Low',  min_score: 0,   max_score: 20  },
  low:       { band: 'low',       label: 'Low',        min_score: 20,  max_score: 40  },
  medium:    { band: 'medium',    label: 'Medium',     min_score: 40,  max_score: 60  },
  high:      { band: 'high',      label: 'High',       min_score: 60,  max_score: 80  },
  very_high: { band: 'very_high', label: 'Very High',  min_score: 80,  max_score: 100 },
};

export interface BandResult {
  band:        ScoreBand;
  label:       string;
  min_score:   number;
  max_score:   number;
  count:       number;
  pct:         number;  // 0-1
  mean_score:  number | null;
}

export interface ModelDecisionDistribution {
  model_id:          string;
  tenant_id:         string;
  generated_at:      string;
  total_decisions:   number;
  bands:             BandResult[];  // 5 in canonical order
  mean_score:        number | null;
  median_score:      number | null;
  std_dev:           number | null;
  discrimination_index: number | null;  // Gini-like: 0=random, 1=perfect separation
  peak_band:         ScoreBand | null;
  peak_band_pct:     number | null;
  concentration_warning: boolean;  // true if > 50% in a single non-extreme band
  by_outcome: {
    action_taken:  number;
    escalated:     number;
    auto_approved: number;
  };
}

// ─── PRNG ────────────────────────────────────────────────────────────────────

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

// ─── Score → band ────────────────────────────────────────────────────────────

export function bandForScore(score: number): ScoreBand {
  if (score < 20) return 'very_low';
  if (score < 40) return 'low';
  if (score < 60) return 'medium';
  if (score < 80) return 'high';
  return 'very_high';
}

// ─── Gini-like discrimination index ─────────────────────────────────────────

function discriminationIndex(scores: number[]): number | null {
  if (scores.length < 2) return null;
  const sorted = [...scores].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  if (mean === 0) return 0;
  let giniNum = 0;
  for (let i = 0; i < n; i++) giniNum += (2 * (i + 1) - n - 1) * sorted[i]!;
  return Math.round(Math.min(1, Math.max(0, giniNum / (n * n * mean))) * 1000) / 1000;
}

// ─── Std dev ─────────────────────────────────────────────────────────────────

function stdDev(scores: number[]): number | null {
  if (scores.length < 2) return null;
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / (scores.length - 1);
  return Math.round(Math.sqrt(variance) * 100) / 100;
}

// ─── Main function ────────────────────────────────────────────────────────────

export function buildModelDecisionDistribution(
  model_id: string,
  tenant_id: string,
  sample_count: number,
  now: Date,
): ModelDecisionDistribution {
  const generated_at = now.toISOString();
  const dayKey = now.toISOString().slice(0, 10);
  const r = mulberry32(fnv1a(`mdd:${tenant_id}:${model_id}:${dayKey}`));

  if (sample_count === 0) {
    const emptyBands: BandResult[] = ALL_SCORE_BANDS.map(b => ({
      ...SCORE_BAND_META[b], count: 0, pct: 0, mean_score: null,
    }));
    return {
      model_id, tenant_id, generated_at, total_decisions: 0,
      bands: emptyBands, mean_score: null, median_score: null, std_dev: null,
      discrimination_index: null, peak_band: null, peak_band_pct: null,
      concentration_warning: false,
      by_outcome: { action_taken: 0, escalated: 0, auto_approved: 0 },
    };
  }

  // Synthesize score distribution biased toward medium (realistic)
  const scores: number[] = Array.from({ length: Math.min(sample_count, 500) }, () => {
    // Beta-like distribution centered around 40-60
    const u = r(); const v = r();
    const norm = Math.sqrt(-2 * Math.log(Math.max(u, 1e-10))) * Math.cos(2 * Math.PI * v);
    return Math.max(0, Math.min(100, 50 + norm * 18));
  });

  const bandCounts: Record<ScoreBand, number> = { very_low: 0, low: 0, medium: 0, high: 0, very_high: 0 };
  const bandScores: Record<ScoreBand, number[]> = { very_low: [], low: [], medium: [], high: [], very_high: [] };
  for (const s of scores) {
    const b = bandForScore(s);
    bandCounts[b]++;
    bandScores[b].push(s);
  }

  const total = scores.length;
  const sortedScores = [...scores].sort((a, b) => a - b);
  const mid = Math.floor(sortedScores.length / 2);
  const median = sortedScores.length % 2 === 0
    ? Math.round(((sortedScores[mid - 1]! + sortedScores[mid]!) / 2) * 100) / 100
    : sortedScores[mid]!;

  let peakBand: ScoreBand | null = null;
  let peakCount = 0;
  for (const b of ALL_SCORE_BANDS) {
    if (bandCounts[b] > peakCount) { peakBand = b; peakCount = bandCounts[b]; }
  }

  const bands: BandResult[] = ALL_SCORE_BANDS.map(b => ({
    ...SCORE_BAND_META[b],
    count:      bandCounts[b],
    pct:        Math.round((bandCounts[b] / total) * 1000) / 1000,
    mean_score: bandScores[b].length > 0
      ? Math.round(bandScores[b].reduce((s, v) => s + v, 0) / bandScores[b].length * 100) / 100
      : null,
  }));

  const meanScore = Math.round(scores.reduce((s, v) => s + v, 0) / total * 100) / 100;
  const concentrationWarning = peakBand !== null
    && peakBand !== 'very_low' && peakBand !== 'very_high'
    && peakCount / total > 0.5;

  const byOutcome = {
    action_taken:  Math.round(r() * total * 0.15),
    escalated:     Math.round(r() * total * 0.05),
    auto_approved: Math.round(r() * total * 0.70),
  };

  return {
    model_id, tenant_id, generated_at, total_decisions: sample_count,
    bands,
    mean_score:   meanScore,
    median_score: median,
    std_dev:      stdDev(scores),
    discrimination_index: discriminationIndex(scores),
    peak_band:     peakBand,
    peak_band_pct: peakBand ? Math.round((peakCount / total) * 1000) / 1000 : null,
    concentration_warning: concentrationWarning,
    by_outcome:   byOutcome,
  };
}
