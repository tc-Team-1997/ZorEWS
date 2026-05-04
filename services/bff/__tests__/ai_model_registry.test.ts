// services/bff/__tests__/ai_model_registry.test.ts
//
// T6 M7.1 — BIL AI/ML model registry.

import request from 'supertest';
import {
  InMemoryAiModelRegistry,
  ModelRegistryError,
  SEED_MODELS,
  isModelStatus,
  isModelType,
  type AiModelRegistry,
  type InferenceResult,
  type ModelType,
  type ModelVersion,
} from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeAiApp(role: string = 'admin', aiModelRegistry?: AiModelRegistry) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    aiModelRegistry: aiModelRegistry ?? new InMemoryAiModelRegistry(),
  });
}

// ─── Type guards ───────────────────────────────────────────────────────

describe('Type guards', () => {
  test('isModelType', () => {
    expect(isModelType('pd')).toBe(true);
    expect(isModelType('fraud')).toBe(true);
    expect(isModelType('claim_severity')).toBe(true);
    expect(isModelType('PD')).toBe(false);
    expect(isModelType('foo')).toBe(false);
  });
  test('isModelStatus', () => {
    expect(isModelStatus('production')).toBe(true);
    expect(isModelStatus('shadow')).toBe(true);
    expect(isModelStatus('retired')).toBe(true);
    expect(isModelStatus('active')).toBe(false);
  });
});

// ─── Seed schema invariants ────────────────────────────────────────────

