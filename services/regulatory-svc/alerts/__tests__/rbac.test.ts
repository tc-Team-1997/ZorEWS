import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { makeApp } from '../src/server';
import { OutboxProducer } from '../src/producer';
import { SmartQueue } from '../src/queue';
import { StubScoreClient } from '../src/score_client';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-alerts-rbac-'));
}

/** App factory using the *real* default getRole (header-based). */
function makeRealApp() {
  const dir = tmp();
  const producer = new OutboxProducer(path.join(dir, '.outbox'));
  const queue = new SmartQueue(path.join(dir, 'queue.ndjson'), []);
  const scoreClient = new StubScoreClient(null);
  return makeApp({ producer, queue, scoreClient });
}

const FIRING = {
  firing_id: '11111111-1111-4111-8111-111111111111',
  rule_id: 'RULE-001',
  rule_version: 1,
  customer_id: 'CUST0000001',
  indicators_fired: ['TXN-003'],
  rule_severity: 'high',
  reason: 'Test rule',
  recommended_action: 'Contact customer',
  ts: '2026-04-27T10:00:00.000Z',
};

describe('alerts — RBAC enforcement', () => {
  test('GET /healthz is unauthenticated', async () => {
    const { app } = makeRealApp();
    expect((await request(app).get('/healthz')).status).toBe(200);
  });

  test('POST /alerts/evaluate without role → 401 (admin-only producer endpoint)', async () => {
    const { app } = makeRealApp();
    const r = await request(app).post('/alerts/evaluate').send(FIRING);
    expect(r.status).toBe(401);
  });

  test('POST /alerts/evaluate with non-admin role → 403', async () => {
    const { app } = makeRealApp();
    const r = await request(app)
      .post('/alerts/evaluate')
      .set('x-apex-role', 'risk_analyst')
      .send(FIRING);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/admin only/);
  });

  test('POST /alerts/evaluate with admin → 201/200 (RBAC pass)', async () => {
    const { app } = makeRealApp();
    const r = await request(app)
      .post('/alerts/evaluate')
      .set('x-apex-role', 'admin')
      .send(FIRING);
    expect([200, 201]).toContain(r.status);
  });

  test('GET /alerts with field_officer is allowed (alerts:list)', async () => {
    const { app } = makeRealApp();
    const r = await request(app).get('/alerts').set('x-apex-role', 'field_officer');
    expect(r.status).toBe(200);
  });

  test('GET /alerts with unknown role → 403', async () => {
    const { app } = makeRealApp();
    const r = await request(app).get('/alerts').set('x-apex-role', 'ghost');
    expect(r.status).toBe(403);
  });

  test('field_officer cannot assign / ack / close alerts', async () => {
    // Seed an alert via admin first.
    const { app } = makeRealApp();
    const seed = await request(app)
      .post('/alerts/evaluate')
      .set('x-apex-role', 'admin')
      .send(FIRING);
    expect([200, 201]).toContain(seed.status);
    const alertId = seed.body.alert?.alert_id;
    expect(alertId).toBeTruthy();

    const a = await request(app)
      .post(`/alerts/${alertId}/assign`)
      .set('x-apex-role', 'field_officer')
      .send({ user_id: 'fo' });
    expect(a.status).toBe(403);

    const ack = await request(app)
      .post(`/alerts/${alertId}/ack`)
      .set('x-apex-role', 'field_officer')
      .send({});
    expect(ack.status).toBe(403);

    const c = await request(app)
      .post(`/alerts/${alertId}/close`)
      .set('x-apex-role', 'field_officer')
      .send({ outcome: 'cured' });
    expect(c.status).toBe(403);
  });

  test('risk_analyst can assign + ack + close alerts (matrix)', async () => {
    const { app } = makeRealApp();
    const seed = await request(app)
      .post('/alerts/evaluate')
      .set('x-apex-role', 'admin')
      .send(FIRING);
    const alertId = seed.body.alert?.alert_id;

    const a = await request(app)
      .post(`/alerts/${alertId}/assign`)
      .set('x-apex-role', 'risk_analyst')
      .send({ user_id: 'ra' });
    expect(a.status).toBe(200);

    const ack = await request(app)
      .post(`/alerts/${alertId}/ack`)
      .set('x-apex-role', 'risk_analyst')
      .send({});
    expect(ack.status).toBe(200);

    const c = await request(app)
      .post(`/alerts/${alertId}/close`)
      .set('x-apex-role', 'risk_analyst')
      .send({ outcome: 'cured' });
    expect(c.status).toBe(200);
  });
});
