// services/bff/src/adapter_parameter_location_distribution.ts
//
// T6 M14.30 — Adapter operation parameter `in` distribution.
//
// M14.24 ships the adapter operation catalog: 8 adapters × N operations
// × parameters[] where each parameter carries `in: 'path'|'query'|'body'`.
// M14.27 ships the HTTP-method 1D distribution; M14.28 the method ×
// adapter matrix; M14.29 the parameter-type × required matrix.
//
// M14.30 lands the orthogonal axis: pivot every parameter across the
// fleet by `in` location. Mirror of M14.27 1D distribution pattern.
//
// 3 canonical ParameterLocation rows (path → query → body). Every key
// always emitted even when zero — stable SPA grid.
//
// Per-row:
//   {location, count, by_adapter (compact — only adapters with > 0 in
//    this `in` appear), by_method (compact), by_type (4-key Record at 0
//    when absent: string/integer/datetime/enum), required_count,
//    optional_count, sample_operations (cap 5; sorted adapter_id asc +
//    operation_id asc for deterministic SPA rendering)}
//
// Envelope:
//   {generated_at, total_operations, total_parameters, locations[] in
//    canonical order, most_common_location (canonical iteration
//    tie-break: path wins over query at tied), unused_locations[]
//    (zero-count subset in canonical order)}
//
// Platform-static — same response across tenants.

import {
  listAdapterOperationCatalog,
  type ParameterLocation,
  type ParameterType,
  type AdapterOperation,
} from './adapter_operation_catalog';
import type { AdapterId } from './adapter_health';

// ─── Canonical enums ───────────────────────────────────────────────────

export const ALL_PARAMETER_LOCATIONS: readonly ParameterLocation[] = [
  'path',
  'query',
  'body',
] as const;

const ALL_PARAMETER_TYPES: readonly ParameterType[] = [
  'string',
  'integer',
  'datetime',
  'enum',
] as const;

const ALL_HTTP_METHODS: readonly AdapterOperation['method'][] = [
  'GET',
  'POST',
  'PATCH',
  'DELETE',
] as const;

// ─── Public types ──────────────────────────────────────────────────────

export interface AdapterParameterLocationSample {
  adapter_id: AdapterId;
  operation_id: string;
  parameter_name: string;
  parameter_type: ParameterType;
  required: boolean;
}

export interface AdapterParameterLocationRow {
  location: ParameterLocation;
  count: number;
  /** Per-adapter counts — only adapters with > 0 parameters in this
   *  location appear as keys. */
  by_adapter: Partial<Record<AdapterId, number>>;
  /** Per-method counts — only methods with > 0 parameters in this
   *  location appear as keys. */
  by_method: Partial<Record<AdapterOperation['method'], number>>;
  /** Per-type counts; every ParameterType present at 0 when absent. */
  by_type: Record<ParameterType, number>;
  /** Required / optional split (required_count + optional_count = count). */
  required_count: number;
  optional_count: number;
  /** Distinct adapters with > 0 parameters in this location. */
  distinct_adapters: number;
  /** Sample (cap 5; sorted adapter_id asc + operation_id asc + parameter_name asc). */
  sample_parameters: AdapterParameterLocationSample[];
}