describe('SEED_MODELS schema', () => {
  test('exactly 8 model versions seeded', () => {
    expect(SEED_MODELS.length).toBe(8);
  });

  test('model_ids unique', () => {
    const ids = SEED_MODELS.map((m) => m.model_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every model declares required fields with valid types', () => {
    for (const m of SEED_MODELS) {
      expect(typeof m.model_id).toBe('string');
      expect(['pd', 'fraud', 'churn', 'lapse', 'anomaly', 'claim_severity']).toContain(m.type);
      expect(['experimental', 'staging', 'production', 'shadow', 'retired']).toContain(m.status);
      expect(['xgboost', 'sklearn', 'torch', 'lightgbm', 'isolation_forest']).toContain(m.framework);
      expect(Array.isArray(m.key_features)).toBe(true);
      expect(m.key_features.length).toBeGreaterThan(0);
      expect(typeof m.metrics.training_rows).toBe('number');
    }
  });

  test('exactly one production model per BIL pitch type (PD/fraud/churn/lapse/anomaly)', () => {
    const types: ModelType[] = ['pd', 'fraud', 'churn', 'lapse', 'anomaly'];
    for (const t of types) {
      const prod = SEED_MODELS.filter((m) => m.type === t && m.status === 'production');
      expect(prod.length).toBe(1);
    }
  });

  test('claim_severity model is in staging (regression model not yet in prod)', () => {
    const cs = SEED_MODELS.find((m) => m.type === 'claim_severity');
    expect(cs).toBeDefined();
    expect(cs!.status).toBe('staging');
  });

  test('regression model carries mae, binary models carry auc; anomaly carries neither', () => {
    for (const m of SEED_MODELS) {
      if (m.type === 'claim_severity') {
        expect(m.metrics.mae).toBeGreaterThan(0);
        expect(m.metrics.auc).toBeNull();
      } else if (m.type === 'anomaly') {
        expect(m.metrics.auc).toBeNull();
        expect(m.metrics.mae).toBeNull();
      } else {
        expect(m.metrics.auc).toBeGreaterThan(0);
        expect(m.metrics.mae).toBeNull();
      }
    }
  });

  test('retired model has retired_at set; live models have it null', () => {
    for (const m of SEED_MODELS) {
      if (m.status === 'retired') {
        expect(m.retired_at).not.toBeNull();
      } else {
        expect(m.retired_at).toBeNull();
      }
    }
  });
});

// ─── InMemoryAiModelRegistry — list + get + getProductionByType ────────

describe('InMemoryAiModelRegistry — list', () => {
  test('returns all 8 models, production first', () => {
    const r = new InMemoryAiModelRegistry();
    const items = r.list();
    expect(items.length).toBe(8);
    expect(items[0]!.status).toBe('production');
  });

  test('filter by type narrows', () => {
    const r = new InMemoryAiModelRegistry();
    const pd = r.list({ type: 'pd' });
    expect(pd.length).toBeGreaterThanOrEqual(2);
    for (const m of pd) expect(m.type).toBe('pd');
  });

  test('filter by status narrows', () => {
    const r = new InMemoryAiModelRegistry();
    const prod = r.list({ status: 'production' });
    expect(prod.length).toBe(5); // pd, fraud, churn, lapse, anomaly
    for (const m of prod) expect(m.status).toBe('production');
  });

  test('list ordering: production → shadow → staging → experimental → retired', () => {
    const r = new InMemoryAiModelRegistry();
    const items = r.list();
    const rank = { production: 0, shadow: 1, staging: 2, experimental: 3, retired: 4 } as const;
    for (let i = 1; i < items.length; i++) {
      expect(rank[items[i - 1]!.status] <= rank[items[i]!.status]).toBe(true);
    }
  });
});

describe('InMemoryAiModelRegistry — get + getProductionByType', () => {
  test('get returns the model + null on miss', () => {
    const r = new InMemoryAiModelRegistry();
    expect(r.get('pd_xgb_v3')!.type).toBe('pd');
    expect(r.get('no.such.model')).toBeNull();
  });

  test('getProductionByType returns the prod model', () => {
    const r = new InMemoryAiModelRegistry();
    expect(r.getProductionByType('pd')!.model_id).toBe('pd_xgb_v3');
    expect(r.getProductionByType('fraud')!.model_id).toBe('fraud_lgb_v1');
  });

  test('getProductionByType returns null when no production model (claim_severity)', () => {
    const r = new InMemoryAiModelRegistry();
    expect(r.getProductionByType('claim_severity')).toBeNull();
  });
});

// ─── InMemoryAiModelRegistry — score ───────────────────────────────────

describe('InMemoryAiModelRegistry — score', () => {
  test('produces a valid result for a binary classifier', () => {
    const r = new InMemoryAiModelRegistry();
    const res = r.score('pd_xgb_v3', { customer_id: 'c-1' }, 'BIL', NOW);
    expect(res.model_id).toBe('pd_xgb_v3');
    expect(res.customer_id).toBe('c-1');
    expect(res.score).toBeGreaterThanOrEqual(0);
    expect(res.score).toBeLessThanOrEqual(1);
    expect(res.probability).toBe(res.score);
    expect(['low', 'medium', 'high']).toContain(res.band);
    expect(res.scored_at).toBe(NOW.toISOString());
    expect(res.top_features.length).toBeGreaterThan(0);
  });

  test('regression model (claim_severity) returns positive KES with null probability + null band', () => {
    const r = new InMemoryAiModelRegistry();
    const res = r.score('claim_sev_lgb_v1', { customer_id: 'c-1' }, 'BIL', NOW);
    expect(res.score).toBeGreaterThan(0);
    expect(res.probability).toBeNull();
    expect(res.band).toBeNull();
  });

  test('anomaly model returns null probability + null band, score in [-1, 1]', () => {
    const r = new InMemoryAiModelRegistry();
    const res = r.score('anomaly_iforest_v2', { customer_id: 'c-1' }, 'BIL', NOW);
    expect(res.score).toBeGreaterThanOrEqual(-1);
    expect(res.score).toBeLessThanOrEqual(1);
    expect(res.probability).toBeNull();
    expect(res.band).toBeNull();
  });

  test('deterministic — same (model, tenant, customer, day) → identical', () => {
    const r = new InMemoryAiModelRegistry();
    const a = r.score('pd_xgb_v3', { customer_id: 'c-1' }, 'BIL', NOW);
    const b = r.score('pd_xgb_v3', { customer_id: 'c-1' }, 'BIL', NOW);
    expect(a).toEqual(b);
  });

  test('different tenants → different scores for same customer', () => {
    const r = new InMemoryAiModelRegistry();
    let differs = false;
    for (let i = 0; i < 50; i++) {
      const bil = r.score('pd_xgb_v3', { customer_id: `c-${i}` }, 'BIL', NOW);
      const bank = r.score('pd_xgb_v3', { customer_id: `c-${i}` }, 'BANK_DEMO', NOW);
      if (bil.score !== bank.score) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });

  test('band derivation: <0.3 low, <0.7 medium, ≥0.7 high', () => {
    const r = new InMemoryAiModelRegistry();
    let sawLow = false, sawMed = false, sawHigh = false;
    for (let i = 0; i < 200; i++) {
      const res = r.score('pd_xgb_v3', { customer_id: `c-${i}` }, 'BIL', NOW);
      if (res.band === 'low') {
        expect(res.score).toBeLessThan(0.3);
        sawLow = true;
      } else if (res.band === 'medium') {
        expect(res.score).toBeGreaterThanOrEqual(0.3);
        expect(res.score).toBeLessThan(0.7);
        sawMed = true;
      } else if (res.band === 'high') {
        expect(res.score).toBeGreaterThanOrEqual(0.7);
        sawHigh = true;
      }
    }
    expect(sawLow && sawMed && sawHigh).toBe(true);
  });

  test('top_features all from the model\'s declared key_features', () => {
    const r = new InMemoryAiModelRegistry();
    const model = r.get('pd_xgb_v3')!;
    const res = r.score('pd_xgb_v3', { customer_id: 'c-1' }, 'BIL', NOW);
    for (const f of res.top_features) {
      expect(model.key_features).toContain(f.feature);
    }
  });

  test('unknown model_id throws unknown_model', () => {
    const r = new InMemoryAiModelRegistry();
    try {
      r.score('no.such', { customer_id: 'c-1' }, 'BIL', NOW);
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ModelRegistryError);
      expect((e as ModelRegistryError).code).toBe('unknown_model');
    }
  });

  test('retired model throws retired', () => {
    const r = new InMemoryAiModelRegistry();
    try {
      r.score('pd_xgb_v2', { customer_id: 'c-1' }, 'BIL', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ModelRegistryError).code).toBe('retired');
    }
  });

  test('missing customer_id throws invalid_input', () => {
    const r = new InMemoryAiModelRegistry();
    try {
      r.score('pd_xgb_v3', { customer_id: '' }, 'BIL', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ModelRegistryError).code).toBe('invalid_input');
    }
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/ai/models/types', () => {
  test('returns the 6 BIL model types', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app).get('/v1/ai/models/types').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.items).toEqual(['pd', 'fraud', 'churn', 'lapse', 'anomaly', 'claim_severity']);
  });

  test('unknown role → 403', async () => {
    const { app } = makeAiApp('case_owner');
    const r = await request(app).get('/v1/ai/models/types').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/ai/models/by-type/:type', () => {
  test('valid type → 200 with production model', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app).get('/v1/ai/models/by-type/pd').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.model_id).toBe('pd_xgb_v3');
    expect(r.body.body.status).toBe('production');
  });

  test('claim_severity (no production) → 404 EWS_404_no_production_model', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app).get('/v1/ai/models/by-type/claim_severity').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_no_production_model');
  });

  test('invalid type → 400 EWS_400_invalid_type', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app).get('/v1/ai/models/by-type/foo').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_type');
  });
});

