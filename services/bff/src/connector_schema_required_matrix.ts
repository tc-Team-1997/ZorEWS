// services/bff/src/connector_schema_required_matrix.ts
//
// T6 M3.14 — Connector schema field-type × required cross-tab matrix.
//
// M3.2 ships the per-connector schema metadata. M3.11 ships the
// connector × type matrix (which connector uses which types). M3.14
// lands the orthogonal CROSS-CATALOG 2D pivot: across the WHOLE
// schema catalog (every field of every connector), rows = FieldType
// (7 values) × cols = required boolean (2 values: required / optional)
// = 14 cells.
//
// Cells count FIELDS across the catalog — a connector with two
// `string` required fields and one `string` optional field
// contributes 2 to (string, required) and 1 to (string, optional).
//
// Mirror of M7.14 / M5.17 / M13.15 / M14.28 / M3.11 / M8.14 matrix
// pattern. Pure resolver — operates over every schema in the
// M3.2 SCHEMAS catalog (= every M3.1 seed connector). Platform-
// static — same response across tenants.
//
// Drives "what's the required/optional ratio per type?" + "which
// types are exclusively required (operator can't omit them)?" +
// "where are the optional `enum` fields (likely candidates for
// stricter requirement)?".

import {
  listSchemaConnectorIds,
  getConnectorSchema,
  type FieldType,
} from './connector_schema';
import { ALL_FIELD_TYPES } from './connector_schema_type_matrix';

// ─── Public types ─────────────────────────────────────────────────────

export type RequiredColumn = 'required' | 'optional';

export const ALL_REQUIRED_COLUMNS: readonly RequiredColumn[] = ['required', 'optional'];

export interface SchemaRequiredCell {
  type: FieldType;
  required_column: RequiredColumn;
  count: number;
  /** Sample (connector_id, field_name) pairs in this cell — cap 5,
   *  sorted by connector_id asc then field_name asc. */
  samples: Array<{ connector_id: string; field_name: string }>;
}

export interface SchemaTypeRow {
  type: FieldType;
  total: number;
  required_count: number;
  optional_count: number;
  /** required_count / total in [0, 1]; 0 when total=0. */
  required_ratio: number;
}

export interface SchemaRequiredColumnAgg {
  required_column: RequiredColumn;
  total: number;
  /** Per-type breakdown — every FieldType key present at 0 when absent. */
  by_type: Record<FieldType, number>;
}

