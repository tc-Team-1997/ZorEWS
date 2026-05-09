// Integration tests for PgNotificationDispatchStore (T6 M14.24c).
//
// Skipped when ADMIN_PG_URL/BFF_PG_URL is unset. Run locally with the
// apex-ews-pg container up and migration 022 applied:
//
//   ADMIN_PG_URL=postgres://apex:apex@localhost:55432/apex_ews \
//     npx jest notification_dispatch_store_pg
//
// Uses a per-suite tenant id (TEST_M14_24_DISP) so parallel PG suites
// don't step on each other. Cleanup uses a tenant-scoped DELETE inside
// a brief DISABLE TRIGGER block — the append-only trigger blocks
// global DELETE just like the case_scenario_history pattern.

import { Pool } from 'pg';
import {
  PgNotificationDispatchStore,
  type AppendDispatchInput,
} from '../src/admin/notification_dispatch_store';

const PG_URL = process.env.ADMIN_PG_URL ?? process.env.BFF_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

const NOW1 = new Date('2026-05-09T10:00:00Z');
const NOW2 = new Date('2026-05-09T11:00:00Z');
const NOW3 = new Date('2026-05-09T12:00:00Z');
const TENANT = 'TEST_M14_24_DISP';

function mkInput(over: Partial<AppendDispatchInput> = {}): AppendDispatchInput {
  return {
    template_id: '11111111-2222-3333-4444-555555555555',
    template_name: 'Test template',
    channel: 'EMAIL',
    recipient: 'alice@example.com',
    trigger: 'admin_test_fire',
    reference: null,
    rendered_subject: 'Subject',
    rendered_body: 'Body',
    missing_vars: [],
    status: 'sent',
    status_reason: null,
    performed_by: 'alice.admin',
    ...over,
  };
}

