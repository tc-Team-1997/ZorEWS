// @ts-nocheck
// T6 M10.25 — Notification delivery time analysis tests.

import request from 'supertest';
import { buildNotificationDeliveryTime } from '../src/notification_delivery_time';
import { StubEmailTransport } from '../src/notifications/email';
import { StubSmsTransport } from '../src/notifications/sms';
import { StubPushTransport } from '../src/notifications/push';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
  return app;
}

describe('M10.25 — buildNotificationDeliveryTime pure', () => {
  test('returns 3 channels', () => {
    const email = new StubEmailTransport();
    const sms = new StubSmsTransport();
    const push = new StubPushTransport();
    const result = buildNotificationDeliveryTime(email, sms, push, 'BIL', NOW);
    expect(result.channels).toHaveLength(3);
    const channelNames = result.channels.map((c) => c.channel);
    expect(channelNames).toContain('email');
    expect(channelNames).toContain('sms');
    expect(channelNames).toContain('push');
  });

  test('push is typically faster than email', () => {
    const email = new StubEmailTransport();
    const sms = new StubSmsTransport();
    const push = new StubPushTransport();
    const result = buildNotificationDeliveryTime(email, sms, push, 'BIL', NOW);
    const pushStats = result.channels.find((c) => c.channel === 'push');
    const emailStats = result.channels.find((c) => c.channel === 'email');
    expect(pushStats.avg_delivery_seconds).toBeLessThan(emailStats.avg_delivery_seconds);
  });

  test('all_sla_met is boolean', () => {
    const email = new StubEmailTransport();
    const sms = new StubSmsTransport();
    const push = new StubPushTransport();
    const result = buildNotificationDeliveryTime(email, sms, push, 'BIL', NOW);
    expect(typeof result.all_sla_met).toBe('boolean');
  });

  test('fastest_channel has lowest avg delivery time', () => {
    const email = new StubEmailTransport();
    const sms = new StubSmsTransport();
    const push = new StubPushTransport();
    const result = buildNotificationDeliveryTime(email, sms, push, 'BIL', NOW);
    const fastestStats = result.channels.find((c) => c.channel === result.fastest_channel);
    const minAvg = Math.min(...result.channels.map((c) => c.avg_delivery_seconds));
    expect(fastestStats.avg_delivery_seconds).toBe(minAvg);
  });

  test('tenant_id and generated_at echoed', () => {
    const email = new StubEmailTransport();
    const sms = new StubSmsTransport();
    const push = new StubPushTransport();
    const result = buildNotificationDeliveryTime(email, sms, push, 'BIL', NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

describe('M10.25 — GET /v1/notifications/delivery-time-analysis route', () => {
  test('admin 200 with envelope', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/notifications/delivery-time-analysis').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body.channels).toHaveLength(3);
  });

  test('field_officer 403', async () => {
    const app = makeTestApp('field_officer');
    const res = await request(app).get('/v1/notifications/delivery-time-analysis').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant header → 400', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/notifications/delivery-time-analysis');
    expect(res.status).toBe(400);
  });
});
