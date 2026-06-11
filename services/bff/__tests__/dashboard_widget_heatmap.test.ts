// @ts-nocheck
// services/bff/__tests__/dashboard_widget_heatmap.test.ts
// T6 M11.22 — Dashboard widget interaction heatmap.

import request from 'supertest';
import { buildDashboardWidgetInteractionHeatmap } from '../src/dashboard_widget_heatmap';
import { WIDGET_TYPES } from '../src/custom_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-11T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function fakeApp(role = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    getRole: () => role,
    now: () => NOW,
  });
  return app;
}

// ─── Pure function tests ────────────────────────────────────────────────

describe('M11.22 — buildDashboardWidgetInteractionHeatmap — shape', () => {
  test('returns all widget types', () => {
    const out = buildDashboardWidgetInteractionHeatmap('BIL', NOW);
    expect(out.widgets).toHaveLength(WIDGET_TYPES.length);
  });

  test('all interaction_scores in [0, 100]', () => {
    const out = buildDashboardWidgetInteractionHeatmap('BIL', NOW);
    for (const w of out.widgets) {
      expect(w.interaction_score).toBeGreaterThanOrEqual(0);
      expect(w.interaction_score).toBeLessThanOrEqual(100);
    }
  });

  test('sorted by score desc', () => {
    const out = buildDashboardWidgetInteractionHeatmap('BIL', NOW);
    for (let i = 0; i < out.widgets.length - 1; i++) {
      expect(out.widgets[i].interaction_score).toBeGreaterThanOrEqual(out.widgets[i + 1].interaction_score);
    }
  });

  test('relative_rank starts at 1 and increments', () => {
    const out = buildDashboardWidgetInteractionHeatmap('BIL', NOW);
    expect(out.widgets[0].relative_rank).toBe(1);
    expect(out.widgets[out.widgets.length - 1].relative_rank).toBe(WIDGET_TYPES.length);
  });

  test('most_interacted is the first widget', () => {
    const out = buildDashboardWidgetInteractionHeatmap('BIL', NOW);
    expect(out.most_interacted).toBe(out.widgets[0].widget_type);
  });

  test('least_interacted is the last widget', () => {
    const out = buildDashboardWidgetInteractionHeatmap('BIL', NOW);
    expect(out.least_interacted).toBe(out.widgets[out.widgets.length - 1].widget_type);
  });

  test('deterministic per (tenant, day)', () => {
    const a = buildDashboardWidgetInteractionHeatmap('BIL', NOW);
    const b = buildDashboardWidgetInteractionHeatmap('BIL', NOW);
    expect(a.most_interacted).toBe(b.most_interacted);
  });

  test('different tenants yield different rankings', () => {
    const a = buildDashboardWidgetInteractionHeatmap('BIL', NOW);
    const b = buildDashboardWidgetInteractionHeatmap('BANK_DEMO', NOW);
    // Different tenants should produce some difference
    const differs = a.widgets.some((w, i) => w.interaction_score !== b.widgets[i].interaction_score);
    expect(differs).toBe(true);
  });

  test('each widget has display_name', () => {
    const out = buildDashboardWidgetInteractionHeatmap('BIL', NOW);
    for (const w of out.widgets) {
      expect(typeof w.display_name).toBe('string');
      expect(w.display_name.length).toBeGreaterThan(0);
    }
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M11.22 — route GET /v1/dashboards/widgets/interaction-heatmap', () => {
  test('admin → 200 with widget array', async () => {
    const app = fakeApp('admin');
    const res = await request(app).get('/v1/dashboards/widgets/interaction-heatmap').set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.widgets)).toBe(true);
    expect(res.body.body.widgets.length).toBe(WIDGET_TYPES.length);
  });

  test('case_owner → 403', async () => {
    const app = fakeApp('case_owner');
    const res = await request(app).get('/v1/dashboards/widgets/interaction-heatmap').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant → 400', async () => {
    const app = fakeApp('admin');
    const res = await request(app).get('/v1/dashboards/widgets/interaction-heatmap');
    expect(res.status).toBe(400);
  });
});
