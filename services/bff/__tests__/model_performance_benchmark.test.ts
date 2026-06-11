// @ts-nocheck
// services/bff/__tests__/model_performance_benchmark.test.ts
// T6 M7.24 — Model performance benchmark comparison

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { defaultAiModelRegistry, InMemoryAiModelRegistry, SEED_MODELS } from '../src/ai_model_registry';
import { InMemoryModelPerformanceStore } from '../src/model_performance';
import { computeModelPerformanceBenchmark, BENCHMARK_AUC } from '../src/model_performance_benchmark';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('computeModelPerformanceBenchmark()', () => {
  test('returns one entry per model in registry', () => {
    const registry = new InMemoryAiModelRegistry();
    const perfStore = new InMemoryModelPerformanceStore(registry);
    const result = computeModelPerformanceBenchmark('BIL', registry, perfStore, NOW);
    const allModels = registry.list();
    expect(result.models).toHaveLength(allModels.length);
  });

  test('no performance data → latest_auc is null', () => {
    const registry = new InMemoryAiModelRegistry();
    const perfStore = new InMemoryModelPerformanceStore(registry);
    const result = computeModelPerformanceBenchmark('BIL', registry, perfStore, NOW);
    for (const m of result.models) {
      expect(m.latest_auc).toBeNull();
    }
  });

  test('exceeds_benchmark is null when no perf data', () => {
    const registry = new InMemoryAiModelRegistry();
    const perfStore = new InMemoryModelPerformanceStore(registry);
    const result = computeModelPerformanceBenchmark('BIL', registry, perfStore, NOW);
    for (const m of result.models) {
      expect(m.exceeds_benchmark).toBeNull();
    }
  });

  test('with AUC recorded, exceeds_benchmark is set correctly', () => {
    const registry = new InMemoryAiModelRegistry();
    const perfStore = new InMemoryModelPerformanceStore(registry);
    // Find a PD model
    const pdModel = registry.list({ type: 'pd' })[0];
    if (pdModel) {
      perfStore.record('BIL', pdModel.model_id, { metric: 'auc', value: 0.88, sample_size: 1000 }, NOW);
      const result = computeModelPerformanceBenchmark('BIL', registry, perfStore, NOW);
      const entry = result.models.find((m) => m.model_id === pdModel.model_id);
      if (entry && entry.latest_auc !== null && entry.benchmark_auc !== null) {
        expect(entry.exceeds_benchmark).toBe(entry.latest_auc > entry.benchmark_auc);
      }
    }
  });

  test('benchmark_definitions includes pd_auc', () => {
    const registry = new InMemoryAiModelRegistry();
    const perfStore = new InMemoryModelPerformanceStore(registry);
    const result = computeModelPerformanceBenchmark('BIL', registry, perfStore, NOW);
    expect(result.benchmark_definitions).toHaveProperty('pd_auc');
    expect(result.benchmark_definitions.pd_auc).toBe(BENCHMARK_AUC.pd);
  });

  test('generated_at echoed', () => {
    const registry = new InMemoryAiModelRegistry();
    const perfStore = new InMemoryModelPerformanceStore(registry);
    const result = computeModelPerformanceBenchmark('BIL', registry, perfStore, NOW);
    expect(result.generated_at).toBe(NOW.toISOString());
  });

  test('tenant_id echoed', () => {
    const registry = new InMemoryAiModelRegistry();
    const perfStore = new InMemoryModelPerformanceStore(registry);
    const result = computeModelPerformanceBenchmark('BIL', registry, perfStore, NOW);
    expect(result.tenant_id).toBe('BIL');
  });

  test('models_above_benchmark and below sum correctly', () => {
    const registry = new InMemoryAiModelRegistry();
    const perfStore = new InMemoryModelPerformanceStore(registry);
    const result = computeModelPerformanceBenchmark('BIL', registry, perfStore, NOW);
    // With no perf data, both should be 0
    expect(result.models_above_benchmark).toBe(0);
    expect(result.models_below_benchmark).toBe(0);
  });
});

describe('GET /v1/ai/models/benchmark', () => {
  test('admin returns 200 with models array', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/ai/models/benchmark')
      .set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('models');
    expect(res.body.body).toHaveProperty('benchmark_definitions');
  });

  test('risk_analyst accepted', async () => {
    const { app } = makeTestApp('risk_analyst');
    const res = await request(app)
      .get('/v1/ai/models/benchmark')
      .set(TH);
    expect(res.status).toBe(200);
  });

  test('unknown role returns 403', async () => {
    const { app } = makeTestApp('unknown_role_xyz');
    const res = await request(app)
      .get('/v1/ai/models/benchmark')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('missing tenant header returns 400', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/ai/models/benchmark')
      .set('X-Channel', 'API');
    expect(res.status).toBe(400);
  });
});
