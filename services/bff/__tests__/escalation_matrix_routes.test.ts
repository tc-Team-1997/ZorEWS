// Route smoke tests for /v1/admin/escalation-matrix (T6 M14.17).
// Wires the in-memory store into makeApp() + exercises happy path,
// resolveFor lookup, RBAC, tenant isolation. Bulk validation already
// covered by escalation_matrix_store.test.ts.

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryEscalationMatrixStore } from '../src/admin/escalation_matrix_store';

const NOW = new Date('2026-05-09T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeEsApp(role = 'admin', store?: InMemoryEscalationMatrixStore) {
  const s = store ?? new InMemoryEscalationMatrixStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    escalationMatrixStore: s,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store: s };
}

const FRAUD_P1 = {
  name: 'Fraud P1 fast-escalate',
  case_category: 'fraud',
  priority: 'P1',
  level_1_after_minutes: 15,
  level_1_role: 'supervisor',
  level_2_after_minutes: 60,
  level_2_role: 'risk_analyst',
  level_3_after_minutes: 240,
  level_3_role: 'admin',
};

describe('POST + GET /v1/admin/escalation-matrix (M14.17)', () => {
  test('POST 201 creates ACTIVE rule, GET list returns it', async () => {
    const { app } = makeEsApp();
    const c = await request(app)
      .post('/v1/admin/escalation-matrix')
      .set({ ...TH_BIL, 'x-apex-user': 'alice.admin' })
      .send(FRAUD_P1);
    expect(c.status).toBe(201);
    expect(c.body.body.status).toBe('ACTIVE');
    expect(c.body.body.created_by).toBe('alice.admin');
    const l = await request(app).get('/v1/admin/escalation-matrix').set(TH_BIL);
    expect(l.body.body.total).toBe(1);
  });

  test('POST 400 on level_2 minutes <= level_1 minutes', async () => {
    const { app } = makeEsApp();
    const r = await request(app)
      .post('/v1/admin/escalation-matrix')
      .set(TH_BIL)
      .send({ ...FRAUD_P1, level_2_after_minutes: 5 });
    expect(r.status).toBe(400);
  });

  test('POST 400 on unknown role', async () => {
    const { app } = makeEsApp();
    const r = await request(app)
      .post('/v1/admin/escalation-matrix')
      .set(TH_BIL)
      .send({ ...FRAUD_P1, level_1_role: 'overlord' });
    expect(r.status).toBe(400);
  });

  test('POST 409 on duplicate name', async () => {
    const { app } = makeEsApp();
    await request(app).post('/v1/admin/escalation-matrix').set(TH_BIL).send(FRAUD_P1);
    const dup = await request(app)
      .post('/v1/admin/escalation-matrix')
      .set(TH_BIL)
      .send(FRAUD_P1);
    expect(dup.status).toBe(409);
  });

  test('GET list filter by case_category + priority', async () => {
    const { app } = makeEsApp();
    await request(app).post('/v1/admin/escalation-matrix').set(TH_BIL).send(FRAUD_P1);
    await request(app)
      .post('/v1/admin/escalation-matrix')
      .set(TH_BIL)
      .send({
        ...FRAUD_P1,
        name: 'KYC P3',
        case_category: 'kyc',
        priority: 'P3',
        level_1_after_minutes: 480,
        level_2_after_minutes: null,
        level_2_role: null,
        level_3_after_minutes: null,
        level_3_role: null,
      });
    const fraud = await request(app)
      .get('/v1/admin/escalation-matrix?case_category=fraud&priority=P1')
      .set(TH_BIL);
    expect(fraud.body.body.total).toBe(1);
  });

  test('GET /resolve returns the ACTIVE rule for (category, priority)', async () => {
    const { app } = makeEsApp();
    const c = await request(app)
      .post('/v1/admin/escalation-matrix')
      .set(TH_BIL)
      .send(FRAUD_P1);
    const r = await request(app)
      .get('/v1/admin/escalation-matrix/resolve?case_category=fraud&priority=P1')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.rule.escalation_id).toBe(c.body.body.escalation_id);
  });

  test('GET /resolve returns rule:null when nothing matches', async () => {
    const { app } = makeEsApp();
    const r = await request(app)
      .get('/v1/admin/escalation-matrix/resolve?case_category=fraud&priority=P1')
      .set(TH_BIL);
    expect(r.body.body.rule).toBeNull();
  });

  test('GET /resolve 400 when missing category or invalid priority', async () => {
    const { app } = makeEsApp();
    const a = await request(app)
      .get('/v1/admin/escalation-matrix/resolve?priority=P1')
      .set(TH_BIL);
    expect(a.status).toBe(400);
    const b = await request(app)
      .get('/v1/admin/escalation-matrix/resolve?case_category=fraud&priority=P9')
      .set(TH_BIL);
    expect(b.status).toBe(400);
  });

  test('PATCH 200 + DELETE 200 (archive); list excludes ARCHIVED only when filtered', async () => {
    const { app } = makeEsApp();
    const c = await request(app)
      .post('/v1/admin/escalation-matrix')
      .set({ ...TH_BIL, 'x-apex-user': 'alice.admin' })
      .send(FRAUD_P1);
    const id = c.body.body.escalation_id;
    const p = await request(app)
      .patch(`/v1/admin/escalation-matrix/${id}`)
      .set({ ...TH_BIL, 'x-apex-user': 'bob.admin' })
      .send({ name: 'Renamed Fraud P1' });
    expect(p.status).toBe(200);
    expect(p.body.body.name).toBe('Renamed Fraud P1');
    expect(p.body.body.updated_by).toBe('bob.admin');
    const d = await request(app)
      .delete(`/v1/admin/escalation-matrix/${id}`)
      .set(TH_BIL);
    expect(d.status).toBe(200);
    expect(d.body.body.status).toBe('ARCHIVED');
    const onlyActive = await request(app)
      .get('/v1/admin/escalation-matrix?status=ACTIVE')
      .set(TH_BIL);
    expect(onlyActive.body.body.total).toBe(0);
  });

  test('non-allowed role → 403 on POST', async () => {
    const { app } = makeEsApp('case_owner');
    const r = await request(app)
      .post('/v1/admin/escalation-matrix')
      .set(TH_BIL)
      .send(FRAUD_P1);
    expect(r.status).toBe(403);
  });

  test('supervisor can list + resolve but not create', async () => {
    const { app } = makeEsApp('supervisor');
    const l = await request(app).get('/v1/admin/escalation-matrix').set(TH_BIL);
    expect(l.status).toBe(200);
    const r = await request(app)
      .get('/v1/admin/escalation-matrix/resolve?case_category=fraud&priority=P1')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    const c = await request(app)
      .post('/v1/admin/escalation-matrix')
      .set(TH_BIL)
      .send(FRAUD_P1);
    expect(c.status).toBe(403);
  });

  test('GET 404 across tenants', async () => {
    const { app } = makeEsApp();
    const c = await request(app)
      .post('/v1/admin/escalation-matrix')
      .set(TH_BIL)
      .send(FRAUD_P1);
    const id = c.body.body.escalation_id;
    const cross = await request(app)
      .get(`/v1/admin/escalation-matrix/${id}`)
      .set({ ...TH_BIL, 'X-Tenant-ID': 'BANK_DEMO' });
    expect(cross.status).toBe(404);
  });
});
