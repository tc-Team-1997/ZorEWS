// services/bff/__tests__/sms_channel.test.ts
//
// T6 M10.2 — BIL SMS notification channel.

import request from 'supertest';
import {
  StubSmsTransport,
  SmsValidationError,
  getSmsTemplate,
  listSmsTemplates,
  renderSmsTemplate,
  resolveMessage,
  substitute,
} from '../src/notifications/sms';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeSmsApp(role: string = 'admin', smsTransport?: StubSmsTransport) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    smsTransport,
  });
}

// ─── Pure helpers ──────────────────────────────────────────────────────

describe('substitute()', () => {
  test('replaces {{var}} occurrences', () => {
    expect(substitute('OTP {{otp}} valid for {{m}} min', { otp: 12345, m: 5 })).toBe(
      'OTP 12345 valid for 5 min',
    );
  });
  test('leaves unmatched slots intact', () => {
    expect(substitute('Hi {{name}}, code {{otp}}', { name: 'A' })).toBe('Hi A, code {{otp}}');
  });
  test('numeric values stringified', () => {
    expect(substitute('{{n}}', { n: 0 })).toBe('0');
  });
});

describe('listSmsTemplates / getSmsTemplate', () => {
  test('exposes the 4 BIL canned SMS templates', () => {
    const ids = listSmsTemplates().map((t) => t.id).sort();
    expect(ids).toEqual(['ALERT_RED_BRIEF', 'KYC_REMINDER', 'OTP_LOGIN', 'PAYMENT_REMINDER']);
  });

  test('every template declares required_vars', () => {
    for (const t of listSmsTemplates()) {
      expect(Array.isArray(t.required_vars)).toBe(true);
      expect(t.required_vars.length).toBeGreaterThan(0);
    }
  });

  test('every template body raw is ≤ 160 chars (slot placeholders + literal)', () => {
    for (const t of listSmsTemplates()) {
      // The raw body with `{{var}}` placeholders should fit; substituted
      // values may push over for unrealistic inputs, but the template
      // surface must be reasonable.
      expect(t.body.length).toBeLessThanOrEqual(160);
    }
  });

  test('getSmsTemplate hit + miss', () => {
    expect(getSmsTemplate('OTP_LOGIN')!.id).toBe('OTP_LOGIN');
    expect(getSmsTemplate('NOPE' as never)).toBeUndefined();
  });
});

describe('renderSmsTemplate', () => {
  test('substitutes vars into body', () => {
    const r = renderSmsTemplate('OTP_LOGIN', { otp: 123456, minutes_valid: 5 });
    expect(r.body).toBe('ZorEWS login OTP: 123456. Valid for 5 minutes. Do not share.');
    expect(r.missing_vars).toEqual([]);
  });

  test('reports missing vars without throwing', () => {
    const r = renderSmsTemplate('PAYMENT_REMINDER', { policy_id: 'POL-001' });
    expect(r.missing_vars.sort()).toEqual(['amount_kes', 'due_date']);
  });

  test('throws on unknown template id', () => {
    expect(() => renderSmsTemplate('NOPE' as never)).toThrow(/unknown template/);
  });
});

describe('resolveMessage', () => {
  test('template path renders body', () => {
    const r = resolveMessage({
      to: '+254712345678',
      template_id: 'OTP_LOGIN',
      template_vars: { otp: 123456, minutes_valid: 5 },
    });
    expect(r.body).toContain('OTP: 123456');
    expect(r.template_id).toBe('OTP_LOGIN');
  });

  test('caller body overrides template body', () => {
    const r = resolveMessage({
      to: '+254712345678',
      body: 'Custom body',
      template_id: 'OTP_LOGIN',
      template_vars: { otp: 1, minutes_valid: 5 },
    });
    expect(r.body).toBe('Custom body');
  });

  test('explicit body without template works', () => {
    const r = resolveMessage({ to: '+254712345678', body: 'Hello world' });
    expect(r.body).toBe('Hello world');
    expect(r.template_id).toBeUndefined();
  });

  test('rejects non-E.164 phone', () => {
    expect(() => resolveMessage({ to: '0712345678', body: 'x' })).toThrow(/E\.164/);
    expect(() => resolveMessage({ to: 'not-a-phone', body: 'x' })).toThrow(/E\.164/);
    expect(() => resolveMessage({ to: '+0123', body: 'x' })).toThrow(/E\.164/);
  });

  test('accepts E.164 numbers across countries', () => {
    expect(() => resolveMessage({ to: '+14155551234', body: 'x' })).not.toThrow();
    expect(() => resolveMessage({ to: '+447400123456', body: 'x' })).not.toThrow();
    expect(() => resolveMessage({ to: '+919876543210', body: 'x' })).not.toThrow();
  });

  test('rejects body > 160 chars', () => {
    expect(() => resolveMessage({ to: '+254712345678', body: 'a'.repeat(161) })).toThrow(
      /≤ 160/,
    );
  });

  test('rejects template missing required vars', () => {
    expect(() =>
      resolveMessage({
        to: '+254712345678',
        template_id: 'PAYMENT_REMINDER',
        template_vars: { policy_id: 'POL-001' },
      }),
    ).toThrow(/template PAYMENT_REMINDER requires/);
  });

  test('rejects when neither body nor template supplied', () => {
    expect(() => resolveMessage({ to: '+254712345678' })).toThrow(/body is required/);
  });

  test('error type carries machine-readable code', () => {
    try {
      resolveMessage({ to: 'bad', body: 'x' });
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SmsValidationError);
      expect((e as SmsValidationError).code).toBe('invalid_recipient');
    }
  });
});

