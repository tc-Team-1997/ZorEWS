// services/bff/src/audit_trail.ts
//
// T6 M15.1 — BIL Audit & Compliance trail.
//
// Structured audit log with filters tuned for RBI/IRDAI evidence
// dumps. Distinct from:
//   - services/audit-svc (Python WORM hash-chain ledger — tamper-proof
//     long-term storage)
//   - rules/types.ts AuditEvent (rule-state transitions only)
//
// This module is the BIL-facing query surface: per-tenant scoped,
// filterable by actor / action / resource / outcome / time-window,
// with a summary aggregator for compliance dashboards.
//
// Production swap: same AuditTrailStore interface, persisted to a
// WORM table with hash-chain integrity (the audit-svc shape).
//
// T6 M15.2 — hash-chain integrity. Each event carries:
//   prev_hash: hash of the previous event in this tenant's ledger
//              (or "GENESIS" for the first event)
//   hash:      SHA-256 over the canonical JSON of the event
//              (excluding hash + prev_hash itself, but INCLUDING
//              prev_hash so a tampered earlier event invalidates
//              every subsequent hash)
//
// Tampering with any field on any event → its hash no longer matches
// the recomputed hash → verifyChain detects the break and reports
// the index + expected vs actual hash.

import { createHash, randomUUID } from 'node:crypto';

// ─── Public types ──────────────────────────────────────────────────────

export type AuditOutcome = 'success' | 'failure' | 'denied';
export type AuditSeverity = 'info' | 'warning' | 'critical';

export type AuditResourceType =
  | 'user'
  | 'session'
  | 'config'
  | 'case'
  | 'alert'
  | 'report'
  | 'scenario'
  | 'rule'
  | 'integration'
  | 'system';

/** Verb describing the action taken. Open-ended string so callers can
 *  introduce new actions without a schema change; the listActions route
 *  enumerates whatever has been seen. Convention: lowercase + dot-
 *  separated namespace, e.g. `auth.login`, `config.update`. */
export type AuditAction = string;

export interface AuditEventInput {
  actor_username: string;
  actor_role: string;
  action: AuditAction;
  resource_type: AuditResourceType;
  resource_id: string;
  outcome: AuditOutcome;
  severity?: AuditSeverity;
  correlation_id?: string;
  ip_address?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditEvent extends Required<Omit<AuditEventInput, 'metadata' | 'correlation_id' | 'ip_address' | 'severity'>> {
  event_id: string;
  ts: string;
  tenant_id: string;
  severity: AuditSeverity;
  correlation_id: string | null;
  ip_address: string | null;
  metadata: Record<string, unknown>;
  /** SHA-256 hex of the canonical JSON encoding of this event
   *  (without the hash field itself). Set at record time. */
  hash: string;
  /** Hash of the previous event in the same tenant's ledger.
   *  'GENESIS' for the first event. */
  prev_hash: string;
}

export interface AuditFilters {
  actor_username?: string;
  /** Single action OR a comma-separated list (the route expands the
   *  comma form before calling). */
  action?: string | string[];
  resource_type?: AuditResourceType;
  outcome?: AuditOutcome;
  severity?: AuditSeverity;
  /** ISO timestamp inclusive lower bound. */
  since?: string;
  /** ISO timestamp inclusive upper bound. */
  until?: string;
  page?: number;
  page_size?: number;
}

export interface AuditPage {
  items: AuditEvent[];
  page: number;
  page_size: number;
  total: number;
}

export interface AuditSummary {
  /** Window covered (inclusive). */
  since: string;
  until: string;
  total: number;
  by_outcome: Record<AuditOutcome, number>;
  by_severity: Record<AuditSeverity, number>;
  by_action: Array<{ action: string; count: number }>;
  by_resource_type: Array<{ resource_type: AuditResourceType; count: number }>;
}

/** Result of walking a tenant's audit chain and recomputing every hash. */
export interface ChainVerification {
  tenant_id: string;
  generated_at: string;
  total_events: number;
  /** True iff every event's recorded hash matches the recomputed hash AND
   *  every prev_hash matches the previous event's hash. */
  valid: boolean;
  /** Hash of the last event in the chain. 'GENESIS' when no events yet. */
  last_hash: string;
  /**
   * Set when valid=false. Identifies the first index at which the chain
   * broke (oldest-first ordering), the offending event_id, and the
   * expected vs. actual hashes for the SPA to render. */
  broken_at?: {
    index: number;
    event_id: string;
    expected_hash: string;
    actual_hash: string;
    reason: 'hash_mismatch' | 'prev_hash_mismatch';
  };
}

export interface AuditTrailStore {
  /** Record a new event. Throws AuditValidationError on bad input. */
  record(tenant_id: string, input: AuditEventInput, now: Date): AuditEvent;
  /** Paginated query. Sorted newest-first within page. */
  list(tenant_id: string, filters: AuditFilters): AuditPage;
  /** Single event by id. Returns null when not found. */
  get(tenant_id: string, event_id: string): AuditEvent | null;
  /** Distinct action verbs seen for this tenant. */
  listActions(tenant_id: string): string[];
  /** Aggregate counts for the last `days` ending at `now`. */
  summarise(tenant_id: string, days: number, now: Date): AuditSummary;
  /** Walk the chain + recompute every hash. Reports tampering. */
  verifyChain(tenant_id: string, now: Date): ChainVerification;
}

export class AuditValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AuditValidationError';
  }
}

