// services/bff/__tests__/tenant_onboarding_actors.test.ts
//
// T6 M2.10 — Tenant onboarding actor summary.

import request from 'supertest';
import { summarizeOnboardingActors } from '../src/tenant_onboarding_actors';
import { InMemoryOnboardingStore } from '../src/tenant_onboarding';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── summarizeOnboardingActors — pure ──────────────────────────────

describe('M2.10 — untouched tenant', () => {
  test('zero actors / zero counts', () => {
    const store = new InMemoryOnboardingStore();
    const summary = summarizeOnboardingActors(store.get('BIL'));
    expect(summary.tenant_id).toBe('BIL');
    expect(summary.total_actors).toBe(0);
    expect(summary.total_completed).toBe(0);
    expect(summary.total_skipped).toBe(0);
    expect(summary.actors).toEqual([]);
  });
});

describe('M2.10 — single actor', () => {
  test('one user completes 2 steps → one row with completed_steps in order', () => {
    const store = new InMemoryOnboardingStore();
    // Mark out of order to test sort
    store.markStep('BIL', 'vertical_set', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    const summary = summarizeOnboardingActors(store.get('BIL'));
    expect(summary.total_actors).toBe(1);
    expect(summary.total_completed).toBe(2);
    expect(summary.total_skipped).toBe(0);
    expect(summary.actors[0]!.actor_username).toBe('alice');
    expect(summary.actors[0]!.total_actions).toBe(2);
    expect(summary.actors[0]!.completed_steps).toEqual([
      'tenant_provisioned',
      'vertical_set',
    ]);
  });
});

describe('M2.10 — multiple actors with skips', () => {
  test('actors sorted by total_actions desc, then username asc', () => {
    const store = new InMemoryOnboardingStore();
    // alice: 1 completed (1 action)
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    // bob: 2 completed (2 actions)
    store.markStep('BIL', 'channels_configured', 'completed', 'bob', null, NOW);
    store.markStep('BIL', 'vertical_set', 'completed', 'bob', null, NOW);
    // charlie: 1 skip with reason (1 action) — using legacy markStep so completed_by is set
    store.markStep('BIL', 'operator_invited', 'skipped', 'charlie', null, NOW);
    const summary = summarizeOnboardingActors(store.get('BIL'));
    expect(summary.total_actors).toBe(3);
    expect(summary.total_completed).toBe(3);
    expect(summary.total_skipped).toBe(1);
    // bob first (2 actions), then alice + charlie (alphabetical at 1 action)
    expect(summary.actors.map((a) => a.actor_username)).toEqual(['bob', 'alice', 'charlie']);
    const charlie = summary.actors.find((a) => a.actor_username === 'charlie')!;
    expect(charlie.skipped_count).toBe(1);
    expect(charlie.completed_count).toBe(0);
    expect(charlie.skipped_steps).toEqual(['operator_invited']);
  });
});

describe('M2.10 — skipStepWithReason captures actor', () => {
  test('M2.5 skip path is included in the actor summary', () => {
    const store = new InMemoryOnboardingStore();
    store.skipStepWithReason('BIL', 'audit_active', 'compliance.lead', 'centralised audit not yet wired', NOW);
    const summary = summarizeOnboardingActors(store.get('BIL'));
    expect(summary.total_skipped).toBe(1);
    expect(summary.actors[0]!.actor_username).toBe('compliance.lead');
    expect(summary.actors[0]!.skipped_steps).toEqual(['audit_active']);
  });
});

describe('M2.10 — pending steps not counted', () => {
  test('pending statuses ignored regardless of actor', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'vertical_set', 'pending', 'alice', null, NOW); // explicit pending
    const summary = summarizeOnboardingActors(store.get('BIL'));
    expect(summary.total_completed).toBe(1);
    expect(summary.actors[0]!.completed_count).toBe(1);
  });
});

describe('M2.10 — same actor mixes complete + skip', () => {
  test('one actor with both complete and skip → row carries both counts', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'operator_invited', 'skipped', 'alice', null, NOW);
    const summary = summarizeOnboardingActors(store.get('BIL'));
    expect(summary.total_actors).toBe(1);
    expect(summary.actors[0]!.completed_count).toBe(1);
    expect(summary.actors[0]!.skipped_count).toBe(1);
    expect(summary.actors[0]!.total_actions).toBe(2);
  });
});

// ─── GET /v1/tenants/me/onboarding/actors ──────────────────────────

function makeActorsApp(role = 'admin') {
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

describe('M2.10 — GET /v1/tenants/me/onboarding/actors', () => {
  test('admin → 200 with actor summary', async () => {
    const { app, onboardingStore } = makeActorsApp('admin');
    onboardingStore.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    onboardingStore.markStep('BIL', 'channels_configured', 'completed', 'bob', null, NOW);
    const r = await request(app).get('/v1/tenants/me/onboarding/actors').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.total_actors).toBe(2);
    expect(r.body.body.actors).toHaveLength(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeActorsApp('case_owner');
    const r = await request(app).get('/v1/tenants/me/onboarding/actors').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL state invisible to BANK_DEMO', async () => {
    const { app, onboardingStore } = makeActorsApp('admin');
    onboardingStore.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    const bank = await request(app)
      .get('/v1/tenants/me/onboarding/actors')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_actors).toBe(0);
  });

  test('M2.9 overview endpoint still works (additive route)', async () => {
    const { app } = makeActorsApp('admin');
    const r = await request(app).get('/v1/tenants/me/onboarding/overview').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
