// Integration tests for PgNotificationTemplateStore (T6 M14.22).
//
// Skipped when ADMIN_PG_URL/BFF_PG_URL is unset (the default — keeps
// `npm test` hermetic in CI). Run locally with the `zorews-pg`
// container up + migration 021 applied:
//
//   ADMIN_PG_URL=postgres://zorews_user:apex@localhost:55432/zorews \
//     npx jest notification_templates_store_pg
//
// TRUNCATEs app_admin.notification_templates in beforeEach so the suite
// will wipe any data you've inserted manually. By design — tests need a
// clean slate to assert on counts.

import { Pool } from 'pg';
import {
  PgNotificationTemplateStore,
  validateCreate,
} from '../src/admin/notification_templates_store';

const PG_URL = process.env.ADMIN_PG_URL ?? process.env.BFF_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

const ACTOR = { actor_id: 'alice.admin' };
const NOW1 = new Date('2026-05-09T10:00:00Z');
const NOW2 = new Date('2026-05-09T11:00:00Z');
const TENANT = 'TEST_M14_22_TPL';

describeIfPg('PgNotificationTemplateStore (integration — requires ADMIN_PG_URL)', () => {
  let pool: Pool;
  let store: PgNotificationTemplateStore;

  beforeAll(() => {
    pool = new Pool({ connectionString: PG_URL, max: 2 });
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM app_admin.notification_templates WHERE tenant_id = $1`, [TENANT]);
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM app_admin.notification_templates WHERE tenant_id = $1`, [TENANT]);
    store = new PgNotificationTemplateStore(pool);
  });

  test('create + get round-trip', async () => {
    const input = validateCreate({
      name: 'PG round-trip email',
      channel: 'EMAIL',
      subject: 'subject',
      body: 'body',
    });
    const row = await store.create(TENANT, input, ACTOR, NOW1);
    expect(row.status).toBe('DRAFT');
    expect(row.created_by).toBe('alice.admin');
    const got = await store.get(TENANT, row.template_id);
    expect(got?.name).toBe('PG round-trip email');
    expect(got?.subject).toBe('subject');
  });

  test('duplicate (tenant, lower(name), locale) → 409 via DB partial UNIQUE', async () => {
    const input = validateCreate({
      name: 'PG dup test',
      channel: 'SMS',
      body: 'b',
    });
    await store.create(TENANT, input, ACTOR, NOW1);
    await expect(
      store.create(TENANT, { ...input, name: 'pg dup test' }, ACTOR, NOW2),
    ).rejects.toMatchObject({ status: 409, code: 'EWS_409_duplicate_template_name' });
  });

  test('SMS create with non-null subject → DB CHECK rejects', async () => {
    // The validator wouldn't let this through; bypass it to confirm the
    // DB CHECK catches it as a defence-in-depth signal.
    await expect(
      pool.query(
        `INSERT INTO app_admin.notification_templates
           (tenant_id, name, channel, subject, body, locale, created_by)
         VALUES ($1, 'bad-sms-with-subject', 'SMS', 'should be null', 'b', 'en-IN', 'test')`,
        [TENANT],
      ),
    ).rejects.toMatchObject({ code: '23514' }); // CHECK violation
  });

  test('list filters by channel + status', async () => {
    await store.create(TENANT, validateCreate({ name: 'Email A', channel: 'EMAIL', subject: 's', body: 'b' }), ACTOR, NOW1);
    await store.create(TENANT, validateCreate({ name: 'SMS A', channel: 'SMS', body: 'b' }), ACTOR, NOW1);
    const sms = await store.list(TENANT, { channel: 'SMS' });
    expect(sms.total).toBe(1);
    expect(sms.items[0]!.channel).toBe('SMS');
    const drafts = await store.list(TENANT, { status: ['DRAFT'] });
    expect(drafts.total).toBe(2);
  });

  test('activate moves DRAFT → ACTIVE; idempotent', async () => {
    const row = await store.create(TENANT, validateCreate({ name: 'Activate me', channel: 'SMS', body: 'b' }), ACTOR, NOW1);
    const a1 = await store.activate(TENANT, row.template_id, ACTOR, NOW2);
    expect(a1.status).toBe('ACTIVE');
    const a2 = await store.activate(TENANT, row.template_id, ACTOR, NOW2);
    expect(a2.status).toBe('ACTIVE');
  });

  test('archive sets deleted_at + ARCHIVED; subsequent list hides it by default', async () => {
    const row = await store.create(TENANT, validateCreate({ name: 'Archive me', channel: 'SMS', body: 'b' }), ACTOR, NOW1);
    const arch = await store.archive(TENANT, row.template_id, ACTOR, NOW2);
    expect(arch.status).toBe('ARCHIVED');
    expect(arch.deleted_at).not.toBeNull();
    const visible = await store.list(TENANT, {});
    expect(visible.total).toBe(0);
    const all = await store.list(TENANT, { include_deleted: true });
    expect(all.total).toBe(1);
  });

  test('update on archived row → 409', async () => {
    const row = await store.create(TENANT, validateCreate({ name: 'Update gate', channel: 'SMS', body: 'b' }), ACTOR, NOW1);
    await store.archive(TENANT, row.template_id, ACTOR, NOW2);
    await expect(
      store.update(TENANT, row.template_id, { body: 'new' }, ACTOR, NOW2),
    ).rejects.toMatchObject({ status: 409, code: 'EWS_409_invalid_state' });
  });

  test('cross-tenant get returns null', async () => {
    const row = await store.create(TENANT, validateCreate({ name: 'Cross tenant', channel: 'SMS', body: 'b' }), ACTOR, NOW1);
    const cross = await store.get('OTHER_TENANT', row.template_id);
    expect(cross).toBeNull();
  });
});
