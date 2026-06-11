// @ts-nocheck
// T6 M4.30 — Indicator alert effectiveness tests.

import request from 'supertest';
import { buildIndicatorAlertEffectiveness } from '../src/indicator_alert_effectiveness';
import { STUB_CATALOG } from '../src/bil_scoring_v2';
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

describe('M4.30 — buildIndicatorAlertEffectiveness pure', () => {
  test('returns all catalog indicators', () => {
    const result = buildIndicatorAlertEffectiveness('BIL', NOW);
    expect(result.indicators).toHaveLength(Object.keys(STUB_CATALOG).length);
    expect(result.tenant_id).toBe('BIL');
  });

  test('every indicator has valid metrics', () => {
    const result = buildIndicatorAlertEffectiveness('BIL', NOW);
    for (const ind of result.indicators) {
      expect(ind.f1_score).toBeGreaterThanOrEqual(0);
      expect(ind.f1_score).toBeLessThanOrEqual(1);
      expect(ind.precision).toBeGreaterThanOrEqual(0);
      expect(ind.recall).toBeGreaterThanOrEqual(0);
      expect(['A', 'B', 'C', 'D']).toContain(ind.effectiveness_grade);
    }
  });

  test('sorted by f1_score descending', () => {
    const result = buildIndicatorAlertEffectiveness('BIL', NOW);
    for (let i = 1; i < result.indicators.length; i++) {
      expect(result.indicators[i - 1].f1_score).toBeGreaterThanOrEqual(
        result.indicators[i].f1_score,
      );
    }
  });

  test('avg_f1_score is in valid range', () => {
    const result = buildIndicatorAlertEffectiveness('BIL', NOW);
    expect(result.avg_f1_score).toBeGreaterThan(0);
    expect(result.avg_f1_score).toBeLessThanOrEqual(1);
  });

  test('throws on empty tenant_id', () => {
    expect(() => buildIndicatorAlertEffectiveness('', NOW)).toThrow();
  });
});

describe('M4.30 — GET /v1/indicators/alert-effectiveness route', () => {
  test('risk_analyst returns 200', async () => {
    const { app } = makeTestApp('risk_analyst');
    const res = await request(app)
      .get('/v1/indicators/alert-effectiveness')
      .set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.indicators)).toBe(true);
    expect(res.body.body.indicators.length).toBeGreaterThan(0);
  });

  test('admin returns 200', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/indicators/alert-effectiveness')
      .set(TH);
    expect(res.status).toBe(200);
  });

  test('unknown role returns 403', async () => {
    const { app } = makeTestApp('viewer');
    const res = await request(app)
      .get('/v1/indicators/alert-effectiveness')
      .set(TH);
    expect(res.status).toBe(403);
  });
});
