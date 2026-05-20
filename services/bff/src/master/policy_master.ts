// services/bff/src/master/policy_master.ts
//
// PHASE B.4 — Product & Policy Master Setup (PDF §5 Master Setup item 3).
//
// Tenant-scoped catalog of INSURANCE policy types with their default
// premium ranges, coverage limits, waiting periods, and renewal
// configuration. SPA insurance "issue policy" picker reads from this;
// M11.2 Underwriting dashboard reads max_coverage as a sanity threshold;
// M14.1 InsuranceAdapter's stub fixture aligns to this catalog so the
// SPA + adapter stay consistent.

/** Canonical insurance product categories — matches M14.1
 *  InsuranceAdapter convention so cross-module reads line up. */
export const ALL_POLICY_CATEGORIES = ['TERM_LIFE', 'ENDOWMENT', 'ULIP', 'GENERAL_HEALTH'] as const;
export type PolicyCategory = (typeof ALL_POLICY_CATEGORIES)[number];

export function isPolicyCategory(v: unknown): v is PolicyCategory {
  return typeof v === 'string' && (ALL_POLICY_CATEGORIES as readonly string[]).includes(v);
}

/** Premium payment frequencies. */
export const ALL_PREMIUM_FREQUENCIES = [
  'monthly',
  'quarterly',
  'half_yearly',
  'yearly',
  'single_pay',
] as const;
export type PremiumFrequency = (typeof ALL_PREMIUM_FREQUENCIES)[number];

export function isPremiumFrequency(v: unknown): v is PremiumFrequency {
  return typeof v === 'string' && (ALL_PREMIUM_FREQUENCIES as readonly string[]).includes(v);
}

/** Renewal type. */
export const ALL_RENEWAL_TYPES = ['auto', 'manual', 'on_demand'] as const;
export type RenewalType = (typeof ALL_RENEWAL_TYPES)[number];

export function isRenewalType(v: unknown): v is RenewalType {
  return typeof v === 'string' && (ALL_RENEWAL_TYPES as readonly string[]).includes(v);
}

export interface PolicyMasterEntry {
  policy_type_id: string;
  tenant_id: string;
  display_name: string;
  category: PolicyCategory;
  premium_frequency: PremiumFrequency;
  min_premium: number;
  max_premium: number;
  min_coverage: number;
  max_coverage: number;
  waiting_period_days: number;       // 0 for instant-cover products
  grace_period_days: number;         // standard 30 for term-life; tunable
  renewal_type: RenewalType;
  active: boolean;
  description: string | null;
  notes: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface PolicyMasterCreateInput {
  policy_type_id: string;
  display_name: string;
  category: PolicyCategory;
  premium_frequency?: PremiumFrequency;
  min_premium: number;
  max_premium: number;
  min_coverage: number;
  max_coverage: number;
  waiting_period_days?: number;
  grace_period_days?: number;
  renewal_type?: RenewalType;
  active?: boolean;
  description?: string | null;
  notes?: string | null;
}

export interface PolicyMasterUpdateInput {
  display_name?: string;
  category?: PolicyCategory;
  premium_frequency?: PremiumFrequency;
  min_premium?: number;
  max_premium?: number;
  min_coverage?: number;
  max_coverage?: number;
  waiting_period_days?: number;
  grace_period_days?: number;
  renewal_type?: RenewalType;
  active?: boolean;
  description?: string | null;
  notes?: string | null;
}

export class PolicyMasterError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_policy_type_id'
      | 'invalid_name'
      | 'invalid_category'
      | 'invalid_premium_frequency'
      | 'invalid_renewal_type'
      | 'invalid_premium_range'
      | 'invalid_coverage_range'
      | 'invalid_period'
      | 'invalid_description_or_notes'
      | 'unknown_policy_type'
      | 'duplicate_policy_type_id'
      | 'cap_reached',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'PolicyMasterError';
  }
}

export const POLICY_MASTER_CAP_PER_TENANT = 200;

const POLICY_ID_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

function validateRange(
  lo: unknown,
  hi: unknown,
  code: 'invalid_premium_range' | 'invalid_coverage_range',
  label: string,
): void {
  if (
    typeof lo !== 'number' ||
    typeof hi !== 'number' ||
    !Number.isFinite(lo) ||
    !Number.isFinite(hi) ||
    lo < 0 ||
    hi < lo
  ) {
    throw new PolicyMasterError(
      code,
      `${label}: min and max must be finite numbers ≥ 0 with max ≥ min`,
    );
  }
}

