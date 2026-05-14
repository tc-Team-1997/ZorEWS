// services/bff/src/scenario_bundle.ts
//
// T6 M16.13 — Custom scenario preset bundle export/import.
//
// M16.4 ships the per-tenant custom scenario preset CRUD. M16.5
// wires custom presets through bulk-run + diff; M16.10 adds version
// snapshots; M16.11 version diff; M16.12 bulk delete. M16.13 closes
// the portability loop by mirroring the M5.11 rule-template bundle +
// M11.9 dashboard bundle shape: a versioned JSON envelope for
// migrating custom scenarios between tenants / environments.
//
// Design:
//  - Versioned envelope (schema_version='1'). Bumping the version
//    later lets us evolve the shape without breaking imports of
//    older bundles.
//  - exportBundle deep-copies the ScenarioPreset, strips the live
//    store's identity (preset_id gets re-minted on import).
//  - importBundle replays via store.create with per-row outcomes
//    (created / skipped already_exists / error captures cap_reached
//    or any other CustomPresetError).
//  - name_prefix optional: useful when cloning into the SAME tenant
//    (avoid same-name collision).
//  - Cap 30 items per bundle — matches the M16.4 CAP_PER_TENANT.

import {
  type CustomPresetStore,
  CustomPresetError,
} from './scenario_custom';
import { type ScenarioPreset } from './scenario_library';

// ─── Public types ─────────────────────────────────────────────────────

export const SCENARIO_BUNDLE_SCHEMA_VERSION = '1';

export const SCENARIO_BUNDLE_MAX_ITEMS = 30;

/** Items carry the full ScenarioPreset shape MINUS the live store's
 *  identity (id). source_doc + everything else stays. */
export type ScenarioBundleItem = Omit<ScenarioPreset, 'id'>;

export interface ScenarioBundle {
  schema_version: string;
  exported_at: string;
  exported_by: string;
  source_tenant_id: string;
  items: ScenarioBundleItem[];
}

export type ScenarioImportRowOutcome =
  | { source_name: string; status: 'created'; new_id: string; name: string }
  | { source_name: string; status: 'skipped'; reason: string }
  | { source_name: string; status: 'error'; reason: string };

export interface ScenarioBundleImportResult {
  schema_version: string;
  source_tenant_id: string;
  target_tenant_id: string;
  imported_at: string;
  imported_by: string;
  total: number;
  created_count: number;
  skipped_count: number;
  error_count: number;
  rows: ScenarioImportRowOutcome[];
}

export class ScenarioBundleError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ScenarioBundleError';
  }
}

// ─── Validation ───────────────────────────────────────────────────────

export function validateBundle(input: unknown): ScenarioBundle {
  if (!input || typeof input !== 'object') {
    throw new ScenarioBundleError('invalid_input', 'bundle body required');
  }
  const i = input as Record<string, unknown>;
  if (i.schema_version !== SCENARIO_BUNDLE_SCHEMA_VERSION) {
    throw new ScenarioBundleError(
      'unsupported_schema_version',
      `expected schema_version='${SCENARIO_BUNDLE_SCHEMA_VERSION}', got '${String(i.schema_version)}'`,
    );
  }
  if (typeof i.exported_at !== 'string' || !i.exported_at.trim()) {
    throw new ScenarioBundleError('invalid_input', 'exported_at required');
  }
  if (typeof i.exported_by !== 'string' || !i.exported_by.trim()) {
    throw new ScenarioBundleError('invalid_input', 'exported_by required');
  }
  if (typeof i.source_tenant_id !== 'string' || !i.source_tenant_id.trim()) {
    throw new ScenarioBundleError('invalid_input', 'source_tenant_id required');
  }
  if (!Array.isArray(i.items)) {
    throw new ScenarioBundleError('invalid_input', 'items[] required');
  }
  if (i.items.length === 0) {
    throw new ScenarioBundleError('invalid_input', 'bundle must contain at least 1 item');
  }
  if (i.items.length > SCENARIO_BUNDLE_MAX_ITEMS) {
    throw new ScenarioBundleError(
      'invalid_input',
      `bundle has ${i.items.length} items > cap ${SCENARIO_BUNDLE_MAX_ITEMS}`,
    );
  }
  for (let k = 0; k < i.items.length; k++) {
    const item = i.items[k];
    if (!item || typeof item !== 'object') {
      throw new ScenarioBundleError('invalid_input', `items[${k}] must be an object`);
    }
    const r = item as Record<string, unknown>;
    if (typeof r.name !== 'string' || !r.name.trim()) {
      throw new ScenarioBundleError('invalid_input', `items[${k}].name required`);
    }
    if (!r.shocks || typeof r.shocks !== 'object') {
      throw new ScenarioBundleError('invalid_input', `items[${k}].shocks required`);
    }
  }
  return {
    schema_version: i.schema_version,
    exported_at: i.exported_at,
    exported_by: i.exported_by,
    source_tenant_id: i.source_tenant_id,
    items: i.items as ScenarioBundleItem[],
  };
}

// ─── Export ───────────────────────────────────────────────────────────

export interface ExportArgs {
  tenant_id: string;
  preset_ids: string[];
  exported_by: string;
  now: Date;
}

