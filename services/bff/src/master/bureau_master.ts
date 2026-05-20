// services/bff/src/master/bureau_master.ts
//
// PHASE B.2 — External Bureau Master (PDF §8 Master Setup item 6).
//
// Tenant-scoped per-bureau configuration: which bureaus are enabled,
// what weight each carries in the scoring overlay, what score range
// the bureau publishes (so the SPA can render correctly even when a
// tenant changes provider), default refresh cadence, and whether the
// bureau is currently in fallback mode.
//
// Distinct from M14.5 BureauAdapter (which is the READ-side that
// fetches actual bureau reports per-customer). This is the
// CONFIGURATION layer that supplies the weights M6.x scoring uses
// when an overlay is active.

/** Canonical bureau types — closed enum so the SPA picker shows the
 *  fixed set. Operators can enable/disable each per tenant; can't add
 *  new bureaus without a code change (avoids tenant-level free-text
 *  for what's a regulated provider list). */
export const ALL_BUREAU_TYPES = ['CIBIL', 'CRIF', 'EXPERIAN', 'EQUIFAX'] as const;
export type BureauType = (typeof ALL_BUREAU_TYPES)[number];

export function isBureauType(v: unknown): v is BureauType {
  return typeof v === 'string' && (ALL_BUREAU_TYPES as readonly string[]).includes(v);
}

/** Refresh cadence options — closed enum aligned with the rest of the
 *  scheduler subsystem (M12.2). */
export const ALL_BUREAU_REFRESH_CADENCES = ['hourly', 'daily', 'weekly', 'monthly', 'on_demand'] as const;
export type BureauRefreshCadence = (typeof ALL_BUREAU_REFRESH_CADENCES)[number];

export function isBureauRefreshCadence(v: unknown): v is BureauRefreshCadence {
  return typeof v === 'string' && (ALL_BUREAU_REFRESH_CADENCES as readonly string[]).includes(v);
}

export interface BureauMasterEntry {
  bureau_id: BureauType;
  tenant_id: string;
  enabled: boolean;
  /** Weight (0..1) in scoring overlay. 0 = not factored. */
  score_weight: number;
  /** Min/max possible score from this bureau. 300-900 default (CIBIL
   *  standard) but config-driven since bureaus differ. */
  score_range_min: number;
  score_range_max: number;
  /** Optional contract reference / SLA metadata for ops bookkeeping. */
  contract_ref: string | null;
  refresh_cadence: BureauRefreshCadence;
  /** Fallback mode — when true, scoring uses the previous successful
   *  pull instead of erroring on bureau-unavailable. */
  fallback_mode: boolean;
  notes: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface BureauMasterCreateInput {
  bureau_id: BureauType;
  enabled?: boolean;
  score_weight: number;
  score_range_min?: number;
  score_range_max?: number;
  contract_ref?: string | null;
  refresh_cadence?: BureauRefreshCadence;
  fallback_mode?: boolean;
  notes?: string | null;
}

export interface BureauMasterUpdateInput {
  enabled?: boolean;
  score_weight?: number;
  score_range_min?: number;
  score_range_max?: number;
  contract_ref?: string | null;
  refresh_cadence?: BureauRefreshCadence;
  fallback_mode?: boolean;
  notes?: string | null;
}

export class BureauMasterError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_bureau_id'
      | 'invalid_weight'
      | 'invalid_score_range'
      | 'invalid_cadence'
      | 'invalid_contract_ref'
      | 'invalid_notes'
      | 'unknown_bureau'
      | 'duplicate_bureau'
      | 'weight_sum_exceeds_one',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'BureauMasterError';
  }
}

