// services/bff/__tests__/email_channel.test.ts
//
// T6 M10.1 — BIL notification email channel.
//
// Three concentric layers:
//   1. Pure renderTemplate / substitute / resolveMessage
//   2. StubEmailTransport (in-memory ledger, tenant scoping)
//   3. The four routes (send / log / templates / preview) — RBAC, envelope,
//      tenant isolation, validation error codes

import request from 'supertest';
import {
  StubEmailTransport,
  EmailValidationError,
  listTemplates,
  getTemplate,
  renderTemplate,
  resolveMessage,
  substitute,
} from '../src/notifications/email';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeEmailApp(role: string = 'admin', emailTransport?: StubEmailTransport) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    emailTransport,
  });
}

// ─── Pure helpers ──────────────────────────────────────────────────────

describe('substitute()', () => {
  test('replaces {{var}} occurrences', () => {
    expect(substitute('Hi {{name}}, score {{score}}', { name: 'Asha', score: 87 })).toBe(
      'Hi Asha, score 87',
    );
  });

  test('leaves unmatched slots intact (visible to operator)', () => {
    expect(substitute('Hi {{name}}, you missed {{count}}', { name: 'Asha' })).toBe(
      'Hi Asha, you missed {{count}}',
    );
  });

  test('handles a string with no slots', () => {
    expect(substitute('plain text')).toBe('plain text');
  });

  test('numeric values are stringified', () => {
    expect(substitute('{{n}}', { n: 0 })).toBe('0');
  });
});

describe('listTemplates() / getTemplate()', () => {
  test('exposes the 4 BIL canned templates', () => {
    const ids = listTemplates().map((t) => t.id).sort();
    expect(ids).toEqual(['ALERT_ORANGE', 'ALERT_RED', 'CASE_ASSIGNED', 'SLA_BREACH']);
  });

  test('every template declares required_vars', () => {
    for (const t of listTemplates()) {
      expect(Array.isArray(t.required_vars)).toBe(true);
      expect(t.required_vars.length).toBeGreaterThan(0);
    }
  });

  test('getTemplate returns the right one by id', () => {
    expect(getTemplate('ALERT_RED')!.id).toBe('ALERT_RED');
  });

  test('getTemplate returns undefined for unknown id', () => {
    expect(getTemplate('UNKNOWN' as never)).toBeUndefined();
  });
});

describe('renderTemplate()', () => {
  test('substitutes vars into subject + body', () => {
    const r = renderTemplate('ALERT_RED', {
      customer_name: 'Asha Mwangi',
      indicator: 'DPD-90',
      risk_score: 87,
      case_id: 'CASE-001',
    });
    expect(r.subject).toBe('[RED] Asha Mwangi — DPD-90 breach (score 87)');
    expect(r.body_text).toContain('Customer: Asha Mwangi');
    expect(r.body_text).toContain('Risk score: 87');
    expect(r.missing_vars).toEqual([]);
  });

  test('reports missing required vars', () => {
    const r = renderTemplate('ALERT_RED', { customer_name: 'X' });
    // required_vars: customer_name, indicator, risk_score, case_id → 3 missing
    expect(r.missing_vars.sort()).toEqual(['case_id', 'indicator', 'risk_score']);
    // Slots survive in output
    expect(r.subject).toContain('{{indicator}}');
  });

  test('throws on unknown template id', () => {
    expect(() => renderTemplate('NOPE' as never)).toThrow(/unknown template/);
  });
});

