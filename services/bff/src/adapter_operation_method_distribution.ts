// services/bff/src/adapter_operation_method_distribution.ts
//
// T6 M14.27 — Adapter operation HTTP method distribution.
//
// M14.24 ships the operation catalog with per-adapter operation
// lists (method + path + parameters). M14.27 lands the orthogonal
// pivot: per HTTP method, count operations across all adapters +
// which adapters expose ≥1 operation in that method.
//
// Use case: the SPA's "API explorer" panel wants a top-line
// breakdown — "we have 35 GETs, 8 POSTs, 2 PATCHes, 1 DELETE
// across all 8 adapters" — without enumerating every row.
//
// Mirror of M5.16 / M11.11 / M3.12 pivot pattern. Pure platform-
// static rollup over the M14.24 catalog.

import {
  listAdapterOperationCatalog,
  type AdapterOperation,
} from './adapter_operation_catalog';
import type { AdapterId } from './adapter_health';

// ─── Constants ────────────────────────────────────────────────────────

export type HttpMethod = AdapterOperation['method'];

export const ALL_HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PATCH',
  'DELETE',
] as const;

const SAMPLE_OPS_CAP = 5;

// ─── Public types ─────────────────────────────────────────────────────

export interface MethodSampleOp {
  adapter_id: AdapterId;
  operation_id: string;
  path: string;
}

export interface MethodDistributionRow {
  method: HttpMethod;
  count: number;
  /** Per-adapter count of operations using this method. Only
   *  adapters with ≥1 operation in this method appear as keys. */
  by_adapter: Partial<Record<AdapterId, number>>;
  distinct_adapters: number;
  /** Up to 5 sample operations in this method. Sorted by
   *  adapter_id asc + path asc for deterministic SPA rendering. */
  sample_operations: MethodSampleOp[];
}

export interface AdapterOperationMethodDistribution {
  generated_at: string;
  total_operations: number;
  /** Every HTTP method in canonical order even when zero-count. */
  methods: MethodDistributionRow[];
  /** Highest-count method. Canonical-order tie-break (GET wins over
   *  POST at same count). null when total_operations=0. */
  most_common_method: HttpMethod | null;
  /** Methods with count=0, in canonical order. */
  unused_methods: HttpMethod[];
}

// ─── Pure resolver ────────────────────────────────────────────────────

interface RowBuilder {
  method: HttpMethod;
  count: number;
  by_adapter: Partial<Record<AdapterId, number>>;
  ops: Array<{ adapter_id: AdapterId; operation_id: string; path: string }>;
}

function emptyBuilder(method: HttpMethod): RowBuilder {
  return { method, count: 0, by_adapter: {}, ops: [] };
}

export function summarizeAdapterOperationsByMethod(
  now: Date,
): AdapterOperationMethodDistribution {
  const catalog = listAdapterOperationCatalog();

  const builders = new Map<HttpMethod, RowBuilder>();
  for (const m of ALL_HTTP_METHODS) builders.set(m, emptyBuilder(m));

  let total = 0;
  for (const group of catalog.adapters) {
    for (const op of group.operations) {
      const b = builders.get(op.method);
      if (!b) continue;
      b.count++;
      total++;
      b.by_adapter[group.adapter_id] = (b.by_adapter[group.adapter_id] ?? 0) + 1;
      b.ops.push({
        adapter_id: group.adapter_id,
        operation_id: op.operation_id,
        path: op.path,
      });
    }
  }

  // Materialise rows in canonical order. Sample-op sort: adapter_id asc + path asc.
  const methods: MethodDistributionRow[] = ALL_HTTP_METHODS.map((m) => {
    const b = builders.get(m)!;
    const sampleSorted = [...b.ops].sort((a, c) => {
      if (a.adapter_id !== c.adapter_id) return a.adapter_id.localeCompare(c.adapter_id);
      return a.path.localeCompare(c.path);
    }).slice(0, SAMPLE_OPS_CAP);
    return {
      method: b.method,
      count: b.count,
      by_adapter: b.by_adapter,
      distinct_adapters: Object.keys(b.by_adapter).length,
      sample_operations: sampleSorted,
    };
  });

  // most_common_method: highest count with canonical tie-break.
  let most_common_method: HttpMethod | null = null;
  let mostCount = 0;
  for (const m of ALL_HTTP_METHODS) {
    const b = builders.get(m)!;
    if (b.count > mostCount) {
      mostCount = b.count;
      most_common_method = m;
    }
  }
  if (mostCount === 0) most_common_method = null;

  const unused_methods = ALL_HTTP_METHODS.filter((m) => builders.get(m)!.count === 0);

  return {
    generated_at: now.toISOString(),
    total_operations: total,
    methods,
    most_common_method,
    unused_methods,
  };
}
