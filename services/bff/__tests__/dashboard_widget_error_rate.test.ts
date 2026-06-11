// @ts-nocheck
// T6 M11.25 — Dashboard widget error rate tests.

import request from 'supertest';
import { buildDashboardWidgetErrorRate } from '../src/dashboard_widget_error_rate';
import { WIDGET_TYPES } from '../src/custom_dashboards';
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

describe('M11.25 — buildDashboardWidgetErrorRate pure', () => {
  test('returns one entry per widget type', () => {
    const result = buildDashboardWidgetErrorRate('BIL', NOW);
    expect(result.widgets).toHaveLength(WIDGET_TYPES.length);
  });

  test('every widget has required fields in valid ranges', () => {
    const result = buildDashboardWidgetErrorRate('BIL', NOW);
    for (const w of result.widgets) {
      expect(w.error_rate).toBeGreaterThanOrEqual(0);
      expect(w.error_rate).toBeLessThanOrEqual(0.15);
      expect(w.avg_load_ms).toBeGreaterThanOrEqual(100);
      expect(w.avg_load_ms).toBeLessThanOrEqual(2000);
      expect(w.timeout_rate).toBeGreaterThanOrEqual(0);
      expect(w.timeout_rate).toBeLessThanOrEqual(0.05);
      expect(w.reliability_score).toBeGreaterThanOrEqual(0);
      expect(w.reliability_score).toBeLessThanOrEqual(100);
    }
  });

  test('sorted by reliability_score asc (least reliable first)', () => {
    const result = buildDashboardWidgetErrorRate('BIL', NOW);
    for (let i = 1; i < result.widgets.length; i++) {
      expect(result.widgets[i-1].reliability_score).toBeLessThanOrEqual(result.widgets[i].reliability_score);
    }
  });

  test('least_reliable has lowest score', () => {
    const result = buildDashboardWidgetErrorRate('BIL', NOW);
    const minScore = Math.min(...result.widgets.map((w) => w.reliability_score));
    const leastWidget = result.widgets.find((w) => w.widget_type === result.least_reliable_widget);
    expect(leastWidget.reliability_score).toBe(minScore);
  });

  test('fleet_avg_reliability is average of all widget scores', () => {
    const result = buildDashboardWidgetErrorRate('BIL', NOW);
    const expected = Math.round(result.widgets.reduce((s, w) => s + w.reliability_score, 0) / result.widgets.length);
    expect(result.fleet_avg_reliability).toBe(expected);
  });

  test('deterministic for same inputs', () => {
    const r1 = buildDashboardWidgetErrorRate('BIL', NOW);
    const r2 = buildDashboardWidgetErrorRate('BIL', NOW);
    expect(r1.widgets[0].error_rate).toBe(r2.widgets[0].error_rate);
  });
});

describe('M11.25 — GET /v1/dashboards/widgets/error-rate route', () => {
  test('admin 200 with envelope', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/dashboards/widgets/error-rate').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body.widgets).toBeInstanceOf(Array);
  });

  test('field_officer 403', async () => {
    const app = makeTestApp('field_officer');
    const res = await request(app).get('/v1/dashboards/widgets/error-rate').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant header → 400', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/dashboards/widgets/error-rate');
    expect(res.status).toBe(400);
  });
});