describe('GET /v1/ai/models', () => {
  test('admin: 200 with all 8 models', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app).get('/v1/ai/models').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(8);
  });

  test('?type=pd narrows', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app).get('/v1/ai/models?type=pd').set(TH_BIL);
    expect(r.body.body.total).toBeGreaterThanOrEqual(2);
    for (const m of r.body.body.items as ModelVersion[]) {
      expect(m.type).toBe('pd');
    }
  });

  test('?status=production narrows', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app).get('/v1/ai/models?status=production').set(TH_BIL);
    expect(r.body.body.total).toBe(5);
  });

  test('?type=invalid → 400 EWS_400_invalid_type', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app).get('/v1/ai/models?type=foo').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_type');
  });

  test('?status=invalid → 400 EWS_400_invalid_status', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app).get('/v1/ai/models?status=active').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_status');
  });
});

describe('GET /v1/ai/models/:model_id', () => {
  test('valid id → 200', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app).get('/v1/ai/models/pd_xgb_v3').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.model_id).toBe('pd_xgb_v3');
  });

  test('unknown id → 404 EWS_404_unknown_model', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app).get('/v1/ai/models/no.such').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_model');
  });
});

describe('GET /v1/ai/models/:model_id/metrics', () => {
  test('valid id → 200 with metrics block + status fields', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app).get('/v1/ai/models/pd_xgb_v3/metrics').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.model_id).toBe('pd_xgb_v3');
    expect(r.body.body.metrics.auc).toBe(0.847);
    expect(r.body.body.metrics.training_rows).toBe(1_250_000);
  });

  test('unknown id → 404', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app).get('/v1/ai/models/no.such/metrics').set(TH_BIL);
    expect(r.status).toBe(404);
  });
});

