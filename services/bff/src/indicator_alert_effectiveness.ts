// services/bff/src/indicator_alert_effectiveness.ts
// T6 M4.30 — Indicator alert effectiveness score.

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

export type EffectivenessGrade = 'A' | 'B' | 'C' | 'D';

export interface IndicatorEffectivenessRow {
  indicator_id: string;
  name: string;
  true_positive_rate: number;
  false_positive_rate: number;
  precision: number;
  recall: number;
  f1_score: number;
  effectiveness_grade: EffectivenessGrade;
}

export interface IndicatorAlertEffectivenessResult {
  tenant_id: string;
  generated_at: string;
  indicators: IndicatorEffectivenessRow[];
  top_performers: string[];
  poor_performers: string[];
  avg_f1_score: number;
}

function gradeFor(f1: number): EffectivenessGrade {
  if (f1 >= 0.8) return 'A';
  if (f1 >= 0.6) return 'B';
  if (f1 >= 0.4) return 'C';
  return 'D';
}

export function buildIndicatorAlertEffectiveness(
  tenant_id: string,
  now: Date,
): IndicatorAlertEffectivenessResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const indicators: IndicatorEffectivenessRow[] = [];

  for (const [id, entry] of Object.entries(STUB_CATALOG)) {
    const rng = mulberry32(fnv1a(tenant_id + id + now.toISOString().slice(0, 10)));

    const tpr = 0.4 + rng() * 0.5; // 0.4-0.9
    const fpr = 0.05 + rng() * 0.35; // 0.05-0.4

    // precision = tp / (tp + fp); recall = tp / (tp + fn = 1 - tp)
    const tp = tpr;
    const fp = fpr;
    const fn = 1 - tp;
    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    const f1_score = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

    indicators.push({
      indicator_id: id,
      name: (entry as any).name ?? id,
      true_positive_rate: Math.round(tpr * 1000) / 1000,
      false_positive_rate: Math.round(fpr * 1000) / 1000,
      precision: Math.round(precision * 1000) / 1000,
      recall: Math.round(recall * 1000) / 1000,
      f1_score: Math.round(f1_score * 1000) / 1000,
      effectiveness_grade: gradeFor(f1_score),
    });
  }

  indicators.sort((a, b) => b.f1_score - a.f1_score);

  const top_performers = indicators
    .filter((i) => i.effectiveness_grade === 'A')
    .slice(0, 5)
    .map((i) => i.indicator_id);
  const poor_performers = indicators
    .filter((i) => i.effectiveness_grade === 'D')
    .slice(0, 5)
    .map((i) => i.indicator_id);

  const avg_f1_score =
    indicators.length === 0
      ? 0
      : Math.round((indicators.reduce((s, i) => s + i.f1_score, 0) / indicators.length) * 1000) / 1000;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    indicators,
    top_performers,
    poor_performers,
    avg_f1_score,
  };
}
