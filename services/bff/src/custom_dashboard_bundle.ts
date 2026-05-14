// services/bff/src/custom_dashboard_bundle.ts
//
// T6 M11.9 — Custom dashboard export/import bundle.
//
// M11.7 ships the custom-dashboard CRUD; M11.8 the widget data
// resolver. Operators migrating from sandbox → staging → prod or
// rolling out a "BIL ops gold layout" across multiple tenants need
// a portable JSON envelope. M11.9 mirrors the M5.11 rule-template
// bundle shape so the SPA can reuse the same import/export viewer.
//
// Design:
//  - Versioned envelope (schema_version='1'). Future shape evolution
//    bumps the version; older imports get rejected with a clear code.
//  - exportDashboardBundle is read-only; importDashboardBundle fans
//    out to store.create per item.
//  - Per-row outcomes (created / skipped already_exists / error)
//    surface every row's result so a partial-success import is
//    visible end-to-end.
//  - name_prefix optional — same-tenant cloning works without
//    hitting whatever uniqueness constraints downstream consumers
//    layer on.
//  - Cap 10 items per bundle — matches the per-tenant CAP_PER_TENANT
//    in M11.7.

import {
  type CustomDashboardStore,
  type CustomDashboard,
  type DashboardWidget,
  DashboardError,
} from './custom_dashboards';

// ─── Public types ─────────────────────────────────────────────────────

export const DASHBOARD_BUNDLE_SCHEMA_VERSION = '1';

export const DASHBOARD_BUNDLE_MAX_ITEMS = 10;

/** What we ship in the bundle for each dashboard — the live store's
 *  identity / audit fields (dashboard_id, tenant_id, created_by,
 *  created_at, updated_at, version) are NOT included; they get
 *  re-minted on import. */
export interface DashboardBundleItem {
  name: string;
  description: string;
  widgets: DashboardWidget[];
}

export interface DashboardBundle {
  schema_version: string;
  exported_at: string;
  exported_by: string;
  source_tenant_id: string;
  items: DashboardBundleItem[];
}

export type DashboardImportRowOutcome =
  | { source_name: string; status: 'created'; new_id: string; name: string }
  | { source_name: string; status: 'skipped'; reason: string }
  | { source_name: string; status: 'error'; reason: string };

export interface DashboardBundleImportResult {
  schema_version: string;
  source_tenant_id: string;
  target_tenant_id: string;
  imported_at: string;
  imported_by: string;
  total: number;
  created_count: number;
  skipped_count: number;
  error_count: number;
  rows: DashboardImportRowOutcome[];
}

export class DashboardBundleError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DashboardBundleError';
  }
}

// ─── Validation ───────────────────────────────────────────────────────

/** Validate that the supplied object is a well-formed bundle envelope.
 *  Per-item widget shape is re-validated at import time by the store. */
export function validateBundle(input: unknown): DashboardBundle {
  if (!input || typeof input !== 'object') {
    throw new DashboardBundleError('invalid_input', 'bundle body required');
  }
  const i = input as Record<string, unknown>;
  if (i.schema_version !== DASHBOARD_BUNDLE_SCHEMA_VERSION) {
    throw new DashboardBundleError(
      'unsupported_schema_version',
      `expected schema_version='${DASHBOARD_BUNDLE_SCHEMA_VERSION}', got '${String(i.schema_version)}'`,
    );
  }
  if (typeof i.exported_at !== 'string' || !i.exported_at.trim()) {
    throw new DashboardBundleError('invalid_input', 'exported_at required');
  }
  if (typeof i.exported_by !== 'string' || !i.exported_by.trim()) {
    throw new DashboardBundleError('invalid_input', 'exported_by required');
  }
  if (typeof i.source_tenant_id !== 'string' || !i.source_tenant_id.trim()) {
    throw new DashboardBundleError('invalid_input', 'source_tenant_id required');
  }
  if (!Array.isArray(i.items)) {
    throw new DashboardBundleError('invalid_input', 'items[] required');
  }
  if (i.items.length === 0) {
    throw new DashboardBundleError('invalid_input', 'bundle must contain at least 1 item');
  }
  if (i.items.length > DASHBOARD_BUNDLE_MAX_ITEMS) {
    throw new DashboardBundleError(
      'invalid_input',
      `bundle has ${i.items.length} items > cap ${DASHBOARD_BUNDLE_MAX_ITEMS}`,
    );
  }
  for (let k = 0; k < i.items.length; k++) {
    const item = i.items[k];
    if (!item || typeof item !== 'object') {
      throw new DashboardBundleError('invalid_input', `items[${k}] must be an object`);
    }
    const r = item as Record<string, unknown>;
    if (typeof r.name !== 'string' || !r.name.trim()) {
      throw new DashboardBundleError('invalid_input', `items[${k}].name required`);
    }
    if (!Array.isArray(r.widgets) || r.widgets.length === 0) {
      throw new DashboardBundleError(
        'invalid_input',
        `items[${k}].widgets must be a non-empty array`,
      );
    }
  }
  return {
    schema_version: i.schema_version,
    exported_at: i.exported_at,
    exported_by: i.exported_by,
    source_tenant_id: i.source_tenant_id,
    items: i.items as DashboardBundleItem[],
  };
}

