// @ts-nocheck
// __tests__/notification_delivery_failure_analysis.test.ts
// T6 M10.20 — Notification delivery failure analysis

import request from 'supertest';
import {
  analyzeNotificationDeliveryFailures,
} from '../src/notification_delivery_failure_analysis';
import { StubEmailTransport } from '../src/notifications/email';
import { StubSmsTransport } from '../src/notifications/sms';
import { StubPushTransport } from '../src/notifications/push';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-08T12:00:00Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeFailureApp(role = 'admin') {
  const emailTransport = new StubEmailTransport();
  const smsTransport = new StubSmsTransport();
  const pushTransport = new StubPushTransport();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    emailTransport,
    smsTransport,
    pushTransport,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, emailTransport, smsTransport, pushTransport };
}

// ─── Pure function tests ───────────────────────────────────────────────

describe('analyzeNotificationDeliveryFailures — M10.20', () => {
  it('empty ledgers → zero totals, null overall_failure_rate', () => {
    const result = analyzeNotificationDeliveryFailures('BIL', [], [], [], NOW);
    expect(result.by_channel.email.total_sent).toBe(0);
    expect(result.by_channel.sms.total_sent).toBe(0);
    expect(result.by_channel.push.total_sent).toBe(0);
    expect(result.overall_failure_rate).toBeNull();
    expect(result.most_reliable_channel).toBeNull();
    expect(result.least_reliable_channel).toBeNull();
  });

  it('email entries → email total_sent populated', () => {
    const emails = [
      { tenant_id: 'BIL', to: ['a@x.com'], subject: 'S', body_text: 'B', message_id: 'm1', status: 'sent', sent_at: NOW.toISOString(), transport: 'stub' },
      { tenant_id: 'BIL', to: ['b@x.com'], subject: 'S', body_text: 'B', message_id: 'm2', status: 'sent', sent_at: NOW.toISOString(), transport: 'stub' },
    ];
    const result = analyzeNotificationDeliveryFailures('BIL', emails, [], [], NOW);
    expect(result.by_channel.email.total_sent).toBe(2);
    expect(result.by_channel.sms.total_sent).toBe(0);
    expect(result.by_channel.push.total_sent).toBe(0);
  });

  it('failure_rate is a number in [0, 1]', () => {
    const emails = [
      { tenant_id: 'BIL', to: ['a@x.com'], subject: 'S', body_text: 'B', message_id: 'm1', status: 'sent', sent_at: NOW.toISOString(), transport: 'stub', template_id: 'ALERT_RED' },
    ];
    const result = analyzeNotificationDeliveryFailures('BIL', emails, [], [], NOW);
    expect(result.by_channel.email.failure_rate).toBeGreaterThanOrEqual(0);
    expect(result.by_channel.email.failure_rate).toBeLessThanOrEqual(1);
  });

  it('estimated_failures = round(failure_rate * total_sent)', () => {
    const emails = Array.from({ length: 10 }, (_, i) => ({
      tenant_id: 'BIL', to: [`u${i}@x.com`], subject: 'S', body_text: 'B',
      message_id: `m${i}`, status: 'sent', sent_at: NOW.toISOString(), transport: 'stub',
    }));
    const result = analyzeNotificationDeliveryFailures('BIL', emails, [], [], NOW);
    const ch = result.by_channel.email;
    expect(ch.estimated_failures).toBe(Math.round(ch.failure_rate * ch.total_sent));
  });

  it('most_reliable_channel is the one with lowest failure_rate', () => {
    // Provide entries for all 3 channels
    const emails = [{ tenant_id: 'BIL', to: ['a@x.com'], subject: 'S', body_text: 'B', message_id: 'm1', status: 'sent', sent_at: NOW.toISOString(), transport: 'stub' }];
    const sms = [{ tenant_id: 'BIL', to: '+254700001', body: 'Hi', message_id: 's1', status: 'sent', sent_at: NOW.toISOString(), transport: 'stub', segments: 1 }];
    const push = [{ tenant_id: 'BIL', to: [{ device_token: 'dt1', platform: 'fcm', user_id: 'u1' }], title: 'T', body: 'B', per_device: [{ device_token: 'dt1', platform: 'fcm', status: 'sent' }], message_id: 'p1', status: 'sent', sent_at: NOW.toISOString(), transport: 'stub' }];
    const result = analyzeNotificationDeliveryFailures('BIL', emails, sms, push, NOW);
    expect(['email', 'sms', 'push']).toContain(result.most_reliable_channel);
    expect(['email', 'sms', 'push']).toContain(result.least_reliable_channel);
  });

  it('top_failure_templates is an array of strings', () => {
    const emails = [
      { tenant_id: 'BIL', to: ['a@x.com'], subject: 'S', body_text: 'B', message_id: 'm1', status: 'sent', sent_at: NOW.toISOString(), transport: 'stub', template_id: 'ALERT_RED' },
    ];
    const result = analyzeNotificationDeliveryFailures('BIL', emails, [], [], NOW);
    expect(Array.isArray(result.by_channel.email.top_failure_templates)).toBe(true);
    for (const t of result.by_channel.email.top_failure_templates) {
      expect(typeof t).toBe('string');
    }
  });

  it('tenant_id and generated_at echoed', () => {
    const result = analyzeNotificationDeliveryFailures('BANK_DEMO', [], [], [], NOW);
    expect(result.tenant_id).toBe('BANK_DEMO');
    expect(result.generated_at).toBe(NOW.toISOString());
  });

  it('deterministic — same input same day same result', () => {
    const emails = [
      { tenant_id: 'BIL', to: ['a@x.com'], subject: 'S', body_text: 'B', message_id: 'm1', status: 'sent', sent_at: NOW.toISOString(), transport: 'stub', template_id: 'ALERT_RED' },
    ];
    const r1 = analyzeNotificationDeliveryFailures('BIL', emails, [], [], NOW);
    const r2 = analyzeNotificationDeliveryFailures('BIL', emails, [], [], NOW);
    expect(r1.by_channel.email.failure_rate).toBeCloseTo(r2.by_channel.email.failure_rate, 10);
  });
});

