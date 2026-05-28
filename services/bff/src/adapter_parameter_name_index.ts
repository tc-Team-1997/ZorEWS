// services/bff/src/adapter_parameter_name_index.ts
//
// T6 M14.31 — Adapter operation parameter-name cross-index.
//
// M14.24 ships the operation catalog (8 adapters × N operations ×
// parameters[]). M14.27 pivots operations by HTTP method; M14.28 builds
// the method × adapter matrix; M14.29 the parameter-type × required
// matrix; M14.30 the parameter `in` 1D distribution.
//
// M14.31 lands the INVERTED index: group every parameter across the
// fleet by its `name`, surfacing which operations declare it and — the
// headline value — whether they AGREE on its type and location. Mirror
// of M3.8 (connector schema field cross-index) / M10.13 (notification
// variable index) / M11.16 (dashboard config-key index).
//
// Drives integration-contract hygiene: "customer_id is used by 7
// operations across 5 adapters, all agree it's a string in path — good"
// vs "amount appears as both number and integer (type drift)" or
// "policy_id appears in both path and query (location drift)". Type/
// location drift across adapters is a contract-consistency smell the
// flat M14.30 distribution can't surface.
//
// Platform-static — same response across tenants.

import {
  listAdapterOperationCatalog,
  type ParameterLocation,
  type ParameterType,
} from './adapter_operation_catalog';
import type { AdapterId } from './adapter_health';

// ─── Canonical enums (for stable ordering) ──────────────────────────────

const ALL_PARAMETER_TYPES: readonly ParameterType[] = [
  'string',
  'integer',
  'datetime',
  'enum',
] as const;

const ALL_PARAMETER_LOCATIONS: readonly ParameterLocation[] = [
  'path',
  'query',
  'body',
] as const;

// ─── Public types ──────────────────────────────────────────────────────

export interface ParameterOccurrence {
  adapter_id: AdapterId;
  operation_id: string;
  type: ParameterType;
  in: ParameterLocation;
  required: boolean;
}

export interface ParameterNameEntry {
  name: string;
  /** Total occurrences across every operation in the catalog. */
  reference_count: number;
  /** Distinct types observed (canonical ALL_PARAMETER_TYPES order) —
   *  multi-entry signals TYPE DRIFT. */
  observed_types: ParameterType[];
  /** Distinct locations observed (canonical ALL_PARAMETER_LOCATIONS
   *  order) — multi-entry signals LOCATION DRIFT. */
  observed_locations: ParameterLocation[];
  /** Distinct adapters declaring this parameter name (sorted asc). */
  adapters: AdapterId[];
  /** Per-occurrence detail; sorted adapter_id asc + operation_id asc. */
  occurrences: ParameterOccurrence[];
  /** observed_types.length > 1. */
  has_type_drift: boolean;
  /** observed_locations.length > 1. */
  has_location_drift: boolean;
}

export interface AdapterParameterNameIndex {
  generated_at: string;
  /** Σ occurrences across the catalog (= total parameters). */
  total_parameters: number;
  total_distinct_names: number;
  total_operations: number;
  /** All entries sorted by reference_count desc + name asc tie-break. */
  names: ParameterNameEntry[];
  /** Names used by ≥ 2 operations (reference_count > 1); name asc. */
  shared_names: string[];
  /** Names used by exactly 1 operation — unique / refactor candidates;
   *  name asc. */
  single_use_names: string[];
  /** Names with type OR location drift — contract-consistency warnings;
   *  name asc. */
  drifting_names: string[];
  /** Highest reference_count + canonical name asc tie-break; null on
   *  empty catalog. */
  most_shared_name: { name: string; reference_count: number } | null;
}

// ─── Accumulator ─────────────────────────────────────────────────────────

interface Acc {
  count: number;
  types: Set<ParameterType>;
  locations: Set<ParameterLocation>;
  adapters: Set<AdapterId>;
  occurrences: ParameterOccurrence[];
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildAdapterParameterNameIndex(now: Date): AdapterParameterNameIndex {
  const catalog = listAdapterOperationCatalog();

  const byName = new Map<string, Acc>();
  let total_parameters = 0;
  let total_operations = 0;

  for (const group of catalog.adapters) {
    for (const op of group.operations) {
      total_operations++;
      for (const p of op.parameters) {
        // Defensive: skip out-of-enum type / location.
        if (!ALL_PARAMETER_TYPES.includes(p.type)) continue;
        if (!ALL_PARAMETER_LOCATIONS.includes(p.in)) continue;
        total_parameters++;

        let acc = byName.get(p.name);
        if (!acc) {
          acc = {
            count: 0,
            types: new Set(),
            locations: new Set(),
            adapters: new Set(),
            occurrences: [],
          };
          byName.set(p.name, acc);
        }
        acc.count++;
        acc.types.add(p.type);
        acc.locations.add(p.in);
        acc.adapters.add(group.adapter_id);
        acc.occurrences.push({
          adapter_id: group.adapter_id,
          operation_id: op.operation_id,
          type: p.type,
          in: p.in,
          required: p.required,
        });
      }
    }
  }

  const names: ParameterNameEntry[] = [...byName.entries()].map(([name, acc]) => {
    const observed_types = ALL_PARAMETER_TYPES.filter((t) => acc.types.has(t));
    const observed_locations = ALL_PARAMETER_LOCATIONS.filter((l) => acc.locations.has(l));
    const adapters = [...acc.adapters].sort((a, z) => a.localeCompare(z));
    const occurrences = [...acc.occurrences].sort(
      (a, z) =>
        a.adapter_id.localeCompare(z.adapter_id) ||
        a.operation_id.localeCompare(z.operation_id),
    );
    return {
      name,
      reference_count: acc.count,
      observed_types,
      observed_locations,
      adapters,
      occurrences,
      has_type_drift: observed_types.length > 1,
      has_location_drift: observed_locations.length > 1,
    };
  });

  // Sort: reference_count desc, then name asc.
  names.sort((a, z) => z.reference_count - a.reference_count || a.name.localeCompare(z.name));

  const shared_names = names
    .filter((e) => e.reference_count > 1)
    .map((e) => e.name)
    .sort((a, z) => a.localeCompare(z));
  const single_use_names = names
    .filter((e) => e.reference_count === 1)
    .map((e) => e.name)
    .sort((a, z) => a.localeCompare(z));
  const drifting_names = names
    .filter((e) => e.has_type_drift || e.has_location_drift)
    .map((e) => e.name)
    .sort((a, z) => a.localeCompare(z));

  const most_shared_name =
    names.length > 0
      ? { name: names[0].name, reference_count: names[0].reference_count }
      : null;

  return {
    generated_at: now.toISOString(),
    total_parameters,
    total_distinct_names: names.length,
    total_operations,
    names,
    shared_names,
    single_use_names,
    drifting_names,
    most_shared_name,
  };
}
