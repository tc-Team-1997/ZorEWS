// services/bff/__tests__/tenant_onboarding_overview.test.ts
//
// T6 M2.9 — Tenant onboarding overview (composite).

import request from 'supertest';
import { composeOnboardingOverview } from '../src/tenant_onboarding_overview';
import {
  InMemoryOnboardingStore,
  ONBOARDING_STEPS,
} from '../src/tenant_onboarding';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── composeOnboardingOverview — pure ────────────────────────────────

describe('M2.9 — untouched tenant', () => {
  test('composite has 3 sub-views populated', () => {
    const store = new InMemoryOnboardingStore();
    const overview = composeOnboardingOverview(store.get('BIL'), NOW);
    expect(overview.tenant_id).toBe('BIL');
    expect(overview.generated_at).toBe(NOW.toISOString());
    expect(overview.readiness).toBeDefined();
    expect(overview.skip_history).toBeDefined();
    expect(overview.eta).toBeDefined();
    // readiness: blocked because zero required steps done
    expect(overview.readiness.completeness_score).toBe(0);
    // skip_history: zero skipped
    expect(overview.skip_history.total_skipped).toBe(0);
    // eta: pending=total
    expect(overview.eta.pending_minutes).toBeGreaterThan(0);
  });
});

describe('M2.9 — partial progress', () => {
  test('readiness, skip_history, eta all reflect the state', () => {
    const store = new InMemoryOnboardingStore();
    // Complete 3 steps, skip 1 with reason
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'channels_configured', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'vertical_set', 'completed', 'alice', null, NOW);
    store.skipStepWithReason('BIL', 'operator_invited', 'alice', 'centralised onboarding', NOW);
    const overview = composeOnboardingOverview(store.get('BIL'), NOW);
    // readiness reflects 3 of 7 required + 1 optional skip
    expect(overview.readiness.completeness_score).toBeGreaterThan(0);
    expect(overview.readiness.completeness_score).toBeLessThan(100);
    // skip_history shows the 1 skip
    expect(overview.skip_history.total_skipped).toBe(1);
    expect(overview.skip_history.total_skipped_with_reason).toBe(1);
    // eta reflects the completed minutes
    expect(overview.eta.completed_minutes).toBeGreaterThan(0);
    expect(overview.eta.pending_minutes).toBeGreaterThan(0);
  });
});

describe('M2.9 — fully done', () => {
  test('every step completed → readiness=100, eta=0 pending, projected_completion_at=null', () => {
    const store = new InMemoryOnboardingStore();
    for (const s of ONBOARDING_STEPS) {
      store.markStep('BIL', s.id, 'completed', 'alice', null, NOW);
    }
    const overview = composeOnboardingOverview(store.get('BIL'), NOW);
    expect(overview.readiness.completeness_score).toBe(100);
    expect(overview.eta.pending_minutes).toBe(0);
    expect(overview.eta.projected_completion_at).toBeNull();
  });
});

// ─── GET /v1/tenants/me/onboarding/overview ──────────────────────────

function makeOverviewApp(role = 'admin') {
  const onboardingStore = new InMemoryOnboardingStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    onboardingStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, onboardingStore };
}

describe('M2.9 — GET /v1/tenants/me/onboarding/overview', () => {
  test('admin → 200 with 3-sub-view composite', async () => {
    const { app } = makeOverviewApp('admin');
    const r = await request(app).get('/v1/tenants/me/onboarding/overview').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.readiness).toBeDefined();
    expect(r.body.body.skip_history).toBeDefined();
    expect(r.body.body.eta).toBeDefined();
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeOverviewApp('case_owner');
    const r = await request(app).get('/v1/tenants/me/onboarding/overview').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL state invisible to BANK_DEMO', async () => {
    const { app, onboardingStore } = makeOverviewApp('admin');
    onboardingStore.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    const bil = await request(app).get('/v1/tenants/me/onboarding/overview').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/tenants/me/onboarding/overview')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body.eta.completed_minutes).toBeGreaterThan(0);
    expect(bank.body.body.eta.completed_minutes).toBe(0);
  });

  test('M2.6 readiness endpoint still works (additive route)', async () => {
    const { app } = makeOverviewApp('admin');
    const r = await request(app).get('/v1/tenants/me/onboarding/readiness').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
