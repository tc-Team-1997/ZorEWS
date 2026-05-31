// services/auth-svc/src/user_audit_history.ts
//
// Enterprise IAM — Feature 6: User Audit History.
//
// Per-user event timeline with before/after JSON snapshots. Distinct from
// the existing audit_log.ts (closed AuthEventType enum for auth events
// like login_success / login_failure / user_locked) — this one captures
// LIFECYCLE events with structural diff (before vs after) so the SPA can
// render side-by-side panels for compliance review.
//
// Production fans out to the M15 audit.event_log hash-chain via the
// existing AuditEventLogClient bridge (services/auth-svc/src/audit_event_log.ts)
// so every IAM mutation is cryptographically anchored.

export type UserAuditEventType =
  | 'user_created'
  | 'user_updated'
  | 'password_reset'
  | 'role_changed'
  | 'access_changed'
  | 'status_changed'
  | 'approval_requested'
  | 'approval_decided'
  | 'session_terminated'
  | 'profile_updated'
  | 'lifecycle_bulk_update';

export const ALL_USER_AUDIT_EVENT_TYPES: readonly UserAuditEventType[] = [
  'user_created',
  'user_updated',
  'password_reset',
  'role_changed',
  'access_changed',
  'status_changed',
  'approval_requested',
  'approval_decided',
  'session_terminated',
  'profile_updated',
  'lifecycle_bulk_update',
] as const;

export function isUserAuditEventType(v: unknown): v is UserAuditEventType {
  return typeof v === 'string' &&
    (ALL_USER_AUDIT_EVENT_TYPES as readonly string[]).includes(v);
}

export interface UserAuditEntry {
  audit_id: string;
  user_id: string;
  tenant_id: string;
  event_type: UserAuditEventType;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  actor: string;
  occurred_at: string;
  comments: string | null;
  correlation_id: string | null;
  ip_address: string | null;
}

export interface RecordUserAuditInput {
  user_id: string;
  tenant_id?: string;
  event_type: UserAuditEventType;
  before_state?: Record<string, unknown> | null;
  after_state?: Record<string, unknown> | null;
  actor: string;
  comments?: string;
  correlation_id?: string | null;
  ip_address?: string | null;
}

export interface UserAuditFilter {
  event_type?: UserAuditEventType;
  actor?: string;
  since?: string;
  until?: string;
  page?: number;
  page_size?: number;
}

export interface FieldDiffEntry {
  field: string;
  before: unknown;
  after: unknown;
}

export class UserAuditHistoryError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'UserAuditHistoryError';
  }
}

const AUDIT_PAGE_SIZE_DEFAULT = 50;
const AUDIT_PAGE_SIZE_MAX = 500;

export interface IUserAuditStore {
  record(input: RecordUserAuditInput, now?: Date): UserAuditEntry;
  listByUser(user_id: string, filter?: UserAuditFilter): { items: UserAuditEntry[]; total: number; page: number; page_size: number };
  listByTenant(tenant_id: string, filter?: UserAuditFilter): { items: UserAuditEntry[]; total: number; page: number; page_size: number };
  listByCorrelation(correlation_id: string): UserAuditEntry[];
  get(audit_id: string): UserAuditEntry | null;
  diff(audit_id: string): FieldDiffEntry[];
}

export class InMemoryUserAuditStore implements IUserAuditStore {
  private byUser = new Map<string, UserAuditEntry[]>();
  private byTenant = new Map<string, UserAuditEntry[]>();
  private byCorrelation = new Map<string, UserAuditEntry[]>();
  private byId = new Map<string, UserAuditEntry>();
  private seq = 0;

