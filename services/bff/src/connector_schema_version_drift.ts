// services/bff/src/connector_schema_version_drift.ts
//
// T6 M3.23 — Connector schema version drift detection.
//
// Compares field counts across connectors of the same source_system
// type to surface divergence (e.g. two CBS connectors with different
// field counts → likely out-of-sync schema versions).

import { listSchemaConnectorIds, getConnectorSchema } from './connector_schema';

// ─── Public types ──────────────────────────────────────────────────────

export interface SourceSystemDrift {
  source_system: string;
  connector_count: number;
  field_counts: number[];
  has_drift: boolean;
  min_fields: number;
  max_fields: number;
  drift_magnitude: number;
}

export interface ConnectorSchemaVersionDrift {
  generated_at: string;
  total_connectors: number;
  by_source_system: SourceSystemDrift[];
  drifting_systems: string[];
  stable_systems: string[];
}

// ─── Pure function ─────────────────────────────────────────────────────

export function buildConnectorSchemaVersionDrift(now: Date): ConnectorSchemaVersionDrift {
  const generated_at = now.toISOString();

  const ids = listSchemaConnectorIds();
  const total_connectors = ids.length;

  // Group by source_system
  const systemMap = new Map<string, { id: string; field_count: number }[]>();
  for (const id of ids) {
    const schema = getConnectorSchema(id);
    if (!schema) continue;
    // Derive source_system from the connector id by taking the prefix before '_'
    // e.g. "cbs_loan_book" → "cbs", "aml_watchlist" → "aml"
    const source_system = deriveSourceSystem(id);
    if (!systemMap.has(source_system)) systemMap.set(source_system, []);
    systemMap.get(source_system)!.push({ id, field_count: schema.fields.length });
  }

  const by_source_system: SourceSystemDrift[] = [];

  for (const [source_system, group] of systemMap) {
    const field_counts = group.map(g => g.field_count);
    const min_fields = Math.min(...field_counts);
    const max_fields = Math.max(...field_counts);
    const drift_magnitude = max_fields - min_fields;
    const has_drift = group.length > 1 && drift_magnitude > 0;

    by_source_system.push({
      source_system,
      connector_count: group.length,
      field_counts,
      has_drift,
      min_fields,
      max_fields,
      drift_magnitude,
    });
  }

  // Sort by drift_magnitude desc
  by_source_system.sort((a, b) => b.drift_magnitude - a.drift_magnitude || a.source_system.localeCompare(b.source_system));

  const drifting_systems = by_source_system.filter(s => s.has_drift).map(s => s.source_system).sort();
  const stable_systems = by_source_system.filter(s => !s.has_drift).map(s => s.source_system).sort();

  return {
    generated_at,
    total_connectors,
    by_source_system,
    drifting_systems,
    stable_systems,
  };
}

function deriveSourceSystem(connector_id: string): string {
  // e.g. "cbs_loan_book" → "cbs", "core_insurance_policies" → "core_insurance"
  // Just use the first segment(s) to identify the upstream system
  const parts = connector_id.split('_');
  if (parts.length <= 1) return connector_id;
  // "core_insurance_policies" → "core_insurance"; "cbs_loan_book" → "cbs"
  if (parts[0] === 'core' && parts.length >= 2) return `${parts[0]}_${parts[1]}`;
  return parts[0] ?? connector_id;
}
