// services/bff/src/config_bulk.ts
//
// T6 M13.4 — Bulk config import/export.
//
// M13.1-13.3 ship the per-key config registry + audit + rollback.
// M13.4 ships the bulk-export shape (snapshot all overrides into
// a single JSON document the SPA can save as a `.json` file or
// import into another tenant for cloning) plus a bulk-import
// that applies a snapshot to the current tenant.
//
// Import semantics:
//   - dry_run=true  → returns a summary of what WOULD change
//                     without mutating the store
//   - dry_run=false → applies the snapshot via configStore.set
//                     for each entry; existing values for keys NOT
//                     in the snapshot are PRESERVED (additive merge)
//   - keys not in the platform schema are reported as `skipped`
//     (per-key) and don't fail the whole import.

import { type ConfigStore, type ConfigValue, ConfigValidationError } from './admin_config';

// ─── M13.5 — Config diff between tenants ─────────────────────────────

export type DiffKeyStatus = 'same' | 'a_only' | 'b_only' | 'different';

export interface ConfigDiffEntry {
  key: string;
  status: DiffKeyStatus;
  /** Override value for tenant A (null when default OR a_only doesn't apply). */
  value_a: ConfigValue | null;
  value_b: ConfigValue | null;
  is_default_a: boolean;
  is_default_b: boolean;
}

export interface ConfigDiffResult {
  tenant_a: string;
  tenant_b: string;
  generated_at: string;
  /** Every schema key, regardless of override status, in declared order. */
  entries: ConfigDiffEntry[];
  /** Filtered subset where status !== 'same'. */
  changed_entries: ConfigDiffEntry[];
  /** Aggregate counters. */
  same_count: number;
  a_only_count: number;
  b_only_count: number;
  different_count: number;
}

function valuesEqual(a: ConfigValue, b: ConfigValue): boolean {
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

export function diffTenantConfig(
  configStore: ConfigStore,
  tenant_a: string,
  tenant_b: string,
  now: Date,
): ConfigDiffResult {
  if (!tenant_a || typeof tenant_a !== 'string') {
    throw new ConfigBulkError('invalid_input', 'tenant_a is required');
  }
  if (!tenant_b || typeof tenant_b !== 'string') {
    throw new ConfigBulkError('invalid_input', 'tenant_b is required');
  }
  if (tenant_a === tenant_b) {
    throw new ConfigBulkError('invalid_input', 'tenant_a and tenant_b must differ');
  }
  const aEntries = configStore.list(tenant_a);
  const bEntries = configStore.list(tenant_b);
  const bByKey = new Map(bEntries.map((e) => [e.key, e]));

  const entries: ConfigDiffEntry[] = [];
  for (const a of aEntries) {
    const b = bByKey.get(a.key);
    if (!b) continue; // platform schema is shared; this should never happen
    let status: DiffKeyStatus;
    if (a.is_default && b.is_default) {
      status = 'same';
    } else if (!a.is_default && b.is_default) {
      status = 'a_only';
    } else if (a.is_default && !b.is_default) {
      status = 'b_only';
    } else {
      // both have overrides — same value or different?
      status = valuesEqual(a.value, b.value) ? 'same' : 'different';
    }
    entries.push({
      key: a.key,
      status,
      value_a: a.is_default ? null : a.value,
      value_b: b.is_default ? null : b.value,
      is_default_a: a.is_default,
      is_default_b: b.is_default,
    });
  }

  const changed_entries = entries.filter((e) => e.status !== 'same');

  return {
    tenant_a,
    tenant_b,
    generated_at: now.toISOString(),
    entries,
    changed_entries,
    same_count: entries.filter((e) => e.status === 'same').length,
    a_only_count: entries.filter((e) => e.status === 'a_only').length,
    b_only_count: entries.filter((e) => e.status === 'b_only').length,
    different_count: entries.filter((e) => e.status === 'different').length,
  };
}

// ─── M13.6 — Clone tenant config ─────────────────────────────────────

/**
 * Pure composition of exportConfig + importConfig: snapshot the
 * source tenant's overrides, apply them to the target tenant.
 * Reuses importConfig's per-key skipped/applied/unchanged shape.
 */
export function cloneTenantConfig(
  configStore: ConfigStore,
  source_tenant_id: string,
  target_tenant_id: string,
  applied_by: string,
  dry_run: boolean,
  now: Date,
): ImportSummary {
  if (!source_tenant_id || typeof source_tenant_id !== 'string') {
    throw new ConfigBulkError('invalid_input', 'source_tenant_id required');
  }
  if (!target_tenant_id || typeof target_tenant_id !== 'string') {
    throw new ConfigBulkError('invalid_input', 'target_tenant_id required');
  }
  if (source_tenant_id === target_tenant_id) {
    throw new ConfigBulkError(
      'invalid_input',
      'source and target tenants must differ',
    );
  }
  const snapshot = exportConfig(configStore, source_tenant_id, now);
  return importConfig(
    configStore,
    target_tenant_id,
    snapshot,
    applied_by,
    dry_run,
    now,
  );
}

// ─── M13.7 — Selective-key clone ─────────────────────────────────────

export interface SelectiveCloneSummary extends ImportSummary {
  /** Keys requested by the caller that were NOT in the source's
   *  overrides (so nothing to copy). Reported back so the operator
   *  can fix typos / understand what was a no-op. */
  not_in_source: string[];
  /** Echo of the keys filter the caller supplied. */
  requested_keys: string[];
}

/**
 * Like cloneTenantConfig but copies ONLY the listed keys. Useful when
 * the operator wants to migrate a subset of tunables (e.g. just the
 * threshold overrides, not the channel toggles) from one tenant to
 * another. Keys in the filter that are NOT in the source's overrides
 * are reported under `not_in_source` rather than skipped — they're
 * not errors, just no-ops.
 *
 * Validates: source ≠ target; keys is a non-empty array of non-empty
 * strings; cap 100 keys; no duplicates within the filter.
 */
export function cloneTenantConfigSelective(
  configStore: ConfigStore,
  source_tenant_id: string,
  target_tenant_id: string,
  keys: readonly unknown[],
  applied_by: string,
  dry_run: boolean,
  now: Date,
): SelectiveCloneSummary {
  if (!source_tenant_id || typeof source_tenant_id !== 'string') {
    throw new ConfigBulkError('invalid_input', 'source_tenant_id required');
  }
  if (!target_tenant_id || typeof target_tenant_id !== 'string') {
    throw new ConfigBulkError('invalid_input', 'target_tenant_id required');
  }
  if (source_tenant_id === target_tenant_id) {
    throw new ConfigBulkError(
      'invalid_input',
      'source and target tenants must differ',
    );
  }
  if (!Array.isArray(keys)) {
    throw new ConfigBulkError('invalid_input', 'keys must be an array');
  }
  if (keys.length === 0) {
    throw new ConfigBulkError('invalid_input', 'keys cannot be empty');
  }
  if (keys.length > 100) {
    throw new ConfigBulkError('invalid_input', 'keys cap is 100');
  }
  const seen = new Set<string>();
  const requested: string[] = [];
  for (const k of keys) {
    if (typeof k !== 'string' || !k.trim()) {
      throw new ConfigBulkError(
        'invalid_input',
        'keys must be non-empty strings',
      );
    }
    const trimmed = k.trim();
    if (seen.has(trimmed)) {
      throw new ConfigBulkError(
        'invalid_input',
        `duplicate key in filter: ${trimmed}`,
      );
    }
    seen.add(trimmed);
    requested.push(trimmed);
  }

  const fullSnapshot = exportConfig(configStore, source_tenant_id, now);
  const filteredOverrides: Record<string, ConfigValue> = {};
  const not_in_source: string[] = [];
  for (const k of requested) {
    if (Object.prototype.hasOwnProperty.call(fullSnapshot.overrides, k)) {
      filteredOverrides[k] = fullSnapshot.overrides[k]!;
    } else {
      not_in_source.push(k);
    }
  }

  const summary = importConfig(
    configStore,
    target_tenant_id,
    {
      generated_at: fullSnapshot.generated_at,
      source_tenant_id: fullSnapshot.source_tenant_id,
      overrides: filteredOverrides,
    },
    applied_by,
    dry_run,
    now,
  );

  return {
    ...summary,
    not_in_source,
    requested_keys: requested,
  };
}

export interface ConfigSnapshot {
  /** ISO timestamp of when the snapshot was generated. */
  generated_at: string;
  /** Source tenant of the export. */
  source_tenant_id: string;
  /** Map of key → override value. Keys NOT in the platform schema
   *  must be filtered before export. */
  overrides: Record<string, ConfigValue>;
}

export interface ImportSummary {
  applied: string[];
  skipped: Array<{ key: string; reason: string }>;
  unchanged: string[];
  dry_run: boolean;
  total_input: number;
}

export class ConfigBulkError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ConfigBulkError';
  }
}

