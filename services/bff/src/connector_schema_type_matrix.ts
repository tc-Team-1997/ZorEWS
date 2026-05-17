// services/bff/src/connector_schema_type_matrix.ts
//
// T6 M3.11 — Connector schema field type-coverage matrix.
//
// M3.2 ships per-connector schemas with field-level metadata.
// M3.8 ships the cross-connector inverted index (field_name →
// connectors). M3.11 ships the orthogonal 2D matrix: per-connector
// × per-FieldType counts plus required-vs-optional split.
//
// Lets the SPA's "schema audit" panel render a stacked-bar chart
// per connector ("what's the type-makeup of CBS loan-book?")
// without re-aggregating client-side. Surfaces structural insights
// at a glance (e.g. "this connector has NO enum fields — should it?").
//
// Pure rollup — walks SCHEMAS_BY_ID once, no I/O. Platform-static.

import {
  type FieldType,
  type ConnectorSchema,
  listSchemaConnectorIds,
  getConnectorSchema,
} from './connector_schema';

// ─── Public types ─────────────────────────────────────────────────────

export const ALL_FIELD_TYPES: readonly FieldType[] = [
  'string',
  'integer',
  'number',
  'boolean',
  'date',
  'datetime',
  'enum',
] as const;

export interface ConnectorTypeRow {
  connector_id: string;
  version: string;
  total_fields: number;
  required_count: number;
  optional_count: number;
  /** Per-FieldType count. Every FieldType key present (zero when
   *  absent) so the SPA can render a stable grid. */
  by_type: Record<FieldType, number>;
  /** Highest-count type for this connector. Tie-broken by
   *  ALL_FIELD_TYPES declared order. null when total_fields=0. */
  dominant_type: FieldType | null;
}

export interface ConnectorSchemaTypeMatrix {
  total_connectors: number;
  total_fields: number;
  total_required: number;
  total_optional: number;
  /** Per-FieldType marginal totals across all connectors. */
  by_type_totals: Record<FieldType, number>;
  /** Per-connector rows sorted by total_fields desc with
   *  connector_id asc tie-break — biggest schemas float to the top. */
  connectors: ConnectorTypeRow[];
  /** Connectors whose by_type has zero entries for a given key
   *  (i.e. no fields of that type). For each FieldType lists the
   *  connector_ids that don't use it. Sorted by connector_id asc. */
  connectors_without_type: Record<FieldType, string[]>;
}

// ─── Pure resolver ────────────────────────────────────────────────────

function emptyTypeCounts(): Record<FieldType, number> {
  return {
    string: 0,
    integer: 0,
    number: 0,
    boolean: 0,
    date: 0,
    datetime: 0,
    enum: 0,
  };
}

function pickDominantType(by_type: Record<FieldType, number>): FieldType | null {
  let best: FieldType | null = null;
  let bestCount = 0;
  for (const t of ALL_FIELD_TYPES) {
    const c = by_type[t];
    if (c > bestCount) {
      bestCount = c;
      best = t;
    }
    // Iteration order is declared-order → ties auto-resolve to the
    // first-seen type (matches the documented tie-break rule).
  }
  return bestCount === 0 ? null : best;
}

function buildRow(schema: ConnectorSchema): ConnectorTypeRow {
  const by_type = emptyTypeCounts();
  let required_count = 0;
  let optional_count = 0;
  for (const f of schema.fields) {
    by_type[f.type]++;
    if (f.required) required_count++;
    else optional_count++;
  }
  return {
    connector_id: schema.connector_id,
    version: schema.version,
    total_fields: schema.fields.length,
    required_count,
    optional_count,
    by_type,
    dominant_type: pickDominantType(by_type),
  };
}

export function buildConnectorSchemaTypeMatrix(): ConnectorSchemaTypeMatrix {
  const connector_ids = listSchemaConnectorIds();
  const rows: ConnectorTypeRow[] = [];
  const by_type_totals = emptyTypeCounts();
  let total_fields = 0;
  let total_required = 0;
  let total_optional = 0;

  for (const id of connector_ids) {
    const schema = getConnectorSchema(id);
    if (!schema) continue; // unknown id — shouldn't happen
    const row = buildRow(schema);
    rows.push(row);
    total_fields += row.total_fields;
    total_required += row.required_count;
    total_optional += row.optional_count;
    for (const t of ALL_FIELD_TYPES) {
      by_type_totals[t] += row.by_type[t];
    }
  }

  rows.sort((a, b) => {
    if (b.total_fields !== a.total_fields) return b.total_fields - a.total_fields;
    return a.connector_id.localeCompare(b.connector_id);
  });

  const connectors_without_type: Record<FieldType, string[]> = {
    string: [],
    integer: [],
    number: [],
    boolean: [],
    date: [],
    datetime: [],
    enum: [],
  };
  for (const t of ALL_FIELD_TYPES) {
    const missing = rows
      .filter((r) => r.by_type[t] === 0)
      .map((r) => r.connector_id)
      .sort();
    connectors_without_type[t] = missing;
  }

  return {
    total_connectors: rows.length,
    total_fields,
    total_required,
    total_optional,
    by_type_totals,
    connectors: rows,
    connectors_without_type,
  };
}
