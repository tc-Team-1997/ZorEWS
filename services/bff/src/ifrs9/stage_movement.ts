// services/bff/src/ifrs9/stage_movement.ts
//
// PHASE T3.2 — IFRS9 Stage Movement + ECL Inputs.
//
// Layered on top of the existing M14.2 Ifrs9Adapter (read-only stub
// that synthesises stage + PD/LGD/EAD/ECL per (tenant, customer, day)).
// Adds:
//
//   - Per-customer STAGE TRANSITION LEDGER — every Stage 1↔2↔3 change
//     with reason + the PD/LGD/EAD inputs at the time of transition.
//     Drives the SPA's stage-history timeline and the regulator-facing
//     IFRS9 audit trail.
//   - Per-tenant ECL INPUT OVERRIDE store — caller can set explicit
//     PD/LGD/EAD overrides per customer that WIN over the adapter's
//     synthesis. Useful when the IFRS9 engine returns wrong data and
//     ops needs to patch.
//   - ECL CALCULATOR — pure function (PD × LGD × EAD), so the SPA can
//     preview the calculation step-by-step without round-tripping the
//     adapter.
//   - PORTFOLIO ROLLUP — distribution by stage + concentration by
//     branch / sector if the caller threads tags.
//
// Architecture choices (per execution rules):
//   - Additive only — no changes to M14.2 Ifrs9Adapter or any other
//     runtime module.
//   - Pure-data + in-memory ledger; pg-backed swap is a future ticket
//     via the IStageMovementLedger interface.
//   - Closed enum of stages, drivers, and movement reasons.
//   - Audit fields + soft-delete + Recovery Center adapter.
//   - RBAC: customers:read_risk_profile (matches M14.2's scope).

/** Closed enum mirroring M14.2 Ifrs9Stage. Re-declared here to avoid
 *  cross-module import coupling — they MUST match the adapter's
 *  values. Future-safe: any new stage must be added to both. */
export const ALL_IFRS9_STAGES = [1, 2, 3] as const;
export type Ifrs9Stage = (typeof ALL_IFRS9_STAGES)[number];

export function isIfrs9Stage(v: unknown): v is Ifrs9Stage {
  return v === 1 || v === 2 || v === 3;
}

/** Closed enum of reasons for a stage movement, per BAC-A IFRS9 §B
 *  classification. */
export const ALL_STAGE_MOVEMENT_REASONS = [
  'dpd_30_breach',           // Stage 1→2: DPD crossed 30 days
  'dpd_90_breach',           // Stage 2→3: DPD crossed 90 days
  'restructure',             // Stage promotion after restructure
  'pd_lifetime_increased',   // PD-lifetime > origination threshold
  'watchlist_flagged',       // Operations watchlist promotion
  'cured',                   // Stage 3→2 / 2→1 after DPD cleared + SICR cooling
  'manual_override',         // Operator-driven stage change
  'data_quality_correction', // After CBS/IFRS9 engine data correction
] as const;
export type StageMovementReason = (typeof ALL_STAGE_MOVEMENT_REASONS)[number];

export function isStageMovementReason(v: unknown): v is StageMovementReason {
  return (
    typeof v === 'string' &&
    (ALL_STAGE_MOVEMENT_REASONS as readonly string[]).includes(v)
  );
}

/** ECL = PD × LGD × EAD. Per IFRS9 §5.5. */
export interface EclInputs {
  /** 12-month PD when stage=1; lifetime PD when stage=2/3.
   *  Range [0, 1]. Validated. */
  pd: number;
  /** Loss-given-default. Range (0, 1]. */
  lgd: number;
  /** Exposure-at-default in tenant's reporting currency.
   *  Validated as a finite non-negative integer (in minor units e.g.
   *  paise / cents — caller responsible for the unit scale). */
  ead: number;
}

