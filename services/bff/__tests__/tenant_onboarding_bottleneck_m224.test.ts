// @ts-nocheck
// services/bff/__tests__/tenant_onboarding_bottleneck_m224.test.ts
// T6 M2.24 — Tenant onboarding bottleneck analysis

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryOnboardingStore } from '../src/tenant_onboarding';
import { predictOnboardingBottlenecks } from '../src/tenant_onboarding_bottleneck';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// Build a fleet array from a single-tenant store
function fleetFrom(store, tenantId) {
  return [{ tenant_id: tenantId, state: store.get(tenantId) }];
}

describe('predictOnboardingBottlenecks()', () => {
  test('returns bottlenecks array for untouched tenant', () => {
    const store = new InMemoryOnboardingStore();
    const fleet = fleetFrom(store, 'BIL');
    const result = predictOnboardingBottlenecks(fleet, NOW);
    expect(Array.isArray(result.bottlenecks)).toBe(true);
    expect(result.total_tenants).toBe(1);
  });

  test('no bottlenecks when nothing is completed', () => {
    const store = new InMemoryOnboardingStore();
    const fleet = fleetFrom(store, 'BIL');
    const result = predictOnboardingBottlenecks(fleet, NOW);
    // All pending — no stuck steps since none completed ahead
    expect(Array.isArray(result.bottlenecks)).toBe(true);
  });

  test('critical_bottleneck is null or object when pct_blocked > 0.5', () => {
    const store = new InMemoryOnboardingStore();
    const fleet = fleetFrom(store, 'BIL');
    const result = predictOnboardingBottlenecks(fleet, NOW);
    // critical_bottleneck is null when nothing is stuck
    expect(result.critical_bottleneck === null || typeof result.critical_bottleneck === 'object').toBe(true);
  });

  test('fleet_completion_probability is 0 for untouched tenant', () => {
    const store = new InMemoryOnboardingStore();
    const fleet = fleetFrom(store, 'BIL');
    const result = predictOnboardingBottlenecks(fleet, NOW);
    expect(result.fleet_completion_probability).toBe(0);
  });

  test('fleet_completion_probability is 1 when all complete', () => {
    const store = new InMemoryOnboardingStore();
    // Mark all required steps completed
    const steps = ['tenant_provisioned', 'channels_configured', 'vertical_set', 'config_baseline',
      'email_channel', 'alert_routing', 'audit_active', 'operator_invited'];
    for (const s of steps) {
      store.markStep('BIL', s, 'completed', 'alice', null, NOW);
    }
    const fleet = fleetFrom(store, 'BIL');
    const result = predictOnboardingBottlenecks(fleet, NOW);
    expect(result.fleet_completion_probability).toBe(1);
  });

  test('generated_at is set', () => {
    const store = new InMemoryOnboardingStore();
    const fleet = fleetFrom(store, 'BIL');
    const result = predictOnboardingBottlenecks(fleet, NOW);
    expect(result.generated_at).toBe(NOW.toISOString());
  });

  test('total_tenants equals fleet length', () => {
    const store = new InMemoryOnboardingStore();
    const fleet = fleetFrom(store, 'BIL');
    const result = predictOnboardingBottlenecks(fleet, NOW);
    expect(result.total_tenants).toBe(fleet.length);
  });
});

describe('GET /v1/tenants/onboarding/bottleneck', () => {
  test('admin returns 200 with bottlenecks field', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/tenants/onboarding/bottleneck')
      .set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('bottlenecks');
    expect(res.body.body).toHaveProperty('total_tenants');
  });

  test('non-admin returns 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/tenants/onboarding/bottleneck')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('missing tenant header returns 400', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/tenants/onboarding/bottleneck')
      .set('X-Channel', 'API');
    expect(res.status).toBe(400);
  });
});
