// services/regulatory-svc/cases/src/store.ts
//
// In-memory case store with NDJSON snapshot persistence. Each upsert writes
// the full record on a single line; on construction we replay the file and
// keep only the latest record per case_id. This mirrors the SmartQueue
// pattern in alerts/queue.ts — append-only on disk, mutable in memory.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool } from 'pg';
import type { Case, CaseState } from './types';
import { PgCaseStore } from './pg_store';

export interface ListFilters {
  /** T4.24 Phase 5 — tenant scope. Optional with default 'BANK_DEMO'
   *  for backward compat with pre-Phase-5 callers; the route layer
   *  passes the real tenant from X-Tenant-ID. */
  tenant_id?: string;
  state?: CaseState;
  assignee?: string;
  customer_id?: string;
  page?: number;
  pageSize?: number;
}

/** Either backend exposes the same shape — service.ts duck-types against this. */
export type ICaseStore = CaseStore | PgCaseStore;

/**
 * Build the case store based on env. CASES_PG_URL set → pg; unset → NDJSON
 * (the existing default — keeps `npm test` and the dev wizard hermetic).
 */
export async function makeCaseStore(
  env: NodeJS.ProcessEnv = process.env,
  fallbackPath?: string,
): Promise<{ store: ICaseStore; pool: Pool | null }> {
  const url = env.CASES_PG_URL;
  if (!url) {
    const p =
      fallbackPath ??
      env.APEX_CASE_STORE_PATH ??
      path.resolve(__dirname, '..', '.store', 'cases.ndjson');
    return { store: new CaseStore(p), pool: null };
  }
  const pool = new Pool({ connectionString: url, max: 4 });
  const store = new PgCaseStore(pool);
  await store.init();
  return { store, pool };
}

export { PgCaseStore };

export class CaseStore {
  private readonly cases = new Map<string, Case>();
  /** alert_id -> case_id, for idempotent create. */
  private readonly byAlert = new Map<string, string>();

  constructor(private readonly snapshotPath: string) {
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    this.replay();
  }

  private replay(): void {
    if (!fs.existsSync(this.snapshotPath)) return;
    const txt = fs.readFileSync(this.snapshotPath, 'utf8');
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try {
        const c = JSON.parse(line) as Case;
        this.cases.set(c.case_id, c);
        this.byAlert.set(c.alert_id, c.case_id);
      } catch {
        // skip corrupt line — append-only file is best-effort recoverable
      }
    }
  }

  upsert(c: Case): Case {
    // Defensive: older rows in the snapshot don't have cas_records / caps;
    // fill in empty arrays so the rest of the code never sees `undefined`.
    const normalised: Case = {
      ...c,
      cas_records: c.cas_records ?? [],
      caps: c.caps ?? [],
    };
    this.cases.set(normalised.case_id, normalised);
    this.byAlert.set(normalised.alert_id, normalised.case_id);
    fs.appendFileSync(this.snapshotPath, JSON.stringify(normalised) + '\n', { encoding: 'utf8' });
    return normalised;
  }

  get(caseId: string, tenant_id: string = 'BANK_DEMO'): Case | undefined {
    const c = this.cases.get(caseId);
    // Pre-Phase-5 rows that exist in the snapshot but lack tenant_id
    // are treated as belonging to BANK_DEMO (the default). Callers that
    // pass tenant_id='BIL' won't see them.
    const t = c?.tenant_id ?? 'BANK_DEMO';
    return c && t === tenant_id ? c : undefined;
  }

  getByAlert(alertId: string, tenant_id: string = 'BANK_DEMO'): Case | undefined {
    const caseId = this.byAlert.get(alertId);
    if (!caseId) return undefined;
    const c = this.cases.get(caseId);
    const t = c?.tenant_id ?? 'BANK_DEMO';
    return c && t === tenant_id ? c : undefined;
  }

  list(f: ListFilters = {}): { items: Case[]; total: number; page: number; pageSize: number } {
    const tenant_id = f.tenant_id ?? 'BANK_DEMO';
    const all = [...this.cases.values()].filter((c) => {
      if ((c.tenant_id ?? 'BANK_DEMO') !== tenant_id) return false;
      if (f.state && c.state !== f.state) return false;
      if (f.assignee && c.assignee !== f.assignee) return false;
      if (f.customer_id && c.customer_id !== f.customer_id) return false;
      return true;
    });
    // Newest-first, tie-broken by case_id for stable ordering across runs.
    all.sort((a, b) =>
      a.updated_at === b.updated_at
        ? a.case_id.localeCompare(b.case_id)
        : a.updated_at < b.updated_at
          ? 1
          : -1,
    );
    const page = Math.max(1, f.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, f.pageSize ?? 50));
    const start = (page - 1) * pageSize;
    return { items: all.slice(start, start + pageSize), total: all.length, page, pageSize };
  }
}
