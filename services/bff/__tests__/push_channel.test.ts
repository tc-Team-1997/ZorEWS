// services/bff/__tests__/push_channel.test.ts
//
// T6 M10.3 — BIL push notification channel.

import request from 'supertest';
import {
  StubPushTransport,
  PushValidationError,
  getPushTemplate,
  listPushTemplates,
  renderPushTemplate,
  resolveMessage,
  substitute,
  isPushPlatform,
  type PushDevice,
} from '../src/notifications/push';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makePushApp(role: string = 'admin', pushTransport?: StubPushTransport) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    pushTransport,
  });
}

const ANDROID: PushDevice = { device_token: 'fcm-tok-1', platform: 'fcm', user_id: 'taniya' };
const IPHONE: PushDevice = { device_token: 'apns-tok-1', platform: 'apns', user_id: 'taniya' };
const WEB: PushDevice = { device_token: 'web-tok-1', platform: 'web', user_id: 'taniya' };

// ─── Pure helpers ──────────────────────────────────────────────────────

describe('isPushPlatform / substitute', () => {
  test('isPushPlatform accepts the 3 valid platforms', () => {
    expect(isPushPlatform('fcm')).toBe(true);
    expect(isPushPlatform('apns')).toBe(true);
    expect(isPushPlatform('web')).toBe(true);
    expect(isPushPlatform('FCM')).toBe(false);
    expect(isPushPlatform('windows')).toBe(false);
  });

  test('substitute replaces {{var}} occurrences', () => {
    expect(substitute('Code {{otp}}', { otp: 12345 })).toBe('Code 12345');
  });

  test('substitute leaves unmatched slots intact', () => {
    expect(substitute('Hi {{name}} ({{role}})', { name: 'A' })).toBe('Hi A ({{role}})');
  });
});

describe('listPushTemplates / getPushTemplate', () => {
  test('exposes the 4 BIL canned templates', () => {
    const ids = listPushTemplates().map((t) => t.id).sort();
    expect(ids).toEqual(['ALERT_RED_PUSH', 'NEW_CASE_ASSIGNED', 'OTP_CONFIRM', 'REPORT_READY']);
  });

  test('every template declares required_vars + title + body', () => {
    for (const t of listPushTemplates()) {
      expect(Array.isArray(t.required_vars)).toBe(true);
      expect(typeof t.title).toBe('string');
      expect(typeof t.body).toBe('string');
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.body.length).toBeGreaterThan(0);
    }
  });

  test('template title raw ≤ 100 chars; body ≤ 240 chars', () => {
    for (const t of listPushTemplates()) {
      expect(t.title.length).toBeLessThanOrEqual(100);
      expect(t.body.length).toBeLessThanOrEqual(240);
    }
  });

  test('getPushTemplate hit + miss', () => {
    expect(getPushTemplate('ALERT_RED_PUSH')!.id).toBe('ALERT_RED_PUSH');
    expect(getPushTemplate('NOPE' as never)).toBeUndefined();
  });
});

describe('renderPushTemplate', () => {
  test('substitutes vars into title + body', () => {
    const r = renderPushTemplate('ALERT_RED_PUSH', { customer_name: 'Asha', case_id: 'CASE-1' });
    expect(r.title).toBe('APEX RED Alert');
    expect(r.body).toContain('Asha');
    expect(r.body).toContain('CASE-1');
    expect(r.missing_vars).toEqual([]);
  });

  test('reports missing required vars without throwing', () => {
    const r = renderPushTemplate('ALERT_RED_PUSH', { customer_name: 'X' });
    expect(r.missing_vars).toEqual(['case_id']);
  });

  test('throws on unknown template id', () => {
    expect(() => renderPushTemplate('NOPE' as never)).toThrow(/unknown template/);
  });
});

