// services/bff/src/rule_template_bundle.ts
//
// T6 M5.11 — Custom rule template export/import bundle.
//
// Operators frequently need to migrate hand-crafted rule
// templates between environments (sandbox → staging → prod).
// M5.11 ships a portable JSON envelope: exportBundle picks N
// templates by id and snapshots them; importBundle installs the
// snapshot into a target tenant via the existing M5.6 CRUD
// store.
//
// Design:
//  - Versioned envelope (schema_version='1'). Bumping the version
//    later lets us evolve the shape without breaking imports of
//    older bundles.
//  - exportBundle is read-only (no audit event); importBundle
//    fans out to store.create per item which itself is logged
//    by M5's existing audit hook.
//  - Per-row outcomes (created / skipped already_exists / error
//    with reason) so a partial-success import surfaces
//    every row's result.
//  - name_prefix optional: useful when cloning into the SAME
//    tenant — the original "fraud-rule-1" becomes "BIL — fraud-rule-1"
//    so the unique-name guard in the store doesn't collide.
//  - Cap 30 items per bundle — same as the per-tenant template cap.

import {
  type CustomRuleTemplateStore,
  CustomRuleTemplateError,
} from './rule_templates_custom';
import { type RuleTemplate } from './rule_templates';

// ─── Public types ─────────────────────────────────────────────────────

export const BUNDLE_SCHEMA_VERSION = '1';

export const BUNDLE_MAX_ITEMS = 30;

export interface RuleTemplateBundle {
  schema_version: string;
  exported_at: string;
  exported_by: string;
  source_tenant_id: string;
  items: RuleTemplate[];
}

export type ImportRowOutcome =
  | { source_id: string; status: 'created'; new_id: string; name: string }
  | { source_id: string; status: 'skipped'; reason: string }
  | { source_id: string; status: 'error'; reason: string };

export interface BundleImportResult {
  schema_version: string;
  source_tenant_id: string;
  target_tenant_id: string;
  imported_at: string;
  imported_by: string;
  total: number;
  created_count: number;
  skipped_count: number;
  error_count: number;
  rows: ImportRowOutcome[];
}

export class BundleError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

// ─── Validation ───────────────────────────────────────────────────────

function isStringArray(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => typeof x === 'string' && x.trim().length > 0)
  );
}

/** Validate that the supplied object is a well-formed bundle. */
export function validateBundle(input: unknown): RuleTemplateBundle {
  if (!input || typeof input !== 'object') {
    throw new BundleError('invalid_input', 'bundle body required');
  }
  const i = input as Record<string, unknown>;
  if (i.schema_version !== BUNDLE_SCHEMA_VERSION) {
    throw new BundleError(
      'unsupported_schema_version',
      `expected schema_version='${BUNDLE_SCHEMA_VERSION}', got '${String(i.schema_version)}'`,
    );
  }
  if (typeof i.exported_at !== 'string' || !i.exported_at.trim()) {
    throw new BundleError('invalid_input', 'exported_at required');
  }
  if (typeof i.exported_by !== 'string' || !i.exported_by.trim()) {
    throw new BundleError('invalid_input', 'exported_by required');
  }
  if (typeof i.source_tenant_id !== 'string' || !i.source_tenant_id.trim()) {
    throw new BundleError('invalid_input', 'source_tenant_id required');
  }
  if (!Array.isArray(i.items)) {
    throw new BundleError('invalid_input', 'items[] required');
  }
  if (i.items.length === 0) {
    throw new BundleError('invalid_input', 'bundle must contain at least 1 item');
  }
  if (i.items.length > BUNDLE_MAX_ITEMS) {
    throw new BundleError(
      'invalid_input',
      `bundle has ${i.items.length} items > cap ${BUNDLE_MAX_ITEMS}`,
    );
  }
  // Spot-check each item shape — full validation happens at import
  // time when we re-run the store's validate().
  for (let k = 0; k < i.items.length; k++) {
    const item = i.items[k];
    if (!item || typeof item !== 'object') {
      throw new BundleError('invalid_input', `items[${k}] must be an object`);
    }
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id.trim()) {
      throw new BundleError('invalid_input', `items[${k}].id required`);
    }
    if (typeof r.name !== 'string' || !r.name.trim()) {
      throw new BundleError('invalid_input', `items[${k}].name required`);
    }
    if (!isStringArray(r.supporting_indicators)) {
      throw new BundleError(
        'invalid_input',
        `items[${k}].supporting_indicators must be a non-empty string[]`,
      );
    }
  }
  return {
    schema_version: i.schema_version,
    exported_at: i.exported_at,
    exported_by: i.exported_by,
    source_tenant_id: i.source_tenant_id,
    items: i.items as RuleTemplate[],
  };
}

