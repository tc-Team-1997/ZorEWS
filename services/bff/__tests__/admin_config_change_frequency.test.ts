// @ts-nocheck
// services/bff/__tests__/admin_config_change_frequency.test.ts
// T6 M13.21 — Admin config change frequency by key.

import request from 'supertest';
import { buildConfigChangeFrequency } from '../src/admin_config_change_frequency';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { DEFAULTS } from '../src/admin_config';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeStore() {
  return new InMemoryAuditTrailStore();
}

function fakeApp(role = 'admin', store = makeStore()) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    auditTrailStore: store,
    getRole: () => role,
    now: () => NOW,
  });
  return { app, store };
}

function recordConfigChange(store, tenantId, key, action = 'config.update') {
  store.record(tenantId, {
    actor_username: 'admin', actor_role: 'admin',
    action,
    resource_type: 'config',
    resource_id: key,
    outcome: 'success', severity: 'info',
    metadata: {},
  }, NOW);
}

// ─── Pure function tests ────────────────────────────────────────────────

describe('M13.21 — buildConfigChangeFrequency — empty', () => {
  test('no events → zero results', () => {
    const out = buildConfigChangeFrequency('BIL', [], NOW);
    expect(out.total_change_events).toBe(0);
    expect(out.unique_keys_changed).toBe(0);
    expect(out.keys).toHaveLength(0);
    expect(out.most_changed_key).toBeNull();
    expect(out.stable_keys_count).toBe(DEFAULTS.length);
  });
});

describe('M13.21 — counts correctly', () => {
  test('single change → total=1, unique_keys=1', () => {
    const store = makeStore();
    recordConfigChange(store, 'BIL', 'alerts.red_sla_hours');
    const events = store.list('BIL', {}).items;
    const out = buildConfigChangeFrequency('BIL', events, NOW);
    expect(out.total_change_events).toBe(1);
    expect(out.unique_keys_changed).toBe(1);
    expect(out.keys[0].key).toBe('alerts.red_sla_hours');
    expect(out.keys[0].total_changes).toBe(1);
  });

  test('multiple changes same key → count aggregated', () => {
    const store = makeStore();
    for (let i = 0; i < 3; i++) {
      recordConfigChange(store, 'BIL', 'alerts.red_sla_hours');
    }
    const events = store.list('BIL', {}).items;
    const out = buildConfigChangeFrequency('BIL', events, NOW);
    expect(out.keys[0].total_changes).toBe(3);
  });
});

describe('M13.21 — change_velocity', () => {
  test('>10 changes → high velocity', () => {
    const store = makeStore();
    for (let i = 0; i < 12; i++) {
      recordConfigChange(store, 'BIL', 'alerts.red_sla_hours');
    }
    const events = store.list('BIL', {}).items;
    const out = buildConfigChangeFrequency('BIL', events, NOW);
    expect(out.keys[0].change_velocity).toBe('high');
  });

  test('5-10 changes → medium velocity', () => {
    const store = makeStore();
    for (let i = 0; i < 7; i++) {
      recordConfigChange(store, 'BIL', 'alerts.orange_sla_hours');
    }
    const events = store.list('BIL', {}).items;
    const out = buildConfigChangeFrequency('BIL', events, NOW);
    expect(out.keys[0].change_velocity).toBe('medium');
  });
});

describe('M13.21 — sort order', () => {
  test('sorted total_changes desc + key asc tie-break', () => {
    const store = makeStore();
    recordConfigChange(store, 'BIL', 'alerts.red_sla_hours');
    recordConfigChange(store, 'BIL', 'alerts.red_sla_hours');
    recordConfigChange(store, 'BIL', 'alerts.orange_sla_hours');
    const events = store.list('BIL', {}).items;
    const out = buildConfigChangeFrequency('BIL', events, NOW);
    expect(out.keys[0].key).toBe('alerts.red_sla_hours');
    expect(out.most_changed_key.key).toBe('alerts.red_sla_hours');
  });
});

describe('M13.21 — stable_keys_count', () => {
  test('never-changed keys count', () => {
    const store = makeStore();
    recordConfigChange(store, 'BIL', 'alerts.red_sla_hours');
    const events = store.list('BIL', {}).items;
    const out = buildConfigChangeFrequency('BIL', events, NOW);
    expect(out.stable_keys_count).toBe(DEFAULTS.length - 1);
  });
});

describe('M13.21 — tenant isolation', () => {
  test('BANK_DEMO events not counted for BIL', () => {
    const store = makeStore();
    store.record('BANK_DEMO', {
      actor_username: 'admin', actor_role: 'admin',
      action: 'config.update', resource_type: 'config', resource_id: 'key1',
      outcome: 'success', severity: 'info', metadata: {},
    }, NOW);
    const events = store.list('BANK_DEMO', {}).items;
    const out = buildConfigChangeFrequency('BIL', events, NOW);
    expect(out.total_change_events).toBe(0);
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M13.21 — route', () => {
  test('GET /v1/admin/config/change-frequency → 200', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/admin/config/change-frequency')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(typeof res.body.body.total_change_events).toBe('number');
    expect(Array.isArray(res.body.body.keys)).toBe(true);
  });

  test('reflected changes appear in response', async () => {
    const store = makeStore();
    recordConfigChange(store, 'BIL', 'alerts.red_sla_hours');
    const { app } = fakeApp('admin', store);
    const res = await request(app)
      .get('/v1/admin/config/change-frequency')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.body.body.total_change_events).toBe(1);
    expect(res.body.body.most_changed_key.key).toBe('alerts.red_sla_hours');
  });

  test('403 for unknown role', async () => {
    const { app } = fakeApp('viewer');
    const res = await request(app)
      .get('/v1/admin/config/change-frequency')
      .set(TH_BIL)
      .set('x-apex-role', 'viewer');
    expect(res.status).toBe(403);
  });

  test('400 when no tenant header', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/admin/config/change-frequency')
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });
});
