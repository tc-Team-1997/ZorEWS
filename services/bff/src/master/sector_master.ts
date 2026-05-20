// services/bff/src/master/sector_master.ts
//
// PHASE A.1 — Sector & Industry Master Setup (PDF §6 Master Setup item 4).
//
// Tenant-scoped master-data table for industry sectors used by the
// portfolio dashboard, sector-risk view, and (optionally) the M6.x
// scoring engine as a weight overlay. Distinct from the M6.2 indicator
// catalog and the M16.1 scenario library — those are platform-static;
// THIS is per-tenant admin-editable master data.
//
// Architecture choices (per execution rules):
//   - Additive only — no changes to existing M6/M16/runtime modules.
//   - Pure in-memory store first (mirrors M3.1 / M13.1 / M16.4 prototype
//     pattern). Pg-backed swap is a future ticket; the IStore interface
//     keeps the swap mechanical.
//   - Audit-fields baked in: created_at, created_by, updated_at,
//     updated_by, deleted_at, deleted_by.
//   - Soft-delete-by-default — delete() flips deleted_at/_by and removes
//     from list() but the row stays in the store for Recovery Center
//     archive + restore.
//   - Recovery Center adapter registered at boot (see server.ts).
//   - RBAC: `audit:read` for everything (admin-only, matches M13.1
//     admin config convention).

/** Canonical regulatory categories — closed enum so SPA filter chips
 *  + stack charts have a stable set. Order is canonical for display. */
export const ALL_REGULATORY_CATEGORIES = [
  'priority_sector',
  'non_priority_sector',
  'restricted_sector',
  'sensitive_sector',
  'export_oriented',
  'msme',
  'agriculture',
  'unclassified',
] as const;
export type RegulatoryCategory = (typeof ALL_REGULATORY_CATEGORIES)[number];

export function isRegulatoryCategory(v: unknown): v is RegulatoryCategory {
  return (
    typeof v === 'string' &&
    (ALL_REGULATORY_CATEGORIES as readonly string[]).includes(v)
  );
}

/** One row in the sector master. risk_weight ∈ (0, 1] mirrors M6.2
 *  weight semantics so the value is interchangeable with scoring inputs. */
export interface SectorMasterEntry {
  sector_id: string;
  tenant_id: string;
  sector_name: string;
  risk_weight: number;
  regulatory_category: RegulatoryCategory;
  description: string | null;
  active: boolean;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface SectorMasterCreateInput {
  sector_id: string;
  sector_name: string;
  risk_weight: number;
  regulatory_category: RegulatoryCategory;
  description?: string | null;
  active?: boolean;
}

export interface SectorMasterUpdateInput {
  sector_name?: string;
  risk_weight?: number;
  regulatory_category?: RegulatoryCategory;
  description?: string | null;
  active?: boolean;
}

export class SectorMasterError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_sector_id'
      | 'invalid_name'
      | 'invalid_risk_weight'
      | 'invalid_category'
      | 'invalid_description'
      | 'unknown_sector'
      | 'duplicate_sector_id'
      | 'cap_reached',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'SectorMasterError';
  }
}

/** Per-tenant cap. Matches M16.4 / M13.1 conservative scaling. */
export const SECTOR_MASTER_CAP_PER_TENANT = 200;

const SECTOR_ID_RE = /^[A-Z][A-Z0-9_]{1,47}$/;

function validateCreate(input: SectorMasterCreateInput): void {
  if (!input || typeof input !== 'object') {
    throw new SectorMasterError('invalid_input', 'request body must be an object');
  }
  if (typeof input.sector_id !== 'string' || !SECTOR_ID_RE.test(input.sector_id)) {
    throw new SectorMasterError(
      'invalid_sector_id',
      'sector_id must match ^[A-Z][A-Z0-9_]{1,47}$',
    );
  }
  if (
    typeof input.sector_name !== 'string' ||
    input.sector_name.trim().length === 0 ||
    input.sector_name.length > 200
  ) {
    throw new SectorMasterError(
      'invalid_name',
      'sector_name must be 1..200 chars after trim',
    );
  }
  if (
    typeof input.risk_weight !== 'number' ||
    !Number.isFinite(input.risk_weight) ||
    input.risk_weight <= 0 ||
    input.risk_weight > 1
  ) {
    throw new SectorMasterError(
      'invalid_risk_weight',
      'risk_weight must be a finite number in (0, 1]',
    );
  }
  if (!isRegulatoryCategory(input.regulatory_category)) {
    throw new SectorMasterError(
      'invalid_category',
      `regulatory_category must be one of: ${ALL_REGULATORY_CATEGORIES.join(', ')}`,
    );
  }
  if (input.description != null) {
    if (typeof input.description !== 'string' || input.description.length > 1000) {
      throw new SectorMasterError(
        'invalid_description',
        'description must be a string ≤ 1000 chars (or omitted/null)',
      );
    }
  }
}