function validateCreate(input: BureauMasterCreateInput): void {
  if (!input || typeof input !== 'object') {
    throw new BureauMasterError('invalid_input', 'request body must be an object');
  }
  if (!isBureauType(input.bureau_id)) {
    throw new BureauMasterError(
      'invalid_bureau_id',
      `bureau_id must be one of: ${ALL_BUREAU_TYPES.join(', ')}`,
    );
  }
  validateWeight(input.score_weight);
  if (input.score_range_min !== undefined || input.score_range_max !== undefined) {
    const lo = input.score_range_min ?? 300;
    const hi = input.score_range_max ?? 900;
    validateRange(lo, hi);
  }
  if (input.refresh_cadence !== undefined && !isBureauRefreshCadence(input.refresh_cadence)) {
    throw new BureauMasterError('invalid_cadence', 'refresh_cadence invalid');
  }
  if (input.contract_ref != null) {
    if (typeof input.contract_ref !== 'string' || input.contract_ref.length > 200) {
      throw new BureauMasterError('invalid_contract_ref', 'contract_ref ≤ 200 chars (or null)');
    }
  }
  if (input.notes != null) {
    if (typeof input.notes !== 'string' || input.notes.length > 1000) {
      throw new BureauMasterError('invalid_notes', 'notes ≤ 1000 chars (or null)');
    }
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new BureauMasterError('invalid_input', 'enabled must be boolean');
  }
  if (input.fallback_mode !== undefined && typeof input.fallback_mode !== 'boolean') {
    throw new BureauMasterError('invalid_input', 'fallback_mode must be boolean');
  }
}

function validateWeight(w: unknown): void {
  if (typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > 1) {
    throw new BureauMasterError(
      'invalid_weight',
      'score_weight must be a finite number in [0, 1]',
    );
  }
}

function validateRange(lo: number, hi: number): void {
  if (
    typeof lo !== 'number' ||
    typeof hi !== 'number' ||
    !Number.isFinite(lo) ||
    !Number.isFinite(hi)
  ) {
    throw new BureauMasterError('invalid_score_range', 'score_range_min/max must be finite');
  }
  if (lo < 0 || hi <= lo) {
    throw new BureauMasterError(
      'invalid_score_range',
      'score_range_min must be ≥ 0 and score_range_max must be > score_range_min',
    );
  }
}

function validateUpdate(patch: BureauMasterUpdateInput, base: BureauMasterEntry): void {
  if (!patch || typeof patch !== 'object') {
    throw new BureauMasterError('invalid_input', 'patch must be an object');
  }
  if (patch.score_weight !== undefined) validateWeight(patch.score_weight);
  if (patch.score_range_min !== undefined || patch.score_range_max !== undefined) {
    const lo = patch.score_range_min ?? base.score_range_min;
    const hi = patch.score_range_max ?? base.score_range_max;
    validateRange(lo, hi);
  }
  if (patch.refresh_cadence !== undefined && !isBureauRefreshCadence(patch.refresh_cadence)) {
    throw new BureauMasterError('invalid_cadence', 'refresh_cadence invalid');
  }
  if (patch.contract_ref !== undefined && patch.contract_ref !== null) {
    if (typeof patch.contract_ref !== 'string' || patch.contract_ref.length > 200) {
      throw new BureauMasterError('invalid_contract_ref', 'contract_ref ≤ 200 chars (or null)');
    }
  }
  if (patch.notes !== undefined && patch.notes !== null) {
    if (typeof patch.notes !== 'string' || patch.notes.length > 1000) {
      throw new BureauMasterError('invalid_notes', 'notes ≤ 1000 chars (or null)');
    }
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    throw new BureauMasterError('invalid_input', 'enabled must be boolean');
  }
  if (patch.fallback_mode !== undefined && typeof patch.fallback_mode !== 'boolean') {
    throw new BureauMasterError('invalid_input', 'fallback_mode must be boolean');
  }
}

