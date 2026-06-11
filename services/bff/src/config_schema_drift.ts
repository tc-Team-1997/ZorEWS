// services/bff/src/config_schema_drift.ts
//
// T6 M13.24 — Config schema version drift detection.
//
// For each key in DEFAULTS schema, check if the tenant's effective value
// type matches the declared schema type. An override is "drifted" if
// the stored value's JS typeof doesn't match the declared type.
//
// Mapping: 'number' → typeof === 'number'; 'string' → 'string';
//          'boolean' → 'boolean'; 'json' → 'object' (but not null/array)
//
// Route: GET /v1/admin/config/schema-drift
//   RBAC: audit:read (admin)

import { DEFAULTS, defaultConfigStore, type ConfigStore, type ConfigDef } from './admin_config';

// ─── Public types ─────────────────────────────────────────────────────

export interface DriftedKey {
  key: string;
  declared_type: string;
  effective_type: string;
  is_drifted: boolean;
  value: unknown;
}

export interface ConfigSchemaDriftReport {
  generated_at: string;
  total_keys: number;
  drifted_keys: DriftedKey[];
  schema_healthy: boolean;
}

function effectiveType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isDrifted(def: ConfigDef, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const declared = def.type;
  const actual = effectiveType(value);

  if (declared === 'number') return actual !== 'number';
  if (declared === 'string') return actual !== 'string';
  if (declared === 'boolean') return actual !== 'boolean';
  if (declared === 'json') return actual !== 'object'; // object but not null/array
  return false;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function detectConfigSchemaDrift(
  store: ConfigStore,
  tenant_id: string,
  now: Date,
): ConfigSchemaDriftReport {
  if (!tenant_id) throw new Error('tenant_id is required');

  const entries = store.list(tenant_id);
  const entryMap = new Map(entries.map((e) => [e.key, e]));

  const drifted_keys: DriftedKey[] = [];

  for (const def of DEFAULTS) {
    const entry = entryMap.get(def.key);
    // Only check overrides (non-default values)
    if (!entry || entry.is_default) continue;

    const value = entry.value;
    const drifted = isDrifted(def, value);

    if (drifted) {
      drifted_keys.push({
        key: def.key,
        declared_type: def.type,
        effective_type: effectiveType(value),
        is_drifted: true,
        value,
      });
    }
  }

  return {
    generated_at: now.toISOString(),
    total_keys: DEFAULTS.length,
    drifted_keys,
    schema_healthy: drifted_keys.length === 0,
  };
}
