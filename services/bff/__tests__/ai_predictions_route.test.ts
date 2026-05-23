// services/bff/__tests__/ai_predictions_route.test.ts
//
// HTTP route tests for the pg-ai-predictions surface:
//   - POST /v1/ai/models/:model_id/score now logs to aiPredictionStore
//   - GET  /v1/ai/predictions (filtered list)
//   - GET  /v1/ai/predictions/:prediction_id (single)
//
// Uses an injected InMemoryAiPredictionStore — no pg, no env vars, deterministic.

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryAiModelRegistry } from '../src/ai_model_registry';
import { InMemoryAiPredictionStore } from '../src/ai_predictions';

const NOW = new Date('2026-05-23T12:00:00.000Z');
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeAiApp(role: string = 'admin', predStore?: InMemoryAiPredictionStore) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    aiModelRegistry: new InMemoryAiModelRegistry(),
    aiPredictionStore: predStore ?? new InMemoryAiPredictionStore(),
  });
  return { app, store: predStore };
}

describe('POST /v1/ai/models/:model_id/score → logs to aiPredictionStore', () => {
  it('successful score creates a prediction row in the store', async () => {
    const store = new InMemoryAiPredictionStore();
    const { app } = makeAiApp('admin', store);

    await request(app)
      .post('/v1/ai/models/pd_xgb_v3/score')
      .set(TH_BANK)
      .set('X-APEX-USER', 'alice.admin')
      .send({ customer_id: 'CUST-100001' })
      .expect(200);

    const list = store.list('BANK_DEMO');
    expect(list.items).toHaveLength(1);
    const row = list.items[0];
    expect(row.tenant_id).toBe('BANK_DEMO');
    expect(row.model_id).toBe('pd_xgb_v3');
    expect(row.model_version).toBe('3.2.1');
    expect(row.prediction_type).toBe('pd');
    expect(row.customer_id).toBe('CUST-100001');
    expect(row.created_by).toBe('alice.admin');
    expect(row.input_snapshot).toEqual({ customer_id: 'CUST-100001' });
    expect(row.top_features.length).toBeGreaterThan(0);
  });

  it('X-APEX-USER absent → created_by defaults to "system"', async () => {
    const store = new InMemoryAiPredictionStore();
    const { app } = makeAiApp('admin', store);

    await request(app)
      .post('/v1/ai/models/pd_xgb_v3/score')
      .set(TH_BANK)
      .send({ customer_id: 'CUST-NOAUTHOR' })
      .expect(200);

    const list = store.list('BANK_DEMO');
    expect(list.items).toHaveLength(1);
    expect(list.items[0].created_by).toBe('system');
  });

  it('cross-tenant: BIL score creates row only in BIL bucket', async () => {
    const store = new InMemoryAiPredictionStore();
    const { app } = makeAiApp('admin', store);

    await request(app)
      .post('/v1/ai/models/pd_xgb_v3/score')
      .set(TH_BIL)
      .send({ customer_id: 'CUST-BIL' })
      .expect(200);

    expect(store.list('BIL').items).toHaveLength(1);
    expect(store.list('BANK_DEMO').items).toHaveLength(0);
  });

  it('unknown model 404 → no prediction recorded', async () => {
    const store = new InMemoryAiPredictionStore();
    const { app } = makeAiApp('admin', store);

    await request(app)
      .post('/v1/ai/models/no.such.model/score')
      .set(TH_BANK)
      .send({ customer_id: 'CUST-X' })
      .expect(404);

    expect(store.list('BANK_DEMO').items).toHaveLength(0);
  });

  it('invalid input 400 → no prediction recorded', async () => {
    const store = new InMemoryAiPredictionStore();
    const { app } = makeAiApp('admin', store);

    await request(app)
      .post('/v1/ai/models/pd_xgb_v3/score')
      .set(TH_BANK)
      .send({}) // missing customer_id
      .expect(400);

    expect(store.list('BANK_DEMO').items).toHaveLength(0);
  });
});

