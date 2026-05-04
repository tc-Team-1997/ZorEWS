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

import { randomUUID } from 'node:crypto';

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
    const event: AuditEvent = {
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
    };
    let arr = this.events.get(tenant_id);
    if (!arr) {
      arr = [];
      this.events.set(tenant_id, arr);
    }
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

  /** Test helper. */
  reset(): void {
    this.events.clear();
  }
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
