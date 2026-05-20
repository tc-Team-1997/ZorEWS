// services/bff/src/master/customer_master.ts
//
// PHASE B.1 — Customer Master Setup (PDF §3 Master Setup item 1).
//
// Tenant-scoped overlay on top of the existing mart.customer_360
// dataset. Admins register the COMPLIANCE-CRITICAL master attributes
// per customer (KYC status, PEP flag, risk_category override, segment,
// industry, country, mandatory-field configuration) that don't change
// often and aren't sourced from CBS automatically.
//
// Architecture mirrors Phase A.1 sector_master:
//   - Additive only — no changes to existing M11.6 Customer 360 or
//     M6.x scoring; both can OPT to overlay master attributes when
//     they want a deterministic value vs. an inferred one.
//   - Pure in-memory store; pg-backed swap deferred.
//   - Audit fields + soft-delete + Recovery Center adapter.
//   - RBAC audit:read (admin-only — KYC/PEP changes are compliance-
//     sensitive and audit-traced).

/** Customer types — closed enum matching M11.6 / mart.customer_360
 *  conventions. */
export const ALL_CUSTOMER_TYPES = ['retail', 'corporate', 'sme', 'msme', 'priority'] as const;
export type CustomerType = (typeof ALL_CUSTOMER_TYPES)[number];

export function isCustomerType(v: unknown): v is CustomerType {
  return typeof v === 'string' && (ALL_CUSTOMER_TYPES as readonly string[]).includes(v);
}

/** KYC verification status. Closed enum. */
export const ALL_KYC_STATUSES = ['pending', 'verified', 'expired', 'failed', 'exempt'] as const;
export type KycStatus = (typeof ALL_KYC_STATUSES)[number];

export function isKycStatus(v: unknown): v is KycStatus {
  return typeof v === 'string' && (ALL_KYC_STATUSES as readonly string[]).includes(v);
}

/** Risk category override. Closed enum. Operates as an ADMIN
 *  OVERRIDE of any computed risk score — useful when ops needs to
 *  force a customer into a specific category for compliance reasons. */
export const ALL_RISK_CATEGORIES = ['low', 'medium', 'high'] as const;
export type RiskCategory = (typeof ALL_RISK_CATEGORIES)[number];

export function isRiskCategory(v: unknown): v is RiskCategory {
  return typeof v === 'string' && (ALL_RISK_CATEGORIES as readonly string[]).includes(v);
}

export interface CustomerMasterEntry {
  customer_id: string;
  tenant_id: string;
  customer_type: CustomerType;
  segment: string | null;       // free-text, e.g. 'premium' / 'mass-market'
  risk_category: RiskCategory | null;  // override; null = use computed
  kyc_status: KycStatus;
  kyc_expires_at: string | null;  // ISO; ops needs to know when to re-verify
  pep_flag: boolean;
  country: string;                 // ISO 3166-1 alpha-2; cross-ref with geography_master
  industry: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface CustomerMasterCreateInput {
  customer_id: string;
  customer_type: CustomerType;
  segment?: string | null;
  risk_category?: RiskCategory | null;
  kyc_status: KycStatus;
  kyc_expires_at?: string | null;
  pep_flag?: boolean;
  country: string;
  industry?: string | null;
  notes?: string | null;
  active?: boolean;
}

export interface CustomerMasterUpdateInput {
  customer_type?: CustomerType;
  segment?: string | null;
  risk_category?: RiskCategory | null;
  kyc_status?: KycStatus;
  kyc_expires_at?: string | null;
  pep_flag?: boolean;
  country?: string;
  industry?: string | null;
  notes?: string | null;
  active?: boolean;
}

export class CustomerMasterError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_customer_id'
      | 'invalid_type'
      | 'invalid_risk_category'
      | 'invalid_kyc_status'
      | 'invalid_kyc_expires_at'
      | 'invalid_country'
      | 'invalid_segment_or_industry'
      | 'invalid_notes'
      | 'unknown_customer'
      | 'duplicate_customer_id'
      | 'cap_reached',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'CustomerMasterError';
  }
}

/** ~100k customers seems generous for the in-memory prototype. */
export const CUSTOMER_MASTER_CAP_PER_TENANT = 100_000;

