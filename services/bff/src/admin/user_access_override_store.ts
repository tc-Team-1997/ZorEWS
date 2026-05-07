// services/bff/src/admin/user_access_override_store.ts
//
// Persistence for user_access_override + admin_audit_log. Two flavours:
//   - InMemoryStore: dev / tests / when ADMIN_PG_URL is unset
//   - PgStore:       reads/writes app_admin.* in Postgres
//
// Same interface, so the route handlers don't care which is wired.
// Mirrors the pattern used by services/bff/src/scenario/store.ts and
// services/bff/src/cms_store.ts.

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type {
  AdminAuditLogRow,
  CreateOverrideInput,
  ListOverridesFilter,
  ListOverridesResult,
  ModulePath,
  OverrideStatus,
  PermissionType,
  UpdateOverrideInput,
  UserAccessOverride,
} from './types';
import { OverrideError } from './types';

export interface ActorContext {
  actor_id: string;
  actor_role: string;
  request_id?: string;
  ip_address?: string;
  user_agent?: string;
}

export interface UserAccessOverrideStore {
  list(tenant_id: string, filter: ListOverridesFilter): Promise<ListOverridesResult>;
  get(tenant_id: string, override_id: string): Promise<UserAccessOverride | null>;
  /** Returns ALL overrides for a user (any status) — used by the resolver. */
  listForUser(tenant_id: string, user_id: string): Promise<UserAccessOverride[]>;
  /**
   * Create N rows from one CreateOverrideInput (one per module_path).
   * Atomic — either every row inserts or none do.
   */
  create(
    tenant_id: string,
    input: CreateOverrideInput,
    actor: ActorContext,
    now: Date,
  ): Promise<UserAccessOverride[]>;
  update(
    tenant_id: string,
    override_id: string,
    patch: UpdateOverrideInput,
    actor: ActorContext,
    now: Date,
  ): Promise<UserAccessOverride>;
  approve(
    tenant_id: string,
    override_id: string,
    note: string | null,
    actor: ActorContext,
    now: Date,
  ): Promise<UserAccessOverride>;
  reject(
    tenant_id: string,
    override_id: string,
    reason: string,
    actor: ActorContext,
    now: Date,
  ): Promise<UserAccessOverride>;
  revoke(
    tenant_id: string,
    override_id: string,
    reason: string,
    actor: ActorContext,
    now: Date,
  ): Promise<UserAccessOverride>;
  listAuditLog(
    tenant_id: string,
    filter: { entity_id?: string; actor_id?: string; from?: string; to?: string; page?: number; page_size?: number },
  ): Promise<{ items: AdminAuditLogRow[]; total: number; page: number; page_size: number }>;
}

// ── Helpers shared by both flavours ──────────────────────────────────

function ensureModulePathsAreFree(
  existing: UserAccessOverride[],
  user_id: string,
  module_paths: ModulePath[],
  permission_type: PermissionType,
): void {
  for (const path of module_paths) {
    const dup = existing.find(
      (o) =>
        o.user_id === user_id &&
        o.module_path === path &&
        o.permission_type === permission_type &&
        (o.status === 'ACTIVE' || o.status === 'PENDING_APPROVAL'),
    );
    if (dup) {
      throw new OverrideError(
        409,
        'EWS_409_duplicate_active_override',
        `${user_id} already has a ${dup.status.toLowerCase()} override on ${path}/${permission_type} (id=${dup.override_id})`,
      );
    }
  }
}

function mkRow(
  tenant_id: string,
  user_id: string,
  module_path: ModulePath,
  input: CreateOverrideInput,
  actor: ActorContext,
  now: Date,
): UserAccessOverride {
  const status: OverrideStatus = input.requires_approval ? 'PENDING_APPROVAL' : 'ACTIVE';
  return {
    override_id: randomUUID(),
    tenant_id,
    user_id,
    module_path,
    override_type: input.override_type,
    permission_type: input.permission_type,
    effective_from: input.effective_from,
    effective_till: input.effective_till,
    reason: input.reason,
    requires_approval: input.requires_approval,
    status,
    created_by: actor.actor_id,
    approved_by: input.requires_approval ? null : null, // remains null even if auto-active
    rejected_by: null,
    revoked_by: null,
    rejection_reason: null,
    revocation_reason: null,
    approval_note: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    approved_at: null,
    rejected_at: null,
    revoked_at: null,
  };
}

