// @ts-nocheck
// services/bff/__tests__/notification_channel_cost.test.ts
// T6 M10.24 — Notification channel cost estimate tests

import {
  buildNotificationChannelCostEstimate,
  EMAIL_COST_PER_SEND,
  SMS_COST_PER_SEND,
  PUSH_COST_PER_SEND,
} from '../src/notification_channel_cost';
import { StubEmailTransport } from '../src/notifications/email';
import { StubSmsTransport } from '../src/notifications/sms';
import { StubPushTransport } from '../src/notifications/push';

const NOW = new Date('2026-05-22T12:00:00.000Z');

describe('buildNotificationChannelCostEstimate — pure resolver', () => {
  test('empty transports → all costs 0, most_expensive_channel=null', () => {
    const email = new StubEmailTransport();
    const sms = new StubSmsTransport();
    const push = new StubPushTransport();
    const r = buildNotificationChannelCostEstimate(email, sms, push, 'BANK_DEMO', NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.channels.email.sends).toBe(0);
    expect(r.channels.sms.sends).toBe(0);
    expect(r.channels.push.sends).toBe(0);
    expect(r.total_monthly_estimate_usd).toBe(0);
    expect(r.most_expensive_channel).toBeNull();
  });

  test('cost constants have expected order: email << push; sms >> email', () => {
    expect(SMS_COST_PER_SEND).toBeGreaterThan(EMAIL_COST_PER_SEND);
    expect(EMAIL_COST_PER_SEND).toBeGreaterThan(PUSH_COST_PER_SEND);
  });

  test('total_monthly_estimate_usd = sum of channel projections', () => {
    const email = new StubEmailTransport();
    const sms = new StubSmsTransport();
    const push = new StubPushTransport();
    const r = buildNotificationChannelCostEstimate(email, sms, push, 'BANK_DEMO', NOW);
    const expected = r.channels.email.monthly_projection_usd +
                     r.channels.sms.monthly_projection_usd +
                     r.channels.push.monthly_projection_usd;
    expect(r.total_monthly_estimate_usd).toBeCloseTo(expected, 5);
  });

  test('generated_at matches now', () => {
    const email = new StubEmailTransport();
    const sms = new StubSmsTransport();
    const push = new StubPushTransport();
    const r = buildNotificationChannelCostEstimate(email, sms, push, 'BANK_DEMO', NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
  });

  test('tenant_id echoed correctly', () => {
    const email = new StubEmailTransport();
    const sms = new StubSmsTransport();
    const push = new StubPushTransport();
    const r = buildNotificationChannelCostEstimate(email, sms, push, 'BIL', NOW);
    expect(r.tenant_id).toBe('BIL');
  });

  test('monthly_projection_usd >= 0 for all channels', () => {
    const email = new StubEmailTransport();
    const sms = new StubSmsTransport();
    const push = new StubPushTransport();
    const r = buildNotificationChannelCostEstimate(email, sms, push, 'BANK_DEMO', NOW);
    expect(r.channels.email.monthly_projection_usd).toBeGreaterThanOrEqual(0);
    expect(r.channels.sms.monthly_projection_usd).toBeGreaterThanOrEqual(0);
    expect(r.channels.push.monthly_projection_usd).toBeGreaterThanOrEqual(0);
  });

  test('throws on empty tenant_id', () => {
    const email = new StubEmailTransport();
    const sms = new StubSmsTransport();
    const push = new StubPushTransport();
    expect(() => buildNotificationChannelCostEstimate(email, sms, push, '', NOW)).toThrow();
  });

  test('sends count 0 for empty transports (tenant isolates)', () => {
    const email = new StubEmailTransport();
    const sms = new StubSmsTransport();
    const push = new StubPushTransport();
    const r = buildNotificationChannelCostEstimate(email, sms, push, 'UNKNOWN_TENANT', NOW);
    expect(r.channels.email.sends).toBe(0);
    expect(r.channels.sms.sends).toBe(0);
    expect(r.channels.push.sends).toBe(0);
  });
});

// ─── Route tests ──────────────────────────────────────────────────────

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BIL',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('GET /v1/notifications/channel-cost-estimate', () => {
  test('admin 200 with envelope', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/notifications/channel-cost-estimate')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.channels).toBeDefined();
  });

  test('403 for field_officer', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/notifications/channel-cost-estimate')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/notifications/channel-cost-estimate')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });

  test('cross-tenant: BIL admin only sees BIL data', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/notifications/channel-cost-estimate')
      .set(HEADERS_ADMIN);
    expect(r.body.body.tenant_id).toBe('BIL');
  });
});