describe('resolveMessage()', () => {
  test('template_id path renders subject + body', () => {
    const r = resolveMessage({
      to: ['ops@bil.test'],
      template_id: 'ALERT_ORANGE',
      template_vars: { customer_name: 'Foo', indicator: 'X', risk_score: 55 },
    });
    expect(r.subject).toContain('[ORANGE] Foo');
    expect(r.body_text).toContain('Risk score: 55');
    expect(r.template_id).toBe('ALERT_ORANGE');
  });

  test('caller-supplied subject overrides template subject', () => {
    const r = resolveMessage({
      to: ['ops@bil.test'],
      subject: 'Custom subject',
      template_id: 'ALERT_ORANGE',
      template_vars: { customer_name: 'Foo', indicator: 'X', risk_score: 55 },
    });
    expect(r.subject).toBe('Custom subject');
  });

  test('explicit subject + body without template works', () => {
    const r = resolveMessage({
      to: ['ops@bil.test'],
      subject: 'Hello',
      body_text: 'World',
    });
    expect(r.subject).toBe('Hello');
    expect(r.body_text).toBe('World');
    expect(r.template_id).toBeUndefined();
  });

  test('throws on empty recipient list', () => {
    expect(() =>
      resolveMessage({ to: [], subject: 'x', body_text: 'y' }),
    ).toThrow(/at least one address/);
  });

  test('throws on invalid recipient', () => {
    expect(() =>
      resolveMessage({ to: ['not-an-email'], subject: 'x', body_text: 'y' }),
    ).toThrow(/invalid address/);
  });

  test('throws when template missing required vars', () => {
    expect(() =>
      resolveMessage({
        to: ['ops@bil.test'],
        template_id: 'ALERT_RED',
        template_vars: { customer_name: 'X' },
      }),
    ).toThrow(/template ALERT_RED requires/);
  });

  test('throws when neither template nor subject is supplied', () => {
    expect(() => resolveMessage({ to: ['ops@bil.test'], body_text: 'b' })).toThrow(
      /subject is required/,
    );
  });

  test('throws on subject too long', () => {
    expect(() =>
      resolveMessage({
        to: ['ops@bil.test'],
        subject: 'x'.repeat(201),
        body_text: 'y',
      }),
    ).toThrow(/subject must be ≤ 200/);
  });

  test('error type is EmailValidationError with code', () => {
    try {
      resolveMessage({ to: [], subject: 'x', body_text: 'y' });
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(EmailValidationError);
      expect((e as EmailValidationError).code).toBe('no_recipient');
    }
  });
});

