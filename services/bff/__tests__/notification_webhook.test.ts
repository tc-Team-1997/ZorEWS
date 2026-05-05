// services/bff/__tests__/notification_webhook.test.ts
//
// T6 M10.4 — Notification webhook channel.

import request from 'supertest';
import {
  InMemoryNotificationWebhookStore,
  WebhookChannelError,
} from '../src/notification_webhook';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-06T00:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const VALID = { name: 'BIL Slack relay', url: 'https://hooks.bil.example/relay' };

function makeWhApp(role = 'admin') {
  const store = new InMemoryNotificationWebhookStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    notificationWebhookStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

describe('Store', () => {
  test('create + list happy', () => {
    const s = new InMemoryNotificationWebhookStore();
    const sub = s.create('BIL', VALID, 'admin', NOW);
    expect(sub.webhook_id).toMatch(/^whk-/);
    expect(s.list('BIL').length).toBe(1);
  });

  test('rejects http (non-https) url', () => {
    const s = new InMemoryNotificationWebhookStore();
    expect(() =>
      s.create('BIL', { ...VALID, url: 'http://insecure.example' }, 'admin', NOW),
    ).toThrow(/https/);
  });

  test('rejects empty name', () => {
    const s = new InMemoryNotificationWebhookStore();
    expect(() => s.create('BIL', { ...VALID, name: '' }, 'admin', NOW)).toThrow(/name/);
  });

  test('duplicate_url → 409 (rejects 2nd same URL)', () => {
    const s = new InMemoryNotificationWebhookStore();
    s.create('BIL', VALID, 'admin', NOW);
    try {
      s.create('BIL', { ...VALID, name: 'different name' }, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as WebhookChannelError).code).toBe('duplicate_url');
    }
  });

  test('cap_reached after 25', () => {
    const s = new InMemoryNotificationWebhookStore();
    for (let i = 0; i < 25; i++) {
      s.create(
        'BIL',
        { name: `n-${i}`, url: `https://hook${i}.example` },
        'admin',
        NOW,
      );
    }
    expect(() =>
      s.create('BIL', { name: 'n-25', url: 'https://hook25.example' }, 'admin', NOW),
    ).toThrow(/25/);
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryNotificationWebhookStore();
    const a = s.create('BIL', VALID, 'admin', NOW);
    s.create('BANK_DEMO', VALID, 'admin', NOW);
    expect(s.get('BIL', a.webhook_id)?.webhook_id).toBe(a.webhook_id);
    expect(s.get('BANK_DEMO', a.webhook_id)).toBeNull();
  });

  test('send fans to all enabled subscriptions', () => {
    const s = new InMemoryNotificationWebhookStore();
    s.create('BIL', { name: 'a', url: 'https://a.example' }, 'admin', NOW);
    s.create('BIL', { name: 'b', url: 'https://b.example' }, 'admin', NOW);
    const out = s.send('BIL', 'alert.created', { x: 1 }, NOW);
    expect(out.length).toBe(2);
    expect(out.every((d) => d.http_status === 200)).toBe(true);
  });

  test('send skips disabled subscriptions', () => {
    const s = new InMemoryNotificationWebhookStore();
    s.create('BIL', { name: 'a', url: 'https://a.example', enabled: false }, 'admin', NOW);
    s.create('BIL', { name: 'b', url: 'https://b.example' }, 'admin', NOW);
    const out = s.send('BIL', 'alert.created', {}, NOW);
    expect(out.length).toBe(1);
  });

  test('listDeliveries newest-first', () => {
    const s = new InMemoryNotificationWebhookStore();
    const sub = s.create('BIL', VALID, 'admin', NOW);
    s.send('BIL', 'evt-1', { n: 1 }, NOW);
    s.send('BIL', 'evt-2', { n: 2 }, NOW);
    const items = s.listDeliveries('BIL', sub.webhook_id, 10);
    expect(items.length).toBe(2);
    expect(items[0]!.event_type).toBe('evt-2');
  });

  test('delete returns true on hit, false on miss', () => {
    const s = new InMemoryNotificationWebhookStore();
    const sub = s.create('BIL', VALID, 'admin', NOW);
    expect(s.delete('BIL', sub.webhook_id)).toBe(true);
    expect(s.delete('BIL', sub.webhook_id)).toBe(false);
  });
});

describe('Routes', () => {
  test('GET subscriptions 200 (empty)', async () => {
    const { app } = makeWhApp('admin');
    const r = await request(app)
      .get('/v1/notifications/webhook/subscriptions')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });

  test('POST 201 → list shows it', async () => {
    const { app } = makeWhApp('admin');
    const c = await request(app)
      .post('/v1/notifications/webhook/subscriptions')
      .set(TH_BIL)
      .send(VALID);
    expect(c.status).toBe(201);
    const list = await request(app)
      .get('/v1/notifications/webhook/subscriptions')
      .set(TH_BIL);
    expect(list.body.body.total).toBe(1);
  });

  test('POST http URL → 400', async () => {
    const { app } = makeWhApp('admin');
    const r = await request(app)
      .post('/v1/notifications/webhook/subscriptions')
      .set(TH_BIL)
      .send({ ...VALID, url: 'http://insecure.example' });
    expect(r.status).toBe(400);
  });

  test('POST duplicate_url → 409', async () => {
    const { app } = makeWhApp('admin');
    await request(app)
      .post('/v1/notifications/webhook/subscriptions')
      .set(TH_BIL)
      .send(VALID);
    const r = await request(app)
      .post('/v1/notifications/webhook/subscriptions')
      .set(TH_BIL)
      .send(VALID);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_url');
  });

  test('DELETE 204 then 404', async () => {
    const { app } = makeWhApp('admin');
    const c = await request(app)
      .post('/v1/notifications/webhook/subscriptions')
      .set(TH_BIL)
      .send(VALID);
    const id = c.body.body.webhook_id;
    const d1 = await request(app)
      .delete(`/v1/notifications/webhook/subscriptions/${id}`)
      .set(TH_BIL);
    expect(d1.status).toBe(204);
    const d2 = await request(app)
      .delete(`/v1/notifications/webhook/subscriptions/${id}`)
      .set(TH_BIL);
    expect(d2.status).toBe(404);
  });

  test('POST send fans + GET deliveries shows them', async () => {
    const { app } = makeWhApp('admin');
    const c = await request(app)
      .post('/v1/notifications/webhook/subscriptions')
      .set(TH_BIL)
      .send(VALID);
    const id = c.body.body.webhook_id;
    const send = await request(app)
      .post('/v1/notifications/webhook/send')
      .set(TH_BIL)
      .send({ event_type: 'alert.fired', payload: { ok: true } });
    expect(send.body.body.total).toBe(1);
    const list = await request(app)
      .get(`/v1/notifications/webhook/subscriptions/${id}/deliveries`)
      .set(TH_BIL);
    expect(list.body.body.total).toBe(1);
    expect(list.body.body.items[0].event_type).toBe('alert.fired');
  });

  test('POST send missing event_type → 400', async () => {
    const { app } = makeWhApp('admin');
    const r = await request(app)
      .post('/v1/notifications/webhook/send')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeWhApp('case_owner');
    const r = await request(app)
      .get('/v1/notifications/webhook/subscriptions')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });
});