function validatePeriod(v: unknown, label: string): void {
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 365) {
    throw new PolicyMasterError(
      'invalid_period',
      `${label} must be a non-negative integer-like number ≤ 365`,
    );
  }
}

function validateCreate(input: PolicyMasterCreateInput): void {
  if (!input || typeof input !== 'object') {
    throw new PolicyMasterError('invalid_input', 'request body must be an object');
  }
  if (typeof input.policy_type_id !== 'string' || !POLICY_ID_RE.test(input.policy_type_id)) {
    throw new PolicyMasterError(
      'invalid_policy_type_id',
      'policy_type_id must match ^[A-Z][A-Z0-9_]{2,63}$',
    );
  }
  if (
    typeof input.display_name !== 'string' ||
    input.display_name.trim().length === 0 ||
    input.display_name.length > 200
  ) {
    throw new PolicyMasterError('invalid_name', 'display_name must be 1..200 chars');
  }
  if (!isPolicyCategory(input.category)) {
    throw new PolicyMasterError(
      'invalid_category',
      `category must be one of: ${ALL_POLICY_CATEGORIES.join(', ')}`,
    );
  }
  if (input.premium_frequency !== undefined && !isPremiumFrequency(input.premium_frequency)) {
    throw new PolicyMasterError('invalid_premium_frequency', 'premium_frequency invalid');
  }
  if (input.renewal_type !== undefined && !isRenewalType(input.renewal_type)) {
    throw new PolicyMasterError('invalid_renewal_type', 'renewal_type invalid');
  }
  validateRange(input.min_premium, input.max_premium, 'invalid_premium_range', 'premium');
  validateRange(input.min_coverage, input.max_coverage, 'invalid_coverage_range', 'coverage');
  validatePeriod(input.waiting_period_days, 'waiting_period_days');
  validatePeriod(input.grace_period_days, 'grace_period_days');
  if (input.description != null) {
    if (typeof input.description !== 'string' || input.description.length > 500) {
      throw new PolicyMasterError(
        'invalid_description_or_notes',
        'description ≤ 500 chars',
      );
    }
  }
  if (input.notes != null) {
    if (typeof input.notes !== 'string' || input.notes.length > 1000) {
      throw new PolicyMasterError(
        'invalid_description_or_notes',
        'notes ≤ 1000 chars',
      );
    }
  }
}

function validateUpdate(patch: PolicyMasterUpdateInput, base: PolicyMasterEntry): void {
  if (!patch || typeof patch !== 'object') {
    throw new PolicyMasterError('invalid_input', 'patch must be an object');
  }
  if (patch.display_name !== undefined) {
    if (
      typeof patch.display_name !== 'string' ||
      patch.display_name.trim().length === 0 ||
      patch.display_name.length > 200
    ) {
      throw new PolicyMasterError('invalid_name', 'display_name 1..200 chars');
    }
  }
  if (patch.category !== undefined && !isPolicyCategory(patch.category)) {
    throw new PolicyMasterError('invalid_category', 'category invalid');
  }
  if (patch.premium_frequency !== undefined && !isPremiumFrequency(patch.premium_frequency)) {
    throw new PolicyMasterError('invalid_premium_frequency', 'premium_frequency invalid');
  }
  if (patch.renewal_type !== undefined && !isRenewalType(patch.renewal_type)) {
    throw new PolicyMasterError('invalid_renewal_type', 'renewal_type invalid');
  }
  // Premium / coverage validated with merged-effective semantics so a
  // single-side patch can't accidentally invert the range.
  const effMinP = patch.min_premium !== undefined ? patch.min_premium : base.min_premium;
  const effMaxP = patch.max_premium !== undefined ? patch.max_premium : base.max_premium;
  if (patch.min_premium !== undefined || patch.max_premium !== undefined) {
    validateRange(effMinP, effMaxP, 'invalid_premium_range', 'premium');
  }
  const effMinC = patch.min_coverage !== undefined ? patch.min_coverage : base.min_coverage;
  const effMaxC = patch.max_coverage !== undefined ? patch.max_coverage : base.max_coverage;
  if (patch.min_coverage !== undefined || patch.max_coverage !== undefined) {
    validateRange(effMinC, effMaxC, 'invalid_coverage_range', 'coverage');
  }
  validatePeriod(patch.waiting_period_days, 'waiting_period_days');
  validatePeriod(patch.grace_period_days, 'grace_period_days');
  if (patch.description !== undefined && patch.description !== null) {
    if (typeof patch.description !== 'string' || patch.description.length > 500) {
      throw new PolicyMasterError('invalid_description_or_notes', 'description ≤ 500 chars');
    }
  }
  if (patch.notes !== undefined && patch.notes !== null) {
    if (typeof patch.notes !== 'string' || patch.notes.length > 1000) {
      throw new PolicyMasterError('invalid_description_or_notes', 'notes ≤ 1000 chars');
    }
  }
}