export interface StageMovementEvent {
  movement_id: string;
  tenant_id: string;
  customer_id: string;
  /** Stage just before the move. null when this is the customer's
   *  first appearance on the ledger (i.e. opening entry). */
  from_stage: Ifrs9Stage | null;
  to_stage: Ifrs9Stage;
  reason: StageMovementReason;
  /** ECL inputs captured at the time of transition. */
  inputs: EclInputs;
  /** ECL value = pd × lgd × ead, rounded to nearest integer (minor units).
   *  Stored alongside inputs so future recomputations can be reconciled
   *  against the historical value. */
  ecl: number;
  /** Free-text rationale for the SPA tooltip + audit pack. */
  notes: string | null;
  /** ISO timestamp of the observed movement. May differ from
   *  created_at when the operator backdates a movement. */
  movement_at: string;
  /** Audit envelope. */
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface StageMovementCreateInput {
  movement_id?: string;
  customer_id: string;
  from_stage?: Ifrs9Stage | null;
  to_stage: Ifrs9Stage;
  reason: StageMovementReason;
  inputs: EclInputs;
  movement_at: string;
  notes?: string | null;
}

/** Per-tenant per-customer ECL override row. */
export interface EclOverride {
  override_id: string;
  tenant_id: string;
  customer_id: string;
  /** When set, this PD wins over the adapter's synthesis.
   *  Null = caller wants the adapter value to pass through. */
  pd_override: number | null;
  lgd_override: number | null;
  ead_override: number | null;
  /** Active flag — caller can toggle without deleting. */
  active: boolean;
  notes: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface EclOverrideCreateInput {
  override_id?: string;
  customer_id: string;
  pd_override?: number | null;
  lgd_override?: number | null;
  ead_override?: number | null;
  active?: boolean;
  notes?: string | null;
}

export interface EclOverrideUpdateInput {
  pd_override?: number | null;
  lgd_override?: number | null;
  ead_override?: number | null;
  active?: boolean;
  notes?: string | null;
}

export class Ifrs9StageError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_id'
      | 'invalid_customer_id'
      | 'invalid_stage'
      | 'invalid_reason'
      | 'invalid_inputs'
      | 'invalid_movement_at'
      | 'invalid_notes'
      | 'invalid_transition'
      | 'unknown_movement'
      | 'unknown_override'
      | 'duplicate_movement_id'
      | 'duplicate_override'
      | 'cap_reached',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'Ifrs9StageError';
  }
}

export const IFRS9_MOVEMENT_CAP_PER_TENANT = 50_000;
export const IFRS9_OVERRIDE_CAP_PER_TENANT = 5_000;

const ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const CUSTOMER_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{1,63}$/;
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** Pure ECL calculator. Out-of-range inputs throw — caller is expected
 *  to validate first via validateEclInputs. */
export function computeEcl(inputs: EclInputs): number {
  validateEclInputs(inputs);
  return Math.round(inputs.pd * inputs.lgd * inputs.ead);
}

/** Validate ECL input shape. Exported for routes + previewer reuse. */
export function validateEclInputs(inputs: unknown): asserts inputs is EclInputs {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new Ifrs9StageError('invalid_inputs', 'inputs must be an object');
  }
  const rec = inputs as Record<string, unknown>;
  if (typeof rec.pd !== 'number' || !Number.isFinite(rec.pd) || rec.pd < 0 || rec.pd > 1) {
    throw new Ifrs9StageError('invalid_inputs', 'pd must be a finite number in [0, 1]');
  }
  if (typeof rec.lgd !== 'number' || !Number.isFinite(rec.lgd) || rec.lgd <= 0 || rec.lgd > 1) {
    throw new Ifrs9StageError('invalid_inputs', 'lgd must be a finite number in (0, 1]');
  }
  if (
    typeof rec.ead !== 'number' ||
    !Number.isFinite(rec.ead) ||
    rec.ead < 0 ||
    !Number.isInteger(rec.ead)
  ) {
    throw new Ifrs9StageError(
      'invalid_inputs',
      'ead must be a non-negative integer (minor units)',
    );
  }
}

