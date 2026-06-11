// @ts-nocheck
// services/bff/__tests__/dashboard_complexity_score.test.ts
// T6 M11.21 — Dashboard layout complexity score.

import request from 'supertest';
import { buildDashboardComplexityScores } from '../src/dashboard_complexity_score';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { defaultCustomDashboardStore, type CustomDashboard } from '../src/custom_dashboards';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function fakeApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    getRole: () => role,
    now: () => NOW,
  });
}

function makeDash(overrides = {}): CustomDashboard {
  return {
    dashboard_id: `d-${Math.random().toString(36).slice(2)}`,
    tenant_id: 'BIL',
    name: 'Test Dashboard',
    description: '',
    widgets: [],
    created_by: 'admin',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    version: 1,
    ...overrides,
  };
}

// ─── Pure function tests ────────────────────────────────────────────────

describe('M11.21 — buildDashboardComplexityScores — empty', () => {
  test('no dashboards → zero results', () => {
    const out = buildDashboardComplexityScores('BIL', [], NOW);
    expect(out.total_dashboards).toBe(0);
    expect(out.scores).toHaveLength(0);
    expect(out.most_complex).toBeNull();
    expect(out.avg_complexity).toBe(0);
  });
});

describe('M11.21 — complexity formula', () => {
  test('widget_count*10 + max_row_span*5 + distinct_types*8', () => {
    const dash = makeDash({
      widgets: [
        { widget_type: 'alerts_by_class', position: { row: 0, col: 0 }, span: { rows: 2, cols: 6 }, config: {} },
        { widget_type: 'open_cases', position: { row: 2, col: 0 }, span: { rows: 3, cols: 6 }, config: {} },
      ],
    });
    const out = buildDashboardComplexityScores('BIL', [dash], NOW);
    const score = out.scores[0];
    // widget_count=2, distinct_types=2, max_row_span=5
    expect(score.widget_count).toBe(2);
    expect(score.distinct_widget_types).toBe(2);
    expect(score.max_row_span).toBe(5);
    expect(score.complexity_score).toBe(2 * 10 + 5 * 5 + 2 * 8); // 20+25+16=61
    expect(score.tier).toBe('moderate');
  });
});

describe('M11.21 — tiers', () => {
  test('0 widgets → simple (score=0)', () => {
    const dash = makeDash({ widgets: [] });
    const out = buildDashboardComplexityScores('BIL', [dash], NOW);
    expect(out.scores[0].tier).toBe('simple');
  });

  test('score > 70 → complex', () => {
    const widgets = [];
    for (let i = 0; i < 5; i++) {
      widgets.push({ widget_type: 'tenant_kpi', position: { row: i * 2, col: 0 }, span: { rows: 2, cols: 3 }, config: {} });
    }
    // 5 widgets × 10 = 50, max_row_span = 10×5=50, distinct_types=1×8=8 → 50+50+8=108 > 70
    const dash = makeDash({ widgets });
    const out = buildDashboardComplexityScores('BIL', [dash], NOW);
    expect(out.scores[0].tier).toBe('complex');
  });
});

describe('M11.21 — sort order', () => {
  test('sorted complexity_score desc', () => {
    const simple = makeDash({ widgets: [] });
    const complex = makeDash({
      widgets: [
        { widget_type: 'risk_score_histogram', position: { row: 0, col: 0 }, span: { rows: 10, cols: 6 }, config: {} },
        { widget_type: 'alerts_by_class', position: { row: 10, col: 0 }, span: { rows: 3, cols: 6 }, config: {} },
        { widget_type: 'open_cases', position: { row: 13, col: 0 }, span: { rows: 2, cols: 6 }, config: {} },
      ],
    });
    const out = buildDashboardComplexityScores('BIL', [simple, complex], NOW);
    expect(out.scores[0].complexity_score).toBeGreaterThan(out.scores[1].complexity_score);
    expect(out.most_complex.dashboard_id).toBe(complex.dashboard_id);
  });
});

describe('M11.21 — tenant isolation', () => {
  test('BANK_DEMO dashboards not counted for BIL', () => {
    const dash = makeDash({ tenant_id: 'BANK_DEMO' });
    const out = buildDashboardComplexityScores('BIL', [dash], NOW);
    expect(out.total_dashboards).toBe(0);
  });
});

describe('M11.21 — tier_distribution', () => {
  test('sum of tier_distribution equals total_dashboards', () => {
    const d1 = makeDash({ widgets: [] });
    const d2 = makeDash({ widgets: [{ widget_type: 'tenant_kpi', position: { row: 0, col: 0 }, span: { rows: 2, cols: 3 }, config: {} }] });
    const out = buildDashboardComplexityScores('BIL', [d1, d2], NOW);
    const total = out.tier_distribution.simple + out.tier_distribution.moderate + out.tier_distribution.complex;
    expect(total).toBe(out.total_dashboards);
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M11.21 — route', () => {
  test('GET /v1/dashboards/custom/complexity-scores → 200', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/dashboards/custom/complexity-scores')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.scores)).toBe(true);
    expect(res.body.body).toHaveProperty('tier_distribution');
  });

  test('403 for unknown role', async () => {
    const { app } = fakeApp('viewer');
    const res = await request(app)
      .get('/v1/dashboards/custom/complexity-scores')
      .set(TH_BIL)
      .set('x-apex-role', 'viewer');
    expect(res.status).toBe(403);
  });

  test('400 when no tenant header', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/dashboards/custom/complexity-scores')
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });
});
