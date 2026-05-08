// services/bff/src/admin/sla_config_store.ts
//
// CRUD store for app_admin.sla_config — tenant-scoped, edit→supersede,
// no DELETE (archive only). The SLA Breach Matrix dashboard reader
// (services/bff/src/dashboard/sla_breach_matrix.ts) shares the same
// table but only does read; this store is the admin-write side.

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

export type Priority = 'P1' | 'P2' | 'P3' | 'P4';
export type Status = 'ACTIVE' | 'SUPERSEDED' | 'ARCHIVED';

export interface SlaConfigRow {
  sla_config_id: string;
  tenant_id: string;
  case_category: string;
  priority: Priority;
  business_unit: string | null;
  sla_target_days: number;
  status: Status;
  effective_from: string;
  effective_till: string | null;
  notes: string | null;
  created_by: string;
  updated_by: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSlaConfigInput {
  case_category: string;
  priority: Priority;
  business_unit?: string | null;
  sla_target_days: number;
  notes?: string | null;
}

export interface UpdateSlaConfigInput {
  /** Patchable fields. Identity (tenant, category, priority, BU) is fixed
   *  — to change identity, archive + create a new row. */
  sla_target_days?: number;
  notes?: string | null;
}

export interface ListFilter {
  case_category?: string;
  priority?: Priority;
  business_unit?: string | null;
  status?: Status[];
  page?: number;
  page_size?: number;
}

export interface ListResult {
  items: SlaConfigRow[];
  total: number;
  page: number;
  page_size: number;
}

export interface ActorContext {
  actor_id: string;
}

export class SlaConfigError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'SlaConfigError';
  }
}

// ── Validation (pure, no IO) ────────────────────────────────────────

function validatePriority(p: unknown): Priority {
  if (p !== 'P1' && p !== 'P2' && p !== 'P3' && p !== 'P4') {
    throw new SlaConfigError(400, 'EWS_400_invalid_input', 'priority must be P1, P2, P3, or P4');
  }
  return p;
}

function validateTarget(n: unknown): number {
  const x = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(x) || x <= 0 || x > 365) {
    throw new SlaConfigError(
      400,
      'EWS_400_invalid_input',
      'sla_target_days must be a number in (0, 365]',
    );
  }
  // Round to 2 decimals to match the DB's NUMERIC(5,2)
  return Math.round(x * 100) / 100;
}

function validateCreate(raw: unknown): Required<Omit<CreateSlaConfigInput, 'business_unit' | 'notes'>> & {
  business_unit: string | null;
  notes: string | null;
} {
  if (!raw || typeof raw !== 'object') {
    throw new SlaConfigError(400, 'EWS_400_invalid_input', 'request body required');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.case_category !== 'string' || !r.case_category.trim()) {
    throw new SlaConfigError(400, 'EWS_400_invalid_input', 'case_category required');
  }
  return {
    case_category: r.case_category.trim(),
    priority: validatePriority(r.priority),
    business_unit:
      typeof r.business_unit === 'string' && r.business_unit.trim()
        ? r.business_unit.trim()
        : null,
    sla_target_days: validateTarget(r.sla_target_days),
    notes: typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim() : null,
  };
}

function validateUpdate(raw: unknown): UpdateSlaConfigInput {
  if (!raw || typeof raw !== 'object') {
    throw new SlaConfigError(400, 'EWS_400_invalid_input', 'request body required');
  }
  const r = raw as Record<string, unknown>;
  const out: UpdateSlaConfigInput = {};
  if (r.sla_target_days !== undefined) out.sla_target_days = validateTarget(r.sla_target_days);
  if (r.notes !== undefined) {
    if (r.notes === null) {
      out.notes = null;
    } else if (typeof r.notes === 'string') {
      out.notes = r.notes.trim() || null;
    } else {
      throw new SlaConfigError(400, 'EWS_400_invalid_input', 'notes must be a string or null');
    }
  }
  if (out.sla_target_days === undefined && out.notes === undefined) {
    throw new SlaConfigError(
      400,
      'EWS_400_invalid_input',
      'at least one of sla_target_days or notes must be provided',
    );
  }
  return out;
}

// Re-export validators so the route layer can call them without
// duplicating the rules.
export { validateCreate, validateUpdate };

// ── Store interface ─────────────────────────────────────────────────