// Customer IDs allow alphanumeric + dash + underscore (UUIDs, CBS ids,
// or human-readable). Max 64 chars to align with most upstream systems.
const CUSTOMER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function validateCreate(input: CustomerMasterCreateInput): void {
  if (!input || typeof input !== 'object') {
    throw new CustomerMasterError('invalid_input', 'request body must be an object');
  }
  if (typeof input.customer_id !== 'string' || !CUSTOMER_ID_RE.test(input.customer_id)) {
    throw new CustomerMasterError(
      'invalid_customer_id',
      'customer_id must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',
    );
  }
  if (!isCustomerType(input.customer_type)) {
    throw new CustomerMasterError(
      'invalid_type',
      `customer_type must be one of: ${ALL_CUSTOMER_TYPES.join(', ')}`,
    );
  }
  if (!isKycStatus(input.kyc_status)) {
    throw new CustomerMasterError(
      'invalid_kyc_status',
      `kyc_status must be one of: ${ALL_KYC_STATUSES.join(', ')}`,
    );
  }
  if (input.risk_category != null && !isRiskCategory(input.risk_category)) {
    throw new CustomerMasterError(
      'invalid_risk_category',
      `risk_category must be one of: ${ALL_RISK_CATEGORIES.join(', ')} or null`,
    );
  }
  if (typeof input.country !== 'string' || !COUNTRY_RE.test(input.country)) {
    throw new CustomerMasterError(
      'invalid_country',
      'country must be ISO 3166-1 alpha-2 (e.g. IN, US, BT)',
    );
  }
  if (input.kyc_expires_at != null) {
    if (typeof input.kyc_expires_at !== 'string' || !ISO_TS_RE.test(input.kyc_expires_at)) {
      throw new CustomerMasterError(
        'invalid_kyc_expires_at',
        'kyc_expires_at must be ISO-8601 datetime (or null)',
      );
    }
    if (!Number.isFinite(Date.parse(input.kyc_expires_at))) {
      throw new CustomerMasterError('invalid_kyc_expires_at', 'kyc_expires_at not parseable');
    }
  }
  if (input.segment != null) {
    if (typeof input.segment !== 'string' || input.segment.length > 80) {
      throw new CustomerMasterError(
        'invalid_segment_or_industry',
        'segment must be string ≤ 80 chars (or null)',
      );
    }
  }
  if (input.industry != null) {
    if (typeof input.industry !== 'string' || input.industry.length > 80) {
      throw new CustomerMasterError(
        'invalid_segment_or_industry',
        'industry must be string ≤ 80 chars (or null)',
      );
    }
  }
  if (input.notes != null) {
    if (typeof input.notes !== 'string' || input.notes.length > 1000) {
      throw new CustomerMasterError(
        'invalid_notes',
        'notes must be string ≤ 1000 chars (or null)',
      );
    }
  }
  if (input.pep_flag !== undefined && typeof input.pep_flag !== 'boolean') {
    throw new CustomerMasterError('invalid_input', 'pep_flag must be boolean');
  }
}

function validateUpdate(patch: CustomerMasterUpdateInput): void {
  if (!patch || typeof patch !== 'object') {
    throw new CustomerMasterError('invalid_input', 'patch must be an object');
  }
  if (patch.customer_type !== undefined && !isCustomerType(patch.customer_type)) {
    throw new CustomerMasterError('invalid_type', 'customer_type invalid');
  }
  if (patch.kyc_status !== undefined && !isKycStatus(patch.kyc_status)) {
    throw new CustomerMasterError('invalid_kyc_status', 'kyc_status invalid');
  }
  if (
    patch.risk_category !== undefined &&
    patch.risk_category !== null &&
    !isRiskCategory(patch.risk_category)
  ) {
    throw new CustomerMasterError('invalid_risk_category', 'risk_category invalid');
  }
  if (patch.country !== undefined && !COUNTRY_RE.test(patch.country)) {
    throw new CustomerMasterError('invalid_country', 'country invalid');
  }
  if (patch.kyc_expires_at !== undefined && patch.kyc_expires_at !== null) {
    if (typeof patch.kyc_expires_at !== 'string' || !ISO_TS_RE.test(patch.kyc_expires_at)) {
      throw new CustomerMasterError('invalid_kyc_expires_at', 'kyc_expires_at invalid');
    }
  }
  if (patch.segment !== undefined && patch.segment !== null) {
    if (typeof patch.segment !== 'string' || patch.segment.length > 80) {
      throw new CustomerMasterError('invalid_segment_or_industry', 'segment invalid');
    }
  }
  if (patch.industry !== undefined && patch.industry !== null) {
    if (typeof patch.industry !== 'string' || patch.industry.length > 80) {
      throw new CustomerMasterError('invalid_segment_or_industry', 'industry invalid');
    }
  }
  if (patch.notes !== undefined && patch.notes !== null) {
    if (typeof patch.notes !== 'string' || patch.notes.length > 1000) {
      throw new CustomerMasterError('invalid_notes', 'notes invalid');
    }
  }
  if (patch.pep_flag !== undefined && typeof patch.pep_flag !== 'boolean') {
    throw new CustomerMasterError('invalid_input', 'pep_flag invalid');
  }
}

