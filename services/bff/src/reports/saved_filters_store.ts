// services/bff/src/reports/saved_filters_store.ts
//
// Per-user saved Reports filters (BAC §3.1.8). Mirrors
// app_admin.saved_report_filters from migration 020.

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

export type ReportType = 'cases' | 'alerts' | 'snapshot' | 'rbi';

export interface SavedReportFilter {
  filter_id: string;
  tenant_id: string;
  owner_id: string;
  report_type: ReportType;
  name: string;
  filters: Record<string, unknown>;
  is_shared: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateSavedFilterInput {
  report_type: ReportType;
  name: string;
  filters: Record<string, unknown>;
  is_shared?: boolean;
  is_default?: boolean;
}

export interface UpdateSavedFilterInput {
  name?: string;
  filters?: Record<string, unknown>;
  is_shared?: boolean;
  is_default?: boolean;
}

export class SavedFilterError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'SavedFilterError';
  }
}

const REPORT_TYPES: ReportType[] = ['cases', 'alerts', 'snapshot', 'rbi'];

export function validateCreate(raw: unknown): CreateSavedFilterInput {
  if (!raw || typeof raw !== 'object') {
    throw new SavedFilterError(400, 'EWS_400_invalid_input', 'request body required');
  }
  const r = raw as Record<string, unknown>;
  if (!REPORT_TYPES.includes(r.report_type as ReportType)) {
    throw new SavedFilterError(400, 'EWS_400_invalid_input', `report_type must be one of ${REPORT_TYPES.join(',')}`);
  }
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name || name.length > 80) {
    throw new SavedFilterError(400, 'EWS_400_invalid_input', 'name must be 1–80 chars');
  }
  if (!r.filters || typeof r.filters !== 'object' || Array.isArray(r.filters)) {
    throw new SavedFilterError(400, 'EWS_400_invalid_input', 'filters must be a JSON object');
  }
  return {
    report_type: r.report_type as ReportType,
    name,
    filters: r.filters as Record<string, unknown>,
    is_shared: r.is_shared === true,
    is_default: r.is_default === true,
  };
}

export function validateUpdate(raw: unknown): UpdateSavedFilterInput {
  if (!raw || typeof raw !== 'object') {
    throw new SavedFilterError(400, 'EWS_400_invalid_input', 'request body required');
  }
  const r = raw as Record<string, unknown>;
  const out: UpdateSavedFilterInput = {};
  if (r.name !== undefined) {
    const n = typeof r.name === 'string' ? r.name.trim() : '';
    if (!n || n.length > 80) {
      throw new SavedFilterError(400, 'EWS_400_invalid_input', 'name must be 1–80 chars');
    }
    out.name = n;
  }
  if (r.filters !== undefined) {
    if (!r.filters || typeof r.filters !== 'object' || Array.isArray(r.filters)) {
      throw new SavedFilterError(400, 'EWS_400_invalid_input', 'filters must be a JSON object');
    }
    out.filters = r.filters as Record<string, unknown>;
  }
  if (r.is_shared !== undefined) out.is_shared = r.is_shared === true;
  if (r.is_default !== undefined) out.is_default = r.is_default === true;
  if (Object.keys(out).length === 0) {
    throw new SavedFilterError(400, 'EWS_400_invalid_input', 'at least one field must be provided');
  }
  return out;
}

export interface SavedFilterStore {
  list(
    tenant_id: string,
    user_id: string,
    report_type: ReportType,
  ): Promise<SavedReportFilter[]>;
  get(tenant_id: string, filter_id: string): Promise<SavedReportFilter | null>;
  create(tenant_id: string, owner_id: string, input: CreateSavedFilterInput, now: Date): Promise<SavedReportFilter>;
  update(tenant_id: string, filter_id: string, owner_id: string, patch: UpdateSavedFilterInput, now: Date): Promise<SavedReportFilter>;
  delete(tenant_id: string, filter_id: string, owner_id: string): Promise<void>;
}

// ── In-memory implementation ────────────────────────────────────────

export class InMemorySavedFilterStore implements SavedFilterStore {
  private readonly rows: SavedReportFilter[] = [];

  /** Test seeder */
  seed(...rows: SavedReportFilter[]): void {
    for (const r of rows) this.rows.push({ ...r });
  }

