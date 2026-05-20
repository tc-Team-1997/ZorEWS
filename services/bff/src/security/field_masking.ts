// services/bff/src/security/field_masking.ts
//
// PHASE D.2 — Field-Level Masking admin (PDF §A2 Access Control —
// Field-Level Masking item).
//
// Config-driven PII masking: an admin declares "field X is masked
// for role Y at strategy Z", and the runtime applies it before
// returning structured payloads (customer-360, audit events, etc.).
//
// Distinct from the existing free-text scrubber at
// `services/bff/src/copilot/pii_masker.ts` (which uses fixed regex
// patterns to mask PII tokens before they hit the LLM). D.2 is the
// COMPLEMENTARY surface: structured-field masking driven by a per-
// (tenant, role, field_path) policy table.
//
// Architecture choices (per execution rules):
//   - Additive only — no impact on copilot/pii_masker.ts, no impact on
//     any existing dashboards / responses (the resolver is opt-in, the
//     caller has to invoke `applyMasking()` against a payload).
//   - Pure-function `applyMasking(payload, policies, role)` so it's
//     trivial to use anywhere a service builds a response.
//   - Closed enum of strategies — `redact / hash_last4 / partial_email
//     / fixed_label / null`. Strategies are deterministic; no random
//     tokens (audit-replay needs determinism).
//   - Per-tenant policy store with full audit fields (created_at/_by,
//     updated_at/_by, deleted_at/_by) + soft-delete + restore for the
//     Recovery Center.
//   - RBAC: `audit:read` admin-only for the policy CRUD routes (this
//     is sensitive security config).

import { createHash } from 'node:crypto';

/** Closed enum of masking strategies. */
export const ALL_MASKING_STRATEGIES = [
  /** Replace value entirely with the literal `[REDACTED]`. Safe default. */
  'redact',
  /** Hash-and-truncate: last 4 hex chars of sha256(value) shown.
   *  Useful when the field is needed for cross-row joins but the
   *  cleartext must not be shown. Deterministic per-value. */
  'hash_last4',
  /** For email addresses: keep first letter + domain, redact middle.
   *  `j***@example.com`. Falls back to `redact` on non-email strings. */
  'partial_email',
  /** Replace with caller-configured `replacement` string. */
  'fixed_label',
  /** Replace value with JSON null. Useful for numeric fields where
   *  the SPA tile can render "—" cleanly. */
  'null',
] as const;
export type MaskingStrategy = (typeof ALL_MASKING_STRATEGIES)[number];

export function isMaskingStrategy(v: unknown): v is MaskingStrategy {
  return (
    typeof v === 'string' &&
    (ALL_MASKING_STRATEGIES as readonly string[]).includes(v)
  );
}

/** One policy row in the field-masking master. */
export interface FieldMaskingPolicy {
  policy_id: string;
  tenant_id: string;
  /** RBAC role this policy applies to (matches the role string the
   *  BFF resolves from JWT / API-key context). Empty string for "all
   *  roles" is NOT supported — every policy targets a specific role
   *  so admins can't accidentally lock themselves out. */
  role: string;
  /** Dotted path within the payload — e.g. `pii.aadhaar`,
   *  `customer.bureau_score`. Walks objects only; array indices are
   *  not addressable (a policy on `customers[0].name` won't match — set
   *  it on `customers.name` instead and it applies to every element). */
  field_path: string;
  strategy: MaskingStrategy;
  /** Required when strategy === 'fixed_label'; ignored otherwise. */
  replacement: string | null;
  active: boolean;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface FieldMaskingPolicyCreateInput {
  policy_id: string;
  role: string;
  field_path: string;
  strategy: MaskingStrategy;
  replacement?: string | null;
  active?: boolean;
}

export interface FieldMaskingPolicyUpdateInput {
  role?: string;
  field_path?: string;
  strategy?: MaskingStrategy;
  replacement?: string | null;
  active?: boolean;
}

export class FieldMaskingError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_policy_id'
      | 'invalid_role'
      | 'invalid_field_path'
      | 'invalid_strategy'
      | 'invalid_replacement'
      | 'unknown_policy'
      | 'duplicate_policy_id'
      | 'cap_reached',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'FieldMaskingError';
  }
}

/** Per-tenant cap. Matches sector/bureau master cap conservatism. */
export const FIELD_MASKING_CAP_PER_TENANT = 200;