export interface BureauMasterStore {
  list(
    tenant_id: string,
    opts?: { include_deleted?: boolean; enabled?: boolean },
  ): BureauMasterEntry[];
  get(tenant_id: string, bureau_id: BureauType): BureauMasterEntry | null;
  create(
    tenant_id: string,
    input: BureauMasterCreateInput,
    actor: string,
    now: Date,
  ): BureauMasterEntry;
  update(
    tenant_id: string,
    bureau_id: BureauType,
    patch: BureauMasterUpdateInput,
    actor: string,
    now: Date,
  ): BureauMasterEntry;
  softDelete(
    tenant_id: string,
    bureau_id: BureauType,
    actor: string,
    now: Date,
  ): BureauMasterEntry;
  restore(payload: BureauMasterEntry): boolean;
}

export class InMemoryBureauMasterStore implements BureauMasterStore {
  // (tenant, bureau_id) is the natural key — at most 4 bureaus per
  // tenant. So a simple flat Map by composite key is fine.
  private byTenant = new Map<string, Map<BureauType, BureauMasterEntry>>();

  private bucket(tenant_id: string): Map<BureauType, BureauMasterEntry> {
    let b = this.byTenant.get(tenant_id);
    if (!b) {
      b = new Map();
      this.byTenant.set(tenant_id, b);
    }
    return b;
  }

  list(
    tenant_id: string,
    opts: { include_deleted?: boolean; enabled?: boolean } = {},
  ): BureauMasterEntry[] {
    const b = this.byTenant.get(tenant_id);
    if (!b) return [];
    const out: BureauMasterEntry[] = [];
    for (const e of b.values()) {
      if (!opts.include_deleted && e.deleted_at) continue;
      if (opts.enabled !== undefined && e.enabled !== opts.enabled) continue;
      out.push({ ...e });
    }
    // Canonical bureau order matches ALL_BUREAU_TYPES enumeration so
    // the SPA renders them in the same sequence regardless of insertion.
    const order = new Map(ALL_BUREAU_TYPES.map((t, i) => [t, i]));
    out.sort((a, b) => (order.get(a.bureau_id) ?? 0) - (order.get(b.bureau_id) ?? 0));
    return out;
  }

  get(tenant_id: string, bureau_id: BureauType): BureauMasterEntry | null {
    const e = this.byTenant.get(tenant_id)?.get(bureau_id);
    if (!e || e.deleted_at) return null;
    return { ...e };
  }

  create(
    tenant_id: string,
    input: BureauMasterCreateInput,
    actor: string,
    now: Date,
  ): BureauMasterEntry {
    validateCreate(input);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new BureauMasterError('invalid_input', 'actor (created_by) required');
    }
    const b = this.bucket(tenant_id);
    const existing = b.get(input.bureau_id);
    if (existing && !existing.deleted_at) {
      throw new BureauMasterError(
        'duplicate_bureau',
        `bureau ${input.bureau_id} already configured for tenant ${tenant_id}`,
        { bureau_id: input.bureau_id },
      );
    }
    const ts = now.toISOString();
    const entry: BureauMasterEntry = {
      bureau_id: input.bureau_id,
      tenant_id,
      enabled: input.enabled !== undefined ? !!input.enabled : true,
      score_weight: input.score_weight,
      score_range_min: input.score_range_min ?? 300,
      score_range_max: input.score_range_max ?? 900,
      contract_ref: input.contract_ref != null ? input.contract_ref.trim() || null : null,
      refresh_cadence: input.refresh_cadence ?? 'daily',
      fallback_mode: input.fallback_mode === true,
      notes: input.notes != null ? input.notes.trim() || null : null,
      created_at: ts,
      created_by: actor,
      updated_at: ts,
      updated_by: actor,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(entry.bureau_id, entry);
    return { ...entry };
  }