/** Resolve effective ECL inputs by applying override on top of base.
 *  Pure function — exposed for the SPA's "what does my override
 *  produce?" preview tile. */
export function applyEclOverride(
  base: EclInputs,
  override: Pick<EclOverride, 'pd_override' | 'lgd_override' | 'ead_override' | 'active'> | null,
): EclInputs {
  if (!override || !override.active) return { ...base };
  return {
    pd: override.pd_override !== null ? override.pd_override : base.pd,
    lgd: override.lgd_override !== null ? override.lgd_override : base.lgd,
    ead: override.ead_override !== null ? override.ead_override : base.ead,
  };
}

function validateMovementCreate(input: StageMovementCreateInput): void {
  if (!input || typeof input !== 'object') {
    throw new Ifrs9StageError('invalid_input', 'request body must be an object');
  }
  if (input.movement_id !== undefined && (typeof input.movement_id !== 'string' || !ID_RE.test(input.movement_id))) {
    throw new Ifrs9StageError(
      'invalid_id',
      'movement_id must match ^[a-z][a-z0-9_-]{1,63}$',
    );
  }
  if (typeof input.customer_id !== 'string' || !CUSTOMER_ID_RE.test(input.customer_id)) {
    throw new Ifrs9StageError(
      'invalid_customer_id',
      'customer_id must match ^[a-zA-Z][a-zA-Z0-9_-]{1,63}$',
    );
  }
  if (!isIfrs9Stage(input.to_stage)) {
    throw new Ifrs9StageError(
      'invalid_stage',
      'to_stage must be 1, 2, or 3',
    );
  }
  if (input.from_stage !== undefined && input.from_stage !== null) {
    if (!isIfrs9Stage(input.from_stage)) {
      throw new Ifrs9StageError(
        'invalid_stage',
        'from_stage must be 1, 2, 3, or null',
      );
    }
    if (input.from_stage === input.to_stage) {
      throw new Ifrs9StageError(
        'invalid_transition',
        'from_stage and to_stage cannot be equal (no-op move)',
      );
    }
  }
  if (!isStageMovementReason(input.reason)) {
    throw new Ifrs9StageError(
      'invalid_reason',
      `reason must be one of: ${ALL_STAGE_MOVEMENT_REASONS.join(', ')}`,
    );
  }
  validateEclInputs(input.inputs);
  if (typeof input.movement_at !== 'string' || !ISO_DT_RE.test(input.movement_at)) {
    throw new Ifrs9StageError(
      'invalid_movement_at',
      'movement_at must be an ISO-8601 datetime',
    );
  }
  if (input.notes !== undefined && input.notes !== null) {
    if (typeof input.notes !== 'string' || input.notes.length > 2000) {
      throw new Ifrs9StageError('invalid_notes', 'notes must be a string ≤ 2000 chars');
    }
  }
}

function validateOverrideCreate(input: EclOverrideCreateInput): void {
  if (!input || typeof input !== 'object') {
    throw new Ifrs9StageError('invalid_input', 'request body must be an object');
  }
  if (input.override_id !== undefined && (typeof input.override_id !== 'string' || !ID_RE.test(input.override_id))) {
    throw new Ifrs9StageError(
      'invalid_id',
      'override_id must match ^[a-z][a-z0-9_-]{1,63}$',
    );
  }
  if (typeof input.customer_id !== 'string' || !CUSTOMER_ID_RE.test(input.customer_id)) {
    throw new Ifrs9StageError(
      'invalid_customer_id',
      'customer_id must match ^[a-zA-Z][a-zA-Z0-9_-]{1,63}$',
    );
  }
  validatePartialEclFields(input);
  if (input.notes !== undefined && input.notes !== null) {
    if (typeof input.notes !== 'string' || input.notes.length > 2000) {
      throw new Ifrs9StageError('invalid_notes', 'notes must be a string ≤ 2000 chars');
    }
  }
  // Require at least one override field — otherwise the row is pointless.
  if (
    input.pd_override == null &&
    input.lgd_override == null &&
    input.ead_override == null
  ) {
    throw new Ifrs9StageError(
      'invalid_inputs',
      'at least one of pd_override, lgd_override, ead_override must be supplied',
    );
  }
}

