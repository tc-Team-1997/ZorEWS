// services/bff/src/dashboard_widget_error_rate.ts
// T6 M11.25 — Dashboard widget error rate tracking.
// Synthesizes error rate and load metrics per widget_type.

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

export interface WidgetErrorRateEntry {
  widget_type: WidgetType;
  display_name: string;
  error_rate: number;    // 0-0.15
  avg_load_ms: number;   // 100-2000
  timeout_rate: number;  // 0-0.05
  reliability_score: number; // 0-100
}

export interface DashboardWidgetErrorRateResult {
  tenant_id: string;
  generated_at: string;
  widgets: WidgetErrorRateEntry[];
  least_reliable_widget: WidgetType | null;
  most_reliable_widget: WidgetType | null;
  fleet_avg_reliability: number;
}

export function buildDashboardWidgetErrorRate(
  tenant_id: string,
  now: Date,
): DashboardWidgetErrorRateResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const dayKey = Math.floor(now.getTime() / 86_400_000);

  const widgets: WidgetErrorRateEntry[] = WIDGET_TYPES.map((widget_type) => {
    const seed = fnv1a(`${tenant_id}:widget_error:${widget_type}:${dayKey}`);
    const rng = mulberry32(seed);

    const error_rate = Math.round(rng() * 0.15 * 10000) / 10000;
    const avg_load_ms = Math.round(100 + rng() * 1900);
    const timeout_rate = Math.round(rng() * 0.05 * 10000) / 10000;

    const reliability_score = Math.round(
      (1 - error_rate) * 60 + (1 - avg_load_ms / 2000) * 25 + (1 - timeout_rate) * 15,
    );

    const display_name = WIDGET_CATALOG[widget_type]?.display_name ?? widget_type;

    return {
      widget_type,
      display_name,
      error_rate,
      avg_load_ms,
      timeout_rate,
      reliability_score,
    };
  });

  // Sort by reliability_score asc (most problematic first)
  widgets.sort((a, b) => a.reliability_score - b.reliability_score || a.widget_type.localeCompare(b.widget_type));

  const leastReliable = widgets.length > 0 ? widgets[0].widget_type : null;
  const mostReliable = widgets.length > 0 ? widgets[widgets.length - 1].widget_type : null;

  const fleet_avg_reliability =
    widgets.length > 0
      ? Math.round(widgets.reduce((s, w) => s + w.reliability_score, 0) / widgets.length)
      : 0;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    widgets,
    least_reliable_widget: leastReliable,
    most_reliable_widget: mostReliable,
    fleet_avg_reliability,
  };
}