function stripIdentity(p: ScenarioPreset): ScenarioBundleItem {
  return {
    name: p.name,
    description: p.description,
    category: p.category,
    regulator: p.regulator,
    severity: p.severity,
    shocks: { ...p.shocks },
    source_doc: p.source_doc,
  };
}

/**
 * Pure export. Returns an envelope holding deep copies of the
 * requested presets (sans identity). Throws unknown_preset on any
 * missing id — safer than silently emitting a partial bundle.
 */
export function exportScenarioBundle(
  store: CustomPresetStore,
  args: ExportArgs,
): ScenarioBundle {
  if (!args.tenant_id || typeof args.tenant_id !== 'string') {
    throw new ScenarioBundleError('invalid_input', 'tenant_id required');
  }
  if (!args.exported_by || !args.exported_by.trim()) {
    throw new ScenarioBundleError('invalid_input', 'exported_by required');
  }
  if (!Array.isArray(args.preset_ids) || args.preset_ids.length === 0) {
    throw new ScenarioBundleError('invalid_input', 'preset_ids[] must be non-empty');
  }
  if (args.preset_ids.length > SCENARIO_BUNDLE_MAX_ITEMS) {
    throw new ScenarioBundleError(
      'invalid_input',
      `preset_ids exceeds cap ${SCENARIO_BUNDLE_MAX_ITEMS}`,
    );
  }
  const seen = new Set<string>();
  const items: ScenarioBundleItem[] = [];
  for (const id of args.preset_ids) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new ScenarioBundleError(
        'invalid_input',
        'every preset_id must be a non-empty string',
      );
    }
    if (seen.has(id)) {
      throw new ScenarioBundleError('invalid_input', `duplicate preset_id: ${id}`);
    }
    seen.add(id);
    const p = store.get(args.tenant_id, id);
    if (!p) {
      throw new ScenarioBundleError(
        'unknown_preset',
        `custom preset ${id} not found in tenant ${args.tenant_id}`,
      );
    }
    items.push(stripIdentity(p));
  }
  return {
    schema_version: SCENARIO_BUNDLE_SCHEMA_VERSION,
    exported_at: args.now.toISOString(),
    exported_by: args.exported_by.trim(),
    source_tenant_id: args.tenant_id,
    items,
  };
}

// ─── Import ───────────────────────────────────────────────────────────

export interface ImportArgs {
  target_tenant_id: string;
  bundle: unknown;
  imported_by: string;
  /** Optional prefix prepended to imported preset names (avoids same-
   *  tenant name collisions when cloning). */
  name_prefix?: string;
  now: Date;
}

/**
 * Pure import. Validates the bundle, then for each item builds a
 * CustomPresetInput and calls store.create. Per-row outcomes
 * (created / skipped already_exists / error) so partial-success
 * imports surface every row's result.
 */
export function importScenarioBundle(
  store: CustomPresetStore,
  args: ImportArgs,
): ScenarioBundleImportResult {
  if (!args.target_tenant_id || typeof args.target_tenant_id !== 'string') {
    throw new ScenarioBundleError('invalid_input', 'target_tenant_id required');
  }
  if (!args.imported_by || !args.imported_by.trim()) {
    throw new ScenarioBundleError('invalid_input', 'imported_by required');
  }
  let prefix = '';
  if (args.name_prefix !== undefined && args.name_prefix !== null) {
    if (typeof args.name_prefix !== 'string') {
      throw new ScenarioBundleError('invalid_input', 'name_prefix must be a string');
    }
    if (args.name_prefix.length > 24) {
      throw new ScenarioBundleError('invalid_input', 'name_prefix ≤ 24 chars');
    }
    prefix = args.name_prefix;
  }

  const bundle = validateBundle(args.bundle);

  const existingNames = new Set(
    store.list(args.target_tenant_id).map((p) => p.name),
  );

  const rows: ScenarioImportRowOutcome[] = [];
  let created_count = 0;
  let skipped_count = 0;
  let error_count = 0;

  for (const item of bundle.items) {
    const newName = prefix ? `${prefix}${item.name}` : item.name;
    if (existingNames.has(newName)) {
      rows.push({
        source_name: item.name,
        status: 'skipped',
        reason: `already_exists: a preset named '${newName}' is already in the target tenant`,
      });
      skipped_count += 1;
      continue;
    }
    const input = {
      name: newName,
      description: item.description,
      category: item.category,
      regulator: item.regulator,
      severity: item.severity,
      shocks: item.shocks,
      source_doc: item.source_doc,
    };
    try {
      const created = store.create(
        args.target_tenant_id,
        input,
        args.imported_by.trim(),
        args.now,
      );
      rows.push({
        source_name: item.name,
        status: 'created',
        new_id: created.id,
        name: created.name,
      });
      // Intra-bundle dedup against siblings already created in this run.
      existingNames.add(created.name);
      created_count += 1;
    } catch (e) {
      const reason =
        e instanceof CustomPresetError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      rows.push({ source_name: item.name, status: 'error', reason });
      error_count += 1;
    }
  }

  return {
    schema_version: bundle.schema_version,
    source_tenant_id: bundle.source_tenant_id,
    target_tenant_id: args.target_tenant_id,
    imported_at: args.now.toISOString(),
    imported_by: args.imported_by.trim(),
    total: bundle.items.length,
    created_count,
    skipped_count,
    error_count,
    rows,
  };
}
