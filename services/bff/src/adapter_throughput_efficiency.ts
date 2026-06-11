/**
 * M14.35 — Adapter throughput efficiency
 * Computes synthetic throughput efficiency scores for all adapters.
 */

import { listFleetAdapters } from './adapter_health';
import { listAdapterSlaCatalog } from './adapter_sla_catalog';

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

export type EfficiencyGrade = 'A' | 'B' | 'C' | 'D';

export interface AdapterThroughputEntry {
  adapter_id: string;
  label: string;
  throughput_efficiency_score: number;
  requests_per_minute_estimate: number;
  utilization_pct: number;
  efficiency_grade: EfficiencyGrade;
}

export interface AdapterThroughputEfficiencyReport {
  tenant_id: string;
  generated_at: string;
  adapters: AdapterThroughputEntry[];
  avg_efficiency: number;
  most_efficient_adapter: string | null;
  least_efficient_adapter: string | null;
}

function gradeFor(score: number): EfficiencyGrade {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  return 'D';
}

export function buildAdapterThroughputEfficiency(
  tenant_id: string,
  now: Date = new Date(),
): AdapterThroughputEfficiencyReport {
  if (!tenant_id) throw new Error('tenant_id required');

  const fleet = listFleetAdapters();
  const slaCatalog = listAdapterSlaCatalog();
  const slaMap = new Map(slaCatalog.adapters.map((a) => [a.adapter_id, a]));

  const dateKey = now.toISOString().slice(0, 10);
  const adapters: AdapterThroughputEntry[] = [];

  for (const adapter of fleet) {
    const seed = fnv1a(`${tenant_id}:${adapter.adapter_id}:${dateKey}`);
    const rng = mulberry32(seed);

    const throughput_efficiency_score = 70 + rng() * 30;
    const sla = slaMap.get(adapter.adapter_id);
    const requests_per_minute_estimate = sla ? sla.rate_limit_per_minute : 60;
    const utilization_pct = 20 + rng() * 60; // 20-80%

    adapters.push({
      adapter_id: adapter.adapter_id,
      label: adapter.label,
      throughput_efficiency_score,
      requests_per_minute_estimate,
      utilization_pct,
      efficiency_grade: gradeFor(throughput_efficiency_score),
    });
  }

  // Sort by efficiency_score desc
  adapters.sort((a, b) => b.throughput_efficiency_score - a.throughput_efficiency_score);

  const avg_efficiency =
    adapters.length > 0
      ? adapters.reduce((s, a) => s + a.throughput_efficiency_score, 0) / adapters.length
      : 0;

  const most_efficient_adapter = adapters.length > 0 ? adapters[0].adapter_id : null;
  const least_efficient_adapter =
    adapters.length > 0 ? adapters[adapters.length - 1].adapter_id : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    adapters,
    avg_efficiency,
    most_efficient_adapter,
    least_efficient_adapter,
  };
}
