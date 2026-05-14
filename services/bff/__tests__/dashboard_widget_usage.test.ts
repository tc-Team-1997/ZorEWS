// services/bff/__tests__/dashboard_widget_usage.test.ts
//
// T6 M11.11 — Custom dashboard widget usage analytics.

import request from 'supertest';
import { analyseDashboardWidgetUsage } from '../src/dashboard_widget_usage';
import {
  InMemoryCustomDashboardStore,
  WIDGET_TYPES,
  type CustomDashboardInput,
} from '../src/custom_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkInput(name: string, widgets: CustomDashboardInput['widgets']): CustomDashboardInput {
  return { name, description: `for ${name}`, widgets };
}

// ─── analyseDashboardWidgetUsage — pure ──────────────────────────────

describe('M11.11 — analyseDashboardWidgetUsage — empty', () => {
  test('zero dashboards → every widget_type at count=0', () => {
    const out = analyseDashboardWidgetUsage([]);
    expect(out.total_dashboards).toBe(0);
    expect(out.total_widgets).toBe(0);
    expect(out.by_widget_type.length).toBe(WIDGET_TYPES.length);
    for (const e of out.by_widget_type) {
      expect(e.dashboard_count).toBe(0);
      expect(e.total_instances).toBe(0);
      expect(e.dashboards).toEqual([]);
    }
  });
});

describe('M11.11 — distinct vs total counts', () => {
  test('single dashboard with 3 alerts_by_class widgets counts as 1 dashboard, 3 instances', () => {
    const store = new InMemoryCustomDashboardStore();
    store.create(
      'BIL',
      mkInput('alerts heavy', [
        { widget_type: 'alerts_by_class', position: { row: 0, col: 0 }, span: { rows: 1, cols: 6 }, config: {} },
        { widget_type: 'alerts_by_class', position: { row: 1, col: 0 }, span: { rows: 1, cols: 6 }, config: {} },
        { widget_type: 'alerts_by_class', position: { row: 2, col: 0 }, span: { rows: 1, cols: 6 }, config: {} },
      ]),
      'alice',
      NOW,
    );
    const out = analyseDashboardWidgetUsage(store.list('BIL'));
    expect(out.total_dashboards).toBe(1);
    expect(out.total_widgets).toBe(3);
    const alerts = out.by_widget_type.find((e) => e.widget_type === 'alerts_by_class')!;
    expect(alerts.dashboard_count).toBe(1);
    expect(alerts.total_instances).toBe(3);
    expect(alerts.dashboards).toHaveLength(1);
    expect(alerts.dashboards[0]!.count).toBe(3);
  });
});

describe('M11.11 — multi-dashboard rollup', () => {
  test('shared widget_type aggregates across dashboards', () => {
    const store = new InMemoryCustomDashboardStore();
    store.create(
      'BIL',
      mkInput('A', [
        { widget_type: 'risk_score_histogram', position: { row: 0, col: 0 }, span: { rows: 2, cols: 6 }, config: {} },
      ]),
      'alice',
      NOW,
    );
    store.create(
      'BIL',
      mkInput('B', [
        { widget_type: 'risk_score_histogram', position: { row: 0, col: 0 }, span: { rows: 2, cols: 6 }, config: {} },
        { widget_type: 'top_breaches', position: { row: 2, col: 0 }, span: { rows: 2, cols: 6 }, config: {} },
      ]),
      'alice',
      NOW,
    );
    const out = analyseDashboardWidgetUsage(store.list('BIL'));
    expect(out.total_dashboards).toBe(2);
    expect(out.total_widgets).toBe(3);
    const histogram = out.by_widget_type.find((e) => e.widget_type === 'risk_score_histogram')!;
    expect(histogram.dashboard_count).toBe(2);
    expect(histogram.total_instances).toBe(2);
    expect(histogram.dashboards.map((d) => d.name).sort()).toEqual(['A', 'B']);
  });
});

