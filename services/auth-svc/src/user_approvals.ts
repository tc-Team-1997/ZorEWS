// services/auth-svc/src/user_approvals.ts
//
// Enterprise IAM — Feature 5: User Approval Workflow.
//
// IAM-scoped maker-checker queue. Richer than the generic app_audit.approvals
// store (T4.20) because each record carries a typed action_type + payload
// the approve endpoint replays verbatim against the IUserStore /
// IUserLifecycleStore / IPasswordGovernanceStore.
//
// Self-approval blocked at app AND DB level (CHECK constraint in 052 migration
// + UserApprovalsError('self_approval_forbidden') here).

export type UserApprovalActionType =
  | 'user_create'
  | 'user_role_change'
  | 'user_status_change'
  | 'user_delete'
  | 'user_access_grant'
  | 'password_force_reset';

export const ALL_USER_APPROVAL_ACTION_TYPES: readonly UserApprovalActionType[] = [
  'user_create',
  'user_role_change',
  'user_status_change',
  'user_delete',
  'user_access_grant',
  'password_force_reset',
] as const;

export type UserApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export const ALL_USER_APPROVAL_STATUSES: readonly UserApprovalStatus[] = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'expired',
] as const;

export function isUserApprovalActionType(v: unknown): v is UserApprovalActionType {
  return typeof v === 'string' &&
    (ALL_USER_APPROVAL_ACTION_TYPES as readonly string[]).includes(v);
}
export function isUserApprovalStatus(v: unknown): v is UserApprovalStatus {
  return typeof v === 'string' &&
    (ALL_USER_APPROVAL_STATUSES as readonly string[]).includes(v);
}

export interface UserApprovalRecord {
  approval_id: string;
  user_id: string;
  tenant_id: string;
  action_type: UserApprovalActionType;
  status: UserApprovalStatus;
  payload: Record<string, unknown>;
  requested_by: string;
  requested_at: string;
  request_comments: string | null;
  approver: string | null;
  approval_date: string | null;
  decision_comments: string | null;
  expires_at: string | null;
}

export interface CreatePendingInput {
  user_id: string;
  tenant_id?: string;
  action_type: UserApprovalActionType;
  payload?: Record<string, unknown>;
  requested_by: string;
  request_comments?: string;
  expires_in_days?: number;
}

export interface ApprovalDecisionInput {
  approval_id: string;
  approver: string;
  decision_comments?: string;
}

export interface ApprovalListFilter {
  tenant_id?: string;
  status?: UserApprovalStatus;
  action_type?: UserApprovalActionType;
  requested_by?: string;
  user_id?: string;
  page?: number;
  page_size?: number;
}

export interface ApprovalsSummary {
  tenant_id: string;
  by_status: Record<UserApprovalStatus, number>;
  by_action_type: Record<UserApprovalActionType, number>;
  oldest_pending_at: string | null;
}

export class UserApprovalsError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'UserApprovalsError';
  }
}

const APPROVAL_PAGE_SIZE_DEFAULT = 50;
const APPROVAL_PAGE_SIZE_MAX = 500;

export interface IUserApprovalStore {
  createPending(input: CreatePendingInput, now?: Date): UserApprovalRecord;
  get(approval_id: string): UserApprovalRecord | null;
  list(filter?: ApprovalListFilter): { items: UserApprovalRecord[]; total: number; page: number; page_size: number };
  approve(input: ApprovalDecisionInput, now?: Date): UserApprovalRecord;
  reject(input: ApprovalDecisionInput, now?: Date): UserApprovalRecord;
  cancel(approval_id: string, actor: string, reason?: string, now?: Date): UserApprovalRecord;
  summary(tenant_id: string, now?: Date): ApprovalsSummary;
}

export class InMemoryUserApprovalStore implements IUserApprovalStore {
  private rows = new Map<string, UserApprovalRecord>();
  private seq = 0;

  createPending(input: CreatePendingInput, now: Date = new Date()): UserApprovalRecord {
    if (!input.user_id?.trim()) throw new UserApprovalsError('invalid_input', 'user_id required');
    if (!isUserApprovalActionType(input.action_type)) {
      throw new UserApprovalsError('invalid_action_type', `action_type must be one of ${ALL_USER_APPROVAL_ACTION_TYPES.join(', ')}`);
    }
    if (!input.requested_by?.trim()) throw new UserApprovalsError('invalid_input', 'requested_by required');
    if (input.request_comments && input.request_comments.length > 4000) {
      throw new UserApprovalsError('invalid_input', 'request_comments > 4000 chars');
    }
    const approval_id = `appr_${++this.seq}_${now.getTime().toString(36)}`;
    const expires_at = input.expires_in_days && input.expires_in_days > 0
      ? new Date(now.getTime() + input.expires_in_days * 86_400_000).toISOString()
      : null;
    const record: UserApprovalRecord = {
      approval_id,
      user_id: input.user_id,
      tenant_id: input.tenant_id ?? 'BANK_DEMO',
      action_type: input.action_type,
      status: 'pending',
      payload: { ...(input.payload ?? {}) },
      requested_by: input.requested_by,
      requested_at: now.toISOString(),
      request_comments: input.request_comments?.trim() || null,
      approver: null,
      approval_date: null,
      decision_comments: null,
      expires_at,
    };
    this.rows.set(approval_id, record);
    return { ...record };
  }

