// @ts-nocheck
// T6 M13.27 — Config value range validation tests.

import request from 'supertest';
import { buildConfigValueRangeValidation } from '../src/config_value_range_validation';
import { InMemoryConfigStore } from '../src/admin_config';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin', configStore?) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    configStore,
  });
  return { app };
}

describe('M13.27 — buildConfigValueRangeValidation pure', () => {
  test('no overrides = zero checked', () => {
    const store = new InMemoryConfigStore();
    const result = buildConfigValueRangeValidation('BIL', NOW, store);
    expect(result.tenant_id).toBe('BIL');
    expect(result.total_overrides_checked).toBe(0);
    expect(result.out_of_range_count).toBe(0);
    expect(result.validation_health).toBe('pass');
  });

  test('in-range value passes', () => {
    const store = new InMemoryConfigStore();
    store.set('BIL', 'alerts.red_sla_hours', 8, 'admin', NOW);
    const result = buildConfigValueRangeValidation('BIL', NOW, store);
    const v = result.validations.find(v => v.key === 'alerts.red_sla_hours');
    expect(v.in_range).toBe(true);
    expect(v.suggested_correction).toBeNull();
  });

  test('out-of-range value fails', () => {
    const store = new InMemoryConfigStore();
    store.set('BIL', 'alerts.red_sla_hours', 100, 'admin', NOW);
    const result = buildConfigValueRangeValidation('BIL', NOW, store);
    const v = result.validations.find(v => v.key === 'alerts.red_sla_hours');
    expect(v.in_range).toBe(false);
    expect(v.suggested_correction).not.toBeNull();
    expect(result.out_of_range_count).toBeGreaterThan(0);
  });

  test('unknown key is always in_range', () => {
    const store = new InMemoryConfigStore();
    store.set('BIL', 'features.copilot_enabled', true, 'admin', NOW);
    const result = buildConfigValueRangeValidation('BIL', NOW, store);
    const v = result.validations.find(v => v.key === 'features.copilot_enabled');
    expect(v.in_range).toBe(true);
  });

  test('validation_health fail when >2 out-of-range', () => {
    const store = new InMemoryConfigStore();
    store.set('BIL', 'alerts.red_sla_hours', 1000, 'admin', NOW);
    store.set('BIL', 'alerts.orange_sla_hours', 1000, 'admin', NOW);
    store.set('BIL', 'alerts.yellow_sla_hours', 1000, 'admin', NOW);
    const result = buildConfigValueRangeValidation('BIL', NOW, store);
    expect(result.validation_health).toBe('fail');
  });

  test('throws on empty tenant_id', () => {
    const store = new InMemoryConfigStore();
    expect(() => buildConfigValueRangeValidation('', NOW, store)).toThrow();
  });
});

describe('M13.27 — GET /v1/admin/config/value-range-validation route', () => {
  test('admin returns 200', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/admin/config/value-range-validation')
      .set(TH);
    expect(res.status).toBe(200);
    expect(['pass', 'warn', 'fail']).toContain(res.body.body.validation_health);
  });

  test('field_officer returns 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/admin/config/value-range-validation')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('cross-tenant: BIL overrides invisible to BANK_DEMO', async () => {
    const store = new InMemoryConfigStore();
    store.set('BIL', 'alerts.red_sla_hours', 1000, 'admin', NOW);
    const { app } = makeTestApp('admin', store);
    const res = await request(app)
      .get('/v1/admin/config/value-range-validation')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(res.status).toBe(200);
    expect(res.body.body.total_overrides_checked).toBe(0);
  });
});
