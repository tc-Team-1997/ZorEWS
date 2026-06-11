// @ts-nocheck
// services/bff/__tests__/notification_channel_performance.test.ts
// T6 M10.21 — Notification channel performance comparison.

import request from 'supertest';
import { buildNotificationChannelPerformance } from '../src/notification_channel_performance';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { defaultEmailTransport, type EmailLedgerEntry } from '../src/notifications/email';
import { defaultSmsTransport, type SmsLedgerEntry } from '../src/notifications/sms';
import { defaultPushTransport, type PushLedgerEntry } from '../src/notifications/push';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function fakeApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    getRole: () => role,
    now: () => NOW,
  });
}

function makeEmailEntry(tenant_id = 'BIL', sent_at = NOW.toISOString()): EmailLedgerEntry {
  return {
    message_id: `msg-${Math.random().toString(36).slice(2)}`,
    tenant_id,
    to: ['alice@example.com'],
    subject: 'test',
    body_text: 'test',
    status: 'sent',
    sent_at,
    transport: 'stub',
    template_id: 'ALERT_RED',
  };
}

function makeSmsEntry(tenant_id = 'BIL', sent_at = NOW.toISOString()): SmsLedgerEntry {
  return {
    message_id: `msg-${Math.random().toString(36).slice(2)}`,
    tenant_id,
    to: '+254712345678',
    body: 'test',
    status: 'sent',
    sent_at,
    transport: 'stub',
    segments: 1,
    template_id: 'OTP_LOGIN',
  };
}

function makePushEntry(tenant_id = 'BIL', sent_at = NOW.toISOString()): PushLedgerEntry {
  return {
    message_id: `msg-${Math.random().toString(36).slice(2)}`,
    tenant_id,
    to: [{ device_token: 'token1', platform: 'fcm', user_id: 'user1' }],
    title: 'test',
    body: 'test',
    per_device: [{ device_token: 'token1', platform: 'fcm', status: 'sent' }],
    status: 'sent',
    sent_at,
    transport: 'stub',
    template_id: 'ALERT_RED_PUSH',
  };
}

// ─── Pure function tests ────────────────────────────────────────────────

describe('M10.21 — buildNotificationChannelPerformance — empty', () => {
  test('no sends → all zeros, null leaderboards', () => {
    const out = buildNotificationChannelPerformance('BIL', [], [], [], NOW);
    expect(out.total_sent_30d).toBe(0);
    expect(out.by_channel.email.total_sent_30d).toBe(0);
    expect(out.by_channel.sms.total_sent_30d).toBe(0);
    expect(out.by_channel.push.total_sent_30d).toBe(0);
    expect(out.busiest_channel).toBeNull();
    expect(out.quietest_channel).toBeNull();
  });
});

describe('M10.21 — email metrics', () => {
  test('single email → total_sent_30d=1, distinct_recipients_30d counted', () => {
    const out = buildNotificationChannelPerformance('BIL', [makeEmailEntry()], [], [], NOW);
    expect(out.by_channel.email.total_sent_30d).toBe(1);
    expect(out.by_channel.email.distinct_recipients_30d).toBe(1);
    expect(out.busiest_channel).toBe('email');
  });
});

describe('M10.21 — tenant scoping', () => {
  test('BANK_DEMO entries not counted for BIL', () => {
    const out = buildNotificationChannelPerformance(
      'BIL',
      [makeEmailEntry('BANK_DEMO')],
      [],
      [],
      NOW,
    );
    expect(out.total_sent_30d).toBe(0);
  });
});

describe('M10.21 — cross-channel comparison', () => {
  test('busiest = highest total, quietest = lowest', () => {
    const emails = [makeEmailEntry(), makeEmailEntry(), makeEmailEntry()];
    const smss = [makeSmsEntry()];
    const out = buildNotificationChannelPerformance('BIL', emails, smss, [], NOW);
    expect(out.busiest_channel).toBe('email');
    expect(out.total_sent_30d).toBe(4);
  });
});

describe('M10.21 — template frequency', () => {
  test('most_active_template picks most-used', () => {
    const e1 = makeEmailEntry();
    e1.template_id = 'ALERT_RED';
    const e2 = makeEmailEntry();
    e2.template_id = 'ALERT_RED';
    const e3 = makeEmailEntry();
    e3.template_id = 'SLA_BREACH';
    const out = buildNotificationChannelPerformance('BIL', [e1, e2, e3], [], [], NOW);
    expect(out.by_channel.email.most_active_template).toBe('ALERT_RED');
  });
});

describe('M10.21 — distinct recipients', () => {
  test('push deduplicates by user_id', () => {
    const p1 = makePushEntry();
    p1.to = [
      { device_token: 'tok1', platform: 'fcm', user_id: 'u1' },
      { device_token: 'tok2', platform: 'apns', user_id: 'u1' }, // same user_id → 1 distinct
    ];
    const out = buildNotificationChannelPerformance('BIL', [], [], [p1], NOW);
    expect(out.by_channel.push.distinct_recipients_30d).toBe(1);
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M10.21 — route', () => {
  test('GET /v1/notifications/channel-performance → 200', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/notifications/channel-performance')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.by_channel).toHaveProperty('email');
    expect(res.body.body.by_channel).toHaveProperty('sms');
    expect(res.body.body.by_channel).toHaveProperty('push');
  });

  test('403 for unknown role', async () => {
    const { app } = fakeApp('viewer');
    const res = await request(app)
      .get('/v1/notifications/channel-performance')
      .set(TH_BIL)
      .set('x-apex-role', 'viewer');
    expect(res.status).toBe(403);
  });

  test('400 when no tenant header', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/notifications/channel-performance')
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });
});
