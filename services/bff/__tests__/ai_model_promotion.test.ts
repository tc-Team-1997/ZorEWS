// services/bff/__tests__/ai_model_promotion.test.ts
//
// T6 M7.2 — AI/ML model promotion workflow.

import request from 'supertest';
import {
  canTransition,
  InMemoryPromotionEngine,
  isPromotionRequestStatus,
  PromotionError,
  validateRequestInput,
  type PromotionRequest,
  type RequestPromotionInput,
} from '../src/ai_model_promotion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makePromoApp(role: string = 'admin', promotionEngine?: InMemoryPromotionEngine) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    promotionEngine: promotionEngine ?? new InMemoryPromotionEngine(),
  });
}

const VALID_INPUT: RequestPromotionInput = {
  model_id: 'pd_xgb_v3',
  from_status: 'staging',
  to_status: 'production',
  request_notes: 'AUC 0.85, 14 days shadow with stable variance',
};

// ─── canTransition state machine ───────────────────────────────────────

describe('canTransition state machine', () => {
  test('experimental → staging | retired allowed', () => {
    expect(canTransition('experimental', 'staging')).toBe(true);
    expect(canTransition('experimental', 'retired')).toBe(true);
  });
  test('experimental → production forbidden (must go through staging+shadow)', () => {
    expect(canTransition('experimental', 'production')).toBe(false);
  });
  test('staging → shadow | production | retired', () => {
    expect(canTransition('staging', 'shadow')).toBe(true);
    expect(canTransition('staging', 'production')).toBe(true);
    expect(canTransition('staging', 'retired')).toBe(true);
  });
  test('staging → experimental forbidden (no rewind)', () => {
    expect(canTransition('staging', 'experimental')).toBe(false);
  });
  test('shadow → production | retired (only)', () => {
    expect(canTransition('shadow', 'production')).toBe(true);
    expect(canTransition('shadow', 'retired')).toBe(true);
    expect(canTransition('shadow', 'staging')).toBe(false);
    expect(canTransition('shadow', 'experimental')).toBe(false);
  });
  test('production → retired only — no in-place downgrades', () => {
    expect(canTransition('production', 'retired')).toBe(true);
    expect(canTransition('production', 'shadow')).toBe(false);
    expect(canTransition('production', 'staging')).toBe(false);
    expect(canTransition('production', 'experimental')).toBe(false);
  });
  test('retired is terminal — no outgoing transitions', () => {
    expect(canTransition('retired', 'experimental')).toBe(false);
    expect(canTransition('retired', 'staging')).toBe(false);
    expect(canTransition('retired', 'shadow')).toBe(false);
    expect(canTransition('retired', 'production')).toBe(false);
    expect(canTransition('retired', 'retired')).toBe(false);
  });
});

describe('isPromotionRequestStatus', () => {
  test('accepts the 4 valid statuses', () => {
    expect(isPromotionRequestStatus('pending')).toBe(true);
    expect(isPromotionRequestStatus('approved')).toBe(true);
    expect(isPromotionRequestStatus('rejected')).toBe(true);
    expect(isPromotionRequestStatus('cancelled')).toBe(true);
  });
  test('rejects everything else', () => {
    expect(isPromotionRequestStatus('PENDING')).toBe(false);
    expect(isPromotionRequestStatus('done')).toBe(false);
  });
});

// ─── validateRequestInput ──────────────────────────────────────────────

describe('validateRequestInput', () => {
  test('happy path returns the input', () => {
    expect(validateRequestInput(VALID_INPUT)).toEqual(VALID_INPUT);
  });

  test('missing model_id throws invalid_input', () => {
    expect(() => validateRequestInput({ ...VALID_INPUT, model_id: '' })).toThrow(/model_id/);
  });

  test('invalid from_status throws invalid_input', () => {
    expect(() =>
      validateRequestInput({ ...VALID_INPUT, from_status: 'foo' as never }),
    ).toThrow(/from_status/);
  });

  test('illegal transition throws invalid_transition', () => {
    expect(() =>
      validateRequestInput({ ...VALID_INPUT, from_status: 'experimental', to_status: 'production' }),
    ).toThrow(/cannot transition/);
  });

  test('request_notes > 4000 chars throws invalid_input', () => {
    expect(() =>
      validateRequestInput({ ...VALID_INPUT, request_notes: 'a'.repeat(4001) }),
    ).toThrow(/≤ 4000/);
  });

  test('error code surfaced via PromotionError', () => {
    try {
      validateRequestInput({});
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PromotionError);
      expect((e as PromotionError).code).toBe('invalid_input');
    }
  });
});

