// services/bff/src/recovery/store.ts
//
// RecoveryStore — in-memory + pg implementations of the central
// soft-delete archive (app_recovery.deleted_records).
//
// Architecture mirrors every other BFF Pg*Store: cache-on-init,
// write-through fire-and-forget pg writes (errors logged but never
// crash the caller's flow — recovery is a side-effect, not the user's
// primary goal). The InMemoryRecoveryStore is the dev default.

import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import {
  type ArchiveInput,
  type DeletedRecord,
  type RecoveryListFilters,
  type RecoveryModule,
  type RecoveryStatus,
  RecoveryError,
} from './types';

// ─── Interface ────────────────────────────────────────────────────────

export interface RecoveryStore {
  /** Archive a row before it's deleted from its origin table.
   *  Returns the new recovery_id. */
  archive(input: ArchiveInput, now?: Date): Promise<string>;

  /** Filtered list. status defaults to 'archived'. */
  list(filters: RecoveryListFilters): Promise<{
    items: DeletedRecord[];
    total: number;
  }>;

  /** Single record by recovery_id. Tenant-scoped: returns undefined
   *  if the record belongs to another tenant. */
  get(tenant_id: string, recovery_id: string): Promise<DeletedRecord | undefined>;

  /** Mark restored. Idempotent guard at the route layer. */
  markRestored(
    tenant_id: string,
    recovery_id: string,
    restored_by: string,
    now?: Date,
  ): Promise<DeletedRecord>;

  /** Mark purged (permanent delete from origin). The recovery row is
   *  KEPT (audit-only) but flagged purged_at. */
  markPurged(
    tenant_id: string,
    recovery_id: string,
    purged_by: string,
    now?: Date,
  ): Promise<DeletedRecord>;

