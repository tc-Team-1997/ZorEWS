// @ts-nocheck
// T6 M7.27 — Model feature importance tests.

import request from 'supertest';
import { buildModelFeatureImportance } from '../src/model_feature_importance';
import { defaultAiModelRegistry, SEED_MODELS } from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
  return app;
}

describe('M7.27 — buildModelFeatureImportance pure', () => {
  test('returns production models only', () => {
    const result = buildModelFeatureImportance('BIL', NOW);
    const productionModels = defaultAiModelRegistry.list({ status: 'production' });
    expect(result.models).toHaveLength(productionModels.length);
  });

  test('importances sum to approximately 1.0 per model', () => {
    const result = buildModelFeatureImportance('BIL', NOW);
    for (const model of result.models) {
      if (model.features.length === 0) continue;
      const total = model.features.reduce((s, f) => s + f.importance, 0);
      expect(total).toBeCloseTo(1.0, 1);
    }
  });

  test('features sorted by importance desc', () => {
    const result = buildModelFeatureImportance('BIL', NOW);
    for (const model of result.models) {
      for (let i = 1; i < model.features.length; i++) {
        expect(model.features[i-1].importance).toBeGreaterThanOrEqual(model.features[i].importance);
      }
    }
  });

  test('rank starts at 1', () => {
    const result = buildModelFeatureImportance('BIL', NOW);
    for (const model of result.models) {
      if (model.features.length > 0) {
        expect(model.features[0].rank).toBe(1);
      }
    }
  });

  test('top_feature matches first feature', () => {
    const result = buildModelFeatureImportance('BIL', NOW);
    for (const model of result.models) {
      if (model.features.length > 0) {
        expect(model.top_feature).toBe(model.features[0].name);
      }
    }
  });

  test('deterministic for same inputs', () => {
    const r1 = buildModelFeatureImportance('BIL', NOW);
    const r2 = buildModelFeatureImportance('BIL', NOW);
    if (r1.models.length > 0 && r1.models[0].features.length > 0) {
      expect(r1.models[0].features[0].importance).toBe(r2.models[0].features[0].importance);
    }
  });

  test('tenant_id and generated_at echoed', () => {
    const result = buildModelFeatureImportance('BIL', NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

describe('M7.27 — GET /v1/ai/models/feature-importance route', () => {
  test('admin 200 with envelope', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/ai/models/feature-importance').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toBeDefined();
    expect(res.body.body.models).toBeInstanceOf(Array);
  });

  test('risk_analyst accepted', async () => {
    const app = makeTestApp('risk_analyst');
    const res = await request(app).get('/v1/ai/models/feature-importance').set(TH);
    expect(res.status).toBe(200);
  });

  test('unknown_role 403', async () => {
    const app = makeTestApp('unknown_role_xyz');
    const res = await request(app).get('/v1/ai/models/feature-importance').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant header → 400', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/ai/models/feature-importance');
    expect(res.status).toBe(400);
  });
});
