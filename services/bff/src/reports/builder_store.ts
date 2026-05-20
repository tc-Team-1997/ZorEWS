// services/bff/src/reports/builder_store.ts
//
// T4.6.3 — Self-service reporting: saved-report CRUD store.
//
// Mirrors the IScenarioStore pattern (T4.18) — in-memory default +
// pg-backed factory selectable via env. Each SavedReport carries a
// ReportDefinition (T4.6.2) + role-based visibility metadata. The
// store enforces:
//   - Tenant scoping (cross-tenant get → null).
//   - Per-tenant cap (default 200 saved reports / tenant).
//   - Visibility CRUD invariants (visibility='role' requires non-
//     empty visible_to_roles[]; private + tenant ignore the list).
//
// Companion to:
//   - T4.6.1 ReportDataSource (validates source_id at save time).
//   - T4.6.2 ReportDefinition + compileReportDefinition (validates
//     the definition compiles before save).
//   - T4.6.4 execution engine (consumes saved.definition).
//   - T4.6.5 SPA saved-list (consumes list() + visibleTo()).

import { requireReportSource } from './builder_catalog';
import {
  compileReportDefinition,
  type ReportDefinition,
} from './builder_filter';

// ─── Public types ──────────────────────────────────────────────────────

export type ReportVisibility = 'private' | 'role' | 'tenant';

export const ALL_REPORT_VISIBILITIES: readonly ReportVisibility[] = [
  'private',
  'role',
  'tenant',
];

export interface SavedReport {
  report_id: string;
  tenant_id: string;
  name: string;
  description: string;
  definition: ReportDefinition;
  created_by: string;
  created_at: string;
  updated_at: string;
  visibility: ReportVisibility;
  /** Populated when visibility='role'. Ignored otherwise. */
  visible_to_roles: readonly string[];
  tags: readonly string[];
}

export interface CreateSavedReportInput {
  tenant_id: string;
  name: string;
  description?: string;
  definition: ReportDefinition;
  created_by: string;
  visibility?: ReportVisibility;
  visible_to_roles?: readonly string[];
  tags?: readonly string[];
}

export interface UpdateSavedReportInput {
  name?: string;
  description?: string;
  definition?: ReportDefinition;
  visibility?: ReportVisibility;
  visible_to_roles?: readonly string[];
  tags?: readonly string[];
}

export interface SavedReportFilter {
  visibility?: ReportVisibility;
  source_id?: string;
  created_by?: string;
  tag?: string;
}

export class SavedReportError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'unknown_source'
      | 'unknown_report'
      | 'cap_reached'
      | 'invalid_definition'
      | 'role_visibility_requires_roles',
    message: string,
  ) {
    super(message);
    this.name = 'SavedReportError';
  }
}

// ─── Store interface ───────────────────────────────────────────────────

export interface ISavedReportStore {
  create(input: CreateSavedReportInput, now: Date): SavedReport;
  update(
    report_id: string,
    tenant_id: string,
    patch: UpdateSavedReportInput,
    actor: string,
    now: Date,
  ): SavedReport;
  list(tenant_id: string, filter?: SavedReportFilter): SavedReport[];
  get(report_id: string, tenant_id: string): SavedReport | null;
  delete(report_id: string, tenant_id: string): boolean;
  /** Visibility check — does `viewer` see this report? Admin role
   *  short-circuits to true (matches existing audit:read superuser
   *  semantics). */
  visibleTo(
    report: SavedReport,
    viewer_username: string,
    viewer_role: string,
  ): boolean;
}

// ─── Validators ────────────────────────────────────────────────────────

export const PER_TENANT_CAP = 200;
const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;
const TAG_MAX_COUNT = 20;
const ROLES_MAX_COUNT = 20;

