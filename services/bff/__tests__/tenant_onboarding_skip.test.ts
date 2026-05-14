// services/bff/__tests__/tenant_onboarding_skip.test.ts
//
// T6 M2.5 — Tenant onboarding step skip-with-reason capture.

import request from 'supertest';
import {
  InMemoryOnboardingStore,
  OnboardingError,
  SKIP_REASON_MAX,
  SKIP_REASON_MIN,
} from '../src/tenant_onboarding';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── Store-level — skipStepWithReason ────────────────────────────────

describe('M2.5 — skipStepWithReason — happy path', () => {
  test('captures the reason on the StepProgress; status=skipped', () => {
    const s = new InMemoryOnboardingStore();
    const out = s.skipStepWithReason(
      'BIL',
      'operator_invited',
      'alice',
      'no operator hired yet — recruiting',
      NOW,
    );
    const step = out.steps.find((p) => p.step_id === 'operator_invited')!;
    expect(step.status).toBe('skipped');
    expect(step.completed_by).toBe('alice');
    expect(step.completed_at).toBeNull(); // skipped, not completed
    expect(step.skip_reason).toBe('no operator hired yet — recruiting');
  });

  test('whitespace is collapsed in the stored reason', () => {
    const s = new InMemoryOnboardingStore();
    const out = s.skipStepWithReason(
      'BIL',
      'operator_invited',
      'alice',
      '   deferred    by   ops    council   ',
      NOW,
    );
    const step = out.steps.find((p) => p.step_id === 'operator_invited')!;
    expect(step.skip_reason).toBe('deferred by ops council');
  });

  test('counts move: pending → skipped (skipped_count++)', () => {
    const s = new InMemoryOnboardingStore();
    const before = s.get('BIL');
    expect(before.skipped_count).toBe(0);
    expect(before.pending_count).toBe(8);
    const after = s.skipStepWithReason(
      'BIL',
      'operator_invited',
      'alice',
      'deferred — see RB-1234',
      NOW,
    );
    expect(after.skipped_count).toBe(1);
    expect(after.pending_count).toBe(7);
  });
});

describe('M2.5 — skipStepWithReason — validation', () => {
  test('missing reason → skip_reason_required', () => {
    const s = new InMemoryOnboardingStore();
    expect(() =>
      s.skipStepWithReason('BIL', 'operator_invited', 'alice', undefined, NOW),
    ).toThrow(OnboardingError);
    expect(() =>
      s.skipStepWithReason('BIL', 'operator_invited', 'alice', null, NOW),
    ).toThrow(/required/);
    expect(() =>
      s.skipStepWithReason('BIL', 'operator_invited', 'alice', '', NOW),
    ).toThrow(/required/);
    expect(() =>
      s.skipStepWithReason('BIL', 'operator_invited', 'alice', '   ', NOW),
    ).toThrow(/required/);
  });

  test(`reason shorter than ${SKIP_REASON_MIN} chars → skip_reason_too_short`, () => {
    const s = new InMemoryOnboardingStore();
    expect(() =>
      s.skipStepWithReason('BIL', 'operator_invited', 'alice', 'no', NOW),
    ).toThrow(/too_short|≥/);
  });

  test(`reason longer than ${SKIP_REASON_MAX} chars → skip_reason_too_long`, () => {
    const s = new InMemoryOnboardingStore();
    const tooLong = 'x'.repeat(SKIP_REASON_MAX + 1);
    expect(() =>
      s.skipStepWithReason('BIL', 'operator_invited', 'alice', tooLong, NOW),
    ).toThrow(/too_long|≤/);
  });

  test('unknown step → unknown_step error', () => {
    const s = new InMemoryOnboardingStore();
    expect(() =>
      s.skipStepWithReason('BIL', 'not_a_real_step', 'alice', 'plausible reason here', NOW),
    ).toThrow(/unknown onboarding step/);
  });

  test('missing actor → invalid_input', () => {
    const s = new InMemoryOnboardingStore();
    expect(() =>
      s.skipStepWithReason('BIL', 'operator_invited', '', 'plausible reason', NOW),
    ).toThrow(/actor/);
  });
});

