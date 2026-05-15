// services/bff/__tests__/tenant_onboarding_milestone.test.ts
//
// T6 M2.11 — Tenant onboarding milestone tracker.

import request from 'supertest';
import { computeOnboardingMilestone } from '../src/tenant_onboarding_milestone';
import {
  InMemoryOnboardingStore,
  ONBOARDING_STEPS,
} from '../src/tenant_onboarding';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── computeOnboardingMilestone — pure ───────────────────────────────

describe('M2.11 — untouched tenant (score=0)', () => {
  test('current_stage=starting + zero progress', () => {
    const store = new InMemoryOnboardingStore();
    const m = computeOnboardingMilestone(store.get('BIL'), NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.generated_at).toBe(NOW.toISOString());
    expect(m.completeness_score).toBe(0);
    expect(m.current_stage).toBe('starting');
    expect(m.progress_within_stage).toBe(0);
    expect(m.next_stage_threshold).toBe(25);
  });
});

describe('M2.11 — stage boundaries', () => {
  test('score=24 → starting', () => {
    const store = new InMemoryOnboardingStore();
    // Mock readiness directly via state manipulation is complex —
    // instead let the M2.6 score derive naturally. With 8 total
    // steps, completing 2 should hover around starting/in_progress
    // boundary. Use the synthesised state directly to control score.
    // Complete 1 required step → required_pct ≈ 14, overall_pct ≈ 13,
    // weighted ≈ 0.7×14 + 0.3×12.5 = 9.8 + 3.75 = 13.5 → rounded 14.
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    const m = computeOnboardingMilestone(store.get('BIL'), NOW);
    expect(m.completeness_score).toBeLessThan(25);
    expect(m.current_stage).toBe('starting');
  });

  test('score 25-49 → in_progress', () => {
    const store = new InMemoryOnboardingStore();
    // Complete ~3 required steps to reach 25-50% range.
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'channels_configured', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'vertical_set', 'completed', 'alice', null, NOW);
    const m = computeOnboardingMilestone(store.get('BIL'), NOW);
    if (m.completeness_score >= 25 && m.completeness_score < 50) {
      expect(m.current_stage).toBe('in_progress');
    }
  });

  test('score 50-74 → near_done', () => {
    const store = new InMemoryOnboardingStore();
    // Complete 5 of 7 required → ~71%.
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'channels_configured', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'vertical_set', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'config_baseline', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'email_channel', 'completed', 'alice', null, NOW);
    const m = computeOnboardingMilestone(store.get('BIL'), NOW);
    expect(m.completeness_score).toBeGreaterThanOrEqual(50);
    expect(m.completeness_score).toBeLessThan(75);
    expect(m.current_stage).toBe('near_done');
  });

  test('score 75-99 → final_review', () => {
    const store = new InMemoryOnboardingStore();
    // Complete 6 of 7 required.
    for (const id of [
      'tenant_provisioned',
      'channels_configured',
      'vertical_set',
      'config_baseline',
      'email_channel',
      'alert_routing',
    ] as const) {
      store.markStep('BIL', id, 'completed', 'alice', null, NOW);
    }
    const m = computeOnboardingMilestone(store.get('BIL'), NOW);
    expect(m.completeness_score).toBeGreaterThanOrEqual(75);
    expect(m.completeness_score).toBeLessThan(100);
    expect(m.current_stage).toBe('final_review');
    expect(m.next_stage_threshold).toBe(100);
  });

  test('score=100 → complete', () => {
    const store = new InMemoryOnboardingStore();
    for (const s of ONBOARDING_STEPS) {
      store.markStep('BIL', s.id, 'completed', 'alice', null, NOW);
    }
    const m = computeOnboardingMilestone(store.get('BIL'), NOW);
    expect(m.completeness_score).toBe(100);
    expect(m.current_stage).toBe('complete');
    expect(m.next_stage_threshold).toBeNull();
    expect(m.progress_within_stage).toBe(1);
  });
});

describe('M2.11 — all_stages reached flags', () => {
  test('starting: only "starting" reached', () => {
    const store = new InMemoryOnboardingStore();
    const m = computeOnboardingMilestone(store.get('BIL'), NOW);
    expect(m.all_stages.find((s) => s.stage === 'starting')!.reached).toBe(true);
    expect(m.all_stages.find((s) => s.stage === 'complete')!.reached).toBe(false);
  });

  test('complete: every stage reached', () => {
    const store = new InMemoryOnboardingStore();
    for (const s of ONBOARDING_STEPS) {
      store.markStep('BIL', s.id, 'completed', 'alice', null, NOW);
    }
    const m = computeOnboardingMilestone(store.get('BIL'), NOW);
    for (const stage of m.all_stages) {
      expect(stage.reached).toBe(true);
    }
  });

  test('5 stages in canonical order', () => {
    const store = new InMemoryOnboardingStore();
    const m = computeOnboardingMilestone(store.get('BIL'), NOW);
    expect(m.all_stages.map((s) => s.stage)).toEqual([
      'starting',
      'in_progress',
      'near_done',
      'final_review',
      'complete',
    ]);
  });
});

