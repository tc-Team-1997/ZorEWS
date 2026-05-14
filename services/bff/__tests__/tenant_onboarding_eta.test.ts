// services/bff/__tests__/tenant_onboarding_eta.test.ts
//
// T6 M2.8 — Tenant onboarding ETA projection.

import request from 'supertest';
import { projectOnboardingEta } from '../src/tenant_onboarding_eta';
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

// ─── projectOnboardingEta — pure ─────────────────────────────────────

describe('M2.8 — untouched tenant (every step pending)', () => {
  test('all minutes pending; projected_completion_at = now + total minutes', () => {
    const store = new InMemoryOnboardingStore();
    const state = store.get('BIL');
    const p = projectOnboardingEta(state, NOW);
    expect(p.completed_minutes).toBe(0);
    expect(p.skipped_minutes).toBe(0);
    expect(p.pending_minutes).toBe(p.total_platform_minutes);
    expect(p.remaining_minutes).toBe(p.total_platform_minutes);
    expect(p.percent_done_by_effort).toBe(0);
    expect(p.projected_completion_at).not.toBeNull();
    // remaining_required_minutes excludes the optional `operator_invited` (15)
    expect(p.remaining_required_minutes).toBe(p.total_platform_minutes - 15);
  });
});

describe('M2.8 — fully completed', () => {
  test('every step done → projected_completion_at = null + remaining=0', () => {
    const store = new InMemoryOnboardingStore();
    for (const s of ONBOARDING_STEPS) {
      store.markStep('BIL', s.id, 'completed', 'alice', null, NOW);
    }
    const state = store.get('BIL');
    const p = projectOnboardingEta(state, NOW);
    expect(p.completed_minutes).toBe(p.total_platform_minutes);
    expect(p.pending_minutes).toBe(0);
    expect(p.percent_done_by_effort).toBeCloseTo(1, 5);
    expect(p.projected_completion_at).toBeNull();
    expect(p.remaining_required_minutes).toBe(0);
  });
});

describe('M2.8 — partial', () => {
  test('half-done state surfaces accurate counts + ETA', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'channels_configured', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'vertical_set', 'completed', 'alice', null, NOW);
    const state = store.get('BIL');
    const p = projectOnboardingEta(state, NOW);
    expect(p.completed_minutes).toBe(5 + 10 + 5);
    expect(p.pending_minutes).toBe(p.total_platform_minutes - 20);
    expect(p.projected_completion_at).not.toBeNull();
  });
});

describe('M2.8 — skipped steps', () => {
  test('skipped steps contribute to skipped_minutes, not pending', () => {
    const store = new InMemoryOnboardingStore();
    // operator_invited is optional; skipping it shouldn't block completion.
    store.markStep('BIL', 'operator_invited', 'skipped', 'alice', null, NOW);
    const state = store.get('BIL');
    const p = projectOnboardingEta(state, NOW);
    expect(p.skipped_minutes).toBe(15);
    expect(p.pending_minutes).toBe(p.total_platform_minutes - 15);
    // remaining_required excludes skipped + only counts pending required.
    // Every other step (7 of 8) is required and still pending.
    const totalRequiredMins =
      p.total_platform_minutes - 15; /* minus operator_invited */
    expect(p.remaining_required_minutes).toBe(totalRequiredMins);
  });
});

describe('M2.8 — projected_completion_at correctness', () => {
  test('projected_completion_at = now + pending_minutes * 60_000', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    const state = store.get('BIL');
    const p = projectOnboardingEta(state, NOW);
    const expected = new Date(NOW.getTime() + p.pending_minutes * 60_000).toISOString();
    expect(p.projected_completion_at).toBe(expected);
  });
});

// ─── GET /v1/tenants/me/onboarding/eta ───────────────────────────────

function makeEtaApp(role = 'admin') {
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

describe('M2.8 — GET /v1/tenants/me/onboarding/eta', () => {
  test('untouched tenant → 200 with all minutes pending', async () => {
    const { app } = makeEtaApp('admin');
    const r = await request(app).get('/v1/tenants/me/onboarding/eta').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.completed_minutes).toBe(0);
    expect(r.body.body.pending_minutes).toBeGreaterThan(0);
    expect(r.body.body.projected_completion_at).not.toBeNull();
  });

  test('fully completed → projected_completion_at=null', async () => {
    const { app, onboardingStore } = makeEtaApp('admin');
    for (const s of ONBOARDING_STEPS) {
      onboardingStore.markStep('BIL', s.id, 'completed', 'alice', null, NOW);
    }
    const r = await request(app).get('/v1/tenants/me/onboarding/eta').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.pending_minutes).toBe(0);
    expect(r.body.body.projected_completion_at).toBeNull();
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeEtaApp('case_owner');
    const r = await request(app).get('/v1/tenants/me/onboarding/eta').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL state invisible to BANK_DEMO', async () => {
    const { app, onboardingStore } = makeEtaApp('admin');
    onboardingStore.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    const bil = await request(app).get('/v1/tenants/me/onboarding/eta').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/tenants/me/onboarding/eta')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body.completed_minutes).toBeGreaterThan(0);
    expect(bank.body.body.completed_minutes).toBe(0);
  });
});
