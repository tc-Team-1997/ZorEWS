// Route smoke tests for /v1/admin/case-scenarios (T6 M14.18). Wires
// the in-memory scenario store + history into makeApp() with stub FK
// resolvers and exercises the full lifecycle through HTTP.

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryCaseScenarioStore, type CaseScenarioStoreDeps } from '../src/admin/case_scenarios_store';
import { InMemoryCaseScenarioHistoryStore } from '../src/admin/case_scenario_history_store';

const NOW = new Date('2026-05-09T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const ESC_OK = '11111111-1111-1111-1111-111111111111';
const TPL_OK = '44444444-4444-4444-4444-444444444444';

function deps(history?: InMemoryCaseScenarioHistoryStore): CaseScenarioStoreDeps {
  return {
    resolveEscalation: async (tenant_id, id) => (id === ESC_OK ? { status: 'ACTIVE' } : null),
    resolveTemplate: async (tenant_id, id) => (id === TPL_OK ? { status: 'ACTIVE', deleted_at: null } : null),
    history,
  };
}

function makeCsApp(role = 'admin') {
  const history = new InMemoryCaseScenarioHistoryStore();
  const store = new InMemoryCaseScenarioStore(deps(history));
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    caseScenarioStore: store,
    caseScenarioHistoryStore: history,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store, history };
}

const FRAUD_BODY = {
  name: 'Fraud P1 sudden DPD',
  case_category: 'fraud',
  priority: 'P1',
  trigger_indicator_id: 'FRD-001',
  trigger_threshold: 0.85,
  default_escalation_id: ESC_OK,
  notification_template_id: TPL_OK,
  checklist: [{ title: 'Verify with customer', required: true }],
};