  get(approval_id: string): UserApprovalRecord | null {
    const row = this.rows.get(approval_id);
    return row ? { ...row } : null;
  }

  list(filter: ApprovalListFilter = {}): { items: UserApprovalRecord[]; total: number; page: number; page_size: number } {
    let rows = [...this.rows.values()];
    if (filter.tenant_id) rows = rows.filter((r) => r.tenant_id === filter.tenant_id);
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter.action_type) rows = rows.filter((r) => r.action_type === filter.action_type);
    if (filter.requested_by) rows = rows.filter((r) => r.requested_by === filter.requested_by);
    if (filter.user_id) rows = rows.filter((r) => r.user_id === filter.user_id);
    // pending → oldest-first (FIFO inbox); others → newest-first
    rows.sort((a, b) => {
      if (filter.status === 'pending' || (a.status === 'pending' && b.status === 'pending')) {
        return a.requested_at.localeCompare(b.requested_at);
      }
      return b.requested_at.localeCompare(a.requested_at);
    });
    const total = rows.length;
    const page = Math.max(1, filter.page ?? 1);
    const page_size = Math.min(APPROVAL_PAGE_SIZE_MAX, Math.max(1, filter.page_size ?? APPROVAL_PAGE_SIZE_DEFAULT));
    const start = (page - 1) * page_size;
    return {
      items: rows.slice(start, start + page_size).map((r) => ({ ...r })),
      total,
      page,
      page_size,
    };
  }

  approve(input: ApprovalDecisionInput, now: Date = new Date()): UserApprovalRecord {
    return this.decide(input, 'approved', now);
  }
  reject(input: ApprovalDecisionInput, now: Date = new Date()): UserApprovalRecord {
    if (!input.decision_comments?.trim()) {
      throw new UserApprovalsError('invalid_input', 'decision_comments required for reject');
    }
    return this.decide(input, 'rejected', now);
  }

  cancel(approval_id: string, actor: string, reason: string | undefined, now: Date = new Date()): UserApprovalRecord {
    const row = this.rows.get(approval_id);
    if (!row) throw new UserApprovalsError('not_found', `approval_id=${approval_id} not found`);
    if (row.status !== 'pending') throw new UserApprovalsError('already_decided', `cannot cancel approval in status=${row.status}`);
    if (!actor?.trim()) throw new UserApprovalsError('invalid_input', 'actor required');
    const next: UserApprovalRecord = {
      ...row,
      status: 'cancelled',
      approver: actor,
      approval_date: now.toISOString(),
      decision_comments: reason?.trim() || null,
    };
    this.rows.set(approval_id, next);
    return { ...next };
  }

  summary(tenant_id: string, _now: Date = new Date()): ApprovalsSummary {
    const by_status: Record<UserApprovalStatus, number> = {
      pending: 0, approved: 0, rejected: 0, cancelled: 0, expired: 0,
    };
    const by_action_type: Record<UserApprovalActionType, number> = {
      user_create: 0, user_role_change: 0, user_status_change: 0,
      user_delete: 0, user_access_grant: 0, password_force_reset: 0,
    };
    let oldest_pending_at: string | null = null;
    for (const r of this.rows.values()) {
      if (r.tenant_id !== tenant_id) continue;
      by_status[r.status] += 1;
      by_action_type[r.action_type] += 1;
      if (r.status === 'pending') {
        if (!oldest_pending_at || r.requested_at < oldest_pending_at) {
          oldest_pending_at = r.requested_at;
        }
      }
    }
    return { tenant_id, by_status, by_action_type, oldest_pending_at };
  }

  private decide(input: ApprovalDecisionInput, decision: 'approved' | 'rejected', now: Date): UserApprovalRecord {
    const row = this.rows.get(input.approval_id);
    if (!row) throw new UserApprovalsError('not_found', `approval_id=${input.approval_id} not found`);
    if (row.status !== 'pending') throw new UserApprovalsError('already_decided', `approval already ${row.status}`);
    if (!input.approver?.trim()) throw new UserApprovalsError('invalid_input', 'approver required');
    if (input.approver === row.requested_by) {
      throw new UserApprovalsError('self_approval_forbidden', 'approver must differ from requested_by');
    }
    if (input.decision_comments && input.decision_comments.length > 4000) {
      throw new UserApprovalsError('invalid_input', 'decision_comments > 4000 chars');
    }
    const next: UserApprovalRecord = {
      ...row,
      status: decision,
      approver: input.approver,
      approval_date: now.toISOString(),
      decision_comments: input.decision_comments?.trim() || null,
    };
    this.rows.set(input.approval_id, next);
    return { ...next };
  }
}

export { APPROVAL_PAGE_SIZE_DEFAULT, APPROVAL_PAGE_SIZE_MAX };