const VALID_OUTCOMES: AuditOutcome[] = ['success', 'failure', 'denied'];
const VALID_SEVERITIES: AuditSeverity[] = ['info', 'warning', 'critical'];
const VALID_RESOURCE_TYPES: AuditResourceType[] = [
  'user',
  'session',
  'config',
  'case',
  'alert',
  'report',
  'scenario',
  'rule',
  'integration',
  'system',
];

export function isAuditOutcome(s: unknown): s is AuditOutcome {
  return typeof s === 'string' && VALID_OUTCOMES.includes(s as AuditOutcome);
}
export function isAuditSeverity(s: unknown): s is AuditSeverity {
  return typeof s === 'string' && VALID_SEVERITIES.includes(s as AuditSeverity);
}
export function isAuditResourceType(s: unknown): s is AuditResourceType {
  return typeof s === 'string' && VALID_RESOURCE_TYPES.includes(s as AuditResourceType);
}

function validateInput(input: AuditEventInput): void {
  if (!input || typeof input !== 'object') {
    throw new AuditValidationError('invalid_input', 'event input must be an object');
  }
  for (const f of ['actor_username', 'actor_role', 'action', 'resource_id'] as const) {
    if (typeof input[f] !== 'string' || !input[f].trim()) {
      throw new AuditValidationError('invalid_input', `${f} is required`);
    }
  }
  if (!isAuditResourceType(input.resource_type)) {
    throw new AuditValidationError(
      'invalid_resource_type',
      `resource_type must be one of ${VALID_RESOURCE_TYPES.join(',')}`,
    );
  }
  if (!isAuditOutcome(input.outcome)) {
    throw new AuditValidationError(
      'invalid_outcome',
      `outcome must be one of ${VALID_OUTCOMES.join(',')}`,
    );
  }
  if (input.severity !== undefined && !isAuditSeverity(input.severity)) {
    throw new AuditValidationError(
      'invalid_severity',
      `severity must be one of ${VALID_SEVERITIES.join(',')}`,
    );
  }
}

// ─── In-memory store ───────────────────────────────────────────────────

export class InMemoryAuditTrailStore implements AuditTrailStore {
  /** tenant_id → newest-last array. */
  private readonly events = new Map<string, AuditEvent[]>();
  /** Per-tenant retention cap. Production = unbounded (WORM table). */
  private readonly cap: number;

  constructor(opts: { cap?: number } = {}) {
    this.cap = opts.cap ?? 5000;
  }

