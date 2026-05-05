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
