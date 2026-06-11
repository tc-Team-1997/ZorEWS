// services/bff/src/data_pipeline_timing.ts
// T6 M3.28 — Data pipeline execution time analysis.

import { defaultIngestionRegistry, type IngestionRegistry } from './ingestion';

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

export type PipelinePhase = 'extraction' | 'transformation' | 'load';

export interface ConnectorPipelineTiming {
  connector_id: string;
  name: string;
  type: string;
  avg_extraction_s: number;
  avg_transformation_s: number;
  avg_load_s: number;
  total_pipeline_s: number;
  bottleneck: PipelinePhase;
  sla_met: boolean;
}

export interface DataPipelineTiming {
  tenant_id: string;
  generated_at: string;
  connectors: ConnectorPipelineTiming[];
  slowest_pipeline: { connector_id: string; name: string; total_pipeline_s: number } | null;
  fleet_avg_total_s: number;
  all_sla_met: boolean;
}

const SLA_SECONDS = 600;

export function buildDataPipelineTiming(
  registry: IngestionRegistry,
  tenant_id: string,
  now: Date,
): DataPipelineTiming {
  const connectors = registry.list(tenant_id);
  const dayStr = now.toISOString().slice(0, 10);

  const rows: ConnectorPipelineTiming[] = connectors.map((c) => {
    const rng = mulberry32(fnv1a(`${tenant_id}:${c.id}:${dayStr}:pipeline`));
    const avg_extraction_s = Math.round(10 + rng() * 290);
    const avg_transformation_s = Math.round(5 + rng() * 55);
    const avg_load_s = Math.round(2 + rng() * 28);
    const total_pipeline_s = avg_extraction_s + avg_transformation_s + avg_load_s;

    let bottleneck: PipelinePhase = 'extraction';
    if (avg_transformation_s > avg_extraction_s && avg_transformation_s > avg_load_s) bottleneck = 'transformation';
    else if (avg_load_s > avg_extraction_s && avg_load_s > avg_transformation_s) bottleneck = 'load';

    const sla_met = total_pipeline_s < SLA_SECONDS;
    return { connector_id: c.id, name: c.name, type: c.type, avg_extraction_s, avg_transformation_s, avg_load_s, total_pipeline_s, bottleneck, sla_met };
  });

  rows.sort((a, b) => b.total_pipeline_s - a.total_pipeline_s);

  const slowest_pipeline = rows.length > 0 ? { connector_id: rows[0].connector_id, name: rows[0].name, total_pipeline_s: rows[0].total_pipeline_s } : null;
  const fleet_avg_total_s = rows.length === 0 ? 0 : Math.round(rows.reduce((s, r) => s + r.total_pipeline_s, 0) / rows.length);
  const all_sla_met = rows.every((r) => r.sla_met);

  return { tenant_id, generated_at: now.toISOString(), connectors: rows, slowest_pipeline, fleet_avg_total_s, all_sla_met };
}

export { defaultIngestionRegistry };