const POLICY_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const ROLE_RE = /^[a-z][a-z0-9_]{0,47}$/;
// Allow dotted paths, alphanumeric segments, underscores. No array
// indices (`foo[0]`) — see field_path doc above for the rationale.
const FIELD_PATH_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;

function validateCreate(input: FieldMaskingPolicyCreateInput): void {
  if (!input || typeof input !== 'object') {
    throw new FieldMaskingError('invalid_input', 'request body must be an object');
  }
  if (typeof input.policy_id !== 'string' || !POLICY_ID_RE.test(input.policy_id)) {
    throw new FieldMaskingError(
      'invalid_policy_id',
      'policy_id must match ^[a-z][a-z0-9_-]{1,63}$',
    );
  }
  if (typeof input.role !== 'string' || !ROLE_RE.test(input.role)) {
    throw new FieldMaskingError(
      'invalid_role',
      'role must match ^[a-z][a-z0-9_]{0,47}$',
    );
  }
  if (typeof input.field_path !== 'string' || !FIELD_PATH_RE.test(input.field_path)) {
    throw new FieldMaskingError(
      'invalid_field_path',
      'field_path must be a dotted identifier path (no array indices)',
    );
  }
  if (!isMaskingStrategy(input.strategy)) {
    throw new FieldMaskingError(
      'invalid_strategy',
      `strategy must be one of: ${ALL_MASKING_STRATEGIES.join(', ')}`,
    );
  }
  if (input.strategy === 'fixed_label') {
    if (
      typeof input.replacement !== 'string' ||
      input.replacement.length === 0 ||
      input.replacement.length > 200
    ) {
      throw new FieldMaskingError(
        'invalid_replacement',
        'replacement must be a non-empty string ≤ 200 chars when strategy=fixed_label',
      );
    }
  } else {
    if (input.replacement !== undefined && input.replacement !== null) {
      throw new FieldMaskingError(
        'invalid_replacement',
        'replacement is only allowed when strategy=fixed_label',
      );
    }
  }
}

function validateUpdate(patch: FieldMaskingPolicyUpdateInput): void {
  if (!patch || typeof patch !== 'object') {
    throw new FieldMaskingError('invalid_input', 'patch must be an object');
  }
  if (patch.role !== undefined && (typeof patch.role !== 'string' || !ROLE_RE.test(patch.role))) {
    throw new FieldMaskingError('invalid_role', 'role must match ^[a-z][a-z0-9_]{0,47}$');
  }
  if (
    patch.field_path !== undefined &&
    (typeof patch.field_path !== 'string' || !FIELD_PATH_RE.test(patch.field_path))
  ) {
    throw new FieldMaskingError(
      'invalid_field_path',
      'field_path must be a dotted identifier path (no array indices)',
    );
  }
  if (patch.strategy !== undefined && !isMaskingStrategy(patch.strategy)) {
    throw new FieldMaskingError('invalid_strategy', 'strategy must be a valid MaskingStrategy');
  }
  // We do NOT cross-validate replacement vs strategy on partial patches
  // — `applyPatch()` merges first and the store calls validateCreate on
  // the merged result to catch (strategy=fixed_label, replacement=null)
  // mismatches.
}

// ── Store interface + in-memory impl ──────────────────────────────────

export interface FieldMaskingStore {
  list(
    tenant_id: string,
    opts?: { role?: string; include_deleted?: boolean },
  ): FieldMaskingPolicy[];
  get(tenant_id: string, policy_id: string): FieldMaskingPolicy | null;
  create(
    tenant_id: string,
    input: FieldMaskingPolicyCreateInput,
    actor: string,
    now: Date,
  ): FieldMaskingPolicy;
  update(
    tenant_id: string,
    policy_id: string,
    patch: FieldMaskingPolicyUpdateInput,
    actor: string,
    now: Date,
  ): FieldMaskingPolicy;
  softDelete(
    tenant_id: string,
    policy_id: string,
    actor: string,
    now: Date,
  ): FieldMaskingPolicy;
  restore(payload: FieldMaskingPolicy): boolean;
}

export class InMemoryFieldMaskingStore implements FieldMaskingStore {
  private byTenant = new Map<string, Map<string, FieldMaskingPolicy>>();

  private bucket(tenant_id: string): Map<string, FieldMaskingPolicy> {
    let b = this.byTenant.get(tenant_id);
    if (!b) {
      b = new Map();
      this.byTenant.set(tenant_id, b);
    }
    return b;
  }