function validatePartialEclFields(
  input: { pd_override?: number | null; lgd_override?: number | null; ead_override?: number | null },
): void {
  if (input.pd_override !== undefined && input.pd_override !== null) {
    if (
      typeof input.pd_override !== 'number' ||
      !Number.isFinite(input.pd_override) ||
      input.pd_override < 0 ||
      input.pd_override > 1
    ) {
      throw new Ifrs9StageError('invalid_inputs', 'pd_override must be in [0, 1] or null');
    }
  }
  if (input.lgd_override !== undefined && input.lgd_override !== null) {
    if (
      typeof input.lgd_override !== 'number' ||
      !Number.isFinite(input.lgd_override) ||
      input.lgd_override <= 0 ||
      input.lgd_override > 1
    ) {
      throw new Ifrs9StageError('invalid_inputs', 'lgd_override must be in (0, 1] or null');
    }
  }
  if (input.ead_override !== undefined && input.ead_override !== null) {
    if (
      typeof input.ead_override !== 'number' ||
      !Number.isFinite(input.ead_override) ||
      input.ead_override < 0 ||
      !Number.isInteger(input.ead_override)
    ) {
      throw new Ifrs9StageError(
        'invalid_inputs',
        'ead_override must be a non-negative integer or null',
      );
    }
  }
}

// ── Store interfaces ──────────────────────────────────────────────────

export interface StageMovementLedger {
  list(
    tenant_id: string,
    opts?: {
      customer_id?: string;
      to_stage?: Ifrs9Stage;
      reason?: StageMovementReason;
      include_deleted?: boolean;
      limit?: number;
    },
  ): StageMovementEvent[];
  get(tenant_id: string, movement_id: string): StageMovementEvent | null;
  /** Resolve the LATEST stage for a given customer based on the ledger
   *  (newest movement_at wins). Returns null when no movements
   *  recorded. */
  resolveCurrentStage(tenant_id: string, customer_id: string): Ifrs9Stage | null;
  create(
    tenant_id: string,
    input: StageMovementCreateInput,
    actor: string,
    now: Date,
  ): StageMovementEvent;
  softDelete(
    tenant_id: string,
    movement_id: string,
    actor: string,
    now: Date,
  ): StageMovementEvent;
  restore(payload: StageMovementEvent): boolean;
  /** Portfolio rollup: distribution per stage + ECL totals + movement count. */
  portfolioRollup(tenant_id: string): PortfolioRollup;
}

export interface PortfolioRollup {
  total_customers_with_movements: number;
  /** Per-stage customer counts based on resolveCurrentStage. */
  customers_by_current_stage: Record<Ifrs9Stage, number>;
  /** Total ECL across the most-recent ECL value per customer. */
  total_ecl: number;
  /** Stage-3 ECL specifically — drives the SPA's "lifetime credit-impaired"
   *  banner. */
  stage_3_ecl: number;
  /** Movement counts grouped by reason — surfaces dominant
   *  deterioration drivers for the dashboard. */
  movements_by_reason: Record<StageMovementReason, number>;
  /** Newest-first sample of the last 5 stage changes — drives the
   *  "Recent movements" tile. */
  recent_movements: ReadonlyArray<{
    movement_id: string;
    customer_id: string;
    from_stage: Ifrs9Stage | null;
    to_stage: Ifrs9Stage;
    movement_at: string;
  }>;
}

