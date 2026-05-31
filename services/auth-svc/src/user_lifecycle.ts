// services/auth-svc/src/user_lifecycle.ts
//
// Enterprise IAM — Feature 1: User Status Management.
//
// Closed-enum lifecycle states + append-only status-transition ledger +
// bulk update helper. Additive over the existing IUserStore: a status
// change goes through this store, which writes both an in-memory event
// + (in pg mode) the M15 audit chain via the AuditEventLogClient bridge.

export type UserLifecycleStatus =
  | 'active'
  | 'inactive'
  | 'suspended'
  | 'locked'
  | 'pending_approval';

export const ALL_USER_LIFECYCLE_STATUSES: readonly UserLifecycleStatus[] = [
  'active',
  'inactive',
  'suspended',
  'locked',
  'pending_approval',
] as const;

export function isUserLifecycleStatus(v: unknown): v is UserLifecycleStatus {
  return typeof v === 'string' &&
    (ALL_USER_LIFECYCLE_STATUSES as readonly string[]).includes(v);
}

export interface UserStatusHistoryEntry {
  history_id: string;
  user_id: string;
  tenant_id: string;
  prev_status: UserLifecycleStatus | null;
  new_status: UserLifecycleStatus;
  changed_at: string;
  changed_by: string;
  reason: string | null;
  correlation_id: string | null;
  created_at: string;
}

export interface RecordStatusChangeInput {
  user_id: string;
  tenant_id?: string;
  prev_status: UserLifecycleStatus | null;
  new_status: UserLifecycleStatus;
  changed_by: string;
  reason?: string | null;
  correlation_id?: string | null;
}

export interface BulkStatusUpdateInput {
  user_ids: readonly string[];
  tenant_id?: string;
  new_status: UserLifecycleStatus;
  changed_by: string;
  reason?: string;
}

export interface BulkStatusUpdateResult {
  correlation_id: string;
  updated: number;
  failed: Array<{ user_id: string; error: string }>;
}

export class UserLifecycleError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'UserLifecycleError';
  }
}

export interface IUserLifecycleStore {
  recordStatusChange(input: RecordStatusChangeInput, now?: Date): UserStatusHistoryEntry;
  listStatusHistory(user_id: string, opts?: { limit?: number }): UserStatusHistoryEntry[];
  listTenantHistory(tenant_id: string, opts?: { status?: UserLifecycleStatus; limit?: number }): UserStatusHistoryEntry[];
  bulkUpdateStatus(input: BulkStatusUpdateInput, statusResolver: (user_id: string) => UserLifecycleStatus | null, now?: Date): BulkStatusUpdateResult;
  getEffectiveStatus(user_id: string): UserLifecycleStatus | null;
}

const BULK_CAP = 500;

export class InMemoryUserLifecycleStore implements IUserLifecycleStore {
  private byUser = new Map<string, UserStatusHistoryEntry[]>();
  private byTenant = new Map<string, UserStatusHistoryEntry[]>();
  private effective = new Map<string, UserLifecycleStatus>();
  private seq = 0;

  recordStatusChange(input: RecordStatusChangeInput, now: Date = new Date()): UserStatusHistoryEntry {
    if (!input.user_id?.trim()) throw new UserLifecycleError('invalid_input', 'user_id required');
    if (!isUserLifecycleStatus(input.new_status)) {
      throw new UserLifecycleError('invalid_status', `new_status must be one of ${ALL_USER_LIFECYCLE_STATUSES.join(', ')}`);
    }
    if (input.prev_status !== null && input.prev_status !== undefined && !isUserLifecycleStatus(input.prev_status)) {
      throw new UserLifecycleError('invalid_status', 'prev_status invalid');
    }
    if (!input.changed_by?.trim()) throw new UserLifecycleError('invalid_input', 'changed_by required');
    if (input.reason && input.reason.length > 2000) {
      throw new UserLifecycleError('invalid_input', 'reason exceeds 2000 chars');
    }
    const entry: UserStatusHistoryEntry = {
      history_id: `ush_${++this.seq}`,
      user_id: input.user_id,
      tenant_id: input.tenant_id ?? 'BANK_DEMO',
      prev_status: input.prev_status ?? null,
      new_status: input.new_status,
      changed_at: now.toISOString(),
      changed_by: input.changed_by,
      reason: input.reason?.trim() || null,
      correlation_id: input.correlation_id ?? null,
      created_at: now.toISOString(),
    };
    const userList = this.byUser.get(input.user_id) ?? [];
    userList.push(entry);
    this.byUser.set(input.user_id, userList);

    const tenList = this.byTenant.get(entry.tenant_id) ?? [];
    tenList.push(entry);
    this.byTenant.set(entry.tenant_id, tenList);

    this.effective.set(input.user_id, input.new_status);
    return { ...entry };
  }

  listStatusHistory(user_id: string, opts: { limit?: number } = {}): UserStatusHistoryEntry[] {
    const list = this.byUser.get(user_id) ?? [];
    const sorted = [...list].sort((a, b) => b.changed_at.localeCompare(a.changed_at));
    return opts.limit ? sorted.slice(0, opts.limit) : sorted;
  }

  listTenantHistory(tenant_id: string, opts: { status?: UserLifecycleStatus; limit?: number } = {}): UserStatusHistoryEntry[] {
    let list = this.byTenant.get(tenant_id) ?? [];
    if (opts.status) list = list.filter((e) => e.new_status === opts.status);
    const sorted = [...list].sort((a, b) => b.changed_at.localeCompare(a.changed_at));
    return opts.limit ? sorted.slice(0, opts.limit) : sorted;
  }

  bulkUpdateStatus(
    input: BulkStatusUpdateInput,
    statusResolver: (user_id: string) => UserLifecycleStatus | null,
    now: Date = new Date(),
  ): BulkStatusUpdateResult {
    if (!Array.isArray(input.user_ids) || input.user_ids.length === 0) {
      throw new UserLifecycleError('invalid_input', 'user_ids must be a non-empty array');
    }
    if (input.user_ids.length > BULK_CAP) {
      throw new UserLifecycleError('invalid_input', `cap ${BULK_CAP} user_ids per batch (got ${input.user_ids.length})`);
    }
    if (!isUserLifecycleStatus(input.new_status)) {
      throw new UserLifecycleError('invalid_status', 'new_status invalid');
    }
    const correlation_id = `bulk_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
    let updated = 0;
    const failed: Array<{ user_id: string; error: string }> = [];
    for (const uid of input.user_ids) {
      try {
        const prev = statusResolver(uid);
        this.recordStatusChange({
          user_id: uid,
          tenant_id: input.tenant_id,
          prev_status: prev,
          new_status: input.new_status,
          changed_by: input.changed_by,
          reason: input.reason,
          correlation_id,
        }, now);
        updated += 1;
      } catch (e) {
        failed.push({ user_id: uid, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { correlation_id, updated, failed };
  }

  getEffectiveStatus(user_id: string): UserLifecycleStatus | null {
    return this.effective.get(user_id) ?? null;
  }
}

export const BULK_STATUS_CAP = BULK_CAP;
