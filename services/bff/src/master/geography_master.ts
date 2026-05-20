// services/bff/src/master/geography_master.ts
//
// PHASE A.2 — Geography & Risk Region Master Setup (PDF §7 Master Setup
// item 5). Tenant-scoped master data for country / region risk + sanction
// flags. Used by AML M14.3 + EWS scoring overlays.
//
// Architecture mirrors Phase A.1 (sector_master.ts):
//   - Additive only — no changes to existing AML/EWS runtime.
//   - Pure in-memory store with audit fields + soft-delete + Recovery
//     Center adapter.
//   - Pg-backed swap deferred (interface stable).
//   - RBAC: audit:read (admin-only — country risk + sanctions are
//     compliance-sensitive master data).
//
// Distinct from M14.3 AML adapter:
//   - M14.3 ships READ-side sanctions / PEP / adverse-media match probes
//     from upstream watchlists per customer.
//   - M_GEO ships per-tenant CRUD master-data for country-level baseline
//     risk + the sanction_flag overlay that consumers (M14.3, M6.x scoring,
//     SPA AML dashboard) can layer onto upstream signals.

/** Canonical risk levels — closed enum so SPA filter chips + colour
 *  mappings stay stable. Order is canonical (worst-first). */
export const ALL_GEO_RISK_LEVELS = ['high', 'medium', 'low'] as const;
export type GeoRiskLevel = (typeof ALL_GEO_RISK_LEVELS)[number];

export function isGeoRiskLevel(v: unknown): v is GeoRiskLevel {
  return typeof v === 'string' && (ALL_GEO_RISK_LEVELS as readonly string[]).includes(v);
}

/** Canonical FATF AML regimes. Closed enum so SPA can render colour-coded
 *  badges + the M14.3 AML overlay knows how to interpret. */
export const ALL_AML_REGIMES = [
  'fatf_blacklist',
  'fatf_greylist',
  'enhanced_due_diligence',
  'standard',
  'low_risk',
] as const;
export type AmlRegime = (typeof ALL_AML_REGIMES)[number];

export function isAmlRegime(v: unknown): v is AmlRegime {
  return typeof v === 'string' && (ALL_AML_REGIMES as readonly string[]).includes(v);
}

/** Master-data row. country_code is the natural key (ISO 3166-1 alpha-2:
 *  IN, US, GB, BT). risk_level + sanction_flag + aml_regime overlay any
 *  upstream signals. */
export interface GeographyMasterEntry {
  country_code: string;
  tenant_id: string;
  country_name: string;
  risk_level: GeoRiskLevel;
  sanction_flag: boolean;
  aml_regime: AmlRegime;
  region: string | null;           // 'APAC', 'EMEA', etc. — free-text bucket
  notes: string | null;
  active: boolean;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface GeographyMasterCreateInput {
  country_code: string;
  country_name: string;
  risk_level: GeoRiskLevel;
  sanction_flag?: boolean;
  aml_regime?: AmlRegime;
  region?: string | null;
  notes?: string | null;
  active?: boolean;
}

export interface GeographyMasterUpdateInput {
  country_name?: string;
  risk_level?: GeoRiskLevel;
  sanction_flag?: boolean;
  aml_regime?: AmlRegime;
  region?: string | null;
  notes?: string | null;
  active?: boolean;
}

export class GeographyMasterError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_country_code'
      | 'invalid_country_name'
      | 'invalid_risk_level'
      | 'invalid_aml_regime'
      | 'invalid_region'
      | 'invalid_notes'
      | 'unknown_country'
      | 'duplicate_country_code'
      | 'cap_reached',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'GeographyMasterError';
  }
}

/** UN has 193 member states + ~50 territories. 300 leaves headroom. */
export const GEOGRAPHY_MASTER_CAP_PER_TENANT = 300;

// ISO 3166-1 alpha-2 country-code: exactly 2 uppercase letters.
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