export interface EclOverrideStore {
  list(
    tenant_id: string,
    opts?: { customer_id?: string; active?: boolean; include_deleted?: boolean },
  ): EclOverride[];
  get(tenant_id: string, override_id: string): EclOverride | null;
  /** Convenience: resolve the ACTIVE override for a customer.
   *  Returns null when no active override exists. */
  resolveActive(tenant_id: string, customer_id: string): EclOverride | null;
  create(
    tenant_id: string,
    input: EclOverrideCreateInput,
    actor: string,
    now: Date,
  ): EclOverride;
  update(
    tenant_id: string,
    override_id: string,
    patch: EclOverrideUpdateInput,
    actor: string,
    now: Date,
  ): EclOverride;
  softDelete(
    tenant_id: string,
    override_id: string,
    actor: string,
    now: Date,
  ): EclOverride;
  restore(payload: EclOverride): boolean;
}

// ── InMemory implementations ──────────────────────────────────────────

export class InMemoryStageMovementLedger implements StageMovementLedger {
  private byTenant = new Map<string, Map<string, StageMovementEvent>>();
  private idCounter = 0;

  private bucket(tenant_id: string): Map<string, StageMovementEvent> {
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
      customer_id?: string;
      to_stage?: Ifrs9Stage;
      reason?: StageMovementReason;
      include_deleted?: boolean;
      limit?: number;
    } = {},
  ): StageMovementEvent[] {
    const out: StageMovementEvent[] = [];
    const b = this.byTenant.get(tenant_id);
    if (!b) return out;
    for (const e of b.values()) {
      if (!opts.include_deleted && e.deleted_at) continue;
      if (opts.customer_id !== undefined && e.customer_id !== opts.customer_id) continue;
      if (opts.to_stage !== undefined && e.to_stage !== opts.to_stage) continue;
      if (opts.reason !== undefined && e.reason !== opts.reason) continue;
      out.push({ ...e, inputs: { ...e.inputs } });
    }
    // Newest-first by movement_at, then movement_id desc for tie-break.
    out.sort((a, b) => {
      if (a.movement_at !== b.movement_at) return b.movement_at.localeCompare(a.movement_at);
      return b.movement_id.localeCompare(a.movement_id);
    });
    const limit = opts.limit ?? 200;
    return out.slice(0, Math.min(Math.max(limit, 1), 500));
  }

  get(tenant_id: string, movement_id: string): StageMovementEvent | null {
    const e = this.byTenant.get(tenant_id)?.get(movement_id);
    if (!e || e.deleted_at) return null;
    return { ...e, inputs: { ...e.inputs } };
  }

  resolveCurrentStage(tenant_id: string, customer_id: string): Ifrs9Stage | null {
    const items = this.list(tenant_id, { customer_id });
    return items.length > 0 ? items[0].to_stage : null;
  }

  create(
    tenant_id: string,
    input: StageMovementCreateInput,
    actor: string,
    now: Date,
  ): StageMovementEvent {
    validateMovementCreate(input);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new Ifrs9StageError('invalid_input', 'actor (created_by) required');
    }
    const b = this.bucket(tenant_id);
    const live = [...b.values()].filter((e) => !e.deleted_at).length;
    if (live >= IFRS9_MOVEMENT_CAP_PER_TENANT) {
      throw new Ifrs9StageError(
        'cap_reached',
        `stage movement cap (${IFRS9_MOVEMENT_CAP_PER_TENANT}) reached`,
      );
    }
    let movement_id = input.movement_id;
    if (!movement_id) {
      this.idCounter++;
      movement_id = `sm_${now.getTime().toString(36)}_${this.idCounter}`;
    }
    if (b.has(movement_id) && !b.get(movement_id)!.deleted_at) {
      throw new Ifrs9StageError(
        'duplicate_movement_id',
        `movement_id ${movement_id} already exists`,
        { movement_id },
      );
    }
    const ts = now.toISOString();
    const ecl = computeEcl(input.inputs);
    const entry: StageMovementEvent = {
      movement_id,
      tenant_id,
      customer_id: input.customer_id,
      from_stage: input.from_stage ?? null,
      to_stage: input.to_stage,
      reason: input.reason,
      inputs: { ...input.inputs },
      ecl,
      notes: input.notes?.trim() || null,
      movement_at: input.movement_at,
      created_at: ts,
      created_by: actor,
      updated_at: ts,
      updated_by: actor,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(entry.movement_id, entry);
    return { ...entry, inputs: { ...entry.inputs } };
  }

  softDelete(
    tenant_id: string,
    movement_id: string,
    actor: string,
    now: Date,
  ): StageMovementEvent {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new Ifrs9StageError('invalid_input', 'actor (deleted_by) required');
    }
    const b = this.bucket(tenant_id);
    const cur = b.get(movement_id);
    if (!cur || cur.deleted_at) {
      throw new Ifrs9StageError('unknown_movement', `movement ${movement_id} not found`);
    }
    const ts = now.toISOString();
    const tombstoned: StageMovementEvent = {
      ...cur,
      deleted_at: ts,
      deleted_by: actor,
      updated_at: ts,
      updated_by: actor,
    };
    b.set(movement_id, tombstoned);
    return { ...tombstoned, inputs: { ...tombstoned.inputs } };
  }

  restore(payload: StageMovementEvent): boolean {
    const b = this.bucket(payload.tenant_id);
    const cur = b.get(payload.movement_id);
    if (cur && !cur.deleted_at) return false;
    const restored: StageMovementEvent = {
      ...payload,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(restored.movement_id, restored);
    return true;
  }

  portfolioRollup(tenant_id: string): PortfolioRollup {
    const b = this.byTenant.get(tenant_id);
    const by_customer = new Map<string, StageMovementEvent>();
    const movements_by_reason: Record<StageMovementReason, number> = {
      dpd_30_breach: 0,
      dpd_90_breach: 0,
      restructure: 0,
      pd_lifetime_increased: 0,
      watchlist_flagged: 0,
      cured: 0,
      manual_override: 0,
      data_quality_correction: 0,
    };
    const allLiveMovements: StageMovementEvent[] = [];
    if (b) {
      for (const e of b.values()) {
        if (e.deleted_at) continue;
        allLiveMovements.push(e);
        movements_by_reason[e.reason]++;
        const prev = by_customer.get(e.customer_id);
        if (!prev || e.movement_at > prev.movement_at) {
          by_customer.set(e.customer_id, e);
        }
      }
    }
    const customers_by_current_stage: Record<Ifrs9Stage, number> = { 1: 0, 2: 0, 3: 0 };
    let total_ecl = 0;
    let stage_3_ecl = 0;
    for (const latest of by_customer.values()) {
      customers_by_current_stage[latest.to_stage]++;
      total_ecl += latest.ecl;
      if (latest.to_stage === 3) stage_3_ecl += latest.ecl;
    }
    const recent_movements = allLiveMovements
      .slice()
      .sort((a, b) => b.movement_at.localeCompare(a.movement_at))
      .slice(0, 5)
      .map((m) => ({
        movement_id: m.movement_id,
        customer_id: m.customer_id,
        from_stage: m.from_stage,
        to_stage: m.to_stage,
        movement_at: m.movement_at,
      }));
    return {
      total_customers_with_movements: by_customer.size,
      customers_by_current_stage,
      total_ecl,
      stage_3_ecl,
      movements_by_reason,
      recent_movements,
    };
  }
}