export interface SlaConfigStore {
  list(tenant_id: string, filter: ListFilter): Promise<ListResult>;
  get(tenant_id: string, id: string): Promise<SlaConfigRow | null>;
  create(tenant_id: string, input: CreateSlaConfigInput, actor: ActorContext, now: Date): Promise<SlaConfigRow>;
  /**
   * Edit by supersede: marks the existing ACTIVE row SUPERSEDED with
   * superseded_by pointing at a new ACTIVE row carrying the patched
   * values. Atomic. Returns the new ACTIVE row.
   *
   * Identity (category, priority, business_unit) is fixed — only
   * sla_target_days and notes are patchable. To rebadge identity,
   * archive + create.
   */
  supersede(
    tenant_id: string,
    id: string,
    patch: UpdateSlaConfigInput,
    actor: ActorContext,
    now: Date,
  ): Promise<SlaConfigRow>;
  /** Marks the row ARCHIVED. Idempotent: archiving an already-ARCHIVED row is a no-op. */
  archive(tenant_id: string, id: string, actor: ActorContext, now: Date): Promise<SlaConfigRow>;
}

// ── Helpers ─────────────────────────────────────────────────────────

function newRow(
  tenant_id: string,
  input: CreateSlaConfigInput,
  actor: ActorContext,
  now: Date,
): SlaConfigRow {
  const ts = now.toISOString();
  return {
    sla_config_id: randomUUID(),
    tenant_id,
    case_category: input.case_category,
    priority: input.priority,
    business_unit: input.business_unit ?? null,
    sla_target_days: input.sla_target_days,
    status: 'ACTIVE',
    effective_from: ts,
    effective_till: null,
    notes: input.notes ?? null,
    created_by: actor.actor_id,
    updated_by: null,
    superseded_by: null,
    created_at: ts,
    updated_at: ts,
  };
}

function ensureNoDuplicateActive(
  rows: SlaConfigRow[],
  tenant_id: string,
  cat: string,
  prio: Priority,
  bu: string | null,
): void {
  const dup = rows.find(
    (r) =>
      r.tenant_id === tenant_id &&
      r.case_category === cat &&
      r.priority === prio &&
      (r.business_unit ?? '') === (bu ?? '') &&
      r.status === 'ACTIVE',
  );
  if (dup) {
    throw new SlaConfigError(
      409,
      'EWS_409_duplicate_active_sla_config',
      `${tenant_id}/${cat}/${prio}/${bu ?? '*'} already has an ACTIVE row (id=${dup.sla_config_id})`,
    );
  }
}

// ── In-memory implementation (tests + dev fallback) ────────────────

export class InMemorySlaConfigStore implements SlaConfigStore {
  private readonly rows: SlaConfigRow[] = [];

  /** Test helper — deterministic seed for unit tests. */
  seed(...rows: SlaConfigRow[]): void {
    for (const r of rows) this.rows.push({ ...r });
  }