function validateUpdate(patch: SectorMasterUpdateInput): void {
  if (!patch || typeof patch !== 'object') {
    throw new SectorMasterError('invalid_input', 'patch must be an object');
  }
  if (patch.sector_name !== undefined) {
    if (
      typeof patch.sector_name !== 'string' ||
      patch.sector_name.trim().length === 0 ||
      patch.sector_name.length > 200
    ) {
      throw new SectorMasterError(
        'invalid_name',
        'sector_name must be 1..200 chars after trim',
      );
    }
  }
  if (patch.risk_weight !== undefined) {
    if (
      typeof patch.risk_weight !== 'number' ||
      !Number.isFinite(patch.risk_weight) ||
      patch.risk_weight <= 0 ||
      patch.risk_weight > 1
    ) {
      throw new SectorMasterError(
        'invalid_risk_weight',
        'risk_weight must be a finite number in (0, 1]',
      );
    }
  }
  if (patch.regulatory_category !== undefined && !isRegulatoryCategory(patch.regulatory_category)) {
    throw new SectorMasterError(
      'invalid_category',
      'regulatory_category must be valid',
    );
  }
  if (patch.description !== undefined && patch.description !== null) {
    if (typeof patch.description !== 'string' || patch.description.length > 1000) {
      throw new SectorMasterError(
        'invalid_description',
        'description must be a string ≤ 1000 chars (or null)',
      );
    }
  }
}

export interface SectorMasterStore {
  list(tenant_id: string, opts?: { include_deleted?: boolean }): SectorMasterEntry[];
  get(tenant_id: string, sector_id: string): SectorMasterEntry | null;
  create(
    tenant_id: string,
    input: SectorMasterCreateInput,
    actor: string,
    now: Date,
  ): SectorMasterEntry;
  update(
    tenant_id: string,
    sector_id: string,
    patch: SectorMasterUpdateInput,
    actor: string,
    now: Date,
  ): SectorMasterEntry;
  /** Soft-delete (sets deleted_at/_by, returns the deleted row for the
   *  Recovery Center archive call). */
  softDelete(
    tenant_id: string,
    sector_id: string,
    actor: string,
    now: Date,
  ): SectorMasterEntry;
  /** Recovery Center adapter calls this to re-insert a previously-deleted
   *  row using its original_id + payload. Returns false on conflict
   *  (sector_id already taken in the live set). */
  restore(payload: SectorMasterEntry): boolean;
}

export class InMemorySectorMasterStore implements SectorMasterStore {
  // tenant_id -> sector_id -> entry. Soft-deleted rows stay here with
  // deleted_at != null so the restore() handshake works.
  private byTenant = new Map<string, Map<string, SectorMasterEntry>>();

  private bucket(tenant_id: string): Map<string, SectorMasterEntry> {
    let b = this.byTenant.get(tenant_id);
    if (!b) {
      b = new Map();
      this.byTenant.set(tenant_id, b);
    }
    return b;
  }

  list(
    tenant_id: string,
    opts: { include_deleted?: boolean } = {},
  ): SectorMasterEntry[] {
    const out: SectorMasterEntry[] = [];
    const b = this.byTenant.get(tenant_id);
    if (!b) return out;
    for (const e of b.values()) {
      if (!opts.include_deleted && e.deleted_at) continue;
      out.push({ ...e });
    }
    // Stable canonical order: sector_name asc, then sector_id asc.
    out.sort((a, b) => {
      const n = a.sector_name.localeCompare(b.sector_name);
      return n !== 0 ? n : a.sector_id.localeCompare(b.sector_id);
    });
    return out;
  }

  get(tenant_id: string, sector_id: string): SectorMasterEntry | null {
    const e = this.byTenant.get(tenant_id)?.get(sector_id);
    if (!e || e.deleted_at) return null;
    return { ...e };
  }