export interface AdapterParameterLocationDistribution {
  generated_at: string;
  total_operations: number;
  total_parameters: number;
  locations: AdapterParameterLocationRow[];
  /** Highest count + canonical iteration tie-break. Null on empty catalog. */
  most_common_location: ParameterLocation | null;
  /** Zero-count locations in canonical order. */
  unused_locations: ParameterLocation[];
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByType(): Record<ParameterType, number> {
  const out = {} as Record<ParameterType, number>;
  for (const t of ALL_PARAMETER_TYPES) out[t] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function summarizeAdapterParameterLocations(
  now: Date,
): AdapterParameterLocationDistribution {
  const catalog = listAdapterOperationCatalog();

  // Accumulators per location.
  const counts: Record<ParameterLocation, number> = {
    path: 0,
    query: 0,
    body: 0,
  };
  const requiredCounts: Record<ParameterLocation, number> = {
    path: 0,
    query: 0,
    body: 0,
  };
  const byAdapter: Record<ParameterLocation, Map<AdapterId, number>> = {
    path: new Map(),
    query: new Map(),
    body: new Map(),
  };
  const byMethod: Record<ParameterLocation, Map<AdapterOperation['method'], number>> = {
    path: new Map(),
    query: new Map(),
    body: new Map(),
  };
  const byType: Record<ParameterLocation, Record<ParameterType, number>> = {
    path: emptyByType(),
    query: emptyByType(),
    body: emptyByType(),
  };

  interface SampleCandidate extends AdapterParameterLocationSample {}
  const candidates: Record<ParameterLocation, SampleCandidate[]> = {
    path: [],
    query: [],
    body: [],
  };

  let total_parameters = 0;
  let total_operations = 0;

  for (const group of catalog.adapters) {
    for (const op of group.operations) {
      total_operations++;
      for (const p of op.parameters) {
        if (!ALL_PARAMETER_LOCATIONS.includes(p.in)) continue;
        const loc = p.in;
        counts[loc]++;
        total_parameters++;
        if (p.required) requiredCounts[loc]++;
        // by_adapter
        byAdapter[loc].set(
          group.adapter_id,
          (byAdapter[loc].get(group.adapter_id) ?? 0) + 1,
        );
        // by_method
        byMethod[loc].set(
          op.method,
          (byMethod[loc].get(op.method) ?? 0) + 1,
        );
        // by_type — defensive against catalog drift.
        if (ALL_PARAMETER_TYPES.includes(p.type)) {
          byType[loc][p.type]++;
        }
        // Sample candidate.
        candidates[loc].push({
          adapter_id: group.adapter_id,
          operation_id: op.operation_id,
          parameter_name: p.name,
          parameter_type: p.type,
          required: p.required,
        });
      }
    }
  }

  // Build rows in canonical order.
  const locations: AdapterParameterLocationRow[] = ALL_PARAMETER_LOCATIONS.map(
    (loc) => {
      // Sort sample candidates: adapter_id asc, operation_id asc,
      // parameter_name asc — stable + deterministic.
      const sorted = candidates[loc].slice().sort((a, b) => {
        if (a.adapter_id !== b.adapter_id) {
          return a.adapter_id < b.adapter_id ? -1 : 1;
        }
        if (a.operation_id !== b.operation_id) {
          return a.operation_id < b.operation_id ? -1 : 1;
        }
        return a.parameter_name < b.parameter_name
          ? -1
          : a.parameter_name > b.parameter_name
          ? 1
          : 0;
      });

      const adapterRecord: Partial<Record<AdapterId, number>> = {};
      for (const [aid, c] of byAdapter[loc]) {
        adapterRecord[aid] = c;
      }

      const methodRecord: Partial<Record<AdapterOperation['method'], number>> = {};
      for (const [m, c] of byMethod[loc]) {
        methodRecord[m] = c;
      }

      return {
        location: loc,
        count: counts[loc],
        by_adapter: adapterRecord,
        by_method: methodRecord,
        by_type: { ...byType[loc] },
        required_count: requiredCounts[loc],
        optional_count: counts[loc] - requiredCounts[loc],
        distinct_adapters: byAdapter[loc].size,
        sample_parameters: sorted.slice(0, 5),
      };
    },
  );

  // most_common_location — canonical iteration tie-break.
  let most_common_location: ParameterLocation | null = null;
  let peak = 0;
  for (const loc of ALL_PARAMETER_LOCATIONS) {
    if (counts[loc] > peak) {
      peak = counts[loc];
      most_common_location = loc;
    }
  }
  if (peak === 0) most_common_location = null;

  // unused_locations — canonical-order zero-count subset.
  const unused_locations = ALL_PARAMETER_LOCATIONS.filter(
    (loc) => counts[loc] === 0,
  );

  return {
    generated_at: now.toISOString(),
    total_operations,
    total_parameters,
    locations,
    most_common_location,
    unused_locations,
  };
}