// ─── StubSmsTransport ──────────────────────────────────────────────────

describe('StubSmsTransport', () => {
  test('send() records entry and returns receipt; segments=1', async () => {
    const t = new StubSmsTransport({ now: () => NOW });
    const r = await t.send('BIL', { to: '+254712345678', body: 'hi' });
    expect(r.message_id).toMatch(/^sms-/);
    expect(r.status).toBe('sent');
    expect(r.transport).toBe('stub');
    expect(r.segments).toBe(1);
    expect(r.sent_at).toBe(NOW.toISOString());
  });

  test('recent() newest-first within tenant', async () => {
    const t = new StubSmsTransport({ now: () => NOW });
    await t.send('BIL', { to: '+254712345678', body: 'first' });
    await t.send('BIL', { to: '+254712345678', body: 'second' });
    await t.send('BIL', { to: '+254712345678', body: 'third' });
    const log = t.recent('BIL');
    expect(log.map((l) => l.body)).toEqual(['third', 'second', 'first']);
  });

  test('recent() scopes to tenant', async () => {
    const t = new StubSmsTransport({ now: () => NOW });
    await t.send('BIL', { to: '+254712345678', body: 'bil' });
    await t.send('BANK_DEMO', { to: '+254712345678', body: 'bank' });
    expect(t.recent('BIL').map((l) => l.body)).toEqual(['bil']);
    expect(t.recent('BANK_DEMO').map((l) => l.body)).toEqual(['bank']);
    expect(t.recent(null).length).toBe(2);
  });

  test('recent(limit) caps the result', async () => {
    const t = new StubSmsTransport({ now: () => NOW });
    for (let i = 0; i < 5; i++) {
      await t.send('BIL', { to: '+254712345678', body: `s-${i}` });
    }
    expect(t.recent('BIL', 2).length).toBe(2);
  });

  test('cap evicts oldest', async () => {
    const t = new StubSmsTransport({ cap: 3, now: () => NOW });
    for (let i = 0; i < 5; i++) {
      await t.send('BIL', { to: '+254712345678', body: `s-${i}` });
    }
    const log = t.recent('BIL');
    expect(log.length).toBe(3);
    expect(log.map((l) => l.body)).toEqual(['s-4', 's-3', 's-2']);
  });

  test('preserves template_id + correlations in ledger', async () => {
    const t = new StubSmsTransport({ now: () => NOW });
    await t.send('BIL', {
      to: '+254712345678',
      template_id: 'ALERT_RED_BRIEF',
      template_vars: { customer_name: 'A', case_id: 'C-1' },
      related_alert_id: 'ALERT-1',
      related_case_id: 'C-1',
    });
    const [entry] = t.recent('BIL');
    expect(entry!.template_id).toBe('ALERT_RED_BRIEF');
    expect(entry!.related_alert_id).toBe('ALERT-1');
    expect(entry!.related_case_id).toBe('C-1');
  });

  test('send rejects bad input via SmsValidationError', async () => {
    const t = new StubSmsTransport();
    await expect(t.send('BIL', { to: '0712345678', body: 'x' })).rejects.toBeInstanceOf(
      SmsValidationError,
    );
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/notifications/sms/templates', () => {
  test('analyst+ can list', async () => {
    const { app } = makeSmsApp('risk_analyst');
    const r = await request(app).get('/v1/notifications/sms/templates').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(4);
  });

  test('unknown role → 403', async () => {
    const { app } = makeSmsApp('case_owner');
    const r = await request(app).get('/v1/notifications/sms/templates').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/notifications/sms/preview', () => {
  test('renders template with vars', async () => {
    const { app } = makeSmsApp('risk_analyst');
    const r = await request(app)
      .post('/v1/notifications/sms/preview')
      .set(TH_BIL)
      .send({ template_id: 'OTP_LOGIN', template_vars: { otp: 123456, minutes_valid: 5 } });
    expect(r.status).toBe(200);
    expect(r.body.body.body).toContain('OTP: 123456');
  });

  test('reports missing vars (no throw)', async () => {
    const { app } = makeSmsApp('risk_analyst');
    const r = await request(app)
      .post('/v1/notifications/sms/preview')
      .set(TH_BIL)
      .send({ template_id: 'PAYMENT_REMINDER', template_vars: { policy_id: 'X' } });
    expect(r.status).toBe(200);
    expect(r.body.body.missing_vars.sort()).toEqual(['amount_kes', 'due_date']);
  });

  test('missing template_id → 400', async () => {
    const { app } = makeSmsApp('risk_analyst');
    const r = await request(app).post('/v1/notifications/sms/preview').set(TH_BIL).send({});
    expect(r.status).toBe(400);
  });

  test('unknown template → 400 EWS_400_unknown_template', async () => {
    const { app } = makeSmsApp('risk_analyst');
    const r = await request(app)
      .post('/v1/notifications/sms/preview')
      .set(TH_BIL)
      .send({ template_id: 'BOGUS' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_unknown_template');
  });
});

describe('POST /v1/notifications/sms/send', () => {
  test('admin: 201 with receipt + log visible', async () => {
    const transport = new StubSmsTransport({ now: () => NOW });
    const { app } = makeSmsApp('admin', transport);
    const send = await request(app)
      .post('/v1/notifications/sms/send')
      .set(TH_BIL)
      .send({
        to: '+254712345678',
        template_id: 'OTP_LOGIN',
        template_vars: { otp: 654321, minutes_valid: 5 },
      });
    expect(send.status).toBe(201);
    expect(send.body.body.receipt.status).toBe('sent');
    expect(send.body.body.receipt.segments).toBe(1);
    const log = await request(app).get('/v1/notifications/sms/log').set(TH_BIL);
    expect(log.status).toBe(200);
    expect(log.body.body.total).toBe(1);
    expect(log.body.body.items[0].body).toContain('OTP: 654321');
  });

  test('non-admin (risk_analyst lacks audit:read) → 403', async () => {
    const { app } = makeSmsApp('risk_analyst');
    const r = await request(app)
      .post('/v1/notifications/sms/send')
      .set(TH_BIL)
      .send({ to: '+254712345678', body: 'x' });
    expect(r.status).toBe(403);
  });

  test('invalid phone → 400 EWS_400_invalid_recipient', async () => {
    const { app } = makeSmsApp('admin');
    const r = await request(app)
      .post('/v1/notifications/sms/send')
      .set(TH_BIL)
      .send({ to: '0712345678', body: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_recipient');
  });

  test('body > 160 → 400 EWS_400_body_too_long', async () => {
    const { app } = makeSmsApp('admin');
    const r = await request(app)
      .post('/v1/notifications/sms/send')
      .set(TH_BIL)
      .send({ to: '+254712345678', body: 'a'.repeat(161) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_body_too_long');
  });

  test('template missing vars → 400 EWS_400_missing_template_vars', async () => {
    const { app } = makeSmsApp('admin');
    const r = await request(app)
      .post('/v1/notifications/sms/send')
      .set(TH_BIL)
      .send({
        to: '+254712345678',
        template_id: 'PAYMENT_REMINDER',
        template_vars: { policy_id: 'X' },
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_missing_template_vars');
  });

  test('accepts an enveloped request body', async () => {
    const transport = new StubSmsTransport({ now: () => NOW });
    const { app } = makeSmsApp('admin', transport);
    const r = await request(app)
      .post('/v1/notifications/sms/send')
      .set(TH_BIL)
      .send({
        header: { requestId: 'r-1' },
        body: { to: '+254712345678', body: 'enveloped' },
      });
    expect(r.status).toBe(201);
    expect(transport.recent('BIL')[0]!.body).toBe('enveloped');
  });
});

describe('GET /v1/notifications/sms/log — tenant scoping', () => {
  test('BIL admin only sees BIL entries', async () => {
    const transport = new StubSmsTransport({ now: () => NOW });
    const { app } = makeSmsApp('admin', transport);
    await request(app)
      .post('/v1/notifications/sms/send')
      .set(TH_BIL)
      .send({ to: '+254712345678', body: 'bil-only' });
    await request(app)
      .post('/v1/notifications/sms/send')
      .set(TH_BANK)
      .send({ to: '+254712345678', body: 'bank-only' });
    const bil = await request(app).get('/v1/notifications/sms/log').set(TH_BIL);
    const bank = await request(app).get('/v1/notifications/sms/log').set(TH_BANK);
    expect(bil.body.body.items.map((i: { body: string }) => i.body)).toEqual(['bil-only']);
    expect(bank.body.body.items.map((i: { body: string }) => i.body)).toEqual(['bank-only']);
  });

  test('?limit caps the response', async () => {
    const transport = new StubSmsTransport({ now: () => NOW });
    const { app } = makeSmsApp('admin', transport);
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/v1/notifications/sms/send')
        .set(TH_BIL)
        .send({ to: '+254712345678', body: `s-${i}` });
    }
    const r = await request(app).get('/v1/notifications/sms/log?limit=2').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.items.length).toBe(2);
    expect(r.body.body.limit).toBe(2);
  });

  test('non-admin → 403', async () => {
    const { app } = makeSmsApp('risk_analyst');
    const r = await request(app).get('/v1/notifications/sms/log').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});