function validateCreateInput(input: CreateSavedReportInput): void {
  if (!input || typeof input !== 'object') {
    throw new SavedReportError('invalid_input', 'input required');
  }
  if (typeof input.tenant_id !== 'string' || !input.tenant_id.trim()) {
    throw new SavedReportError('invalid_input', 'tenant_id required');
  }
  if (typeof input.name !== 'string' || !input.name.trim()) {
    throw new SavedReportError('invalid_input', 'name required');
  }
  if (input.name.length > NAME_MAX) {
    throw new SavedReportError('invalid_input', `name exceeds ${NAME_MAX} chars`);
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw new SavedReportError('invalid_input', 'description must be string');
  }
  if (input.description && input.description.length > DESCRIPTION_MAX) {
    throw new SavedReportError(
      'invalid_input',
      `description exceeds ${DESCRIPTION_MAX} chars`,
    );
  }
  if (typeof input.created_by !== 'string' || !input.created_by.trim()) {
    throw new SavedReportError('invalid_input', 'created_by required');
  }
  if (input.visibility !== undefined && !ALL_REPORT_VISIBILITIES.includes(input.visibility)) {
    throw new SavedReportError('invalid_input', `invalid visibility: ${input.visibility}`);
  }
  if (input.visibility === 'role') {
    if (
      !Array.isArray(input.visible_to_roles) ||
      input.visible_to_roles.length === 0
    ) {
      throw new SavedReportError(
        'role_visibility_requires_roles',
        'visibility=role requires non-empty visible_to_roles[]',
      );
    }
    if (input.visible_to_roles.length > ROLES_MAX_COUNT) {
      throw new SavedReportError(
        'invalid_input',
        `visible_to_roles exceeds ${ROLES_MAX_COUNT} entries`,
      );
    }
    for (const r of input.visible_to_roles) {
      if (typeof r !== 'string' || !r.trim()) {
        throw new SavedReportError('invalid_input', 'visible_to_roles entries must be non-empty strings');
      }
    }
  }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) {
      throw new SavedReportError('invalid_input', 'tags must be array');
    }
    if (input.tags.length > TAG_MAX_COUNT) {
      throw new SavedReportError(
        'invalid_input',
        `tags exceed ${TAG_MAX_COUNT} entries`,
      );
    }
    for (const t of input.tags) {
      if (typeof t !== 'string' || !t.trim()) {
        throw new SavedReportError('invalid_input', 'tags entries must be non-empty strings');
      }
    }
  }
  // Source + definition validation — compile against the catalog. Throws
  // FilterCompilerError or ReportCatalogError on bad refs.
  if (!input.definition || typeof input.definition !== 'object') {
    throw new SavedReportError('invalid_definition', 'definition required');
  }
  try {
    requireReportSource(input.definition.source_id);
  } catch (err) {
    throw new SavedReportError(
      'unknown_source',
      `unknown source in definition: ${input.definition.source_id}`,
    );
  }
  try {
    compileReportDefinition(input.definition, { tenant_id: input.tenant_id });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    throw new SavedReportError(
      'invalid_definition',
      `definition does not compile: ${e.message ?? 'unknown error'}`,
    );
  }
}

// ─── In-memory store ───────────────────────────────────────────────────

export class InMemorySavedReportStore implements ISavedReportStore {
  private readonly byId = new Map<string, SavedReport>();
  private readonly byTenant = new Map<string, Set<string>>();
  private seq = 0;

  create(input: CreateSavedReportInput, now: Date): SavedReport {
    validateCreateInput(input);
    const tenantSet = this.byTenant.get(input.tenant_id) ?? new Set<string>();
    if (tenantSet.size >= PER_TENANT_CAP) {
      throw new SavedReportError(
        'cap_reached',
        `tenant ${input.tenant_id} has ${PER_TENANT_CAP} saved reports — delete one first`,
      );
    }
    this.seq++;
    const report_id = `rpt-${input.tenant_id}-${Date.now()}-${this.seq}`;
    const visibility = input.visibility ?? 'private';
    const report: SavedReport = {
      report_id,
      tenant_id: input.tenant_id,
      name: input.name.trim(),
      description: (input.description ?? '').trim(),
      definition: input.definition,
      created_by: input.created_by,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      visibility,
      visible_to_roles: visibility === 'role' ? [...(input.visible_to_roles ?? [])] : [],
      tags: input.tags ? [...input.tags] : [],
    };
    this.byId.set(report_id, report);
    tenantSet.add(report_id);
    this.byTenant.set(input.tenant_id, tenantSet);
    return { ...report };
  }

