// services/bff/src/cases_unified_reader.ts
//
// B4 of v1.5+ unified.* consumer migration: pg-backed reader for the
// unified.cases view. Drives /api/cases (list) + /api/cases/:id
// (single) — replaces the HTTP proxy to cases-svc:8083 with a direct
// pg read of the same underlying app_cases.cases data (cases-svc
// writes to that table per T4.15, unified.cases joins it with
// actions/cas_records/caps/customer_360 overlay).
//
// Benefits:
//  - No HTTP hop to cases-svc → lower latency
//  - has_blocking_caps close-gate column (T4.19) surfaced for free
//  - customer_risk_level overlay from mart.customer_360 joined in SQL
//  - error handling simpler (pg pool vs. cases-svc-might-be-down)
//
// Wiring matches B1 + B2: bootstrap probes unified.cases existence + wires
// reader on AppDeps.casesReader when available; undefined → routes fall
// through to the cases-svc HTTP proxy (existing path).

import { Pool, type PoolClient } from 'pg';

// ---------------------------------------------------------------------
// Types — match what the SPA's /api/cases route already produces.
// ---------------------------------------------------------------------

/** Slim list-row shape /api/cases returns to the SPA today. */
export interface CaseListItem {
  id: string;
  alert_id: string | null;
  customer: { id: string; name: string };
  state: string;
  assignee: string | null;
  /** Minutes since case opened, floored, clamped to 0. */
  age_min: number;
  sla_status: string;
  /** v1.5 B4 — additive: surfaces T4.19 close-gate without /caps round-trip. */
  has_blocking_caps?: boolean;
  /** v1.5 B4 — additive: customer risk overlay from mart.customer_360. */
  customer_risk_level?: string | null;
}

/** Single-case detail shape /api/cases/:id returns. */
export interface CaseDetail extends CaseListItem {
  severity: string;
  rule: { id: string; name: string };
  outcome: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  loan_id: string | null;
  reason_summary: string | null;
  action_count: number;
  last_action_at: string | null;
  open_cas_count: number;
  open_cap_count: number;
}

export type CaseListFilters = {
  tenant_id: string;
  state?: string; // 'open' / 'assigned' / 'in_action' / 'monitored' / 'closed'
  assignee?: string;
  customer_id?: string;
  /** Comma-list parsed by route; values match sla_status enum. */
  sla_status?: string[];
  /** Hard LIMIT — clamped to MAX_LIMIT. */
  limit?: number;
};

export interface IUnifiedCasesReader {
  fetchList(filters: CaseListFilters): Promise<CaseListItem[]>;
  fetchOne(tenant_id: string, case_id: string): Promise<CaseDetail | null>;
}

export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 5000;

// ---------------------------------------------------------------------
// Pg implementation
// ---------------------------------------------------------------------

// Columns mirror unified.cases view DDL (T4.25 spec §5.3 + reality-correction).
const SELECT_FULL_COLS = `
  tenant_id, case_id, alert_id, customer_id, customer_name,
  severity, rule_id, rule_name, state, assignee, loan_id, reason_summary,
  outcome, sla_status, created_at, updated_at, closed_at,
  action_count, last_action_at,
  open_cas_count, open_cap_count, has_blocking_caps,
  customer_risk_level
`;

export class PgUnifiedCasesReader implements IUnifiedCasesReader {
  constructor(
    private readonly pool: Pool | PoolClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fetchList(filters: CaseListFilters): Promise<CaseListItem[]> {
    if (!filters.tenant_id || filters.tenant_id.trim() === '') {
      throw new Error('PgUnifiedCasesReader.fetchList: tenant_id required');
    }
    const lim = Math.min(
      Math.max(1, Math.floor(filters.limit ?? DEFAULT_LIMIT)),
      MAX_LIMIT,
    );
    const params: unknown[] = [filters.tenant_id];
    let where = 'WHERE tenant_id = $1';
    if (filters.state !== undefined) {
      params.push(filters.state);
      where += ` AND state = $${params.length}`;
    }
    if (filters.assignee !== undefined) {
      params.push(filters.assignee);
      where += ` AND assignee = $${params.length}`;
    }
    if (filters.customer_id !== undefined) {
      params.push(filters.customer_id);
      where += ` AND customer_id = $${params.length}`;
    }
    if (filters.sla_status && filters.sla_status.length > 0) {
      params.push(filters.sla_status);
      where += ` AND sla_status = ANY($${params.length}::text[])`;
    }
    params.push(lim);
    const sql = `
      SELECT ${SELECT_FULL_COLS}
        FROM unified.cases
        ${where}
        -- SPA expectation: newest-first by updated_at (matches the
        -- cases-svc proxy's default sort).
        ORDER BY updated_at DESC NULLS LAST, case_id ASC
        LIMIT $${params.length}
    `;
    const r = await this.pool.query(sql, params);
    const now = this.now();
    return r.rows.map((row) => rowToListItem(row, now));
  }

  async fetchOne(tenant_id: string, case_id: string): Promise<CaseDetail | null> {
    if (!tenant_id || tenant_id.trim() === '') {
      throw new Error('PgUnifiedCasesReader.fetchOne: tenant_id required');
    }
    if (!case_id || case_id.trim() === '') {
      throw new Error('PgUnifiedCasesReader.fetchOne: case_id required');
    }
    const r = await this.pool.query(
      `SELECT ${SELECT_FULL_COLS} FROM unified.cases
        WHERE tenant_id = $1 AND case_id = $2 LIMIT 1`,
      [tenant_id, case_id],
    );
    if (r.rowCount === 0) return null;
    return rowToDetail(r.rows[0], this.now());
  }
}

function ageMin(created_at: unknown, now: Date): number {
  if (created_at == null) return 0;
  const t =
    created_at instanceof Date
      ? created_at.getTime()
      : Date.parse(String(created_at));
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 60_000));
}

function dateToIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function rowToListItem(row: Record<string, unknown>, now: Date): CaseListItem {
  return {
    id: String(row.case_id),
    alert_id: row.alert_id == null ? null : String(row.alert_id),
    customer: {
      id: String(row.customer_id),
      name: String(row.customer_name ?? row.customer_id),
    },
    state: String(row.state),
    assignee: row.assignee == null ? null : String(row.assignee),
    age_min: ageMin(row.created_at, now),
    sla_status: String(row.sla_status ?? 'on_track'),
    has_blocking_caps: Boolean(row.has_blocking_caps),
    customer_risk_level:
      row.customer_risk_level == null ? null : String(row.customer_risk_level),
  };
}

function rowToDetail(row: Record<string, unknown>, now: Date): CaseDetail {
  const slim = rowToListItem(row, now);
  return {
    ...slim,
    severity: String(row.severity),
    rule: {
      id: String(row.rule_id),
      name: String(row.rule_name ?? row.rule_id),
    },
    outcome: row.outcome == null ? null : String(row.outcome),
    created_at: dateToIso(row.created_at) ?? '',
    updated_at: dateToIso(row.updated_at) ?? '',
    closed_at: dateToIso(row.closed_at),
    loan_id: row.loan_id == null ? null : String(row.loan_id),
    reason_summary:
      row.reason_summary == null ? null : String(row.reason_summary),
    action_count: Number(row.action_count ?? 0),
    last_action_at: dateToIso(row.last_action_at),
    open_cas_count: Number(row.open_cas_count ?? 0),
    open_cap_count: Number(row.open_cap_count ?? 0),
  };
}

// ---------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------

export async function makeUnifiedCasesReader(
  pool: Pool | PoolClient | null | undefined,
): Promise<IUnifiedCasesReader | undefined> {
  if (!pool) return undefined;
  try {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.views
        WHERE table_schema = 'unified' AND table_name = 'cases' LIMIT 1`,
    );
    if (r.rowCount === 1) return new PgUnifiedCasesReader(pool);
    return undefined;
  } catch {
    return undefined;
  }
}

export async function makeUnifiedCasesReaderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<IUnifiedCasesReader | undefined> {
  const url = env.BFF_PG_URL ?? env.ADMIN_PG_URL;
  if (!url) return undefined;
  const pool = new Pool({ connectionString: url, max: 2 });
  return makeUnifiedCasesReader(pool);
}

// ---------------------------------------------------------------------
// Test stub
// ---------------------------------------------------------------------

export class InMemoryUnifiedCasesReader implements IUnifiedCasesReader {
  constructor(private readonly details: CaseDetail[]) {}
  async fetchList(filters: CaseListFilters): Promise<CaseListItem[]> {
    const lim = Math.min(
      Math.max(1, Math.floor(filters.limit ?? DEFAULT_LIMIT)),
      MAX_LIMIT,
    );
    let rows = this.details;
    if (filters.state !== undefined) rows = rows.filter((r) => r.state === filters.state);
    if (filters.assignee !== undefined) rows = rows.filter((r) => r.assignee === filters.assignee);
    if (filters.customer_id !== undefined)
      rows = rows.filter((r) => r.customer.id === filters.customer_id);
    if (filters.sla_status && filters.sla_status.length > 0) {
      const set = new Set(filters.sla_status);
      rows = rows.filter((r) => set.has(r.sla_status));
    }
    return rows.slice(0, lim).map(
      ({ severity, rule, outcome, created_at, updated_at, closed_at, loan_id,
         reason_summary, action_count, last_action_at, open_cas_count,
         open_cap_count, ...slim }) => slim,
    );
  }
  async fetchOne(_tenant_id: string, case_id: string): Promise<CaseDetail | null> {
    return this.details.find((r) => r.id === case_id) ?? null;
  }
}
