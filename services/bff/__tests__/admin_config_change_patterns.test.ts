// @ts-nocheck
// T6 M13.25 — Config change pattern analysis tests.

import request from 'supertest';
import { buildAdminConfigChangePatterns } from '../src/admin_config_change_patterns';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z'); // Monday UTC
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

function addConfigEvent(store, tenant, action, ts) {
  store.record(tenant, {
    actor_username: 'alice',
    actor_role: 'admin',
    action,
    resource_type: 'config',
    resource_id: 'alerts.red_sla_hours',
    outcome: 'success',
    ts,
  }, new Date(ts));
}

describe('M13.25 — buildAdminConfigChangePatterns pure', () => {
  test('empty audit trail returns zero result', () => {
    const store = new InMemoryAuditTrailStore();
    const result = buildAdminConfigChangePatterns(store, 'BIL', NOW);
    expect(result.total_changes).toBe(0);
    expect(result.by_day_of_week).toHaveLength(7);
    expect(result.by_hour).toHaveLength(24);
    expect(result.most_active_day).toBeNull();
    expect(result.most_active_hour).toBeNull();
    expect(result.changes_this_week).toBe(0);
  });

  test('config.update event counted', () => {
    const store = new InMemoryAuditTrailStore();
    addConfigEvent(store, 'BIL', 'config.update', NOW.toISOString());
    const result = buildAdminConfigChangePatterns(store, 'BIL', NOW);
    expect(result.total_changes).toBe(1);
    expect(result.changes_this_week).toBe(1);
  });

  test('config.reset event counted', () => {
    const store = new InMemoryAuditTrailStore();
    addConfigEvent(store, 'BIL', 'config.reset', NOW.toISOString());
    const result = buildAdminConfigChangePatterns(store, 'BIL', NOW);
    expect(result.total_changes).toBe(1);
  });

  test('non-config events excluded', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', {
      actor_username: 'alice',
      actor_role: 'admin',
      action: 'case.closed',
      resource_type: 'case',
      resource_id: 'case-1',
      outcome: 'success',
      ts: NOW.toISOString(),
    }, NOW);
    const result = buildAdminConfigChangePatterns(store, 'BIL', NOW);
    expect(result.total_changes).toBe(0);
  });

  test('by_day_of_week and by_hour sum to total_changes', () => {
    const store = new InMemoryAuditTrailStore();
    addConfigEvent(store, 'BIL', 'config.update', NOW.toISOString());
    addConfigEvent(store, 'BIL', 'config.reset', new Date(NOW.getTime() - 3600000).toISOString());
    const result = buildAdminConfigChangePatterns(store, 'BIL', NOW);
    const dowSum = result.by_day_of_week.reduce((s, v) => s + v, 0);
    const hrSum = result.by_hour.reduce((s, v) => s + v, 0);
    expect(dowSum).toBe(result.total_changes);
    expect(hrSum).toBe(result.total_changes);
  });

  test('change_velocity stable when same count this week vs prior', () => {
    const store = new InMemoryAuditTrailStore();
    const result = buildAdminConfigChangePatterns(store, 'BIL', NOW);
    expect(result.change_velocity).toBe('stable');
  });

  test('tenant_id and generated_at echoed', () => {
    const store = new InMemoryAuditTrailStore();
    const result = buildAdminConfigChangePatterns(store, 'BIL', NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

describe('M13.25 — GET /v1/admin/config/change-patterns route', () => {
  test('admin 200 with envelope', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/admin/config/change-patterns').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body.by_day_of_week).toHaveLength(7);
    expect(res.body.body.by_hour).toHaveLength(24);
  });

  test('field_officer 403', async () => {
    const app = makeTestApp('field_officer');
    const res = await request(app).get('/v1/admin/config/change-patterns').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant header → 400', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/admin/config/change-patterns');
    expect(res.status).toBe(400);
  });
});
