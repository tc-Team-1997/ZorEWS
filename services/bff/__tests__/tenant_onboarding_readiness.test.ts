// services/bff/__tests__/tenant_onboarding_readiness.test.ts
//
// T6 M2.6 — Tenant onboarding readiness score.

import request from 'supertest';
import { computeOnboardingReadiness } from '../src/tenant_onboarding_readiness';
import { InMemoryOnboardingStore } from '../src/tenant_onboarding';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── computeOnboardingReadiness — pure ───────────────────────────────

describe('M2.6 — computeOnboardingReadiness — empty tenant', () => {
  test('untouched tenant → score=0, every required step is a blocker, next_action points at step 1', () => {
    const store = new InMemoryOnboardingStore();
    const state = store.get('BIL');
    const out = computeOnboardingReadiness(state);
    expect(out.tenant_id).toBe('BIL');
    expect(out.completeness_score).toBe(0);
    expect(out.required_pct).toBe(0);
    expect(out.overall_pct).toBe(0);
    expect(out.completed_required_count).toBe(0);
    expect(out.required_steps).toBe(7); // 7 of 8 are required (operator_invited is optional)
    expect(out.is_complete).toBe(false);
    expect(out.blockers.length).toBe(7);
    expect(out.next_action?.step_id).toBe('tenant_provisioned'); // order=1
  });
});

describe('M2.6 — computeOnboardingReadiness — partial', () => {
  test('1 required step done → required_pct ~14, overall_pct ~12, weighted ~14', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    const out = computeOnboardingReadiness(store.get('BIL'));
    expect(out.completed_required_count).toBe(1);
    expect(out.required_pct).toBe(14); // 1/7 = 14.28%
    expect(out.overall_pct).toBe(13); // 1/8 = 12.5%
    // 0.7 * 14 + 0.3 * 13 = 9.8 + 3.9 = 13.7 → 14
    expect(out.completeness_score).toBe(14);
    expect(out.blockers.length).toBe(6); // 6 required still blocked
    expect(out.next_action?.step_id).toBe('channels_configured'); // order=2
  });

  test('all 7 required done → score=100 even though optional step is pending', () => {
    const store = new InMemoryOnboardingStore();
    for (const id of [
      'tenant_provisioned',
      'channels_configured',
      'vertical_set',
      'config_baseline',
      'email_channel',
      'alert_routing',
      'audit_active',
    ]) {
      store.markStep('BIL', id, 'completed', 'alice', null, NOW);
    }
    const out = computeOnboardingReadiness(store.get('BIL'));
    expect(out.is_complete).toBe(true);
    expect(out.required_pct).toBe(100);
    // overall = 7/8 = 87.5% → 88
    expect(out.overall_pct).toBe(88);
    // 0.7 * 100 + 0.3 * 88 = 70 + 26.4 = 96.4 → 96
    expect(out.completeness_score).toBe(96);
    expect(out.blockers).toEqual([]);
    expect(out.next_action).toBeNull();
  });

  test('all 8 done → 100/100/100', () => {
    const store = new InMemoryOnboardingStore();
    for (const id of [
      'tenant_provisioned',
      'channels_configured',
      'vertical_set',
      'config_baseline',
      'email_channel',
      'alert_routing',
      'audit_active',
      'operator_invited',
    ]) {
      store.markStep('BIL', id, 'completed', 'alice', null, NOW);
    }
    const out = computeOnboardingReadiness(store.get('BIL'));
    expect(out.required_pct).toBe(100);
    expect(out.overall_pct).toBe(100);
    expect(out.completeness_score).toBe(100);
  });
});

