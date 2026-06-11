// services/bff/src/dashboard_widget_heatmap.ts
//
// T6 M11.22 — Dashboard widget interaction heatmap.
//
// For each widget_type in the WIDGET_CATALOG, compute a synthetic
// "interaction score" (0-100) representing how often that widget
// type is interacted with. Uses deterministic PRNG seeded by
// (tenant, widget_type, day).

import { WIDGET_CATALOG, WIDGET_TYPES, type WidgetType } from './custom_dashboards';

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

export interface WidgetInteractionRow {
  widget_type: WidgetType;
  display_name: string;
  interaction_score: number; // 0-100
  relative_rank: number; // 1-based
  percentile: number; // 0-100
}

export interface WidgetInteractionHeatmapResult {
  tenant_id: string;
  generated_at: string;
  widgets: WidgetInteractionRow[];
  most_interacted: WidgetType | null;
  least_interacted: WidgetType | null;
}

export function buildDashboardWidgetInteractionHeatmap(
  tenant_id: string,
  now: Date,
): WidgetInteractionHeatmapResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const dayStr = now.toISOString().slice(0, 10);

  const scores: Array<{ widget_type: WidgetType; display_name: string; score: number }> = [];

  for (const wt of WIDGET_TYPES) {
    const seed = fnv1a(`${tenant_id}|${wt}|${dayStr}`);
    const rand = mulberry32(seed);
    const score = Math.round(rand() * 100);
    const entry = WIDGET_CATALOG[wt as WidgetType];
    scores.push({
      widget_type: wt as WidgetType,
      display_name: entry?.display_name ?? wt,
      score,
    });
  }

  // Sort by score desc for ranking
  scores.sort((a, b) => b.score - a.score || a.widget_type.localeCompare(b.widget_type));

  const n = scores.length;
  const widgets: WidgetInteractionRow[] = scores.map((s, idx) => ({
    widget_type: s.widget_type,
    display_name: s.display_name,
    interaction_score: s.score,
    relative_rank: idx + 1,
    percentile: n <= 1 ? 100 : Math.round(((n - 1 - idx) / (n - 1)) * 100),
  }));

  const most_interacted = widgets.length > 0 ? widgets[0].widget_type : null;
  const least_interacted = widgets.length > 0 ? widgets[widgets.length - 1].widget_type : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    widgets,
    most_interacted,
    least_interacted,
  };
}
