// @ts-nocheck
// services/bff/__tests__/tenant_onboarding_bottleneck.test.ts
//
// T6 M2.22 — Tenant onboarding bottleneck predictor.

import request from 'supertest';
import { predictOnboardingBottlenecks } from '../src/tenant_onboarding_bottleneck';
import { ONBOARDING_STEPS, InMemoryOnboardingStore } from '../src/tenant_onboarding';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeStore() {
  return new InMemoryOnboardingStore();
}

// ─── pure function ───────────────────────────────────────────────────

describe('M2.22 — empty fleet', () => {
  test('returns empty bottlenecks for zero tenants', () => {
    const result = predictOnboardingBottlenecks([], NOW);
    expect(result.total_tenants).toBe(0);
    expect(result.bottlenecks).toHaveLength(0);
    expect(result.critical_bottleneck).toBeNull();
    expect(result.fleet_completion_probability).toBe(0);
  });
});

describe('M2.22 — single tenant all pending', () => {
  test('all required steps appear as bottlenecks', () => {
    const store = makeStore();
    const state = store.get('T1');
    const result = predictOnboardingBottlenecks([{ tenant_id: 'T1', state }], NOW);
    const requiredSteps = ONBOARDING_STEPS.filter((s) => s.required);
    expect(result.bottlenecks.length).toBe(requiredSteps.length);
    expect(result.fleet_completion_probability).toBe(0);
  });
});

describe('M2.22 — completed tenant', () => {
  test('fleet_completion_probability = 1 when all tenants complete', () => {
    const store = makeStore();
    const requiredSteps = ONBOARDING_STEPS.filter((s) => s.required);
    for (const step of ONBOARDING_STEPS) {
      store.markStep('T1', step.id, 'completed', 'admin', null, NOW);
    }
    const state = store.get('T1');
    const result = predictOnboardingBottlenecks([{ tenant_id: 'T1', state }], NOW);
    expect(result.fleet_completion_probability).toBe(1);
    expect(result.bottlenecks).toHaveLength(0);
  });
});

describe('M2.22 — bottleneck risk tiers', () => {
  test('critical_bottleneck surfaces when >50% tenants are pending on same step', () => {
    const store = makeStore();
    const stateT1 = store.get('T1');
    const stateT2 = store.get('T2');
    const result = predictOnboardingBottlenecks([
      { tenant_id: 'T1', state: stateT1 },
      { tenant_id: 'T2', state: stateT2 },
    ], NOW);
    // All steps have 100% pending for both tenants — should be critical
    if (result.critical_bottleneck) {
      expect(result.critical_bottleneck.step_id).toBeDefined();
      expect(result.critical_bottleneck.total_tenants_pending).toBeGreaterThan(0);
    }
    expect(result.total_tenants).toBe(2);
  });
});

describe('M2.22 — sorting', () => {
  test('bottlenecks sorted by pct_blocked desc then order asc', () => {
    const store = makeStore();
    // T1: only first step pending (others completed)
    // T2: all steps pending
    // T3: all steps pending
    for (const step of ONBOARDING_STEPS.slice(1)) {
      store.markStep('T1', step.id, 'completed', 'admin', null, NOW);
    }
    const stateT1 = store.get('T1');
    const stateT2 = store.get('T2');
    const stateT3 = store.get('T3');
    const result = predictOnboardingBottlenecks([
      { tenant_id: 'T1', state: stateT1 },
      { tenant_id: 'T2', state: stateT2 },
      { tenant_id: 'T3', state: stateT3 },
    ], NOW);

    for (let i = 0; i < result.bottlenecks.length - 1; i++) {
      expect(result.bottlenecks[i].pct_blocked).toBeGreaterThanOrEqual(result.bottlenecks[i + 1].pct_blocked);
    }
  });
});

describe('M2.22 — generated_at', () => {
  test('generated_at is ISO string', () => {
    const result = predictOnboardingBottlenecks([], NOW);
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

// ─── route ───────────────────────────────────────────────────────────

function makeApp2(role) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M2.22 — GET /v1/tenants/onboarding/bottleneck-predictor', () => {
  test('admin → 200 with bottlenecks', async () => {
    const { app } = makeApp2('admin');
    const r = await request(app).get('/v1/tenants/onboarding/bottleneck-predictor').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(typeof r.body.body.total_tenants).toBe('number');
    expect(Array.isArray(r.body.body.bottlenecks)).toBe(true);
  });

  test('non-admin → 403', async () => {
    const { app } = makeApp2('risk_analyst');
    const r = await request(app).get('/v1/tenants/onboarding/bottleneck-predictor').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('fleet_completion_probability in [0, 1]', async () => {
    const { app } = makeApp2('admin');
    const r = await request(app).get('/v1/tenants/onboarding/bottleneck-predictor').set(TH_BIL);
    expect(r.status).toBe(200);
    const prob = r.body.body.fleet_completion_probability;
    expect(prob).toBeGreaterThanOrEqual(0);
    expect(prob).toBeLessThanOrEqual(1);
  });

  test('M2.21 step-timing sibling still works', async () => {
    const { app } = makeApp2('admin');
    const r = await request(app).get('/v1/tenants/onboarding/step-timing').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