  async list(
    tenant_id: string,
    user_id: string,
    report_type: ReportType,
  ): Promise<SavedReportFilter[]> {
    return this.rows
      .filter((r) => r.tenant_id === tenant_id && r.report_type === report_type)
      .filter((r) => r.owner_id === user_id || r.is_shared)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((r) => ({ ...r }));
  }

  async get(tenant_id: string, filter_id: string): Promise<SavedReportFilter | null> {
    const r = this.rows.find((x) => x.tenant_id === tenant_id && x.filter_id === filter_id);
    return r ? { ...r } : null;
  }

  async create(
    tenant_id: string,
    owner_id: string,
    input: CreateSavedFilterInput,
    now: Date,
  ): Promise<SavedReportFilter> {
    if (input.is_default) this.clearDefault(tenant_id, owner_id, input.report_type);
    const ts = now.toISOString();
    const row: SavedReportFilter = {
      filter_id: randomUUID(),
      tenant_id,
      owner_id,
      report_type: input.report_type,
      name: input.name,
      filters: input.filters,
      is_shared: input.is_shared ?? false,
      is_default: input.is_default ?? false,
      created_at: ts,
      updated_at: ts,
    };
    this.rows.push(row);
    return { ...row };
  }

  async update(
    tenant_id: string,
    filter_id: string,
    owner_id: string,
    patch: UpdateSavedFilterInput,
    now: Date,
  ): Promise<SavedReportFilter> {
    const idx = this.rows.findIndex(
      (x) => x.tenant_id === tenant_id && x.filter_id === filter_id,
    );
    if (idx < 0) throw new SavedFilterError(404, 'EWS_404_not_found', `filter ${filter_id} not found`);
    const cur = this.rows[idx];
    if (cur.owner_id !== owner_id) {
      throw new SavedFilterError(403, 'EWS_403_not_owner', 'only the owner can edit a saved filter');
    }
    if (patch.is_default === true && !cur.is_default) {
      this.clearDefault(tenant_id, owner_id, cur.report_type);
    }
    const next: SavedReportFilter = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.filters !== undefined ? { filters: patch.filters } : {}),
      ...(patch.is_shared !== undefined ? { is_shared: patch.is_shared } : {}),
      ...(patch.is_default !== undefined ? { is_default: patch.is_default } : {}),
      updated_at: now.toISOString(),
    };
    this.rows[idx] = next;
    return { ...next };
  }

  async delete(tenant_id: string, filter_id: string, owner_id: string): Promise<void> {
    const idx = this.rows.findIndex(
      (x) => x.tenant_id === tenant_id && x.filter_id === filter_id,
    );
    if (idx < 0) throw new SavedFilterError(404, 'EWS_404_not_found', `filter ${filter_id} not found`);
    if (this.rows[idx].owner_id !== owner_id) {
      throw new SavedFilterError(403, 'EWS_403_not_owner', 'only the owner can delete a saved filter');
    }
    this.rows.splice(idx, 1);
  }

  private clearDefault(tenant_id: string, owner_id: string, report_type: ReportType): void {
    for (const r of this.rows) {
      if (
        r.tenant_id === tenant_id &&
        r.owner_id === owner_id &&
        r.report_type === report_type &&
        r.is_default
      ) {
        r.is_default = false;
      }
    }
  }
}

// ── PG implementation ──────────────────────────────────────────────

export class PgSavedFilterStore implements SavedFilterStore {
  constructor(private readonly pool: Pool) {}

  async list(
    tenant_id: string,
    user_id: string,
    report_type: ReportType,
  ): Promise<SavedReportFilter[]> {
    const r = await this.pool.query(
      `SELECT * FROM app_admin.saved_report_filters
        WHERE tenant_id = $1
          AND report_type = $2
          AND (owner_id = $3 OR is_shared = TRUE)
        ORDER BY updated_at DESC`,
      [tenant_id, report_type, user_id],
    );
    return r.rows.map(rowToFilter);
  }

  async get(tenant_id: string, filter_id: string): Promise<SavedReportFilter | null> {
    const r = await this.pool.query(
      `SELECT * FROM app_admin.saved_report_filters
        WHERE tenant_id = $1 AND filter_id = $2`,
      [tenant_id, filter_id],
    );
    return r.rows[0] ? rowToFilter(r.rows[0]) : null;
  }