export function exportConfig(
  configStore: ConfigStore,
  tenant_id: string,
  now: Date,
): ConfigSnapshot {
  const entries = configStore.list(tenant_id);
  const overrides: Record<string, ConfigValue> = {};
  for (const e of entries) {
    if (!e.is_default) {
      overrides[e.key] = e.value;
    }
  }
  return {
    generated_at: now.toISOString(),
    source_tenant_id: tenant_id,
    overrides,
  };
}

export function importConfig(
  configStore: ConfigStore,
  target_tenant_id: string,
  snapshot: unknown,
  applied_by: string,
  dry_run: boolean,
  now: Date,
): ImportSummary {
  if (!applied_by || !applied_by.trim()) {
    throw new ConfigBulkError('invalid_input', 'applied_by required');
  }
  if (!snapshot || typeof snapshot !== 'object') {
    throw new ConfigBulkError('invalid_input', 'snapshot must be an object');
  }
  const s = snapshot as Record<string, unknown>;
  const overrides = s.overrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new ConfigBulkError(
      'invalid_input',
      'snapshot.overrides must be a key→value map',
    );
  }
  const ovr = overrides as Record<string, ConfigValue>;
  const keys = Object.keys(ovr);
  if (keys.length > 100) {
    throw new ConfigBulkError('invalid_input', 'snapshot too large (> 100 keys)');
  }

  const applied: string[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  const unchanged: string[] = [];

  for (const k of keys) {
    const target = ovr[k]!;
    const cur = configStore.get(target_tenant_id, k);
    if (!cur) {
      skipped.push({ key: k, reason: 'unknown_key' });
      continue;
    }
    // No-op when current value matches incoming
    if (JSON.stringify(cur.value) === JSON.stringify(target)) {
      unchanged.push(k);
      continue;
    }
    if (dry_run) {
      applied.push(k);
      continue;
    }
    try {
      configStore.set(target_tenant_id, k, target, applied_by.trim(), now);
      applied.push(k);
    } catch (e) {
      if (e instanceof ConfigValidationError) {
        skipped.push({ key: k, reason: `validation: ${e.message}` });
      } else {
        skipped.push({
          key: k,
          reason: `error: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }

  return {
    applied,
    skipped,
    unchanged,
    dry_run,
    total_input: keys.length,
  };
}
