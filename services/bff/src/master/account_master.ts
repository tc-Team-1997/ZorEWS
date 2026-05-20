// services/bff/src/master/account_master.ts
//
// PHASE B.3 — Account & Exposure Master Setup (PDF §4 Master Setup item 2).
//
// Tenant-scoped catalog of account_types + loan_types + their default
// credit limits + exposure caps. Drives the SPA "create new account"
// picker + supplies M11.6 Customer 360 with default exposure
// thresholds that ops admins can tune per-product-line.
//
// Distinct from mart.loan_360 (which is per-account live data); this
// is the TYPE CATALOG (e.g. "personal_loan", "term_deposit",
// "credit_card") that tenants configure once and seldom change.

/** Closed enum — top-level account category. */
export const ALL_ACCOUNT_CATEGORIES = ['deposit', 'loan', 'credit_card', 'overdraft'] as const;
export type AccountCategory = (typeof ALL_ACCOUNT_CATEGORIES)[number];

export function isAccountCategory(v: unknown): v is AccountCategory {
  return typeof v === 'string' && (ALL_ACCOUNT_CATEGORIES as readonly string[]).includes(v);
}

/** Interest/repayment cadence. */
export const ALL_REPAYMENT_FREQUENCIES = ['monthly', 'quarterly', 'half_yearly', 'yearly', 'bullet', 'none'] as const;
export type RepaymentFrequency = (typeof ALL_REPAYMENT_FREQUENCIES)[number];

export function isRepaymentFrequency(v: unknown): v is RepaymentFrequency {
  return typeof v === 'string' && (ALL_REPAYMENT_FREQUENCIES as readonly string[]).includes(v);
}

export interface AccountMasterEntry {
  account_type_id: string;
  tenant_id: string;
  display_name: string;
  category: AccountCategory;
  /** Optional product subtype string (e.g. "personal_loan",
   *  "vehicle_loan", "home_loan" under category=loan). */
  product_subtype: string | null;
  default_credit_limit: number | null;   // currency units; null = no default
  max_exposure_cap: number | null;        // ops-tunable absolute cap
  repayment_frequency: RepaymentFrequency;
  interest_rate_pct: number | null;       // expected APR
  active: boolean;
  notes: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface AccountMasterCreateInput {
  account_type_id: string;
  display_name: string;
  category: AccountCategory;
  product_subtype?: string | null;
  default_credit_limit?: number | null;
  max_exposure_cap?: number | null;
  repayment_frequency?: RepaymentFrequency;
  interest_rate_pct?: number | null;
  active?: boolean;
  notes?: string | null;
}

export interface AccountMasterUpdateInput {
  display_name?: string;
  category?: AccountCategory;
  product_subtype?: string | null;
  default_credit_limit?: number | null;
  max_exposure_cap?: number | null;
  repayment_frequency?: RepaymentFrequency;
  interest_rate_pct?: number | null;
  active?: boolean;
  notes?: string | null;
}

export class AccountMasterError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_account_type_id'
      | 'invalid_name'
      | 'invalid_category'
      | 'invalid_frequency'
      | 'invalid_amount'
      | 'invalid_rate'
      | 'invalid_subtype'
      | 'invalid_notes'
      | 'unknown_account_type'
      | 'duplicate_account_type_id'
      | 'cap_reached',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'AccountMasterError';
  }
}

export const ACCOUNT_MASTER_CAP_PER_TENANT = 200;

const ACCOUNT_ID_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

function validateAmount(v: unknown, label: string): void {
  if (v === undefined || v === null) return;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new AccountMasterError('invalid_amount', `${label} must be a non-negative finite number`);
  }
}

function validateRate(v: unknown): void {
  if (v === undefined || v === null) return;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
    throw new AccountMasterError(
      'invalid_rate',
      'interest_rate_pct must be a finite number in [0, 100]',
    );
  }
}

function validateCreate(input: AccountMasterCreateInput): void {
  if (!input || typeof input !== 'object') {
    throw new AccountMasterError('invalid_input', 'request body must be an object');
  }
  if (typeof input.account_type_id !== 'string' || !ACCOUNT_ID_RE.test(input.account_type_id)) {
    throw new AccountMasterError(
      'invalid_account_type_id',
      'account_type_id must match ^[A-Z][A-Z0-9_]{2,63}$',
    );
  }
  if (
    typeof input.display_name !== 'string' ||
    input.display_name.trim().length === 0 ||
    input.display_name.length > 200
  ) {
    throw new AccountMasterError('invalid_name', 'display_name must be 1..200 chars');
  }
  if (!isAccountCategory(input.category)) {
    throw new AccountMasterError(
      'invalid_category',
      `category must be one of: ${ALL_ACCOUNT_CATEGORIES.join(', ')}`,
    );
  }
  if (input.repayment_frequency !== undefined && !isRepaymentFrequency(input.repayment_frequency)) {
    throw new AccountMasterError('invalid_frequency', 'repayment_frequency invalid');
  }
  if (input.product_subtype != null) {
    if (typeof input.product_subtype !== 'string' || input.product_subtype.length > 80) {
      throw new AccountMasterError('invalid_subtype', 'product_subtype ≤ 80 chars');
    }
  }
  validateAmount(input.default_credit_limit, 'default_credit_limit');
  validateAmount(input.max_exposure_cap, 'max_exposure_cap');
  // Sanity: when both set, cap must be ≥ credit_limit.
  if (
    typeof input.default_credit_limit === 'number' &&
    typeof input.max_exposure_cap === 'number' &&
    input.max_exposure_cap < input.default_credit_limit
  ) {
    throw new AccountMasterError(
      'invalid_amount',
      'max_exposure_cap must be ≥ default_credit_limit',
    );
  }
  validateRate(input.interest_rate_pct);
  if (input.notes != null) {
    if (typeof input.notes !== 'string' || input.notes.length > 1000) {
      throw new AccountMasterError('invalid_notes', 'notes ≤ 1000 chars');
    }
  }
}

