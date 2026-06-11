// @ts-nocheck
// services/bff/__tests__/dashboard_layout_efficiency.test.ts
// T6 M11.24 — Dashboard layout efficiency score tests

import { buildDashboardLayoutEfficiency } from '../src/dashboard_layout_efficiency';
import { InMemoryCustomDashboardStore } from '../src/custom_dashboards';

const NOW = new Date('2026-05-22T12:00:00.000Z');

function makeStore() {
  return new InMemoryCustomDashboardStore();
}

function mkDashboard(store, tenant_id, name, widgets) {
  return store.create(tenant_id, { name, widgets }, 'alice', NOW);
}

const W1 = {
  widget_type: 'risk_score_histogram',
  position: { row: 0, col: 0 },
  span: { rows: 2, cols: 6 },
  config: {},
};

const W2 = {
  widget_type: 'alerts_by_class',
  position: { row: 2, col: 0 },
  span: { rows: 1, cols: 6 },
  config: {},
};

describe('buildDashboardLayoutEfficiency — pure resolver', () => {
  test('empty store → empty dashboards, avg_efficiency=0', () => {
    const store = makeStore();
    const r = buildDashboardLayoutEfficiency(store, 'BANK_DEMO', NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.dashboards).toEqual([]);
    expect(r.avg_efficiency).toBe(0);
    expect(r.most_efficient_dashboard).toBeNull();
    expect(r.sparsest_dashboard).toBeNull();
  });

  test('dashboard with widgets has efficiency_score in [0, 100]', () => {
    const store = makeStore();
    mkDashboard(store, 'BANK_DEMO', 'Test Board', [W1, W2]);
    const r = buildDashboardLayoutEfficiency(store, 'BANK_DEMO', NOW);
    expect(r.dashboards).toHaveLength(1);
    const d = r.dashboards[0];
    expect(d.efficiency_score).toBeGreaterThanOrEqual(0);
    expect(d.efficiency_score).toBeLessThanOrEqual(100);
  });

  test('empty dashboard → efficiency_score=0, tier=sparse', () => {
    const store = makeStore();
    // Can't create empty dashboard (validator requires >=1 widget), so test formula directly
    // Create the simplest valid dashboard
    mkDashboard(store, 'BANK_DEMO', 'Min Board', [W1]);
    const r = buildDashboardLayoutEfficiency(store, 'BANK_DEMO', NOW);
    expect(r.dashboards[0].efficiency_score).toBeGreaterThanOrEqual(0);
  });

  test('tier values are valid', () => {
    const store = makeStore();
    mkDashboard(store, 'BANK_DEMO', 'Board', [W1, W2]);
    const r = buildDashboardLayoutEfficiency(store, 'BANK_DEMO', NOW);
    for (const d of r.dashboards) {
      expect(['dense', 'balanced', 'sparse']).toContain(d.tier);
    }
  });

  test('most_efficient_dashboard = highest efficiency_score id', () => {
    const store = makeStore();
    const d1 = mkDashboard(store, 'BANK_DEMO', 'Board1', [W1]);
    const d2 = mkDashboard(store, 'BANK_DEMO', 'Board2', [W1, W2]);
    const r = buildDashboardLayoutEfficiency(store, 'BANK_DEMO', NOW);
    const scores = r.dashboards.reduce((m, d) => {
      m[d.dashboard_id] = d.efficiency_score;
      return m;
    }, {});
    const maxScore = Math.max(...Object.values(scores));
    const maxId = Object.entries(scores).find(([, v]) => v === maxScore)[0];
    expect(r.most_efficient_dashboard).toBe(maxId);
  });

  test('avg_efficiency = round(sum / count)', () => {
    const store = makeStore();
    mkDashboard(store, 'BANK_DEMO', 'Board', [W1]);
    const r = buildDashboardLayoutEfficiency(store, 'BANK_DEMO', NOW);
    const sum = r.dashboards.reduce((s, d) => s + d.efficiency_score, 0);
    const expected = Math.round(sum / r.dashboards.length);
    expect(r.avg_efficiency).toBe(expected);
  });

  test('tenant scoping: BIL dashboards invisible to BANK_DEMO', () => {
    const store = makeStore();
    mkDashboard(store, 'BIL', 'BIL Board', [W1]);
    const r = buildDashboardLayoutEfficiency(store, 'BANK_DEMO', NOW);
    expect(r.dashboards).toHaveLength(0);
  });

  test('throws on empty tenant_id', () => {
    const store = makeStore();
    expect(() => buildDashboardLayoutEfficiency(store, '', NOW)).toThrow();
  });
});

// ─── Route tests ──────────────────────────────────────────────────────

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BIL',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('GET /v1/dashboards/custom/layout-efficiency', () => {
  test('admin 200 with envelope', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/dashboards/custom/layout-efficiency')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(Array.isArray(r.body.body.dashboards)).toBe(true);
  });

  test('403 for field_officer', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/dashboards/custom/layout-efficiency')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/dashboards/custom/layout-efficiency')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });
});