// ─── Engine — request + list + get ─────────────────────────────────────

describe('InMemoryPromotionEngine — requestPromotion', () => {
  test('creates a pending request with required fields', () => {
    const e = new InMemoryPromotionEngine();
    const r = e.requestPromotion('BIL', VALID_INPUT, 'taniya', NOW);
    expect(r.request_id).toMatch(/^pr-/);
    expect(r.tenant_id).toBe('BIL');
    expect(r.model_id).toBe(VALID_INPUT.model_id);
    expect(r.from_status).toBe('staging');
    expect(r.to_status).toBe('production');
    expect(r.status).toBe('pending');
    expect(r.requested_by).toBe('taniya');
    expect(r.requested_at).toBe(NOW.toISOString());
    expect(r.reviewed_by).toBeNull();
    expect(r.reviewed_at).toBeNull();
    expect(r.decision_notes).toBeNull();
  });

  test('refuses 2nd pending request for the same model', () => {
    const e = new InMemoryPromotionEngine();
    e.requestPromotion('BIL', VALID_INPUT, 'taniya', NOW);
    try {
      e.requestPromotion('BIL', VALID_INPUT, 'bob', NOW);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PromotionError);
      expect((err as PromotionError).code).toBe('request_already_pending');
    }
  });

  test('allows new request after the previous is rejected', () => {
    const e = new InMemoryPromotionEngine();
    const a = e.requestPromotion('BIL', VALID_INPUT, 'taniya', NOW);
    e.reject('BIL', a.request_id, 'reviewer', 'AUC volatile', NOW);
    // 2nd request now permitted
    const b = e.requestPromotion('BIL', VALID_INPUT, 'taniya', NOW);
    expect(b.request_id).not.toBe(a.request_id);
    expect(b.status).toBe('pending');
  });

  test('different models can have concurrent pending requests', () => {
    const e = new InMemoryPromotionEngine();
    const a = e.requestPromotion('BIL', VALID_INPUT, 'taniya', NOW);
    const b = e.requestPromotion(
      'BIL',
      { ...VALID_INPUT, model_id: 'fraud_lgb_v1' },
      'bob',
      NOW,
    );
    expect(a.status).toBe('pending');
    expect(b.status).toBe('pending');
  });

  test('cross-tenant: BIL has no visibility into BANK_DEMO requests', () => {
    const e = new InMemoryPromotionEngine();
    e.requestPromotion('BIL', VALID_INPUT, 'taniya', NOW);
    e.requestPromotion('BANK_DEMO', VALID_INPUT, 'carol', NOW);
    expect(e.list('BIL', {}).total).toBe(1);
    expect(e.list('BANK_DEMO', {}).total).toBe(1);
  });
});