// ─── Export ───────────────────────────────────────────────────────────

export interface ExportArgs {
  tenant_id: string;
  template_ids: string[];
  exported_by: string;
  now: Date;
}

/**
 * Pure-function export. Returns an envelope holding deep copies
 * of the requested templates. Throws unknown_template if any id
 * is missing — safer than silently emitting a partial bundle.
 */
export function exportBundle(
  store: CustomRuleTemplateStore,
  args: ExportArgs,
): RuleTemplateBundle {
  if (!args.tenant_id || typeof args.tenant_id !== 'string') {
    throw new BundleError('invalid_input', 'tenant_id required');
  }
  if (!args.exported_by || !args.exported_by.trim()) {
    throw new BundleError('invalid_input', 'exported_by required');
  }
  if (!Array.isArray(args.template_ids) || args.template_ids.length === 0) {
    throw new BundleError('invalid_input', 'template_ids[] must be non-empty');
  }
  if (args.template_ids.length > BUNDLE_MAX_ITEMS) {
    throw new BundleError(
      'invalid_input',
      `template_ids exceeds cap ${BUNDLE_MAX_ITEMS}`,
    );
  }
  const seen = new Set<string>();
  const items: RuleTemplate[] = [];
  for (const id of args.template_ids) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new BundleError('invalid_input', 'every template_id must be a non-empty string');
    }
    if (seen.has(id)) {
      throw new BundleError('invalid_input', `duplicate template_id: ${id}`);
    }
    seen.add(id);
    const t = store.get(args.tenant_id, id);
    if (!t) {
      throw new BundleError(
        'unknown_template',
        `template ${id} not found in tenant ${args.tenant_id}`,
      );
    }
    // Deep copy so the bundle is independent of the live store.
    items.push({
      ...t,
      recommended_actions: [...t.recommended_actions],
      supporting_indicators: [...t.supporting_indicators],
    });
  }
  return {
    schema_version: BUNDLE_SCHEMA_VERSION,
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
  /** Prefix prepended to every imported template's name. Useful
   *  when cloning into the SAME tenant (avoids collision with the
   *  source name); ignored when omitted. */
  name_prefix?: string;
  now: Date;
}

/**
 * Pure-function import. Validates the bundle, then for each item
 * builds a CustomRuleTemplateInput and calls store.create. Each
 * row's outcome (created / skipped / error) is captured so the
 * SPA can render a partial-success summary.
 *
 * "skipped already_exists" is reserved for name collisions; in
 * the current store the validate path rejects empty/duplicate
 * names but doesn't enforce per-tenant uniqueness, so we detect
 * it here by listing first and matching by name.
 */
export function importBundle(
  store: CustomRuleTemplateStore,
  args: ImportArgs,
): BundleImportResult {
  if (!args.target_tenant_id || typeof args.target_tenant_id !== 'string') {
    throw new BundleError('invalid_input', 'target_tenant_id required');
  }
  if (!args.imported_by || !args.imported_by.trim()) {
    throw new BundleError('invalid_input', 'imported_by required');
  }
  let prefix = '';
  if (args.name_prefix !== undefined && args.name_prefix !== null) {
    if (typeof args.name_prefix !== 'string') {
      throw new BundleError('invalid_input', 'name_prefix must be a string');
    }
    if (args.name_prefix.length > 24) {
      throw new BundleError('invalid_input', 'name_prefix ≤ 24 chars');
    }
    prefix = args.name_prefix;
  }

  const bundle = validateBundle(args.bundle);

  const existingNames = new Set(
    store.list(args.target_tenant_id).map((t) => t.name),
  );

  const rows: ImportRowOutcome[] = [];
  let created_count = 0;
  let skipped_count = 0;
  let error_count = 0;

  for (const item of bundle.items) {
    const newName = prefix ? `${prefix}${item.name}` : item.name;
    if (existingNames.has(newName)) {
      rows.push({
        source_id: item.id,
        status: 'skipped',
        reason: `already_exists: a template named '${newName}' is already in the target tenant`,
      });
      skipped_count += 1;
      continue;
    }
    const input = {
      name: newName,
      description: item.description,
      vertical: item.vertical,
      category: item.category,
      condition_pseudocode: item.condition_pseudocode,
      recommended_severity: item.recommended_severity,
      recommended_actions: item.recommended_actions,
      supporting_indicators: item.supporting_indicators,
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
        source_id: item.id,
        status: 'created',
        new_id: created.id,
        name: created.name,
      });
      // Add to in-memory dedupe set so subsequent items in THIS bundle
      // can detect collisions with siblings.
      existingNames.add(created.name);
      created_count += 1;
    } catch (e) {
      const reason =
        e instanceof CustomRuleTemplateError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      rows.push({ source_id: item.id, status: 'error', reason });
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
