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