  list(
    tenant_id: string,
    opts: { role?: string; include_deleted?: boolean } = {},
  ): FieldMaskingPolicy[] {
    const out: FieldMaskingPolicy[] = [];
    const b = this.byTenant.get(tenant_id);
    if (!b) return out;
    for (const p of b.values()) {
      if (!opts.include_deleted && p.deleted_at) continue;
      if (opts.role !== undefined && p.role !== opts.role) continue;
      out.push({ ...p });
    }
    // Stable canonical order: role asc, then field_path asc, then
    // policy_id asc. Makes SPA grid rendering deterministic.
    out.sort((a, b) => {
      const r = a.role.localeCompare(b.role);
      if (r !== 0) return r;
      const f = a.field_path.localeCompare(b.field_path);
      if (f !== 0) return f;
      return a.policy_id.localeCompare(b.policy_id);
    });
    return out;
  }

  get(tenant_id: string, policy_id: string): FieldMaskingPolicy | null {
    const p = this.byTenant.get(tenant_id)?.get(policy_id);
    if (!p || p.deleted_at) return null;
    return { ...p };
  }

  create(
    tenant_id: string,
    input: FieldMaskingPolicyCreateInput,
    actor: string,
    now: Date,
  ): FieldMaskingPolicy {
    validateCreate(input);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new FieldMaskingError('invalid_input', 'actor (created_by) required');
    }
    const b = this.bucket(tenant_id);
    const existing = b.get(input.policy_id);
    if (existing && !existing.deleted_at) {
      throw new FieldMaskingError(
        'duplicate_policy_id',
        `policy_id ${input.policy_id} already exists`,
        { policy_id: input.policy_id },
      );
    }
    const live = [...b.values()].filter((p) => !p.deleted_at).length;
    if (live >= FIELD_MASKING_CAP_PER_TENANT) {
      throw new FieldMaskingError(
        'cap_reached',
        `field masking policy cap (${FIELD_MASKING_CAP_PER_TENANT}) reached`,
      );
    }
    const ts = now.toISOString();
    const entry: FieldMaskingPolicy = {
      policy_id: input.policy_id,
      tenant_id,
      role: input.role,
      field_path: input.field_path,
      strategy: input.strategy,
      replacement: input.strategy === 'fixed_label' ? (input.replacement as string) : null,
      active: input.active !== undefined ? !!input.active : true,
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
    patch: FieldMaskingPolicyUpdateInput,
    actor: string,
    now: Date,
  ): FieldMaskingPolicy {
    validateUpdate(patch);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new FieldMaskingError('invalid_input', 'actor (updated_by) required');
    }
    const b = this.bucket(tenant_id);
    const cur = b.get(policy_id);
    if (!cur || cur.deleted_at) {
      throw new FieldMaskingError('unknown_policy', `policy ${policy_id} not found`);
    }
    const merged: FieldMaskingPolicy = {
      ...cur,
      role: patch.role ?? cur.role,
      field_path: patch.field_path ?? cur.field_path,
      strategy: patch.strategy ?? cur.strategy,
      replacement:
        patch.replacement !== undefined ? patch.replacement : cur.replacement,
      active: patch.active !== undefined ? !!patch.active : cur.active,
      updated_at: now.toISOString(),
      updated_by: actor,
    };
    // Cross-field invariant on the merged result: fixed_label MUST
    // have a replacement; other strategies MUST NOT.
    if (merged.strategy === 'fixed_label') {
      if (
        typeof merged.replacement !== 'string' ||
        merged.replacement.length === 0 ||
        merged.replacement.length > 200
      ) {
        throw new FieldMaskingError(
          'invalid_replacement',
          'replacement must be a non-empty string ≤ 200 chars when strategy=fixed_label',
        );
      }
    } else {
      merged.replacement = null;
    }
    b.set(policy_id, merged);
    return { ...merged };
  }

  softDelete(
    tenant_id: string,
    policy_id: string,
    actor: string,
    now: Date,
  ): FieldMaskingPolicy {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new FieldMaskingError('invalid_input', 'actor (deleted_by) required');
    }
    const b = this.bucket(tenant_id);
    const cur = b.get(policy_id);
    if (!cur || cur.deleted_at) {
      throw new FieldMaskingError('unknown_policy', `policy ${policy_id} not found`);
    }
    const ts = now.toISOString();
    const tombstoned: FieldMaskingPolicy = {
      ...cur,
      deleted_at: ts,
      deleted_by: actor,
      updated_at: ts,
      updated_by: actor,
    };
    b.set(policy_id, tombstoned);
    return { ...tombstoned };
  }

  restore(payload: FieldMaskingPolicy): boolean {
    const b = this.bucket(payload.tenant_id);
    const cur = b.get(payload.policy_id);
    // Refuse if a live row already exists under this id (Recovery
    // Center surfaces this as a conflict).
    if (cur && !cur.deleted_at) {
      return false;
    }
    const restored: FieldMaskingPolicy = {
      ...payload,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(restored.policy_id, restored);
    return true;
  }
}

