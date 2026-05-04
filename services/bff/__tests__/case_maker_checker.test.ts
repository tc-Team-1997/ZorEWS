// services/bff/__tests__/case_maker_checker.test.ts
//
// T6 M9.3 — Case maker-checker workflow.

import request from 'supertest';
import {
  InMemoryMakerCheckerEngine,
  isMakerCheckerStatus,
  isSensitiveActionType,
  MakerCheckerError,
  validateSubmit,
  type MakerCheckerAction,
  type SubmitActionInput,
} from '../src/case_maker_checker';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeMcApp(role: string = 'admin', makerCheckerEngine?: InMemoryMakerCheckerEngine) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    makerCheckerEngine: makerCheckerEngine ?? new InMemoryMakerCheckerEngine(),
  });
}

const VALID_INPUT: SubmitActionInput = {
  case_id: 'CASE-1',
  action_type: 'case.close',
  payload: { outcome: 'cured', justification: 'paid in full' },
  rationale: 'Customer paid the outstanding balance and confirmed via call',
};

// ─── Type guards ──────────────────────────────────────────────────────

describe('Type guards', () => {
  test('isSensitiveActionType', () => {
    expect(isSensitiveActionType('case.close')).toBe(true);
    expect(isSensitiveActionType('case.escalate')).toBe(true);
    expect(isSensitiveActionType('case.override_decision')).toBe(true);
    expect(isSensitiveActionType('case.foo')).toBe(false);
  });
  test('isMakerCheckerStatus', () => {
    expect(isMakerCheckerStatus('pending')).toBe(true);
    expect(isMakerCheckerStatus('approved')).toBe(true);
    expect(isMakerCheckerStatus('rejected')).toBe(true);
    expect(isMakerCheckerStatus('cancelled')).toBe(true);
    expect(isMakerCheckerStatus('PENDING')).toBe(false);
  });
});

// ─── validateSubmit ───────────────────────────────────────────────────

describe('validateSubmit', () => {
  test('happy path returns the input', () => {
    expect(validateSubmit(VALID_INPUT)).toEqual(VALID_INPUT);
  });

  test('missing case_id throws invalid_input', () => {
    expect(() => validateSubmit({ ...VALID_INPUT, case_id: '' })).toThrow(/case_id/);
  });

  test('invalid action_type throws invalid_action_type', () => {
    expect(() =>
      validateSubmit({ ...VALID_INPUT, action_type: 'case.foo' as never }),
    ).toThrow(/action_type/);
  });

  test('missing rationale throws invalid_input', () => {
    expect(() => validateSubmit({ ...VALID_INPUT, rationale: '' })).toThrow(/rationale/);
  });

  test('rationale > 4000 chars throws invalid_input', () => {
    expect(() =>
      validateSubmit({ ...VALID_INPUT, rationale: 'a'.repeat(4001) }),
    ).toThrow(/≤ 4000/);
  });

  test('non-object payload throws invalid_input', () => {
    expect(() => validateSubmit({ ...VALID_INPUT, payload: [] as never })).toThrow(/payload/);
    expect(() => validateSubmit({ ...VALID_INPUT, payload: null as never })).toThrow(/payload/);
  });

  test('error code surfaced via MakerCheckerError', () => {
    try {
      validateSubmit({});
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MakerCheckerError);
      expect((e as MakerCheckerError).code).toBe('invalid_input');
    }
  });
});

// ─── Engine — submit ──────────────────────────────────────────────────