export interface ConnectorSchemaRequiredMatrix {
  generated_at: string;
  total_connectors: number;
  total_fields: number;
  total_types: number;
  rows: SchemaTypeRow[];
  columns: SchemaRequiredColumnAgg[];
  /** Peak cell — highest count (type, required_column). Canonical
   *  iteration tie-break (types in ALL_FIELD_TYPES order × required
   *  before optional). Null on empty catalog. */
  peak_cell: SchemaRequiredCell | null;
  /** Cells with count=0 (in canonical type × required order). */
  empty_cells: Array<{ type: FieldType; required_column: RequiredColumn }>;
  /** Type with the highest required_ratio (must have ≥ 1 field —
   *  zero-total types don't qualify). Canonical type-order tie-break.
   *  Null on empty catalog. */
  strictest_type: { type: FieldType; required_ratio: number } | null;
  /** Type with the LOWEST required_ratio (loosest — most optional).
   *  Canonical type-order tie-break. Null on empty catalog. */
  loosest_type: { type: FieldType; required_ratio: number } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

const SAMPLE_CAP = 5;

function emptyByType(): Record<FieldType, number> {
  const out: Partial<Record<FieldType, number>> = {};
  for (const t of ALL_FIELD_TYPES) out[t] = 0;
  return out as Record<FieldType, number>;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildConnectorSchemaRequiredMatrix(
  now: Date,
): ConnectorSchemaRequiredMatrix {
  // Per (type, required_column) cell → count + samples buffer.
  const counts = new Map<FieldType, Map<RequiredColumn, number>>();
  const samples = new Map<FieldType, Map<RequiredColumn, Array<{ connector_id: string; field_name: string }>>>();
  for (const t of ALL_FIELD_TYPES) {
    counts.set(t, new Map());
    samples.set(t, new Map());
  }

  let total_fields = 0;
  const connector_ids = listSchemaConnectorIds();

  for (const cid of connector_ids) {
    const schema = getConnectorSchema(cid);
    if (!schema) continue;
    for (const field of schema.fields) {
      if (!ALL_FIELD_TYPES.includes(field.type)) continue;
      const col: RequiredColumn = field.required ? 'required' : 'optional';
      const cInner = counts.get(field.type)!;
      cInner.set(col, (cInner.get(col) ?? 0) + 1);
      const sInner = samples.get(field.type)!;
      const arr = sInner.get(col) ?? [];
      arr.push({ connector_id: cid, field_name: field.name });
      sInner.set(col, arr);
      total_fields++;
    }
  }

  // Rows (type × required + optional sum + ratio).
  const rows: SchemaTypeRow[] = ALL_FIELD_TYPES.map((type) => {
    const cInner = counts.get(type)!;
    const required_count = cInner.get('required') ?? 0;
    const optional_count = cInner.get('optional') ?? 0;
    const total = required_count + optional_count;
    const required_ratio = total > 0 ? required_count / total : 0;
    return { type, total, required_count, optional_count, required_ratio };
  });

  // Columns (required + optional × all types).
  const columns: SchemaRequiredColumnAgg[] = ALL_REQUIRED_COLUMNS.map((col) => {
    const by_type = emptyByType();
    let total = 0;
    for (const t of ALL_FIELD_TYPES) {
      const c = counts.get(t)!.get(col) ?? 0;
      by_type[t] = c;
      total += c;
    }
    return { required_column: col, total, by_type };
  });

  // peak_cell — canonical iteration tie-break (types in
  // ALL_FIELD_TYPES order, required before optional).
  let peak: SchemaRequiredCell | null = null;
  for (const type of ALL_FIELD_TYPES) {
    for (const col of ALL_REQUIRED_COLUMNS) {
      const count = counts.get(type)!.get(col) ?? 0;
      if (count > 0 && (!peak || count > peak.count)) {
        const arr = samples.get(type)!.get(col) ?? [];
        const sorted = [...arr].sort((a, z) => {
          if (a.connector_id !== z.connector_id) return a.connector_id.localeCompare(z.connector_id);
          return a.field_name.localeCompare(z.field_name);
        });
        peak = { type, required_column: col, count, samples: sorted.slice(0, SAMPLE_CAP) };
      }
    }
  }

  // empty_cells canonical row-major (type × required-then-optional).
  const empty_cells: Array<{ type: FieldType; required_column: RequiredColumn }> = [];
  for (const type of ALL_FIELD_TYPES) {
    for (const col of ALL_REQUIRED_COLUMNS) {
      const count = counts.get(type)!.get(col) ?? 0;
      if (count === 0) empty_cells.push({ type, required_column: col });
    }
  }

  // strictest_type — highest required_ratio among types with total > 0.
  // Canonical ALL_FIELD_TYPES order tie-break via strict `>` iteration.
  let strictest: SchemaTypeRow | null = null;
  for (const row of rows) {
    if (row.total === 0) continue;
    if (!strictest || row.required_ratio > strictest.required_ratio) {
      strictest = row;
    }
  }
  const strictest_type = strictest
    ? { type: strictest.type, required_ratio: strictest.required_ratio }
    : null;

  // loosest_type — lowest required_ratio among types with total > 0.
  // Canonical ALL_FIELD_TYPES order tie-break via strict `<` iteration.
  let loosest: SchemaTypeRow | null = null;
  for (const row of rows) {
    if (row.total === 0) continue;
    if (!loosest || row.required_ratio < loosest.required_ratio) {
      loosest = row;
    }
  }
  const loosest_type = loosest
    ? { type: loosest.type, required_ratio: loosest.required_ratio }
    : null;

  return {
    generated_at: now.toISOString(),
    total_connectors: connector_ids.length,
    total_fields,
    total_types: ALL_FIELD_TYPES.length,
    rows,
    columns,
    peak_cell: peak,
    empty_cells,
    strictest_type,
    loosest_type,
  };
}
