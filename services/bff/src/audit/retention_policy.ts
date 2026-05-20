// services/bff/src/audit/retention_policy.ts
//
// PHASE D.3 — Audit Admin retention policy (PDF §A6 Audit Administration).
//
// Per-tenant admin-editable retention policy for the audit ledger. Lets
// ops pick how long audit events are retained + by what strategy (raw
// count cap vs time window). Stored in-memory for the prototype; pg
// swap is mechanical via IRetentionPolicyStore.
//
// Distinct from:
//   - M15.1 ledger (services/bff/src/audit_trail.ts) — the events
//     themselves are stored there with a hard-coded cap.
//   - audit-svc (Python, S3 Object Lock) — long-term WORM storage.
//   - infra/terraform (S3 Object Lock retention years) — IaC config.
//
// D.3 is the ADMIN POLICY layer: regulators want a per-tenant record
// of "what retention is configured?" with auditable changes. The
// runtime cap on the live ledger stays as M15.1 owns it; this
// surface exposes the policy + lets the next-step purge job consume
// it. Application of the policy to actually purge old events is a
// future ticket (the regulatory record is the immediate need).
//
// Architecture choices (per execution rules):
//   - Additive only — no impact on M15.1 audit_trail.ts or any other
//     module's runtime behaviour.
//   - Pure in-memory store; pg-backed swap is a future ticket.
//   - Audit fields baked in (created_at/_by, updated_at/_by,
//     deleted_at/_by).
//   - Soft-delete-by-default with Recovery Center adapter registered.
//   - RBAC: audit:read admin-only.
//   - One policy per (tenant, scope). Scope distinguishes the
//     audit-trail table from future scopes (e.g. case events,
//     auth events). Closed enum.

/** Closed enum of retention strategies. */
export const ALL_RETENTION_STRATEGIES = [
  /** Retain the most-recent N events. Useful when the WORM destination
   *  is sized by row count not time. */
  'count_cap',
  /** Retain events with `ts >= now − retention_days`. Standard for
   *  regulatory compliance (e.g. RBI mandates ≥ 7 years for audit
   *  trail; IRDAI mandates ≥ 5 years for claim audit). */
  'time_window',
  /** Retain forever — purge job skips this policy entirely. Use for
   *  WORM-anchored tenants where deletion is operationally
   *  impossible. */
  'never_purge',
] as const;
export type RetentionStrategy = (typeof ALL_RETENTION_STRATEGIES)[number];

export function isRetentionStrategy(v: unknown): v is RetentionStrategy {
  return (
    typeof v === 'string' &&
    (ALL_RETENTION_STRATEGIES as readonly string[]).includes(v)
  );
}

/** Closed enum of policy scopes — which audit surface this policy
 *  governs. Today only `audit_trail` (M15.1) is wired; future scopes
 *  can be added without breaking the contract. */
export const ALL_RETENTION_SCOPES = [
  'audit_trail',
] as const;
export type RetentionScope = (typeof ALL_RETENTION_SCOPES)[number];

export function isRetentionScope(v: unknown): v is RetentionScope {
  return (
    typeof v === 'string' &&
    (ALL_RETENTION_SCOPES as readonly string[]).includes(v)
  );
}

export interface AuditRetentionPolicy {
  policy_id: string;
  tenant_id: string;
  scope: RetentionScope;
  strategy: RetentionStrategy;
  /** Required when strategy === 'time_window'. Integer 1..3650 (~10 years). */
  retention_days: number | null;
  /** Required when strategy === 'count_cap'. Integer 1..10_000_000. */
  max_events: number | null;
  /** Free-text rationale for the chosen retention — surfaces in
   *  evidence packs + access-review reports. */
  notes: string | null;
  active: boolean;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface AuditRetentionPolicyCreateInput {
  policy_id: string;
  scope: RetentionScope;
  strategy: RetentionStrategy;
  retention_days?: number | null;
  max_events?: number | null;
  notes?: string | null;
  active?: boolean;
}

export interface AuditRetentionPolicyUpdateInput {
  scope?: RetentionScope;
  strategy?: RetentionStrategy;
  retention_days?: number | null;
  max_events?: number | null;
  notes?: string | null;
  active?: boolean;
}

export class AuditRetentionError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_policy_id'
      | 'invalid_scope'
      | 'invalid_strategy'
      | 'invalid_retention_days'
      | 'invalid_max_events'
      | 'invalid_notes'
      | 'unknown_policy'
      | 'duplicate_policy_id'
      | 'duplicate_scope'
      | 'cap_reached',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'AuditRetentionError';
  }
}

