// services/bff/src/adapter_sla_trend.ts
// T6 M14.39 — Adapter SLA trend over batches.

import { listFleetAdapters } from './adapter_health';

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

export type SlaTrend = 'improving' | 'degrading' | 'stable';

export interface AdapterSlaTrendRow {
  adapter_id: string;
  label: string;
  weekly_sla_pcts: [number, number, number, number, number];
  trend: SlaTrend;
  current_sla_pct: number;
  trend_delta_pct: number;
}

export interface AdapterSlaTrendResult {
  tenant_id: string;
  generated_at: string;
  adapters: AdapterSlaTrendRow[];
  improving_count: number;
  degrading_count: number;
  stable_count: number;
  fleet_avg_current_sla_pct: number;
}

export function buildAdapterSlaTrend(
  tenant_id: string,
  now: Date,
): AdapterSlaTrendResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const adapters_meta = listFleetAdapters();
  const rows: AdapterSlaTrendRow[] = [];

  for (const meta of adapters_meta) {
    const weekly_sla_pcts: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    for (let w = 0; w < 5; w++) {
      const rng = mulberry32(fnv1a(tenant_id + meta.adapter_id + String(w)));
      weekly_sla_pcts[w] = Math.round((60 + rng() * 40) * 10) / 10; // 60-100%
    }

    const first = weekly_sla_pcts[0];
    const last = weekly_sla_pcts[4];
    const delta = Math.round((last - first) * 10) / 10;

    let trend: SlaTrend;
    if (delta > 5) trend = 'improving';
    else if (delta < -5) trend = 'degrading';
    else trend = 'stable';

    rows.push({
      adapter_id: meta.adapter_id,
      label: meta.label,
      weekly_sla_pcts,
      trend,
      current_sla_pct: last,
      trend_delta_pct: delta,
    });
  }

  // sort worst first (lowest current_sla_pct)
  rows.sort((a, b) => a.current_sla_pct - b.current_sla_pct);

  const improving_count = rows.filter((r) => r.trend === 'improving').length;
  const degrading_count = rows.filter((r) => r.trend === 'degrading').length;
  const stable_count = rows.filter((r) => r.trend === 'stable').length;

  const fleet_avg_current_sla_pct =
    rows.length === 0
      ? 0
      : Math.round((rows.reduce((s, r) => s + r.current_sla_pct, 0) / rows.length) * 10) / 10;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    adapters: rows,
    improving_count,
    degrading_count,
    stable_count,
    fleet_avg_current_sla_pct,
  };
}