export class InMemoryEclOverrideStore implements EclOverrideStore {
  private byTenant = new Map<string, Map<string, EclOverride>>();
  /** Per-tenant active-override index keyed by customer_id. */
  private activeByCustomer = new Map<string, Map<string, string>>();
  private idCounter = 0;

  private bucket(tenant_id: string): Map<string, EclOverride> {
    let b = this.byTenant.get(tenant_id);
    if (!b) {
      b = new Map();
      this.byTenant.set(tenant_id, b);
    }
    return b;
  }

  private activeBucket(tenant_id: string): Map<string, string> {
    let b = this.activeByCustomer.get(tenant_id);
    if (!b) {
      b = new Map();
      this.activeByCustomer.set(tenant_id, b);
    }
    return b;
  }

  list(
    tenant_id: string,
    opts: { customer_id?: string; active?: boolean; include_deleted?: boolean } = {},
  ): EclOverride[] {
    const out: EclOverride[] = [];
    const b = this.byTenant.get(tenant_id);
    if (!b) return out;
    for (const e of b.values()) {
      if (!opts.include_deleted && e.deleted_at) continue;
      if (opts.customer_id !== undefined && e.customer_id !== opts.customer_id) continue;
      if (opts.active !== undefined && e.active !== opts.active) continue;
      out.push({ ...e });
    }
    out.sort((a, b) => {
      const c = a.customer_id.localeCompare(b.customer_id);
      return c !== 0 ? c : a.override_id.localeCompare(b.override_id);
    });
    return out;
  }

