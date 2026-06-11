// @ts-nocheck
// T6 M4.29 — Indicator trigger frequency analysis.

import request from 'supertest';
import { buildIndicatorTriggerFrequency } from '../src/indicator_trigger_frequency';
import { STUB_CATALOG } from '../src/bil_scoring_v2';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeFreqApp(role = 'admin') {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => role });
  return app;
}

describe('M4.29 — trigger frequency', () => {
  test('returns all indicators from STUB_CATALOG', () => {
    const out = buildIndicatorTriggerFrequency('BIL', NOW);
    expect(out.indicators.length).toBe(Object.keys(STUB_CATALOG).length);
  });

  test('each indicator has valid fields', () => {
    const out = buildIndicatorTriggerFrequency('BIL', NOW);
    for (const ind of out.indicators) {
      expect(ind.triggers_30d).toBeGreaterThanOrEqual(10);
      expect(ind.triggers_30d).toBeLessThanOrEqual(500);
      expect(ind.alerts_generated).toBeLessThanOrEqual(ind.triggers_30d);
      expect(ind.false_positive_estimate).toBeLessThanOrEqual(ind.alerts_generated);
      expect(ind.net_signal_alerts).toBe(ind.alerts_generated - ind.false_positive_estimate);
      expect(ind.trigger_rate_per_day).toBeGreaterThan(0);
    }
  });

  test('sorted by triggers_30d desc', () => {
    const out = buildIndicatorTriggerFrequency('BIL', NOW);
    for (let i = 0; i < out.indicators.length - 1; i++) {
      expect(out.indicators[i].triggers_30d).toBeGreaterThanOrEqual(out.indicators[i + 1].triggers_30d);
    }
  });

  test('highest_trigger_indicator is first', () => {
    const out = buildIndicatorTriggerFrequency('BIL', NOW);
    expect(out.highest_trigger_indicator).toBe(out.indicators[0].indicator_id);
  });

  test('total_triggers_30d = sum of all', () => {
    const out = buildIndicatorTriggerFrequency('BIL', NOW);
    const sum = out.indicators.reduce((s, i) => s + i.triggers_30d, 0);
    expect(out.total_triggers_30d).toBe(sum);
  });

  test('deterministic per (tenant, day)', () => {
    const out1 = buildIndicatorTriggerFrequency('BIL', NOW);
    const out2 = buildIndicatorTriggerFrequency('BIL', NOW);
    expect(out1.indicators[0].triggers_30d).toBe(out2.indicators[0].triggers_30d);
  });
});

describe('M4.29 — route', () => {
  test('risk_analyst GET /v1/indicators/trigger-frequency returns 200', async () => {
    const app = makeFreqApp('risk_analyst');
    const res = await request(app).get('/v1/indicators/trigger-frequency').set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.indicators)).toBe(true);
  });

  test('non-allowed role gets 403', async () => {
    const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => 'unknown_role' });
    const res = await request(app).get('/v1/indicators/trigger-frequency').set(TH);
    expect(res.status).toBe(403);
  });
});