describe('M11.11 — sort order', () => {
  test('by_widget_type sorted by total_instances desc, widget_type asc tie-break', () => {
    const store = new InMemoryCustomDashboardStore();
    store.create(
      'BIL',
      mkInput('mostly alerts', [
        { widget_type: 'alerts_by_class', position: { row: 0, col: 0 }, span: { rows: 1, cols: 6 }, config: {} },
        { widget_type: 'alerts_by_class', position: { row: 1, col: 0 }, span: { rows: 1, cols: 6 }, config: {} },
        { widget_type: 'open_cases', position: { row: 2, col: 0 }, span: { rows: 2, cols: 6 }, config: {} },
      ]),
      'alice',
      NOW,
    );
    const out = analyseDashboardWidgetUsage(store.list('BIL'));
    expect(out.by_widget_type[0]!.widget_type).toBe('alerts_by_class');
    // Second non-zero entry should be open_cases (1 instance).
    const openCases = out.by_widget_type.find((e) => e.widget_type === 'open_cases')!;
    expect(openCases.total_instances).toBe(1);
    // Unused widgets sit at total_instances=0 — verify still emitted.
    const unused = out.by_widget_type.filter((e) => e.total_instances === 0);
    expect(unused.length).toBeGreaterThan(0);
  });
});

describe('M11.11 — per-dashboard breakdown sort', () => {
  test('dashboards[] sorted by count desc, name asc tie-break', () => {
    const store = new InMemoryCustomDashboardStore();
    store.create(
      'BIL',
      mkInput('Zebra', [
        { widget_type: 'alerts_by_class', position: { row: 0, col: 0 }, span: { rows: 1, cols: 6 }, config: {} },
      ]),
      'alice',
      NOW,
    );
    store.create(
      'BIL',
      mkInput('Alpha', [
        { widget_type: 'alerts_by_class', position: { row: 0, col: 0 }, span: { rows: 1, cols: 6 }, config: {} },
      ]),
      'alice',
      NOW,
    );
    store.create(
      'BIL',
      mkInput('Bravo', [
        { widget_type: 'alerts_by_class', position: { row: 0, col: 0 }, span: { rows: 1, cols: 6 }, config: {} },
        { widget_type: 'alerts_by_class', position: { row: 1, col: 0 }, span: { rows: 1, cols: 6 }, config: {} },
      ]),
      'alice',
      NOW,
    );
    const out = analyseDashboardWidgetUsage(store.list('BIL'));
    const alerts = out.by_widget_type.find((e) => e.widget_type === 'alerts_by_class')!;
    expect(alerts.dashboards.map((d) => d.name)).toEqual(['Bravo', 'Alpha', 'Zebra']);
  });
});

// ─── GET /v1/dashboards/widgets/usage ────────────────────────────────

function makeUsageApp(role = 'admin') {
  const customDashboardStore = new InMemoryCustomDashboardStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    customDashboardStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, customDashboardStore };
}

describe('M11.11 — GET /v1/dashboards/widgets/usage', () => {
  test('empty tenant → 200 with zero envelope but full catalog rows', async () => {
    const { app } = makeUsageApp('admin');
    const r = await request(app).get('/v1/dashboards/widgets/usage').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_dashboards).toBe(0);
    expect(r.body.body.total_widgets).toBe(0);
    expect(r.body.body.by_widget_type.length).toBe(WIDGET_TYPES.length);
  });

  test('records show up in the per-tenant rollup', async () => {
    const { app, customDashboardStore } = makeUsageApp('admin');
    customDashboardStore.create(
      'BIL',
      mkInput('my board', [
        { widget_type: 'risk_score_histogram', position: { row: 0, col: 0 }, span: { rows: 2, cols: 6 }, config: {} },
        { widget_type: 'risk_score_histogram', position: { row: 2, col: 0 }, span: { rows: 2, cols: 6 }, config: {} },
      ]),
      'alice',
      NOW,
    );
    const r = await request(app).get('/v1/dashboards/widgets/usage').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_dashboards).toBe(1);
    expect(r.body.body.total_widgets).toBe(2);
    const histogram = r.body.body.by_widget_type.find(
      (e: { widget_type: string }) => e.widget_type === 'risk_score_histogram',
    );
    expect(histogram.dashboard_count).toBe(1);
    expect(histogram.total_instances).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeUsageApp('readonly');
    const r = await request(app).get('/v1/dashboards/widgets/usage').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL dashboards invisible to BANK_DEMO', async () => {
    const { app, customDashboardStore } = makeUsageApp('admin');
    customDashboardStore.create(
      'BIL',
      mkInput('bil-only', [
        { widget_type: 'alerts_by_class', position: { row: 0, col: 0 }, span: { rows: 1, cols: 6 }, config: {} },
      ]),
      'alice',
      NOW,
    );
    const r = await request(app)
      .get('/v1/dashboards/widgets/usage')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total_dashboards).toBe(0);
    expect(r.body.body.total_widgets).toBe(0);
  });

  test('existing /widgets/catalog still works (route ordering)', async () => {
    const { app } = makeUsageApp('admin');
    const r = await request(app).get('/v1/dashboards/widgets/catalog').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