  get(tenant_id: string, override_id: string): EclOverride | null {
    const e = this.byTenant.get(tenant_id)?.get(override_id);
    if (!e || e.deleted_at) return null;
    return { ...e };
  }

  resolveActive(tenant_id: string, customer_id: string): EclOverride | null {
    const id = this.activeByCustomer.get(tenant_id)?.get(customer_id);
    if (!id) return null;
    const e = this.byTenant.get(tenant_id)?.get(id);
    if (!e || e.deleted_at || !e.active) return null;
    return { ...e };
  }

  create(
    tenant_id: string,
    input: EclOverrideCreateInput,
    actor: string,
    now: Date,
  ): EclOverride {
    validateOverrideCreate(input);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new Ifrs9StageError('invalid_input', 'actor (created_by) required');
    }
    const b = this.bucket(tenant_id);
    const active = this.activeBucket(tenant_id);
    const willBeActive = input.active !== undefined ? !!input.active : true;
    // Duplicate-active-override invariant: at most one active per customer.
    if (willBeActive) {
      const existingId = active.get(input.customer_id);
      if (existingId) {
        const existing = b.get(existingId);
        if (existing && !existing.deleted_at && existing.active) {
          throw new Ifrs9StageError(
            'duplicate_override',
            `customer ${input.customer_id} already has an active ECL override (${existingId})`,
            { customer_id: input.customer_id, conflicting_override_id: existingId },
          );
        }
      }
    }
    const live = [...b.values()].filter((e) => !e.deleted_at).length;
    if (live >= IFRS9_OVERRIDE_CAP_PER_TENANT) {
      throw new Ifrs9StageError(
        'cap_reached',
        `ECL override cap (${IFRS9_OVERRIDE_CAP_PER_TENANT}) reached`,
      );
    }
    let override_id = input.override_id;
    if (!override_id) {
      this.idCounter++;
      override_id = `eo_${now.getTime().toString(36)}_${this.idCounter}`;
    }
    if (b.has(override_id) && !b.get(override_id)!.deleted_at) {
      throw new Ifrs9StageError(
        'duplicate_override',
        `override_id ${override_id} already exists`,
        { override_id },
      );
    }
    const ts = now.toISOString();
    const entry: EclOverride = {
      override_id,
      tenant_id,
      customer_id: input.customer_id,
      pd_override: input.pd_override ?? null,
      lgd_override: input.lgd_override ?? null,
      ead_override: input.ead_override ?? null,
      active: willBeActive,
      notes: input.notes?.trim() || null,
      created_at: ts,
      created_by: actor,
      updated_at: ts,
      updated_by: actor,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(entry.override_id, entry);
    if (entry.active) {
      active.set(entry.customer_id, entry.override_id);
    }
    return { ...entry };
  }

