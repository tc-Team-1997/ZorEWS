// Integration tests for PgWebhookSubscriptionStore.
//
// Skipped when BFF_PG_URL is unset (the default — keeps `npm test`
// hermetic in CI). Run locally with the `apex-ews-pg` container up:
//
//   BFF_PG_URL=postgres://apex:apex@localhost:55432/apex_ews \
//     npm test -- --testPathPattern=webhooks_pg
//
// Each test calls store.reset() in beforeEach which TRUNCATEs the two
// app_bff tables — so this suite WILL wipe any data you've put into
// app_bff.* manually. That's a feature, not a bug; tests need a clean
// table to assert on counts.

import { Pool } from 'pg';
import { PgWebhookSubscriptionStore } from '../src/webhooks/pg_store';
import type { WebhookDelivery, WebhookEventType } from '../src/webhooks/types';

const PG_URL = process.env.BFF_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

describeIfPg('PgWebhookSubscriptionStore (integration — requires BFF_PG_URL)', () => {
  let pool: Pool;
  let store: PgWebhookSubscriptionStore;

  beforeAll(() => {
    pool = new Pool({ connectionString: PG_URL, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    store = new PgWebhookSubscriptionStore(pool, () => undefined); // silence the warning logger
    await store.init();
    await store.reset();
  });

  test('create() persists to app_bff.webhook_subscriptions', async () => {
    const sub = store.create({
      tenant_id: 'BANK_DEMO',
      name: 'pg-test-1',
      url: 'https://example.test/x',
      events: ['alert.created'] as WebhookEventType[],
    });
    expect(sub.secret).toMatch(/^[0-9a-f]{64}$/);

    // Wait a beat for the fire-and-forget INSERT to land.
    await new Promise((r) => setTimeout(r, 100));

    const r = await pool.query(
      `SELECT subscription_id, name, url, events, active
         FROM app_bff.webhook_subscriptions WHERE subscription_id = $1`,
      [sub.id],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].name).toBe('pg-test-1');
    expect(r.rows[0].url).toBe('https://example.test/x');
    expect(r.rows[0].events).toEqual(['alert.created']);
    expect(r.rows[0].active).toBe(true);
  });

  test('init() rebuilds cache from app_bff after a "restart"', async () => {
    // Phase 1 — create via store A; subscription should land in pg.
    const a = store.create({
      tenant_id: 'BANK_DEMO',
      name: 'survives-restart',
      url: 'https://aml.test/x',
      events: ['alert.created'] as WebhookEventType[],
    });
    await new Promise((r) => setTimeout(r, 100));

    // Phase 2 — simulate BFF restart with a fresh store; init() must
    // rehydrate the subscription from pg.
    const fresh = new PgWebhookSubscriptionStore(pool, () => undefined);
    await fresh.init();
    const recovered = fresh.get(a.id, 'BANK_DEMO');
    expect(recovered).toBeDefined();
    expect(recovered?.name).toBe('survives-restart');
    // Secret must NOT leak via the public projection.
    expect(recovered).not.toHaveProperty('secret');
    // But internalGet still returns the secret (for the dispatcher).
    expect(fresh.internalGet(a.id)?.secret).toBe(a.secret);
  });

  test('delete() removes from cache + pg', async () => {
    const sub = store.create({
      tenant_id: 'BANK_DEMO',
      name: 'transient',
      url: 'https://x.test',
      events: ['webhook.test'] as WebhookEventType[],
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(store.delete(sub.id, 'BANK_DEMO')).toBe(true);
    expect(store.get(sub.id, 'BANK_DEMO')).toBeUndefined();

    await new Promise((r) => setTimeout(r, 100));
    const r = await pool.query(
      `SELECT 1 FROM app_bff.webhook_subscriptions WHERE subscription_id = $1`,
      [sub.id],
    );
    expect(r.rowCount).toBe(0);
  });

  test('recordDelivery() persists + bumps last_delivery_*', async () => {
    const sub = store.create({
      tenant_id: 'BANK_DEMO',
      name: 'delivery-target',
      url: 'https://x.test',
      events: ['scenario.run'] as WebhookEventType[],
    });
    await new Promise((r) => setTimeout(r, 50));

    const delivery: WebhookDelivery = {
      id: 'wd-pgtest1',
      subscription_id: sub.id,
      tenant_id: 'BANK_DEMO',
      event_type: 'scenario.run',
      payload: { gdp: -2 },
      attempts: 1,
      status: 'success',
      response_status: 200,
      response_body: 'ok',
      created_at: '2026-05-03T12:00:00.000Z',
      completed_at: '2026-05-03T12:00:01.000Z',
    };
    store.recordDelivery(delivery);

    // Cache shows it immediately
    expect(store.deliveriesFor(sub.id, 'BANK_DEMO')).toHaveLength(1);
    expect(store.get(sub.id, 'BANK_DEMO')?.last_delivery_status).toBe('success');

    await new Promise((r) => setTimeout(r, 150));

    // pg has the row + the subscription's last_delivery_* was bumped
    const dRows = await pool.query(
      `SELECT delivery_id, status, response_status FROM app_bff.webhook_deliveries
         WHERE delivery_id = $1`,
      ['wd-pgtest1'],
    );
    expect(dRows.rowCount).toBe(1);
    expect(dRows.rows[0].status).toBe('success');

    const sRows = await pool.query(
      `SELECT last_delivery_status FROM app_bff.webhook_subscriptions
         WHERE subscription_id = $1`,
      [sub.id],
    );
    expect(sRows.rows[0].last_delivery_status).toBe('success');
  });

  test('matching() returns only active subs that listen for the event', async () => {
    const a = store.create({
      tenant_id: 'BANK_DEMO',
      name: 'a',
      url: 'https://a.test',
      events: ['alert.created'] as WebhookEventType[],
    });
    const b = store.create({
      tenant_id: 'BANK_DEMO',
      name: 'b',
      url: 'https://b.test',
      events: ['scenario.run'] as WebhookEventType[],
    });
    const c = store.create({
      tenant_id: 'BANK_DEMO',
      name: 'c',
      url: 'https://c.test',
      events: ['alert.created', 'scenario.run'] as WebhookEventType[],
    });
    // Deactivate c via a direct pg UPDATE + reload to test the cache+db path.
    await new Promise((r) => setTimeout(r, 100));
    await pool.query(
      `UPDATE app_bff.webhook_subscriptions SET active = FALSE WHERE subscription_id = $1`,
      [c.id],
    );
    await store.init();

    const matches = store.matching('alert.created', 'BANK_DEMO').map((s) => s.name).sort();
    expect(matches).toEqual(['a']);
    // b doesn't listen for alert.created; c is inactive.
    expect(b).toBeDefined();
  });
});