describe('resolveMessage', () => {
  test('template path renders title + body', () => {
    const r = resolveMessage({
      to: [ANDROID],
      template_id: 'OTP_CONFIRM',
      template_vars: { otp: 654321, minutes_valid: 5 },
    });
    expect(r.title).toBe('Confirm your action');
    expect(r.body).toContain('654321');
    expect(r.template_id).toBe('OTP_CONFIRM');
  });

  test('caller-supplied title + body override template', () => {
    const r = resolveMessage({
      to: [ANDROID],
      title: 'Custom title',
      body: 'Custom body',
      template_id: 'OTP_CONFIRM',
      template_vars: { otp: 1, minutes_valid: 5 },
    });
    expect(r.title).toBe('Custom title');
    expect(r.body).toBe('Custom body');
  });

  test('explicit title + body without template works', () => {
    const r = resolveMessage({ to: [WEB], title: 'Hi', body: 'World' });
    expect(r.title).toBe('Hi');
    expect(r.body).toBe('World');
    expect(r.template_id).toBeUndefined();
  });

  test('rejects empty devices', () => {
    expect(() => resolveMessage({ to: [], title: 'x', body: 'y' })).toThrow(/at least one/);
  });

  test('rejects > 1000 devices', () => {
    const big = new Array(1001).fill(ANDROID);
    expect(() => resolveMessage({ to: big, title: 'x', body: 'y' })).toThrow(/at most 1000/);
  });

  test('rejects device with empty token', () => {
    expect(() =>
      resolveMessage({
        to: [{ device_token: '', platform: 'fcm', user_id: 'u' }],
        title: 'x',
        body: 'y',
      }),
    ).toThrow(/device_token/);
  });

  test('rejects device with invalid platform', () => {
    expect(() =>
      resolveMessage({
        to: [{ device_token: 't', platform: 'windows' as never, user_id: 'u' }],
        title: 'x',
        body: 'y',
      }),
    ).toThrow(/platform must be/);
  });

  test('rejects device with empty user_id', () => {
    expect(() =>
      resolveMessage({
        to: [{ device_token: 't', platform: 'fcm', user_id: '' }],
        title: 'x',
        body: 'y',
      }),
    ).toThrow(/user_id/);
  });

  test('rejects title > 100 chars', () => {
    expect(() =>
      resolveMessage({ to: [ANDROID], title: 'a'.repeat(101), body: 'y' }),
    ).toThrow(/title must be ≤ 100/);
  });

  test('rejects body > 240 chars', () => {
    expect(() =>
      resolveMessage({ to: [ANDROID], title: 'x', body: 'b'.repeat(241) }),
    ).toThrow(/body must be ≤ 240/);
  });

  test('rejects template missing required vars', () => {
    expect(() =>
      resolveMessage({
        to: [ANDROID],
        template_id: 'ALERT_RED_PUSH',
        template_vars: { customer_name: 'X' },
      }),
    ).toThrow(/template ALERT_RED_PUSH requires/);
  });

  test('rejects neither title+body nor template', () => {
    expect(() => resolveMessage({ to: [ANDROID] })).toThrow(/title is required/);
  });

  test('accepts deep_link as relative path', () => {
    const r = resolveMessage({ to: [ANDROID], title: 'x', body: 'y', deep_link: '/cases/123' });
    expect(r.deep_link).toBe('/cases/123');
  });

  test('accepts deep_link as https URL', () => {
    const r = resolveMessage({
      to: [ANDROID],
      title: 'x',
      body: 'y',
      deep_link: 'https://apex-ews.test/c/1',
    });
    expect(r.deep_link).toBe('https://apex-ews.test/c/1');
  });

  test('rejects deep_link as http (not https)', () => {
    expect(() =>
      resolveMessage({ to: [ANDROID], title: 'x', body: 'y', deep_link: 'http://insecure.test' }),
    ).toThrow(/deep_link/);
  });

  test('rejects deep_link not starting with / or https://', () => {
    expect(() =>
      resolveMessage({ to: [ANDROID], title: 'x', body: 'y', deep_link: 'cases/123' }),
    ).toThrow(/deep_link/);
  });

  test('rejects negative badge_count', () => {
    expect(() =>
      resolveMessage({ to: [ANDROID], title: 'x', body: 'y', badge_count: -1 }),
    ).toThrow(/badge_count/);
  });

  test('rejects non-integer badge_count', () => {
    expect(() =>
      resolveMessage({ to: [ANDROID], title: 'x', body: 'y', badge_count: 1.5 }),
    ).toThrow(/badge_count/);
  });

  test('PushValidationError carries a code', () => {
    try {
      resolveMessage({ to: [], title: 'x', body: 'y' });
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PushValidationError);
      expect((e as PushValidationError).code).toBe('no_devices');
    }
  });
});

