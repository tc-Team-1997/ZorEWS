// services/bff/src/indicator_trigger_frequency.ts
// T6 M4.29 — Indicator trigger frequency analysis.

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

export interface IndicatorTriggerRow {
  indicator_id: string;
  name: string;
  vertical: string;
  triggers_30d: number;
  alerts_generated: number;
  false_positive_estimate: number;
  net_signal_alerts: number;
  trigger_rate_per_day: number;
}

export interface IndicatorTriggerFrequency {
  tenant_id: string;
  generated_at: string;
  indicators: IndicatorTriggerRow[];
  highest_trigger_indicator: string | null;
  lowest_trigger_indicator: string | null;
  total_triggers_30d: number;
}

export function buildIndicatorTriggerFrequency(
  tenant_id: string,
  now: Date,
): IndicatorTriggerFrequency {
  const dayStr = now.toISOString().slice(0, 10);
  const indicators: IndicatorTriggerRow[] = Object.entries(STUB_CATALOG).map(([indicator_id, entry]) => {
    const rng = mulberry32(fnv1a(`${tenant_id}:${indicator_id}:${dayStr}:trigger`));
    const triggers_30d = 10 + Math.floor(rng() * 491);
    const alert_rate = 0.3 + rng() * 0.5;
    const fp_rate = 0.1 + rng() * 0.3;
    const alerts_generated = Math.round(triggers_30d * alert_rate);
    const false_positive_estimate = Math.round(alerts_generated * fp_rate);
    const net_signal_alerts = alerts_generated - false_positive_estimate;
    const trigger_rate_per_day = Math.round((triggers_30d / 30) * 100) / 100;
    return { indicator_id, name: entry.name, vertical: entry.vertical, triggers_30d, alerts_generated, false_positive_estimate, net_signal_alerts, trigger_rate_per_day };
  });

  indicators.sort((a, b) => b.triggers_30d - a.triggers_30d);
  const total_triggers_30d = indicators.reduce((s, i) => s + i.triggers_30d, 0);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    indicators,
    highest_trigger_indicator: indicators.length > 0 ? indicators[0].indicator_id : null,
    lowest_trigger_indicator: indicators.length > 0 ? indicators[indicators.length - 1].indicator_id : null,
    total_triggers_30d,
  };
}
