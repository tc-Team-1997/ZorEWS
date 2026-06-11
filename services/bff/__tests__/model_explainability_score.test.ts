// @ts-nocheck
// T6 M7.29 — Model explainability score tests.

import request from 'supertest';
import { buildModelExplainabilityScore } from '../src/model_explainability_score';
import { InMemoryAiModelRegistry, SEED_MODELS } from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'risk_analyst') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
  return { app };
}

describe('M7.29 — buildModelExplainabilityScore pure', () => {
  test('registry returns non-empty result with seed models', async () => {
    const registry = new InMemoryAiModelRegistry();
    const result = await buildModelExplainabilityScore('BIL', NOW, registry);
    // SEED_MODELS is always present in the global registry
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.most_explainable_model).not.toBeNull();
    expect(result.avg_explainability).toBeGreaterThan(0);
  });

  test('seed models have valid explainability scores', async () => {
    const registry = new InMemoryAiModelRegistry();
    const result = await buildModelExplainabilityScore('BIL', NOW, registry);
    expect(result.models.length).toBeGreaterThan(0);
    for (const m of result.models) {
      expect(m.explainability_score).toBeGreaterThanOrEqual(0);
      expect(m.explainability_score).toBeLessThanOrEqual(100);
      expect(['A', 'B', 'C', 'D']).toContain(m.interpretability_grade);
      expect(typeof m.has_shap_support).toBe('boolean');
    }
  });

  test('sorted by explainability_score desc', async () => {
    const registry = new InMemoryAiModelRegistry();
    const result = await buildModelExplainabilityScore('BIL', NOW, registry);
    for (let i = 1; i < result.models.length; i++) {
      expect(result.models[i - 1].explainability_score).toBeGreaterThanOrEqual(
        result.models[i].explainability_score,
      );
    }
  });

  test('most_explainable_model is first in sorted list', async () => {
    const registry = new InMemoryAiModelRegistry();
    const result = await buildModelExplainabilityScore('BIL', NOW, registry);
    if (result.models.length > 0) {
      expect(result.most_explainable_model).toBe(result.models[0].model_id);
    }
  });

  test('throws on empty tenant_id', async () => {
    const registry = new InMemoryAiModelRegistry();
    await expect(buildModelExplainabilityScore('', NOW, registry)).rejects.toThrow();
  });
});

describe('M7.29 — GET /v1/ai/models/explainability route', () => {
  test('risk_analyst returns 200', async () => {
    const { app } = makeTestApp('risk_analyst');
    const res = await request(app)
      .get('/v1/ai/models/explainability')
      .set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.models)).toBe(true);
    expect(typeof res.body.body.avg_explainability).toBe('number');
  });

  test('unknown role returns 403', async () => {
    const { app } = makeTestApp('viewer');
    const res = await request(app)
      .get('/v1/ai/models/explainability')
      .set(TH);
    expect(res.status).toBe(403);
  });
});
