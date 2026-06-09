// services/bff/src/connector_schema_field_frequency.ts
//
// T6 M3.21 — Connector schema field name frequency.
//
// Counts how many connectors declare each field NAME and surfaces
// which connectors share fields (useful for cross-connector integrity
// audits: "do connectors that both declare 'customer_id' agree on
// the type?").
//
// Distinct from:
//   M3.8  — field cross-index (per-field, lists connector_ids + observed_types)
//   M3.11 — connector schema type-matrix (per-connector FieldType counts)
//   M3.14 — field-type × required matrix (global 2D pivot)
//
// Route: GET /v1/ingestion/schema/field-frequency
//   RBAC: audit:read (admin-only)
//   Platform-static. Mounted BEFORE catch-all /:id/schema routes.

import {
  listSchemaConnectorIds,
  getConnectorSchema,
} from './connector_schema';

// ─── Public types ──────────────────────────────────────────────────────

export interface FieldFrequencyEntry {
  field_name: string;
  /** Number of connectors that declare this field. */
  count: number;
  /** Connector ids that include this field, sorted asc. */
  observed_in_connectors: string[];
  /** Distinct FieldType values observed for this field across connectors, sorted asc. */
  observed_types: string[];
  /** True when more than one distinct type is seen for this field name. */
  has_type_drift: boolean;
}

export interface ConnectorSchemaFieldFrequency {
  generated_at: string;
  total_connectors: number;
  total_unique_fields: number;
  /** Sorted by count desc + field_name asc tie-break. */
  fields: FieldFrequencyEntry[];
  /** Field with the highest count; null when no fields. */
  most_shared_field: { field_name: string; count: number } | null;
  /** Number of field names that appear with more than one distinct type. */
  type_drift_count: number;
  /** Field names that appear in EVERY connector (count === total_connectors). */
  universal_fields: string[];
}

// ─── Implementation ─────────────────────────────────────────────────────

export function buildConnectorSchemaFieldFrequency(
  now: Date,
): ConnectorSchemaFieldFrequency {
  const generated_at = now.toISOString();
  const connector_ids = listSchemaConnectorIds();
  const total_connectors = connector_ids.length;

  // field_name → { connectors: Set<string>, types: Set<string> }
  const fieldMap = new Map<
    string,
    { connectors: Set<string>; types: Set<string> }
  >();

  for (const cid of connector_ids) {
    const schema = getConnectorSchema(cid);
    if (!schema) continue;
    for (const field of schema.fields) {
      const existing = fieldMap.get(field.name);
      if (existing) {
        existing.connectors.add(cid);
        existing.types.add(field.type);
      } else {
        fieldMap.set(field.name, {
          connectors: new Set([cid]),
          types: new Set([field.type]),
        });
      }
    }
  }

  const total_unique_fields = fieldMap.size;
  let type_drift_count = 0;

  const entries: FieldFrequencyEntry[] = [];
  for (const [field_name, { connectors, types }] of fieldMap.entries()) {
    const observed_in_connectors = [...connectors].sort();
    const observed_types = [...types].sort();
    const has_type_drift = observed_types.length > 1;
    if (has_type_drift) type_drift_count++;
    entries.push({
      field_name,
      count: connectors.size,
      observed_in_connectors,
      observed_types,
      has_type_drift,
    });
  }

  // Sort: count desc + field_name asc
  entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.field_name.localeCompare(b.field_name);
  });

  const most_shared_field =
    entries.length > 0
      ? { field_name: entries[0]!.field_name, count: entries[0]!.count }
      : null;

  const universal_fields = entries
    .filter(e => e.count === total_connectors)
    .map(e => e.field_name)
    .sort();

  return {
    generated_at,
    total_connectors,
    total_unique_fields,
    fields: entries,
    most_shared_field,
    type_drift_count,
    universal_fields,
  };
}
