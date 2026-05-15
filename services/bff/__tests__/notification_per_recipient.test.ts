// services/bff/__tests__/notification_per_recipient.test.ts
//
// T6 M10.14 — Notification per-recipient cross-channel rollup.

import request from 'supertest';
import { buildPerRecipientSummary } from '../src/notification_per_recipient';
import {
  StubEmailTransport,
  type EmailLedgerEntry,
} from '../src/notifications/email';
import {
  StubSmsTransport,
  type SmsLedgerEntry,
} from '../src/notifications/sms';
import {
  StubPushTransport,
  type PushLedgerEntry,
} from '../src/notifications/push';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function emailEntry(overrides: Partial<EmailLedgerEntry>): EmailLedgerEntry {
  return {
    message_id: 'em-1',
    status: 'sent',
    sent_at: NOW.toISOString(),
    transport: 'stub',
    tenant_id: 'BIL',
    to: ['ops@bil.example.com'],
    subject: 's',
    body_text: 'b',
    ...overrides,
  };
}

function smsEntry(overrides: Partial<SmsLedgerEntry>): SmsLedgerEntry {
  return {
    message_id: 'sm-1',
    status: 'sent',
    sent_at: NOW.toISOString(),
    transport: 'stub',
    segments: 1,
    tenant_id: 'BIL',
    to: '+254700111222',
    body: 'b',
    ...overrides,
  };
}

function pushEntry(overrides: Partial<PushLedgerEntry>): PushLedgerEntry {
  return {
    message_id: 'pu-1',
    per_device: [{ device_token: 't-1', platform: 'fcm', status: 'sent' }],
    status: 'sent',
    sent_at: NOW.toISOString(),
    transport: 'stub',
    tenant_id: 'BIL',
    to: [{ device_token: 't-1', platform: 'fcm', user_id: 'user-42' }],
    title: 't',
    body: 'b',
    ...overrides,
  };
}

// ─── buildPerRecipientSummary — pure ─────────────────────────────────

describe('M10.14 — empty input', () => {
  test('zero ledger entries → empty rollup', () => {
    const s = buildPerRecipientSummary('BIL', [], [], [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_sent_all_channels).toBe(0);
    expect(s.total_distinct_recipients).toBe(0);
    expect(s.by_kind).toEqual({ email_address: 0, sms_phone: 0, push_user: 0 });
    expect(s.recipients).toEqual([]);
    expect(s.top_recipients).toEqual([]);
    expect(s.most_active_recipient).toBeNull();
  });
});

describe('M10.14 — single email recipient', () => {
  test('row populated with email kind + by_channel.email=1', () => {
    const s = buildPerRecipientSummary(
      'BIL',
      [emailEntry({})],
      [],
      [],
      NOW,
    );
    expect(s.total_distinct_recipients).toBe(1);
    expect(s.total_sent_all_channels).toBe(1);
    expect(s.recipients[0]!.recipient_kind).toBe('email_address');
    expect(s.recipients[0]!.recipient_id).toBe('ops@bil.example.com');
    expect(s.recipients[0]!.by_channel.email).toBe(1);
    expect(s.recipients[0]!.by_channel.sms).toBe(0);
    expect(s.recipients[0]!.by_channel.push).toBe(0);
    expect(s.by_kind.email_address).toBe(1);
  });
});

describe('M10.14 — multi-recipient email fan-out', () => {
  test('each address counts as its own recipient', () => {
    const s = buildPerRecipientSummary(
      'BIL',
      [emailEntry({ to: ['a@bil.example.com', 'b@bil.example.com'] })],
      [],
      [],
      NOW,
    );
    expect(s.total_distinct_recipients).toBe(2);
    expect(s.total_sent_all_channels).toBe(2);
  });
});

describe('M10.14 — push fan-out across devices', () => {
  test('same user with two devices counts as ONE send', () => {
    const s = buildPerRecipientSummary(
      'BIL',
      [],
      [],
      [pushEntry({
        to: [
          { device_token: 't-1', platform: 'fcm', user_id: 'user-42' },
          { device_token: 't-2', platform: 'apns', user_id: 'user-42' },
        ],
      })],
      NOW,
    );
    expect(s.total_distinct_recipients).toBe(1);
    expect(s.total_sent_all_channels).toBe(1);
    const row = s.recipients[0]!;
    expect(row.recipient_kind).toBe('push_user');
    expect(row.by_channel.push).toBe(1);
  });

  test('two different users get two rows', () => {
    const s = buildPerRecipientSummary(
      'BIL',
      [],
      [],
      [pushEntry({
        to: [
          { device_token: 't-1', platform: 'fcm', user_id: 'user-42' },
          { device_token: 't-2', platform: 'fcm', user_id: 'user-43' },
        ],
      })],
      NOW,
    );
    expect(s.total_distinct_recipients).toBe(2);
    expect(s.by_kind.push_user).toBe(2);
  });
});

describe('M10.14 — cross-channel separation', () => {
  test('email + sms + push for same human render as 3 rows', () => {
    const s = buildPerRecipientSummary(
      'BIL',
      [emailEntry({ to: ['alice@bil.example.com'] })],
      [smsEntry({ to: '+254700111222' })],
      [pushEntry({ to: [{ device_token: 't-1', platform: 'fcm', user_id: 'alice-user' }] })],
      NOW,
    );
    expect(s.total_distinct_recipients).toBe(3);
    expect(s.by_kind.email_address).toBe(1);
    expect(s.by_kind.sms_phone).toBe(1);
    expect(s.by_kind.push_user).toBe(1);
  });
});

describe('M10.14 — repeated sends bump total_sent', () => {
  test('5 emails to same address → total_sent=5, one row', () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      emailEntry({ message_id: `em-${i}`, sent_at: new Date(NOW.getTime() + i * 1000).toISOString() }),
    );
    const s = buildPerRecipientSummary('BIL', entries, [], [], NOW);
    expect(s.total_distinct_recipients).toBe(1);
    expect(s.recipients[0]!.total_sent).toBe(5);
    expect(s.recipients[0]!.by_channel.email).toBe(5);
  });
});

