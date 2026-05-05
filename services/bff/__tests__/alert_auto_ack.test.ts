// services/bff/__tests__/alert_auto_ack.test.ts
//
// T6 M8.4 — Alert auto-ack threshold rules.

import request from 'supertest';
import {
  AutoAckError,
  InMemoryAutoAckRuleStore,
  evaluateAutoAck,
} from '../src/alert_auto_ack';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T18:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeAutoAckApp(role = 'admin') {
  const store = new InMemoryAutoAckRuleStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    autoAckRuleStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

const VALID_INPUT = {
  name: 'auto-ack green alerts',
  bil_class: 'green',
  reason: 'low-priority signal — auto-cleared',
};

// ─── Store create + validation ────────────────────────────────────────

describe('InMemoryAutoAckRuleStore.create + validation', () => {
  test('happy path: rule created with all fields', () => {
    const s = new InMemoryAutoAckRuleStore();
    const r = s.create('BIL', VALID_INPUT, 'admin', NOW);
    expect(r.rule_id).toMatch(/^aar-/);
    expect(r.tenant_id).toBe('BIL');
    expect(r.bil_class).toBe('green');
    expect(r.enabled).toBe(true);
  });

  test('rejects empty name', () => {
    const s = new InMemoryAutoAckRuleStore();
    expect(() => s.create('BIL', { ...VALID_INPUT, name: '' }, 'admin', NOW)).toThrow(/name/);
  });

  test('rejects empty reason', () => {
    const s = new InMemoryAutoAckRuleStore();
    expect(() => s.create('BIL', { ...VALID_INPUT, reason: '' }, 'admin', NOW)).toThrow(/reason/);
  });

  test('rejects bad bil_class', () => {
    const s = new InMemoryAutoAckRuleStore();
    expect(() => s.create('BIL', { ...VALID_INPUT, bil_class: 'purple' }, 'admin', NOW)).toThrow(
      /bil_class/,
    );
  });

  test('requires at least one matcher (no bil_class + no source + no tags)', () => {
    const s = new InMemoryAutoAckRuleStore();
    expect(() =>
      s.create('BIL', { name: 'too-broad', reason: 'r' }, 'admin', NOW),
    ).toThrow(/at least one/);
  });

  test('cap_reached after 20 rules', () => {
    const s = new InMemoryAutoAckRuleStore();
    for (let i = 0; i < 20; i++) {
      s.create('BIL', { ...VALID_INPUT, name: `rule-${i}` }, 'admin', NOW);
    }
    try {
      s.create('BIL', VALID_INPUT, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as AutoAckError).code).toBe('cap_reached');
    }
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryAutoAckRuleStore();
    const a = s.create('BIL', VALID_INPUT, 'admin', NOW);
    s.create('BANK_DEMO', VALID_INPUT, 'admin', NOW);
    expect(s.get('BIL', a.rule_id)?.rule_id).toBe(a.rule_id);
    expect(s.get('BANK_DEMO', a.rule_id)).toBeNull();
  });

  test('source_system + tags accepted', () => {
    const s = new InMemoryAutoAckRuleStore();
    const r = s.create(
      'BIL',
      {
        name: 'src match',
        source_system: 'cbs',
        tags_any: ['noise', 'low-priority'],
        reason: 'auto-clear cbs noise',
      },
      'admin',
      NOW,
    );
    expect(r.source_system).toBe('cbs');
    expect(r.tags_any).toEqual(['noise', 'low-priority']);
  });

  test('overlong reason rejected', () => {
    const s = new InMemoryAutoAckRuleStore();
    expect(() =>
      s.create('BIL', { ...VALID_INPUT, reason: 'x'.repeat(501) }, 'admin', NOW),
    ).toThrow(/≤ 500/);
  });
});

// ─── evaluateAutoAck (pure) ───────────────────────────────────────────

