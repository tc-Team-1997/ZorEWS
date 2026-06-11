// @ts-nocheck
// T6 M5.27 — Rule engine throughput metrics tests.

import request from 'supertest';
import { buildRuleEngineThroughput } from '../src/rule_engine_throughput';
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

describe('M5.27 — buildRuleEngineThroughput pure', () => {
  test('returns correct shape', () => {
    const result = buildRuleEngineThroughput('BIL', NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.generated_at).toBe(NOW.toISOString());
    expect(result.evaluations_per_second).toBeGreaterThanOrEqual(100);
    expect(result.evaluations_per_second).toBeLessThanOrEqual(500);
    expect(result.avg_evaluation_ms).toBeGreaterThanOrEqual(0.5);
    expect(result.avg_evaluation_ms).toBeLessThanOrEqual(5);
    expect(result.cache_hit_rate).toBeGreaterThanOrEqual(0.7);
    expect(result.cache_hit_rate).toBeLessThanOrEqual(0.95);
    expect(result.memory_usage_mb).toBeGreaterThanOrEqual(50);
    expect(result.memory_usage_mb).toBeLessThanOrEqual(200);
    expect(result.rules_loaded).toBeGreaterThan(0);
  });

  test('efficiency_score and status are consistent', () => {
    const result = buildRuleEngineThroughput('BIL', NOW);
    if (result.efficiency_score >= 80) expect(result.status).toBe('optimal');
    else if (result.efficiency_score >= 60) expect(result.status).toBe('good');
    else expect(result.status).toBe('degraded');
  });

  test('deterministic for same inputs', () => {
    const r1 = buildRuleEngineThroughput('BIL', NOW);
    const r2 = buildRuleEngineThroughput('BIL', NOW);
    expect(r1.evaluations_per_second).toBe(r2.evaluations_per_second);
    expect(r1.cache_hit_rate).toBe(r2.cache_hit_rate);
  });

  test('different tenant yields different metrics', () => {
    const r1 = buildRuleEngineThroughput('BIL', NOW);
    const r2 = buildRuleEngineThroughput('BANK_DEMO', NOW);
    // Very likely to differ
    expect(r1.evaluations_per_second === r2.evaluations_per_second &&
           r1.cache_hit_rate === r2.cache_hit_rate).toBe(false);
  });
});

describe('M5.27 — GET /v1/rules/engine/throughput route', () => {
  test('admin 200 with envelope', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/rules/engine/throughput').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toBeDefined();
    expect(res.body.body.evaluations_per_second).toBeGreaterThan(0);
  });

  test('risk_analyst accepted', async () => {
    const app = makeTestApp('risk_analyst');
    const res = await request(app).get('/v1/rules/engine/throughput').set(TH);
    expect(res.status).toBe(200);
  });

  test('unknown_role 403', async () => {
    const app = makeTestApp('unknown_role_xyz');
    const res = await request(app).get('/v1/rules/engine/throughput').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant header → 400', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/rules/engine/throughput');
    expect(res.status).toBe(400);
  });
});