  create(
    tenant_id: string,
    input: SectorMasterCreateInput,
    actor: string,
    now: Date,
  ): SectorMasterEntry {
    validateCreate(input);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new SectorMasterError('invalid_input', 'actor (created_by) required');
    }
    const b = this.bucket(tenant_id);
    const existing = b.get(input.sector_id);
    // Conflict if a non-deleted row already holds the id.
    if (existing && !existing.deleted_at) {
      throw new SectorMasterError(
        'duplicate_sector_id',
        `sector_id ${input.sector_id} already exists`,
        { sector_id: input.sector_id },
      );
    }
    // Cap check counts only live rows.
    const live = [...b.values()].filter((e) => !e.deleted_at).length;
    if (live >= SECTOR_MASTER_CAP_PER_TENANT) {
      throw new SectorMasterError(
        'cap_reached',
        `sector master cap (${SECTOR_MASTER_CAP_PER_TENANT}) reached`,
      );
    }
    const ts = now.toISOString();
    const entry: SectorMasterEntry = {
      sector_id: input.sector_id,
      tenant_id,
      sector_name: input.sector_name.trim(),
      risk_weight: input.risk_weight,
      regulatory_category: input.regulatory_category,
      description: input.description?.trim() || null,
      active: input.active !== undefined ? !!input.active : true,
      created_at: ts,
      created_by: actor,
      updated_at: ts,
      updated_by: actor,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(entry.sector_id, entry);
    return { ...entry };
  }

  update(
    tenant_id: string,
    sector_id: string,
    patch: SectorMasterUpdateInput,
    actor: string,
    now: Date,
  ): SectorMasterEntry {
    validateUpdate(patch);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new SectorMasterError('invalid_input', 'actor (updated_by) required');
    }
    const b = this.bucket(tenant_id);
    const e = b.get(sector_id);
    if (!e || e.deleted_at) {
      throw new SectorMasterError(
        'unknown_sector',
        `sector_id ${sector_id} not found in tenant ${tenant_id}`,
        { sector_id },
      );
    }
    const next: SectorMasterEntry = { ...e };
    if (patch.sector_name !== undefined) next.sector_name = patch.sector_name.trim();
    if (patch.risk_weight !== undefined) next.risk_weight = patch.risk_weight;
    if (patch.regulatory_category !== undefined) {
      next.regulatory_category = patch.regulatory_category;
    }
    if (patch.description !== undefined) {
      next.description =
        patch.description === null ? null : patch.description.trim() || null;
    }
    if (patch.active !== undefined) next.active = !!patch.active;
    next.updated_at = now.toISOString();
    next.updated_by = actor;
    b.set(sector_id, next);
    return { ...next };
  }

  softDelete(
    tenant_id: string,
    sector_id: string,
    actor: string,
    now: Date,
  ): SectorMasterEntry {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new SectorMasterError('invalid_input', 'actor (deleted_by) required');
    }
    const b = this.bucket(tenant_id);
    const e = b.get(sector_id);
    if (!e || e.deleted_at) {
      throw new SectorMasterError(
        'unknown_sector',
        `sector_id ${sector_id} not found in tenant ${tenant_id}`,
        { sector_id },
      );
    }
    const ts = now.toISOString();
    const tombstoned: SectorMasterEntry = {
      ...e,
      deleted_at: ts,
      deleted_by: actor,
      updated_at: ts,
      updated_by: actor,
    };
    b.set(sector_id, tombstoned);
    return { ...tombstoned };
  }

  restore(payload: SectorMasterEntry): boolean {
    if (!payload || typeof payload !== 'object') return false;
    if (typeof payload.sector_id !== 'string' || typeof payload.tenant_id !== 'string') {
      return false;
    }
    const b = this.bucket(payload.tenant_id);
    const existing = b.get(payload.sector_id);
    // Restore-conflict semantics: if a LIVE row already holds the id,
    // refuse. If a soft-deleted row exists, overwrite (resurrects it).
    if (existing && !existing.deleted_at) return false;
    b.set(payload.sector_id, {
      ...payload,
      deleted_at: null,
      deleted_by: null,
    });
    return true;
  }
}

/** Module-level singleton — server.ts uses this by default. Tests
 *  inject their own InMemorySectorMasterStore via AppDeps. */
export const defaultSectorMasterStore: SectorMasterStore =
  new InMemorySectorMasterStore();