describe('evaluateAutoAck', () => {
  function makeStore() {
    const s = new InMemoryAutoAckRuleStore();
    s.create('BIL', { name: 'green clear', bil_class: 'green', reason: 'low' }, 'admin', NOW);
    s.create(
      'BIL',
      { name: 'cbs noise', source_system: 'cbs', reason: 'cbs auto' },
      'admin',
      NOW,
    );
    s.create(
      'BIL',
      {
        name: 'tagged auto',
        bil_class: 'yellow',
        tags_any: ['known-noise'],
        reason: 'tag match',
      },
      'admin',
      NOW,
    );
    return s;
  }

  test('green class matches green rule', () => {
    const s = makeStore();
    const r = evaluateAutoAck(s.list('BIL'), { bil_class: 'green' });
    expect(r?.rule_name).toBe('green clear');
  });

  test('cbs source matches cbs rule', () => {
    const s = makeStore();
    const r = evaluateAutoAck(s.list('BIL'), { bil_class: 'orange', source_system: 'cbs' });
    expect(r?.rule_name).toBe('cbs noise');
  });

  test('tag match requires class also match', () => {
    const s = makeStore();
    const ok = evaluateAutoAck(s.list('BIL'), {
      bil_class: 'yellow',
      tags: ['known-noise'],
    });
    expect(ok?.rule_name).toBe('tagged auto');
    const miss = evaluateAutoAck(s.list('BIL'), {
      bil_class: 'red',
      tags: ['known-noise'],
    });
    expect(miss).toBeNull();
  });

  test('no match → null', () => {
    const s = makeStore();
    const r = evaluateAutoAck(s.list('BIL'), { bil_class: 'red', source_system: 'aml' });
    expect(r).toBeNull();
  });

  test('disabled rule does not match', () => {
    const s = new InMemoryAutoAckRuleStore();
    const created = s.create(
      'BIL',
      { ...VALID_INPUT, enabled: false },
      'admin',
      NOW,
    );
    void created;
    const r = evaluateAutoAck(s.list('BIL'), { bil_class: 'green' });
    expect(r).toBeNull();
  });

  test('first matching rule wins', () => {
    const s = new InMemoryAutoAckRuleStore();
    const a = s.create(
      'BIL',
      { name: 'first', bil_class: 'green', reason: 'first' },
      'admin',
      NOW,
    );
    s.create(
      'BIL',
      { name: 'second', bil_class: 'green', reason: 'second' },
      'admin',
      NOW,
    );
    const r = evaluateAutoAck(s.list('BIL'), { bil_class: 'green' });
    expect(r?.rule_id).toBe(a.rule_id);
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('Auto-ack routes', () => {
  test('GET list 200 with empty array', async () => {
    const { app } = makeAutoAckApp('admin');
    const r = await request(app).get('/v1/alerts/auto-ack/rules').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });

  test('POST 201 → GET list shows it', async () => {
    const { app } = makeAutoAckApp('admin');
    const c = await request(app)
      .post('/v1/alerts/auto-ack/rules')
      .set(TH_BIL)
      .send(VALID_INPUT);
    expect(c.status).toBe(201);
    const list = await request(app).get('/v1/alerts/auto-ack/rules').set(TH_BIL);
    expect(list.body.body.total).toBe(1);
  });

  test('POST validation: empty name → 400', async () => {
    const { app } = makeAutoAckApp('admin');
    const r = await request(app)
      .post('/v1/alerts/auto-ack/rules')
      .set(TH_BIL)
      .send({ ...VALID_INPUT, name: '' });
    expect(r.status).toBe(400);
  });

  test('POST cap_reached → 409 after 20', async () => {
    const { app } = makeAutoAckApp('admin');
    for (let i = 0; i < 20; i++) {
      await request(app)
        .post('/v1/alerts/auto-ack/rules')
        .set(TH_BIL)
        .send({ ...VALID_INPUT, name: `rule-${i}` });
    }
    const r = await request(app)
      .post('/v1/alerts/auto-ack/rules')
      .set(TH_BIL)
      .send(VALID_INPUT);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_cap_reached');
  });

  test('DELETE 204 then 404', async () => {
    const { app } = makeAutoAckApp('admin');
    const c = await request(app)
      .post('/v1/alerts/auto-ack/rules')
      .set(TH_BIL)
      .send(VALID_INPUT);
    const id = c.body.body.rule_id;
    const d1 = await request(app).delete(`/v1/alerts/auto-ack/rules/${id}`).set(TH_BIL);
    expect(d1.status).toBe(204);
    const d2 = await request(app).delete(`/v1/alerts/auto-ack/rules/${id}`).set(TH_BIL);
    expect(d2.status).toBe(404);
  });

  test('POST evaluate: matched=true when rule exists', async () => {
    const { app } = makeAutoAckApp('admin');
    await request(app)
      .post('/v1/alerts/auto-ack/rules')
      .set(TH_BIL)
      .send(VALID_INPUT);
    const r = await request(app)
      .post('/v1/alerts/auto-ack/evaluate')
      .set(TH_BIL)
      .send({ bil_class: 'green' });
    expect(r.status).toBe(200);
    expect(r.body.body.matched).toBe(true);
    expect(r.body.body.match.reason).toBe(VALID_INPUT.reason);
  });

  test('POST evaluate: matched=false when no rule matches', async () => {
    const { app } = makeAutoAckApp('admin');
    const r = await request(app)
      .post('/v1/alerts/auto-ack/evaluate')
      .set(TH_BIL)
      .send({ bil_class: 'red' });
    expect(r.body.body.matched).toBe(false);
  });

  test('POST evaluate: missing bil_class → 400', async () => {
    const { app } = makeAutoAckApp('admin');
    const r = await request(app)
      .post('/v1/alerts/auto-ack/evaluate')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAutoAckApp('case_owner');
    const r = await request(app).get('/v1/alerts/auto-ack/rules').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});