describe('M10.14 — most_recent_at', () => {
  test('takes the newest sent_at across this recipient', () => {
    const oldEntry = emailEntry({ sent_at: '2026-05-01T00:00:00.000Z' });
    const newEntry = emailEntry({ sent_at: '2026-05-14T00:00:00.000Z' });
    const s = buildPerRecipientSummary('BIL', [oldEntry, newEntry], [], [], NOW);
    expect(s.recipients[0]!.most_recent_at).toBe('2026-05-14T00:00:00.000Z');
  });
});

describe('M10.14 — distinct_templates', () => {
  test('deduplicates per recipient + sorted asc', () => {
    const entries = [
      emailEntry({ template_id: 'ALERT_RED' }),
      emailEntry({ template_id: 'CASE_ASSIGNED' }),
      emailEntry({ template_id: 'ALERT_RED' }), // dup
      emailEntry({ template_id: undefined }), // untemplated — not counted
    ];
    const s = buildPerRecipientSummary('BIL', entries, [], [], NOW);
    expect(s.recipients[0]!.distinct_templates).toEqual(['ALERT_RED', 'CASE_ASSIGNED']);
  });
});

describe('M10.14 — sort order', () => {
  test('recipients sorted by total_sent desc with recipient_id asc tie-break', () => {
    const s = buildPerRecipientSummary(
      'BIL',
      [
        emailEntry({ to: ['c@bil.example.com'] }),
        emailEntry({ to: ['c@bil.example.com'] }),
        emailEntry({ to: ['a@bil.example.com'] }),
        emailEntry({ to: ['b@bil.example.com'] }),
      ],
      [],
      [],
      NOW,
    );
    // c=2 then a=1, b=1 (tie-break alphabetical)
    expect(s.recipients.map((r) => r.recipient_id)).toEqual([
      'c@bil.example.com',
      'a@bil.example.com',
      'b@bil.example.com',
    ]);
  });
});

describe('M10.14 — top_recipients cap', () => {
  test('cap at 20', () => {
    const entries = Array.from({ length: 25 }, (_, i) =>
      emailEntry({ to: [`user-${i.toString().padStart(2, '0')}@bil.example.com`] }),
    );
    const s = buildPerRecipientSummary('BIL', entries, [], [], NOW);
    expect(s.recipients.length).toBe(25);
    expect(s.top_recipients.length).toBe(20);
  });
});

describe('M10.14 — most_active_recipient', () => {
  test('points at top of sorted recipients', () => {
    const s = buildPerRecipientSummary(
      'BIL',
      [
        emailEntry({ to: ['heavy@bil.example.com'] }),
        emailEntry({ to: ['heavy@bil.example.com'] }),
        emailEntry({ to: ['light@bil.example.com'] }),
      ],
      [],
      [],
      NOW,
    );
    expect(s.most_active_recipient).toEqual({
      recipient_id: 'heavy@bil.example.com',
      recipient_kind: 'email_address',
      total_sent: 2,
    });
  });

  test('null when no sends', () => {
    const s = buildPerRecipientSummary('BIL', [], [], [], NOW);
    expect(s.most_active_recipient).toBeNull();
  });
});

describe('M10.14 — aggregate consistency', () => {
  test('Σ per-recipient total_sent = total_sent_all_channels', () => {
    const s = buildPerRecipientSummary(
      'BIL',
      [emailEntry({ to: ['a@bil.example.com'] })],
      [smsEntry({})],
      [pushEntry({})],
      NOW,
    );
    const sum = s.recipients.reduce((acc, r) => acc + r.total_sent, 0);
    expect(s.total_sent_all_channels).toBe(sum);
  });
});

// ─── GET /v1/notifications/per-recipient ─────────────────────────────

function makePerRecipientApp(role = 'admin') {
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

describe('M10.14 — GET /v1/notifications/per-recipient', () => {
  test('admin → 200 with empty summary for fresh tenant', async () => {
    const { app } = makePerRecipientApp('admin');
    const r = await request(app).get('/v1/notifications/per-recipient').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_distinct_recipients).toBe(0);
    expect(r.body.body.recipients).toEqual([]);
  });

  test('populated summary reflects sends', async () => {
    const { app, emailTransport } = makePerRecipientApp('admin');
    await emailTransport.send('BIL', {
      to: ['ops@bil.example.com'],
      subject: 'test',
      body_text: 'hi',
    });
    const r = await request(app).get('/v1/notifications/per-recipient').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_distinct_recipients).toBe(1);
    expect(r.body.body.most_active_recipient.recipient_id).toBe('ops@bil.example.com');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makePerRecipientApp('case_owner');
    const r = await request(app).get('/v1/notifications/per-recipient').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL sends invisible to BANK_DEMO via route', async () => {
    const { app, emailTransport } = makePerRecipientApp('admin');
    await emailTransport.send('BIL', {
      to: ['ops@bil.example.com'],
      subject: 'test',
      body_text: 'hi',
    });
    const bank = await request(app)
      .get('/v1/notifications/per-recipient')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_distinct_recipients).toBe(0);
  });

  test('M10.12 /v1/notifications/ledger-analytics still works (sibling)', async () => {
    const { app } = makePerRecipientApp('admin');
    const r = await request(app).get('/v1/notifications/ledger-analytics').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
