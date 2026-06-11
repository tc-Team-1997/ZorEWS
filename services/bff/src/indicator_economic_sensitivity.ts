// services/bff/src/indicator_economic_sensitivity.ts
//
// T6 M4.24 — Indicator sensitivity to economic conditions.
//
// For each indicator in the BIL catalog, compute how sensitive it is
// to macroeconomic shifts (GDP, interest rate, inflation).

import { STUB_CATALOG } from './bil_scoring_v2';

// ─── PRNG helpers ─────────────────────────────────────────────────────

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

// ─── Public types ──────────────────────────────────────────────────────

export interface IndicatorEconomicSensitivity {
  indicator_id: string;
  name: string;
  vertical: string;
  catalog_weight: number;
  gdp_sensitivity: number;
  rate_sensitivity: number;
  inflation_sensitivity: number;
  overall_sensitivity: number;
}

export interface IndicatorEconomicSensitivityResult {
  tenant_id: string;
  generated_at: string;
  indicators: IndicatorEconomicSensitivity[];
  most_sensitive_indicator: IndicatorEconomicSensitivity | null;
  avg_overall_sensitivity: number;
}

// ─── Main function ────────────────────────────────────────────────────

export function computeIndicatorEconomicSensitivity(
  tenant_id: string,
  now: Date,
): IndicatorEconomicSensitivityResult {
  const indicators: IndicatorEconomicSensitivity[] = [];

  for (const [id, entry] of Object.entries(STUB_CATALOG)) {
    const seed = fnv1a(`${tenant_id}:${id}:economic`);
    const rand = mulberry32(seed);

    // Base sensitivities with family-aware biases
    let gdp_base = rand();
    let rate_base = rand();
    let inflation_base = rand();

    // Family-based adjustments
    const prefix = id.split('-')[0];
    if (prefix === 'FIN' || prefix === 'CRD') {
      // Financial/Credit: more rate-sensitive
      rate_base = Math.min(1, rate_base * 1.4);
    }
    if (prefix === 'TXN' || prefix === 'BEH') {
      // Transaction/Behavioural: more GDP-sensitive
      gdp_base = Math.min(1, gdp_base * 1.4);
    }
    if (prefix === 'POL' || prefix === 'CLM') {
      // Insurance: more inflation-sensitive
      inflation_base = Math.min(1, inflation_base * 1.4);
    }

    const gdp_sensitivity = Math.round(gdp_base * 10000) / 10000;
    const rate_sensitivity = Math.round(rate_base * 10000) / 10000;
    const inflation_sensitivity = Math.round(inflation_base * 10000) / 10000;
    const overall_sensitivity = Math.max(gdp_sensitivity, rate_sensitivity, inflation_sensitivity);

    indicators.push({
      indicator_id: id,
      name: entry.name,
      vertical: entry.vertical,
      catalog_weight: entry.weight,
      gdp_sensitivity,
      rate_sensitivity,
      inflation_sensitivity,
      overall_sensitivity: Math.round(overall_sensitivity * 10000) / 10000,
    });
  }

  // Sort by overall_sensitivity desc
  indicators.sort((a, b) => b.overall_sensitivity - a.overall_sensitivity);

  const avg_overall_sensitivity =
    indicators.length > 0
      ? Math.round(
          (indicators.reduce((s, i) => s + i.overall_sensitivity, 0) / indicators.length) * 10000,
        ) / 10000
      : 0;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    indicators,
    most_sensitive_indicator: indicators.length > 0 ? indicators[0] : null,
    avg_overall_sensitivity,
  };
}