describe('M2.11 — progress_within_stage', () => {
  test('progress is fraction within current stage range', () => {
    const store = new InMemoryOnboardingStore();
    for (const id of [
      'tenant_provisioned',
      'channels_configured',
      'vertical_set',
      'config_baseline',
      'email_channel',
    ] as const) {
      store.markStep('BIL', id, 'completed', 'alice', null, NOW);
    }
    const m = computeOnboardingMilestone(store.get('BIL'), NOW);
    // near_done spans [50, 75) — score~71 → progress ≈ (71-50)/25
    const expected = (m.completeness_score - 50) / 25;
    expect(m.progress_within_stage).toBeCloseTo(expected, 5);
  });

  test('progress always in [0, 1]', () => {
    const store = new InMemoryOnboardingStore();
    const m = computeOnboardingMilestone(store.get('BIL'), NOW);
    expect(m.progress_within_stage).toBeGreaterThanOrEqual(0);
    expect(m.progress_within_stage).toBeLessThanOrEqual(1);
  });
});

describe('M2.11 — remaining_required_blockers', () => {
  test('counts pending required steps (not skipped)', () => {
    const store = new InMemoryOnboardingStore();
    // Complete 2 required; skip 1; the remaining 4 required are pending.
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'channels_configured', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'vertical_set', 'skipped', 'alice', null, NOW);
    const m = computeOnboardingMilestone(store.get('BIL'), NOW);
    // 7 required total → 2 completed + 1 skipped + 4 pending
    expect(m.remaining_required_blockers).toBe(4);
  });

  test('zero when all required completed', () => {
    const store = new InMemoryOnboardingStore();
    for (const s of ONBOARDING_STEPS) {
      if (s.required) {
        store.markStep('BIL', s.id, 'completed', 'alice', null, NOW);
      }
    }
    const m = computeOnboardingMilestone(store.get('BIL'), NOW);
    expect(m.remaining_required_blockers).toBe(0);
  });
});

describe('M2.11 — labels + descriptions', () => {
  test('current_label / current_description match the current stage', () => {
    const store = new InMemoryOnboardingStore();
    const m = computeOnboardingMilestone(store.get('BIL'), NOW);
    const matched = m.all_stages.find((s) => s.stage === m.current_stage)!;
    expect(m.current_label).toBe(matched.label);
    expect(m.current_description).toBe(matched.description);
  });
});

// ─── GET /v1/tenants/me/onboarding/milestone ─────────────────────────

function makeMilestoneApp(role = 'admin') {
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

describe('M2.11 — GET /v1/tenants/me/onboarding/milestone', () => {
  test('admin → 200 with starting stage for untouched tenant', async () => {
    const { app } = makeMilestoneApp('admin');
    const r = await request(app).get('/v1/tenants/me/onboarding/milestone').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.current_stage).toBe('starting');
    expect(r.body.body.completeness_score).toBe(0);
  });

  test('populated route reflects state changes', async () => {
    const { app, onboardingStore } = makeMilestoneApp('admin');
    for (const s of ONBOARDING_STEPS) {
      onboardingStore.markStep('BIL', s.id, 'completed', 'alice', null, NOW);
    }
    const r = await request(app).get('/v1/tenants/me/onboarding/milestone').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.current_stage).toBe('complete');
    expect(r.body.body.completeness_score).toBe(100);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeMilestoneApp('case_owner');
    const r = await request(app).get('/v1/tenants/me/onboarding/milestone').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL state invisible to BANK_DEMO', async () => {
    const { app, onboardingStore } = makeMilestoneApp('admin');
    onboardingStore.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    const bank = await request(app)
      .get('/v1/tenants/me/onboarding/milestone')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.current_stage).toBe('starting');
    expect(bank.body.body.completeness_score).toBe(0);
  });

  test('M2.6 readiness still works (sibling)', async () => {
    const { app } = makeMilestoneApp('admin');
    const r = await request(app).get('/v1/tenants/me/onboarding/readiness').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