function mkAudit(
  tenant_id: string,
  override_id: string,
  action: AdminAuditLogRow['action'],
  before: UserAccessOverride | null,
  after: UserAccessOverride | null,
  reason: string | null,
  actor: ActorContext,
  now: Date,
): AdminAuditLogRow {
  return {
    audit_id: randomUUID(),
    tenant_id,
    entity_type: 'user_access_override',
    entity_id: override_id,
    action,
    actor_id: actor.actor_id,
    actor_role: actor.actor_role,
    before_state: before,
    after_state: after,
    reason,
    request_id: actor.request_id ?? null,
    ip_address: actor.ip_address ?? null,
    user_agent: actor.user_agent ?? null,
    created_at: now.toISOString(),
  };
}

// ── In-memory implementation (tests + dev fallback) ──────────────────

export class InMemoryUserAccessOverrideStore implements UserAccessOverrideStore {
  private readonly rows: UserAccessOverride[] = [];
  private readonly audits: AdminAuditLogRow[] = [];

  async list(tenant_id: string, filter: ListOverridesFilter): Promise<ListOverridesResult> {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filter.page_size ?? 50));
    const all = this.rows
      .filter((o) => o.tenant_id === tenant_id)
      .filter((o) => !filter.user_id || o.user_id === filter.user_id)
      .filter((o) => !filter.status || filter.status.includes(o.status))
      .filter((o) => !filter.module_path || o.module_path === filter.module_path)
      .filter((o) => !filter.created_from || o.created_at >= filter.created_from)
      .filter((o) => !filter.created_to || o.created_at <= filter.created_to)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const start = (page - 1) * pageSize;
    return { items: all.slice(start, start + pageSize), total: all.length, page, page_size: pageSize };
  }

  async get(tenant_id: string, override_id: string): Promise<UserAccessOverride | null> {
    return this.rows.find((o) => o.tenant_id === tenant_id && o.override_id === override_id) ?? null;
  }

  async listForUser(tenant_id: string, user_id: string): Promise<UserAccessOverride[]> {
    return this.rows.filter((o) => o.tenant_id === tenant_id && o.user_id === user_id);
  }

  async create(
    tenant_id: string,
    input: CreateOverrideInput,
    actor: ActorContext,
    now: Date,
  ): Promise<UserAccessOverride[]> {
    const userRows = this.rows.filter((o) => o.tenant_id === tenant_id && o.user_id === input.user_id);
    ensureModulePathsAreFree(userRows, input.user_id, input.module_paths, input.permission_type);
    const created: UserAccessOverride[] = [];
    for (const path of input.module_paths) {
      const row = mkRow(tenant_id, input.user_id, path, input, actor, now);
      this.rows.push(row);
      created.push(row);
      this.audits.push(mkAudit(tenant_id, row.override_id, 'create', null, row, input.reason, actor, now));
    }
    return created;
  }

  async update(
    tenant_id: string,
    override_id: string,
    patch: UpdateOverrideInput,
    actor: ActorContext,
    now: Date,
  ): Promise<UserAccessOverride> {
    const idx = this.rows.findIndex((o) => o.tenant_id === tenant_id && o.override_id === override_id);
    if (idx < 0) throw new OverrideError(404, 'EWS_404_not_found', `override ${override_id} not found`);
    const before = this.rows[idx];
    if (before.status !== 'PENDING_APPROVAL') {
      throw new OverrideError(
        409,
        'EWS_409_invalid_state',
        `cannot edit override in status ${before.status} (only PENDING_APPROVAL is mutable)`,
      );
    }
    const after: UserAccessOverride = {
      ...before,
      override_type: patch.override_type ?? before.override_type,
      permission_type: patch.permission_type ?? before.permission_type,
      effective_from: patch.effective_from ?? before.effective_from,
      effective_till: patch.effective_till === undefined ? before.effective_till : patch.effective_till,
      reason: patch.reason ?? before.reason,
      module_path: (patch.module_paths && patch.module_paths[0]) ?? before.module_path,
      updated_at: now.toISOString(),
    };
    this.rows[idx] = after;
    this.audits.push(mkAudit(tenant_id, override_id, 'update', before, after, patch.reason ?? null, actor, now));
    return after;
  }

  async approve(
    tenant_id: string,
    override_id: string,
    note: string | null,
    actor: ActorContext,
    now: Date,
  ): Promise<UserAccessOverride> {
    const idx = this.rows.findIndex((o) => o.tenant_id === tenant_id && o.override_id === override_id);
    if (idx < 0) throw new OverrideError(404, 'EWS_404_not_found', `override ${override_id} not found`);
    const before = this.rows[idx];
    if (before.status !== 'PENDING_APPROVAL') {
      throw new OverrideError(409, 'EWS_409_invalid_state', `override is not pending approval (status=${before.status})`);
    }
    if (before.created_by === actor.actor_id) {
      throw new OverrideError(
        403,
        'EWS_403_self_approval',
        'maker cannot be checker — different admin must approve',
      );
    }
    const after: UserAccessOverride = {
      ...before,
      status: 'ACTIVE',
      approved_by: actor.actor_id,
      approved_at: now.toISOString(),
      approval_note: note,
      updated_at: now.toISOString(),
    };
    this.rows[idx] = after;
    this.audits.push(mkAudit(tenant_id, override_id, 'approve', before, after, note, actor, now));
    return after;
  }

  async reject(
    tenant_id: string,
    override_id: string,
    reason: string,
    actor: ActorContext,
    now: Date,
  ): Promise<UserAccessOverride> {
    const idx = this.rows.findIndex((o) => o.tenant_id === tenant_id && o.override_id === override_id);
    if (idx < 0) throw new OverrideError(404, 'EWS_404_not_found', `override ${override_id} not found`);
    const before = this.rows[idx];
    if (before.status !== 'PENDING_APPROVAL') {
      throw new OverrideError(409, 'EWS_409_invalid_state', `override is not pending approval`);
    }
    if (before.created_by === actor.actor_id) {
      throw new OverrideError(403, 'EWS_403_self_approval', 'maker cannot reject own request');
    }
    if (!reason || reason.trim().length < 10) {
      throw new OverrideError(400, 'EWS_400_invalid_input', 'rejection_reason is required (≥ 10 chars)');
    }
    const after: UserAccessOverride = {
      ...before,
      status: 'REJECTED',
      rejected_by: actor.actor_id,
      rejected_at: now.toISOString(),
      rejection_reason: reason,
      updated_at: now.toISOString(),
    };
    this.rows[idx] = after;
    this.audits.push(mkAudit(tenant_id, override_id, 'reject', before, after, reason, actor, now));
    return after;
  }

  async revoke(
    tenant_id: string,
    override_id: string,
    reason: string,
    actor: ActorContext,
    now: Date,
  ): Promise<UserAccessOverride> {
    const idx = this.rows.findIndex((o) => o.tenant_id === tenant_id && o.override_id === override_id);
    if (idx < 0) throw new OverrideError(404, 'EWS_404_not_found', `override ${override_id} not found`);
    const before = this.rows[idx];
    if (before.status !== 'ACTIVE') {
      throw new OverrideError(409, 'EWS_409_invalid_state', `only ACTIVE overrides can be revoked (status=${before.status})`);
    }
    if (!reason || reason.trim().length < 10) {
      throw new OverrideError(400, 'EWS_400_invalid_input', 'revocation_reason is required (≥ 10 chars)');
    }
    const after: UserAccessOverride = {
      ...before,
      status: 'REVOKED',
      revoked_by: actor.actor_id,
      revoked_at: now.toISOString(),
      revocation_reason: reason,
      updated_at: now.toISOString(),
    };
    this.rows[idx] = after;
    this.audits.push(mkAudit(tenant_id, override_id, 'revoke', before, after, reason, actor, now));
    return after;
  }

  async listAuditLog(
    tenant_id: string,
    filter: { entity_id?: string; actor_id?: string; from?: string; to?: string; page?: number; page_size?: number },
  ): Promise<{ items: AdminAuditLogRow[]; total: number; page: number; page_size: number }> {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filter.page_size ?? 50));
    const all = this.audits
      .filter((a) => a.tenant_id === tenant_id)
      .filter((a) => !filter.entity_id || a.entity_id === filter.entity_id)
      .filter((a) => !filter.actor_id || a.actor_id === filter.actor_id)
      .filter((a) => !filter.from || a.created_at >= filter.from)
      .filter((a) => !filter.to || a.created_at <= filter.to)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const start = (page - 1) * pageSize;
    return { items: all.slice(start, start + pageSize), total: all.length, page, page_size: pageSize };
  }
}