/** Per-tenant cap — generous since policies are infrequent. */
export const AUDIT_RETENTION_CAP_PER_TENANT = 20;
/** Inclusive integer bounds. retention_days ≤ 3650 ≈ 10 years
 *  (industry max). max_events ≤ 10M (single-tenant SaaS upper). */
export const RETENTION_DAYS_MIN = 1;
export const RETENTION_DAYS_MAX = 3650;
export const MAX_EVENTS_MIN = 1;
export const MAX_EVENTS_MAX = 10_000_000;
export const NOTES_MAX_LEN = 2000;

const POLICY_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;

/** Cross-field invariant on the strategy / retention_days / max_events triple. */
function validateRetentionTriple(
  strategy: RetentionStrategy,
  retention_days: number | null | undefined,
  max_events: number | null | undefined,
): void {
  if (strategy === 'time_window') {
    if (
      typeof retention_days !== 'number' ||
      !Number.isInteger(retention_days) ||
      retention_days < RETENTION_DAYS_MIN ||
      retention_days > RETENTION_DAYS_MAX
    ) {
      throw new AuditRetentionError(
        'invalid_retention_days',
        `retention_days must be an integer in [${RETENTION_DAYS_MIN}, ${RETENTION_DAYS_MAX}] when strategy=time_window`,
      );
    }
    if (max_events !== undefined && max_events !== null) {
      throw new AuditRetentionError(
        'invalid_max_events',
        'max_events must be omitted/null when strategy=time_window',
      );
    }
  } else if (strategy === 'count_cap') {
    if (
      typeof max_events !== 'number' ||
      !Number.isInteger(max_events) ||
      max_events < MAX_EVENTS_MIN ||
      max_events > MAX_EVENTS_MAX
    ) {
      throw new AuditRetentionError(
        'invalid_max_events',
        `max_events must be an integer in [${MAX_EVENTS_MIN}, ${MAX_EVENTS_MAX}] when strategy=count_cap`,
      );
    }
    if (retention_days !== undefined && retention_days !== null) {
      throw new AuditRetentionError(
        'invalid_retention_days',
        'retention_days must be omitted/null when strategy=count_cap',
      );
    }
  } else {
    // never_purge: both must be null/omitted
    if (retention_days !== undefined && retention_days !== null) {
      throw new AuditRetentionError(
        'invalid_retention_days',
        'retention_days must be omitted/null when strategy=never_purge',
      );
    }
    if (max_events !== undefined && max_events !== null) {
      throw new AuditRetentionError(
        'invalid_max_events',
        'max_events must be omitted/null when strategy=never_purge',
      );
    }
  }
}

function validateCreate(input: AuditRetentionPolicyCreateInput): void {
  if (!input || typeof input !== 'object') {
    throw new AuditRetentionError('invalid_input', 'request body must be an object');
  }
  if (typeof input.policy_id !== 'string' || !POLICY_ID_RE.test(input.policy_id)) {
    throw new AuditRetentionError(
      'invalid_policy_id',
      'policy_id must match ^[a-z][a-z0-9_-]{1,63}$',
    );
  }
  if (!isRetentionScope(input.scope)) {
    throw new AuditRetentionError(
      'invalid_scope',
      `scope must be one of: ${ALL_RETENTION_SCOPES.join(', ')}`,
    );
  }
  if (!isRetentionStrategy(input.strategy)) {
    throw new AuditRetentionError(
      'invalid_strategy',
      `strategy must be one of: ${ALL_RETENTION_STRATEGIES.join(', ')}`,
    );
  }
  validateRetentionTriple(input.strategy, input.retention_days, input.max_events);
  if (input.notes !== undefined && input.notes !== null) {
    if (typeof input.notes !== 'string' || input.notes.length > NOTES_MAX_LEN) {
      throw new AuditRetentionError(
        'invalid_notes',
        `notes must be a string ≤ ${NOTES_MAX_LEN} chars (or null)`,
      );
    }
  }
}