  update(
    tenant_id: string,
    bureau_id: BureauType,
    patch: BureauMasterUpdateInput,
    actor: string,
    now: Date,
  ): BureauMasterEntry {
    const b = this.bucket(tenant_id);
    const e = b.get(bureau_id);
    if (!e || e.deleted_at) {
      throw new BureauMasterError(
        'unknown_bureau',
        `bureau ${bureau_id} not configured for tenant ${tenant_id}`,
        { bureau_id },
      );
    }
    validateUpdate(patch, e);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new BureauMasterError('invalid_input', 'actor (updated_by) required');
    }
    const next: BureauMasterEntry = { ...e };
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    if (patch.score_weight !== undefined) next.score_weight = patch.score_weight;
    if (patch.score_range_min !== undefined) next.score_range_min = patch.score_range_min;
    if (patch.score_range_max !== undefined) next.score_range_max = patch.score_range_max;
    if (patch.contract_ref !== undefined) {
      next.contract_ref = patch.contract_ref === null ? null : patch.contract_ref.trim() || null;
    }
    if (patch.refresh_cadence !== undefined) next.refresh_cadence = patch.refresh_cadence;
    if (patch.fallback_mode !== undefined) next.fallback_mode = !!patch.fallback_mode;
    if (patch.notes !== undefined) {
      next.notes = patch.notes === null ? null : patch.notes.trim() || null;
    }
    next.updated_at = now.toISOString();
    next.updated_by = actor;
    b.set(bureau_id, next);
    return { ...next };
  }

  softDelete(
    tenant_id: string,
    bureau_id: BureauType,
    actor: string,
    now: Date,
  ): BureauMasterEntry {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new BureauMasterError('invalid_input', 'actor required');
    }
    const b = this.bucket(tenant_id);
    const e = b.get(bureau_id);
    if (!e || e.deleted_at) {
      throw new BureauMasterError(
        'unknown_bureau',
        `bureau ${bureau_id} not configured`,
        { bureau_id },
      );
    }
    const ts = now.toISOString();
    const tombstoned: BureauMasterEntry = {
      ...e,
      deleted_at: ts,
      deleted_by: actor,
      updated_at: ts,
      updated_by: actor,
    };
    b.set(bureau_id, tombstoned);
    return { ...tombstoned };
  }

  restore(payload: BureauMasterEntry): boolean {
    if (!payload || typeof payload !== 'object') return false;
    if (!isBureauType(payload.bureau_id) || typeof payload.tenant_id !== 'string') {
      return false;
    }
    const b = this.bucket(payload.tenant_id);
    const existing = b.get(payload.bureau_id);
    if (existing && !existing.deleted_at) return false;
    b.set(payload.bureau_id, { ...payload, deleted_at: null, deleted_by: null });
    return true;
  }
}

export const defaultBureauMasterStore: BureauMasterStore = new InMemoryBureauMasterStore();

// ─── Helper: compute the effective bureau weight overlay ──────────────

/** Pure helper. Returns the per-bureau weight map for use as an M6.x
 *  scoring overlay. Only ENABLED bureaus contribute. If the sum of
 *  enabled weights is 0, returns an empty map (consumer falls back to
 *  catalog defaults). Otherwise weights are normalised so they sum to
 *  1 — caller can choose to bypass normalisation by reading the raw
 *  entries directly. */
export function computeBureauWeightOverlay(
  store: BureauMasterStore,
  tenant_id: string,
): {
  enabled_bureaus: BureauType[];
  raw_weights: Record<BureauType, number>;
  normalised_weights: Record<BureauType, number>;
  total_raw_weight: number;
} {
  const enabled = store.list(tenant_id, { enabled: true });
  const raw: Record<BureauType, number> = {} as Record<BureauType, number>;
  let total = 0;
  for (const e of enabled) {
    raw[e.bureau_id] = e.score_weight;
    total += e.score_weight;
  }
  const normalised: Record<BureauType, number> = {} as Record<BureauType, number>;
  if (total > 0) {
    for (const [b, w] of Object.entries(raw) as Array<[BureauType, number]>) {
      normalised[b] = Number((w / total).toFixed(4));
    }
  }
  return {
    enabled_bureaus: enabled.map((e) => e.bureau_id),
    raw_weights: raw,
    normalised_weights: normalised,
    total_raw_weight: total,
  };
}
