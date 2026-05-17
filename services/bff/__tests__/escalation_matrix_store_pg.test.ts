// Integration tests for PgEscalationMatrixStore (T6 M14.22).
//
// Skipped when ADMIN_PG_URL/BFF_PG_URL is unset. Run locally:
//
//   ADMIN_PG_URL=postgres://zorews_user:apex@localhost:55432/zorews \
//     npx jest escalation_matrix_store_pg
//
// TRUNCATEs only TEST_M14_22 tenant rows so the live BANK_DEMO/BIL
// fixtures are untouched.

import { Pool } from 'pg';
import {
  PgEscalationMatrixStore,
  validateCreate,
} from '../src/admin/escalation_matrix_store';

const PG_URL = process.env.ADMIN_PG_URL ?? process.env.BFF_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

const ACTOR = { actor_id: 'alice.admin' };
const NOW1 = new Date('2026-05-09T10:00:00Z');
const NOW2 = new Date('2026-05-09T11:00:00Z');
const TENANT = 'TEST_M14_22_ESC';

describeIfPg('PgEscalationMatrixStore (integration — requires ADMIN_PG_URL)', () => {
  let pool: Pool;
  let store: PgEscalationMatrixStore;

  beforeAll(() => {
    pool = new Pool({ connectionString: PG_URL, max: 2 });
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM app_admin.escalation_matrix WHERE tenant_id = $1`, [TENANT]);
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM app_admin.escalation_matrix WHERE tenant_id = $1`, [TENANT]);
    store = new PgEscalationMatrixStore(pool);
  });

  test('create + get round-trip (3-level)', async () => {
    const input = validateCreate({
      name: 'PG fast-escalate',
      case_category: 'fraud',
      priority: 'P1',
      level_1_after_minutes: 15,
      level_1_role: 'supervisor',
      level_2_after_minutes: 60,
      level_2_role: 'risk_analyst',
      level_3_after_minutes: 240,
      level_3_role: 'admin',
    });
    const row = await store.create(TENANT, input, ACTOR, NOW1);
    expect(row.status).toBe('ACTIVE');
    expect(row.level_3_after_minutes).toBe(240);
    const got = await store.get(TENANT, row.escalation_id);
    expect(got?.level_2_role).toBe('risk_analyst');
  });

  test('create + get round-trip (single-level)', async () => {
    const input = validateCreate({
      name: 'PG single level',
      case_category: 'kyc',
      priority: 'P3',
      level_1_after_minutes: 480,
      level_1_role: 'supervisor',
    });
    const row = await store.create(TENANT, input, ACTOR, NOW1);
    expect(row.level_2_after_minutes).toBeNull();
    expect(row.level_3_role).toBeNull();
  });

  test('duplicate name → 409 via DB UNIQUE', async () => {
    const input = validateCreate({
      name: 'PG dup name',
      case_category: 'fraud',
      priority: 'P1',
      level_1_after_minutes: 30,
      level_1_role: 'supervisor',
    });
    await store.create(TENANT, input, ACTOR, NOW1);
    await expect(
      store.create(TENANT, { ...input, name: 'pg dup name' }, ACTOR, NOW2),
    ).rejects.toMatchObject({ status: 409, code: 'EWS_409_duplicate_escalation_name' });
  });

  test('DB CHECK rejects level_2 minutes <= level_1 minutes', async () => {
    // Bypass the validator to confirm the DB CHECK catches it.
    await expect(
      pool.query(
        `INSERT INTO app_admin.escalation_matrix
           (tenant_id, name, case_category, priority,
            level_1_after_minutes, level_1_role,
            level_2_after_minutes, level_2_role,
            created_by)
         VALUES ($1, 'bad-l2-ordering', 'fraud', 'P1',
                 60, 'supervisor', 30, 'risk_analyst', 'test')`,
        [TENANT],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('DB CHECK rejects level_2 minutes set without role (paired-column)', async () => {
    await expect(
      pool.query(
        `INSERT INTO app_admin.escalation_matrix
           (tenant_id, name, case_category, priority,
            level_1_after_minutes, level_1_role,
            level_2_after_minutes,
            created_by)
         VALUES ($1, 'bad-l2-half-open', 'fraud', 'P1',
                 60, 'supervisor', 120, 'test')`,
        [TENANT],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('DB CHECK rejects level_3 set without level_2', async () => {
    await expect(
      pool.query(
        `INSERT INTO app_admin.escalation_matrix
           (tenant_id, name, case_category, priority,
            level_1_after_minutes, level_1_role,
            level_3_after_minutes, level_3_role,
            created_by)
         VALUES ($1, 'bad-l3-no-l2', 'fraud', 'P1',
                 60, 'supervisor', 240, 'admin', 'test')`,
        [TENANT],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('resolveFor returns the most-recently-updated ACTIVE rule for (category, priority)', async () => {
    await store.create(
      TENANT,
      validateCreate({
        name: 'Older fraud P1',
        case_category: 'fraud',
        priority: 'P1',
        level_1_after_minutes: 30,
        level_1_role: 'supervisor',
      }),
      ACTOR,
      NOW1,
    );
    const newer = await store.create(
      TENANT,
      validateCreate({
        name: 'Newer fraud P1',
        case_category: 'fraud',
        priority: 'P1',
        level_1_after_minutes: 15,
        level_1_role: 'supervisor',
      }),
      ACTOR,
      NOW2,
    );
    const got = await store.resolveFor(TENANT, 'fraud', 'P1');
    expect(got?.escalation_id).toBe(newer.escalation_id);
  });

  test('resolveFor ignores ARCHIVED rules', async () => {
    const row = await store.create(
      TENANT,
      validateCreate({
        name: 'Will archive',
        case_category: 'kyc',
        priority: 'P3',
        level_1_after_minutes: 480,
        level_1_role: 'supervisor',
      }),
      ACTOR,
      NOW1,
    );
    await store.archive(TENANT, row.escalation_id, ACTOR, NOW2);
    expect(await store.resolveFor(TENANT, 'kyc', 'P3')).toBeNull();
  });

  test('update merges patch + re-validates chain (DB CHECK catches inverted ordering)', async () => {
    const row = await store.create(
      TENANT,
      validateCreate({
        name: 'Mergeable',
        case_category: 'fraud',
        priority: 'P1',
        level_1_after_minutes: 15,
        level_1_role: 'supervisor',
        level_2_after_minutes: 60,
        level_2_role: 'risk_analyst',
      }),
      ACTOR,
      NOW1,
    );
    // Bumping level_1 to 100 inverts the chain — caught by store-level
    // re-validation (throws CaseScenarioError-like, not DB).
    await expect(
      store.update(TENANT, row.escalation_id, { level_1_after_minutes: 100 }, ACTOR, NOW2),
    ).rejects.toThrow(/level_2_after_minutes must be greater than level_1_after_minutes/);
  });

  test('update can clear level_2 + level_3 (set to null)', async () => {
    const row = await store.create(
      TENANT,
      validateCreate({
        name: 'Can-clear',
        case_category: 'fraud',
        priority: 'P1',
        level_1_after_minutes: 15,
        level_1_role: 'supervisor',
        level_2_after_minutes: 60,
        level_2_role: 'risk_analyst',
        level_3_after_minutes: 240,
        level_3_role: 'admin',
      }),
      ACTOR,
      NOW1,
    );
    const updated = await store.update(
      TENANT,
      row.escalation_id,
      {
        level_2_after_minutes: null,
        level_2_role: null,
        level_3_after_minutes: null,
        level_3_role: null,
      },
      ACTOR,
      NOW2,
    );
    expect(updated.level_2_after_minutes).toBeNull();
    expect(updated.level_3_role).toBeNull();
  });

  test('archive idempotent + cannot-update-archived → 409', async () => {
    const row = await store.create(
      TENANT,
      validateCreate({
        name: 'Archive me',
        case_category: 'kyc',
        priority: 'P3',
        level_1_after_minutes: 480,
        level_1_role: 'supervisor',
      }),
      ACTOR,
      NOW1,
    );
    await store.archive(TENANT, row.escalation_id, ACTOR, NOW2);
    const again = await store.archive(TENANT, row.escalation_id, ACTOR, NOW2);
    expect(again.status).toBe('ARCHIVED');
    await expect(
      store.update(TENANT, row.escalation_id, { name: 'rename' }, ACTOR, NOW2),
    ).rejects.toMatchObject({ status: 409, code: 'EWS_409_invalid_state' });
  });

  test('cross-tenant get returns null', async () => {
    const row = await store.create(
      TENANT,
      validateCreate({
        name: 'Cross tenant',
        case_category: 'fraud',
        priority: 'P1',
        level_1_after_minutes: 15,
        level_1_role: 'supervisor',
      }),
      ACTOR,
      NOW1,
    );
    expect(await store.get('OTHER_TENANT', row.escalation_id)).toBeNull();
  });
});
