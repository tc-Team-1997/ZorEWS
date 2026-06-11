// @ts-nocheck
// T6 M2.27 — Tenant comparison matrix tests.

import request from 'supertest';
import { buildTenantComparisonMatrix } from '../src/tenant_comparison_matrix';
import { InMemoryConfigStore, DEFAULTS } from '../src/admin_config';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin', configStore) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    configStore: configStore,
  });
  return app;
}

describe('M2.27 — buildTenantComparisonMatrix pure', () => {
  test('all defaults → all same', () => {
    const store = new InMemoryConfigStore();
    const result = buildTenantComparisonMatrix(store, NOW);
    expect(result.total_keys).toBe(DEFAULTS.length);
    expect(result.same_count).toBe(DEFAULTS.length);
    expect(result.different_count).toBe(0);
    expect(result.most_divergent_category).toBeNull();
  });

  test('BIL override → different entry surfaces', () => {
    const store = new InMemoryConfigStore();
    store.set('BIL', 'alerts.red_sla_hours', 2, 'admin', NOW);
    const result = buildTenantComparisonMatrix(store, NOW);
    const diff = result.keys.find((k) => k.key === 'alerts.red_sla_hours');
    expect(diff).toBeDefined();
    expect(diff.same).toBe(false);
    expect(diff.bil_value).toBe(2);
    expect(result.different_count).toBe(1);
    expect(result.most_divergent_category).toBe('alerts');
  });

  test('all keys present in result', () => {
    const store = new InMemoryConfigStore();
    const result = buildTenantComparisonMatrix(store, NOW);
    const keys = result.keys.map((k) => k.key);
    for (const def of DEFAULTS) {
      expect(keys).toContain(def.key);
    }
  });

  test('generated_at matches now', () => {
    const store = new InMemoryConfigStore();
    const result = buildTenantComparisonMatrix(store, NOW);
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

describe('M2.27 — GET /v1/tenants/comparison-matrix route', () => {
  test('admin 200 with envelope shape', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/tenants/comparison-matrix').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toBeDefined();
    expect(res.body.body.total_keys).toBeGreaterThan(0);
  });

  test('field_officer 403', async () => {
    const app = makeTestApp('field_officer');
    const res = await request(app).get('/v1/tenants/comparison-matrix').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant header → 400', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/tenants/comparison-matrix');
    expect(res.status).toBe(400);
  });
});
