// @ts-nocheck
// T6 M11.27 — Dashboard widget dependency analysis tests.

import request from 'supertest';
import { buildDashboardWidgetDependencies } from '../src/dashboard_widget_dependencies';
import { InMemoryCustomDashboardStore, WIDGET_TYPES } from '../src/custom_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin', customDashboardStore?) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    customDashboardStore,
  });
  return { app };
}

describe('M11.27 — buildDashboardWidgetDependencies pure', () => {
  test('empty store returns empty co_occurrences', () => {
    const store = new InMemoryCustomDashboardStore();
    const result = buildDashboardWidgetDependencies('BIL', NOW, store);
    expect(result.total_dashboards).toBe(0);
    expect(result.co_occurrences).toHaveLength(0);
    expect(result.most_paired_widget).toBeNull();
    expect(result.isolated_widget_types.length).toBeGreaterThan(0);
  });

  test('dashboard with 2 widgets creates 1 co-occurrence', () => {
    const store = new InMemoryCustomDashboardStore();
    store.create('BIL', {
      name: 'test',
      widgets: [
        { widget_type: 'alerts_by_class', config: {}, position: { row: 0, col: 0 }, span: { rows: 1, cols: 1 } },
        { widget_type: 'open_cases', config: {}, position: { row: 0, col: 1 }, span: { rows: 1, cols: 1 } },
      ],
    }, 'admin', NOW);
    const result = buildDashboardWidgetDependencies('BIL', NOW, store);
    expect(result.co_occurrences).toHaveLength(1);
    const pair = result.co_occurrences[0];
    const types = [pair.widget_a, pair.widget_b].sort();
    expect(types).toContain('alerts_by_class');
    expect(types).toContain('open_cases');
    expect(pair.count).toBe(1);
  });

  test('isolated_widget_types are those not appearing in any dashboard', () => {
    const store = new InMemoryCustomDashboardStore();
    store.create('BIL', {
      name: 'minimal',
      widgets: [
        { widget_type: 'tenant_kpi', config: {}, position: { row: 0, col: 0 }, span: { rows: 1, cols: 1 } },
      ],
    }, 'admin', NOW);
    const result = buildDashboardWidgetDependencies('BIL', NOW, store);
    expect(result.isolated_widget_types).not.toContain('tenant_kpi');
    expect(result.isolated_widget_types.length).toBeGreaterThan(0);
  });

  test('throws on empty tenant_id', () => {
    const store = new InMemoryCustomDashboardStore();
    expect(() => buildDashboardWidgetDependencies('', NOW, store)).toThrow();
  });
});

describe('M11.27 — GET /v1/dashboards/widgets/dependencies route', () => {
  test('admin returns 200', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/dashboards/widgets/dependencies')
      .set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.co_occurrences)).toBe(true);
    expect(Array.isArray(res.body.body.isolated_widget_types)).toBe(true);
  });

  test('field_officer returns 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/dashboards/widgets/dependencies')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('cross-tenant isolation', async () => {
    const store = new InMemoryCustomDashboardStore();
    store.create('BIL', {
      name: 'BIL dash',
      widgets: [
        { widget_type: 'alerts_by_class', config: {}, position: { row: 0, col: 0 }, span: { rows: 1, cols: 1 } },
        { widget_type: 'open_cases', config: {}, position: { row: 0, col: 1 }, span: { rows: 1, cols: 1 } },
      ],
    }, 'admin', NOW);
    const { app } = makeTestApp('admin', store);
    const res = await request(app)
      .get('/v1/dashboards/widgets/dependencies')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(res.status).toBe(200);
    expect(res.body.body.total_dashboards).toBe(0);
  });
});