/** Module-level default singleton — matches the rest of the BFF stores. */
export const defaultFieldMaskingStore: FieldMaskingStore = new InMemoryFieldMaskingStore();

// ── Pure resolver ─────────────────────────────────────────────────────

/** Apply a single masking strategy to a scalar value.
 *  Always returns a JSON-safe value (string | null). */
export function applyStrategy(
  value: unknown,
  strategy: MaskingStrategy,
  replacement: string | null,
): string | null {
  if (value === null || value === undefined) {
    return value === undefined ? null : null;
  }
  switch (strategy) {
    case 'redact':
      return '[REDACTED]';
    case 'fixed_label':
      return replacement ?? '[REDACTED]';
    case 'null':
      return null;
    case 'hash_last4': {
      const s = typeof value === 'string' ? value : JSON.stringify(value);
      const hex = createHash('sha256').update(s).digest('hex');
      return `***${hex.slice(-4)}`;
    }
    case 'partial_email': {
      if (typeof value !== 'string') return '[REDACTED]';
      const at = value.indexOf('@');
      if (at <= 0) return '[REDACTED]';
      const local = value.slice(0, at);
      const domain = value.slice(at);
      return `${local[0]}***${domain}`;
    }
    default:
      // Defensive: unknown strategy degrades to redact (should never
      // happen with the closed enum + isMaskingStrategy guard).
      return '[REDACTED]';
  }
}

/** Walk a dotted field path against an object root. Returns null if
 *  any intermediate segment is missing (the field-masking resolver
 *  silently skips paths that don't exist in the payload — masking a
 *  field that isn't present is a no-op).
 *
 *  Arrays are handled by recursing into every element: a policy on
 *  `customers.name` applied to `{customers: [{name: 'A'}, {name: 'B'}]}`
 *  masks both names. */
function setAtPath(
  root: unknown,
  segments: string[],
  setter: (current: unknown) => unknown,
): void {
  if (segments.length === 0) return;
  if (Array.isArray(root)) {
    for (const item of root) setAtPath(item, segments, setter);
    return;
  }
  if (!root || typeof root !== 'object') return;
  const head = segments[0];
  const rest = segments.slice(1);
  // root is a non-array object
  const obj = root as Record<string, unknown>;
  if (rest.length === 0) {
    // Terminal segment: mask if present (don't introduce new keys).
    if (head in obj) {
      obj[head] = setter(obj[head]);
    }
    return;
  }
  const next = obj[head];
  if (next === undefined || next === null) return;
  setAtPath(next, rest, setter);
}

/** Resolve which policies apply to the caller given (tenant, role).
 *  Only ACTIVE, non-deleted policies are returned. */
export function selectApplicablePolicies(
  policies: FieldMaskingPolicy[],
  role: string,
): FieldMaskingPolicy[] {
  return policies.filter((p) => p.active && !p.deleted_at && p.role === role);
}

/** Top-level resolver. Walks each applicable policy's field_path
 *  against `payload` and replaces matching values. Returns a NEW
 *  object (defensive — original payload not mutated). */
export function applyMasking<T>(
  payload: T,
  policies: FieldMaskingPolicy[],
  role: string,
): T {
  const applicable = selectApplicablePolicies(policies, role);
  if (applicable.length === 0) return payload;
  // Deep-clone via structuredClone if available; fall back to JSON
  // (good enough for our payload shapes — no Date/Map/Set).
  let clone: T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sc: any = (globalThis as any).structuredClone;
  if (typeof sc === 'function') {
    clone = sc(payload);
  } else {
    clone = JSON.parse(JSON.stringify(payload));
  }
  for (const p of applicable) {
    const segments = p.field_path.split('.');
    setAtPath(clone, segments, (cur) => applyStrategy(cur, p.strategy, p.replacement));
  }
  return clone;
}