describeIfPg('PgNotificationDispatchStore (integration — requires ADMIN_PG_URL)', () => {
  let pool: Pool;
  let store: PgNotificationDispatchStore;

  // Append-only trigger blocks DELETE; toggle it off briefly for
  // tenant-scoped cleanup so other suites running in parallel aren't
  // disturbed (avoids global TRUNCATE).
  async function deleteForTenant(): Promise<void> {
    await pool.query(
      `ALTER TABLE app_admin.notification_dispatch_log
        DISABLE TRIGGER trg_notification_dispatch_log_block_delete`,
    );
    try {
      await pool.query(
        `DELETE FROM app_admin.notification_dispatch_log WHERE tenant_id = $1`,
        [TENANT],
      );
    } finally {
      await pool.query(
        `ALTER TABLE app_admin.notification_dispatch_log
          ENABLE TRIGGER trg_notification_dispatch_log_block_delete`,
      );
    }
  }

  beforeAll(() => {
    pool = new Pool({ connectionString: PG_URL, max: 2 });
  });
  afterAll(async () => {
    await deleteForTenant();
    await pool.end();
  });
  beforeEach(async () => {
    await deleteForTenant();
    store = new PgNotificationDispatchStore(pool);
  });

  test('append + list round-trip with JSONB missing_vars', async () => {
    const e = await store.append(
      TENANT,
      mkInput({ missing_vars: ['rm_name', 'priority'] }),
      NOW1,
    );
    expect(e.status).toBe('sent');
    expect(e.missing_vars).toEqual(['rm_name', 'priority']);
    const out = await store.list(TENANT, {});
    expect(out.total).toBe(1);
    expect(out.items[0]!.dispatch_id).toBe(e.dispatch_id);
  });

  test('list returns newest-first by performed_at', async () => {
    await store.append(TENANT, mkInput({ recipient: 'old@x' }), NOW1);
    await store.append(TENANT, mkInput({ recipient: 'mid@x' }), NOW2);
    await store.append(TENANT, mkInput({ recipient: 'new@x' }), NOW3);
    const out = await store.list(TENANT, {});
    expect(out.items.map((r) => r.recipient)).toEqual(['new@x', 'mid@x', 'old@x']);
  });

  test('filter by template_id', async () => {
    const tplA = '11111111-1111-1111-1111-111111111111';
    const tplB = '22222222-2222-2222-2222-222222222222';
    await store.append(TENANT, mkInput({ template_id: tplA }), NOW1);
    await store.append(TENANT, mkInput({ template_id: tplB }), NOW2);
    const onlyA = await store.list(TENANT, { template_id: tplA });
    expect(onlyA.total).toBe(1);
    expect(onlyA.items[0]!.template_id).toBe(tplA);
  });

  test('filter by reference (case pivot)', async () => {
    await store.append(TENANT, mkInput({ reference: 'case:c-001' }), NOW1);
    await store.append(TENANT, mkInput({ reference: 'case:c-002' }), NOW2);
    await store.append(TENANT, mkInput({ reference: null }), NOW3);
    const c1 = await store.list(TENANT, { reference: 'case:c-001' });
    expect(c1.total).toBe(1);
    expect(c1.items[0]!.reference).toBe('case:c-001');
  });

  test('filter by trigger', async () => {
    await store.append(TENANT, mkInput({ trigger: 'admin_test_fire' }), NOW1);
    await store.append(TENANT, mkInput({ trigger: 'case_create_pipeline' }), NOW2);
    await store.append(TENANT, mkInput({ trigger: 'escalation_worker' }), NOW3);
    const tests = await store.list(TENANT, { trigger: 'admin_test_fire' });
    expect(tests.total).toBe(1);
    const cases = await store.list(TENANT, { trigger: 'case_create_pipeline' });
    expect(cases.total).toBe(1);
  });

  test('filter by status (CSV via array param)', async () => {
    await store.append(TENANT, mkInput({ status: 'sent' }), NOW1);
    await store.append(TENANT, mkInput({ status: 'preview' }), NOW2);
    await store.append(TENANT, mkInput({ status: 'failed' }), NOW3);
    const failed = await store.list(TENANT, { status: ['failed'] });
    expect(failed.total).toBe(1);
    const both = await store.list(TENANT, { status: ['sent', 'failed'] });
    expect(both.total).toBe(2);
  });

  test('filter by since (ISO bound)', async () => {
    await store.append(TENANT, mkInput({ recipient: 'old@x' }), NOW1);
    await store.append(TENANT, mkInput({ recipient: 'new@x' }), NOW3);
    const sinceMid = await store.list(TENANT, { since: NOW2 });
    expect(sinceMid.total).toBe(1);
    expect(sinceMid.items[0]!.recipient).toBe('new@x');
  });

  test('SMS append with NULL subject succeeds; with subject is rejected by DB CHECK', async () => {
    const sms = await store.append(
      TENANT,
      mkInput({ channel: 'SMS', rendered_subject: null }),
      NOW1,
    );
    expect(sms.channel).toBe('SMS');
    expect(sms.rendered_subject).toBeNull();
    await expect(
      pool.query(
        `INSERT INTO app_admin.notification_dispatch_log
           (tenant_id, template_id, template_name, channel, recipient,
            trigger, rendered_subject, rendered_body, status, performed_by)
         VALUES ($1, gen_random_uuid(), 'X', 'SMS', 'r', 'admin_test_fire',
                 'should be null', 'b', 'sent', 'test')`,
        [TENANT],
      ),
    ).rejects.toMatchObject({ code: '23514' /* check_violation */ });
  });

  test('append-only — UPDATE blocked by trigger (23001)', async () => {
    await store.append(TENANT, mkInput(), NOW1);
    await expect(
      pool.query(
        `UPDATE app_admin.notification_dispatch_log
            SET status = 'failed' WHERE tenant_id = $1`,
        [TENANT],
      ),
    ).rejects.toMatchObject({ code: '23001' });
  });

  test('append-only — DELETE blocked by trigger (23001)', async () => {
    await store.append(TENANT, mkInput(), NOW1);
    await expect(
      pool.query(
        `DELETE FROM app_admin.notification_dispatch_log WHERE tenant_id = $1`,
        [TENANT],
      ),
    ).rejects.toMatchObject({ code: '23001' });
  });

  test('cross-tenant list returns 0', async () => {
    await store.append(TENANT, mkInput(), NOW1);
    const cross = await store.list('OTHER_TENANT', {});
    expect(cross.total).toBe(0);
  });

  test('pagination: page_size capped at 200, page param walks the result', async () => {
    for (let i = 0; i < 5; i++) {
      await store.append(
        TENANT,
        mkInput({ recipient: `r-${i}@x` }),
        new Date(2026, 4, 9, 10, i),
      );
    }
    const p1 = await store.list(TENANT, { page: 1, page_size: 2 });
    expect(p1.items.length).toBe(2);
    expect(p1.total).toBe(5);
    const p3 = await store.list(TENANT, { page: 3, page_size: 2 });
    expect(p3.items.length).toBe(1); // 5 rows / 2 per page = 3 pages, last has 1
  });
});