function validateUpdate(patch: AccountMasterUpdateInput, base: AccountMasterEntry): void {
  if (!patch || typeof patch !== 'object') {
    throw new AccountMasterError('invalid_input', 'patch must be an object');
  }
  if (patch.display_name !== undefined) {
    if (
      typeof patch.display_name !== 'string' ||
      patch.display_name.trim().length === 0 ||
      patch.display_name.length > 200
    ) {
      throw new AccountMasterError('invalid_name', 'display_name 1..200 chars');
    }
  }
  if (patch.category !== undefined && !isAccountCategory(patch.category)) {
    throw new AccountMasterError('invalid_category', 'category invalid');
  }
  if (patch.repayment_frequency !== undefined && !isRepaymentFrequency(patch.repayment_frequency)) {
    throw new AccountMasterError('invalid_frequency', 'repayment_frequency invalid');
  }
  if (patch.product_subtype !== undefined && patch.product_subtype !== null) {
    if (typeof patch.product_subtype !== 'string' || patch.product_subtype.length > 80) {
      throw new AccountMasterError('invalid_subtype', 'product_subtype ≤ 80 chars');
    }
  }
  validateAmount(patch.default_credit_limit, 'default_credit_limit');
  validateAmount(patch.max_exposure_cap, 'max_exposure_cap');
  const effectiveCredit =
    patch.default_credit_limit !== undefined ? patch.default_credit_limit : base.default_credit_limit;
  const effectiveCap =
    patch.max_exposure_cap !== undefined ? patch.max_exposure_cap : base.max_exposure_cap;
  if (
    typeof effectiveCredit === 'number' &&
    typeof effectiveCap === 'number' &&
    effectiveCap < effectiveCredit
  ) {
    throw new AccountMasterError(
      'invalid_amount',
      'max_exposure_cap must be ≥ default_credit_limit',
    );
  }
  validateRate(patch.interest_rate_pct);
  if (patch.notes !== undefined && patch.notes !== null) {
    if (typeof patch.notes !== 'string' || patch.notes.length > 1000) {
      throw new AccountMasterError('invalid_notes', 'notes ≤ 1000 chars');
    }
  }
}

export interface AccountMasterStore {
  list(
    tenant_id: string,
    opts?: { include_deleted?: boolean; category?: AccountCategory; active?: boolean },
  ): AccountMasterEntry[];
  get(tenant_id: string, account_type_id: string): AccountMasterEntry | null;
  create(
    tenant_id: string,
    input: AccountMasterCreateInput,
    actor: string,
    now: Date,
  ): AccountMasterEntry;
  update(
    tenant_id: string,
    account_type_id: string,
    patch: AccountMasterUpdateInput,
    actor: string,
    now: Date,
  ): AccountMasterEntry;
  softDelete(
    tenant_id: string,
    account_type_id: string,
    actor: string,
    now: Date,
  ): AccountMasterEntry;
  restore(payload: AccountMasterEntry): boolean;
}

export class InMemoryAccountMasterStore implements AccountMasterStore {
  private byTenant = new Map<string, Map<string, AccountMasterEntry>>();

  private bucket(tenant_id: string): Map<string, AccountMasterEntry> {
    let b = this.byTenant.get(tenant_id);
    if (!b) {
      b = new Map();
      this.byTenant.set(tenant_id, b);
    }
    return b;
  }

  list(
    tenant_id: string,
    opts: { include_deleted?: boolean; category?: AccountCategory; active?: boolean } = {},
  ): AccountMasterEntry[] {
    const b = this.byTenant.get(tenant_id);
    if (!b) return [];
    const out: AccountMasterEntry[] = [];
    for (const e of b.values()) {
      if (!opts.include_deleted && e.deleted_at) continue;
      if (opts.category && e.category !== opts.category) continue;
      if (opts.active !== undefined && e.active !== opts.active) continue;
      out.push({ ...e });
    }
    // Sort: category (canonical order) → display_name asc.
    const catOrder = new Map(ALL_ACCOUNT_CATEGORIES.map((c, i) => [c, i]));
    out.sort((a, b) => {
      const c = (catOrder.get(a.category) ?? 0) - (catOrder.get(b.category) ?? 0);
      if (c !== 0) return c;
      const n = a.display_name.localeCompare(b.display_name);
      return n !== 0 ? n : a.account_type_id.localeCompare(b.account_type_id);
    });
    return out;
  }

