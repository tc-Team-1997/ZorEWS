// services/bff/__tests__/onboarding_skip_history.test.ts
//
// T6 M2.7 — Tenant onboarding skip-reason history.

import request from 'supertest';
import { listOnboardingSkips } from '../src/onboarding_skip_history';
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

// ─── listOnboardingSkips — pure ──────────────────────────────────────

describe('M2.7 — listOnboardingSkips — empty', () => {
  test('untouched tenant → zero envelope', () => {
    const store = new InMemoryOnboardingStore();
    const state = store.get('BIL');
    const out = listOnboardingSkips(state);
    expect(out.tenant_id).toBe('BIL');
    expect(out.total_skipped).toBe(0);
    expect(out.total_skipped_with_reason).toBe(0);
    expect(out.total_skipped_legacy).toBe(0);
    expect(out.skipped_steps).toEqual([]);
  });
});

describe('M2.7 — explicit skip with reason (M2.5 path)', () => {
  test('skipStepWithReason captures reason; surfaced in history', () => {
    const store = new InMemoryOnboardingStore();
    // Pick any optional step so the skip doesn't block readiness.
    const optionalStep = ONBOARDING_STEPS.find((s) => !s.required)!;
    store.skipStepWithReason(
      'BIL',
      optionalStep.id,
      'alice',
      'Customer opted out of branch onboarding — covered by central ops',
      NOW,
    );
    const state = store.get('BIL');
    const out = listOnboardingSkips(state);
    expect(out.total_skipped).toBe(1);
    expect(out.total_skipped_with_reason).toBe(1);
    expect(out.total_skipped_legacy).toBe(0);
    const rec = out.skipped_steps[0]!;
    expect(rec.step_id).toBe(optionalStep.id);
    expect(rec.skip_reason).toContain('Customer opted out');
    expect(rec.actor).toBe('alice');
    expect(rec.required).toBe(false);
    expect(rec.order).toBe(optionalStep.order);
  });
});

describe('M2.7 — legacy skip (markStep "skipped" path)', () => {
  test('legacy skip has null skip_reason; counted in legacy bucket', () => {
    const store = new InMemoryOnboardingStore();
    const optionalStep = ONBOARDING_STEPS.find((s) => !s.required)!;
    store.markStep('BIL', optionalStep.id, 'skipped', 'bob', null, NOW);
    const state = store.get('BIL');
    const out = listOnboardingSkips(state);
    expect(out.total_skipped).toBe(1);
    expect(out.total_skipped_with_reason).toBe(0);
    expect(out.total_skipped_legacy).toBe(1);
    expect(out.skipped_steps[0]!.skip_reason).toBeNull();
  });
});

describe('M2.7 — filtering + order', () => {
  test('completed and pending steps drop; skipped surface in step.order asc', () => {
    const store = new InMemoryOnboardingStore();
    // Pick the 3 highest-order steps to skip (any step can be skipped
    // via skipStepWithReason — required-skip is the regulatory use case
    // M2.5 was designed for).
    const [first, second, third] = [...ONBOARDING_STEPS]
      .sort((a, b) => b.order - a.order)
      .slice(0, 3);
    store.skipStepWithReason('BIL', first!.id, 'alice', 'reason for first', NOW);
    store.skipStepWithReason('BIL', second!.id, 'alice', 'reason for second', NOW);
    store.skipStepWithReason('BIL', third!.id, 'alice', 'reason for third', NOW);
    // Complete an unrelated step — should NOT appear in skip-history.
    const anyOther = ONBOARDING_STEPS.find(
      (s) => ![first!.id, second!.id, third!.id].includes(s.id),
    )!;
    store.markStep('BIL', anyOther.id, 'completed', 'alice', null, NOW);
    const state = store.get('BIL');
    const out = listOnboardingSkips(state);
    expect(out.total_skipped).toBe(3);
    // Sorted asc by step.order
    const orders = out.skipped_steps.map((s) => s.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    // The completed step doesn't appear.
    expect(out.skipped_steps.find((s) => s.step_id === anyOther.id)).toBeUndefined();
  });
});

describe('M2.7 — mixed reason and legacy', () => {
  test('counts both buckets correctly', () => {
    const store = new InMemoryOnboardingStore();
    // Pick any two distinct steps — any step type is fine.
    const [a, b] = ONBOARDING_STEPS;
    store.skipStepWithReason('BIL', a!.id, 'alice', 'because reasons', NOW);
    store.markStep('BIL', b!.id, 'skipped', 'bob', null, NOW);
    const state = store.get('BIL');
    const out = listOnboardingSkips(state);
    expect(out.total_skipped).toBe(2);
    expect(out.total_skipped_with_reason).toBe(1);
    expect(out.total_skipped_legacy).toBe(1);
  });
});

// ─── GET /v1/tenants/me/onboarding/skip-history ──────────────────────

function makeSkipHistoryApp(role = 'admin') {
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

describe('M2.7 — GET /v1/tenants/me/onboarding/skip-history', () => {
  test('empty tenant → 200 zero envelope', async () => {
    const { app } = makeSkipHistoryApp('admin');
    const r = await request(app)
      .get('/v1/tenants/me/onboarding/skip-history')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.total_skipped).toBe(0);
  });

  test('records show up after skipStepWithReason', async () => {
    const { app, onboardingStore } = makeSkipHistoryApp('admin');
    const optionalStep = ONBOARDING_STEPS.find((s) => !s.required)!;
    onboardingStore.skipStepWithReason(
      'BIL',
      optionalStep.id,
      'alice',
      'branch onboarding waived per central ops directive',
      NOW,
    );
    const r = await request(app)
      .get('/v1/tenants/me/onboarding/skip-history')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_skipped).toBe(1);
    expect(r.body.body.total_skipped_with_reason).toBe(1);
    expect(r.body.body.skipped_steps[0].skip_reason).toContain('branch onboarding');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSkipHistoryApp('readonly');
    const r = await request(app)
      .get('/v1/tenants/me/onboarding/skip-history')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL skip invisible to BANK_DEMO', async () => {
    const { app, onboardingStore } = makeSkipHistoryApp('admin');
    const optionalStep = ONBOARDING_STEPS.find((s) => !s.required)!;
    onboardingStore.skipStepWithReason(
      'BIL',
      optionalStep.id,
      'alice',
      'reason for skipping',
      NOW,
    );
    const r = await request(app)
      .get('/v1/tenants/me/onboarding/skip-history')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total_skipped).toBe(0);
  });
});
