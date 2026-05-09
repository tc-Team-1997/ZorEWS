// Integration tests for PgCaseScenarioHistoryStore (T6 M14.22).
//
// Verifies the append-only contract end-to-end:
//   - append() writes a JSONB-encoded diff + after_state row
//   - list() filters by scenario_id and pages newest-first
//   - the BEFORE UPDATE/DELETE trigger from migration 021 raises
//     restrict_violation when the SPA tries to mutate history
//
// Skipped when ADMIN_PG_URL/BFF_PG_URL is unset.

import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { PgCaseScenarioHistoryStore } from '../src/admin/case_scenario_history_store';
import type { DiffOp } from '../src/admin/case_scenarios_diff';

const PG_URL = process.env.ADMIN_PG_URL ?? process.env.BFF_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

const NOW1 = new Date('2026-05-09T10:00:00Z');
const NOW2 = new Date('2026-05-09T11:00:00Z');
const TENANT = 'TEST_M14_22_HIST';

describeIfPg('PgCaseScenarioHistoryStore (integration — requires ADMIN_PG_URL)', () => {
  let pool: Pool;
  let store: PgCaseScenarioHistoryStore;
  // history_id has a FK to case_scenarios — we need a real scenario row
  // to append against. Provision + tear down once for the suite.
  let scenarioId: string;
  let scenarioId2: string;
  let escalationId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 2 });
    // Need an ACTIVE escalation rule for the FK
    escalationId = randomUUID();
    await pool.query(
      `INSERT INTO app_admin.escalation_matrix
         (escalation_id, tenant_id, name, case_category, priority,
          level_1_after_minutes, level_1_role, status, created_by)
       VALUES ($1, $2, 'history-test-esc', 'fraud', 'P1', 30, 'supervisor', 'ACTIVE', 'test')`,
      [escalationId, TENANT],
    );
    scenarioId = randomUUID();
    scenarioId2 = randomUUID();
    await pool.query(
      `INSERT INTO app_admin.case_scenarios
         (scenario_id, tenant_id, name, case_category, priority,
          default_escalation_id, status, created_by)
       VALUES
         ($1, $2, 'history-test-scenario-1', 'fraud', 'P1', $3, 'DRAFT', 'test'),
         ($4, $2, 'history-test-scenario-2', 'fraud', 'P1', $3, 'DRAFT', 'test')`,
      [scenarioId, TENANT, escalationId, scenarioId2],
    );
  });
  // Tenant-scoped cleanup. case_scenario_history has a BEFORE DELETE
  // trigger (append-only); we disable it temporarily so we can DELETE
  // only this suite's tenant rows without disturbing other suites that
  // run in parallel against the same DB.
  async function deleteHistoryForTenant(): Promise<void> {
    await pool.query(`ALTER TABLE app_admin.case_scenario_history DISABLE TRIGGER trg_case_scenario_history_block_delete`);
    try {
      await pool.query(`DELETE FROM app_admin.case_scenario_history WHERE tenant_id = $1`, [TENANT]);
    } finally {
      await pool.query(`ALTER TABLE app_admin.case_scenario_history ENABLE TRIGGER trg_case_scenario_history_block_delete`);
    }
  }

  afterAll(async () => {
    await deleteHistoryForTenant();
    await pool.query(`DELETE FROM app_admin.case_scenarios WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM app_admin.escalation_matrix WHERE tenant_id = $1`, [TENANT]);
    await pool.end();
  });
  beforeEach(async () => {
    await deleteHistoryForTenant();
    store = new PgCaseScenarioHistoryStore(pool);
  });

  test('append + list round-trip with JSONB diff', async () => {
    const diff: DiffOp[] = [
      { op: 'add', path: '/name', value: 'New name' },
      { op: 'replace', path: '/priority', value: 'P1' },
    ];
    await store.append(
      TENANT,
      {
        scenario_id: scenarioId,
        action: 'create',
        diff,
        after_state: { foo: 'bar', n: 1 },
        performed_by: 'alice.admin',
      },
      NOW1,
    );
    const out = await store.list(TENANT, { scenario_id: scenarioId });
    expect(out.total).toBe(1);
    expect(out.items[0]!.action).toBe('create');
    expect(out.items[0]!.diff).toEqual(diff);
    expect(out.items[0]!.after_state).toEqual({ foo: 'bar', n: 1 });
    expect(out.items[0]!.performed_by).toBe('alice.admin');
  });

  test('list newest-first by history_id (BIGSERIAL)', async () => {
    await store.append(
      TENANT,
      { scenario_id: scenarioId, action: 'create', diff: [], after_state: {}, performed_by: 'a' },
      NOW1,
    );
    await store.append(
      TENANT,
      { scenario_id: scenarioId, action: 'update', diff: [], after_state: {}, performed_by: 'a' },
      NOW2,
    );
    const out = await store.list(TENANT, { scenario_id: scenarioId });
    expect(out.items.map((r) => r.action)).toEqual(['update', 'create']);
  });

  test('list filters by scenario_id', async () => {
    await store.append(
      TENANT,
      { scenario_id: scenarioId, action: 'create', diff: [], after_state: {}, performed_by: 'a' },
      NOW1,
    );
    await store.append(
      TENANT,
      { scenario_id: scenarioId2, action: 'create', diff: [], after_state: {}, performed_by: 'a' },
      NOW1,
    );
    expect((await store.list(TENANT, { scenario_id: scenarioId })).total).toBe(1);
    expect((await store.list(TENANT, { scenario_id: scenarioId2 })).total).toBe(1);
    expect((await store.list(TENANT, {})).total).toBe(2);
  });

  test('append-only — UPDATE on the table is blocked by trigger', async () => {
    await store.append(
      TENANT,
      { scenario_id: scenarioId, action: 'create', diff: [], after_state: {}, performed_by: 'a' },
      NOW1,
    );
    await expect(
      pool.query(
        `UPDATE app_admin.case_scenario_history SET action = 'archive' WHERE tenant_id = $1`,
        [TENANT],
      ),
    ).rejects.toMatchObject({ code: '23001' /* restrict_violation */ });
  });

  test('append-only — DELETE on the table is blocked by trigger', async () => {
    await store.append(
      TENANT,
      { scenario_id: scenarioId, action: 'create', diff: [], after_state: {}, performed_by: 'a' },
      NOW1,
    );
    await expect(
      pool.query(`DELETE FROM app_admin.case_scenario_history WHERE tenant_id = $1`, [TENANT]),
    ).rejects.toMatchObject({ code: '23001' });
  });

  test('cross-tenant list returns 0', async () => {
    await store.append(
      TENANT,
      { scenario_id: scenarioId, action: 'create', diff: [], after_state: {}, performed_by: 'a' },
      NOW1,
    );
    expect((await store.list('OTHER_TENANT', {})).total).toBe(0);
  });
});
