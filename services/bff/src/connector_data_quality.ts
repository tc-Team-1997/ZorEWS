// services/bff/src/connector_data_quality.ts
//
// T6 M3.24 — Connector data quality score.
//
// For each connector in the M3.1 registry, compute a data quality
// score (0-100) based on: success_rate from recent runs, connectivity
// status, and field completeness from M3.2 schema.

import { type IngestionRegistry } from './ingestion';
import { getConnectorSchema } from './connector_schema';

// ─── Public types ──────────────────────────────────────────────────────

export interface ConnectorDataQualityEntry {
  connector_id: string;
  name: string;
  type: string;
  source_system: string;
  quality_score: number; // 0–100
  success_rate: number; // 0–1
  connectivity_score: number; // 0–100
  completeness_score: number; // 0–100
  recent_runs: number;
  status: string;
}

export interface ConnectorDataQualityResult {
  tenant_id: string;
  generated_at: string;
  connectors: ConnectorDataQualityEntry[];
  avg_quality_score: number;
  lowest_quality_connector: ConnectorDataQualityEntry | null;
  highest_quality_connector: ConnectorDataQualityEntry | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function connectivityScore(status: string): number {
  switch (status) {
    case 'healthy':
      return 100;
    case 'degraded':
      return 60;
    case 'failing':
      return 20;
    case 'paused':
      return 0;
    default:
      return 50;
  }
}

// ─── Main function ────────────────────────────────────────────────────

export function computeConnectorDataQuality(
  tenant_id: string,
  registry: IngestionRegistry,
  now: Date,
): ConnectorDataQualityResult {
  const connectors = registry.list(tenant_id);
  const entries: ConnectorDataQualityEntry[] = [];

  for (const connector of connectors) {
    const runs = registry.listRuns(tenant_id, connector.id, 10);

    // Success rate from last 10 runs
    const finishedRuns = runs.filter((r) => r.status === 'success' || r.status === 'failure' || r.status === 'partial');
    const successRuns = runs.filter((r) => r.status === 'success');
    const success_rate = finishedRuns.length > 0 ? successRuns.length / finishedRuns.length : 1;

    // Connectivity score based on current status
    const connectivity = connectivityScore(connector.status);

    // Field completeness from schema
    const schema = getConnectorSchema(connector.id);
    let completeness_score = 80; // default if no schema
    if (schema) {
      const totalFields = schema.fields.length;
      const requiredFields = schema.fields.filter((f) => f.required).length;
      // Higher required/total ratio = more well-defined schema
      if (totalFields > 0) {
        completeness_score = Math.round((requiredFields / totalFields) * 100);
        // At least 50 for any schema that exists
        completeness_score = Math.max(50, completeness_score);
      }
    }

    // Weighted score
    const quality_score = Math.round(
      success_rate * 100 * 0.5 + connectivity * 0.3 + completeness_score * 0.2,
    );

    entries.push({
      connector_id: connector.id,
      name: connector.name,
      type: connector.type,
      source_system: connector.source_system,
      quality_score: Math.min(100, Math.max(0, quality_score)),
      success_rate: Math.round(success_rate * 10000) / 10000,
      connectivity_score: connectivity,
      completeness_score,
      recent_runs: runs.length,
      status: connector.status,
    });
  }

  // Sort by quality_score asc (lowest first for attention)
  entries.sort((a, b) => a.quality_score - b.quality_score);

  const avg_quality_score =
    entries.length > 0
      ? Math.round(entries.reduce((s, e) => s + e.quality_score, 0) / entries.length)
      : 0;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    connectors: entries,
    avg_quality_score,
    lowest_quality_connector: entries.length > 0 ? entries[0] : null,
    highest_quality_connector: entries.length > 0 ? entries[entries.length - 1] : null,
  };
}