  /** Stats for the SPA dashboard tile + page header. */
  stats(tenant_id: string): Promise<{
    total: number;
    by_status: Record<RecoveryStatus, number>;
    by_module: Record<string, number>;
    by_entity_type: Record<string, number>;
    most_recent_at: string | null;
  }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function deriveStatus(r: {
  restored_at: string | null;
  purged_at: string | null;
}): RecoveryStatus {
  if (r.purged_at) return 'purged';
  if (r.restored_at) return 'restored';
  return 'archived';
}

function shapeRecord(
  raw: {
    recovery_id: string;
    tenant_id: string;
    module: string;
    entity_type: string;
    original_id: string;
    original_table: string;
    payload: Record<string, unknown> | unknown;
    deleted_by: string;
    deleted_at: string | Date;
    deletion_reason: string | null;
    source_action: string | null;
    prior_status: string | null;
    restored_at: string | Date | null;
    restored_by: string | null;
    purged_at: string | Date | null;
    purged_by: string | null;
  },
): DeletedRecord {
  const restored_at = toIso(raw.restored_at);
  const purged_at = toIso(raw.purged_at);
  return {
    recovery_id: raw.recovery_id,
    tenant_id: raw.tenant_id,
    module: raw.module as RecoveryModule,
    entity_type: raw.entity_type,
    original_id: raw.original_id,
    original_table: raw.original_table,
    payload: (raw.payload as Record<string, unknown>) ?? {},
    deleted_by: raw.deleted_by,
    deleted_at: toIso(raw.deleted_at) ?? new Date(0).toISOString(),
    deletion_reason: raw.deletion_reason,
    source_action: raw.source_action,
    prior_status: raw.prior_status,
    restored_at,
    restored_by: raw.restored_by,
    purged_at,
    purged_by: raw.purged_by,
    status: deriveStatus({ restored_at, purged_at }),
  };
}

function toIso(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

function applyFilters(
  rows: readonly DeletedRecord[],
  f: RecoveryListFilters,
): DeletedRecord[] {
  const status = f.status ?? 'archived';
  return rows.filter((r) => {
    if (r.tenant_id !== f.tenant_id) return false;
    if (r.status !== status) return false;
    if (f.module && r.module !== f.module) return false;
    if (f.entity_type && r.entity_type !== f.entity_type) return false;
    if (f.deleted_by && r.deleted_by !== f.deleted_by) return false;
    if (f.since && r.deleted_at < f.since) return false;
    if (f.until && r.deleted_at > f.until) return false;
    return true;
  });
}

function paginate<T>(rows: T[], page: number, page_size: number): T[] {
  return rows.slice((page - 1) * page_size, page * page_size);
}

// ─── In-memory store (dev default) ────────────────────────────────────

export class InMemoryRecoveryStore implements RecoveryStore {
  private rows: DeletedRecord[] = [];

  async archive(input: ArchiveInput, now: Date = new Date()): Promise<string> {
    if (!input.tenant_id || !input.module || !input.entity_type || !input.original_id) {
      throw new RecoveryError('invalid_input', 'missing required archive fields');
    }
    const rec: DeletedRecord = {
      recovery_id: randomUUID(),
      tenant_id: input.tenant_id,
      module: input.module,
      entity_type: input.entity_type,
      original_id: input.original_id,
      original_table: input.original_table,
      payload: input.payload,
      deleted_by: input.deleted_by,
      deleted_at: now.toISOString(),
      deletion_reason: input.deletion_reason ?? null,
      source_action: input.source_action ?? null,
      prior_status: input.prior_status ?? null,
      restored_at: null,
      restored_by: null,
      purged_at: null,
      purged_by: null,
      status: 'archived',
    };
    this.rows.push(rec);
    return rec.recovery_id;
  }

  async list(filters: RecoveryListFilters): Promise<{
    items: DeletedRecord[];
    total: number;
  }> {
    const matched = applyFilters(this.rows, filters)
      .slice()
      .sort((a, b) => (a.deleted_at < b.deleted_at ? 1 : -1));
    const page = Math.max(1, filters.page ?? 1);
    const page_size = Math.min(200, Math.max(1, filters.page_size ?? 50));
    return {
      items: paginate(matched, page, page_size),
      total: matched.length,
    };
  }

  async get(tenant_id: string, recovery_id: string): Promise<DeletedRecord | undefined> {
    return this.rows.find((r) => r.recovery_id === recovery_id && r.tenant_id === tenant_id);
  }

  async markRestored(
    tenant_id: string,
    recovery_id: string,
    restored_by: string,
    now: Date = new Date(),
  ): Promise<DeletedRecord> {
    const idx = this.rows.findIndex((r) => r.recovery_id === recovery_id && r.tenant_id === tenant_id);
    if (idx < 0) throw new RecoveryError('unknown_record', `recovery_id not found: ${recovery_id}`);
    const r = this.rows[idx];
    if (r.purged_at) throw new RecoveryError('already_purged', `record already purged`);
    if (r.restored_at) throw new RecoveryError('already_restored', `record already restored`);
    const next: DeletedRecord = {
      ...r,
      restored_at: now.toISOString(),
      restored_by,
      status: 'restored',
    };
    this.rows[idx] = next;
    return next;
  }

  async markPurged(
    tenant_id: string,
    recovery_id: string,
    purged_by: string,
    now: Date = new Date(),
  ): Promise<DeletedRecord> {
    const idx = this.rows.findIndex((r) => r.recovery_id === recovery_id && r.tenant_id === tenant_id);
    if (idx < 0) throw new RecoveryError('unknown_record', `recovery_id not found: ${recovery_id}`);
    const r = this.rows[idx];
    if (r.purged_at) throw new RecoveryError('already_purged', `record already purged`);
    if (r.restored_at)
      throw new RecoveryError(
        'invalid_status_transition',
        'cannot purge an already-restored record',
      );
    const next: DeletedRecord = {
      ...r,
      purged_at: now.toISOString(),
      purged_by,
      status: 'purged',
    };
    this.rows[idx] = next;
    return next;
  }

  async stats(tenant_id: string): Promise<{
    total: number;
    by_status: Record<RecoveryStatus, number>;
    by_module: Record<string, number>;
    by_entity_type: Record<string, number>;
    most_recent_at: string | null;
  }> {
    const mine = this.rows.filter((r) => r.tenant_id === tenant_id);
    const by_status: Record<RecoveryStatus, number> = {
      archived: 0,
      restored: 0,
      purged: 0,
    };
    const by_module: Record<string, number> = {};
    const by_entity_type: Record<string, number> = {};
    let most_recent_at: string | null = null;
    for (const r of mine) {
      by_status[r.status] += 1;
      by_module[r.module] = (by_module[r.module] ?? 0) + 1;
      by_entity_type[r.entity_type] = (by_entity_type[r.entity_type] ?? 0) + 1;
      if (!most_recent_at || r.deleted_at > most_recent_at) most_recent_at = r.deleted_at;
    }
    return { total: mine.length, by_status, by_module, by_entity_type, most_recent_at };
  }

  /** Test helper. Production stores wouldn't expose this. */
  _reset() {
    this.rows = [];
  }
}

// ─── Pg-backed store ──────────────────────────────────────────────────

export class PgRecoveryStore implements RecoveryStore {
  constructor(private pool: Pool) {}

  async archive(input: ArchiveInput, now: Date = new Date()): Promise<string> {
    if (!input.tenant_id || !input.module || !input.entity_type || !input.original_id) {
      throw new RecoveryError('invalid_input', 'missing required archive fields');
    }
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO app_recovery.deleted_records
         (recovery_id, tenant_id, module, entity_type, original_id, original_table,
          payload, deleted_by, deleted_at, deletion_reason, source_action, prior_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        input.tenant_id,
        input.module,
        input.entity_type,
        input.original_id,
        input.original_table,
        JSON.stringify(input.payload),
        input.deleted_by,
        now.toISOString(),
        input.deletion_reason ?? null,
        input.source_action ?? null,
        input.prior_status ?? null,
      ],
    );
    return id;
  }

  async list(filters: RecoveryListFilters): Promise<{
    items: DeletedRecord[];
    total: number;
  }> {
    const status = filters.status ?? 'archived';
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [filters.tenant_id];
    let idx = 2;

    if (status === 'archived') {
      conditions.push('restored_at IS NULL AND purged_at IS NULL');
    } else if (status === 'restored') {
      conditions.push('restored_at IS NOT NULL');
    } else if (status === 'purged') {
      conditions.push('purged_at IS NOT NULL');
    }
    if (filters.module) {
      conditions.push(`module = $${idx++}`);
      params.push(filters.module);
    }
    if (filters.entity_type) {
      conditions.push(`entity_type = $${idx++}`);
      params.push(filters.entity_type);
    }
    if (filters.deleted_by) {
      conditions.push(`deleted_by = $${idx++}`);
      params.push(filters.deleted_by);
    }
    if (filters.since) {
      conditions.push(`deleted_at >= $${idx++}`);
      params.push(filters.since);
    }
    if (filters.until) {
      conditions.push(`deleted_at <= $${idx++}`);
      params.push(filters.until);
    }
    const where = conditions.join(' AND ');

    const page = Math.max(1, filters.page ?? 1);
    const page_size = Math.min(200, Math.max(1, filters.page_size ?? 50));
    const offset = (page - 1) * page_size;

    const countSql = `SELECT count(*)::bigint AS total FROM app_recovery.deleted_records WHERE ${where}`;
    const listSql = `SELECT * FROM app_recovery.deleted_records WHERE ${where}
                     ORDER BY deleted_at DESC, recovery_id LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(page_size, offset);

    const [countRes, listRes] = await Promise.all([
      this.pool.query(countSql, params.slice(0, params.length - 2)),
      this.pool.query(listSql, params),
    ]);

    return {
      items: listRes.rows.map(shapeRecord),
      total: Number(countRes.rows[0]?.total ?? 0),
    };
  }

  async get(tenant_id: string, recovery_id: string): Promise<DeletedRecord | undefined> {
    const res = await this.pool.query(
      `SELECT * FROM app_recovery.deleted_records WHERE tenant_id=$1 AND recovery_id=$2`,
      [tenant_id, recovery_id],
    );
    if (res.rows.length === 0) return undefined;
    return shapeRecord(res.rows[0]);
  }

  async markRestored(
    tenant_id: string,
    recovery_id: string,
    restored_by: string,
    now: Date = new Date(),
  ): Promise<DeletedRecord> {
    const existing = await this.get(tenant_id, recovery_id);
    if (!existing) throw new RecoveryError('unknown_record', `recovery_id not found: ${recovery_id}`);
    if (existing.purged_at) throw new RecoveryError('already_purged', 'record already purged');
    if (existing.restored_at)
      throw new RecoveryError('already_restored', 'record already restored');
    const res = await this.pool.query(
      `UPDATE app_recovery.deleted_records
          SET restored_at=$3, restored_by=$4
        WHERE tenant_id=$1 AND recovery_id=$2
        RETURNING *`,
      [tenant_id, recovery_id, now.toISOString(), restored_by],
    );
    return shapeRecord(res.rows[0]);
  }

  async markPurged(
    tenant_id: string,
    recovery_id: string,
    purged_by: string,
    now: Date = new Date(),
  ): Promise<DeletedRecord> {
    const existing = await this.get(tenant_id, recovery_id);
    if (!existing) throw new RecoveryError('unknown_record', `recovery_id not found: ${recovery_id}`);
    if (existing.purged_at) throw new RecoveryError('already_purged', 'record already purged');
    if (existing.restored_at)
      throw new RecoveryError(
        'invalid_status_transition',
        'cannot purge an already-restored record',
      );
    const res = await this.pool.query(
      `UPDATE app_recovery.deleted_records
          SET purged_at=$3, purged_by=$4
        WHERE tenant_id=$1 AND recovery_id=$2
        RETURNING *`,
      [tenant_id, recovery_id, now.toISOString(), purged_by],
    );
    return shapeRecord(res.rows[0]);
  }

  async stats(tenant_id: string): Promise<{
    total: number;
    by_status: Record<RecoveryStatus, number>;
    by_module: Record<string, number>;
    by_entity_type: Record<string, number>;
    most_recent_at: string | null;
  }> {
    const res = await this.pool.query(
      `SELECT
         COUNT(*)::bigint AS total,
         SUM(CASE WHEN restored_at IS NULL AND purged_at IS NULL THEN 1 ELSE 0 END)::bigint AS archived,
         SUM(CASE WHEN restored_at IS NOT NULL THEN 1 ELSE 0 END)::bigint AS restored,
         SUM(CASE WHEN purged_at IS NOT NULL THEN 1 ELSE 0 END)::bigint AS purged,
         MAX(deleted_at) AS most_recent_at
       FROM app_recovery.deleted_records WHERE tenant_id=$1`,
      [tenant_id],
    );
    const r = res.rows[0];
    const moduleRes = await this.pool.query(
      `SELECT module, COUNT(*)::bigint AS n FROM app_recovery.deleted_records
        WHERE tenant_id=$1 GROUP BY module`,
      [tenant_id],
    );
    const entityRes = await this.pool.query(
      `SELECT entity_type, COUNT(*)::bigint AS n FROM app_recovery.deleted_records
        WHERE tenant_id=$1 GROUP BY entity_type`,
      [tenant_id],
    );
    const by_module: Record<string, number> = {};
    for (const row of moduleRes.rows) by_module[row.module] = Number(row.n);
    const by_entity_type: Record<string, number> = {};
    for (const row of entityRes.rows) by_entity_type[row.entity_type] = Number(row.n);
    return {
      total: Number(r.total ?? 0),
      by_status: {
        archived: Number(r.archived ?? 0),
        restored: Number(r.restored ?? 0),
        purged: Number(r.purged ?? 0),
      },
      by_module,
      by_entity_type,
      most_recent_at: toIso(r.most_recent_at),
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────

let defaultStore: RecoveryStore = new InMemoryRecoveryStore();

export function getDefaultRecoveryStore(): RecoveryStore {
  return defaultStore;
}

/** Test + bootstrap hook — swap the default in-memory store for a
 *  pg-backed one at server startup. */
export function setDefaultRecoveryStore(store: RecoveryStore) {
  defaultStore = store;
}