export interface PolicyMasterStore {
  list(
    tenant_id: string,
    opts?: { include_deleted?: boolean; category?: PolicyCategory; active?: boolean },
  ): PolicyMasterEntry[];
  get(tenant_id: string, policy_type_id: string): PolicyMasterEntry | null;
  create(
    tenant_id: string,
    input: PolicyMasterCreateInput,
    actor: string,
    now: Date,
  ): PolicyMasterEntry;
  update(
    tenant_id: string,
    policy_type_id: string,
    patch: PolicyMasterUpdateInput,
    actor: string,
    now: Date,
  ): PolicyMasterEntry;
  softDelete(
    tenant_id: string,
    policy_type_id: string,
    actor: string,
    now: Date,
  ): PolicyMasterEntry;
  restore(payload: PolicyMasterEntry): boolean;
}

export class InMemoryPolicyMasterStore implements PolicyMasterStore {
  private byTenant = new Map<string, Map<string, PolicyMasterEntry>>();

  private bucket(tenant_id: string): Map<string, PolicyMasterEntry> {
    let b = this.byTenant.get(tenant_id);
    if (!b) {
      b = new Map();
      this.byTenant.set(tenant_id, b);
    }
    return b;
  }

  list(
    tenant_id: string,
    opts: { include_deleted?: boolean; category?: PolicyCategory; active?: boolean } = {},
  ): PolicyMasterEntry[] {
    const b = this.byTenant.get(tenant_id);
    if (!b) return [];
    const out: PolicyMasterEntry[] = [];
    for (const e of b.values()) {
      if (!opts.include_deleted && e.deleted_at) continue;
      if (opts.category && e.category !== opts.category) continue;
      if (opts.active !== undefined && e.active !== opts.active) continue;
      out.push({ ...e });
    }
    // Sort: canonical category order → display_name asc.
    const catOrder = new Map(ALL_POLICY_CATEGORIES.map((c, i) => [c, i]));
    out.sort((a, b) => {
      const c = (catOrder.get(a.category) ?? 0) - (catOrder.get(b.category) ?? 0);
      if (c !== 0) return c;
      const n = a.display_name.localeCompare(b.display_name);
      return n !== 0 ? n : a.policy_type_id.localeCompare(b.policy_type_id);
    });
    return out;
  }

  get(tenant_id: string, policy_type_id: string): PolicyMasterEntry | null {
    const e = this.byTenant.get(tenant_id)?.get(policy_type_id);
    if (!e || e.deleted_at) return null;
    return { ...e };
  }