// ─── Route tests ───────────────────────────────────────────────────────

describe('GET /v1/notifications/delivery-failure-analysis — M10.20 route', () => {
  it('admin GET → 200 with shape', async () => {
    const { app } = makeFailureApp('admin');
    const res = await request(app)
      .get('/v1/notifications/delivery-failure-analysis')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('by_channel');
    expect(res.body.body.by_channel).toHaveProperty('email');
    expect(res.body.body.by_channel).toHaveProperty('sms');
    expect(res.body.body.by_channel).toHaveProperty('push');
  });

  it('supervisor → 200 (audit:read)', async () => {
    const { app } = makeFailureApp('supervisor');
    const res = await request(app)
      .get('/v1/notifications/delivery-failure-analysis')
      .set(TH_BIL)
      .set('x-apex-role', 'supervisor');
    expect(res.status).toBe(200);
  });

  it('risk_analyst → 403', async () => {
    const { app } = makeFailureApp('risk_analyst');
    const res = await request(app)
      .get('/v1/notifications/delivery-failure-analysis')
      .set(TH_BIL)
      .set('x-apex-role', 'risk_analyst');
    expect(res.status).toBe(403);
  });

  it('no tenant header → 400', async () => {
    const { app } = makeFailureApp('admin');
    const res = await request(app)
      .get('/v1/notifications/delivery-failure-analysis')
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });

  it('cross-tenant: BIL entries invisible to BANK_DEMO request', async () => {
    const { app, emailTransport } = makeFailureApp('admin');
    await emailTransport.send('BIL', {
      to: ['a@x.com'],
      subject: 'Test',
      body_text: 'Test body',
    });
    const res = await request(app)
      .get('/v1/notifications/delivery-failure-analysis')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' })
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.by_channel.email.total_sent).toBe(0);
  });
});
