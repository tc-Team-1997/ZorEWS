// Integration tests for PgCaseScenarioStore + makePgScenarioFkResolvers
// (T6 M14.22).
//
// Verifies the FK validation flow runs against the live
// escalation_matrix + notification_templates tables (not mocks), the
// trigger pair guard fires both at the application layer + as a
// belt-and-braces DB CHECK, the unique-name guard maps the partial
// UNIQUE 23505 to a EWS_409, and the lifecycle (activate / archive /
// restore) writes the expected history rows via the wired history store.
//
// Skipped when ADMIN_PG_URL/BFF_PG_URL is unset.

import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  PgCaseScenarioStore,
  makePgScenarioFkResolvers,
  validateCreate,
} from '../src/admin/case_scenarios_store';
import { PgCaseScenarioHistoryStore } from '../src/admin/case_scenario_history_store';

const PG_URL = process.env.ADMIN_PG_URL ?? process.env.BFF_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

const ACTOR = { actor_id: 'alice.admin' };
const NOW1 = new Date('2026-05-09T10:00:00Z');
const NOW2 = new Date('2026-05-09T11:00:00Z');
const NOW3 = new Date('2026-05-09T12:00:00Z');
const TENANT = 'TEST_M14_22_SCEN';

describeIfPg('PgCaseScenarioStore (integration — requires ADMIN_PG_URL)', () => {
  let pool: Pool;
  let store: PgCaseScenarioStore;
  let history: PgCaseScenarioHistoryStore;
  let activeEscId: string;
  let archivedEscId: string;
  let activeTplId: string;
  let archivedTplId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 2 });
    activeEscId = randomUUID();
    archivedEscId = randomUUID();
    activeTplId = randomUUID();
    archivedTplId = randomUUID();
    await pool.query(
      `INSERT INTO app_admin.escalation_matrix
         (escalation_id, tenant_id, name, case_category, priority,
          level_1_after_minutes, level_1_role, status, created_by)
       VALUES
         ($1, $2, 'sc-test-active-esc', 'fraud', 'P1', 30, 'supervisor', 'ACTIVE', 'test'),
         ($3, $2, 'sc-test-archived-esc', 'fraud', 'P1', 30, 'supervisor', 'ARCHIVED', 'test')`,
      [activeEscId, TENANT, archivedEscId],
    );
    await pool.query(
      `INSERT INTO app_admin.notification_templates
         (template_id, tenant_id, name, channel, body, status, created_by)
       VALUES
         ($1, $2, 'sc-test-active-tpl', 'SMS', 'b', 'ACTIVE', 'test'),
         ($3, $2, 'sc-test-archived-tpl', 'SMS', 'b', 'ARCHIVED', 'test')`,
      [activeTplId, TENANT, archivedTplId],
    );
    // Soft-delete the archived template so deleted_at is set
    await pool.query(
      `UPDATE app_admin.notification_templates
          SET deleted_at = now() WHERE template_id = $1`,
      [archivedTplId],
    );
  });
  // Tenant-scoped cleanup. case_scenario_history has a BEFORE DELETE
  // trigger (append-only); disable it briefly so we can DELETE only
  // this suite's tenant rows. Avoids global TRUNCATE interfering with
  // parallel PG suites.
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
    await pool.query(`DELETE FROM app_admin.notification_templates WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM app_admin.escalation_matrix WHERE tenant_id = $1`, [TENANT]);
    await pool.end();
  });
  beforeEach(async () => {
    await deleteHistoryForTenant();
    await pool.query(`DELETE FROM app_admin.case_scenarios WHERE tenant_id = $1`, [TENANT]);
    history = new PgCaseScenarioHistoryStore(pool);
    const fk = makePgScenarioFkResolvers(pool);
    store = new PgCaseScenarioStore(pool, { ...fk, history });
  });

  test('create with valid FKs writes scenario + create history entry', async () => {
    const input = validateCreate({
      name: 'PG happy scenario',
      case_category: 'fraud',
      priority: 'P1',
      trigger_indicator_id: 'FRD-001',
      trigger_threshold: 0.85,
      default_escalation_id: activeEscId,
      notification_template_id: activeTplId,
      checklist: [
        { title: 'Verify with customer', required: true },
        { title: 'Optional follow-up', required: false },
      ],
    });
    const row = await store.create(TENANT, input, ACTOR, NOW1);
    expect(row.status).toBe('DRAFT');
    expect(row.checklist).toEqual(input.checklist);
    expect(row.trigger_threshold).toBe(0.85);
    const log = await history.list(TENANT, { scenario_id: row.scenario_id });
    expect(log.items.map((e) => e.action)).toEqual(['create']);
  });

  test('FK miss (unknown escalation_id) → 400 EWS_400_invalid_fk', async () => {
    const input = validateCreate({
      name: 'PG bad esc',
      case_category: 'fraud',
      priority: 'P1',
      default_escalation_id: randomUUID(),
    });
    await expect(store.create(TENANT, input, ACTOR, NOW1)).rejects.toMatchObject({
      status: 400,
      code: 'EWS_400_invalid_fk',
    });
  });

  test('FK to ARCHIVED escalation → 400', async () => {
    const input = validateCreate({
      name: 'PG archived esc fk',
      case_category: 'fraud',
      priority: 'P1',
      default_escalation_id: archivedEscId,
    });
    await expect(store.create(TENANT, input, ACTOR, NOW1)).rejects.toMatchObject({
      status: 400,
      code: 'EWS_400_invalid_fk',
    });
  });

  test('FK to deleted notification_template → 400', async () => {
    const input = validateCreate({
      name: 'PG deleted tpl fk',
      case_category: 'fraud',
      priority: 'P1',
      default_escalation_id: activeEscId,
      notification_template_id: archivedTplId,
    });
    await expect(store.create(TENANT, input, ACTOR, NOW1)).rejects.toMatchObject({
      status: 400,
      code: 'EWS_400_invalid_fk',
    });
  });

  test('cross-tenant FK use → 400 (resolver returns null for wrong tenant)', async () => {
    // Create the scenario from a different tenant pointing at TENANT's
    // escalation_id — should fail because resolveEscalation is tenant-scoped.
    const input = validateCreate({
      name: 'PG cross-tenant fk',
      case_category: 'fraud',
      priority: 'P1',
      default_escalation_id: activeEscId,
    });
    await expect(store.create('OTHER_TENANT', input, ACTOR, NOW1)).rejects.toMatchObject({
      status: 400,
      code: 'EWS_400_invalid_fk',
    });
  });

  test('duplicate name → 409 EWS_409_duplicate_scenario_name (DB partial UNIQUE)', async () => {
    const input = validateCreate({
      name: 'PG dup scenario',
      case_category: 'fraud',
      priority: 'P1',
      default_escalation_id: activeEscId,
    });
    await store.create(TENANT, input, ACTOR, NOW1);
    await expect(
      store.create(TENANT, { ...input, name: 'pg dup scenario' }, ACTOR, NOW2),
    ).rejects.toMatchObject({ status: 409, code: 'EWS_409_duplicate_scenario_name' });
  });

  test('DB CHECK rejects half-open trigger pair (defence in depth)', async () => {
    // Bypass the application validator
    await expect(
      pool.query(
        `INSERT INTO app_admin.case_scenarios
           (tenant_id, name, case_category, priority,
            trigger_indicator_id, default_escalation_id, created_by)
         VALUES ($1, 'bad-trigger-pair', 'fraud', 'P1', 'FRD-001', $2, 'test')`,
        [TENANT, activeEscId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('lifecycle: create → update → activate → archive → restore writes 5 history entries', async () => {
    const input = validateCreate({
      name: 'PG lifecycle scenario',
      case_category: 'fraud',
      priority: 'P1',
      default_escalation_id: activeEscId,
    });
    const created = await store.create(TENANT, input, ACTOR, NOW1);
    await store.update(
      TENANT,
      created.scenario_id,
      { checklist: [{ title: 'Step 1', required: true }] },
      ACTOR,
      NOW2,
    );
    await store.activate(TENANT, created.scenario_id, ACTOR, NOW2);
    await store.archive(TENANT, created.scenario_id, ACTOR, NOW3);
    const restored = await store.restore(TENANT, created.scenario_id, ACTOR, NOW3);
    expect(restored.status).toBe('DRAFT');
    expect(restored.deleted_at).toBeNull();
    const log = await history.list(TENANT, { scenario_id: created.scenario_id });
    // Newest-first
    expect(log.items.map((e) => e.action)).toEqual([
      'restore', 'archive', 'activate', 'update', 'create',
    ]);
  });

  test('restore refuses when name was reused while archived → 409', async () => {
    const a = await store.create(
      TENANT,
      validateCreate({
        name: 'PG restore collision',
        case_category: 'fraud',
        priority: 'P1',
        default_escalation_id: activeEscId,
      }),
      ACTOR,
      NOW1,
    );
    await store.archive(TENANT, a.scenario_id, ACTOR, NOW2);
    // Create another scenario with the now-free name
    await store.create(
      TENANT,
      validateCreate({
        name: 'PG restore collision',
        case_category: 'fraud',
        priority: 'P1',
        default_escalation_id: activeEscId,
      }),
      ACTOR,
      NOW2,
    );
    // Restore the archived one — should refuse
    await expect(store.restore(TENANT, a.scenario_id, ACTOR, NOW3)).rejects.toMatchObject({
      status: 409,
      code: 'EWS_409_duplicate_scenario_name',
    });
  });

  test('list hides soft-deleted by default; include_deleted=true reveals', async () => {
    const r1 = await store.create(
      TENANT,
      validateCreate({
        name: 'List visible',
        case_category: 'fraud',
        priority: 'P1',
        default_escalation_id: activeEscId,
      }),
      ACTOR,
      NOW1,
    );
    const r2 = await store.create(
      TENANT,
      validateCreate({
        name: 'List hidden',
        case_category: 'fraud',
        priority: 'P1',
        default_escalation_id: activeEscId,
      }),
      ACTOR,
      NOW1,
    );
    await store.archive(TENANT, r2.scenario_id, ACTOR, NOW2);
    expect((await store.list(TENANT, {})).total).toBe(1);
    expect((await store.list(TENANT, { include_deleted: true })).total).toBe(2);
    void r1;
  });

  test('cross-tenant get returns null', async () => {
    const r = await store.create(
      TENANT,
      validateCreate({
        name: 'Cross tenant scenario',
        case_category: 'fraud',
        priority: 'P1',
        default_escalation_id: activeEscId,
      }),
      ACTOR,
      NOW1,
    );
    expect(await store.get('OTHER_TENANT', r.scenario_id)).toBeNull();
  });
});