function validateUpdate(patch: AuditRetentionPolicyUpdateInput): void {
  if (!patch || typeof patch !== 'object') {
    throw new AuditRetentionError('invalid_input', 'patch must be an object');
  }
  if (patch.scope !== undefined && !isRetentionScope(patch.scope)) {
    throw new AuditRetentionError('invalid_scope', 'scope must be valid');
  }
  if (patch.strategy !== undefined && !isRetentionStrategy(patch.strategy)) {
    throw new AuditRetentionError('invalid_strategy', 'strategy must be valid');
  }
  if (patch.notes !== undefined && patch.notes !== null) {
    if (typeof patch.notes !== 'string' || patch.notes.length > NOTES_MAX_LEN) {
      throw new AuditRetentionError(
        'invalid_notes',
        `notes must be a string ≤ ${NOTES_MAX_LEN} chars (or null)`,
      );
    }
  }
  // Cross-field invariant runs against the merged result in update().
}

// ── Store ──────────────────────────────────────────────────────────────

export interface AuditRetentionPolicyStore {
  list(tenant_id: string, opts?: { include_deleted?: boolean }): AuditRetentionPolicy[];
  get(tenant_id: string, policy_id: string): AuditRetentionPolicy | null;
  /** Convenience lookup: the active policy governing a given scope (if
   *  any). Returns the first active row for the scope; only one is
   *  permitted at a time per the duplicate_scope invariant in
   *  create(). */
  resolveActive(tenant_id: string, scope: RetentionScope): AuditRetentionPolicy | null;
  create(
    tenant_id: string,
    input: AuditRetentionPolicyCreateInput,
    actor: string,
    now: Date,
  ): AuditRetentionPolicy;
  update(
    tenant_id: string,
    policy_id: string,
    patch: AuditRetentionPolicyUpdateInput,
    actor: string,
    now: Date,
  ): AuditRetentionPolicy;
  softDelete(
    tenant_id: string,
    policy_id: string,
    actor: string,
    now: Date,
  ): AuditRetentionPolicy;
  restore(payload: AuditRetentionPolicy): boolean;
}

export class InMemoryAuditRetentionPolicyStore implements AuditRetentionPolicyStore {
  private byTenant = new Map<string, Map<string, AuditRetentionPolicy>>();

  private bucket(tenant_id: string): Map<string, AuditRetentionPolicy> {
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
  ): AuditRetentionPolicy[] {
    const out: AuditRetentionPolicy[] = [];
    const b = this.byTenant.get(tenant_id);
    if (!b) return out;
    for (const p of b.values()) {
      if (!opts.include_deleted && p.deleted_at) continue;
      out.push({ ...p });
    }
    // Stable canonical order: scope asc, then policy_id asc.
    out.sort((a, b) => {
      const s = a.scope.localeCompare(b.scope);
      return s !== 0 ? s : a.policy_id.localeCompare(b.policy_id);
    });
    return out;
  }

  get(tenant_id: string, policy_id: string): AuditRetentionPolicy | null {
    const p = this.byTenant.get(tenant_id)?.get(policy_id);
    if (!p || p.deleted_at) return null;
    return { ...p };
  }

  resolveActive(tenant_id: string, scope: RetentionScope): AuditRetentionPolicy | null {
    const b = this.byTenant.get(tenant_id);
    if (!b) return null;
    for (const p of b.values()) {
      if (!p.deleted_at && p.active && p.scope === scope) {
        return { ...p };
      }
    }
    return null;
  }

  create(
    tenant_id: string,
    input: AuditRetentionPolicyCreateInput,
    actor: string,
    now: Date,
  ): AuditRetentionPolicy {
    validateCreate(input);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new AuditRetentionError('invalid_input', 'actor (created_by) required');
    }
    const b = this.bucket(tenant_id);
    const existing = b.get(input.policy_id);
    if (existing && !existing.deleted_at) {
      throw new AuditRetentionError(
        'duplicate_policy_id',
        `policy_id ${input.policy_id} already exists`,
        { policy_id: input.policy_id },
      );
    }
    // Duplicate-scope invariant — only one ACTIVE policy per scope
    // (inactive policies are kept for history but don't conflict).
    const willBeActive = input.active !== undefined ? !!input.active : true;
    if (willBeActive) {
      for (const p of b.values()) {
        if (!p.deleted_at && p.active && p.scope === input.scope) {
          throw new AuditRetentionError(
            'duplicate_scope',
            `an active policy already governs scope=${input.scope}; deactivate it first`,
            { scope: input.scope, conflicting_policy_id: p.policy_id },
          );
        }
      }
    }
    const live = [...b.values()].filter((p) => !p.deleted_at).length;
    if (live >= AUDIT_RETENTION_CAP_PER_TENANT) {
      throw new AuditRetentionError(
        'cap_reached',
        `audit retention policy cap (${AUDIT_RETENTION_CAP_PER_TENANT}) reached`,
      );
    }
    const ts = now.toISOString();
    const entry: AuditRetentionPolicy = {
      policy_id: input.policy_id,
      tenant_id,
      scope: input.scope,
      strategy: input.strategy,
      retention_days:
        input.strategy === 'time_window' ? (input.retention_days as number) : null,
      max_events: input.strategy === 'count_cap' ? (input.max_events as number) : null,
      notes: input.notes?.trim() || null,
      active: willBeActive,
      created_at: ts,
      created_by: actor,
      updated_at: ts,
      updated_by: actor,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(entry.policy_id, entry);
    return { ...entry };
  }

