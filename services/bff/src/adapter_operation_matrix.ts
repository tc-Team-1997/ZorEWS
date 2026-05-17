// services/bff/src/adapter_operation_matrix.ts
//
// T6 M14.28 — Adapter operation method × adapter cross-tab matrix.
//
// M14.24 ships the per-adapter operation catalog. M14.27 ships the
// 1D pivot by HTTP method (which method has the most operations
// across the fleet?). M14.28 lands the orthogonal 2D cross-tab:
// rows = HTTP method, cols = adapter — answers "which adapters expose
// PATCH endpoints?" + "where are the gaps in DELETE coverage?".
//
// Mirror of M3.11 (connector schema type-matrix) + M9.13 (investigation
// age × status matrix) for the adapter operation surface.
//
// Pure resolver — operates entirely over the M14.24 hand-curated
// catalog. Platform-static — same response across tenants.

import type { AdapterId } from './adapter_health';
import {
  ALL_HTTP_METHODS,
  type HttpMethod,
} from './adapter_operation_method_distribution';
import {
  listAdapterOperationCatalog,
  type AdapterOperationGroup,
} from './adapter_operation_catalog';

// ─── Public types ─────────────────────────────────────────────────────

/** A single cell {method, adapter, count}. count is the number of
 *  operations on this adapter using this method. */
export interface MethodAdapterCell {
  method: HttpMethod;
  adapter_id: AdapterId;
  count: number;
}

/** Row in the matrix — one HTTP method × all adapters. */
export interface MethodRow {
  method: HttpMethod;
  /** Total count across all adapters for this method. */
  total: number;
  /** Per-adapter count map — every AdapterId key present at 0 when
   *  absent for stable grid rendering. */
  by_adapter: Record<AdapterId, number>;
  /** Adapter ids with 0 operations for this method — coverage-gap
   *  list per method. Sorted asc. */
  adapters_without: AdapterId[];
}

/** Column in the matrix — one adapter × all HTTP methods. */
export interface AdapterColumn {
  adapter_id: AdapterId;
  label: string;
  base_path: string;
  total: number;
  by_method: Record<HttpMethod, number>;
  /** HTTP methods this adapter does NOT support — coverage-gap list
   *  per adapter. Sorted in canonical ALL_HTTP_METHODS order. */
  methods_without: HttpMethod[];
}

export interface AdapterOperationMatrixSummary {
  generated_at: string;
  total_adapters: number;
  total_operations: number;
  rows: MethodRow[];
  columns: AdapterColumn[];
  /** Peak cell — highest count (method, adapter) pair. Canonical
   *  iteration tie-break (rows in ALL_HTTP_METHODS order, cols in
   *  catalog order). null when total_operations=0. */
  peak_cell: MethodAdapterCell | null;
  /** Cells with count=0 — gap list. Sorted by canonical method order
   *  then adapter_id asc within. */
  empty_cells: MethodAdapterCell[];
  /** Adapter with the most methods supported (= total non-zero
   *  by_method entries). Canonical adapter_id asc tie-break. null
   *  when zero operations across the fleet. */
  most_versatile_adapter: { adapter_id: AdapterId; methods_supported: number } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByAdapter(adapter_ids: readonly AdapterId[]): Record<AdapterId, number> {
  const out: Partial<Record<AdapterId, number>> = {};
  for (const id of adapter_ids) out[id] = 0;
  return out as Record<AdapterId, number>;
}

function emptyByMethod(): Record<HttpMethod, number> {
  const out: Partial<Record<HttpMethod, number>> = {};
  for (const m of ALL_HTTP_METHODS) out[m] = 0;
  return out as Record<HttpMethod, number>;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildAdapterOperationMatrix(now: Date): AdapterOperationMatrixSummary {
  const catalog = listAdapterOperationCatalog();
  const adapters: AdapterOperationGroup[] = catalog.adapters;
  const adapter_ids = adapters.map((a) => a.adapter_id);

  // Build per-(method, adapter) count map by scanning the catalog
  // operations once.
  const cellCount = new Map<HttpMethod, Map<AdapterId, number>>();
  for (const method of ALL_HTTP_METHODS) {
    cellCount.set(method, new Map());
  }
  let total_operations = 0;
  for (const adapter of adapters) {
    for (const op of adapter.operations) {
      total_operations++;
      const methodMap = cellCount.get(op.method)!;
      methodMap.set(adapter.adapter_id, (methodMap.get(adapter.adapter_id) ?? 0) + 1);
    }
  }

  // Build rows (methods × all adapters).
  const rows: MethodRow[] = ALL_HTTP_METHODS.map((method) => {
    const methodMap = cellCount.get(method)!;
    const by_adapter = emptyByAdapter(adapter_ids);
    let total = 0;
    for (const id of adapter_ids) {
      const count = methodMap.get(id) ?? 0;
      by_adapter[id] = count;
      total += count;
    }
    const adapters_without = adapter_ids
      .filter((id) => by_adapter[id] === 0)
      .sort((a, z) => a.localeCompare(z));
    return { method, total, by_adapter, adapters_without };
  });

  // Build columns (adapters × all methods).
  const columns: AdapterColumn[] = adapters.map((adapter) => {
    const by_method = emptyByMethod();
    let total = 0;
    for (const method of ALL_HTTP_METHODS) {
      const count = cellCount.get(method)!.get(adapter.adapter_id) ?? 0;
      by_method[method] = count;
      total += count;
    }
    // methods_without: keep canonical order via ALL_HTTP_METHODS
    // iteration (not alphabetical — readers expect GET / POST / PATCH /
    // DELETE order).
    const methods_without = ALL_HTTP_METHODS.filter((m) => by_method[m] === 0);
    return {
      adapter_id: adapter.adapter_id,
      label: adapter.label,
      base_path: adapter.base_path,
      total,
      by_method,
      methods_without,
    };
  });

  // peak_cell: highest count via canonical iteration tie-break.
  let peak: MethodAdapterCell | null = null;
  for (const method of ALL_HTTP_METHODS) {
    for (const id of adapter_ids) {
      const count = cellCount.get(method)!.get(id) ?? 0;
      if (count > 0 && (!peak || count > peak.count)) {
        peak = { method, adapter_id: id, count };
      }
    }
  }

  // empty_cells: zero-count pairs, canonical method order × adapter
  // order via iteration.
  const empty_cells: MethodAdapterCell[] = [];
  for (const method of ALL_HTTP_METHODS) {
    for (const id of [...adapter_ids].sort((a, z) => a.localeCompare(z))) {
      const count = cellCount.get(method)!.get(id) ?? 0;
      if (count === 0) empty_cells.push({ method, adapter_id: id, count: 0 });
    }
  }

  // most_versatile_adapter: adapter with most NON-ZERO by_method
  // entries (=method coverage span); canonical adapter_id asc tie-break.
  let most_versatile: AdapterColumn | null = null;
  let bestSupport = 0;
  for (const col of columns) {
    const supported = ALL_HTTP_METHODS.filter((m) => col.by_method[m] > 0).length;
    if (supported > bestSupport) {
      bestSupport = supported;
      most_versatile = col;
    }
  }
  const most_versatile_adapter = most_versatile
    ? { adapter_id: most_versatile.adapter_id, methods_supported: bestSupport }
    : null;

  return {
    generated_at: now.toISOString(),
    total_adapters: adapters.length,
    total_operations,
    rows,
    columns,
    peak_cell: peak,
    empty_cells,
    most_versatile_adapter,
  };
}