describe('POST /v1/ai/models/:model_id/score', () => {
  test('admin: 200 with valid InferenceResult', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app)
      .post('/v1/ai/models/pd_xgb_v3/score')
      .set(TH_BIL)
      .send({ customer_id: 'c-1' });
    expect(r.status).toBe(200);
    const res = r.body.body as InferenceResult;
    expect(res.model_id).toBe('pd_xgb_v3');
    expect(res.customer_id).toBe('c-1');
    expect(res.score).toBeGreaterThanOrEqual(0);
    expect(res.score).toBeLessThanOrEqual(1);
  });

  test('accepts an enveloped request body', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app)
      .post('/v1/ai/models/pd_xgb_v3/score')
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: { customer_id: 'c-1' } });
    expect(r.status).toBe(200);
  });

  test('missing customer_id → 400 EWS_400_invalid_input', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app).post('/v1/ai/models/pd_xgb_v3/score').set(TH_BIL).send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('unknown model_id → 404 EWS_404_unknown_model', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app)
      .post('/v1/ai/models/no.such/score')
      .set(TH_BIL)
      .send({ customer_id: 'c-1' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_model');
  });

  test('retired model → 409 EWS_409_retired', async () => {
    const { app } = makeAiApp('admin');
    const r = await request(app)
      .post('/v1/ai/models/pd_xgb_v2/score')
      .set(TH_BIL)
      .send({ customer_id: 'c-1' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_retired');
  });

  test('different tenants → different scores (tenant in seed)', async () => {
    const { app } = makeAiApp('admin');
    let differs = false;
    for (let i = 0; i < 50 && !differs; i++) {
      const bil = await request(app)
        .post('/v1/ai/models/pd_xgb_v3/score')
        .set(TH_BIL)
        .send({ customer_id: `c-${i}` });
      const bank = await request(app)
        .post('/v1/ai/models/pd_xgb_v3/score')
        .set(TH_BANK)
        .send({ customer_id: `c-${i}` });
      if (bil.body.body.score !== bank.body.body.score) differs = true;
    }
    expect(differs).toBe(true);
  });

  test('unknown role → 403', async () => {
    const { app } = makeAiApp('case_owner');
    const r = await request(app)
      .post('/v1/ai/models/pd_xgb_v3/score')
      .set(TH_BIL)
      .send({ customer_id: 'c-1' });
    expect(r.status).toBe(403);
  });
});