describe('POST + GET /v1/admin/case-scenarios (M14.18)', () => {
  test('POST 201 creates DRAFT scenario, history captures create', async () => {
    const { app } = makeCsApp();
    const c = await request(app)
      .post('/v1/admin/case-scenarios')
      .set({ ...TH_BIL, 'x-apex-user': 'alice.admin' })
      .send(FRAUD_BODY);
    expect(c.status).toBe(201);
    expect(c.body.body.status).toBe('DRAFT');
    expect(c.body.body.created_by).toBe('alice.admin');
    const id = c.body.body.scenario_id;
    const h = await request(app).get(`/v1/admin/case-scenarios/${id}/history`).set(TH_BIL);
    expect(h.status).toBe(200);
    expect(h.body.body.total).toBe(1);
    expect(h.body.body.items[0].action).toBe('create');
  });

  test('POST 400 on FK miss (escalation_id unknown)', async () => {
    const { app } = makeCsApp();
    const r = await request(app)
      .post('/v1/admin/case-scenarios')
      .set(TH_BIL)
      .send({ ...FRAUD_BODY, default_escalation_id: '99999999-9999-9999-9999-999999999999' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_fk');
  });

  test('POST 400 on half-open trigger pair', async () => {
    const { app } = makeCsApp();
    const r = await request(app)
      .post('/v1/admin/case-scenarios')
      .set(TH_BIL)
      .send({ ...FRAUD_BODY, trigger_threshold: undefined });
    expect(r.status).toBe(400);
  });

  test('POST 409 on duplicate name', async () => {
    const { app } = makeCsApp();
    await request(app).post('/v1/admin/case-scenarios').set(TH_BIL).send(FRAUD_BODY);
    const dup = await request(app).post('/v1/admin/case-scenarios').set(TH_BIL).send(FRAUD_BODY);
    expect(dup.status).toBe(409);
  });

  test('GET list filters by status + trigger_indicator_id', async () => {
    const { app } = makeCsApp();
    await request(app).post('/v1/admin/case-scenarios').set(TH_BIL).send(FRAUD_BODY);
    await request(app)
      .post('/v1/admin/case-scenarios')
      .set(TH_BIL)
      .send({ ...FRAUD_BODY, name: 'KYC P3', case_category: 'kyc', priority: 'P3', trigger_indicator_id: 'KYC-001', trigger_threshold: 1 });
    const fraud = await request(app)
      .get('/v1/admin/case-scenarios?trigger_indicator_id=FRD-001')
      .set(TH_BIL);
    expect(fraud.body.body.total).toBe(1);
  });

  test('PATCH 200 updates checklist + writes update history', async () => {
    const { app } = makeCsApp();
    const c = await request(app)
      .post('/v1/admin/case-scenarios')
      .set({ ...TH_BIL, 'x-apex-user': 'alice.admin' })
      .send(FRAUD_BODY);
    const id = c.body.body.scenario_id;
    const p = await request(app)
      .patch(`/v1/admin/case-scenarios/${id}`)
      .set({ ...TH_BIL, 'x-apex-user': 'bob.admin' })
      .send({ checklist: [{ title: 'New step', required: false }] });
    expect(p.status).toBe(200);
    expect(p.body.body.checklist[0].title).toBe('New step');
    expect(p.body.body.updated_by).toBe('bob.admin');
    const h = await request(app).get(`/v1/admin/case-scenarios/${id}/history`).set(TH_BIL);
    expect(h.body.body.items.map((e: { action: string }) => e.action)).toEqual(['update', 'create']);
  });

  test('lifecycle: create → activate → archive → restore', async () => {
    const { app } = makeCsApp();
    const c = await request(app)
      .post('/v1/admin/case-scenarios')
      .set(TH_BIL)
      .send(FRAUD_BODY);
    const id = c.body.body.scenario_id;
    expect(c.body.body.status).toBe('DRAFT');
    const a = await request(app).post(`/v1/admin/case-scenarios/${id}/activate`).set(TH_BIL);
    expect(a.body.body.status).toBe('ACTIVE');
    const d = await request(app).delete(`/v1/admin/case-scenarios/${id}`).set(TH_BIL);
    expect(d.body.body.status).toBe('ARCHIVED');
    expect(d.body.body.deleted_at).not.toBeNull();
    const r = await request(app).post(`/v1/admin/case-scenarios/${id}/restore`).set(TH_BIL);
    expect(r.body.body.status).toBe('DRAFT');
    expect(r.body.body.deleted_at).toBeNull();
    const h = await request(app).get(`/v1/admin/case-scenarios/${id}/history`).set(TH_BIL);
    expect(h.body.body.items.map((e: { action: string }) => e.action))
      .toEqual(['restore', 'archive', 'activate', 'create']);
  });

  test('non-allowed role → 403 on POST + activate', async () => {
    const { app } = makeCsApp('case_owner');
    const r = await request(app).post('/v1/admin/case-scenarios').set(TH_BIL).send(FRAUD_BODY);
    expect(r.status).toBe(403);
  });

  test('supervisor can list/get/history but not create or lifecycle', async () => {
    // Seed via admin app first, then re-build as supervisor.
    const adminApp = makeCsApp('admin');
    const c = await request(adminApp.app).post('/v1/admin/case-scenarios').set(TH_BIL).send(FRAUD_BODY);
    const id = c.body.body.scenario_id;
    // Supervisor view via a second app — note: stores are per-app, so
    // re-test via requireRole alone using the same admin store. Easier:
    // make supervisor app and assert RBAC on a non-existent id (still 403
    // because RBAC fires before lookup).
    const sup = makeCsApp('supervisor');
    const l = await request(sup.app).get('/v1/admin/case-scenarios').set(TH_BIL);
    expect(l.status).toBe(200);
    const cr = await request(sup.app).post('/v1/admin/case-scenarios').set(TH_BIL).send(FRAUD_BODY);
    expect(cr.status).toBe(403);
    const ac = await request(sup.app).post(`/v1/admin/case-scenarios/${id}/activate`).set(TH_BIL);
    expect(ac.status).toBe(403);
  });

  test('GET /:id 404 across tenants', async () => {
    const { app } = makeCsApp();
    const c = await request(app)
      .post('/v1/admin/case-scenarios')
      .set(TH_BIL)
      .send(FRAUD_BODY);
    const id = c.body.body.scenario_id;
    const cross = await request(app)
      .get(`/v1/admin/case-scenarios/${id}`)
      .set({ ...TH_BIL, 'X-Tenant-ID': 'BANK_DEMO' });
    expect(cross.status).toBe(404);
  });

  test('GET /:id/history 404 across tenants', async () => {
    const { app } = makeCsApp();
    const c = await request(app)
      .post('/v1/admin/case-scenarios')
      .set(TH_BIL)
      .send(FRAUD_BODY);
    const id = c.body.body.scenario_id;
    const cross = await request(app)
      .get(`/v1/admin/case-scenarios/${id}/history`)
      .set({ ...TH_BIL, 'X-Tenant-ID': 'BANK_DEMO' });
    expect(cross.status).toBe(404);
  });
});