  async create(
    tenant_id: string,
    owner_id: string,
    input: CreateSavedFilterInput,
    now: Date,
  ): Promise<SavedReportFilter> {
    const id = randomUUID();
    const ts = now.toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (input.is_default) {
        await client.query(
          `UPDATE app_admin.saved_report_filters
              SET is_default = FALSE, updated_at = $1
            WHERE tenant_id = $2 AND owner_id = $3 AND report_type = $4 AND is_default = TRUE`,
          [ts, tenant_id, owner_id, input.report_type],
        );
      }
      await client.query(
        `INSERT INTO app_admin.saved_report_filters
           (filter_id, tenant_id, owner_id, report_type, name, filters,
            is_shared, is_default, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$9)`,
        [
          id, tenant_id, owner_id, input.report_type, input.name,
          JSON.stringify(input.filters),
          input.is_shared ?? false, input.is_default ?? false,
          ts,
        ],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    const fresh = await this.get(tenant_id, id);
    if (!fresh) throw new Error('post-create read returned null');
    return fresh;
  }

  async update(
    tenant_id: string,
    filter_id: string,
    owner_id: string,
    patch: UpdateSavedFilterInput,
    now: Date,
  ): Promise<SavedReportFilter> {
    const cur = await this.get(tenant_id, filter_id);
    if (!cur) throw new SavedFilterError(404, 'EWS_404_not_found', `filter ${filter_id} not found`);
    if (cur.owner_id !== owner_id) {
      throw new SavedFilterError(403, 'EWS_403_not_owner', 'only the owner can edit a saved filter');
    }
    const ts = now.toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (patch.is_default === true && !cur.is_default) {
        await client.query(
          `UPDATE app_admin.saved_report_filters
              SET is_default = FALSE, updated_at = $1
            WHERE tenant_id = $2 AND owner_id = $3 AND report_type = $4
              AND is_default = TRUE`,
          [ts, tenant_id, owner_id, cur.report_type],
        );
      }
      await client.query(
        `UPDATE app_admin.saved_report_filters
            SET name        = COALESCE($1, name),
                filters     = COALESCE($2::jsonb, filters),
                is_shared   = COALESCE($3, is_shared),
                is_default  = COALESCE($4, is_default),
                updated_at  = $5
          WHERE tenant_id = $6 AND filter_id = $7`,
        [
          patch.name ?? null,
          patch.filters !== undefined ? JSON.stringify(patch.filters) : null,
          patch.is_shared ?? null,
          patch.is_default ?? null,
          ts,
          tenant_id, filter_id,
        ],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    const fresh = await this.get(tenant_id, filter_id);
    if (!fresh) throw new Error('post-update read returned null');
    return fresh;
  }

  async delete(tenant_id: string, filter_id: string, owner_id: string): Promise<void> {
    const cur = await this.get(tenant_id, filter_id);
    if (!cur) throw new SavedFilterError(404, 'EWS_404_not_found', `filter ${filter_id} not found`);
    if (cur.owner_id !== owner_id) {
      throw new SavedFilterError(403, 'EWS_403_not_owner', 'only the owner can delete a saved filter');
    }
    await this.pool.query(
      `DELETE FROM app_admin.saved_report_filters WHERE tenant_id=$1 AND filter_id=$2`,
      [tenant_id, filter_id],
    );
  }
}

function rowToFilter(r: Record<string, unknown>): SavedReportFilter {
  return {
    filter_id: String(r.filter_id),
    tenant_id: String(r.tenant_id),
    owner_id: String(r.owner_id),
    report_type: r.report_type as ReportType,
    name: String(r.name),
    filters: r.filters as Record<string, unknown>,
    is_shared: Boolean(r.is_shared),
    is_default: Boolean(r.is_default),
    created_at: (r.created_at as Date).toISOString(),
    updated_at: (r.updated_at as Date).toISOString(),
  };
}

export async function makeSavedFilterStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ store: SavedFilterStore; pool: Pool | null }> {
  const url = env.ADMIN_PG_URL ?? env.BFF_PG_URL;
  if (!url) return { store: new InMemorySavedFilterStore(), pool: null };
  const pool = new Pool({ connectionString: url, max: 4 });
  return { store: new PgSavedFilterStore(pool), pool };
}