  update(
    tenant_id: string,
    policy_id: string,
    patch: AuditRetentionPolicyUpdateInput,
    actor: string,
    now: Date,
  ): AuditRetentionPolicy {
    validateUpdate(patch);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new AuditRetentionError('invalid_input', 'actor (updated_by) required');
    }
    const b = this.bucket(tenant_id);
    const cur = b.get(policy_id);
    if (!cur || cur.deleted_at) {
      throw new AuditRetentionError('unknown_policy', `policy ${policy_id} not found`);
    }
    const merged: AuditRetentionPolicy = {
      ...cur,
      scope: patch.scope ?? cur.scope,
      strategy: patch.strategy ?? cur.strategy,
      retention_days:
        patch.retention_days !== undefined ? patch.retention_days : cur.retention_days,
      max_events: patch.max_events !== undefined ? patch.max_events : cur.max_events,
      notes: patch.notes !== undefined ? patch.notes?.trim() || null : cur.notes,
      active: patch.active !== undefined ? !!patch.active : cur.active,
      updated_at: now.toISOString(),
      updated_by: actor,
    };
    // Cross-field invariant on the merged result.
    validateRetentionTriple(merged.strategy, merged.retention_days, merged.max_events);
    // If this policy is being (re-)activated for a scope already
    // governed by another active policy, refuse.
    if (merged.active && (patch.active === true || patch.scope !== undefined)) {
      for (const p of b.values()) {
        if (
          !p.deleted_at &&
          p.active &&
          p.scope === merged.scope &&
          p.policy_id !== policy_id
        ) {
          throw new AuditRetentionError(
            'duplicate_scope',
            `an active policy already governs scope=${merged.scope}; deactivate it first`,
            { scope: merged.scope, conflicting_policy_id: p.policy_id },
          );
        }
      }
    }
    // Normalise null-out fields that don't apply to the chosen strategy.
    if (merged.strategy !== 'time_window') merged.retention_days = null;
    if (merged.strategy !== 'count_cap') merged.max_events = null;
    b.set(policy_id, merged);
    return { ...merged };
  }

  softDelete(
    tenant_id: string,
    policy_id: string,
    actor: string,
    now: Date,
  ): AuditRetentionPolicy {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new AuditRetentionError('invalid_input', 'actor (deleted_by) required');
    }
    const b = this.bucket(tenant_id);
    const cur = b.get(policy_id);
    if (!cur || cur.deleted_at) {
      throw new AuditRetentionError('unknown_policy', `policy ${policy_id} not found`);
    }
    const ts = now.toISOString();
    const tombstoned: AuditRetentionPolicy = {
      ...cur,
      deleted_at: ts,
      deleted_by: actor,
      updated_at: ts,
      updated_by: actor,
    };
    b.set(policy_id, tombstoned);
    return { ...tombstoned };
  }

  restore(payload: AuditRetentionPolicy): boolean {
    const b = this.bucket(payload.tenant_id);
    const cur = b.get(payload.policy_id);
    if (cur && !cur.deleted_at) return false;
    // If restoring as active, refuse when another active policy
    // already governs the scope.
    if (payload.active) {
      for (const p of b.values()) {
        if (
          !p.deleted_at &&
          p.active &&
          p.scope === payload.scope &&
          p.policy_id !== payload.policy_id
        ) {
          return false;
        }
      }
    }
    const restored: AuditRetentionPolicy = {
      ...payload,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(restored.policy_id, restored);
    return true;
  }
}

/** Module-level default singleton — matches the rest of the BFF stores. */
export const defaultAuditRetentionPolicyStore: AuditRetentionPolicyStore =
  new InMemoryAuditRetentionPolicyStore();
