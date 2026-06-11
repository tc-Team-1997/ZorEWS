// @ts-nocheck
// T6 M4.28 — Indicator value distribution tests.

import request from 'supertest';
import { buildIndicatorValueDistribution } from '../src/indicator_value_distribution';
import { STUB_CATALOG } from '../src/bil_scoring_v2';
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

describe('M4.28 — buildIndicatorValueDistribution pure', () => {
  test('returns one entry per STUB_CATALOG indicator', () => {
    const result = buildIndicatorValueDistribution('BIL', NOW);
    const catalogSize = Object.keys(STUB_CATALOG).length;
    expect(result.indicators).toHaveLength(catalogSize);
  });

  test('every indicator has required shape', () => {
    const result = buildIndicatorValueDistribution('BIL', NOW);
    for (const ind of result.indicators) {
      expect(typeof ind.indicator_id).toBe('string');
      expect(typeof ind.name).toBe('string');
      expect(typeof ind.vertical).toBe('string');
      expect(ind.p10).toBeGreaterThanOrEqual(0);
      expect(ind.p90).toBeLessThanOrEqual(1);
      expect(ind.p10).toBeLessThanOrEqual(ind.p25);
      expect(ind.p25).toBeLessThanOrEqual(ind.p50);
      expect(ind.p50).toBeLessThanOrEqual(ind.p75);
      expect(ind.p75).toBeLessThanOrEqual(ind.p90);
      expect(ind.std_dev).toBeGreaterThanOrEqual(0);
      expect(['left_skewed', 'right_skewed', 'symmetric']).toContain(ind.shape);
    }
  });

  test('deterministic for same inputs', () => {
    const r1 = buildIndicatorValueDistribution('BIL', NOW);
    const r2 = buildIndicatorValueDistribution('BIL', NOW);
    expect(r1.indicators[0].mean).toBe(r2.indicators[0].mean);
  });

  test('different tenant → different values', () => {
    const r1 = buildIndicatorValueDistribution('BIL', NOW);
    const r2 = buildIndicatorValueDistribution('BANK_DEMO', NOW);
    // Very unlikely they are identical
    const same = r1.indicators.every((ind, i) => ind.mean === r2.indicators[i].mean);
    expect(same).toBe(false);
  });

  test('most_variable and least_variable populated when catalog non-empty', () => {
    const result = buildIndicatorValueDistribution('BIL', NOW);
    expect(result.most_variable_indicator).not.toBeNull();
    expect(result.least_variable_indicator).not.toBeNull();
  });

  test('tenant_id and generated_at echo', () => {
    const result = buildIndicatorValueDistribution('BIL', NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

describe('M4.28 — GET /v1/indicators/value-distribution route', () => {
  test('admin 200 with envelope', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/indicators/value-distribution').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toBeDefined();
    expect(res.body.body.indicators).toBeInstanceOf(Array);
  });

  test('risk_analyst accepted', async () => {
    const app = makeTestApp('risk_analyst');
    const res = await request(app).get('/v1/indicators/value-distribution').set(TH);
    expect(res.status).toBe(200);
  });

  test('unknown_role 403', async () => {
    const app = makeTestApp('unknown_role_xyz');
    const res = await request(app).get('/v1/indicators/value-distribution').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant header → 400', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/indicators/value-distribution');
    expect(res.status).toBe(400);
  });
});
