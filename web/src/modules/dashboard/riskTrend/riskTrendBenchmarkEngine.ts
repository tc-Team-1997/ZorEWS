// web/src/modules/dashboard/riskTrend/riskTrendBenchmarkEngine.ts
//
// Pure-TypeScript benchmark comparison engine.
// Uses FNV-1a + mulberry32 (no Math.imul) for deterministic synthesis.

import type { BenchmarkPeriod } from './riskTrendConfigurationEngine';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BenchmarkDataPoint {
  date: string;
  current: number;
  benchmark: number;
  delta: number;
}

// ─── Deterministic RNG (no Math.imul) ─────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = ((r ^ (r >>> 15)) * (r | 1)) >>> 0;
    r = (r ^ (r + ((r ^ (r >>> 7)) * (r | 61)))) >>> 0;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── Main API ─────────────────────────────────────────────────────────────────

/**
 * Generate a paired current + benchmark series of `days` data points.
 * The seed string controls the deterministic output so the same call
 * always produces the same numbers (stable chart preview).
 */
export function generateBenchmarkSeries(
  period: BenchmarkPeriod,
  days: number,
  seed: string,
): BenchmarkDataPoint[] {
  const rng = mulberry32(fnv1a(seed + period));

  // Offset factor — how much higher/lower benchmark is vs current
  const offsets: Record<BenchmarkPeriod, number> = {
    previous_period:   0.05,
    previous_month:    0.08,
    previous_quarter:  0.12,
    previous_year:     0.20,
    industry_benchmark: 0.30,
    peer_institutions:  0.15,
  };
  const offset = offsets[period] ?? 0.10;

  const today = new Date();
  const results: BenchmarkDataPoint[] = [];

  let currentBase = 40 + rng() * 40;   // baseline current 40-80
  let benchBase   = currentBase * (1 + offset);

  for (let i = 0; i < days; i++) {
    const date = isoDate(addDays(today, -(days - 1 - i)));

    // Gentle random walk
    currentBase = Math.max(5, currentBase + (rng() - 0.48) * 8);
    benchBase   = Math.max(5, benchBase   + (rng() - 0.52) * 6);

    const current   = Math.round(currentBase);
    const benchmark = Math.round(benchBase);
    results.push({ date, current, benchmark, delta: current - benchmark });
  }

  return results;
}

/**
 * Human-readable label for a benchmark period.
 */
export function getBenchmarkLabel(period: BenchmarkPeriod): string {
  const labels: Record<BenchmarkPeriod, string> = {
    previous_period:    'vs Previous Period',
    previous_month:     'vs Previous Month',
    previous_quarter:   'vs Previous Quarter',
    previous_year:      'vs Previous Year',
    industry_benchmark: 'vs Industry Benchmark',
    peer_institutions:  'vs Peer Institutions',
  };
  return labels[period] ?? period;
}

/**
 * Compute aggregate summary over a generated benchmark series.
 */
export function computeBenchmarkSummary(
  series: BenchmarkDataPoint[],
): { avg_delta: number; trend: 'better' | 'worse' | 'same'; peak_gap: number } {
  if (series.length === 0) {
    return { avg_delta: 0, trend: 'same', peak_gap: 0 };
  }

  const avgDelta = series.reduce((s, p) => s + p.delta, 0) / series.length;
  const peakGap  = Math.max(...series.map((p) => Math.abs(p.delta)));

  const trend =
    Math.abs(avgDelta) < 1
      ? 'same'
      : avgDelta < 0
      ? 'better'   // current < benchmark = performing better
      : 'worse';

  return { avg_delta: Math.round(avgDelta * 10) / 10, trend, peak_gap: peakGap };
}