  create(
    tenant_id: string,
    input: PolicyMasterCreateInput,
    actor: string,
    now: Date,
  ): PolicyMasterEntry {
    validateCreate(input);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new PolicyMasterError('invalid_input', 'actor (created_by) required');
    }
    const b = this.bucket(tenant_id);
    const existing = b.get(input.policy_type_id);
    if (existing && !existing.deleted_at) {
      throw new PolicyMasterError(
        'duplicate_policy_type_id',
        `policy_type_id ${input.policy_type_id} already exists`,
        { policy_type_id: input.policy_type_id },
      );
    }
    const live = [...b.values()].filter((e) => !e.deleted_at).length;
    if (live >= POLICY_MASTER_CAP_PER_TENANT) {
      throw new PolicyMasterError(
        'cap_reached',
        `policy master cap (${POLICY_MASTER_CAP_PER_TENANT}) reached`,
      );
    }
    const ts = now.toISOString();
    const entry: PolicyMasterEntry = {
      policy_type_id: input.policy_type_id,
      tenant_id,
      display_name: input.display_name.trim(),
      category: input.category,
      premium_frequency: input.premium_frequency ?? 'yearly',
      min_premium: input.min_premium,
      max_premium: input.max_premium,
      min_coverage: input.min_coverage,
      max_coverage: input.max_coverage,
      waiting_period_days: input.waiting_period_days ?? 0,
      grace_period_days: input.grace_period_days ?? 30,
      renewal_type: input.renewal_type ?? 'manual',
      active: input.active !== undefined ? !!input.active : true,
      description: input.description != null ? input.description.trim() || null : null,
      notes: input.notes != null ? input.notes.trim() || null : null,
      created_at: ts,
      created_by: actor,
      updated_at: ts,
      updated_by: actor,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(entry.policy_type_id, entry);
    return { ...entry };
  }

  update(
    tenant_id: string,
    policy_type_id: string,
    patch: PolicyMasterUpdateInput,
    actor: string,
    now: Date,
  ): PolicyMasterEntry {
    const b = this.bucket(tenant_id);
    const e = b.get(policy_type_id);
    if (!e || e.deleted_at) {
      throw new PolicyMasterError(
        'unknown_policy_type',
        `policy_type_id ${policy_type_id} not found`,
        { policy_type_id },
      );
    }
    validateUpdate(patch, e);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new PolicyMasterError('invalid_input', 'actor required');
    }
    const next: PolicyMasterEntry = { ...e };
    if (patch.display_name !== undefined) next.display_name = patch.display_name.trim();
    if (patch.category !== undefined) next.category = patch.category;
    if (patch.premium_frequency !== undefined) next.premium_frequency = patch.premium_frequency;
    if (patch.min_premium !== undefined) next.min_premium = patch.min_premium;
    if (patch.max_premium !== undefined) next.max_premium = patch.max_premium;
    if (patch.min_coverage !== undefined) next.min_coverage = patch.min_coverage;
    if (patch.max_coverage !== undefined) next.max_coverage = patch.max_coverage;
    if (patch.waiting_period_days !== undefined) next.waiting_period_days = patch.waiting_period_days;
    if (patch.grace_period_days !== undefined) next.grace_period_days = patch.grace_period_days;
    if (patch.renewal_type !== undefined) next.renewal_type = patch.renewal_type;
    if (patch.active !== undefined) next.active = !!patch.active;
    if (patch.description !== undefined) {
      next.description = patch.description === null ? null : patch.description.trim() || null;
    }
    if (patch.notes !== undefined) {
      next.notes = patch.notes === null ? null : patch.notes.trim() || null;
    }
    next.updated_at = now.toISOString();
    next.updated_by = actor;
    b.set(policy_type_id, next);
    return { ...next };
  }

  softDelete(
    tenant_id: string,
    policy_type_id: string,
    actor: string,
    now: Date,
  ): PolicyMasterEntry {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new PolicyMasterError('invalid_input', 'actor required');
    }
    const b = this.bucket(tenant_id);
    const e = b.get(policy_type_id);
    if (!e || e.deleted_at) {
      throw new PolicyMasterError(
        'unknown_policy_type',
        `policy_type_id ${policy_type_id} not found`,
        { policy_type_id },
      );
    }
    const ts = now.toISOString();
    const tombstoned: PolicyMasterEntry = {
      ...e,
      deleted_at: ts,
      deleted_by: actor,
      updated_at: ts,
      updated_by: actor,
    };
    b.set(policy_type_id, tombstoned);
    return { ...tombstoned };
  }

  restore(payload: PolicyMasterEntry): boolean {
    if (!payload || typeof payload !== 'object') return false;
    if (typeof payload.policy_type_id !== 'string' || typeof payload.tenant_id !== 'string') {
      return false;
    }
    const b = this.bucket(payload.tenant_id);
    const existing = b.get(payload.policy_type_id);
    if (existing && !existing.deleted_at) return false;
    b.set(payload.policy_type_id, { ...payload, deleted_at: null, deleted_by: null });
    return true;
  }
}

export const defaultPolicyMasterStore: PolicyMasterStore = new InMemoryPolicyMasterStore();
