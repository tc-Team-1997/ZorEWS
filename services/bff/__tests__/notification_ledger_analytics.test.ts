// services/bff/__tests__/notification_ledger_analytics.test.ts
//
// T6 M10.12 — Notification delivery ledger analytics.

import request from 'supertest';
import { analyseNotificationLedgers } from '../src/notification_ledger_analytics';
import type { EmailLedgerEntry } from '../src/notifications/email';
import type { SmsLedgerEntry } from '../src/notifications/sms';
import type { PushLedgerEntry } from '../src/notifications/push';
import { StubEmailTransport } from '../src/notifications/email';
import { StubSmsTransport } from '../src/notifications/sms';
import { StubPushTransport } from '../src/notifications/push';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkEmail(o: Partial<EmailLedgerEntry> & { sent_at: string }): EmailLedgerEntry {
  return {
    message_id: o.message_id ?? `em-${Math.random()}`,
    status: o.status ?? 'sent',
    sent_at: o.sent_at,
    transport: o.transport ?? 'stub',
    tenant_id: o.tenant_id ?? 'BIL',
    to: o.to ?? ['ops@example.com'],
    cc: o.cc,
    subject: o.subject ?? 'Subject',
    body_text: o.body_text ?? 'Body',
    body_html: o.body_html,
    template_id: o.template_id,
    related_alert_id: o.related_alert_id,
    related_case_id: o.related_case_id,
  };
}

function mkSms(o: Partial<SmsLedgerEntry> & { sent_at: string }): SmsLedgerEntry {
  return {
    message_id: o.message_id ?? `sms-${Math.random()}`,
    status: o.status ?? 'sent',
    sent_at: o.sent_at,
    transport: o.transport ?? 'stub',
    segments: o.segments ?? 1,
    tenant_id: o.tenant_id ?? 'BIL',
    to: o.to ?? '+254700000001',
    body: o.body ?? 'sms body',
    template_id: o.template_id,
    related_alert_id: o.related_alert_id,
    related_case_id: o.related_case_id,
  };
}

function mkPush(o: Partial<PushLedgerEntry> & { sent_at: string }): PushLedgerEntry {
  return {
    message_id: o.message_id ?? `push-${Math.random()}`,
    status: o.status ?? 'sent',
    sent_at: o.sent_at,
    transport: o.transport ?? 'stub',
    per_device: o.per_device ?? [],
    tenant_id: o.tenant_id ?? 'BIL',
    to: o.to ?? [{ device_token: 't1', platform: 'fcm', user_id: 'u1' }],
    title: o.title ?? 'Hello',
    body: o.body ?? 'Push body',
    deep_link: o.deep_link,
    badge_count: o.badge_count,
    template_id: o.template_id,
    related_alert_id: o.related_alert_id,
    related_case_id: o.related_case_id,
  };
}

// ─── analyseNotificationLedgers — pure ───────────────────────────────

describe('M10.12 — empty ledgers', () => {
  test('zero entries on every channel → zero envelope', () => {
    const r = analyseNotificationLedgers('BIL', [], [], [], NOW);
    expect(r.tenant_id).toBe('BIL');
    expect(r.total_sent_all_channels).toBe(0);
    expect(r.channels.email.total_sent).toBe(0);
    expect(r.channels.sms.total_sent).toBe(0);
    expect(r.channels.push.total_sent).toBe(0);
    expect(r.channels.email.most_recent_at).toBeNull();
  });
});

describe('M10.12 — per-channel totals', () => {
  test('total_sent_all_channels = sum across channels', () => {
    const emails = [mkEmail({ sent_at: '2026-05-14T10:00:00Z' }), mkEmail({ sent_at: '2026-05-14T11:00:00Z' })];
    const sms = [mkSms({ sent_at: '2026-05-14T10:30:00Z' })];
    const push = [mkPush({ sent_at: '2026-05-14T11:30:00Z' }), mkPush({ sent_at: '2026-05-14T11:45:00Z' }), mkPush({ sent_at: '2026-05-14T12:00:00Z' })];
    const r = analyseNotificationLedgers('BIL', emails, sms, push, NOW);
    expect(r.total_sent_all_channels).toBe(6);
    expect(r.channels.email.total_sent).toBe(2);
    expect(r.channels.sms.total_sent).toBe(1);
    expect(r.channels.push.total_sent).toBe(3);
  });
});