// ── Postgres implementation ──────────────────────────────────────────

export class PgUserAccessOverrideStore implements UserAccessOverrideStore {
  constructor(private readonly pool: Pool) {}

  async list(tenant_id: string, filter: ListOverridesFilter): Promise<ListOverridesResult> {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filter.page_size ?? 50));
    const where: string[] = ['tenant_id = $1'];
    const args: unknown[] = [tenant_id];
    if (filter.user_id) {
      args.push(filter.user_id);
      where.push(`user_id = $${args.length}`);
    }
    if (filter.status && filter.status.length > 0) {
      args.push(filter.status);
      where.push(`status = ANY($${args.length}::text[])`);
    }
    if (filter.module_path) {
      args.push(filter.module_path);
      where.push(`module_path = $${args.length}`);
    }
    if (filter.created_from) {
      args.push(filter.created_from);
      where.push(`created_at >= $${args.length}`);
    }
    if (filter.created_to) {
      args.push(filter.created_to);
      where.push(`created_at <= $${args.length}`);
    }
    const whereSql = where.join(' AND ');

    const totalRes = await this.pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM app_admin.user_access_override WHERE ${whereSql}`,
      args,
    );
    const total = Number(totalRes.rows[0]?.c ?? 0);

    args.push(pageSize, (page - 1) * pageSize);
    const rowsRes = await this.pool.query(
      `SELECT * FROM app_admin.user_access_override
        WHERE ${whereSql}
        ORDER BY created_at DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    return {
      items: rowsRes.rows.map(rowToOverride),
      total,
      page,
      page_size: pageSize,
    };
  }

  async get(tenant_id: string, override_id: string): Promise<UserAccessOverride | null> {
    const r = await this.pool.query(
      `SELECT * FROM app_admin.user_access_override
        WHERE tenant_id=$1 AND override_id=$2`,
      [tenant_id, override_id],
    );
    return r.rows[0] ? rowToOverride(r.rows[0]) : null;
  }

  async listForUser(tenant_id: string, user_id: string): Promise<UserAccessOverride[]> {
    const r = await this.pool.query(
      `SELECT * FROM app_admin.user_access_override
        WHERE tenant_id=$1 AND user_id=$2
        ORDER BY created_at ASC`,
      [tenant_id, user_id],
    );
    return r.rows.map(rowToOverride);
  }

  async create(
    tenant_id: string,
    input: CreateOverrideInput,
    actor: ActorContext,
    now: Date,
  ): Promise<UserAccessOverride[]> {
    // Pre-flight: check duplicates so we 409 before opening a transaction.
    const existing = await this.listForUser(tenant_id, input.user_id);
    ensureModulePathsAreFree(existing, input.user_id, input.module_paths, input.permission_type);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const created: UserAccessOverride[] = [];
      for (const path of input.module_paths) {
        const row = mkRow(tenant_id, input.user_id, path, input, actor, now);
        await client.query(
          `INSERT INTO app_admin.user_access_override
             (override_id, tenant_id, user_id, module_path, override_type,
              permission_type, effective_from, effective_till, reason,
              requires_approval, status, created_by, created_at, updated_at)
           VALUES
             ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
          [
            row.override_id, row.tenant_id, row.user_id, row.module_path, row.override_type,
            row.permission_type, row.effective_from, row.effective_till, row.reason,
            row.requires_approval, row.status, row.created_by, row.created_at,
          ],
        );
        await this.writeAudit(client, mkAudit(tenant_id, row.override_id, 'create', null, row, input.reason, actor, now));
        created.push(row);
      }
      await client.query('COMMIT');
      return created;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async update(
    tenant_id: string,
    override_id: string,
    patch: UpdateOverrideInput,
    actor: ActorContext,
    now: Date,
  ): Promise<UserAccessOverride> {
    const before = await this.get(tenant_id, override_id);
    if (!before) throw new OverrideError(404, 'EWS_404_not_found', `override ${override_id} not found`);
    if (before.status !== 'PENDING_APPROVAL') {
      throw new OverrideError(409, 'EWS_409_invalid_state', `cannot edit override in status ${before.status}`);
    }
    const after: UserAccessOverride = {
      ...before,
      override_type: patch.override_type ?? before.override_type,
      permission_type: patch.permission_type ?? before.permission_type,
      effective_from: patch.effective_from ?? before.effective_from,
      effective_till: patch.effective_till === undefined ? before.effective_till : patch.effective_till,
      reason: patch.reason ?? before.reason,
      module_path: (patch.module_paths && patch.module_paths[0]) ?? before.module_path,
      updated_at: now.toISOString(),
    };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE app_admin.user_access_override
            SET override_type=$1, permission_type=$2, effective_from=$3,
                effective_till=$4, reason=$5, module_path=$6, updated_at=$7
          WHERE tenant_id=$8 AND override_id=$9`,
        [after.override_type, after.permission_type, after.effective_from,
         after.effective_till, after.reason, after.module_path, after.updated_at,
         tenant_id, override_id],
      );
      await this.writeAudit(client, mkAudit(tenant_id, override_id, 'update', before, after, patch.reason ?? null, actor, now));
      await client.query('COMMIT');
      return after;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async approve(
    tenant_id: string,
    override_id: string,
    note: string | null,
    actor: ActorContext,
    now: Date,
  ): Promise<UserAccessOverride> {
    const before = await this.get(tenant_id, override_id);
    if (!before) throw new OverrideError(404, 'EWS_404_not_found', `override ${override_id} not found`);
    if (before.status !== 'PENDING_APPROVAL') {
      throw new OverrideError(409, 'EWS_409_invalid_state', `override is not pending approval (status=${before.status})`);
    }
    if (before.created_by === actor.actor_id) {
      throw new OverrideError(403, 'EWS_403_self_approval', 'maker cannot be checker');
    }
    const after: UserAccessOverride = {
      ...before,
      status: 'ACTIVE',
      approved_by: actor.actor_id,
      approved_at: now.toISOString(),
      approval_note: note,
      updated_at: now.toISOString(),
    };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE app_admin.user_access_override
            SET status='ACTIVE', approved_by=$1, approved_at=$2,
                approval_note=$3, updated_at=$2
          WHERE tenant_id=$4 AND override_id=$5`,
        [actor.actor_id, after.approved_at, note, tenant_id, override_id],
      );
      await this.writeAudit(client, mkAudit(tenant_id, override_id, 'approve', before, after, note, actor, now));
      await client.query('COMMIT');
      return after;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async reject(
    tenant_id: string,
    override_id: string,
    reason: string,
    actor: ActorContext,
    now: Date,
  ): Promise<UserAccessOverride> {
    const before = await this.get(tenant_id, override_id);
    if (!before) throw new OverrideError(404, 'EWS_404_not_found', `override ${override_id} not found`);
    if (before.status !== 'PENDING_APPROVAL') {
      throw new OverrideError(409, 'EWS_409_invalid_state', `override is not pending approval`);
    }
    if (before.created_by === actor.actor_id) {
      throw new OverrideError(403, 'EWS_403_self_approval', 'maker cannot reject own request');
    }
    if (!reason || reason.trim().length < 10) {
      throw new OverrideError(400, 'EWS_400_invalid_input', 'rejection_reason is required (≥ 10 chars)');
    }
    const after: UserAccessOverride = {
      ...before,
      status: 'REJECTED',
      rejected_by: actor.actor_id,
      rejected_at: now.toISOString(),
      rejection_reason: reason,
      updated_at: now.toISOString(),
    };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE app_admin.user_access_override
            SET status='REJECTED', rejected_by=$1, rejected_at=$2,
                rejection_reason=$3, updated_at=$2
          WHERE tenant_id=$4 AND override_id=$5`,
        [actor.actor_id, after.rejected_at, reason, tenant_id, override_id],
      );
      await this.writeAudit(client, mkAudit(tenant_id, override_id, 'reject', before, after, reason, actor, now));
      await client.query('COMMIT');
      return after;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async revoke(
    tenant_id: string,
    override_id: string,
    reason: string,
    actor: ActorContext,
    now: Date,
  ): Promise<UserAccessOverride> {
    const before = await this.get(tenant_id, override_id);
    if (!before) throw new OverrideError(404, 'EWS_404_not_found', `override ${override_id} not found`);
    if (before.status !== 'ACTIVE') {
      throw new OverrideError(409, 'EWS_409_invalid_state', `only ACTIVE overrides can be revoked (status=${before.status})`);
    }
    if (!reason || reason.trim().length < 10) {
      throw new OverrideError(400, 'EWS_400_invalid_input', 'revocation_reason is required (≥ 10 chars)');
    }
    const after: UserAccessOverride = {
      ...before,
      status: 'REVOKED',
      revoked_by: actor.actor_id,
      revoked_at: now.toISOString(),
      revocation_reason: reason,
      updated_at: now.toISOString(),
    };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE app_admin.user_access_override
            SET status='REVOKED', revoked_by=$1, revoked_at=$2,
                revocation_reason=$3, updated_at=$2
          WHERE tenant_id=$4 AND override_id=$5`,
        [actor.actor_id, after.revoked_at, reason, tenant_id, override_id],
      );
      await this.writeAudit(client, mkAudit(tenant_id, override_id, 'revoke', before, after, reason, actor, now));
      await client.query('COMMIT');
      return after;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async listAuditLog(
    tenant_id: string,
    filter: { entity_id?: string; actor_id?: string; from?: string; to?: string; page?: number; page_size?: number },
  ): Promise<{ items: AdminAuditLogRow[]; total: number; page: number; page_size: number }> {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filter.page_size ?? 50));
    const where: string[] = ['tenant_id = $1'];
    const args: unknown[] = [tenant_id];
    if (filter.entity_id) { args.push(filter.entity_id); where.push(`entity_id = $${args.length}`); }
    if (filter.actor_id)  { args.push(filter.actor_id);  where.push(`actor_id = $${args.length}`); }
    if (filter.from)      { args.push(filter.from);      where.push(`created_at >= $${args.length}`); }
    if (filter.to)        { args.push(filter.to);        where.push(`created_at <= $${args.length}`); }
    const whereSql = where.join(' AND ');

    const totalRes = await this.pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM app_admin.admin_audit_log WHERE ${whereSql}`,
      args,
    );
    const total = Number(totalRes.rows[0]?.c ?? 0);

    args.push(pageSize, (page - 1) * pageSize);
    const rows = await this.pool.query(
      `SELECT * FROM app_admin.admin_audit_log
        WHERE ${whereSql}
        ORDER BY created_at DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    return {
      items: rows.rows.map(rowToAudit),
      total,
      page,
      page_size: pageSize,
    };
  }

  private async writeAudit(client: { query: (sql: string, args?: unknown[]) => Promise<unknown> }, a: AdminAuditLogRow): Promise<void> {
    await client.query(
      `INSERT INTO app_admin.admin_audit_log
         (audit_id, tenant_id, entity_type, entity_id, action, actor_id, actor_role,
          before_state, after_state, reason, request_id, ip_address, user_agent, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12::inet,$13,$14)`,
      [
        a.audit_id, a.tenant_id, a.entity_type, a.entity_id, a.action, a.actor_id, a.actor_role,
        a.before_state ? JSON.stringify(a.before_state) : null,
        a.after_state ? JSON.stringify(a.after_state) : null,
        a.reason, a.request_id, a.ip_address, a.user_agent, a.created_at,
      ],
    );
  }
}

function rowToOverride(r: Record<string, unknown>): UserAccessOverride {
  return {
    override_id: String(r.override_id),
    tenant_id: String(r.tenant_id),
    user_id: String(r.user_id),
    module_path: r.module_path as ModulePath,
    override_type: r.override_type as 'GRANT' | 'REVOKE',
    permission_type: r.permission_type as PermissionType,
    effective_from: (r.effective_from as Date).toISOString(),
    effective_till: r.effective_till ? (r.effective_till as Date).toISOString() : null,
    reason: String(r.reason),
    requires_approval: Boolean(r.requires_approval),
    status: r.status as OverrideStatus,
    created_by: String(r.created_by),
    approved_by: r.approved_by ? String(r.approved_by) : null,
    rejected_by: r.rejected_by ? String(r.rejected_by) : null,
    revoked_by: r.revoked_by ? String(r.revoked_by) : null,
    rejection_reason: r.rejection_reason ? String(r.rejection_reason) : null,
    revocation_reason: r.revocation_reason ? String(r.revocation_reason) : null,
    approval_note: r.approval_note ? String(r.approval_note) : null,
    created_at: (r.created_at as Date).toISOString(),
    updated_at: (r.updated_at as Date).toISOString(),
    approved_at: r.approved_at ? (r.approved_at as Date).toISOString() : null,
    rejected_at: r.rejected_at ? (r.rejected_at as Date).toISOString() : null,
    revoked_at: r.revoked_at ? (r.revoked_at as Date).toISOString() : null,
  };
}

function rowToAudit(r: Record<string, unknown>): AdminAuditLogRow {
  return {
    audit_id: String(r.audit_id),
    tenant_id: String(r.tenant_id),
    entity_type: r.entity_type as 'user_access_override',
    entity_id: String(r.entity_id),
    action: r.action as AdminAuditLogRow['action'],
    actor_id: String(r.actor_id),
    actor_role: String(r.actor_role),
    before_state: r.before_state ?? null,
    after_state: r.after_state ?? null,
    reason: r.reason ? String(r.reason) : null,
    request_id: r.request_id ? String(r.request_id) : null,
    ip_address: r.ip_address ? String(r.ip_address) : null,
    user_agent: r.user_agent ? String(r.user_agent) : null,
    created_at: (r.created_at as Date).toISOString(),
  };
}

/**
 * Factory: returns a PgUserAccessOverrideStore if BFF_PG_URL or
 * ADMIN_PG_URL is set, else the in-memory fallback. Mirrors
 * makeScenarioStore() / makeWebhookStore().
 */
export async function makeUserAccessOverrideStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ store: UserAccessOverrideStore; pool: Pool | null }> {
  const url = env.ADMIN_PG_URL ?? env.BFF_PG_URL;
  if (!url) return { store: new InMemoryUserAccessOverrideStore(), pool: null };
  const pool = new Pool({ connectionString: url, max: 4 });
  return { store: new PgUserAccessOverrideStore(pool), pool };
}