describe('InMemoryPromotionEngine — list + get', () => {
  function seed(e: InMemoryPromotionEngine): void {
    e.requestPromotion('BIL', VALID_INPUT, 'alice', new Date('2026-05-01T10:00:00Z'));
    e.requestPromotion(
      'BIL',
      { ...VALID_INPUT, model_id: 'fraud_lgb_v1' },
      'bob',
      new Date('2026-05-02T10:00:00Z'),
    );
    e.requestPromotion(
      'BIL',
      { ...VALID_INPUT, model_id: 'churn_xgb_v1' },
      'alice',
      new Date('2026-05-03T10:00:00Z'),
    );
  }

  test('list() newest-first', () => {
    const e = new InMemoryPromotionEngine();
    seed(e);
    const out = e.list('BIL', {});
    expect(out.total).toBe(3);
    for (let i = 1; i < out.items.length; i++) {
      expect(out.items[i - 1]!.requested_at >= out.items[i]!.requested_at).toBe(true);
    }
  });

  test('filter by status', () => {
    const e = new InMemoryPromotionEngine();
    const a = e.requestPromotion('BIL', VALID_INPUT, 't', NOW);
    e.approve('BIL', a.request_id, 'r', null, NOW);
    e.requestPromotion('BIL', { ...VALID_INPUT, model_id: 'fraud_lgb_v1' }, 't', NOW);
    expect(e.list('BIL', { status: 'pending' }).total).toBe(1);
    expect(e.list('BIL', { status: 'approved' }).total).toBe(1);
  });

  test('filter by model_id', () => {
    const e = new InMemoryPromotionEngine();
    seed(e);
    expect(e.list('BIL', { model_id: 'pd_xgb_v3' }).total).toBe(1);
  });

  test('filter by requested_by', () => {
    const e = new InMemoryPromotionEngine();
    seed(e);
    expect(e.list('BIL', { requested_by: 'alice' }).total).toBe(2);
  });

  test('pagination disjoint, page_size clamped', () => {
    const e = new InMemoryPromotionEngine();
    seed(e);
    const p1 = e.list('BIL', { page: 1, page_size: 2 });
    const p2 = e.list('BIL', { page: 2, page_size: 2 });
    expect(p1.items.length).toBe(2);
    expect(p2.items.length).toBe(1);
    const ids1 = new Set(p1.items.map((r) => r.request_id));
    for (const r of p2.items) expect(ids1.has(r.request_id)).toBe(false);
    expect(e.list('BIL', { page_size: 99999 }).page_size).toBe(200);
  });

  test('get() returns request; null on miss + cross-tenant', () => {
    const e = new InMemoryPromotionEngine();
    const r = e.requestPromotion('BIL', VALID_INPUT, 't', NOW);
    expect(e.get('BIL', r.request_id)).toEqual(r);
    expect(e.get('BIL', 'pr-nope')).toBeNull();
    expect(e.get('BANK_DEMO', r.request_id)).toBeNull();
  });
});

// ─── Engine — approve + reject ─────────────────────────────────────────