  record(input: RecordUserAuditInput, now: Date = new Date()): UserAuditEntry {
    if (!input.user_id?.trim()) throw new UserAuditHistoryError('invalid_input', 'user_id required');
    if (!isUserAuditEventType(input.event_type)) {
      throw new UserAuditHistoryError('invalid_input', `event_type must be one of ${ALL_USER_AUDIT_EVENT_TYPES.join(', ')}`);
    }
    if (!input.actor?.trim()) throw new UserAuditHistoryError('invalid_input', 'actor required');
    if (input.comments && input.comments.length > 4000) {
      throw new UserAuditHistoryError('invalid_input', 'comments > 4000 chars');
    }
    const entry: UserAuditEntry = {
      audit_id: `uah_${++this.seq}_${now.getTime().toString(36)}`,
      user_id: input.user_id,
      tenant_id: input.tenant_id ?? 'BANK_DEMO',
      event_type: input.event_type,
      before_state: input.before_state ?? null,
      after_state: input.after_state ?? null,
      actor: input.actor,
      occurred_at: now.toISOString(),
      comments: input.comments?.trim() || null,
      correlation_id: input.correlation_id ?? null,
      ip_address: input.ip_address ?? null,
    };
    this.byId.set(entry.audit_id, entry);
    pushTo(this.byUser, input.user_id, entry);
    pushTo(this.byTenant, entry.tenant_id, entry);
    if (entry.correlation_id) pushTo(this.byCorrelation, entry.correlation_id, entry);
    return { ...entry };
  }

  listByUser(user_id: string, filter: UserAuditFilter = {}): { items: UserAuditEntry[]; total: number; page: number; page_size: number } {
    return this.applyFilter(this.byUser.get(user_id) ?? [], filter);
  }

  listByTenant(tenant_id: string, filter: UserAuditFilter = {}): { items: UserAuditEntry[]; total: number; page: number; page_size: number } {
    return this.applyFilter(this.byTenant.get(tenant_id) ?? [], filter);
  }

  listByCorrelation(correlation_id: string): UserAuditEntry[] {
    const rows = this.byCorrelation.get(correlation_id) ?? [];
    return [...rows]
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
      .map((r) => ({ ...r }));
  }

  get(audit_id: string): UserAuditEntry | null {
    const r = this.byId.get(audit_id);
    return r ? { ...r } : null;
  }

  diff(audit_id: string): FieldDiffEntry[] {
    const r = this.byId.get(audit_id);
    if (!r) throw new UserAuditHistoryError('not_found', `audit_id=${audit_id} not found`);
    const before = (r.before_state ?? {}) as Record<string, unknown>;
    const after = (r.after_state ?? {}) as Record<string, unknown>;
    const fields = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
    const out: FieldDiffEntry[] = [];
    for (const f of [...fields].sort()) {
      const b = before[f];
      const a = after[f];
      if (!deepEqual(b, a)) {
        out.push({ field: f, before: b ?? null, after: a ?? null });
      }
    }
    return out;
  }

  private applyFilter(rows: UserAuditEntry[], filter: UserAuditFilter): { items: UserAuditEntry[]; total: number; page: number; page_size: number } {
    let filtered = rows;
    if (filter.event_type) filtered = filtered.filter((r) => r.event_type === filter.event_type);
    if (filter.actor) filtered = filtered.filter((r) => r.actor === filter.actor);
    if (filter.since) filtered = filtered.filter((r) => r.occurred_at >= filter.since!);
    if (filter.until) filtered = filtered.filter((r) => r.occurred_at <= filter.until!);
    const sorted = [...filtered].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
    const total = sorted.length;
    const page = Math.max(1, filter.page ?? 1);
    const page_size = Math.min(AUDIT_PAGE_SIZE_MAX, Math.max(1, filter.page_size ?? AUDIT_PAGE_SIZE_DEFAULT));
    const start = (page - 1) * page_size;
    return {
      items: sorted.slice(start, start + page_size).map((r) => ({ ...r })),
      total,
      page,
      page_size,
    };
  }
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export { AUDIT_PAGE_SIZE_DEFAULT, AUDIT_PAGE_SIZE_MAX };