// ─── Export ───────────────────────────────────────────────────────────

export interface ExportArgs {
  tenant_id: string;
  dashboard_ids: string[];
  exported_by: string;
  now: Date;
}

function snapshotDashboard(d: CustomDashboard): DashboardBundleItem {
  return {
    name: d.name,
    description: d.description,
    widgets: d.widgets.map((w) => ({
      widget_type: w.widget_type,
      position: { ...w.position },
      span: { ...w.span },
      config: { ...w.config },
    })),
  };
}

/**
 * Pure-function export. Returns an envelope holding deep copies of
 * the requested dashboards. Throws unknown_dashboard if any id is
 * missing — safer than silently emitting a partial bundle.
 */
export function exportDashboardBundle(
  store: CustomDashboardStore,
  args: ExportArgs,
): DashboardBundle {
  if (!args.tenant_id || typeof args.tenant_id !== 'string') {
    throw new DashboardBundleError('invalid_input', 'tenant_id required');
  }
  if (!args.exported_by || !args.exported_by.trim()) {
    throw new DashboardBundleError('invalid_input', 'exported_by required');
  }
  if (!Array.isArray(args.dashboard_ids) || args.dashboard_ids.length === 0) {
    throw new DashboardBundleError('invalid_input', 'dashboard_ids[] must be non-empty');
  }
  if (args.dashboard_ids.length > DASHBOARD_BUNDLE_MAX_ITEMS) {
    throw new DashboardBundleError(
      'invalid_input',
      `dashboard_ids exceeds cap ${DASHBOARD_BUNDLE_MAX_ITEMS}`,
    );
  }
  const seen = new Set<string>();
  const items: DashboardBundleItem[] = [];
  for (const id of args.dashboard_ids) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new DashboardBundleError(
        'invalid_input',
        'every dashboard_id must be a non-empty string',
      );
    }
    if (seen.has(id)) {
      throw new DashboardBundleError('invalid_input', `duplicate dashboard_id: ${id}`);
    }
    seen.add(id);
    const d = store.get(args.tenant_id, id);
    if (!d) {
      throw new DashboardBundleError(
        'unknown_dashboard',
        `dashboard ${id} not found in tenant ${args.tenant_id}`,
      );
    }
    items.push(snapshotDashboard(d));
  }
  return {
    schema_version: DASHBOARD_BUNDLE_SCHEMA_VERSION,
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
  /** Prefix prepended to every imported dashboard's name. Useful when
   *  cloning into the SAME tenant; ignored when omitted. */
  name_prefix?: string;
  now: Date;
}

/**
 * Pure-function import. Validates the bundle, then for each item
 * builds a CustomDashboardInput and calls store.create. Each row's
 * outcome (created / skipped / error) is captured so the SPA can
 * render a partial-success summary.
 */
export function importDashboardBundle(
  store: CustomDashboardStore,
  args: ImportArgs,
): DashboardBundleImportResult {
  if (!args.target_tenant_id || typeof args.target_tenant_id !== 'string') {
    throw new DashboardBundleError('invalid_input', 'target_tenant_id required');
  }
  if (!args.imported_by || !args.imported_by.trim()) {
    throw new DashboardBundleError('invalid_input', 'imported_by required');
  }
  let prefix = '';
  if (args.name_prefix !== undefined && args.name_prefix !== null) {
    if (typeof args.name_prefix !== 'string') {
      throw new DashboardBundleError('invalid_input', 'name_prefix must be a string');
    }
    if (args.name_prefix.length > 24) {
      throw new DashboardBundleError('invalid_input', 'name_prefix ≤ 24 chars');
    }
    prefix = args.name_prefix;
  }

  const bundle = validateBundle(args.bundle);

  const existingNames = new Set(
    store.list(args.target_tenant_id).map((d) => d.name),
  );

  const rows: DashboardImportRowOutcome[] = [];
  let created_count = 0;
  let skipped_count = 0;
  let error_count = 0;

  for (const item of bundle.items) {
    const newName = prefix ? `${prefix}${item.name}` : item.name;
    if (existingNames.has(newName)) {
      rows.push({
        source_name: item.name,
        status: 'skipped',
        reason: `already_exists: a dashboard named '${newName}' is already in the target tenant`,
      });
      skipped_count += 1;
      continue;
    }
    const input = {
      name: newName,
      description: item.description,
      widgets: item.widgets,
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
        new_id: created.dashboard_id,
        name: created.name,
      });
      existingNames.add(created.name);
      created_count += 1;
    } catch (e) {
      const reason =
        e instanceof DashboardError
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