describe('InMemoryPromotionEngine — approve + reject', () => {
  test('approve sets status, reviewed_by, reviewed_at, decision_notes', () => {
    const e = new InMemoryPromotionEngine();
    const r = e.requestPromotion('BIL', VALID_INPUT, 'taniya', NOW);
    const approved = e.approve('BIL', r.request_id, 'reviewer', 'AUC stable', NOW);
    expect(approved.status).toBe('approved');
    expect(approved.reviewed_by).toBe('reviewer');
    expect(approved.reviewed_at).toBe(NOW.toISOString());
    expect(approved.decision_notes).toBe('AUC stable');
  });

  test('reject mirrors approve — status=rejected', () => {
    const e = new InMemoryPromotionEngine();
    const r = e.requestPromotion('BIL', VALID_INPUT, 'taniya', NOW);
    const rejected = e.reject('BIL', r.request_id, 'reviewer', 'precision regressed', NOW);
    expect(rejected.status).toBe('rejected');
    expect(rejected.decision_notes).toBe('precision regressed');
  });

  test('approve null decision_notes allowed', () => {
    const e = new InMemoryPromotionEngine();
    const r = e.requestPromotion('BIL', VALID_INPUT, 'taniya', NOW);
    const approved = e.approve('BIL', r.request_id, 'reviewer', null, NOW);
    expect(approved.decision_notes).toBeNull();
  });

  test('approve a non-pending request → already_decided', () => {
    const e = new InMemoryPromotionEngine();
    const r = e.requestPromotion('BIL', VALID_INPUT, 'taniya', NOW);
    e.approve('BIL', r.request_id, 'reviewer', null, NOW);
    try {
      e.approve('BIL', r.request_id, 'reviewer', null, NOW);
      fail('expected throw');
    } catch (err) {
      expect((err as PromotionError).code).toBe('already_decided');
    }
  });

  test('approve unknown request → unknown_request', () => {
    const e = new InMemoryPromotionEngine();
    try {
      e.approve('BIL', 'pr-nope', 'r', null, NOW);
      fail('expected throw');
    } catch (err) {
      expect((err as PromotionError).code).toBe('unknown_request');
    }
  });

  test('decision_notes > 4000 chars → invalid_input', () => {
    const e = new InMemoryPromotionEngine();
    const r = e.requestPromotion('BIL', VALID_INPUT, 't', NOW);
    expect(() => e.approve('BIL', r.request_id, 'r', 'a'.repeat(4001), NOW)).toThrow(/≤ 4000/);
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('POST /v1/ai/promotions', () => {
  test('analyst+: 201 with pending request', async () => {
    const { app } = makePromoApp('risk_analyst');
    const r = await request(app)
      .post('/v1/ai/promotions')
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send(VALID_INPUT);
    expect(r.status).toBe(201);
    expect(r.body.body.status).toBe('pending');
    expect(r.body.body.requested_by).toBe('taniya');
  });

  test('accepts an enveloped request body', async () => {
    const { app } = makePromoApp('admin');
    const r = await request(app)
      .post('/v1/ai/promotions')
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: VALID_INPUT });
    expect(r.status).toBe(201);
  });

  test('illegal transition → 400 EWS_400_invalid_transition', async () => {
    const { app } = makePromoApp('admin');
    const r = await request(app)
      .post('/v1/ai/promotions')
      .set(TH_BIL)
      .send({
        ...VALID_INPUT,
        from_status: 'experimental',
        to_status: 'production',
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_transition');
  });

  test('2nd pending for same model → 409 EWS_409_request_already_pending', async () => {
    const { app } = makePromoApp('admin');
    await request(app).post('/v1/ai/promotions').set(TH_BIL).send(VALID_INPUT);
    const r = await request(app).post('/v1/ai/promotions').set(TH_BIL).send(VALID_INPUT);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_request_already_pending');
  });

  test('missing model_id → 400 EWS_400_invalid_input', async () => {
    const { app } = makePromoApp('admin');
    const r = await request(app)
      .post('/v1/ai/promotions')
      .set(TH_BIL)
      .send({ ...VALID_INPUT, model_id: '' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('unknown role → 403', async () => {
    const { app } = makePromoApp('case_owner');
    const r = await request(app).post('/v1/ai/promotions').set(TH_BIL).send(VALID_INPUT);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/ai/promotions + /:id', () => {
  test('list returns newest-first; single 404 on miss', async () => {
    const { app } = makePromoApp('admin');
    await request(app).post('/v1/ai/promotions').set(TH_BIL).send(VALID_INPUT);
    const list = await request(app).get('/v1/ai/promotions').set(TH_BIL);
    expect(list.status).toBe(200);
    expect(list.body.body.total).toBe(1);
    const single = await request(app).get('/v1/ai/promotions/pr-nope').set(TH_BIL);
    expect(single.status).toBe(404);
    expect(single.body.error.code).toBe('EWS_404_unknown_request');
  });

  test('?status filter; ?status=invalid → 400', async () => {
    const { app } = makePromoApp('admin');
    await request(app).post('/v1/ai/promotions').set(TH_BIL).send(VALID_INPUT);
    const ok = await request(app).get('/v1/ai/promotions?status=pending').set(TH_BIL);
    expect(ok.body.body.total).toBe(1);
    const bad = await request(app).get('/v1/ai/promotions?status=DONE').set(TH_BIL);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('EWS_400_invalid_status');
  });

  test('cross-tenant single lookup → 404', async () => {
    const engine = new InMemoryPromotionEngine();
    const r = engine.requestPromotion('BIL', VALID_INPUT, 't', NOW);
    const { app } = makePromoApp('admin', engine);
    const out = await request(app).get(`/v1/ai/promotions/${r.request_id}`).set(TH_BANK);
    expect(out.status).toBe(404);
  });
});

describe('POST /v1/ai/promotions/:id/approve', () => {
  test('admin: 200 with approved status; review fields populated', async () => {
    const engine = new InMemoryPromotionEngine();
    const req0 = engine.requestPromotion('BIL', VALID_INPUT, 'taniya', NOW);
    const { app } = makePromoApp('admin', engine);
    const r = await request(app)
      .post(`/v1/ai/promotions/${req0.request_id}/approve`)
      .set(TH_BIL)
      .set('x-apex-user', 'reviewer')
      .send({ decision_notes: 'AUC stable on 14-day shadow' });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('approved');
    expect(r.body.body.reviewed_by).toBe('reviewer');
    expect(r.body.body.decision_notes).toBe('AUC stable on 14-day shadow');
  });

  test('approve with no body → null decision_notes', async () => {
    const engine = new InMemoryPromotionEngine();
    const req0 = engine.requestPromotion('BIL', VALID_INPUT, 'taniya', NOW);
    const { app } = makePromoApp('admin', engine);
    const r = await request(app)
      .post(`/v1/ai/promotions/${req0.request_id}/approve`)
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.body.decision_notes).toBeNull();
  });

  test('approve already-approved → 409 EWS_409_already_decided', async () => {
    const engine = new InMemoryPromotionEngine();
    const req0 = engine.requestPromotion('BIL', VALID_INPUT, 'taniya', NOW);
    engine.approve('BIL', req0.request_id, 'r', null, NOW);
    const { app } = makePromoApp('admin', engine);
    const r = await request(app)
      .post(`/v1/ai/promotions/${req0.request_id}/approve`)
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_already_decided');
  });

  test('approve unknown id → 404', async () => {
    const { app } = makePromoApp('admin');
    const r = await request(app).post('/v1/ai/promotions/pr-nope/approve').set(TH_BIL).send({});
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_request');
  });

  test('non-admin → 403', async () => {
    const engine = new InMemoryPromotionEngine();
    const req0 = engine.requestPromotion('BIL', VALID_INPUT, 'taniya', NOW);
    const { app } = makePromoApp('risk_analyst', engine);
    const r = await request(app)
      .post(`/v1/ai/promotions/${req0.request_id}/approve`)
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/ai/promotions/:id/reject', () => {
  test('admin: 200 with rejected status', async () => {
    const engine = new InMemoryPromotionEngine();
    const req0 = engine.requestPromotion('BIL', VALID_INPUT, 'taniya', NOW);
    const { app } = makePromoApp('admin', engine);
    const r = await request(app)
      .post(`/v1/ai/promotions/${req0.request_id}/reject`)
      .set(TH_BIL)
      .set('x-apex-user', 'reviewer')
      .send({ decision_notes: 'AUC volatile' });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('rejected');
    expect(r.body.body.decision_notes).toBe('AUC volatile');
  });

  test('reject already-decided → 409', async () => {
    const engine = new InMemoryPromotionEngine();
    const req0 = engine.requestPromotion('BIL', VALID_INPUT, 'taniya', NOW);
    engine.reject('BIL', req0.request_id, 'r', null, NOW);
    const { app } = makePromoApp('admin', engine);
    const r = await request(app)
      .post(`/v1/ai/promotions/${req0.request_id}/reject`)
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(409);
  });

  test('non-admin → 403', async () => {
    const { app } = makePromoApp('risk_analyst');
    const r = await request(app).post('/v1/ai/promotions/pr-x/reject').set(TH_BIL).send({});
    expect(r.status).toBe(403);
  });
});

describe('Tenant isolation through routes', () => {
  test('BIL requests do not leak to BANK_DEMO list', async () => {
    const { app } = makePromoApp('admin');
    await request(app).post('/v1/ai/promotions').set(TH_BIL).send(VALID_INPUT);
    const bil = await request(app).get('/v1/ai/promotions').set(TH_BIL);
    const bank = await request(app).get('/v1/ai/promotions').set(TH_BANK);
    expect(bil.body.body.total).toBe(1);
    expect(bank.body.body.total).toBe(0);
  });

  test('full round-trip through routes — request + list + get + approve', async () => {
    const { app } = makePromoApp('admin');
    const created = await request(app)
      .post('/v1/ai/promotions')
      .set(TH_BIL)
      .send(VALID_INPUT);
    const id = (created.body.body as PromotionRequest).request_id;
    const list = await request(app).get('/v1/ai/promotions').set(TH_BIL);
    expect(list.body.body.total).toBe(1);
    const single = await request(app).get(`/v1/ai/promotions/${id}`).set(TH_BIL);
    expect(single.body.body.status).toBe('pending');
    const approved = await request(app)
      .post(`/v1/ai/promotions/${id}/approve`)
      .set(TH_BIL)
      .send({ decision_notes: 'ship it' });
    expect(approved.body.body.status).toBe('approved');
  });
});
