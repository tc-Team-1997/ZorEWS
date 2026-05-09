// services/bff/src/admin/case_scenario_history_store.ts
//
// Append-only history store for app_admin.case_scenario_history (T6
// M14.15 schema). Mirrors the BIGSERIAL history_id pattern of the DB
// table — the in-memory implementation hands out a monotonic counter
// per tenant.
//
// The DB table has a BEFORE UPDATE/DELETE trigger that raises
// restrict_violation. The in-memory store mirrors that contract via
// the lack of any update/delete method on the interface.

import { Pool } from 'pg';
import type {
  CaseScenarioHistoryAction,
  CaseScenarioHistoryEntry,
} from './case_scenarios_types';
import type { DiffOp } from './case_scenarios_diff';

export interface AppendCaseScenarioHistoryInput {
  scenario_id: string;
  action: CaseScenarioHistoryAction;
  diff: DiffOp[];
  after_state: Record<string, unknown>;
  performed_by: string;
}

export interface ListHistoryFilter {
  scenario_id?: string;
  page?: number;
  page_size?: number;
}

export interface ListHistoryResult {
  items: CaseScenarioHistoryEntry[];
  total: number;
  page: number;
  page_size: number;
}

export interface CaseScenarioHistoryStore {
  append(tenant_id: string, input: AppendCaseScenarioHistoryInput, now: Date): Promise<CaseScenarioHistoryEntry>;
  list(tenant_id: string, filter: ListHistoryFilter): Promise<ListHistoryResult>;
}

/** In-memory append-only implementation. */
export class InMemoryCaseScenarioHistoryStore implements CaseScenarioHistoryStore {
  private readonly rows: CaseScenarioHistoryEntry[] = [];
  private nextId = 1;

  async append(
    tenant_id: string,
    input: AppendCaseScenarioHistoryInput,
    now: Date,
  ): Promise<CaseScenarioHistoryEntry> {
    const row: CaseScenarioHistoryEntry = {
      history_id: this.nextId++,
      scenario_id: input.scenario_id,
      tenant_id,
      action: input.action,
      diff: input.diff,
      after_state: input.after_state,
      performed_by: input.performed_by,
      performed_at: now.toISOString(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async list(tenant_id: string, filter: ListHistoryFilter): Promise<ListHistoryResult> {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filter.page_size ?? 100));
    const all = this.rows
      .filter((r) => r.tenant_id === tenant_id)
      .filter((r) => !filter.scenario_id || r.scenario_id === filter.scenario_id)
      .sort((a, b) => b.history_id - a.history_id); // newest-first by serial id
    const start = (page - 1) * pageSize;
    return {
      items: all.slice(start, start + pageSize).map((r) => ({ ...r })),
      total: all.length,
      page,
      page_size: pageSize,
    };
  }
}

// ─── PG-backed implementation ────────────────────────────────────────

interface PgHistoryRow {
  history_id: string | number;
  scenario_id: string;
  tenant_id: string;
  action: string;
  diff: unknown;
  after_state: unknown;
  performed_by: string;
  performed_at: Date;
}

function rowToHistory(r: PgHistoryRow): CaseScenarioHistoryEntry {
  return {
    history_id: Number(r.history_id),
    scenario_id: String(r.scenario_id),
    tenant_id: String(r.tenant_id),
    action: r.action as CaseScenarioHistoryAction,
    diff: (r.diff as CaseScenarioHistoryEntry['diff']) ?? [],
    after_state: (r.after_state as Record<string, unknown>) ?? {},
    performed_by: String(r.performed_by),
    performed_at: (r.performed_at as Date).toISOString(),
  };
}

export class PgCaseScenarioHistoryStore implements CaseScenarioHistoryStore {
  constructor(private readonly pool: Pool) {}

  async append(
    tenant_id: string,
    input: AppendCaseScenarioHistoryInput,
    now: Date,
  ): Promise<CaseScenarioHistoryEntry> {
    const r = await this.pool.query<PgHistoryRow>(
      `INSERT INTO app_admin.case_scenario_history
         (scenario_id, tenant_id, action, diff, after_state, performed_by, performed_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       RETURNING *`,
      [
        input.scenario_id, tenant_id, input.action,
        JSON.stringify(input.diff), JSON.stringify(input.after_state),
        input.performed_by, now,
      ],
    );
    return rowToHistory(r.rows[0]!);
  }

  async list(tenant_id: string, filter: ListHistoryFilter): Promise<ListHistoryResult> {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filter.page_size ?? 100));
    const where: string[] = ['tenant_id = $1'];
    const args: unknown[] = [tenant_id];
    if (filter.scenario_id) {
      args.push(filter.scenario_id);
      where.push(`scenario_id = $${args.length}`);
    }
    const whereSql = where.join(' AND ');
    const totalRes = await this.pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM app_admin.case_scenario_history WHERE ${whereSql}`,
      args,
    );
    const total = Number(totalRes.rows[0]?.c ?? 0);
    args.push(pageSize, (page - 1) * pageSize);
    const r = await this.pool.query<PgHistoryRow>(
      `SELECT * FROM app_admin.case_scenario_history
        WHERE ${whereSql}
        ORDER BY history_id DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    return { items: r.rows.map(rowToHistory), total, page, page_size: pageSize };
  }
}

export async function makeCaseScenarioHistoryStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ store: CaseScenarioHistoryStore; pool: Pool | null }> {
  const url = env.ADMIN_PG_URL ?? env.BFF_PG_URL;
  if (!url) return { store: new InMemoryCaseScenarioHistoryStore(), pool: null };
  const pool = new Pool({ connectionString: url, max: 4 });
  return { store: new PgCaseScenarioHistoryStore(pool), pool };
}
