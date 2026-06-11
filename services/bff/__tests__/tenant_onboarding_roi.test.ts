// @ts-nocheck
// T6 M2.28 — Tenant onboarding ROI estimate.

import request from 'supertest';
import { buildTenantOnboardingRoi } from '../src/tenant_onboarding_roi';
import { InMemoryOnboardingStore } from '../src/tenant_onboarding';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeRoiApp(role = 'admin', store = new InMemoryOnboardingStore()) {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => role, onboardingStore: store });
  return app;
}

describe('M2.28 — untouched tenant (completeness=0)', () => {
  test('low roi_grade when no steps done', () => {
    const store = new InMemoryOnboardingStore();
    const out = buildTenantOnboardingRoi('BIL', store, NOW);
    expect(out.completeness_score).toBe(0);
    expect(out.projected_alert_reduction_pct).toBe(0);
    expect(out.projected_fp_reduction_pct).toBe(0);
    expect(out.estimated_monthly_savings_usd).toBe(0);
    expect(out.roi_grade).toBe('low');
    expect(out.time_to_value_days).toBe(30);
  });
});

describe('M2.28 — partial onboarding', () => {
  test('projected_alert_reduction_pct = completeness * 0.3', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    const out = buildTenantOnboardingRoi('BIL', store, NOW);
    expect(out.completeness_score).toBeGreaterThan(0);
    const expected = Math.round(out.completeness_score * 0.3 * 100) / 100;
    expect(out.projected_alert_reduction_pct).toBe(expected);
  });

  test('time_to_value_days decreases as onboarding progresses', () => {
    const store1 = new InMemoryOnboardingStore();
    const store2 = new InMemoryOnboardingStore();
    store2.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    store2.markStep('BIL', 'channels_configured', 'completed', 'alice', null, NOW);
    const out1 = buildTenantOnboardingRoi('BIL', store1, NOW);
    const out2 = buildTenantOnboardingRoi('BIL', store2, NOW);
    expect(out2.time_to_value_days).toBeLessThan(out1.time_to_value_days);
  });
});

describe('M2.28 — roi_grade thresholds', () => {
  test('roi_grade is one of high/medium/low', () => {
    const store = new InMemoryOnboardingStore();
    const out = buildTenantOnboardingRoi('BIL', store, NOW);
    expect(['high', 'medium', 'low']).toContain(out.roi_grade);
  });
});

describe('M2.28 — route', () => {
  test('admin GET /v1/tenants/onboarding/roi-estimate returns 200', async () => {
    const app = makeRoiApp('admin');
    const res = await request(app).get('/v1/tenants/onboarding/roi-estimate').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('roi_grade');
    expect(res.body.body).toHaveProperty('estimated_monthly_savings_usd');
  });

  test('non-admin gets 403', async () => {
    const app = makeRoiApp('field_officer');
    const res = await request(app).get('/v1/tenants/onboarding/roi-estimate').set(TH);
    expect(res.status).toBe(403);
  });
});