  update(
    tenant_id: string,
    override_id: string,
    patch: EclOverrideUpdateInput,
    actor: string,
    now: Date,
  ): EclOverride {
    if (!patch || typeof patch !== 'object') {
      throw new Ifrs9StageError('invalid_input', 'patch must be an object');
    }
    validatePartialEclFields(patch);
    if (patch.notes !== undefined && patch.notes !== null) {
      if (typeof patch.notes !== 'string' || patch.notes.length > 2000) {
        throw new Ifrs9StageError('invalid_notes', 'notes must be a string ≤ 2000 chars');
      }
    }
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new Ifrs9StageError('invalid_input', 'actor (updated_by) required');
    }
    const b = this.bucket(tenant_id);
    const cur = b.get(override_id);
    if (!cur || cur.deleted_at) {
      throw new Ifrs9StageError('unknown_override', `override ${override_id} not found`);
    }
    const active = this.activeBucket(tenant_id);
    const willBeActive = patch.active !== undefined ? !!patch.active : cur.active;
    // Refuse re-activation if another active override holds the customer.
    if (willBeActive && !cur.active) {
      const existingId = active.get(cur.customer_id);
      if (existingId && existingId !== override_id) {
        const existing = b.get(existingId);
        if (existing && !existing.deleted_at && existing.active) {
          throw new Ifrs9StageError(
            'duplicate_override',
            `customer ${cur.customer_id} already has an active ECL override (${existingId})`,
            { customer_id: cur.customer_id, conflicting_override_id: existingId },
          );
        }
      }
    }
    const merged: EclOverride = {
      ...cur,
      pd_override: patch.pd_override !== undefined ? patch.pd_override : cur.pd_override,
      lgd_override: patch.lgd_override !== undefined ? patch.lgd_override : cur.lgd_override,
      ead_override: patch.ead_override !== undefined ? patch.ead_override : cur.ead_override,
      active: willBeActive,
      notes: patch.notes !== undefined ? patch.notes?.trim() || null : cur.notes,
      updated_at: now.toISOString(),
      updated_by: actor,
    };
    // Maintain at-least-one-override invariant.
    if (
      merged.pd_override == null &&
      merged.lgd_override == null &&
      merged.ead_override == null
    ) {
      throw new Ifrs9StageError(
        'invalid_inputs',
        'at least one of pd_override, lgd_override, ead_override must remain set',
      );
    }
    b.set(override_id, merged);
    // Maintain active index.
    if (merged.active) {
      active.set(merged.customer_id, override_id);
    } else if (active.get(merged.customer_id) === override_id) {
      active.delete(merged.customer_id);
    }
    return { ...merged };
  }

  softDelete(
    tenant_id: string,
    override_id: string,
    actor: string,
    now: Date,
  ): EclOverride {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new Ifrs9StageError('invalid_input', 'actor (deleted_by) required');
    }
    const b = this.bucket(tenant_id);
    const cur = b.get(override_id);
    if (!cur || cur.deleted_at) {
      throw new Ifrs9StageError('unknown_override', `override ${override_id} not found`);
    }
    const ts = now.toISOString();
    const tombstoned: EclOverride = {
      ...cur,
      deleted_at: ts,
      deleted_by: actor,
      updated_at: ts,
      updated_by: actor,
    };
    b.set(override_id, tombstoned);
    // Drop from active index.
    const active = this.activeBucket(tenant_id);
    if (active.get(cur.customer_id) === override_id) {
      active.delete(cur.customer_id);
    }
    return { ...tombstoned };
  }

  restore(payload: EclOverride): boolean {
    const b = this.bucket(payload.tenant_id);
    const cur = b.get(payload.override_id);
    if (cur && !cur.deleted_at) return false;
    // Refuse restore when an active override already governs the
    // customer (security: don't silently re-enable a stale override).
    if (payload.active) {
      const active = this.activeBucket(payload.tenant_id);
      const conflict = active.get(payload.customer_id);
      if (conflict && conflict !== payload.override_id) {
        const conflictRow = b.get(conflict);
        if (conflictRow && !conflictRow.deleted_at && conflictRow.active) {
          return false;
        }
      }
    }
    const restored: EclOverride = {
      ...payload,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(restored.override_id, restored);
    if (restored.active) {
      this.activeBucket(restored.tenant_id).set(restored.customer_id, restored.override_id);
    }
    return true;
  }
}

export const defaultStageMovementLedger: StageMovementLedger = new InMemoryStageMovementLedger();
export const defaultEclOverrideStore: EclOverrideStore = new InMemoryEclOverrideStore();
