/**
 * M4.25 — Indicator family weight comparison
 * Groups STUB_CATALOG by family prefix and compares weight statistics.
 */

import { STUB_CATALOG } from './bil_scoring_v2';

export interface FamilyWeightStats {
  family: string;
  indicator_count: number;
  min_weight: number;
  max_weight: number;
  avg_weight: number;
  weight_range: number;
  dominant_indicators: Array<{ indicator_id: string; weight: number }>;
}

export interface IndicatorFamilyWeightReport {
  generated_at: string;
  total_families: number;
  families: FamilyWeightStats[];
  heaviest_family: string | null;
  lightest_family: string | null;
}

function familyPrefix(indicator_id: string): string {
  const m = indicator_id.match(/^(.+?)-\d+$/);
  return m ? m[1] : indicator_id;
}

export function buildIndicatorFamilyWeightComparison(
  now: Date = new Date(),
): IndicatorFamilyWeightReport {
  const byFamily = new Map<string, Array<{ indicator_id: string; weight: number }>>();

  for (const [indicator_id, entry] of Object.entries(STUB_CATALOG)) {
    const family = familyPrefix(indicator_id);
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family)!.push({ indicator_id, weight: entry.weight });
  }

  const families: FamilyWeightStats[] = [];

  for (const [family, entries] of byFamily) {
    const weights = entries.map((e) => e.weight);
    const min_weight = Math.min(...weights);
    const max_weight = Math.max(...weights);
    const avg_weight = weights.reduce((s, w) => s + w, 0) / weights.length;
    const sorted_desc = [...entries].sort((a, b) => b.weight - a.weight);
    const dominant_indicators = sorted_desc.slice(0, 2).map((e) => ({
      indicator_id: e.indicator_id,
      weight: e.weight,
    }));

    families.push({
      family,
      indicator_count: entries.length,
      min_weight,
      max_weight,
      avg_weight,
      weight_range: max_weight - min_weight,
      dominant_indicators,
    });
  }

  // Sort by avg_weight desc
  families.sort((a, b) => b.avg_weight - a.avg_weight);

  const heaviest_family = families.length > 0 ? families[0].family : null;
  const lightest_family = families.length > 0 ? families[families.length - 1].family : null;

  return {
    generated_at: now.toISOString(),
    total_families: families.length,
    families,
    heaviest_family,
    lightest_family,
  };
}
