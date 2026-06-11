// services/bff/src/indicator_correlation_matrix.ts
// T6 M4.31 — Indicator cross-correlation matrix (sampling)

import { STUB_CATALOG } from './bil_scoring_v2';

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

function computePearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n === 0) return 0;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const di = x[i]! - mx;
    const dj = y[i]! - my;
    num += di * dj;
    dx2 += di * di;
    dy2 += dj * dj;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (denom === 0) return 0;
  return Math.round((num / denom) * 10000) / 10000;
}

export interface IndicatorCorrelationMatrix {
  tenant_id: string;
  generated_at: string;
  indicators: Array<{ id: string; name: string }>;
  matrix: number[][];
  most_correlated_pair: { a: string; b: string; r: number } | null;
  least_correlated_pair: { a: string; b: string; r: number } | null;
  avg_abs_correlation: number;
}

export function buildIndicatorCorrelationMatrix(
  tenant_id: string,
  now: Date
): IndicatorCorrelationMatrix {
  const generated_at = now.toISOString();

  // Pick top 6 indicators by weight
  const sorted = Object.entries(STUB_CATALOG)
    .sort(([, a], [, b]) => b.weight - a.weight)
    .slice(0, 6);

  const indicators = sorted.map(([id, entry]) => ({ id, name: entry.name }));
  const n = indicators.length;

  const N_CUSTOMERS = 50;
  const day = Math.floor(now.getTime() / 86400000);

  // Synthesize customer values per indicator
  const values: number[][] = indicators.map((ind, i) => {
    const seed = fnv1a(`${tenant_id}:${ind.id}:${day}:corr`);
    const rng = mulberry32(seed);
    // Base signal + noise
    return Array.from({ length: N_CUSTOMERS }, () => rng());
  });

  // Build 6x6 matrix
  const matrix: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (__, j) => {
      if (i === j) return 1;
      return computePearson(values[i]!, values[j]!);
    })
  );

  let most_correlated_pair: { a: string; b: string; r: number } | null = null;
  let least_correlated_pair: { a: string; b: string; r: number } | null = null;
  let sumAbsR = 0;
  let pairCount = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = matrix[i]![j]!;
      const absR = Math.abs(r);
      sumAbsR += absR;
      pairCount++;

      if (most_correlated_pair === null || absR > Math.abs(most_correlated_pair.r)) {
        most_correlated_pair = { a: indicators[i]!.id, b: indicators[j]!.id, r };
      }
      if (least_correlated_pair === null || absR < Math.abs(least_correlated_pair.r)) {
        least_correlated_pair = { a: indicators[i]!.id, b: indicators[j]!.id, r };
      }
    }
  }

  const avg_abs_correlation = pairCount > 0 ? Math.round((sumAbsR / pairCount) * 10000) / 10000 : 0;

  return {
    tenant_id,
    generated_at,
    indicators,
    matrix,
    most_correlated_pair,
    least_correlated_pair,
    avg_abs_correlation,
  };
}