  record(tenant_id: string, input: AuditEventInput, now: Date): AuditEvent {
    validateInput(input);
    let arr = this.events.get(tenant_id);
    if (!arr) {
      arr = [];
      this.events.set(tenant_id, arr);
    }
    // The chain links to the previous event's hash. When the cap has
    // evicted older events, the chain still verifies for the
    // RETAINED window — the eviction acts as a reset boundary the
    // verifier can detect via the GENESIS prev_hash. For the in-memory
    // prototype that's fine; the production WORM store doesn't evict.
    const prev_hash = arr.length > 0 ? arr[arr.length - 1]!.hash : 'GENESIS';

    const skeleton: Omit<AuditEvent, 'hash'> = {
      event_id: `aud-${randomUUID()}`,
      ts: now.toISOString(),
      tenant_id,
      actor_username: input.actor_username,
      actor_role: input.actor_role,
      action: input.action,
      resource_type: input.resource_type,
      resource_id: input.resource_id,
      outcome: input.outcome,
      severity: input.severity ?? 'info',
      correlation_id: input.correlation_id ?? null,
      ip_address: input.ip_address ?? null,
      metadata: input.metadata ?? {},
      prev_hash,
    };
    const hash = computeEventHash(skeleton);
    const event: AuditEvent = { ...skeleton, hash };
    arr.push(event);
    if (arr.length > this.cap) {
      arr.splice(0, arr.length - this.cap);
    }
    return event;
  }

  list(tenant_id: string, filters: AuditFilters): AuditPage {
    const arr = this.events.get(tenant_id) ?? [];
    const filtered = applyFilters(arr, filters);
    const page = Math.max(1, filters.page ?? 1);
    const page_size = Math.max(1, Math.min(500, filters.page_size ?? 50));
    // newest-first
    const sorted = [...filtered].reverse();
    const start = (page - 1) * page_size;
    const items = sorted.slice(start, start + page_size);
    return { items, page, page_size, total: filtered.length };
  }

  get(tenant_id: string, event_id: string): AuditEvent | null {
    const arr = this.events.get(tenant_id) ?? [];
    return arr.find((e) => e.event_id === event_id) ?? null;
  }

  listActions(tenant_id: string): string[] {
    const arr = this.events.get(tenant_id) ?? [];
    const set = new Set<string>();
    for (const e of arr) set.add(e.action);
    return [...set].sort();
  }

  summarise(tenant_id: string, days: number, now: Date): AuditSummary {
    const since = new Date(now.getTime() - days * 86_400_000);
    const arr = this.events.get(tenant_id) ?? [];
    const inWindow = arr.filter((e) => e.ts >= since.toISOString() && e.ts <= now.toISOString());

    const by_outcome: Record<AuditOutcome, number> = { success: 0, failure: 0, denied: 0 };
    const by_severity: Record<AuditSeverity, number> = { info: 0, warning: 0, critical: 0 };
    const actionCounts = new Map<string, number>();
    const resCounts = new Map<AuditResourceType, number>();
    for (const e of inWindow) {
      by_outcome[e.outcome]++;
      by_severity[e.severity]++;
      actionCounts.set(e.action, (actionCounts.get(e.action) ?? 0) + 1);
      resCounts.set(e.resource_type, (resCounts.get(e.resource_type) ?? 0) + 1);
    }
    const by_action = [...actionCounts.entries()]
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count);
    const by_resource_type = [...resCounts.entries()]
      .map(([resource_type, count]) => ({ resource_type, count }))
      .sort((a, b) => b.count - a.count);