  async list(tenant_id: string, filter: ListFilter): Promise<ListResult> {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filter.page_size ?? 100));
    const all = this.rows
      .filter((r) => r.tenant_id === tenant_id)
      .filter((r) => !filter.case_category || r.case_category === filter.case_category)
      .filter((r) => !filter.priority || r.priority === filter.priority)
      .filter((r) => filter.business_unit === undefined || (r.business_unit ?? null) === (filter.business_unit ?? null))
      .filter((r) => !filter.status || filter.status.includes(r.status))
      .sort((a, b) => {
        if (a.case_category !== b.case_category) return a.case_category.localeCompare(b.case_category);
        if (a.priority !== b.priority) return a.priority.localeCompare(b.priority);
        return (b.created_at).localeCompare(a.created_at);
      });
    const start = (page - 1) * pageSize;
    return {
      items: all.slice(start, start + pageSize).map((r) => ({ ...r })),
      total: all.length,
      page,
      page_size: pageSize,
    };
  }

  async get(tenant_id: string, id: string): Promise<SlaConfigRow | null> {
    const r = this.rows.find((x) => x.tenant_id === tenant_id && x.sla_config_id === id);
    return r ? { ...r } : null;
  }

  async create(
    tenant_id: string,
    input: CreateSlaConfigInput,
    actor: ActorContext,
    now: Date,
  ): Promise<SlaConfigRow> {
    ensureNoDuplicateActive(this.rows, tenant_id, input.case_category, input.priority, input.business_unit ?? null);
    const row = newRow(tenant_id, input, actor, now);
    this.rows.push(row);
    return { ...row };
  }

  async supersede(
    tenant_id: string,
    id: string,
    patch: UpdateSlaConfigInput,
    actor: ActorContext,
    now: Date,
  ): Promise<SlaConfigRow> {
    const idx = this.rows.findIndex((x) => x.tenant_id === tenant_id && x.sla_config_id === id);
    if (idx < 0) throw new SlaConfigError(404, 'EWS_404_not_found', `sla_config ${id} not found`);
    const old = this.rows[idx];
    if (old.status !== 'ACTIVE') {
      throw new SlaConfigError(
        409,
        'EWS_409_invalid_state',
        `only ACTIVE rows can be edited (status=${old.status})`,
      );
    }
    const ts = now.toISOString();
    const next: SlaConfigRow = {
      ...old,
      sla_config_id: randomUUID(),
      sla_target_days: patch.sla_target_days ?? old.sla_target_days,
      notes: patch.notes !== undefined ? patch.notes : old.notes,
      effective_from: ts,
      created_by: actor.actor_id,
      updated_by: null,
      superseded_by: null,
      created_at: ts,
      updated_at: ts,
    };
    // Mark old as SUPERSEDED *first*, then insert new (so the partial
    // unique-active index stays valid through the swap).
    this.rows[idx] = {
      ...old,
      status: 'SUPERSEDED',
      effective_till: ts,
      superseded_by: next.sla_config_id,
      updated_by: actor.actor_id,
      updated_at: ts,
    };
    this.rows.push(next);
    return { ...next };
  }

  async archive(tenant_id: string, id: string, actor: ActorContext, now: Date): Promise<SlaConfigRow> {
    const idx = this.rows.findIndex((x) => x.tenant_id === tenant_id && x.sla_config_id === id);
    if (idx < 0) throw new SlaConfigError(404, 'EWS_404_not_found', `sla_config ${id} not found`);
    const old = this.rows[idx];
    if (old.status === 'ARCHIVED') return { ...old }; // idempotent
    if (old.status !== 'ACTIVE') {
      throw new SlaConfigError(
        409,
        'EWS_409_invalid_state',
        `cannot archive a ${old.status} row — archive only applies to ACTIVE`,
      );
    }
    const ts = now.toISOString();
    const next: SlaConfigRow = {
      ...old,
      status: 'ARCHIVED',
      effective_till: ts,
      updated_by: actor.actor_id,
      updated_at: ts,
    };
    this.rows[idx] = next;
    return { ...next };
  }
}

// ── PG-backed implementation ────────────────────────────────────────

export class PgSlaConfigStore implements SlaConfigStore {
  constructor(private readonly pool: Pool) {}