describe('StubEmailTransport', () => {
  test('send() records the entry and returns a receipt', async () => {
    const t = new StubEmailTransport({ now: () => NOW });
    const r = await t.send('BIL', {
      to: ['ops@bil.test'],
      subject: 'Hi',
      body_text: 'Hello',
    });
    expect(r.message_id).toMatch(/^email-/);
    expect(r.status).toBe('sent');
    expect(r.transport).toBe('stub');
    expect(r.sent_at).toBe(NOW.toISOString());
  });

  test('recent() returns newest-first within tenant', async () => {
    const t = new StubEmailTransport({ now: () => NOW });
    await t.send('BIL', { to: ['a@x.test'], subject: 'first', body_text: '.' });
    await t.send('BIL', { to: ['b@x.test'], subject: 'second', body_text: '.' });
    await t.send('BIL', { to: ['c@x.test'], subject: 'third', body_text: '.' });
    const log = t.recent('BIL');
    expect(log.map((l) => l.subject)).toEqual(['third', 'second', 'first']);
  });

  test('recent() scopes to tenant — BIL does not see BANK_DEMO entries', async () => {
    const t = new StubEmailTransport({ now: () => NOW });
    await t.send('BIL', { to: ['bil@x.test'], subject: 'bil-only', body_text: '.' });
    await t.send('BANK_DEMO', { to: ['bank@x.test'], subject: 'bank-only', body_text: '.' });
    expect(t.recent('BIL').map((l) => l.subject)).toEqual(['bil-only']);
    expect(t.recent('BANK_DEMO').map((l) => l.subject)).toEqual(['bank-only']);
    // null = all
    expect(t.recent(null).length).toBe(2);
  });

  test('recent(limit) caps the result', async () => {
    const t = new StubEmailTransport({ now: () => NOW });
    for (let i = 0; i < 5; i++) {
      await t.send('BIL', { to: ['x@x.test'], subject: `s-${i}`, body_text: '.' });
    }
    expect(t.recent('BIL', 2).length).toBe(2);
  });

  test('cap evicts oldest entries', async () => {
    const t = new StubEmailTransport({ cap: 3, now: () => NOW });
    for (let i = 0; i < 5; i++) {
      await t.send('BIL', { to: ['x@x.test'], subject: `s-${i}`, body_text: '.' });
    }
    const log = t.recent('BIL');
    expect(log.length).toBe(3);
    // s-0 + s-1 evicted; s-2..s-4 retained
    expect(log.map((l) => l.subject)).toEqual(['s-4', 's-3', 's-2']);
  });

  test('send() preserves template_id + alert/case correlations in the ledger', async () => {
    const t = new StubEmailTransport({ now: () => NOW });
    await t.send('BIL', {
      to: ['ops@bil.test'],
      template_id: 'ALERT_RED',
      template_vars: {
        customer_name: 'Asha',
        indicator: 'DPD-90',
        risk_score: 87,
        case_id: 'CASE-1',
      },
      related_alert_id: 'ALERT-77',
      related_case_id: 'CASE-1',
    });
    const [entry] = t.recent('BIL');
    expect(entry!.template_id).toBe('ALERT_RED');
    expect(entry!.related_alert_id).toBe('ALERT-77');
    expect(entry!.related_case_id).toBe('CASE-1');
    expect(entry!.tenant_id).toBe('BIL');
  });

  test('send() rejects bad input via EmailValidationError', async () => {
    const t = new StubEmailTransport();
    await expect(t.send('BIL', { to: [], subject: 'x', body_text: 'y' })).rejects.toBeInstanceOf(
      EmailValidationError,
    );
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/notifications/email/templates', () => {
  test('any analyst-level role can list templates', async () => {
    const { app } = makeEmailApp('risk_analyst');
    const r = await request(app).get('/v1/notifications/email/templates').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(4);
    expect(r.body.body.items.map((i: { id: string }) => i.id).sort()).toEqual([
      'ALERT_ORANGE',
      'ALERT_RED',
      'CASE_ASSIGNED',
      'SLA_BREACH',
    ]);
  });

  test('unknown role → 403', async () => {
    const { app } = makeEmailApp('case_owner');
    const r = await request(app).get('/v1/notifications/email/templates').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/notifications/email/preview', () => {
  test('renders a template with vars', async () => {
    const { app } = makeEmailApp('risk_analyst');
    const r = await request(app)
      .post('/v1/notifications/email/preview')
      .set(TH_BIL)
      .send({
        template_id: 'ALERT_ORANGE',
        template_vars: { customer_name: 'Foo', indicator: 'DPD-30', risk_score: 55 },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.subject).toContain('[ORANGE] Foo');
    expect(r.body.body.body_text).toContain('Risk score: 55');
    expect(r.body.body.missing_vars).toEqual([]);
  });

  test('reports missing_vars without throwing', async () => {
    const { app } = makeEmailApp('risk_analyst');
    const r = await request(app)
      .post('/v1/notifications/email/preview')
      .set(TH_BIL)
      .send({ template_id: 'ALERT_RED', template_vars: { customer_name: 'X' } });
    expect(r.status).toBe(200);
    expect(r.body.body.missing_vars.sort()).toEqual(['case_id', 'indicator', 'risk_score']);
  });

  test('missing template_id → 400', async () => {
    const { app } = makeEmailApp('risk_analyst');
    const r = await request(app).post('/v1/notifications/email/preview').set(TH_BIL).send({});
    expect(r.status).toBe(400);
  });

  test('unknown template_id → 400 with code EWS_400_unknown_template', async () => {
    const { app } = makeEmailApp('risk_analyst');
    const r = await request(app)
      .post('/v1/notifications/email/preview')
      .set(TH_BIL)
      .send({ template_id: 'BOGUS' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_unknown_template');
  });
});

describe('POST /v1/notifications/email/send', () => {
  test('admin: 201 with receipt, ledger entry visible at /log', async () => {
    const transport = new StubEmailTransport({ now: () => NOW });
    const { app } = makeEmailApp('admin', transport);
    const send = await request(app)
      .post('/v1/notifications/email/send')
      .set(TH_BIL)
      .send({
        to: ['ops@bil.test'],
        template_id: 'ALERT_RED',
        template_vars: {
          customer_name: 'Asha',
          indicator: 'DPD-90',
          risk_score: 87,
          case_id: 'CASE-1',
        },
        related_alert_id: 'ALERT-77',
      });
    expect(send.status).toBe(201);
    expect(send.body.body.receipt.status).toBe('sent');
    expect(send.body.body.receipt.message_id).toMatch(/^email-/);

    const log = await request(app).get('/v1/notifications/email/log').set(TH_BIL);
    expect(log.status).toBe(200);
    expect(log.body.body.total).toBe(1);
    expect(log.body.body.items[0].subject).toContain('[RED] Asha');
    expect(log.body.body.items[0].related_alert_id).toBe('ALERT-77');
  });

  test('non-admin role (risk_analyst, no audit:read) → 403', async () => {
    const { app } = makeEmailApp('risk_analyst');
    const r = await request(app)
      .post('/v1/notifications/email/send')
      .set(TH_BIL)
      .send({ to: ['x@x.test'], subject: 'hi', body_text: 'body' });
    expect(r.status).toBe(403);
  });

  test('invalid recipient → 400 with code EWS_400_invalid_addresses', async () => {
    const { app } = makeEmailApp('admin');
    const r = await request(app)
      .post('/v1/notifications/email/send')
      .set(TH_BIL)
      .send({ to: ['not-an-email'], subject: 'hi', body_text: 'body' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_addresses');
  });

  test('missing subject + no template → 400 with code EWS_400_missing_subject', async () => {
    const { app } = makeEmailApp('admin');
    const r = await request(app)
      .post('/v1/notifications/email/send')
      .set(TH_BIL)
      .send({ to: ['x@x.test'], body_text: 'body' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_missing_subject');
  });

  test('template missing required vars → 400 with code EWS_400_missing_template_vars', async () => {
    const { app } = makeEmailApp('admin');
    const r = await request(app)
      .post('/v1/notifications/email/send')
      .set(TH_BIL)
      .send({
        to: ['x@x.test'],
        template_id: 'ALERT_RED',
        template_vars: { customer_name: 'X' },
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_missing_template_vars');
  });

  test('accepts an enveloped request body', async () => {
    const transport = new StubEmailTransport({ now: () => NOW });
    const { app } = makeEmailApp('admin', transport);
    const r = await request(app)
      .post('/v1/notifications/email/send')
      .set(TH_BIL)
      .send({
        header: { requestId: 'req-1' },
        body: { to: ['x@x.test'], subject: 'enveloped', body_text: 'ok' },
      });
    expect(r.status).toBe(201);
    expect(transport.recent('BIL')[0]!.subject).toBe('enveloped');
  });
});

describe('GET /v1/notifications/email/log — tenant scoping', () => {
  test('BIL admin only sees BIL entries (BANK_DEMO sends are hidden)', async () => {
    const transport = new StubEmailTransport({ now: () => NOW });
    const { app } = makeEmailApp('admin', transport);

    const sendBil = await request(app)
      .post('/v1/notifications/email/send')
      .set(TH_BIL)
      .send({ to: ['bil@x.test'], subject: 'bil-only', body_text: '.' });
    expect(sendBil.status).toBe(201);

    const sendBank = await request(app)
      .post('/v1/notifications/email/send')
      .set(TH_BANK)
      .send({ to: ['bank@x.test'], subject: 'bank-only', body_text: '.' });
    expect(sendBank.status).toBe(201);

    const bilLog = await request(app).get('/v1/notifications/email/log').set(TH_BIL);
    expect(bilLog.body.body.items.map((i: { subject: string }) => i.subject)).toEqual(['bil-only']);

    const bankLog = await request(app).get('/v1/notifications/email/log').set(TH_BANK);
    expect(bankLog.body.body.items.map((i: { subject: string }) => i.subject)).toEqual(['bank-only']);
  });

  test('?limit=N caps the response', async () => {
    const transport = new StubEmailTransport({ now: () => NOW });
    const { app } = makeEmailApp('admin', transport);
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/v1/notifications/email/send')
        .set(TH_BIL)
        .send({ to: ['x@x.test'], subject: `s-${i}`, body_text: '.' });
    }
    const r = await request(app).get('/v1/notifications/email/log?limit=2').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.items.length).toBe(2);
    expect(r.body.body.limit).toBe(2);
  });

  test('non-admin → 403', async () => {
    const { app } = makeEmailApp('risk_analyst');
    const r = await request(app).get('/v1/notifications/email/log').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});