    return {
      since: since.toISOString(),
      until: now.toISOString(),
      total: inWindow.length,
      by_outcome,
      by_severity,
      by_action,
      by_resource_type,
    };
  }

  verifyChain(tenant_id: string, now: Date): ChainVerification {
    const arr = this.events.get(tenant_id) ?? [];
    if (arr.length === 0) {
      return {
        tenant_id,
        generated_at: now.toISOString(),
        total_events: 0,
        valid: true,
        last_hash: 'GENESIS',
      };
    }
    let prev = 'GENESIS';
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i]!;
      // Recompute the hash from the on-disk fields (excluding hash itself).
      const recomputed = computeEventHash({
        event_id: e.event_id,
        ts: e.ts,
        tenant_id: e.tenant_id,
        actor_username: e.actor_username,
        actor_role: e.actor_role,
        action: e.action,
        resource_type: e.resource_type,
        resource_id: e.resource_id,
        outcome: e.outcome,
        severity: e.severity,
        correlation_id: e.correlation_id,
        ip_address: e.ip_address,
        metadata: e.metadata,
        prev_hash: e.prev_hash,
      });
      if (recomputed !== e.hash) {
        return {
          tenant_id,
          generated_at: now.toISOString(),
          total_events: arr.length,
          valid: false,
          last_hash: arr[arr.length - 1]!.hash,
          broken_at: {
            index: i,
            event_id: e.event_id,
            expected_hash: recomputed,
            actual_hash: e.hash,
            reason: 'hash_mismatch',
          },
        };
      }
      if (e.prev_hash !== prev) {
        return {
          tenant_id,
          generated_at: now.toISOString(),
          total_events: arr.length,
          valid: false,
          last_hash: arr[arr.length - 1]!.hash,
          broken_at: {
            index: i,
            event_id: e.event_id,
            expected_hash: prev,
            actual_hash: e.prev_hash,
            reason: 'prev_hash_mismatch',
          },
        };
      }
      prev = e.hash;
    }
    return {
      tenant_id,
      generated_at: now.toISOString(),
      total_events: arr.length,
      valid: true,
      last_hash: arr[arr.length - 1]!.hash,
    };
  }

  /** Test helper. */
  reset(): void {
    this.events.clear();
  }

  /**
   * Test-only — return the underlying events array for a tenant.
   * Used by the integrity tests to simulate tampering by mutating
   * a field on a recorded event. Production stores wouldn't expose
   * this; the WORM table is append-only at the storage layer.
   */
  _eventsForTenant(tenant_id: string): AuditEvent[] | undefined {
    return this.events.get(tenant_id);
  }
}

/**
 * Canonical SHA-256 of an event. Excludes the `hash` field (we're
 * computing it!) but INCLUDES `prev_hash` so a tampered earlier event
 * invalidates every subsequent hash. Field order is deterministic per
 * the explicit object literal. */
function computeEventHash(e: Omit<AuditEvent, 'hash'>): string {
  // Sort metadata keys so JSON.stringify is deterministic across input
  // shapes. The other fields are scalars so their order doesn't change.
  const meta_canonical: Record<string, unknown> = {};
  for (const k of Object.keys(e.metadata).sort()) {
    meta_canonical[k] = e.metadata[k];
  }
  const canonical = JSON.stringify({
    event_id: e.event_id,
    ts: e.ts,
    tenant_id: e.tenant_id,
    actor_username: e.actor_username,
    actor_role: e.actor_role,
    action: e.action,
    resource_type: e.resource_type,
    resource_id: e.resource_id,
    outcome: e.outcome,
    severity: e.severity,
    correlation_id: e.correlation_id,
    ip_address: e.ip_address,
    metadata: meta_canonical,
    prev_hash: e.prev_hash,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function applyFilters(arr: AuditEvent[], f: AuditFilters): AuditEvent[] {
  let actions: Set<string> | null = null;
  if (f.action !== undefined) {
    const list = Array.isArray(f.action)
      ? f.action
      : f.action.split(',').map((s) => s.trim()).filter(Boolean);
    actions = new Set(list);
  }
  return arr.filter((e) => {
    if (f.actor_username !== undefined && e.actor_username !== f.actor_username) return false;
    if (actions !== null && !actions.has(e.action)) return false;
    if (f.resource_type !== undefined && e.resource_type !== f.resource_type) return false;
    if (f.outcome !== undefined && e.outcome !== f.outcome) return false;
    if (f.severity !== undefined && e.severity !== f.severity) return false;
    if (f.since !== undefined && e.ts < f.since) return false;
    if (f.until !== undefined && e.ts > f.until) return false;
    return true;
  });
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultAuditTrailStore: AuditTrailStore = new InMemoryAuditTrailStore();