// ─── StubPushTransport ─────────────────────────────────────────────────

describe('StubPushTransport', () => {
  test('send() records entry + returns receipt with per-device status', async () => {
    const t = new StubPushTransport({ now: () => NOW });
    const r = await t.send('BIL', { to: [ANDROID, IPHONE], title: 'Hi', body: 'World' });
    expect(r.message_id).toMatch(/^push-/);
    expect(r.status).toBe('sent');
    expect(r.transport).toBe('stub');
    expect(r.per_device.length).toBe(2);
    expect(r.per_device[0]!.device_token).toBe('fcm-tok-1');
    expect(r.per_device[0]!.status).toBe('sent');
    expect(r.per_device[1]!.platform).toBe('apns');
  });

  test('recent() newest-first within tenant', async () => {
    const t = new StubPushTransport({ now: () => NOW });
    await t.send('BIL', { to: [ANDROID], title: 'first', body: '.' });
    await t.send('BIL', { to: [ANDROID], title: 'second', body: '.' });
    await t.send('BIL', { to: [ANDROID], title: 'third', body: '.' });
    const log = t.recent('BIL');
    expect(log.map((l) => l.title)).toEqual(['third', 'second', 'first']);
  });

  test('recent() scopes to tenant', async () => {
    const t = new StubPushTransport({ now: () => NOW });
    await t.send('BIL', { to: [ANDROID], title: 'bil', body: '.' });
    await t.send('BANK_DEMO', { to: [ANDROID], title: 'bank', body: '.' });
    expect(t.recent('BIL').map((l) => l.title)).toEqual(['bil']);
    expect(t.recent('BANK_DEMO').map((l) => l.title)).toEqual(['bank']);
    expect(t.recent(null).length).toBe(2);
  });

  test('recent(limit) caps the result', async () => {
    const t = new StubPushTransport({ now: () => NOW });
    for (let i = 0; i < 5; i++) {
      await t.send('BIL', { to: [ANDROID], title: `s-${i}`, body: '.' });
    }
    expect(t.recent('BIL', 2).length).toBe(2);
  });

  test('cap evicts oldest', async () => {
    const t = new StubPushTransport({ cap: 3, now: () => NOW });
    for (let i = 0; i < 5; i++) {
      await t.send('BIL', { to: [ANDROID], title: `s-${i}`, body: '.' });
    }
    const log = t.recent('BIL');
    expect(log.length).toBe(3);
    expect(log.map((l) => l.title)).toEqual(['s-4', 's-3', 's-2']);
  });

  test('preserves template_id + correlations + deep_link in ledger', async () => {
    const t = new StubPushTransport({ now: () => NOW });
    await t.send('BIL', {
      to: [ANDROID],
      template_id: 'ALERT_RED_PUSH',
      template_vars: { customer_name: 'A', case_id: 'C-1' },
      deep_link: '/cases/C-1',
      related_alert_id: 'ALERT-1',
      related_case_id: 'C-1',
    });
    const [entry] = t.recent('BIL');
    expect(entry!.template_id).toBe('ALERT_RED_PUSH');
    expect(entry!.deep_link).toBe('/cases/C-1');
    expect(entry!.related_alert_id).toBe('ALERT-1');
  });

  test('send rejects bad input via PushValidationError', async () => {
    const t = new StubPushTransport();
    await expect(t.send('BIL', { to: [], title: 'x', body: 'y' })).rejects.toBeInstanceOf(
      PushValidationError,
    );
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/notifications/push/templates', () => {
  test('analyst+ can list', async () => {
    const { app } = makePushApp('risk_analyst');
    const r = await request(app).get('/v1/notifications/push/templates').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(4);
  });

  test('unknown role → 403', async () => {
    const { app } = makePushApp('case_owner');
    const r = await request(app).get('/v1/notifications/push/templates').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/notifications/push/preview', () => {
  test('renders template with vars', async () => {
    const { app } = makePushApp('risk_analyst');
    const r = await request(app)
      .post('/v1/notifications/push/preview')
      .set(TH_BIL)
      .send({
        template_id: 'NEW_CASE_ASSIGNED',
        template_vars: { case_id: 'C-1', customer_name: 'Asha', sla_hours: 24 },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.title).toBe('New case assigned');
    expect(r.body.body.body).toContain('C-1');
  });

  test('reports missing_vars without throwing', async () => {
    const { app } = makePushApp('risk_analyst');
    const r = await request(app)
      .post('/v1/notifications/push/preview')
      .set(TH_BIL)
      .send({ template_id: 'ALERT_RED_PUSH', template_vars: { customer_name: 'X' } });
    expect(r.status).toBe(200);
    expect(r.body.body.missing_vars).toEqual(['case_id']);
  });

  test('missing template_id → 400', async () => {
    const { app } = makePushApp('risk_analyst');
    const r = await request(app).post('/v1/notifications/push/preview').set(TH_BIL).send({});
    expect(r.status).toBe(400);
  });

  test('unknown template → 400 EWS_400_unknown_template', async () => {
    const { app } = makePushApp('risk_analyst');
    const r = await request(app)
      .post('/v1/notifications/push/preview')
      .set(TH_BIL)
      .send({ template_id: 'BOGUS' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_unknown_template');
  });
});

describe('POST /v1/notifications/push/send', () => {
  test('admin: 201 with receipt + per-device status', async () => {
    const transport = new StubPushTransport({ now: () => NOW });
    const { app } = makePushApp('admin', transport);
    const r = await request(app)
      .post('/v1/notifications/push/send')
      .set(TH_BIL)
      .send({
        to: [ANDROID, IPHONE, WEB],
        template_id: 'ALERT_RED_PUSH',
        template_vars: { customer_name: 'Asha', case_id: 'C-1' },
        deep_link: '/cases/C-1',
      });
    expect(r.status).toBe(201);
    expect(r.body.body.receipt.status).toBe('sent');
    expect(r.body.body.receipt.per_device.length).toBe(3);
  });

  test('non-admin (risk_analyst lacks audit:read) → 403', async () => {
    const { app } = makePushApp('risk_analyst');
    const r = await request(app)
      .post('/v1/notifications/push/send')
      .set(TH_BIL)
      .send({ to: [ANDROID], title: 'x', body: 'y' });
    expect(r.status).toBe(403);
  });

  test('empty devices → 400 EWS_400_no_devices', async () => {
    const { app } = makePushApp('admin');
    const r = await request(app)
      .post('/v1/notifications/push/send')
      .set(TH_BIL)
      .send({ to: [], title: 'x', body: 'y' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_no_devices');
  });

  test('invalid platform → 400 EWS_400_invalid_device', async () => {
    const { app } = makePushApp('admin');
    const r = await request(app)
      .post('/v1/notifications/push/send')
      .set(TH_BIL)
      .send({
        to: [{ device_token: 't', platform: 'windows', user_id: 'u' }],
        title: 'x',
        body: 'y',
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_device');
  });

  test('title > 100 → 400 EWS_400_title_too_long', async () => {
    const { app } = makePushApp('admin');
    const r = await request(app)
      .post('/v1/notifications/push/send')
      .set(TH_BIL)
      .send({ to: [ANDROID], title: 'a'.repeat(101), body: 'y' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_title_too_long');
  });

  test('body > 240 → 400 EWS_400_body_too_long', async () => {
    const { app } = makePushApp('admin');
    const r = await request(app)
      .post('/v1/notifications/push/send')
      .set(TH_BIL)
      .send({ to: [ANDROID], title: 'x', body: 'b'.repeat(241) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_body_too_long');
  });

  test('template missing vars → 400 EWS_400_missing_template_vars', async () => {
    const { app } = makePushApp('admin');
    const r = await request(app)
      .post('/v1/notifications/push/send')
      .set(TH_BIL)
      .send({
        to: [ANDROID],
        template_id: 'ALERT_RED_PUSH',
        template_vars: { customer_name: 'X' },
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_missing_template_vars');
  });

  test('invalid deep_link → 400 EWS_400_invalid_deep_link', async () => {
    const { app } = makePushApp('admin');
    const r = await request(app)
      .post('/v1/notifications/push/send')
      .set(TH_BIL)
      .send({ to: [ANDROID], title: 'x', body: 'y', deep_link: 'cases/123' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_deep_link');
  });

  test('accepts an enveloped request body', async () => {
    const transport = new StubPushTransport({ now: () => NOW });
    const { app } = makePushApp('admin', transport);
    const r = await request(app)
      .post('/v1/notifications/push/send')
      .set(TH_BIL)
      .send({
        header: { requestId: 'r-1' },
        body: { to: [ANDROID], title: 'enveloped', body: 'ok' },
      });
    expect(r.status).toBe(201);
    expect(transport.recent('BIL')[0]!.title).toBe('enveloped');
  });
});

describe('GET /v1/notifications/push/log — tenant scoping', () => {
  test('BIL admin only sees BIL entries', async () => {
    const transport = new StubPushTransport({ now: () => NOW });
    const { app } = makePushApp('admin', transport);
    await request(app)
      .post('/v1/notifications/push/send')
      .set(TH_BIL)
      .send({ to: [ANDROID], title: 'bil-only', body: '.' });
    await request(app)
      .post('/v1/notifications/push/send')
      .set(TH_BANK)
      .send({ to: [ANDROID], title: 'bank-only', body: '.' });
    const bil = await request(app).get('/v1/notifications/push/log').set(TH_BIL);
    const bank = await request(app).get('/v1/notifications/push/log').set(TH_BANK);
    expect(bil.body.body.items.map((i: { title: string }) => i.title)).toEqual(['bil-only']);
    expect(bank.body.body.items.map((i: { title: string }) => i.title)).toEqual(['bank-only']);
  });

  test('?limit caps the response', async () => {
    const transport = new StubPushTransport({ now: () => NOW });
    const { app } = makePushApp('admin', transport);
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/v1/notifications/push/send')
        .set(TH_BIL)
        .send({ to: [ANDROID], title: `s-${i}`, body: '.' });
    }
    const r = await request(app).get('/v1/notifications/push/log?limit=2').set(TH_BIL);
    expect(r.body.body.items.length).toBe(2);
    expect(r.body.body.limit).toBe(2);
  });

  test('non-admin → 403', async () => {
    const { app } = makePushApp('risk_analyst');
    const r = await request(app).get('/v1/notifications/push/log').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

// ─── Sanity: M10.1 + M10.2 still work ──────────────────────────────────

describe('M10.1 + M10.2 surfaces unchanged after M10.3', () => {
  test('email templates still 200', async () => {
    const { app } = makePushApp('risk_analyst');
    const r = await request(app).get('/v1/notifications/email/templates').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(4);
  });

  test('sms templates still 200', async () => {
    const { app } = makePushApp('risk_analyst');
    const r = await request(app).get('/v1/notifications/sms/templates').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(4);
  });
});
