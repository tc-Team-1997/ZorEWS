// services/bff/src/adapter_param_type_required_matrix.ts
//
// T6 M14.29 — Adapter operation parameter type × required cross-tab.
//
// M14.24 ships the operation catalog (per-adapter operations + each
// operation's parameters). M14.27 ships HTTP method distribution.
// M14.28 ships method × adapter matrix. M14.29 lands the 2D pivot
// over EVERY PARAMETER across the catalog: rows = 4 ParameterType
// (string / integer / datetime / enum) × cols = 2 required boolean
// (required / optional) = 8 cells.
//
// Mirror of M3.14 (connector schema field-type × required) for the
// adapter operation catalog surface. Pure resolver — operates over
// the hand-curated M14.24 catalog. Platform-static.
//
// Drives "are most adapter params required or optional? do enums skew
// to required? which adapter has the most string params?".

import {
  listAdapterOperationCatalog,
  type ParameterType,
} from './adapter_operation_catalog';
import type { AdapterId } from './adapter_health';

// ─── Canonical enum order ─────────────────────────────────────────────

export const ALL_PARAMETER_TYPES: readonly ParameterType[] = [
  'string',
  'integer',
  'datetime',
  'enum',
] as const;

export type RequiredColumn = 'required' | 'optional';

export const ALL_REQUIRED_COLUMNS: readonly RequiredColumn[] = ['required', 'optional'];

// ─── Public types ─────────────────────────────────────────────────────

export interface AdapterParamCell {
  type: ParameterType;
  required_column: RequiredColumn;
  count: number;
  /** Sample (adapter_id, operation_id, parameter_name) triples in
   *  this cell — cap 5, sorted (adapter_id asc, operation_id asc,
   *  name asc). */
  samples: Array<{
    adapter_id: AdapterId;
    operation_id: string;
    parameter_name: string;
  }>;
}

export interface AdapterParamTypeRow {
  type: ParameterType;
  total: number;
  required_count: number;
  optional_count: number;
  /** required_count / total in [0, 1]; 0 when total=0. */
  required_ratio: number;
}

export interface AdapterParamRequiredColumn {
  required_column: RequiredColumn;
  total: number;
  by_type: Record<ParameterType, number>;
}

export interface AdapterParamTypeRequiredMatrix {
  generated_at: string;
  total_adapters: number;
  total_operations: number;
  total_parameters: number;
  rows: AdapterParamTypeRow[];
  columns: AdapterParamRequiredColumn[];
  /** Peak cell — highest count (type, required_column). Canonical
   *  iteration tie-break (types in ALL_PARAMETER_TYPES order, then
   *  required before optional). null when catalog has zero parameters. */
  peak_cell: AdapterParamCell | null;
  /** Cells with count=0 in canonical row-major order. */
  empty_cells: Array<{ type: ParameterType; required_column: RequiredColumn }>;
  /** Type with the highest required_ratio (most "always required").
   *  Canonical type-order tie-break. null when catalog has zero params. */
  strictest_type: { type: ParameterType; required_ratio: number } | null;
  /** Type with the lowest required_ratio (most-often optional).
   *  Canonical type-order tie-break. null when catalog has zero params. */
  loosest_type: { type: ParameterType; required_ratio: number } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

const SAMPLE_CAP = 5;

function emptyByType(): Record<ParameterType, number> {
  const out: Partial<Record<ParameterType, number>> = {};
  for (const t of ALL_PARAMETER_TYPES) out[t] = 0;
  return out as Record<ParameterType, number>;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildAdapterParamTypeRequiredMatrix(
  now: Date,
): AdapterParamTypeRequiredMatrix {
  const catalog = listAdapterOperationCatalog();

  // Per (type, required_col) cell → count + samples buffer.
  const counts = new Map<ParameterType, Map<RequiredColumn, number>>();
  const samples = new Map<
    ParameterType,
    Map<RequiredColumn, Array<{ adapter_id: AdapterId; operation_id: string; parameter_name: string }>>
  >();
  for (const t of ALL_PARAMETER_TYPES) {
    counts.set(t, new Map());
    samples.set(t, new Map());
  }

  let total_parameters = 0;
  for (const adapter of catalog.adapters) {
    for (const op of adapter.operations) {
      for (const param of op.parameters) {
        if (!ALL_PARAMETER_TYPES.includes(param.type)) continue;
        const col: RequiredColumn = param.required ? 'required' : 'optional';
        const cInner = counts.get(param.type)!;
        cInner.set(col, (cInner.get(col) ?? 0) + 1);
        const sInner = samples.get(param.type)!;
        const arr = sInner.get(col) ?? [];
        arr.push({
          adapter_id: adapter.adapter_id,
          operation_id: op.operation_id,
          parameter_name: param.name,
        });
        sInner.set(col, arr);
        total_parameters++;
      }
    }
  }

  // Rows (type × required + optional sum + ratio).
  const rows: AdapterParamTypeRow[] = ALL_PARAMETER_TYPES.map((type) => {
    const cInner = counts.get(type)!;
    const required_count = cInner.get('required') ?? 0;
    const optional_count = cInner.get('optional') ?? 0;
    const total = required_count + optional_count;
    const required_ratio = total > 0 ? required_count / total : 0;
    return { type, total, required_count, optional_count, required_ratio };
  });

  // Columns (required + optional × all types).
  const columns: AdapterParamRequiredColumn[] = ALL_REQUIRED_COLUMNS.map((col) => {
    const by_type = emptyByType();
    let total = 0;
    for (const t of ALL_PARAMETER_TYPES) {
      const c = counts.get(t)!.get(col) ?? 0;
      by_type[t] = c;
      total += c;
    }
    return { required_column: col, total, by_type };
  });

  // peak_cell — canonical iteration tie-break.
  let peak: AdapterParamCell | null = null;
  for (const t of ALL_PARAMETER_TYPES) {
    for (const col of ALL_REQUIRED_COLUMNS) {
      const count = counts.get(t)!.get(col) ?? 0;
      if (count > 0 && (!peak || count > peak.count)) {
        const arr = samples.get(t)!.get(col) ?? [];
        const sorted = [...arr].sort((a, z) => {
          if (a.adapter_id !== z.adapter_id) return a.adapter_id.localeCompare(z.adapter_id);
          if (a.operation_id !== z.operation_id) return a.operation_id.localeCompare(z.operation_id);
          return a.parameter_name.localeCompare(z.parameter_name);
        });
        peak = { type: t, required_column: col, count, samples: sorted.slice(0, SAMPLE_CAP) };
      }
    }
  }

  // empty_cells canonical row-major.
  const empty_cells: Array<{ type: ParameterType; required_column: RequiredColumn }> = [];
  for (const t of ALL_PARAMETER_TYPES) {
    for (const col of ALL_REQUIRED_COLUMNS) {
      const count = counts.get(t)!.get(col) ?? 0;
      if (count === 0) empty_cells.push({ type: t, required_column: col });
    }
  }

  // strictest_type — highest required_ratio among types with total > 0.
  let strictest: AdapterParamTypeRow | null = null;
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
  let loosest: AdapterParamTypeRow | null = null;
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
    total_adapters: catalog.adapters.length,
    total_operations: catalog.total_operations,
    total_parameters,
    rows,
    columns,
    peak_cell: peak,
    empty_cells,
    strictest_type,
    loosest_type,
  };
}
