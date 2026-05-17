// services/bff/__tests__/notification_template_usage.test.ts
//
// T6 M10.16 — Notification template usage analytics.

import request from 'supertest';
import {
  summarizeNotificationTemplateUsage,
  summarizeNotificationTemplateUsageFromTransports,
} from '../src/notification_template_usage';
import { StubEmailTransport } from '../src/notifications/email';
import { StubSmsTransport } from '../src/notifications/sms';
import { StubPushTransport, type PushDevice } from '../src/notifications/push';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTuApp(role: string = 'admin') {
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

// Standard test template_vars per channel (must satisfy required_vars).
const EMAIL_RED_VARS = {
  customer_name: 'Alice',
  indicator: 'FIN-001',
  risk_score: '85',
  case_id: 'C-1',
};
const SMS_OTP_VARS = { otp: '123456', minutes_valid: '5' };
const PUSH_OTP_VARS = { otp: '123456', minutes_valid: '5' };

const PUSH_DEVICE: PushDevice = {
  device_token: 'tok-abc',
  platform: 'fcm',
  user_id: 'alice',
};

// ─── summarizeNotificationTemplateUsage — pure ───────────────────────

describe('M10.16 — empty input', () => {
  test('zero sends → every catalog template emitted at 0', () => {
    const s = summarizeNotificationTemplateUsage('BIL', [], [], [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_sent_all_templates).toBe(0);
    expect(s.total_templates_in_catalog).toBe(12); // 4 email + 4 sms + 4 push
    expect(s.total_templates_used).toBe(0);
    expect(s.templates.length).toBe(12);
    for (const row of s.templates) {
      expect(row.total_sent).toBe(0);
      expect(row.distinct_recipients).toBe(0);
      expect(row.most_recent_sent_at).toBeNull();
    }
    expect(s.most_used_template).toBeNull();
    expect(s.unused_templates.length).toBe(12);
    expect(s.stale_templates).toEqual([]);
    expect(s.by_channel.email.catalog_count).toBe(4);
    expect(s.by_channel.sms.catalog_count).toBe(4);
    expect(s.by_channel.push.catalog_count).toBe(4);
  });
});

describe('M10.16 — catalog coverage', () => {
  test('every catalog template surfaces in templates[]', () => {
    const s = summarizeNotificationTemplateUsage('BIL', [], [], [], NOW);
    const ids = s.templates.map((t) => t.template_id);
    // Sanity: known BIL canned templates.
    expect(ids).toContain('ALERT_RED');
    expect(ids).toContain('ALERT_ORANGE');
    expect(ids).toContain('ALERT_RED_BRIEF');
    expect(ids).toContain('OTP_LOGIN');
    expect(ids).toContain('ALERT_RED_PUSH');
    expect(ids).toContain('OTP_CONFIRM');
  });
});

describe('M10.16 — single email send', () => {
  test('one templated email → that row bumped + others stay 0', async () => {
    const t = new StubEmailTransport({ now: () => NOW });
    await t.send('BIL', { to: ['alice@bil.com'], template_id: 'ALERT_RED', template_vars: EMAIL_RED_VARS });
    const s = summarizeNotificationTemplateUsage(
      'BIL', t.recent('BIL', 500), [], [], NOW,
    );
    expect(s.total_sent_all_templates).toBe(1);
    expect(s.total_templates_used).toBe(1);
    const alert_red = s.templates.find((t) => t.template_id === 'ALERT_RED')!;
    expect(alert_red.total_sent).toBe(1);
    expect(alert_red.distinct_recipients).toBe(1);
    expect(alert_red.most_recent_sent_at).toBe(NOW.toISOString());
    const other = s.templates.find((t) => t.template_id === 'ALERT_ORANGE')!;
    expect(other.total_sent).toBe(0);
  });
});

describe('M10.16 — multi-channel mixed', () => {
  test('sends across all 3 channels each populate their template row', async () => {
    const e = new StubEmailTransport({ now: () => NOW });
    const sms = new StubSmsTransport({ now: () => NOW });
    const pu = new StubPushTransport({ now: () => NOW });
    await e.send('BIL', { to: ['alice@bil.com'], template_id: 'ALERT_RED', template_vars: EMAIL_RED_VARS });
    await sms.send('BIL', { to: '+254700111222', template_id: 'OTP_LOGIN', template_vars: SMS_OTP_VARS });
    await pu.send('BIL', { to: [PUSH_DEVICE], template_id: 'OTP_CONFIRM', template_vars: PUSH_OTP_VARS });
    const s = summarizeNotificationTemplateUsage(
      'BIL', e.recent('BIL', 500), sms.recent('BIL', 500), pu.recent('BIL', 500), NOW,
    );
    expect(s.total_sent_all_templates).toBe(3);
    expect(s.total_templates_used).toBe(3);
    expect(s.templates.find((t) => t.template_id === 'ALERT_RED')!.total_sent).toBe(1);
    expect(s.templates.find((t) => t.template_id === 'OTP_LOGIN')!.total_sent).toBe(1);
    expect(s.templates.find((t) => t.template_id === 'OTP_CONFIRM')!.total_sent).toBe(1);
  });
});

describe('M10.16 — email multi-address recipient counting', () => {
  test('one send to to=[a, b] → distinct_recipients=2', async () => {
    const e = new StubEmailTransport({ now: () => NOW });
    await e.send('BIL', {
      to: ['alice@bil.com', 'bob@bil.com'],
      template_id: 'ALERT_RED',
      template_vars: EMAIL_RED_VARS,
    });
    const s = summarizeNotificationTemplateUsage('BIL', e.recent('BIL', 500), [], [], NOW);
    const row = s.templates.find((t) => t.template_id === 'ALERT_RED')!;
    expect(row.total_sent).toBe(1);
    expect(row.distinct_recipients).toBe(2);
  });
});

describe('M10.16 — push user-level distinct counting', () => {
  test('fan-out to N devices of same user_id counts as 1 recipient per send', async () => {
    const pu = new StubPushTransport({ now: () => NOW });
    await pu.send('BIL', {
      to: [
        { device_token: 'dev1', platform: 'fcm', user_id: 'alice' },
        { device_token: 'dev2', platform: 'apns', user_id: 'alice' },
        { device_token: 'dev3', platform: 'fcm', user_id: 'bob' },
      ],
      template_id: 'OTP_CONFIRM',
      template_vars: PUSH_OTP_VARS,
    });
    const s = summarizeNotificationTemplateUsage('BIL', [], [], pu.recent('BIL', 500), NOW);
    const row = s.templates.find((t) => t.template_id === 'OTP_CONFIRM')!;
    expect(row.total_sent).toBe(1);
    expect(row.distinct_recipients).toBe(2); // alice + bob (alice's 2 devices = 1)
  });
});

describe('M10.16 — multiple sends accumulate', () => {
  test('3 sends of same template → total_sent=3 and distinct recipients dedup', async () => {
    const sms = new StubSmsTransport({ now: () => NOW });
    await sms.send('BIL', { to: '+254700111222', template_id: 'OTP_LOGIN', template_vars: SMS_OTP_VARS });
    await sms.send('BIL', { to: '+254700111222', template_id: 'OTP_LOGIN', template_vars: SMS_OTP_VARS });
    await sms.send('BIL', { to: '+254700333444', template_id: 'OTP_LOGIN', template_vars: SMS_OTP_VARS });
    const s = summarizeNotificationTemplateUsage('BIL', [], sms.recent('BIL', 500), [], NOW);
    const row = s.templates.find((t) => t.template_id === 'OTP_LOGIN')!;
    expect(row.total_sent).toBe(3);
    expect(row.distinct_recipients).toBe(2);
  });
});

describe('M10.16 — untemplated sends excluded', () => {
  test('email with no template_id contributes nothing to template totals', async () => {
    const e = new StubEmailTransport({ now: () => NOW });
    // Ad-hoc untemplated send.
    await e.send('BIL', {
      to: ['alice@bil.com'],
      subject: 'Ad hoc',
      body_text: 'Ad hoc body',
    });
    const s = summarizeNotificationTemplateUsage('BIL', e.recent('BIL', 500), [], [], NOW);
    expect(s.total_sent_all_templates).toBe(0);
    expect(s.total_templates_used).toBe(0);
  });
});

describe('M10.16 — most_recent_sent_at', () => {
  test('newest sent_at across this template wins', async () => {
    const past = new Date('2026-05-10T10:00:00.000Z');
    const recent = new Date('2026-05-16T10:00:00.000Z');
    const e1 = new StubEmailTransport({ now: () => past });
    await e1.send('BIL', { to: ['alice@bil.com'], template_id: 'ALERT_RED', template_vars: EMAIL_RED_VARS });
    const e2 = new StubEmailTransport({ now: () => recent });
    await e2.send('BIL', { to: ['bob@bil.com'], template_id: 'ALERT_RED', template_vars: EMAIL_RED_VARS });
    const s = summarizeNotificationTemplateUsage(
      'BIL',
      [...e1.recent('BIL', 500), ...e2.recent('BIL', 500)],
      [], [], NOW,
    );
    const row = s.templates.find((t) => t.template_id === 'ALERT_RED')!;
    expect(row.most_recent_sent_at).toBe(recent.toISOString());
  });
});

describe('M10.16 — unused_templates', () => {
  test('every template with total_sent=0 appears in unused_templates', async () => {
    const e = new StubEmailTransport({ now: () => NOW });
    await e.send('BIL', { to: ['a@b.com'], template_id: 'ALERT_RED', template_vars: EMAIL_RED_VARS });
    const s = summarizeNotificationTemplateUsage('BIL', e.recent('BIL', 500), [], [], NOW);
    // 12 catalog templates - 1 used = 11 unused.
    expect(s.unused_templates.length).toBe(11);
    expect(s.unused_templates.find((t) => t.template_id === 'ALERT_RED')).toBeUndefined();
    expect(s.unused_templates.find((t) => t.template_id === 'ALERT_ORANGE')).toBeDefined();
  });
});

describe('M10.16 — most_used_template', () => {
  test('points at template with highest total_sent', async () => {
    const e = new StubEmailTransport({ now: () => NOW });
    await e.send('BIL', { to: ['a@b.com'], template_id: 'ALERT_RED', template_vars: EMAIL_RED_VARS });
    await e.send('BIL', { to: ['a@b.com'], template_id: 'ALERT_RED', template_vars: EMAIL_RED_VARS });
    await e.send('BIL', { to: ['a@b.com'], template_id: 'ALERT_RED', template_vars: EMAIL_RED_VARS });
    await e.send('BIL', { to: ['a@b.com'], template_id: 'ALERT_ORANGE', template_vars: EMAIL_RED_VARS });
    const s = summarizeNotificationTemplateUsage('BIL', e.recent('BIL', 500), [], [], NOW);
    expect(s.most_used_template).toEqual({
      template_id: 'ALERT_RED',
      channel: 'email',
      total_sent: 3,
    });
  });

  test('canonical iteration tie-break: first template in templates[] order wins at same count', async () => {
    const e = new StubEmailTransport({ now: () => NOW });
    await e.send('BIL', { to: ['a@b.com'], template_id: 'ALERT_RED', template_vars: EMAIL_RED_VARS });
    await e.send('BIL', { to: ['a@b.com'], template_id: 'ALERT_ORANGE', template_vars: EMAIL_RED_VARS });
    const s = summarizeNotificationTemplateUsage('BIL', e.recent('BIL', 500), [], [], NOW);
    // Both at 1; canonical templates[] order picks whichever is first.
    expect(s.most_used_template).not.toBeNull();
    expect(s.most_used_template!.total_sent).toBe(1);
  });

  test('null on empty', () => {
    const s = summarizeNotificationTemplateUsage('BIL', [], [], [], NOW);
    expect(s.most_used_template).toBeNull();
  });
});

describe('M10.16 — by_channel rollup', () => {
  test('per-channel total_sent + used_count + catalog_count consistent', async () => {
    const e = new StubEmailTransport({ now: () => NOW });
    const sms = new StubSmsTransport({ now: () => NOW });
    await e.send('BIL', { to: ['a@b.com'], template_id: 'ALERT_RED', template_vars: EMAIL_RED_VARS });
    await e.send('BIL', { to: ['a@b.com'], template_id: 'ALERT_ORANGE', template_vars: EMAIL_RED_VARS });
    await sms.send('BIL', { to: '+254700111222', template_id: 'OTP_LOGIN', template_vars: SMS_OTP_VARS });
    const s = summarizeNotificationTemplateUsage('BIL', e.recent('BIL', 500), sms.recent('BIL', 500), [], NOW);
    expect(s.by_channel.email.total_sent).toBe(2);
    expect(s.by_channel.email.used_count).toBe(2); // ALERT_RED + ALERT_ORANGE
    expect(s.by_channel.email.catalog_count).toBe(4);
    expect(s.by_channel.sms.total_sent).toBe(1);
    expect(s.by_channel.sms.used_count).toBe(1);
    expect(s.by_channel.sms.catalog_count).toBe(4);
    expect(s.by_channel.push.total_sent).toBe(0);
    expect(s.by_channel.push.used_count).toBe(0);
    expect(s.by_channel.push.catalog_count).toBe(4);
  });
});

describe('M10.16 — partition invariant', () => {
  test('Σ templates.total_sent = total_sent_all_templates; per-channel totals add up', async () => {
    const e = new StubEmailTransport({ now: () => NOW });
    const sms = new StubSmsTransport({ now: () => NOW });
    const pu = new StubPushTransport({ now: () => NOW });
    await e.send('BIL', { to: ['a@b.com'], template_id: 'ALERT_RED', template_vars: EMAIL_RED_VARS });
    await sms.send('BIL', { to: '+254700111222', template_id: 'OTP_LOGIN', template_vars: SMS_OTP_VARS });
    await pu.send('BIL', { to: [PUSH_DEVICE], template_id: 'OTP_CONFIRM', template_vars: PUSH_OTP_VARS });
    const s = summarizeNotificationTemplateUsage(
      'BIL', e.recent('BIL', 500), sms.recent('BIL', 500), pu.recent('BIL', 500), NOW,
    );
    const sum = s.templates.reduce((acc, t) => acc + t.total_sent, 0);
    expect(sum).toBe(s.total_sent_all_templates);
    expect(s.by_channel.email.total_sent + s.by_channel.sms.total_sent + s.by_channel.push.total_sent).toBe(
      s.total_sent_all_templates,
    );
  });
});

describe('M10.16 — stale_templates', () => {
  test('templates used > 30 days ago surface as stale (oldest-first)', async () => {
    const veryOld = new Date('2026-04-01T10:00:00.000Z'); // > 30 days before NOW (May 17)
    const old = new Date('2026-04-10T10:00:00.000Z');
    const recent = new Date('2026-05-15T10:00:00.000Z'); // 2 days ago; NOT stale
    const e1 = new StubEmailTransport({ now: () => veryOld });
    const e2 = new StubEmailTransport({ now: () => old });
    const e3 = new StubEmailTransport({ now: () => recent });
    await e1.send('BIL', { to: ['a@b.com'], template_id: 'ALERT_RED', template_vars: EMAIL_RED_VARS });
    await e2.send('BIL', { to: ['a@b.com'], template_id: 'ALERT_ORANGE', template_vars: EMAIL_RED_VARS });
    await e3.send('BIL', { to: ['a@b.com'], template_id: 'CASE_ASSIGNED', template_vars: { case_id: 'C-1', customer_name: 'Alice', assignee_name: 'Bob', sla_hours: '24' } });
    const s = summarizeNotificationTemplateUsage(
      'BIL',
      [...e1.recent('BIL', 500), ...e2.recent('BIL', 500), ...e3.recent('BIL', 500)],
      [], [], NOW,
    );
    // ALERT_RED (very old) + ALERT_ORANGE (old) both stale.
    // CASE_ASSIGNED (recent) NOT stale.
    expect(s.stale_templates.map((t) => t.template_id)).toEqual(['ALERT_RED', 'ALERT_ORANGE']);
  });

  test('unused templates not stale (total_sent=0 → no most_recent_sent_at)', () => {
    const s = summarizeNotificationTemplateUsage('BIL', [], [], [], NOW);
    expect(s.stale_templates).toEqual([]);
  });
});

describe('M10.16 — total_templates_in_catalog matches catalog size', () => {
  test('catalog has exactly 12 templates (4 + 4 + 4)', () => {
    const s = summarizeNotificationTemplateUsage('BIL', [], [], [], NOW);
    expect(s.total_templates_in_catalog).toBe(12);
  });
});

// ─── summarizeNotificationTemplateUsageFromTransports ─────────────────

describe('M10.16 — from-transports helper drains tenant ledgers', () => {
  test('per-tenant scoping: tenant A doesn\'t see tenant B\'s sends', async () => {
    const e = new StubEmailTransport({ now: () => NOW });
    await e.send('BIL', { to: ['a@b.com'], template_id: 'ALERT_RED', template_vars: EMAIL_RED_VARS });
    await e.send('BANK_DEMO', { to: ['b@b.com'], template_id: 'ALERT_RED', template_vars: EMAIL_RED_VARS });
    const sms = new StubSmsTransport({ now: () => NOW });
    const pu = new StubPushTransport({ now: () => NOW });
    const bil = summarizeNotificationTemplateUsageFromTransports('BIL', e, sms, pu, NOW);
    const bank = summarizeNotificationTemplateUsageFromTransports('BANK_DEMO', e, sms, pu, NOW);
    expect(bil.total_sent_all_templates).toBe(1);
    expect(bank.total_sent_all_templates).toBe(1);
  });
});

// ─── GET /v1/notifications/template-usage ────────────────────────────

describe('M10.16 — GET /v1/notifications/template-usage', () => {
  test('admin → 200 with empty rollup on fresh tenant', async () => {
    const { app } = makeTuApp('admin');
    const r = await request(app).get('/v1/notifications/template-usage').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.total_sent_all_templates).toBe(0);
    expect(r.body.body.total_templates_in_catalog).toBe(12);
    expect(r.body.body.total_templates_used).toBe(0);
    expect(r.body.body.most_used_template).toBeNull();
    expect(r.body.body.unused_templates.length).toBe(12);
  });

  test('populated rollup reflects sends across all 3 channels', async () => {
    const { app, emailTransport, smsTransport, pushTransport } = makeTuApp('admin');
    await emailTransport.send('BIL', { to: ['a@b.com'], template_id: 'ALERT_RED', template_vars: EMAIL_RED_VARS });
    await smsTransport.send('BIL', { to: '+254700111222', template_id: 'OTP_LOGIN', template_vars: SMS_OTP_VARS });
    await pushTransport.send('BIL', { to: [PUSH_DEVICE], template_id: 'OTP_CONFIRM', template_vars: PUSH_OTP_VARS });
    const r = await request(app).get('/v1/notifications/template-usage').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_sent_all_templates).toBe(3);
    expect(r.body.body.total_templates_used).toBe(3);
    expect(r.body.body.by_channel.email.total_sent).toBe(1);
    expect(r.body.body.by_channel.sms.total_sent).toBe(1);
    expect(r.body.body.by_channel.push.total_sent).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTuApp('case_owner');
    const r = await request(app).get('/v1/notifications/template-usage').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant isolation: BIL sends invisible to BANK_DEMO', async () => {
    const { app, emailTransport } = makeTuApp('admin');
    await emailTransport.send('BIL', { to: ['a@b.com'], template_id: 'ALERT_RED', template_vars: EMAIL_RED_VARS });
    const bank = await request(app)
      .get('/v1/notifications/template-usage')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_sent_all_templates).toBe(0);
  });

  test('M10.11 sibling /v1/notifications/templates/catalog still 200', async () => {
    const { app } = makeTuApp('admin');
    const r = await request(app).get('/v1/notifications/templates/catalog').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