describe('InMemoryMakerCheckerEngine — submit', () => {
  test('creates a pending action', () => {
    const e = new InMemoryMakerCheckerEngine();
    const a = e.submit('BIL', VALID_INPUT, 'taniya', NOW);
    expect(a.action_id).toMatch(/^mc-/);
    expect(a.tenant_id).toBe('BIL');
    expect(a.case_id).toBe('CASE-1');
    expect(a.action_type).toBe('case.close');
    expect(a.status).toBe('pending');
    expect(a.maker_username).toBe('taniya');
    expect(a.maker_at).toBe(NOW.toISOString());
    expect(a.rationale).toBe(VALID_INPUT.rationale);
    expect(a.checker_username).toBeNull();
    expect(a.checker_at).toBeNull();
    expect(a.decision_notes).toBeNull();
  });

  test('refuses 2nd pending submission for same case + action_type', () => {
    const e = new InMemoryMakerCheckerEngine();
    e.submit('BIL', VALID_INPUT, 'taniya', NOW);
    try {
      e.submit('BIL', VALID_INPUT, 'taniya', NOW);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MakerCheckerError);
      expect((err as MakerCheckerError).code).toBe('submission_already_pending');
    }
  });

  test('allows new submission after the prior is rejected', () => {
    const e = new InMemoryMakerCheckerEngine();
    const a = e.submit('BIL', VALID_INPUT, 'taniya', NOW);
    e.reject('BIL', a.action_id, 'reviewer', 'incomplete', NOW);
    const b = e.submit('BIL', VALID_INPUT, 'taniya', NOW);
    expect(b.action_id).not.toBe(a.action_id);
    expect(b.status).toBe('pending');
  });

  test('different action_types on the same case can both be pending', () => {
    const e = new InMemoryMakerCheckerEngine();
    e.submit('BIL', VALID_INPUT, 'taniya', NOW);
    const escalate = e.submit('BIL', { ...VALID_INPUT, action_type: 'case.escalate' }, 'taniya', NOW);
    expect(escalate.status).toBe('pending');
  });

  test('cross-tenant: BIL has no visibility into BANK_DEMO submissions', () => {
    const e = new InMemoryMakerCheckerEngine();
    e.submit('BIL', VALID_INPUT, 't', NOW);
    e.submit('BANK_DEMO', VALID_INPUT, 't', NOW);
    expect(e.list('BIL', {}).total).toBe(1);
    expect(e.list('BANK_DEMO', {}).total).toBe(1);
  });

  test('rejects empty maker_username', () => {
    const e = new InMemoryMakerCheckerEngine();
    expect(() => e.submit('BIL', VALID_INPUT, '', NOW)).toThrow(/maker_username/);
  });
});

// ─── Engine — list + get ──────────────────────────────────────────────

describe('InMemoryMakerCheckerEngine — list + get', () => {
  function seed(e: InMemoryMakerCheckerEngine): void {
    e.submit('BIL', VALID_INPUT, 'alice', new Date('2026-05-01T10:00:00Z'));
    e.submit(
      'BIL',
      { ...VALID_INPUT, case_id: 'CASE-2', action_type: 'case.escalate' },
      'bob',
      new Date('2026-05-02T10:00:00Z'),
    );
    e.submit(
      'BIL',
      { ...VALID_INPUT, case_id: 'CASE-3', action_type: 'case.override_decision' },
      'alice',
      new Date('2026-05-03T10:00:00Z'),
    );
  }

  test('list newest-first', () => {
    const e = new InMemoryMakerCheckerEngine();
    seed(e);
    const out = e.list('BIL', {});
    expect(out.total).toBe(3);
    for (let i = 1; i < out.items.length; i++) {
      expect(out.items[i - 1]!.maker_at >= out.items[i]!.maker_at).toBe(true);
    }
  });

  test('filter by status', () => {
    const e = new InMemoryMakerCheckerEngine();
    const a = e.submit('BIL', VALID_INPUT, 't', NOW);
    e.approve('BIL', a.action_id, 'r', null, NOW);
    e.submit('BIL', { ...VALID_INPUT, case_id: 'CASE-2' }, 't', NOW);
    expect(e.list('BIL', { status: 'pending' }).total).toBe(1);
    expect(e.list('BIL', { status: 'approved' }).total).toBe(1);
  });

  test('filter by action_type', () => {
    const e = new InMemoryMakerCheckerEngine();
    seed(e);
    expect(e.list('BIL', { action_type: 'case.close' }).total).toBe(1);
    expect(e.list('BIL', { action_type: 'case.escalate' }).total).toBe(1);
  });

  test('filter by case_id + maker_username', () => {
    const e = new InMemoryMakerCheckerEngine();
    seed(e);
    expect(e.list('BIL', { case_id: 'CASE-2' }).total).toBe(1);
    expect(e.list('BIL', { maker_username: 'alice' }).total).toBe(2);
  });

  test('pagination disjoint, page_size clamped', () => {
    const e = new InMemoryMakerCheckerEngine();
    seed(e);
    const p1 = e.list('BIL', { page: 1, page_size: 2 });
    const p2 = e.list('BIL', { page: 2, page_size: 2 });
    expect(p1.items.length).toBe(2);
    expect(p2.items.length).toBe(1);
    expect(e.list('BIL', { page_size: 99999 }).page_size).toBe(200);
  });

  test('get returns action; null on miss + cross-tenant', () => {
    const e = new InMemoryMakerCheckerEngine();
    const a = e.submit('BIL', VALID_INPUT, 't', NOW);
    expect(e.get('BIL', a.action_id)).toEqual(a);
    expect(e.get('BIL', 'mc-nope')).toBeNull();
    expect(e.get('BANK_DEMO', a.action_id)).toBeNull();
  });
});

