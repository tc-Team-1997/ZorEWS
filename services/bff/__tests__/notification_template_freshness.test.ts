// services/bff/__tests__/notification_template_freshness.test.ts
//
// T6 M10.19 — Notification template freshness rollup.

import request from 'supertest';
import {
  ALL_TEMPLATE_FRESHNESS_BUCKETS,
  DEFAULT_TEMPLATE_FRESH_DAYS,
  DEFAULT_TEMPLATE_STALE_DAYS,
  LEDGER_DRAIN_LIMIT,
  MAX_STALE_TEMPLATES_LIST,
  TemplateFreshnessError,
  bucketForDaysSinceSend,
  summarizeNotificationTemplateFreshness,
  summarizeNotificationTemplateFreshnessFromTransports,
  type FreshnessLedgerInput,
} from '../src/notification_template_freshness';
import {
  type EmailLedgerEntry,
  StubEmailTransport,
} from '../src/notifications/email';
import {
  type SmsLedgerEntry,
  StubSmsTransport,
} from '../src/notifications/sms';
import {
  type PushLedgerEntry,
  StubPushTransport,
} from '../src/notifications/push';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { introspectNotificationTemplateCatalog } from '../src/notification_template_catalog';

const NOW = new Date('2026-05-23T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── helpers ────────────────────────────────────────────────────────

function emailEntry(opts: {
  template_id?: 'ALERT_RED' | 'ALERT_ORANGE' | 'CASE_ASSIGNED' | 'SLA_BREACH';
  sent_at_offset_days: number;
  message_id?: string;
}): EmailLedgerEntry {
  return {
    message_id: opts.message_id ?? `em-${Math.random()}`,
    status: 'sent',
    sent_at: new Date(NOW.getTime() - opts.sent_at_offset_days * DAY_MS).toISOString(),
    transport: 'stub',
    tenant_id: 'BIL',
    template_id: opts.template_id,
    to: ['someone@example.com'],
    subject: 'Test',
    body_text: 'Body',
  };
}

function smsEntry(opts: {
  template_id?: 'ALERT_RED_BRIEF' | 'OTP_LOGIN' | 'KYC_REMINDER' | 'PAYMENT_REMINDER';
  sent_at_offset_days: number;
  message_id?: string;
}): SmsLedgerEntry {
  return {
    message_id: opts.message_id ?? `sm-${Math.random()}`,
    status: 'sent',
    sent_at: new Date(NOW.getTime() - opts.sent_at_offset_days * DAY_MS).toISOString(),
    transport: 'stub',
    segments: 1,
    tenant_id: 'BIL',
    template_id: opts.template_id,
    to: '+254712345678',
    body: 'Test',
  };
}

function pushEntry(opts: {
  template_id?: 'ALERT_RED_PUSH' | 'OTP_CONFIRM' | 'NEW_CASE_ASSIGNED' | 'REPORT_READY';
  sent_at_offset_days: number;
  message_id?: string;
}): PushLedgerEntry {
  return {
    message_id: opts.message_id ?? `pu-${Math.random()}`,
    per_device: [{ device_token: 'tok', platform: 'fcm', status: 'sent' }],
    status: 'sent',
    sent_at: new Date(NOW.getTime() - opts.sent_at_offset_days * DAY_MS).toISOString(),
    transport: 'stub',
    tenant_id: 'BIL',
    template_id: opts.template_id,
    to: [{ device_token: 'tok', platform: 'fcm', user_id: 'u1' }],
    title: 'Test',
    body: 'Body',
  };
}

function emptyLedgers(): FreshnessLedgerInput {
  return { email: [], sms: [], push: [] };
}

// ─── enum + helper invariants ───────────────────────────────────────

describe('M10.19 — canonical enum + helper', () => {
  test('ALL_TEMPLATE_FRESHNESS_BUCKETS has 4 canonical values', () => {
    expect([...ALL_TEMPLATE_FRESHNESS_BUCKETS]).toEqual([
      'recent',
      'stable',
      'stale',
      'never_sent',
    ]);
  });

  test('default thresholds + caps exported', () => {
    expect(DEFAULT_TEMPLATE_FRESH_DAYS).toBe(14);
    expect(DEFAULT_TEMPLATE_STALE_DAYS).toBe(60);
    expect(MAX_STALE_TEMPLATES_LIST).toBe(20);
    expect(LEDGER_DRAIN_LIMIT).toBe(500);
  });

  test('bucketForDaysSinceSend null → never_sent', () => {
    expect(bucketForDaysSinceSend(null, 14, 60)).toBe('never_sent');
  });

  test('bucketForDaysSinceSend recent < fresh_days', () => {
    expect(bucketForDaysSinceSend(0, 14, 60)).toBe('recent');
    expect(bucketForDaysSinceSend(13, 14, 60)).toBe('recent');
  });

  test('bucketForDaysSinceSend stable in [fresh_days, stale_days] inclusive', () => {
    expect(bucketForDaysSinceSend(14, 14, 60)).toBe('stable');
    expect(bucketForDaysSinceSend(30, 14, 60)).toBe('stable');
    expect(bucketForDaysSinceSend(60, 14, 60)).toBe('stable');
  });

  test('bucketForDaysSinceSend stale > stale_days', () => {
    expect(bucketForDaysSinceSend(61, 14, 60)).toBe('stale');
    expect(bucketForDaysSinceSend(365, 14, 60)).toBe('stale');
  });

  test('boundary semantics — strict-< on fresh + strict-> on stale', () => {
    expect(bucketForDaysSinceSend(14 - 1, 14, 60)).toBe('recent');
    expect(bucketForDaysSinceSend(14, 14, 60)).toBe('stable');
    expect(bucketForDaysSinceSend(60, 14, 60)).toBe('stable');
    expect(bucketForDaysSinceSend(60 + 1, 14, 60)).toBe('stale');
  });
});

// ─── validation ─────────────────────────────────────────────────────

describe('M10.19 — validation', () => {
  test('throws on empty tenant_id', () => {
    expect(() => summarizeNotificationTemplateFreshness('', emptyLedgers(), NOW)).toThrow(
      TemplateFreshnessError,
    );
    expect(() => summarizeNotificationTemplateFreshness('  ', emptyLedgers(), NOW)).toThrow(
      TemplateFreshnessError,
    );
  });

  test('throws on negative fresh_days', () => {
    expect(() =>
      summarizeNotificationTemplateFreshness('BIL', emptyLedgers(), NOW, -1, 60),
    ).toThrow(TemplateFreshnessError);
  });

  test('throws on negative stale_days', () => {
    expect(() =>
      summarizeNotificationTemplateFreshness('BIL', emptyLedgers(), NOW, 14, -1),
    ).toThrow(TemplateFreshnessError);
  });

  test('throws on non-integer days', () => {
    expect(() =>
      summarizeNotificationTemplateFreshness('BIL', emptyLedgers(), NOW, 7.5, 60),
    ).toThrow(TemplateFreshnessError);
  });

  test('throws when stale_days < fresh_days', () => {
    expect(() =>
      summarizeNotificationTemplateFreshness('BIL', emptyLedgers(), NOW, 60, 14),
    ).toThrow(TemplateFreshnessError);
  });

  test('accepts stale_days == fresh_days (degenerate but valid range)', () => {
    expect(() =>
      summarizeNotificationTemplateFreshness('BIL', emptyLedgers(), NOW, 14, 14),
    ).not.toThrow();
  });
});

// ─── empty input ────────────────────────────────────────────────────

describe('M10.19 — empty ledgers', () => {
  test('no sends → every template never_sent', () => {
    const r = summarizeNotificationTemplateFreshness('BIL', emptyLedgers(), NOW);
    const catalog = introspectNotificationTemplateCatalog();
    expect(r.tenant_id).toBe('BIL');
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(r.total_templates).toBe(catalog.total_templates);
    expect(r.never_sent_count).toBe(catalog.total_templates);
    expect(r.recent_count).toBe(0);
    expect(r.stable_count).toBe(0);
    expect(r.stale_count).toBe(0);
    expect(r.mean_days_since_send).toBeNull();
    expect(r.fresh_days).toBe(14);
    expect(r.stale_days).toBe(60);
    for (const row of r.templates) {
      expect(row.last_sent_at).toBeNull();
      expect(row.days_since_last_send).toBeNull();
      expect(row.freshness).toBe('never_sent');
      expect(row.total_sends_observed).toBe(0);
    }
  });

  test('templates_needing_attention contains every never_sent', () => {
    const r = summarizeNotificationTemplateFreshness('BIL', emptyLedgers(), NOW);
    const catalog = introspectNotificationTemplateCatalog();
    // All 12 are never_sent — cap 20 so all 12 fit
    expect(r.templates_needing_attention).toHaveLength(catalog.total_templates);
    for (const t of r.templates_needing_attention) {
      expect(t.freshness).toBe('never_sent');
    }
  });
});

// ─── freshness classification ──────────────────────────────────────

describe('M10.19 — freshness classification', () => {
  test('recent: send 5 days ago + defaults', () => {
    const r = summarizeNotificationTemplateFreshness(
      'BIL',
      {
        email: [emailEntry({ template_id: 'ALERT_RED', sent_at_offset_days: 5 })],
        sms: [],
        push: [],
      },
      NOW,
    );
    const row = r.templates.find(
      (t) => t.channel === 'email' && t.template_id === 'ALERT_RED',
    )!;
    expect(row.freshness).toBe('recent');
    expect(row.days_since_last_send).toBe(5);
    expect(row.total_sends_observed).toBe(1);
    expect(r.recent_count).toBe(1);
  });

  test('stable: send 30 days ago (in [14, 60])', () => {
    const r = summarizeNotificationTemplateFreshness(
      'BIL',
      {
        email: [],
        sms: [smsEntry({ template_id: 'OTP_LOGIN', sent_at_offset_days: 30 })],
        push: [],
      },
      NOW,
    );
    const row = r.templates.find(
      (t) => t.channel === 'sms' && t.template_id === 'OTP_LOGIN',
    )!;
    expect(row.freshness).toBe('stable');
    expect(row.days_since_last_send).toBe(30);
    expect(r.stable_count).toBe(1);
  });

  test('stale: send 100 days ago', () => {
    const r = summarizeNotificationTemplateFreshness(
      'BIL',
      {
        email: [],
        sms: [],
        push: [pushEntry({ template_id: 'REPORT_READY', sent_at_offset_days: 100 })],
      },
      NOW,
    );
    const row = r.templates.find(
      (t) => t.channel === 'push' && t.template_id === 'REPORT_READY',
    )!;
    expect(row.freshness).toBe('stale');
    expect(row.days_since_last_send).toBe(100);
    expect(r.stale_count).toBe(1);
  });

  test('newest send wins when multiple entries for same template', () => {
    const r = summarizeNotificationTemplateFreshness(
      'BIL',
      {
        email: [
          emailEntry({ template_id: 'ALERT_RED', sent_at_offset_days: 60 }),
          emailEntry({ template_id: 'ALERT_RED', sent_at_offset_days: 5 }),
          emailEntry({ template_id: 'ALERT_RED', sent_at_offset_days: 30 }),
        ],
        sms: [],
        push: [],
      },
      NOW,
    );
    const row = r.templates.find(
      (t) => t.channel === 'email' && t.template_id === 'ALERT_RED',
    )!;
    expect(row.days_since_last_send).toBe(5);
    expect(row.freshness).toBe('recent');
    expect(row.total_sends_observed).toBe(3);
  });

  test('untemplated sends excluded (no template_id)', () => {
    const r = summarizeNotificationTemplateFreshness(
      'BIL',
      {
        email: [emailEntry({ sent_at_offset_days: 5 })], // no template_id
        sms: [],
        push: [],
      },
      NOW,
    );
    // Every template remains never_sent
    expect(r.never_sent_count).toBe(r.total_templates);
  });

  test('boundary: send exactly fresh_days ago → stable', () => {
    const r = summarizeNotificationTemplateFreshness(
      'BIL',
      {
        email: [emailEntry({ template_id: 'ALERT_RED', sent_at_offset_days: 14 })],
        sms: [],
        push: [],
      },
      NOW,
    );
    const row = r.templates.find(
      (t) => t.channel === 'email' && t.template_id === 'ALERT_RED',
    )!;
    expect(row.days_since_last_send).toBe(14);
    expect(row.freshness).toBe('stable');
  });

  test('boundary: send exactly stale_days ago → stable', () => {
    const r = summarizeNotificationTemplateFreshness(
      'BIL',
      {
        email: [emailEntry({ template_id: 'ALERT_RED', sent_at_offset_days: 60 })],
        sms: [],
        push: [],
      },
      NOW,
    );
    const row = r.templates.find(
      (t) => t.channel === 'email' && t.template_id === 'ALERT_RED',
    )!;
    expect(row.freshness).toBe('stable');
  });

  test('boundary: 61 days → stale', () => {
    const r = summarizeNotificationTemplateFreshness(
      'BIL',
      {
        email: [emailEntry({ template_id: 'ALERT_RED', sent_at_offset_days: 61 })],
        sms: [],
        push: [],
      },
      NOW,
    );
    const row = r.templates.find(
      (t) => t.channel === 'email' && t.template_id === 'ALERT_RED',
    )!;
    expect(row.freshness).toBe('stale');
  });
});

// ─── partition invariants ──────────────────────────────────────────

describe('M10.19 — partition invariants', () => {
  test('recent + stable + stale + never_sent = total_templates', () => {
    const ledgers: FreshnessLedgerInput = {
      email: [
        emailEntry({ template_id: 'ALERT_RED', sent_at_offset_days: 3 }),
        emailEntry({ template_id: 'ALERT_ORANGE', sent_at_offset_days: 30 }),
      ],
      sms: [smsEntry({ template_id: 'OTP_LOGIN', sent_at_offset_days: 100 })],
      push: [],
    };
    const r = summarizeNotificationTemplateFreshness('BIL', ledgers, NOW);
    expect(r.recent_count + r.stable_count + r.stale_count + r.never_sent_count).toBe(
      r.total_templates,
    );
  });

  test('total_templates matches catalog size', () => {
    const r = summarizeNotificationTemplateFreshness('BIL', emptyLedgers(), NOW);
    const catalog = introspectNotificationTemplateCatalog();
    expect(r.total_templates).toBe(catalog.total_templates);
  });

  test('every catalog template appears in templates[] exactly once', () => {
    const r = summarizeNotificationTemplateFreshness('BIL', emptyLedgers(), NOW);
    const catalog = introspectNotificationTemplateCatalog();
    expect(r.templates).toHaveLength(catalog.total_templates);
    const seen = new Set<string>();
    for (const t of r.templates) {
      const key = `${t.channel}::${t.template_id}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    for (const c of catalog.templates) {
      expect(seen.has(`${c.channel}::${c.template_id}`)).toBe(true);
    }
  });

  test('mean_days_since_send computed over sent templates only', () => {
    const ledgers: FreshnessLedgerInput = {
      email: [
        emailEntry({ template_id: 'ALERT_RED', sent_at_offset_days: 10 }),
        emailEntry({ template_id: 'ALERT_ORANGE', sent_at_offset_days: 30 }),
      ],
      sms: [smsEntry({ template_id: 'OTP_LOGIN', sent_at_offset_days: 50 })],
      push: [],
    };
    const r = summarizeNotificationTemplateFreshness('BIL', ledgers, NOW);
    expect(r.mean_days_since_send).toBe(30); // (10+30+50)/3
  });
});

// ─── sort order ────────────────────────────────────────────────────

describe('M10.19 — sort order', () => {
  test('templates sorted by days_since_last_send desc + (channel, template_id) asc tie-break; never_sent at top', () => {
    const ledgers: FreshnessLedgerInput = {
      email: [
        emailEntry({ template_id: 'ALERT_RED', sent_at_offset_days: 5 }), // recent
        emailEntry({ template_id: 'ALERT_ORANGE', sent_at_offset_days: 100 }), // stale
        emailEntry({ template_id: 'CASE_ASSIGNED', sent_at_offset_days: 30 }), // stable
        emailEntry({ template_id: 'SLA_BREACH', sent_at_offset_days: 100 }), // stale (tied days)
      ],
      sms: [],
      push: [],
    };
    const r = summarizeNotificationTemplateFreshness('BIL', ledgers, NOW);
    // First entries should be never_sent (all SMS + push + nothing on email)
    expect(r.templates[0]!.freshness).toBe('never_sent');
    // Find the 4 emails with sends and check their relative order
    const sentEmails = r.templates.filter(
      (t) => t.channel === 'email' && t.days_since_last_send !== null,
    );
    // Order: ALERT_ORANGE 100d, SLA_BREACH 100d (tie-break asc: ALERT_ORANGE < SLA_BREACH), CASE_ASSIGNED 30d, ALERT_RED 5d
    expect(sentEmails[0]!.template_id).toBe('ALERT_ORANGE');
    expect(sentEmails[1]!.template_id).toBe('SLA_BREACH');
    expect(sentEmails[2]!.template_id).toBe('CASE_ASSIGNED');
    expect(sentEmails[3]!.template_id).toBe('ALERT_RED');
  });
});

// ─── templates_needing_attention ───────────────────────────────────

describe('M10.19 — templates_needing_attention', () => {
  test('never_sent + stale only; cap MAX_STALE_TEMPLATES_LIST', () => {
    const ledgers: FreshnessLedgerInput = {
      email: [
        emailEntry({ template_id: 'ALERT_RED', sent_at_offset_days: 3 }), // recent — excluded
        emailEntry({ template_id: 'ALERT_ORANGE', sent_at_offset_days: 100 }), // stale — included
      ],
      sms: [],
      push: [],
    };
    const r = summarizeNotificationTemplateFreshness('BIL', ledgers, NOW);
    for (const t of r.templates_needing_attention) {
      expect(['never_sent', 'stale']).toContain(t.freshness);
    }
    // Recent + stable excluded
    const allFresh = r.templates_needing_attention.map((t) => t.freshness);
    expect(allFresh).not.toContain('recent');
    expect(allFresh).not.toContain('stable');
  });

  test('attention list capped at MAX_STALE_TEMPLATES_LIST', () => {
    const r = summarizeNotificationTemplateFreshness('BIL', emptyLedgers(), NOW);
    // catalog has 12 templates total; cap is 20 so all 12 fit
    expect(r.templates_needing_attention.length).toBeLessThanOrEqual(MAX_STALE_TEMPLATES_LIST);
  });
});

// ─── transport adapter ─────────────────────────────────────────────

describe('M10.19 — transport adapter (tenant scoping)', () => {
  test('drains via transports + tenant-scopes BIL ↔ BANK_DEMO', () => {
    const email = new StubEmailTransport();
    const sms = new StubSmsTransport();
    const push = new StubPushTransport();
    // Stub the transports with NOW so timestamps are deterministic
    // Simulate sends via inserting directly into ledger — easier than
    // figuring out the full send-shape; the resolver only reads .recent().
    // Instead, use the resolver's pure path with mocked recent() output.
    const customEmail = {
      send: email.send.bind(email),
      recent: (tenant_id: string | null, _limit?: number) => {
        if (tenant_id === 'BIL') {
          return [emailEntry({ template_id: 'ALERT_RED', sent_at_offset_days: 5 })];
        }
        return [];
      },
    } as typeof email;
    const r = summarizeNotificationTemplateFreshnessFromTransports(
      customEmail,
      sms,
      push,
      'BIL',
      NOW,
    );
    expect(r.recent_count).toBe(1);
    const bank = summarizeNotificationTemplateFreshnessFromTransports(
      customEmail,
      sms,
      push,
      'BANK_DEMO',
      NOW,
    );
    expect(bank.recent_count).toBe(0);
  });

  test('transport adapter rejects empty tenant_id', () => {
    const email = new StubEmailTransport();
    const sms = new StubSmsTransport();
    const push = new StubPushTransport();
    expect(() =>
      summarizeNotificationTemplateFreshnessFromTransports(email, sms, push, '', NOW),
    ).toThrow(TemplateFreshnessError);
  });
});

// ─── HTTP route ─────────────────────────────────────────────────────

function makeFreshApp(role = 'admin') {
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

describe('M10.19 — GET /v1/notifications/template-freshness', () => {
  test('admin → 200 with envelope shape (empty store → all never_sent)', async () => {
    const { app } = makeFreshApp('admin');
    const r = await request(app)
      .get('/v1/notifications/template-freshness')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.total_templates).toBeGreaterThan(0);
    expect(r.body.body.never_sent_count).toBe(r.body.body.total_templates);
    expect(r.body.body.fresh_days).toBe(14);
    expect(r.body.body.stale_days).toBe(60);
  });

  test('populated → reflects send via real transport', async () => {
    const { app, emailTransport } = makeFreshApp('admin');
    // Fire a valid email send with the right template vars for ALERT_RED
    await emailTransport.send('BIL', {
      to: ['someone@example.com'],
      template_id: 'ALERT_RED',
      template_vars: {
        customer_name: 'Test',
        indicator: 'FIN-001',
        risk_score: '85',
        case_id: 'C-1',
      },
    });
    const r = await request(app)
      .get('/v1/notifications/template-freshness')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    // StubEmailTransport.send uses real Date.now(); test environment
    // clock should be close to NOW (2026-05-23) so the send lands as
    // "recent" — but be defensive: as long as ALERT_RED is not
    // never_sent any more, the send was recorded.
    const alertRed = r.body.body.templates.find(
      (t: { channel: string; template_id: string }) =>
        t.channel === 'email' && t.template_id === 'ALERT_RED',
    );
    expect(alertRed.last_sent_at).not.toBeNull();
    expect(alertRed.total_sends_observed).toBeGreaterThanOrEqual(1);
  });

  test('?fresh_days=7 + ?stale_days=30 reflected in envelope', async () => {
    const { app } = makeFreshApp('admin');
    const r = await request(app)
      .get('/v1/notifications/template-freshness?fresh_days=7&stale_days=30')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.fresh_days).toBe(7);
    expect(r.body.body.stale_days).toBe(30);
  });

  test('?fresh_days=-1 → 400 EWS_400_invalid_input', async () => {
    const { app } = makeFreshApp('admin');
    const r = await request(app)
      .get('/v1/notifications/template-freshness?fresh_days=-1')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?stale_days < fresh_days → 400', async () => {
    const { app } = makeFreshApp('admin');
    const r = await request(app)
      .get('/v1/notifications/template-freshness?fresh_days=60&stale_days=14')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeFreshApp('case_owner');
    const r = await request(app)
      .get('/v1/notifications/template-freshness')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('400 when no tenant header', async () => {
    const { app } = makeFreshApp('admin');
    const r = await request(app).get('/v1/notifications/template-freshness');
    expect(r.status).toBe(400);
  });

  test('M10.16 /template-usage sibling still works', async () => {
    const { app } = makeFreshApp('admin');
    const r = await request(app)
      .get('/v1/notifications/template-usage')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M10.11 /templates/catalog sibling still works', async () => {
    const { app } = makeFreshApp('admin');
    const r = await request(app)
      .get('/v1/notifications/templates/catalog')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