  async list(tenant_id: string, filter: ListFilter): Promise<ListResult> {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filter.page_size ?? 100));
    const where: string[] = ['tenant_id = $1'];
    const args: unknown[] = [tenant_id];
    if (filter.case_category) {
      args.push(filter.case_category);
      where.push(`case_category = $${args.length}`);
    }
    if (filter.priority) {
      args.push(filter.priority);
      where.push(`priority = $${args.length}`);
    }
    if (filter.business_unit !== undefined) {
      if (filter.business_unit === null) {
        where.push('business_unit IS NULL');
      } else {
        args.push(filter.business_unit);
        where.push(`business_unit = $${args.length}`);
      }
    }
    if (filter.status && filter.status.length > 0) {
      args.push(filter.status);
      where.push(`status = ANY($${args.length}::text[])`);
    }
    const whereSql = where.join(' AND ');

    const totalRes = await this.pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM app_admin.sla_config WHERE ${whereSql}`,
      args,
    );
    const total = Number(totalRes.rows[0]?.c ?? 0);

    args.push(pageSize, (page - 1) * pageSize);
    const r = await this.pool.query(
      `SELECT * FROM app_admin.sla_config
        WHERE ${whereSql}
        ORDER BY case_category ASC, priority ASC, created_at DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    return {
      items: r.rows.map(rowToConfig),
      total,
      page,
      page_size: pageSize,
    };
  }

  async get(tenant_id: string, id: string): Promise<SlaConfigRow | null> {
    const r = await this.pool.query(
      `SELECT * FROM app_admin.sla_config
        WHERE tenant_id = $1 AND sla_config_id = $2`,
      [tenant_id, id],
    );
    return r.rows[0] ? rowToConfig(r.rows[0]) : null;
  }

  async create(
    tenant_id: string,
    input: CreateSlaConfigInput,
    actor: ActorContext,
    now: Date,
  ): Promise<SlaConfigRow> {
    const row = newRow(tenant_id, input, actor, now);
    try {
      await this.pool.query(
        `INSERT INTO app_admin.sla_config
           (sla_config_id, tenant_id, case_category, priority, business_unit,
            sla_target_days, status, effective_from, notes, created_by,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8,$9,$7,$7)`,
        [
          row.sla_config_id, row.tenant_id, row.case_category, row.priority,
          row.business_unit, row.sla_target_days, row.effective_from,
          row.notes, row.created_by,
        ],
      );
    } catch (e) {
      // The partial unique active index throws 23505 on collision.
      const err = e as { code?: string };
      if (err?.code === '23505') {
        throw new SlaConfigError(
          409,
          'EWS_409_duplicate_active_sla_config',
          `${tenant_id}/${input.case_category}/${input.priority}/${input.business_unit ?? '*'} already has an ACTIVE row`,
        );
      }
      throw e;
    }
    return row;
  }

  async supersede(
    tenant_id: string,
    id: string,
    patch: UpdateSlaConfigInput,
    actor: ActorContext,
    now: Date,
  ): Promise<SlaConfigRow> {
    const old = await this.get(tenant_id, id);
    if (!old) throw new SlaConfigError(404, 'EWS_404_not_found', `sla_config ${id} not found`);
    if (old.status !== 'ACTIVE') {
      throw new SlaConfigError(
        409,
        'EWS_409_invalid_state',
        `only ACTIVE rows can be edited (status=${old.status})`,
      );
    }
    const ts = now.toISOString();
    const newId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Mark old as SUPERSEDED first so the partial active-index lets
      // us insert the new ACTIVE row.
      await client.query(
        `UPDATE app_admin.sla_config
            SET status='SUPERSEDED',
                effective_till=$1,
                superseded_by=$2,
                updated_by=$3,
                updated_at=$1
          WHERE tenant_id=$4 AND sla_config_id=$5`,
        [ts, newId, actor.actor_id, tenant_id, id],
      );
      await client.query(
        `INSERT INTO app_admin.sla_config
           (sla_config_id, tenant_id, case_category, priority, business_unit,
            sla_target_days, status, effective_from, notes, created_by,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8,$9,$7,$7)`,
        [
          newId, tenant_id, old.case_category, old.priority, old.business_unit,
          patch.sla_target_days ?? old.sla_target_days,
          ts,
          patch.notes !== undefined ? patch.notes : old.notes,
          actor.actor_id,
        ],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    const fresh = await this.get(tenant_id, newId);
    if (!fresh) throw new Error('post-supersede read returned null'); // unreachable
    return fresh;
  }

  async archive(tenant_id: string, id: string, actor: ActorContext, now: Date): Promise<SlaConfigRow> {
    const old = await this.get(tenant_id, id);
    if (!old) throw new SlaConfigError(404, 'EWS_404_not_found', `sla_config ${id} not found`);
    if (old.status === 'ARCHIVED') return old;
    if (old.status !== 'ACTIVE') {
      throw new SlaConfigError(
        409,
        'EWS_409_invalid_state',
        `cannot archive a ${old.status} row — archive only applies to ACTIVE`,
      );
    }
    const ts = now.toISOString();
    await this.pool.query(
      `UPDATE app_admin.sla_config
          SET status='ARCHIVED',
              effective_till=$1,
              updated_by=$2,
              updated_at=$1
        WHERE tenant_id=$3 AND sla_config_id=$4`,
      [ts, actor.actor_id, tenant_id, id],
    );
    const fresh = await this.get(tenant_id, id);
    if (!fresh) throw new Error('post-archive read returned null');
    return fresh;
  }
}

function rowToConfig(r: Record<string, unknown>): SlaConfigRow {
  return {
    sla_config_id: String(r.sla_config_id),
    tenant_id: String(r.tenant_id),
    case_category: String(r.case_category),
    priority: r.priority as Priority,
    business_unit: r.business_unit ? String(r.business_unit) : null,
    sla_target_days: Number(r.sla_target_days),
    status: r.status as Status,
    effective_from: (r.effective_from as Date).toISOString(),
    effective_till: r.effective_till ? (r.effective_till as Date).toISOString() : null,
    notes: r.notes ? String(r.notes) : null,
    created_by: String(r.created_by),
    updated_by: r.updated_by ? String(r.updated_by) : null,
    superseded_by: r.superseded_by ? String(r.superseded_by) : null,
    created_at: (r.created_at as Date).toISOString(),
    updated_at: (r.updated_at as Date).toISOString(),
  };
}

export async function makeSlaConfigStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ store: SlaConfigStore; pool: Pool | null }> {
  const url = env.ADMIN_PG_URL ?? env.BFF_PG_URL;
  if (!url) return { store: new InMemorySlaConfigStore(), pool: null };
  const pool = new Pool({ connectionString: url, max: 4 });
  return { store: new PgSlaConfigStore(pool), pool };
}
