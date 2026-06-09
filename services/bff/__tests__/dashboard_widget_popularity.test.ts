// @ts-nocheck
// services/bff/__tests__/dashboard_widget_popularity.test.ts
//
// T6 M11.20 — Dashboard widget popularity ranking.

import request from 'supertest';
import {
  buildWidgetPopularityRanking,
  buildWidgetPopularityRankingFromStore,
} from '../src/dashboard_widget_popularity';
import {
  InMemoryCustomDashboardStore,
  WIDGET_TYPES,
} from '../src/custom_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkWidget(type, idx) {
  return {
    widget_type: type,
    position: { row: Math.floor(idx / 4), col: (idx % 4) * 3 },
    span: { rows: 1, cols: 3 },
    config: {},
  };
}

function mkDashboard(id, widgets, opts = {}) {
  return {
    dashboard_id: id,
    tenant_id: 'BIL',
    name: `Dashboard ${id}`,
    widgets,
    created_by: 'admin',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    version: 1,
    ...opts,
  };
}

function makePopApp(role) {
  const customDashboardStore = new InMemoryCustomDashboardStore();
  const source = new StaticSource([]);
  const evaluator = new StubEvaluator();
  const riskProfile = new StubRiskProfileSource();
  const caseAction = new UnavailableCaseActionSink();
  const getRole = () => role;
  const { app } = makeApp({ source, evaluator, riskProfile, caseAction, getRole, customDashboardStore });
  return { app, customDashboardStore };
}

// ─── Pure function tests ────────────────────────────────────────────

describe('buildWidgetPopularityRanking — pure', () => {
  test('empty dashboards → all widget types with 0 counts', () => {
    const result = buildWidgetPopularityRanking('BIL', [], NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.total_dashboards).toBe(0);
    expect(result.total_widget_instances).toBe(0);
    expect(result.rankings).toHaveLength(WIDGET_TYPES.length);
    for (const row of result.rankings) {
      expect(row.instance_count).toBe(0);
      expect(row.dashboard_count).toBe(0);
    }
    expect(result.top_widget).toBeNull();
    expect(result.bottom_widget).toBeNull();
    expect(result.unused_widget_types).toHaveLength(WIDGET_TYPES.length);
  });

  test('single dashboard with 2 alert widgets', () => {
    const dash = mkDashboard('d1', [mkWidget('alerts_by_class', 0), mkWidget('alerts_by_class', 1)]);
    const result = buildWidgetPopularityRanking('BIL', [dash], NOW);
    expect(result.total_dashboards).toBe(1);
    expect(result.total_widget_instances).toBe(2);
    const alertsRow = result.rankings.find(r => r.widget_type === 'alerts_by_class');
    expect(alertsRow.instance_count).toBe(2);
    expect(alertsRow.dashboard_count).toBe(1);
    expect(result.top_widget.widget_type).toBe('alerts_by_class');
  });

  test('rankings sorted instance_count desc + widget_type asc tie-break', () => {
    const dash = mkDashboard('d1', [
      mkWidget('alerts_by_class', 0),
      mkWidget('tenant_kpi', 1),
      mkWidget('tenant_kpi', 2),
    ]);
    const result = buildWidgetPopularityRanking('BIL', [dash], NOW);
    expect(result.rankings[0].widget_type).toBe('tenant_kpi');
    expect(result.rankings[0].instance_count).toBe(2);
    expect(result.rankings[1].widget_type).toBe('alerts_by_class');
    expect(result.rankings[1].instance_count).toBe(1);
  });

  test('pct_of_instances sums to ~1 for used widgets', () => {
    const dash = mkDashboard('d1', [mkWidget('alerts_by_class', 0), mkWidget('tenant_kpi', 1)]);
    const result = buildWidgetPopularityRanking('BIL', [dash], NOW);
    const total = result.rankings.reduce((s, r) => s + r.pct_of_instances, 0);
    expect(Math.abs(total - 1.0)).toBeLessThan(0.0001);
  });

  test('pct_of_dashboards = 1 when every dashboard uses the type', () => {
    const dash1 = mkDashboard('d1', [mkWidget('tenant_kpi', 0)]);
    const dash2 = mkDashboard('d2', [mkWidget('tenant_kpi', 1)]);
    const result = buildWidgetPopularityRanking('BIL', [dash1, dash2], NOW);
    const kpiRow = result.rankings.find(r => r.widget_type === 'tenant_kpi');
    expect(kpiRow.pct_of_dashboards).toBe(1);
  });

  test('bottom_widget is least used among used types', () => {
    const dash = mkDashboard('d1', [
      mkWidget('alerts_by_class', 0),
      mkWidget('alerts_by_class', 1),
      mkWidget('tenant_kpi', 2),
    ]);
    const result = buildWidgetPopularityRanking('BIL', [dash], NOW);
    // tenant_kpi has 1 instance, alerts_by_class has 2 → bottom = tenant_kpi
    expect(result.bottom_widget.widget_type).toBe('tenant_kpi');
    expect(result.bottom_widget.instance_count).toBe(1);
  });

  test('unused_widget_types contains all types with 0 instances', () => {
    const dash = mkDashboard('d1', [mkWidget('alerts_by_class', 0)]);
    const result = buildWidgetPopularityRanking('BIL', [dash], NOW);
    expect(result.unused_widget_types).not.toContain('alerts_by_class');
    expect(result.unused_widget_types).toContain('tenant_kpi');
    expect(result.unused_widget_types).toHaveLength(WIDGET_TYPES.length - 1);
  });

  test('every ranking row has display_name from WIDGET_CATALOG', () => {
    const result = buildWidgetPopularityRanking('BIL', [], NOW);
    for (const row of result.rankings) {
      expect(row.display_name).toBeTruthy();
    }
  });
});

// ─── Route tests ────────────────────────────────────────────────────

describe('M11.20 — GET /v1/dashboards/custom/widget-popularity', () => {
  test('admin → 200 with envelope shape (empty store)', async () => {
    const { app } = makePopApp('admin');
    const r = await request(app)
      .get('/v1/dashboards/custom/widget-popularity')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.rankings).toHaveLength(WIDGET_TYPES.length);
    expect(r.body.body.top_widget).toBeNull();
  });

  test('populated store → reflects widget counts', async () => {
    const { app, customDashboardStore } = makePopApp('admin');
    customDashboardStore.create('BIL', {
      name: 'dash1',
      widgets: [mkWidget('tenant_kpi', 0), mkWidget('tenant_kpi', 1), mkWidget('alerts_by_class', 2)],
    }, 'admin', NOW);
    const r = await request(app)
      .get('/v1/dashboards/custom/widget-popularity')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_widget_instances).toBe(3);
    expect(r.body.body.top_widget.widget_type).toBe('tenant_kpi');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makePopApp('field_officer');
    const r = await request(app)
      .get('/v1/dashboards/custom/widget-popularity')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL dashboards invisible to BANK_DEMO', async () => {
    const { app, customDashboardStore } = makePopApp('admin');
    customDashboardStore.create('BIL', {
      name: 'bil-dash',
      widgets: [mkWidget('tenant_kpi', 0)],
    }, 'admin', NOW);
    const r = await request(app)
      .get('/v1/dashboards/custom/widget-popularity')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r.status).toBe(200);
    expect(r.body.body.total_widget_instances).toBe(0);
  });

  test('400 when no tenant header', async () => {
    const { app } = makePopApp('admin');
    const r = await request(app).get('/v1/dashboards/custom/widget-popularity');
    expect(r.status).toBe(400);
  });
});