describe('M2.6 — skipped required step is a blocker, not a completion', () => {
  test('skipped required step counts as blocker (status=skipped) AND not in completed_required_count', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    store.skipStepWithReason(
      'BIL',
      'channels_configured',
      'alice',
      'deferred per RB-1234 — channels still under review',
      NOW,
    );
    const out = computeOnboardingReadiness(store.get('BIL'));
    expect(out.completed_required_count).toBe(1);
    expect(out.required_pct).toBe(14); // still 1/7
    // Blockers: 6 required not completed (1 skipped, 5 pending).
    expect(out.blockers.length).toBe(6);
    const skippedBlocker = out.blockers.find((b) => b.step_id === 'channels_configured');
    expect(skippedBlocker?.status).toBe('skipped');
    expect(skippedBlocker?.skip_reason).toContain('RB-1234');
  });

  test('next_action skips OVER skipped required steps to the next PENDING one', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    store.skipStepWithReason(
      'BIL',
      'channels_configured',
      'alice',
      'deferred per RB-1234 follow-up',
      NOW,
    );
    const out = computeOnboardingReadiness(store.get('BIL'));
    // Next PENDING required step is vertical_set (order=3, not the
    // skipped channels_configured which is at order=2).
    expect(out.next_action?.step_id).toBe('vertical_set');
  });

  test('every required skipped → blockers all skipped, next_action null', () => {
    const store = new InMemoryOnboardingStore();
    for (const id of [
      'tenant_provisioned',
      'channels_configured',
      'vertical_set',
      'config_baseline',
      'email_channel',
      'alert_routing',
      'audit_active',
    ]) {
      store.skipStepWithReason('BIL', id, 'alice', 'all deferred for this test', NOW);
    }
    const out = computeOnboardingReadiness(store.get('BIL'));
    expect(out.next_action).toBeNull();
    expect(out.blockers.every((b) => b.status === 'skipped')).toBe(true);
    expect(out.completeness_score).toBe(0);
  });
});

describe('M2.6 — blockers sorted by step.order', () => {
  test('blockers come out in order regardless of mark sequence', () => {
    const store = new InMemoryOnboardingStore();
    // Complete some out-of-order, leave others pending.
    store.markStep('BIL', 'audit_active', 'completed', 'alice', null, NOW); // order=7
    store.markStep('BIL', 'vertical_set', 'completed', 'alice', null, NOW); // order=3
    const out = computeOnboardingReadiness(store.get('BIL'));
    expect(out.blockers.map((b) => b.order)).toEqual([1, 2, 4, 5, 6]);
  });
});

// ─── Routes — /readiness ─────────────────────────────────────────────

function makeReadinessApp(role = 'admin') {
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

describe('M2.6 — GET /v1/tenants/me/onboarding/readiness', () => {
  test('untouched tenant → 200 with zero score', async () => {
    const { app } = makeReadinessApp('admin');
    const r = await request(app).get('/v1/tenants/me/onboarding/readiness').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.completeness_score).toBe(0);
    expect(r.body.body.blockers.length).toBe(7);
  });

  test('after a couple of completions, score reflects progress', async () => {
    const { app, onboardingStore } = makeReadinessApp('admin');
    onboardingStore.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    onboardingStore.markStep('BIL', 'channels_configured', 'completed', 'alice', null, NOW);
    const r = await request(app).get('/v1/tenants/me/onboarding/readiness').set(TH_BIL);
    expect(r.body.body.completed_required_count).toBe(2);
    expect(r.body.body.required_pct).toBe(29); // 2/7 = 28.57
    expect(r.body.body.next_action.step_id).toBe('vertical_set');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeReadinessApp('case_owner');
    const r = await request(app).get('/v1/tenants/me/onboarding/readiness').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('M2.6 — GET /v1/tenants/:tenant_id/onboarding/readiness', () => {
  test('admin lookup for another tenant', async () => {
    const { app, onboardingStore } = makeReadinessApp('admin');
    onboardingStore.markStep('BANK_DEMO', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    const r = await request(app)
      .get('/v1/tenants/BANK_DEMO/onboarding/readiness')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
    expect(r.body.body.completed_required_count).toBe(1);
  });

  test('M2.2 /v1/tenants/:tenant_id/onboarding still works (readiness route is additive)', async () => {
    const { app } = makeReadinessApp('admin');
    const r = await request(app).get('/v1/tenants/BIL/onboarding').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
  });
});