describe('M10.12 — template mix', () => {
  test('by_template_id aggregates count per template; sorted desc', () => {
    const emails = [
      mkEmail({ sent_at: '2026-05-14T10:00:00Z', template_id: 'ALERT_RED' }),
      mkEmail({ sent_at: '2026-05-14T10:30:00Z', template_id: 'ALERT_RED' }),
      mkEmail({ sent_at: '2026-05-14T11:00:00Z', template_id: 'ALERT_ORANGE' }),
    ];
    const r = analyseNotificationLedgers('BIL', emails, [], [], NOW);
    const mix = r.channels.email.by_template_id;
    expect(mix[0]!.template_id).toBe('ALERT_RED');
    expect(mix[0]!.count).toBe(2);
    expect(mix[1]!.template_id).toBe('ALERT_ORANGE');
    expect(mix[1]!.count).toBe(1);
  });

  test('untemplated entries do not contribute to by_template_id', () => {
    const emails = [
      mkEmail({ sent_at: '2026-05-14T10:00:00Z' }), // no template_id
      mkEmail({ sent_at: '2026-05-14T11:00:00Z', template_id: 'ALERT_RED' }),
    ];
    const r = analyseNotificationLedgers('BIL', emails, [], [], NOW);
    expect(r.channels.email.by_template_id).toHaveLength(1);
    expect(r.channels.email.by_template_id[0]!.template_id).toBe('ALERT_RED');
  });
});

describe('M10.12 — top recipients', () => {
  test('email: by_recipient counts per address', () => {
    const emails = [
      mkEmail({ sent_at: '2026-05-14T10:00:00Z', to: ['alice@example.com'] }),
      mkEmail({ sent_at: '2026-05-14T10:30:00Z', to: ['alice@example.com', 'bob@example.com'] }),
      mkEmail({ sent_at: '2026-05-14T11:00:00Z', to: ['bob@example.com'] }),
    ];
    const r = analyseNotificationLedgers('BIL', emails, [], [], NOW);
    expect(r.channels.email.top_recipients).toHaveLength(2);
    expect(r.channels.email.top_recipients[0]!.count).toBe(2);
  });

  test('push: counts distinct user_id per push (2 devices, same user → 1 count)', () => {
    const push = [
      mkPush({
        sent_at: '2026-05-14T10:00:00Z',
        to: [
          { device_token: 't1', platform: 'fcm', user_id: 'u1' },
          { device_token: 't2', platform: 'apns', user_id: 'u1' },
        ],
      }),
    ];
    const r = analyseNotificationLedgers('BIL', [], [], push, NOW);
    expect(r.channels.push.top_recipients).toHaveLength(1);
    expect(r.channels.push.top_recipients[0]!.recipient).toBe('u1');
    // Distinct user_id per push, so 2 same-user devices in one push = 1
    expect(r.channels.push.top_recipients[0]!.count).toBe(1);
  });

  test('top_recipients capped at 10', () => {
    const emails: EmailLedgerEntry[] = [];
    for (let i = 0; i < 15; i += 1) {
      emails.push(mkEmail({ sent_at: '2026-05-14T10:00:00Z', to: [`u${i}@example.com`] }));
    }
    const r = analyseNotificationLedgers('BIL', emails, [], [], NOW);
    expect(r.channels.email.top_recipients).toHaveLength(10);
  });
});

describe('M10.12 — most_recent_at', () => {
  test('latest sent_at per channel surfaces', () => {
    const emails = [
      mkEmail({ sent_at: '2026-05-14T08:00:00Z' }),
      mkEmail({ sent_at: '2026-05-14T11:00:00Z' }),
      mkEmail({ sent_at: '2026-05-14T09:00:00Z' }),
    ];
    const r = analyseNotificationLedgers('BIL', emails, [], [], NOW);
    expect(r.channels.email.most_recent_at).toBe('2026-05-14T11:00:00Z');
  });
});

describe('M10.12 — by_template_id cap', () => {
  test('top 5 templates only', () => {
    const emails: EmailLedgerEntry[] = [];
    const templates: Array<'ALERT_RED' | 'ALERT_ORANGE' | 'CASE_ASSIGNED' | 'SLA_BREACH'> = [
      'ALERT_RED',
      'ALERT_ORANGE',
      'CASE_ASSIGNED',
      'SLA_BREACH',
    ];
    for (const t of templates) {
      emails.push(mkEmail({ sent_at: '2026-05-14T10:00:00Z', template_id: t }));
    }
    const r = analyseNotificationLedgers('BIL', emails, [], [], NOW);
    expect(r.channels.email.by_template_id).toHaveLength(4);
  });
});

// ─── GET /v1/notifications/ledger-analytics ──────────────────────────

function makeAnalyticsApp(role = 'admin') {
  const emailTransport = new StubEmailTransport({ now: () => NOW });
  const smsTransport = new StubSmsTransport({ now: () => NOW });
  const pushTransport = new StubPushTransport({ now: () => NOW });
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

describe('M10.12 — GET /v1/notifications/ledger-analytics', () => {
  test('empty tenant → 200 with zero envelope', async () => {
    const { app } = makeAnalyticsApp('admin');
    const r = await request(app).get('/v1/notifications/ledger-analytics').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_sent_all_channels).toBe(0);
    expect(r.body.body.channels.email.total_sent).toBe(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAnalyticsApp('readonly');
    const r = await request(app).get('/v1/notifications/ledger-analytics').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL ledger invisible to BANK_DEMO', async () => {
    const { app } = makeAnalyticsApp('admin');
    const r = await request(app)
      .get('/v1/notifications/ledger-analytics')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total_sent_all_channels).toBe(0);
  });
});