// ─── Engine — approve + reject (incl. self-approval guard) ────────────

describe('InMemoryMakerCheckerEngine — approve + reject', () => {
  test('approve sets status, checker_username/_at, decision_notes', () => {
    const e = new InMemoryMakerCheckerEngine();
    const a = e.submit('BIL', VALID_INPUT, 'taniya', NOW);
    const approved = e.approve('BIL', a.action_id, 'reviewer', 'verified the rationale', NOW);
    expect(approved.status).toBe('approved');
    expect(approved.checker_username).toBe('reviewer');
    expect(approved.checker_at).toBe(NOW.toISOString());
    expect(approved.decision_notes).toBe('verified the rationale');
  });

  test('reject mirrors approve — status=rejected', () => {
    const e = new InMemoryMakerCheckerEngine();
    const a = e.submit('BIL', VALID_INPUT, 'taniya', NOW);
    const rejected = e.reject('BIL', a.action_id, 'reviewer', 'incomplete docs', NOW);
    expect(rejected.status).toBe('rejected');
    expect(rejected.decision_notes).toBe('incomplete docs');
  });

  test('SELF-APPROVAL forbidden — maker cannot approve their own action', () => {
    const e = new InMemoryMakerCheckerEngine();
    const a = e.submit('BIL', VALID_INPUT, 'taniya', NOW);
    try {
      e.approve('BIL', a.action_id, 'taniya', null, NOW);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MakerCheckerError);
      expect((err as MakerCheckerError).code).toBe('self_approval_forbidden');
    }
  });

  test('SELF-REJECTION forbidden too', () => {
    const e = new InMemoryMakerCheckerEngine();
    const a = e.submit('BIL', VALID_INPUT, 'taniya', NOW);
    try {
      e.reject('BIL', a.action_id, 'taniya', null, NOW);
      fail('expected throw');
    } catch (err) {
      expect((err as MakerCheckerError).code).toBe('self_approval_forbidden');
    }
  });

  test('approve null decision_notes allowed', () => {
    const e = new InMemoryMakerCheckerEngine();
    const a = e.submit('BIL', VALID_INPUT, 'taniya', NOW);
    const approved = e.approve('BIL', a.action_id, 'reviewer', null, NOW);
    expect(approved.decision_notes).toBeNull();
  });

  test('approve already-approved → already_decided', () => {
    const e = new InMemoryMakerCheckerEngine();
    const a = e.submit('BIL', VALID_INPUT, 'taniya', NOW);
    e.approve('BIL', a.action_id, 'reviewer', null, NOW);
    try {
      e.approve('BIL', a.action_id, 'reviewer2', null, NOW);
      fail('expected throw');
    } catch (err) {
      expect((err as MakerCheckerError).code).toBe('already_decided');
    }
  });

  test('approve unknown action → unknown_action', () => {
    const e = new InMemoryMakerCheckerEngine();
    expect(() => e.approve('BIL', 'mc-nope', 'r', null, NOW)).toThrow(/unknown maker-checker/);
  });

  test('decision_notes > 4000 chars → invalid_input', () => {
    const e = new InMemoryMakerCheckerEngine();
    const a = e.submit('BIL', VALID_INPUT, 'taniya', NOW);
    expect(() => e.approve('BIL', a.action_id, 'reviewer', 'a'.repeat(4001), NOW)).toThrow(
      /≤ 4000/,
    );
  });

  test('rejects empty checker_username', () => {
    const e = new InMemoryMakerCheckerEngine();
    const a = e.submit('BIL', VALID_INPUT, 'taniya', NOW);
    expect(() => e.approve('BIL', a.action_id, '', null, NOW)).toThrow(/checker_username/);
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('POST /v1/cases/maker-checker', () => {
  test('analyst+: 201 with pending action', async () => {
    const { app } = makeMcApp('risk_analyst');
    const r = await request(app)
      .post('/v1/cases/maker-checker')
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send(VALID_INPUT);
    expect(r.status).toBe(201);
    expect(r.body.body.status).toBe('pending');
    expect(r.body.body.maker_username).toBe('taniya');
  });

  test('accepts an enveloped request body', async () => {
    const { app } = makeMcApp('admin');
    const r = await request(app)
      .post('/v1/cases/maker-checker')
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: VALID_INPUT });
    expect(r.status).toBe(201);
  });

  test('invalid action_type → 400 EWS_400_invalid_action_type', async () => {
    const { app } = makeMcApp('admin');
    const r = await request(app)
      .post('/v1/cases/maker-checker')
      .set(TH_BIL)
      .send({ ...VALID_INPUT, action_type: 'case.foo' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_action_type');
  });

  test('2nd pending → 409 EWS_409_submission_already_pending', async () => {
    const { app } = makeMcApp('admin');
    await request(app).post('/v1/cases/maker-checker').set(TH_BIL).send(VALID_INPUT);
    const r = await request(app).post('/v1/cases/maker-checker').set(TH_BIL).send(VALID_INPUT);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_submission_already_pending');
  });

  test('missing rationale → 400 EWS_400_invalid_input', async () => {
    const { app } = makeMcApp('admin');
    const r = await request(app)
      .post('/v1/cases/maker-checker')
      .set(TH_BIL)
      .send({ ...VALID_INPUT, rationale: '' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeMcApp('case_owner');
    const r = await request(app).post('/v1/cases/maker-checker').set(TH_BIL).send(VALID_INPUT);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/cases/maker-checker + /:id', () => {
  test('list newest-first; single 404 on miss', async () => {
    const { app } = makeMcApp('admin');
    await request(app).post('/v1/cases/maker-checker').set(TH_BIL).send(VALID_INPUT);
    const list = await request(app).get('/v1/cases/maker-checker').set(TH_BIL);
    expect(list.status).toBe(200);
    expect(list.body.body.total).toBe(1);
    const single404 = await request(app).get('/v1/cases/maker-checker/mc-nope').set(TH_BIL);
    expect(single404.status).toBe(404);
    expect(single404.body.error.code).toBe('EWS_404_unknown_action');
  });

  test('?status filter; ?status=invalid → 400', async () => {
    const { app } = makeMcApp('admin');
    await request(app).post('/v1/cases/maker-checker').set(TH_BIL).send(VALID_INPUT);
    const ok = await request(app).get('/v1/cases/maker-checker?status=pending').set(TH_BIL);
    expect(ok.body.body.total).toBe(1);
    const bad = await request(app).get('/v1/cases/maker-checker?status=DONE').set(TH_BIL);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('EWS_400_invalid_status');
  });

  test('?action_type filter; ?action_type=invalid → 400', async () => {
    const { app } = makeMcApp('admin');
    await request(app).post('/v1/cases/maker-checker').set(TH_BIL).send(VALID_INPUT);
    const ok = await request(app)
      .get('/v1/cases/maker-checker?action_type=case.close')
      .set(TH_BIL);
    expect(ok.body.body.total).toBe(1);
    const bad = await request(app).get('/v1/cases/maker-checker?action_type=case.foo').set(TH_BIL);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('EWS_400_invalid_action_type');
  });

  test('cross-tenant single lookup → 404', async () => {
    const engine = new InMemoryMakerCheckerEngine();
    const a = engine.submit('BIL', VALID_INPUT, 't', NOW);
    const { app } = makeMcApp('admin', engine);
    const r = await request(app).get(`/v1/cases/maker-checker/${a.action_id}`).set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('POST /v1/cases/maker-checker/:id/approve', () => {
  test('admin (different user from maker): 200 with approved status', async () => {
    const engine = new InMemoryMakerCheckerEngine();
    const a = engine.submit('BIL', VALID_INPUT, 'taniya', NOW);
    const { app } = makeMcApp('admin', engine);
    const r = await request(app)
      .post(`/v1/cases/maker-checker/${a.action_id}/approve`)
      .set(TH_BIL)
      .set('x-apex-user', 'reviewer')
      .send({ decision_notes: 'verified' });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('approved');
    expect(r.body.body.checker_username).toBe('reviewer');
  });

  test('SELF-APPROVAL: maker tries to approve own → 409 EWS_409_self_approval_forbidden', async () => {
    const engine = new InMemoryMakerCheckerEngine();
    const a = engine.submit('BIL', VALID_INPUT, 'taniya', NOW);
    const { app } = makeMcApp('admin', engine);
    const r = await request(app)
      .post(`/v1/cases/maker-checker/${a.action_id}/approve`)
      .set(TH_BIL)
      .set('x-apex-user', 'taniya') // same as maker
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_self_approval_forbidden');
  });

  test('approve already-approved → 409 EWS_409_already_decided', async () => {
    const engine = new InMemoryMakerCheckerEngine();
    const a = engine.submit('BIL', VALID_INPUT, 'taniya', NOW);
    engine.approve('BIL', a.action_id, 'reviewer', null, NOW);
    const { app } = makeMcApp('admin', engine);
    const r = await request(app)
      .post(`/v1/cases/maker-checker/${a.action_id}/approve`)
      .set(TH_BIL)
      .set('x-apex-user', 'reviewer2')
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_already_decided');
  });

  test('approve unknown id → 404', async () => {
    const { app } = makeMcApp('admin');
    const r = await request(app)
      .post('/v1/cases/maker-checker/mc-nope/approve')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_action');
  });

  test('non-admin → 403', async () => {
    const engine = new InMemoryMakerCheckerEngine();
    const a = engine.submit('BIL', VALID_INPUT, 'taniya', NOW);
    const { app } = makeMcApp('risk_analyst', engine);
    const r = await request(app)
      .post(`/v1/cases/maker-checker/${a.action_id}/approve`)
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/cases/maker-checker/:id/reject', () => {
  test('admin (different user): 200 with rejected status', async () => {
    const engine = new InMemoryMakerCheckerEngine();
    const a = engine.submit('BIL', VALID_INPUT, 'taniya', NOW);
    const { app } = makeMcApp('admin', engine);
    const r = await request(app)
      .post(`/v1/cases/maker-checker/${a.action_id}/reject`)
      .set(TH_BIL)
      .set('x-apex-user', 'reviewer')
      .send({ decision_notes: 'docs missing' });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('rejected');
    expect(r.body.body.decision_notes).toBe('docs missing');
  });

  test('self-rejection forbidden too → 409', async () => {
    const engine = new InMemoryMakerCheckerEngine();
    const a = engine.submit('BIL', VALID_INPUT, 'taniya', NOW);
    const { app } = makeMcApp('admin', engine);
    const r = await request(app)
      .post(`/v1/cases/maker-checker/${a.action_id}/reject`)
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_self_approval_forbidden');
  });

  test('non-admin → 403', async () => {
    const { app } = makeMcApp('risk_analyst');
    const r = await request(app).post('/v1/cases/maker-checker/mc-x/reject').set(TH_BIL).send({});
    expect(r.status).toBe(403);
  });
});

describe('Tenant isolation through routes', () => {
  test('BIL submissions do not leak to BANK_DEMO list', async () => {
    const { app } = makeMcApp('admin');
    await request(app).post('/v1/cases/maker-checker').set(TH_BIL).send(VALID_INPUT);
    const bil = await request(app).get('/v1/cases/maker-checker').set(TH_BIL);
    const bank = await request(app).get('/v1/cases/maker-checker').set(TH_BANK);
    expect(bil.body.body.total).toBe(1);
    expect(bank.body.body.total).toBe(0);
  });

  test('full round-trip — submit + list + get + approve', async () => {
    const { app } = makeMcApp('admin');
    const created = await request(app)
      .post('/v1/cases/maker-checker')
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send(VALID_INPUT);
    const id = (created.body.body as MakerCheckerAction).action_id;
    const list = await request(app).get('/v1/cases/maker-checker').set(TH_BIL);
    expect(list.body.body.total).toBe(1);
    const single = await request(app).get(`/v1/cases/maker-checker/${id}`).set(TH_BIL);
    expect(single.body.body.status).toBe('pending');
    const approved = await request(app)
      .post(`/v1/cases/maker-checker/${id}/approve`)
      .set(TH_BIL)
      .set('x-apex-user', 'reviewer') // different user
      .send({ decision_notes: 'verified' });
    expect(approved.body.body.status).toBe('approved');
  });
});
