// services/bff/src/indicator_value_distribution.ts
// T6 M4.28 — Indicator value distribution by segment.
// Synthesizes value distribution stats for each indicator in STUB_CATALOG.

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

export type DistributionShape = 'left_skewed' | 'right_skewed' | 'symmetric';

export interface IndicatorDistribution {
  indicator_id: string;
  name: string;
  vertical: string;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  mean: number;
  std_dev: number;
  shape: DistributionShape;
}

export interface IndicatorValueDistributionResult {
  tenant_id: string;
  generated_at: string;
  indicators: IndicatorDistribution[];
  most_variable_indicator: string | null;
  least_variable_indicator: string | null;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

export function buildIndicatorValueDistribution(
  tenant_id: string,
  now: Date,
): IndicatorValueDistributionResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const dayKey = Math.floor(now.getTime() / 86_400_000);
  const COHORT = 200;

  const indicators: IndicatorDistribution[] = Object.entries(STUB_CATALOG).map(
    ([indicator_id, entry]) => {
      const seed = fnv1a(`${tenant_id}:${indicator_id}:dist:${dayKey}`);
      const rng = mulberry32(seed);

      // Generate COHORT values in [0,1]
      const values: number[] = [];
      for (let i = 0; i < COHORT; i++) {
        values.push(rng());
      }
      values.sort((a, b) => a - b);

      const mean = round4(values.reduce((s, v) => s + v, 0) / COHORT);
      const variance =
        values.reduce((s, v) => s + (v - mean) ** 2, 0) / COHORT;
      const std_dev = round4(Math.sqrt(variance));

      const pct = (p: number) => {
        const idx = (p / 100) * (COHORT - 1);
        const lo = Math.floor(idx);
        const hi = Math.ceil(idx);
        return round4(values[lo] + (values[hi] - values[lo]) * (idx - lo));
      };

      const p10 = pct(10);
      const p25 = pct(25);
      const p50 = pct(50);
      const p75 = pct(75);
      const p90 = pct(90);

      let shape: DistributionShape;
      const diff = p50 - mean;
      if (diff > 0.01) shape = 'left_skewed';
      else if (diff < -0.01) shape = 'right_skewed';
      else shape = 'symmetric';

      return {
        indicator_id,
        name: entry.name,
        vertical: entry.vertical,
        p10,
        p25,
        p50,
        p75,
        p90,
        mean,
        std_dev,
        shape,
      };
    },
  );

  // Sort by std_dev desc for result list, asc tie-break on indicator_id
  indicators.sort(
    (a, b) => b.std_dev - a.std_dev || a.indicator_id.localeCompare(b.indicator_id),
  );

  const mostVariable = indicators.length > 0 ? indicators[0].indicator_id : null;
  const leastVariable = indicators.length > 0 ? indicators[indicators.length - 1].indicator_id : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    indicators,
    most_variable_indicator: mostVariable,
    least_variable_indicator: leastVariable,
  };
}
