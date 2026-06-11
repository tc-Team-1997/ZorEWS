// services/bff/src/admin_config_impact.ts
//
// T6 M13.22 — Config change impact score.
//
// For each config key in the DEFAULTS schema, compute an "impact_score"
// (0-100) representing how critical this key is to operations.
// Scoring rules:
//   category=alerts → base 80
//   category=scoring → base 75
//   category=features → base 90 (feature toggles affect everything)
//   category=notifications → base 60
//   category=reporting → base 50
//   + type=boolean ? +10 : type=number ? +5 : 0
// Sort by impact_score desc.

import { DEFAULTS, type ConfigCategory, type ConfigType } from './admin_config';

const CATEGORY_BASE: Record<ConfigCategory, number> = {
  alerts: 80,
  cases: 70,
  scoring: 75,
  features: 90,
  notifications: 60,
  reporting: 50,
};

const TYPE_BONUS: Record<ConfigType, number> = {
  boolean: 10,
  number: 5,
  string: 0,
  json: 3,
};

export interface ConfigImpactRow {
  key: string;
  category: ConfigCategory;
  type: ConfigType;
  description: string;
  impact_score: number;
}

export interface ConfigImpactResult {
  generated_at: string;
  total_keys: number;
  keys: ConfigImpactRow[];
  highest_impact_key: string | null;
  category_avg_scores: Record<ConfigCategory, number>;
}

export function buildConfigImpactScores(now: Date): ConfigImpactResult {
  const rows: ConfigImpactRow[] = DEFAULTS.map((def) => {
    const base = CATEGORY_BASE[def.category] ?? 50;
    const bonus = TYPE_BONUS[def.type] ?? 0;
    return {
      key: def.key,
      category: def.category,
      type: def.type,
      description: def.description,
      impact_score: Math.min(100, base + bonus),
    };
  });

  rows.sort((a, b) => b.impact_score - a.impact_score || a.key.localeCompare(b.key));

  const highest_impact_key = rows.length > 0 ? rows[0].key : null;

  // Compute average per category
  const catTotals: Record<string, { sum: number; count: number }> = {};
  for (const r of rows) {
    if (!catTotals[r.category]) catTotals[r.category] = { sum: 0, count: 0 };
    catTotals[r.category].sum += r.impact_score;
    catTotals[r.category].count++;
  }

  const allCategories: ConfigCategory[] = ['alerts', 'cases', 'notifications', 'reporting', 'scoring', 'features'];
  const category_avg_scores = {} as Record<ConfigCategory, number>;
  for (const cat of allCategories) {
    const entry = catTotals[cat];
    category_avg_scores[cat] = entry && entry.count > 0
      ? Math.round((entry.sum / entry.count) * 100) / 100
      : 0;
  }

  return {
    generated_at: now.toISOString(),
    total_keys: rows.length,
    keys: rows,
    highest_impact_key,
    category_avg_scores,
  };
}