  update(
    report_id: string,
    tenant_id: string,
    patch: UpdateSavedReportInput,
    actor: string,
    now: Date,
  ): SavedReport {
    const existing = this.byId.get(report_id);
    if (!existing || existing.tenant_id !== tenant_id) {
      throw new SavedReportError('unknown_report', `unknown report: ${report_id}`);
    }
    const next: SavedReport = { ...existing };

    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string' || !patch.name.trim()) {
        throw new SavedReportError('invalid_input', 'name must be non-empty');
      }
      if (patch.name.length > NAME_MAX) {
        throw new SavedReportError('invalid_input', `name exceeds ${NAME_MAX} chars`);
      }
      next.name = patch.name.trim();
    }
    if (patch.description !== undefined) {
      if (typeof patch.description !== 'string') {
        throw new SavedReportError('invalid_input', 'description must be string');
      }
      if (patch.description.length > DESCRIPTION_MAX) {
        throw new SavedReportError(
          'invalid_input',
          `description exceeds ${DESCRIPTION_MAX} chars`,
        );
      }
      next.description = patch.description.trim();
    }
    if (patch.definition !== undefined) {
      try {
        compileReportDefinition(patch.definition, { tenant_id });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        throw new SavedReportError(
          'invalid_definition',
          `definition does not compile: ${e.message ?? 'unknown error'}`,
        );
      }
      next.definition = patch.definition;
    }
    if (patch.visibility !== undefined) {
      if (!ALL_REPORT_VISIBILITIES.includes(patch.visibility)) {
        throw new SavedReportError(
          'invalid_input',
          `invalid visibility: ${patch.visibility}`,
        );
      }
      next.visibility = patch.visibility;
      // If switching TO 'role', visible_to_roles must accompany the patch
      // OR exist on the prior row.
      if (next.visibility === 'role') {
        const rolesAfterPatch = patch.visible_to_roles ?? next.visible_to_roles;
        if (!Array.isArray(rolesAfterPatch) || rolesAfterPatch.length === 0) {
          throw new SavedReportError(
            'role_visibility_requires_roles',
            'switching to visibility=role requires visible_to_roles[]',
          );
        }
      } else {
        // Switching to private/tenant clears roles.
        next.visible_to_roles = [];
      }
    }
    if (patch.visible_to_roles !== undefined && next.visibility === 'role') {
      if (
        !Array.isArray(patch.visible_to_roles) ||
        patch.visible_to_roles.length === 0
      ) {
        throw new SavedReportError(
          'role_visibility_requires_roles',
          'visible_to_roles must be non-empty when visibility=role',
        );
      }
      if (patch.visible_to_roles.length > ROLES_MAX_COUNT) {
        throw new SavedReportError(
          'invalid_input',
          `visible_to_roles exceeds ${ROLES_MAX_COUNT} entries`,
        );
      }
      next.visible_to_roles = [...patch.visible_to_roles];
    }
    if (patch.tags !== undefined) {
      if (!Array.isArray(patch.tags)) {
        throw new SavedReportError('invalid_input', 'tags must be array');
      }
      if (patch.tags.length > TAG_MAX_COUNT) {
        throw new SavedReportError(
          'invalid_input',
          `tags exceed ${TAG_MAX_COUNT} entries`,
        );
      }
      next.tags = [...patch.tags];
    }
    next.updated_at = now.toISOString();
    this.byId.set(report_id, next);
    return { ...next };
  }

  list(tenant_id: string, filter?: SavedReportFilter): SavedReport[] {
    const tenantSet = this.byTenant.get(tenant_id);
    if (!tenantSet) return [];
    const rows: SavedReport[] = [];
    for (const id of tenantSet) {
      const r = this.byId.get(id);
      if (!r) continue;
      if (filter?.visibility !== undefined && r.visibility !== filter.visibility) continue;
      if (filter?.source_id !== undefined && r.definition.source_id !== filter.source_id) continue;
      if (filter?.created_by !== undefined && r.created_by !== filter.created_by) continue;
      if (filter?.tag !== undefined && !r.tags.includes(filter.tag)) continue;
      rows.push({ ...r });
    }
    // Newest-first.
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return rows;
  }

  get(report_id: string, tenant_id: string): SavedReport | null {
    const r = this.byId.get(report_id);
    if (!r || r.tenant_id !== tenant_id) return null;
    return { ...r };
  }

  delete(report_id: string, tenant_id: string): boolean {
    const r = this.byId.get(report_id);
    if (!r || r.tenant_id !== tenant_id) return false;
    this.byId.delete(report_id);
    const tenantSet = this.byTenant.get(tenant_id);
    if (tenantSet) tenantSet.delete(report_id);
    return true;
  }

  visibleTo(
    report: SavedReport,
    viewer_username: string,
    viewer_role: string,
  ): boolean {
    // Admin sees everything (audit:read superuser per docs/charter.md
    // RACI §4).
    if (viewer_role === 'admin') return true;
    switch (report.visibility) {
      case 'tenant':
        return true; // any user in the tenant
      case 'role':
        return report.visible_to_roles.includes(viewer_role);
      case 'private':
        return report.created_by === viewer_username;
      default:
        return false;
    }
  }
}

// ─── Singleton + factory ───────────────────────────────────────────────

let _default: ISavedReportStore | null = null;

export function defaultSavedReportStore(): ISavedReportStore {
  if (!_default) _default = new InMemorySavedReportStore();
  return _default;
}

/** Test-only: wipe + replace the default store. */
export function _resetDefaultSavedReportStore(): void {
  _default = new InMemorySavedReportStore();
}