export interface CustomerMasterStore {
  list(
    tenant_id: string,
    opts?: {
      include_deleted?: boolean;
      customer_type?: CustomerType;
      kyc_status?: KycStatus;
      risk_category?: RiskCategory;
      pep_flag?: boolean;
      country?: string;
      limit?: number;
    },
  ): CustomerMasterEntry[];
  get(tenant_id: string, customer_id: string): CustomerMasterEntry | null;
  create(
    tenant_id: string,
    input: CustomerMasterCreateInput,
    actor: string,
    now: Date,
  ): CustomerMasterEntry;
  update(
    tenant_id: string,
    customer_id: string,
    patch: CustomerMasterUpdateInput,
    actor: string,
    now: Date,
  ): CustomerMasterEntry;
  softDelete(
    tenant_id: string,
    customer_id: string,
    actor: string,
    now: Date,
  ): CustomerMasterEntry;
  restore(payload: CustomerMasterEntry): boolean;
}

export class InMemoryCustomerMasterStore implements CustomerMasterStore {
  private byTenant = new Map<string, Map<string, CustomerMasterEntry>>();

  private bucket(tenant_id: string): Map<string, CustomerMasterEntry> {
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
      customer_type?: CustomerType;
      kyc_status?: KycStatus;
      risk_category?: RiskCategory;
      pep_flag?: boolean;
      country?: string;
      limit?: number;
    } = {},
  ): CustomerMasterEntry[] {
    const b = this.byTenant.get(tenant_id);
    if (!b) return [];
    let out: CustomerMasterEntry[] = [];
    for (const e of b.values()) {
      if (!opts.include_deleted && e.deleted_at) continue;
      if (opts.customer_type && e.customer_type !== opts.customer_type) continue;
      if (opts.kyc_status && e.kyc_status !== opts.kyc_status) continue;
      if (opts.risk_category && e.risk_category !== opts.risk_category) continue;
      if (opts.pep_flag !== undefined && e.pep_flag !== opts.pep_flag) continue;
      if (opts.country && e.country !== opts.country) continue;
      out.push({ ...e });
    }
    // Sort: PEP/high-risk first (compliance priority), then by
    // customer_id asc for stable rendering.
    out.sort((a, b) => {
      const pepDiff = (b.pep_flag ? 1 : 0) - (a.pep_flag ? 1 : 0);
      if (pepDiff !== 0) return pepDiff;
      return a.customer_id.localeCompare(b.customer_id);
    });
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
    if (out.length > limit) out = out.slice(0, limit);
    return out;
  }

  get(tenant_id: string, customer_id: string): CustomerMasterEntry | null {
    const e = this.byTenant.get(tenant_id)?.get(customer_id);
    if (!e || e.deleted_at) return null;
    return { ...e };
  }

  create(
    tenant_id: string,
    input: CustomerMasterCreateInput,
    actor: string,
    now: Date,
  ): CustomerMasterEntry {
    validateCreate(input);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new CustomerMasterError('invalid_input', 'actor (created_by) required');
    }
    const b = this.bucket(tenant_id);
    const existing = b.get(input.customer_id);
    if (existing && !existing.deleted_at) {
      throw new CustomerMasterError(
        'duplicate_customer_id',
        `customer_id ${input.customer_id} already exists`,
        { customer_id: input.customer_id },
      );
    }
    const live = [...b.values()].filter((e) => !e.deleted_at).length;
    if (live >= CUSTOMER_MASTER_CAP_PER_TENANT) {
      throw new CustomerMasterError(
        'cap_reached',
        `customer master cap (${CUSTOMER_MASTER_CAP_PER_TENANT}) reached`,
      );
    }
    const ts = now.toISOString();
    const entry: CustomerMasterEntry = {
      customer_id: input.customer_id,
      tenant_id,
      customer_type: input.customer_type,
      segment: input.segment != null ? input.segment.trim() || null : null,
      risk_category: input.risk_category ?? null,
      kyc_status: input.kyc_status,
      kyc_expires_at: input.kyc_expires_at ?? null,
      pep_flag: input.pep_flag === true,
      country: input.country,
      industry: input.industry != null ? input.industry.trim() || null : null,
      notes: input.notes != null ? input.notes.trim() || null : null,
      active: input.active !== undefined ? !!input.active : true,
      created_at: ts,
      created_by: actor,
      updated_at: ts,
      updated_by: actor,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(entry.customer_id, entry);
    return { ...entry };
  }

  update(
    tenant_id: string,
    customer_id: string,
    patch: CustomerMasterUpdateInput,
    actor: string,
    now: Date,
  ): CustomerMasterEntry {
    validateUpdate(patch);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new CustomerMasterError('invalid_input', 'actor (updated_by) required');
    }
    const b = this.bucket(tenant_id);
    const e = b.get(customer_id);
    if (!e || e.deleted_at) {
      throw new CustomerMasterError(
        'unknown_customer',
        `customer_id ${customer_id} not found in tenant ${tenant_id}`,
        { customer_id },
      );
    }
    const next: CustomerMasterEntry = { ...e };
    if (patch.customer_type !== undefined) next.customer_type = patch.customer_type;
    if (patch.segment !== undefined) {
      next.segment = patch.segment === null ? null : patch.segment.trim() || null;
    }
    if (patch.risk_category !== undefined) next.risk_category = patch.risk_category;
    if (patch.kyc_status !== undefined) next.kyc_status = patch.kyc_status;
    if (patch.kyc_expires_at !== undefined) next.kyc_expires_at = patch.kyc_expires_at;
    if (patch.pep_flag !== undefined) next.pep_flag = !!patch.pep_flag;
    if (patch.country !== undefined) next.country = patch.country;
    if (patch.industry !== undefined) {
      next.industry = patch.industry === null ? null : patch.industry.trim() || null;
    }
    if (patch.notes !== undefined) {
      next.notes = patch.notes === null ? null : patch.notes.trim() || null;
    }
    if (patch.active !== undefined) next.active = !!patch.active;
    next.updated_at = now.toISOString();
    next.updated_by = actor;
    b.set(customer_id, next);
    return { ...next };
  }

  softDelete(
    tenant_id: string,
    customer_id: string,
    actor: string,
    now: Date,
  ): CustomerMasterEntry {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new CustomerMasterError('invalid_input', 'actor (deleted_by) required');
    }
    const b = this.bucket(tenant_id);
    const e = b.get(customer_id);
    if (!e || e.deleted_at) {
      throw new CustomerMasterError(
        'unknown_customer',
        `customer_id ${customer_id} not found`,
        { customer_id },
      );
    }
    const ts = now.toISOString();
    const tombstoned: CustomerMasterEntry = {
      ...e,
      deleted_at: ts,
      deleted_by: actor,
      updated_at: ts,
      updated_by: actor,
    };
    b.set(customer_id, tombstoned);
    return { ...tombstoned };
  }

  restore(payload: CustomerMasterEntry): boolean {
    if (!payload || typeof payload !== 'object') return false;
    if (typeof payload.customer_id !== 'string' || typeof payload.tenant_id !== 'string') {
      return false;
    }
    const b = this.bucket(payload.tenant_id);
    const existing = b.get(payload.customer_id);
    if (existing && !existing.deleted_at) return false;
    b.set(payload.customer_id, { ...payload, deleted_at: null, deleted_by: null });
    return true;
  }
}

export const defaultCustomerMasterStore: CustomerMasterStore =
  new InMemoryCustomerMasterStore();

// ─── KYC-expiry helpers (consumed by SPA + downstream alerting) ───────

/** Pure helper. Returns customers whose KYC expires within
 *  `lookahead_days` (default 30). Useful for compliance alert builds. */
export function listKycExpiringCustomers(
  store: CustomerMasterStore,
  tenant_id: string,
  now: Date,
  lookahead_days: number = 30,
): CustomerMasterEntry[] {
  const horizon = now.getTime() + lookahead_days * 86_400_000;
  return store
    .list(tenant_id, { limit: 5000 })
    .filter((e) => {
      if (e.kyc_status === 'exempt') return false;
      if (!e.kyc_expires_at) return false;
      const t = Date.parse(e.kyc_expires_at);
      if (!Number.isFinite(t)) return false;
      // Expired OR within the lookahead window.
      return t <= horizon;
    })
    .sort((a, b) => {
      const ta = Date.parse(a.kyc_expires_at as string);
      const tb = Date.parse(b.kyc_expires_at as string);
      return ta - tb;
    });
}
