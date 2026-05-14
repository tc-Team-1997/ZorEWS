// services/bff/src/connector_schema_field_index.ts
//
// T6 M3.8 — Connector schema field cross-index.
//
// M3.2 ships per-connector schemas. M3.7 emits per-connector source-
// maps (platform vs tenant_addition annotation). M3.8 is the
// orthogonal cross-cut: an INVERTED index over every connector's
// fields. Answers "which connectors use a field called `customer_id`?"
// and "how many connectors share a `loan_id` field, and do they
// agree on its type?" — useful for a dataops integrity-audit
// dashboard that flags accidental schema drift across connectors
// expected to share a common identifier.
//
// Pure aggregation, no I/O. Caller passes the list of connector ids
// (from M3.1 `listConnectorIds`) + a schema lookup function (the
// M3.2 `getConnectorSchema`).

import type { ConnectorSchema, FieldType } from './connector_schema';

// ─── Public types ─────────────────────────────────────────────────────

export interface FieldIndexEntry {
  field_name: string;
  /** Distinct types observed under this field name. Single-entry array
   *  in the happy case; multi-entry signals schema drift (which the
   *  SPA can surface in red). Sorted asc. */
  observed_types: FieldType[];
  /** Connectors carrying this field, sorted asc. */
  connector_ids: string[];
  /** Total occurrence count — equals `connector_ids.length` since a
   *  field name appears at most once per connector schema. */
  observed_count: number;
}

export interface ConnectorSchemaFieldIndex {
  total_connectors_scanned: number;
  total_unique_field_names: number;
  /** Entries sorted by `observed_count` desc with `field_name` asc
   *  tie-break — shared fields surface first for the integrity-audit
   *  dashboard. */
  entries: FieldIndexEntry[];
}

// ─── Pure indexer ─────────────────────────────────────────────────────

interface Acc {
  field_name: string;
  types: Set<FieldType>;
  connectors: Set<string>;
}

/**
 * Builds the inverted field-name → connector_ids index. Connectors
 * with no schema (lookup returns null) are silently skipped — the
 * existing M3.2 catalog has full coverage but a defensive null check
 * keeps the function safe under future re-orgs.
 */
export function indexConnectorSchemaFields(
  connector_ids: readonly string[],
  getSchema: (id: string) => ConnectorSchema | null,
): ConnectorSchemaFieldIndex {
  const byName = new Map<string, Acc>();
  let scanned = 0;
  for (const id of connector_ids) {
    const schema = getSchema(id);
    if (!schema) continue;
    scanned += 1;
    for (const field of schema.fields) {
      let acc = byName.get(field.name);
      if (!acc) {
        acc = {
          field_name: field.name,
          types: new Set<FieldType>(),
          connectors: new Set<string>(),
        };
        byName.set(field.name, acc);
      }
      acc.types.add(field.type);
      acc.connectors.add(id);
    }
  }

  const entries: FieldIndexEntry[] = [];
  for (const acc of byName.values()) {
    const connector_ids_sorted = [...acc.connectors].sort();
    entries.push({
      field_name: acc.field_name,
      observed_types: [...acc.types].sort(),
      connector_ids: connector_ids_sorted,
      observed_count: connector_ids_sorted.length,
    });
  }
  entries.sort((a, b) => {
    if (b.observed_count !== a.observed_count) return b.observed_count - a.observed_count;
    return a.field_name < b.field_name ? -1 : a.field_name > b.field_name ? 1 : 0;
  });

  return {
    total_connectors_scanned: scanned,
    total_unique_field_names: entries.length,
    entries,
  };
}
