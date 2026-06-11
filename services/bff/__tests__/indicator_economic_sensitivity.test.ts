// @ts-nocheck
// services/bff/__tests__/indicator_economic_sensitivity.test.ts
// T6 M4.24 — Indicator sensitivity to economic conditions

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { STUB_CATALOG } from '../src/bil_scoring_v2';
import { computeIndicatorEconomicSensitivity } from '../src/indicator_economic_sensitivity';

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

describe('computeIndicatorEconomicSensitivity()', () => {
  test('returns one entry per STUB_CATALOG indicator', () => {
    const result = computeIndicatorEconomicSensitivity('BIL', NOW);
    const catalogCount = Object.keys(STUB_CATALOG).length;
    expect(result.indicators).toHaveLength(catalogCount);
  });

  test('all sensitivity values are in [0, 1]', () => {
    const result = computeIndicatorEconomicSensitivity('BIL', NOW);
    for (const ind of result.indicators) {
      expect(ind.gdp_sensitivity).toBeGreaterThanOrEqual(0);
      expect(ind.gdp_sensitivity).toBeLessThanOrEqual(1);
      expect(ind.rate_sensitivity).toBeGreaterThanOrEqual(0);
      expect(ind.rate_sensitivity).toBeLessThanOrEqual(1);
      expect(ind.inflation_sensitivity).toBeGreaterThanOrEqual(0);
      expect(ind.inflation_sensitivity).toBeLessThanOrEqual(1);
      expect(ind.overall_sensitivity).toBeGreaterThanOrEqual(0);
      expect(ind.overall_sensitivity).toBeLessThanOrEqual(1);
    }
  });

  test('overall_sensitivity is max of gdp/rate/inflation', () => {
    const result = computeIndicatorEconomicSensitivity('BIL', NOW);
    for (const ind of result.indicators) {
      const expected = Math.max(ind.gdp_sensitivity, ind.rate_sensitivity, ind.inflation_sensitivity);
      expect(ind.overall_sensitivity).toBeCloseTo(expected, 3);
    }
  });

  test('sorted by overall_sensitivity desc', () => {
    const result = computeIndicatorEconomicSensitivity('BIL', NOW);
    for (let i = 1; i < result.indicators.length; i++) {
      expect(result.indicators[i - 1].overall_sensitivity).toBeGreaterThanOrEqual(
        result.indicators[i].overall_sensitivity,
      );
    }
  });

  test('most_sensitive_indicator is first in list', () => {
    const result = computeIndicatorEconomicSensitivity('BIL', NOW);
    expect(result.most_sensitive_indicator).not.toBeNull();
    expect(result.most_sensitive_indicator.indicator_id).toBe(result.indicators[0].indicator_id);
  });

  test('avg_overall_sensitivity is in [0, 1]', () => {
    const result = computeIndicatorEconomicSensitivity('BIL', NOW);
    expect(result.avg_overall_sensitivity).toBeGreaterThanOrEqual(0);
    expect(result.avg_overall_sensitivity).toBeLessThanOrEqual(1);
  });

  test('deterministic — same tenant+date produces same results', () => {
    const r1 = computeIndicatorEconomicSensitivity('BIL', NOW);
    const r2 = computeIndicatorEconomicSensitivity('BIL', NOW);
    expect(r1.indicators[0].indicator_id).toBe(r2.indicators[0].indicator_id);
    expect(r1.avg_overall_sensitivity).toBe(r2.avg_overall_sensitivity);
  });

  test('generated_at echoed', () => {
    const result = computeIndicatorEconomicSensitivity('BIL', NOW);
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

describe('GET /v1/indicators/economic-sensitivity', () => {
  test('admin returns 200 with indicators array', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/indicators/economic-sensitivity')
      .set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('indicators');
    expect(res.body.body).toHaveProperty('most_sensitive_indicator');
  });

  test('risk_analyst accepted (customers:read_risk_profile)', async () => {
    const { app } = makeTestApp('risk_analyst');
    const res = await request(app)
      .get('/v1/indicators/economic-sensitivity')
      .set(TH);
    expect(res.status).toBe(200);
  });

  test('unknown role returns 403', async () => {
    const { app } = makeTestApp('unknown_role');
    const res = await request(app)
      .get('/v1/indicators/economic-sensitivity')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('missing tenant header returns 400', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/indicators/economic-sensitivity')
      .set('X-Channel', 'API');
    expect(res.status).toBe(400);
  });
});