describe('GET /v1/ai/predictions', () => {
  it('lists newest-first, tenant-scoped, with pagination envelope', async () => {
    const store = new InMemoryAiPredictionStore();
    const { app } = makeAiApp('admin', store);

    // Seed via score endpoint to keep the test honest
    for (const cust of ['CUST-A', 'CUST-B', 'CUST-C']) {
      await request(app)
        .post('/v1/ai/models/pd_xgb_v3/score')
        .set(TH_BANK)
        .send({ customer_id: cust })
        .expect(200);
    }

    const r = await request(app).get('/v1/ai/predictions').set(TH_BANK).expect(200);
    expect(r.body.body.items).toHaveLength(3);
    expect(r.body.body.total).toBe(3);
    expect(r.body.body.page).toBe(1);
    expect(r.body.body.page_size_default).toBe(50);
    expect(r.body.body.page_size_max).toBe(200);
  });

  it('filter by customer_id narrows the result', async () => {
    const store = new InMemoryAiPredictionStore();
    const { app } = makeAiApp('admin', store);

    for (const c of ['CUST-A', 'CUST-B', 'CUST-A']) {
      await request(app).post('/v1/ai/models/pd_xgb_v3/score').set(TH_BANK).send({ customer_id: c });
    }

    const r = await request(app)
      .get('/v1/ai/predictions?customer_id=CUST-A')
      .set(TH_BANK)
      .expect(200);
    expect(r.body.body.items).toHaveLength(2);
    expect(r.body.body.items.every((p: { customer_id: string }) => p.customer_id === 'CUST-A')).toBe(true);
  });

  it('invalid prediction_type → 400 EWS_400_invalid_prediction_type', async () => {
    const r = await request(makeAiApp('admin').app)
      .get('/v1/ai/predictions?prediction_type=BOGUS')
      .set(TH_BANK)
      .expect(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_prediction_type');
  });

  it('cross-tenant: BIL request never sees BANK_DEMO rows', async () => {
    const store = new InMemoryAiPredictionStore();
    const { app } = makeAiApp('admin', store);

    await request(app).post('/v1/ai/models/pd_xgb_v3/score').set(TH_BANK).send({ customer_id: 'CUST-1' });
    await request(app).post('/v1/ai/models/pd_xgb_v3/score').set(TH_BIL).send({ customer_id: 'CUST-2' });

    const bank = await request(app).get('/v1/ai/predictions').set(TH_BANK).expect(200);
    const bil = await request(app).get('/v1/ai/predictions').set(TH_BIL).expect(200);
    expect(bank.body.body.items).toHaveLength(1);
    expect(bank.body.body.items[0].customer_id).toBe('CUST-1');
    expect(bil.body.body.items).toHaveLength(1);
    expect(bil.body.body.items[0].customer_id).toBe('CUST-2');
  });

  it('non-allowed role → 403', async () => {
    const r = await request(makeAiApp('unknown_role').app)
      .get('/v1/ai/predictions')
      .set(TH_BANK);
    expect(r.status).toBe(403);
  });

  it('missing tenant header → 400', async () => {
    await request(makeAiApp('admin').app)
      .get('/v1/ai/predictions')
      .expect(400);
  });
});

describe('GET /v1/ai/predictions/:prediction_id', () => {
  it('200 with envelope on hit', async () => {
    const store = new InMemoryAiPredictionStore();
    const { app } = makeAiApp('admin', store);

    await request(app)
      .post('/v1/ai/models/pd_xgb_v3/score')
      .set(TH_BANK)
      .send({ customer_id: 'CUST-FETCH' })
      .expect(200);

    const list = store.list('BANK_DEMO');
    const id = list.items[0].prediction_id;

    const r = await request(app).get(`/v1/ai/predictions/${id}`).set(TH_BANK).expect(200);
    expect(r.body.body.prediction_id).toBe(id);
    expect(r.body.body.customer_id).toBe('CUST-FETCH');
  });

  it('404 with EWS_404_unknown_prediction on miss', async () => {
    const r = await request(makeAiApp('admin').app)
      .get('/v1/ai/predictions/does-not-exist')
      .set(TH_BANK)
      .expect(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_prediction');
  });

  it('cross-tenant 404 (BIL caller, BANK_DEMO row)', async () => {
    const store = new InMemoryAiPredictionStore();
    const { app } = makeAiApp('admin', store);

    await request(app).post('/v1/ai/models/pd_xgb_v3/score').set(TH_BANK).send({ customer_id: 'C' });
    const id = store.list('BANK_DEMO').items[0].prediction_id;

    await request(app).get(`/v1/ai/predictions/${id}`).set(TH_BIL).expect(404);
  });

  it('non-allowed role → 403', async () => {
    await request(makeAiApp('unknown_role').app)
      .get('/v1/ai/predictions/x')
      .set(TH_BANK)
      .expect(403);
  });
});