  get(tenant_id: string, account_type_id: string): AccountMasterEntry | null {
    const e = this.byTenant.get(tenant_id)?.get(account_type_id);
    if (!e || e.deleted_at) return null;
    return { ...e };
  }

  create(
    tenant_id: string,
    input: AccountMasterCreateInput,
    actor: string,
    now: Date,
  ): AccountMasterEntry {
    validateCreate(input);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new AccountMasterError('invalid_input', 'actor (created_by) required');
    }
    const b = this.bucket(tenant_id);
    const existing = b.get(input.account_type_id);
    if (existing && !existing.deleted_at) {
      throw new AccountMasterError(
        'duplicate_account_type_id',
        `account_type_id ${input.account_type_id} already exists`,
        { account_type_id: input.account_type_id },
      );
    }
    const live = [...b.values()].filter((e) => !e.deleted_at).length;
    if (live >= ACCOUNT_MASTER_CAP_PER_TENANT) {
      throw new AccountMasterError(
        'cap_reached',
        `account master cap (${ACCOUNT_MASTER_CAP_PER_TENANT}) reached`,
      );
    }
    const ts = now.toISOString();
    const entry: AccountMasterEntry = {
      account_type_id: input.account_type_id,
      tenant_id,
      display_name: input.display_name.trim(),
      category: input.category,
      product_subtype:
        input.product_subtype != null ? input.product_subtype.trim() || null : null,
      default_credit_limit: input.default_credit_limit ?? null,
      max_exposure_cap: input.max_exposure_cap ?? null,
      repayment_frequency: input.repayment_frequency ?? 'monthly',
      interest_rate_pct: input.interest_rate_pct ?? null,
      active: input.active !== undefined ? !!input.active : true,
      notes: input.notes != null ? input.notes.trim() || null : null,
      created_at: ts,
      created_by: actor,
      updated_at: ts,
      updated_by: actor,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(entry.account_type_id, entry);
    return { ...entry };
  }

  update(
    tenant_id: string,
    account_type_id: string,
    patch: AccountMasterUpdateInput,
    actor: string,
    now: Date,
  ): AccountMasterEntry {
    const b = this.bucket(tenant_id);
    const e = b.get(account_type_id);
    if (!e || e.deleted_at) {
      throw new AccountMasterError(
        'unknown_account_type',
        `account_type_id ${account_type_id} not found`,
        { account_type_id },
      );
    }
    validateUpdate(patch, e);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new AccountMasterError('invalid_input', 'actor required');
    }
    const next: AccountMasterEntry = { ...e };
    if (patch.display_name !== undefined) next.display_name = patch.display_name.trim();
    if (patch.category !== undefined) next.category = patch.category;
    if (patch.product_subtype !== undefined) {
      next.product_subtype =
        patch.product_subtype === null ? null : patch.product_subtype.trim() || null;
    }
    if (patch.default_credit_limit !== undefined) next.default_credit_limit = patch.default_credit_limit;
    if (patch.max_exposure_cap !== undefined) next.max_exposure_cap = patch.max_exposure_cap;
    if (patch.repayment_frequency !== undefined) next.repayment_frequency = patch.repayment_frequency;
    if (patch.interest_rate_pct !== undefined) next.interest_rate_pct = patch.interest_rate_pct;
    if (patch.active !== undefined) next.active = !!patch.active;
    if (patch.notes !== undefined) {
      next.notes = patch.notes === null ? null : patch.notes.trim() || null;
    }
    next.updated_at = now.toISOString();
    next.updated_by = actor;
    b.set(account_type_id, next);
    return { ...next };
  }

  softDelete(
    tenant_id: string,
    account_type_id: string,
    actor: string,
    now: Date,
  ): AccountMasterEntry {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new AccountMasterError('invalid_input', 'actor required');
    }
    const b = this.bucket(tenant_id);
    const e = b.get(account_type_id);
    if (!e || e.deleted_at) {
      throw new AccountMasterError(
        'unknown_account_type',
        `account_type_id ${account_type_id} not found`,
        { account_type_id },
      );
    }
    const ts = now.toISOString();
    const tombstoned: AccountMasterEntry = {
      ...e,
      deleted_at: ts,
      deleted_by: actor,
      updated_at: ts,
      updated_by: actor,
    };
    b.set(account_type_id, tombstoned);
    return { ...tombstoned };
  }

  restore(payload: AccountMasterEntry): boolean {
    if (!payload || typeof payload !== 'object') return false;
    if (typeof payload.account_type_id !== 'string' || typeof payload.tenant_id !== 'string') {
      return false;
    }
    const b = this.bucket(payload.tenant_id);
    const existing = b.get(payload.account_type_id);
    if (existing && !existing.deleted_at) return false;
    b.set(payload.account_type_id, { ...payload, deleted_at: null, deleted_by: null });
    return true;
  }
}

export const defaultAccountMasterStore: AccountMasterStore = new InMemoryAccountMasterStore();