function validateCreate(input: GeographyMasterCreateInput): void {
  if (!input || typeof input !== 'object') {
    throw new GeographyMasterError('invalid_input', 'request body must be an object');
  }
  if (typeof input.country_code !== 'string' || !COUNTRY_CODE_RE.test(input.country_code)) {
    throw new GeographyMasterError(
      'invalid_country_code',
      'country_code must be ISO 3166-1 alpha-2 (e.g. IN, US, BT)',
    );
  }
  if (
    typeof input.country_name !== 'string' ||
    input.country_name.trim().length === 0 ||
    input.country_name.length > 120
  ) {
    throw new GeographyMasterError(
      'invalid_country_name',
      'country_name must be 1..120 chars after trim',
    );
  }
  if (!isGeoRiskLevel(input.risk_level)) {
    throw new GeographyMasterError(
      'invalid_risk_level',
      `risk_level must be one of: ${ALL_GEO_RISK_LEVELS.join(', ')}`,
    );
  }
  if (input.aml_regime !== undefined && !isAmlRegime(input.aml_regime)) {
    throw new GeographyMasterError(
      'invalid_aml_regime',
      `aml_regime must be one of: ${ALL_AML_REGIMES.join(', ')}`,
    );
  }
  if (input.region != null) {
    if (typeof input.region !== 'string' || input.region.length > 80) {
      throw new GeographyMasterError(
        'invalid_region',
        'region must be a string ≤ 80 chars (or null)',
      );
    }
  }
  if (input.notes != null) {
    if (typeof input.notes !== 'string' || input.notes.length > 1000) {
      throw new GeographyMasterError(
        'invalid_notes',
        'notes must be a string ≤ 1000 chars (or null)',
      );
    }
  }
  if (input.sanction_flag !== undefined && typeof input.sanction_flag !== 'boolean') {
    throw new GeographyMasterError('invalid_input', 'sanction_flag must be boolean');
  }
}

function validateUpdate(patch: GeographyMasterUpdateInput): void {
  if (!patch || typeof patch !== 'object') {
    throw new GeographyMasterError('invalid_input', 'patch must be an object');
  }
  if (patch.country_name !== undefined) {
    if (
      typeof patch.country_name !== 'string' ||
      patch.country_name.trim().length === 0 ||
      patch.country_name.length > 120
    ) {
      throw new GeographyMasterError(
        'invalid_country_name',
        'country_name must be 1..120 chars after trim',
      );
    }
  }
  if (patch.risk_level !== undefined && !isGeoRiskLevel(patch.risk_level)) {
    throw new GeographyMasterError('invalid_risk_level', 'risk_level invalid');
  }
  if (patch.aml_regime !== undefined && !isAmlRegime(patch.aml_regime)) {
    throw new GeographyMasterError('invalid_aml_regime', 'aml_regime invalid');
  }
  if (patch.region !== undefined && patch.region !== null) {
    if (typeof patch.region !== 'string' || patch.region.length > 80) {
      throw new GeographyMasterError('invalid_region', 'region too long or wrong type');
    }
  }
  if (patch.notes !== undefined && patch.notes !== null) {
    if (typeof patch.notes !== 'string' || patch.notes.length > 1000) {
      throw new GeographyMasterError('invalid_notes', 'notes too long or wrong type');
    }
  }
  if (patch.sanction_flag !== undefined && typeof patch.sanction_flag !== 'boolean') {
    throw new GeographyMasterError('invalid_input', 'sanction_flag must be boolean');
  }
}

export interface GeographyMasterStore {
  list(
    tenant_id: string,
    opts?: {
      include_deleted?: boolean;
      risk_level?: GeoRiskLevel;
      sanction_flag?: boolean;
    },
  ): GeographyMasterEntry[];
  get(tenant_id: string, country_code: string): GeographyMasterEntry | null;
  create(
    tenant_id: string,
    input: GeographyMasterCreateInput,
    actor: string,
    now: Date,
  ): GeographyMasterEntry;
  update(
    tenant_id: string,
    country_code: string,
    patch: GeographyMasterUpdateInput,
    actor: string,
    now: Date,
  ): GeographyMasterEntry;
  softDelete(
    tenant_id: string,
    country_code: string,
    actor: string,
    now: Date,
  ): GeographyMasterEntry;
  restore(payload: GeographyMasterEntry): boolean;
}

export class InMemoryGeographyMasterStore implements GeographyMasterStore {
  private byTenant = new Map<string, Map<string, GeographyMasterEntry>>();

  private bucket(tenant_id: string): Map<string, GeographyMasterEntry> {
    let b = this.byTenant.get(tenant_id);
    if (!b) {
      b = new Map();
      this.byTenant.set(tenant_id, b);
    }
    return b;
  }

  list(
    tenant_id: string,
    opts: {
      include_deleted?: boolean;
      risk_level?: GeoRiskLevel;
      sanction_flag?: boolean;
    } = {},
  ): GeographyMasterEntry[] {
    const b = this.byTenant.get(tenant_id);
    if (!b) return [];
    const out: GeographyMasterEntry[] = [];
    for (const e of b.values()) {
      if (!opts.include_deleted && e.deleted_at) continue;
      if (opts.risk_level !== undefined && e.risk_level !== opts.risk_level) continue;
      if (opts.sanction_flag !== undefined && e.sanction_flag !== opts.sanction_flag) continue;
      out.push({ ...e });
    }
    // Canonical sort: country_name asc, then country_code asc.
    out.sort((a, b) => {
      const n = a.country_name.localeCompare(b.country_name);
      return n !== 0 ? n : a.country_code.localeCompare(b.country_code);
    });
    return out;
  }