describe('M2.5 — backwards-compatibility with markStep', () => {
  test('legacy markStep skipped → skip_reason stays null', () => {
    const s = new InMemoryOnboardingStore();
    const out = s.markStep('BIL', 'operator_invited', 'skipped', 'alice', null, NOW);
    const step = out.steps.find((p) => p.step_id === 'operator_invited')!;
    expect(step.status).toBe('skipped');
    expect(step.skip_reason).toBeNull();
  });

  test('skipStepWithReason then markStep completed → skip_reason cleared back to null', () => {
    const s = new InMemoryOnboardingStore();
    s.skipStepWithReason('BIL', 'operator_invited', 'alice', 'reason A held', NOW);
    const after = s.markStep('BIL', 'operator_invited', 'completed', 'alice', null, NOW);
    const step = after.steps.find((p) => p.step_id === 'operator_invited')!;
    expect(step.status).toBe('completed');
    expect(step.skip_reason).toBeNull();
  });

  test('pendingStep default has skip_reason: null', () => {
    const s = new InMemoryOnboardingStore();
    const out = s.get('BIL');
    for (const step of out.steps) {
      expect(step.skip_reason).toBeNull();
    }
  });
});

describe('M2.5 — tenant isolation', () => {
  test('skipStepWithReason on one tenant does not affect another', () => {
    const s = new InMemoryOnboardingStore();
    s.skipStepWithReason('BIL', 'operator_invited', 'alice', 'reason BIL', NOW);
    const demo = s.get('BANK_DEMO');
    expect(demo.skipped_count).toBe(0);
    const demoStep = demo.steps.find((p) => p.step_id === 'operator_invited')!;
    expect(demoStep.skip_reason).toBeNull();
  });
});

// ─── Route — POST /v1/tenants/:tenant_id/onboarding/steps/:step_id/skip ───

function makeSkipApp(role = 'admin', store?: InMemoryOnboardingStore) {
  const onboardingStore = store ?? new InMemoryOnboardingStore();
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

describe('M2.5 — POST /v1/tenants/:tenant_id/onboarding/steps/:step_id/skip', () => {
  test('200 with state.skip_reason populated', async () => {
    const { app } = makeSkipApp('admin');
    const r = await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/operator_invited/skip')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ reason: 'no operator yet, recruiting underway' });
    expect(r.status).toBe(200);
    const step = r.body.body.steps.find(
      (p: { step_id: string }) => p.step_id === 'operator_invited',
    );
    expect(step.status).toBe('skipped');
    expect(step.skip_reason).toBe('no operator yet, recruiting underway');
  });

  test('missing reason → 400 skip_reason_required', async () => {
    const { app } = makeSkipApp('admin');
    const r = await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/operator_invited/skip')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_skip_reason_required');
  });

  test('reason too short → 400 skip_reason_too_short', async () => {
    const { app } = makeSkipApp('admin');
    const r = await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/operator_invited/skip')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ reason: 'no' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_skip_reason_too_short');
  });

  test('reason too long → 400 skip_reason_too_long', async () => {
    const { app } = makeSkipApp('admin');
    const r = await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/operator_invited/skip')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ reason: 'x'.repeat(SKIP_REASON_MAX + 1) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_skip_reason_too_long');
  });

  test('unknown step → 404 unknown_step', async () => {
    const { app } = makeSkipApp('admin');
    const r = await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/not_a_real_step/skip')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ reason: 'plausible reason here' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_step');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSkipApp('case_owner');
    const r = await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/operator_invited/skip')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ reason: 'plausible reason here' });
    expect(r.status).toBe(403);
  });

  test('M2.2 markStep route still works (skip route is additive)', async () => {
    const { app } = makeSkipApp('admin');
    const r = await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/operator_invited')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ status: 'completed' });
    expect(r.status).toBe(200);
    const step = r.body.body.steps.find(
      (p: { step_id: string }) => p.step_id === 'operator_invited',
    );
    expect(step.status).toBe('completed');
    expect(step.skip_reason).toBeNull();
  });
});