  get(tenant_id: string, country_code: string): GeographyMasterEntry | null {
    const e = this.byTenant.get(tenant_id)?.get(country_code);
    if (!e || e.deleted_at) return null;
    return { ...e };
  }

  create(
    tenant_id: string,
    input: GeographyMasterCreateInput,
    actor: string,
    now: Date,
  ): GeographyMasterEntry {
    validateCreate(input);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new GeographyMasterError('invalid_input', 'actor (created_by) required');
    }
    const b = this.bucket(tenant_id);
    const existing = b.get(input.country_code);
    if (existing && !existing.deleted_at) {
      throw new GeographyMasterError(
        'duplicate_country_code',
        `country_code ${input.country_code} already exists`,
        { country_code: input.country_code },
      );
    }
    const live = [...b.values()].filter((e) => !e.deleted_at).length;
    if (live >= GEOGRAPHY_MASTER_CAP_PER_TENANT) {
      throw new GeographyMasterError(
        'cap_reached',
        `geography master cap (${GEOGRAPHY_MASTER_CAP_PER_TENANT}) reached`,
      );
    }
    const ts = now.toISOString();
    const entry: GeographyMasterEntry = {
      country_code: input.country_code,
      tenant_id,
      country_name: input.country_name.trim(),
      risk_level: input.risk_level,
      sanction_flag: input.sanction_flag === true,
      aml_regime: input.aml_regime ?? 'standard',
      region: input.region != null ? (input.region.trim() || null) : null,
      notes: input.notes != null ? (input.notes.trim() || null) : null,
      active: input.active !== undefined ? !!input.active : true,
      created_at: ts,
      created_by: actor,
      updated_at: ts,
      updated_by: actor,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(entry.country_code, entry);
    return { ...entry };
  }

  update(
    tenant_id: string,
    country_code: string,
    patch: GeographyMasterUpdateInput,
    actor: string,
    now: Date,
  ): GeographyMasterEntry {
    validateUpdate(patch);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new GeographyMasterError('invalid_input', 'actor (updated_by) required');
    }
    const b = this.bucket(tenant_id);
    const e = b.get(country_code);
    if (!e || e.deleted_at) {
      throw new GeographyMasterError(
        'unknown_country',
        `country_code ${country_code} not found in tenant ${tenant_id}`,
        { country_code },
      );
    }
    const next: GeographyMasterEntry = { ...e };
    if (patch.country_name !== undefined) next.country_name = patch.country_name.trim();
    if (patch.risk_level !== undefined) next.risk_level = patch.risk_level;
    if (patch.sanction_flag !== undefined) next.sanction_flag = !!patch.sanction_flag;
    if (patch.aml_regime !== undefined) next.aml_regime = patch.aml_regime;
    if (patch.region !== undefined) {
      next.region = patch.region === null ? null : patch.region.trim() || null;
    }
    if (patch.notes !== undefined) {
      next.notes = patch.notes === null ? null : patch.notes.trim() || null;
    }
    if (patch.active !== undefined) next.active = !!patch.active;
    next.updated_at = now.toISOString();
    next.updated_by = actor;
    b.set(country_code, next);
    return { ...next };
  }

  softDelete(
    tenant_id: string,
    country_code: string,
    actor: string,
    now: Date,
  ): GeographyMasterEntry {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new GeographyMasterError('invalid_input', 'actor (deleted_by) required');
    }
    const b = this.bucket(tenant_id);
    const e = b.get(country_code);
    if (!e || e.deleted_at) {
      throw new GeographyMasterError(
        'unknown_country',
        `country_code ${country_code} not found in tenant ${tenant_id}`,
        { country_code },
      );
    }
    const ts = now.toISOString();
    const tombstoned: GeographyMasterEntry = {
      ...e,
      deleted_at: ts,
      deleted_by: actor,
      updated_at: ts,
      updated_by: actor,
    };
    b.set(country_code, tombstoned);
    return { ...tombstoned };
  }

  restore(payload: GeographyMasterEntry): boolean {
    if (!payload || typeof payload !== 'object') return false;
    if (typeof payload.country_code !== 'string' || typeof payload.tenant_id !== 'string') {
      return false;
    }
    const b = this.bucket(payload.tenant_id);
    const existing = b.get(payload.country_code);
    if (existing && !existing.deleted_at) return false;
    b.set(payload.country_code, {
      ...payload,
      deleted_at: null,
      deleted_by: null,
    });
    return true;
  }
}

export const defaultGeographyMasterStore: GeographyMasterStore =
  new InMemoryGeographyMasterStore();
