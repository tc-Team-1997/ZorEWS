// services/bff/__tests__/tenant_onboarding.test.ts
//
// T6 M2.2 — Tenant onboarding wizard.

import request from 'supertest';
import {
  InMemoryOnboardingStore,
  ONBOARDING_STEPS,
  OnboardingError,
  getOnboardingStepDef,
  isOnboardingStepId,
  isStepStatus,
  type OnboardingState,
} from '../src/tenant_onboarding';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeOnboardApp(role: string = 'admin') {
  const store = new InMemoryOnboardingStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    onboardingStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

// ─── Catalogue ────────────────────────────────────────────────────────

describe('Onboarding step catalogue', () => {
  test('exactly 8 steps in 1-based order', () => {
    expect(ONBOARDING_STEPS.length).toBe(8);
    const orders = ONBOARDING_STEPS.map((s) => s.order).sort((a, b) => a - b);
    expect(orders).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('all step ids unique', () => {
    const ids = new Set(ONBOARDING_STEPS.map((s) => s.id));
    expect(ids.size).toBe(8);
  });

  test('7 required + 1 optional', () => {
    const req = ONBOARDING_STEPS.filter((s) => s.required);
    const opt = ONBOARDING_STEPS.filter((s) => !s.required);
    expect(req.length).toBe(7);
    expect(opt.length).toBe(1);
    expect(opt[0]!.id).toBe('operator_invited');
  });

  test('isOnboardingStepId / getOnboardingStepDef agree', () => {
    for (const s of ONBOARDING_STEPS) {
      expect(isOnboardingStepId(s.id)).toBe(true);
      expect(getOnboardingStepDef(s.id)?.id).toBe(s.id);
    }
    expect(isOnboardingStepId('NO-SUCH')).toBe(false);
    expect(getOnboardingStepDef('NO-SUCH')).toBeNull();
  });

  test('isStepStatus accepts pending/completed/skipped only', () => {
    expect(isStepStatus('pending')).toBe(true);
    expect(isStepStatus('completed')).toBe(true);
    expect(isStepStatus('skipped')).toBe(true);
    expect(isStepStatus('done')).toBe(false);
    expect(isStepStatus(42)).toBe(false);
  });
});

// ─── Store: get ────────────────────────────────────────────────────────

describe('InMemoryOnboardingStore.get', () => {
  test('never-touched tenant returns all-pending', () => {
    const s = new InMemoryOnboardingStore();
    const out = s.get('BIL');
    expect(out.tenant_id).toBe('BIL');
    expect(out.steps.length).toBe(8);
    expect(out.steps.every((p) => p.status === 'pending')).toBe(true);
    expect(out.completed_count).toBe(0);
    expect(out.skipped_count).toBe(0);
    expect(out.pending_count).toBe(8);
    expect(out.is_complete).toBe(false);
    expect(out.updated_at).toBeNull();
    expect(out.total_steps).toBe(8);
    expect(out.required_steps).toBe(7);
  });

  test('steps returned sorted by order', () => {
    const s = new InMemoryOnboardingStore();
    const out = s.get('BIL');
    const ids = out.steps.map((p) => p.step_id);
    expect(ids[0]).toBe('tenant_provisioned');
    expect(ids[7]).toBe('operator_invited');
  });

  test('rejects empty tenant_id', () => {
    const s = new InMemoryOnboardingStore();
    expect(() => s.get('')).toThrow(OnboardingError);
  });
});

// ─── Store: markStep ──────────────────────────────────────────────────

describe('InMemoryOnboardingStore.markStep', () => {
  test('completed step records completed_at + completed_by + notes', () => {
    const s = new InMemoryOnboardingStore();
    const out = s.markStep('BIL', 'tenant_provisioned', 'completed', 'admin', 'auto on tenant insert', NOW);
    const step = out.steps.find((p) => p.step_id === 'tenant_provisioned')!;
    expect(step.status).toBe('completed');
    expect(step.completed_at).toBe(NOW.toISOString());
    expect(step.completed_by).toBe('admin');
    expect(step.notes).toBe('auto on tenant insert');
    expect(out.completed_count).toBe(1);
    expect(out.pending_count).toBe(7);
    expect(out.is_complete).toBe(false);
  });

  test('skipped step records actor but not completed_at', () => {
    const s = new InMemoryOnboardingStore();
    const out = s.markStep('BIL', 'operator_invited', 'skipped', 'admin', 'defer to next sprint', NOW);
    const step = out.steps.find((p) => p.step_id === 'operator_invited')!;
    expect(step.status).toBe('skipped');
    expect(step.completed_at).toBeNull();
    expect(step.completed_by).toBe('admin');
    expect(step.notes).toBe('defer to next sprint');
  });

  test('pending status clears completed_at + completed_by', () => {
    const s = new InMemoryOnboardingStore();
    s.markStep('BIL', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    const out = s.markStep('BIL', 'tenant_provisioned', 'pending', 'admin', null, NOW);
    const step = out.steps.find((p) => p.step_id === 'tenant_provisioned')!;
    expect(step.status).toBe('pending');
    expect(step.completed_at).toBeNull();
    expect(step.completed_by).toBeNull();
  });

  test('re-marking overwrites prior progress', () => {
    const s = new InMemoryOnboardingStore();
    s.markStep('BIL', 'channels_configured', 'completed', 'alice', 'first pass', NOW);
    const out = s.markStep('BIL', 'channels_configured', 'completed', 'bob', 'redone', NOW);
    const step = out.steps.find((p) => p.step_id === 'channels_configured')!;
    expect(step.completed_by).toBe('bob');
    expect(step.notes).toBe('redone');
  });

  test('all 7 required completed → is_complete=true (skipped optional doesn\'t block)', () => {
    const s = new InMemoryOnboardingStore();
    const required = ONBOARDING_STEPS.filter((x) => x.required);
    for (const r of required) {
      s.markStep('BIL', r.id, 'completed', 'admin', null, NOW);
    }
    s.markStep('BIL', 'operator_invited', 'skipped', 'admin', 'later', NOW);
    const out = s.get('BIL');
    expect(out.is_complete).toBe(true);
    expect(out.completed_count).toBe(7);
    expect(out.skipped_count).toBe(1);
  });

  test('skipping a REQUIRED step keeps is_complete=false', () => {
    const s = new InMemoryOnboardingStore();
    s.markStep('BIL', 'tenant_provisioned', 'skipped', 'admin', null, NOW);
    // Complete the rest of the required:
    for (const r of ONBOARDING_STEPS.filter((x) => x.required && x.id !== 'tenant_provisioned')) {
      s.markStep('BIL', r.id, 'completed', 'admin', null, NOW);
    }
    const out = s.get('BIL');
    expect(out.is_complete).toBe(false);
  });

  test('unknown step → unknown_step error', () => {
    const s = new InMemoryOnboardingStore();
    try {
      s.markStep('BIL', 'NO-SUCH', 'completed', 'admin', null, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as OnboardingError).code).toBe('unknown_step');
    }
  });

  test('invalid status → invalid_status error', () => {
    const s = new InMemoryOnboardingStore();
    try {
      s.markStep('BIL', 'tenant_provisioned', 'done', 'admin', null, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as OnboardingError).code).toBe('invalid_status');
    }
  });

  test('missing actor rejected', () => {
    const s = new InMemoryOnboardingStore();
    expect(() =>
      s.markStep('BIL', 'tenant_provisioned', 'completed', '', null, NOW),
    ).toThrow(/actor_username/);
  });

  test('notes > 1000 chars rejected', () => {
    const s = new InMemoryOnboardingStore();
    expect(() =>
      s.markStep('BIL', 'tenant_provisioned', 'completed', 'admin', 'x'.repeat(1001), NOW),
    ).toThrow(/notes ≤ 1000/);
  });

  test('non-string notes rejected', () => {
    const s = new InMemoryOnboardingStore();
    expect(() =>
      s.markStep('BIL', 'tenant_provisioned', 'completed', 'admin', 42 as unknown, NOW),
    ).toThrow(/notes must be a string/);
  });

  test('whitespace notes treated as null', () => {
    const s = new InMemoryOnboardingStore();
    const out = s.markStep('BIL', 'tenant_provisioned', 'completed', 'admin', '   ', NOW);
    expect(out.steps.find((p) => p.step_id === 'tenant_provisioned')!.notes).toBeNull();
  });

  test('updated_at recorded', () => {
    const s = new InMemoryOnboardingStore();
    const out = s.markStep('BIL', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    expect(out.updated_at).toBe(NOW.toISOString());
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryOnboardingStore();
    s.markStep('BIL', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    s.markStep('BANK_DEMO', 'channels_configured', 'completed', 'admin', null, NOW);
    const bil = s.get('BIL');
    const bd = s.get('BANK_DEMO');
    expect(bil.steps.find((p) => p.step_id === 'tenant_provisioned')!.status).toBe('completed');
    expect(bil.steps.find((p) => p.step_id === 'channels_configured')!.status).toBe('pending');
    expect(bd.steps.find((p) => p.step_id === 'tenant_provisioned')!.status).toBe('pending');
    expect(bd.steps.find((p) => p.step_id === 'channels_configured')!.status).toBe('completed');
  });
});

// ─── Store: reset ─────────────────────────────────────────────────────

describe('InMemoryOnboardingStore.reset', () => {
  test('zeros all progress for one tenant', () => {
    const s = new InMemoryOnboardingStore();
    s.markStep('BIL', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    s.markStep('BIL', 'channels_configured', 'completed', 'admin', null, NOW);
    const out = s.reset('BIL', 'admin', NOW);
    expect(out.steps.every((p) => p.status === 'pending')).toBe(true);
    expect(out.completed_count).toBe(0);
    expect(out.updated_at).toBe(NOW.toISOString());
  });

  test('reset is per-tenant', () => {
    const s = new InMemoryOnboardingStore();
    s.markStep('BIL', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    s.markStep('BANK_DEMO', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    s.reset('BIL', 'admin', NOW);
    const bd = s.get('BANK_DEMO');
    expect(bd.steps.find((p) => p.step_id === 'tenant_provisioned')!.status).toBe('completed');
  });

  test('rejects empty actor', () => {
    const s = new InMemoryOnboardingStore();
    expect(() => s.reset('BIL', '', NOW)).toThrow(/actor_username/);
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('GET /v1/tenants/onboarding/steps', () => {
  test('admin: 200 with 8-step catalog ordered', async () => {
    const { app } = makeOnboardApp('admin');
    const r = await request(app).get('/v1/tenants/onboarding/steps').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(8);
    expect(r.body.body.items[0].id).toBe('tenant_provisioned');
    expect(r.body.body.items[7].id).toBe('operator_invited');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeOnboardApp('case_owner');
    const r = await request(app).get('/v1/tenants/onboarding/steps').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/tenants/me/onboarding', () => {
  test('analyst+: 200 with own tenant state', async () => {
    const { app } = makeOnboardApp('risk_analyst');
    const r = await request(app).get('/v1/tenants/me/onboarding').set(TH_BIL);
    expect(r.status).toBe(200);
    const body = r.body.body as OnboardingState;
    expect(body.tenant_id).toBe('BIL');
    expect(body.steps.length).toBe(8);
  });

  test('reflects current state after a markStep', async () => {
    const { app } = makeOnboardApp('admin');
    await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/tenant_provisioned')
      .set(TH_BIL)
      .send({ status: 'completed' });
    const r = await request(app).get('/v1/tenants/me/onboarding').set(TH_BIL);
    expect(r.body.body.completed_count).toBe(1);
  });
});

describe('GET /v1/tenants/:tenant_id/onboarding', () => {
  test('admin: 200 for any tenant', async () => {
    const { app } = makeOnboardApp('admin');
    const r = await request(app).get('/v1/tenants/BANK_DEMO/onboarding').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeOnboardApp('case_owner');
    const r = await request(app).get('/v1/tenants/BIL/onboarding').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/tenants/:tenant_id/onboarding/steps/:step_id', () => {
  test('admin: 200 with updated state on completed', async () => {
    const { app } = makeOnboardApp('admin');
    const r = await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/tenant_provisioned')
      .set(TH_BIL)
      .set('X-APEX-USER', 'compliance.lead')
      .send({ status: 'completed', notes: 'auto on insert' });
    expect(r.status).toBe(200);
    const step = r.body.body.steps.find(
      (s: { step_id: string }) => s.step_id === 'tenant_provisioned',
    );
    expect(step.status).toBe('completed');
    expect(step.completed_by).toBe('compliance.lead');
    expect(step.notes).toBe('auto on insert');
  });

  test('accepts enveloped body', async () => {
    const { app } = makeOnboardApp('admin');
    const r = await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/channels_configured')
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: { status: 'completed' } });
    expect(r.status).toBe(200);
  });

  test('default actor=admin when no X-APEX-USER', async () => {
    const { app } = makeOnboardApp('admin');
    const r = await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/tenant_provisioned')
      .set(TH_BIL)
      .send({ status: 'completed' });
    const step = r.body.body.steps.find(
      (s: { step_id: string }) => s.step_id === 'tenant_provisioned',
    );
    expect(step.completed_by).toBe('admin');
  });

  test('unknown step → 404 EWS_404_unknown_step', async () => {
    const { app } = makeOnboardApp('admin');
    const r = await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/NO-SUCH')
      .set(TH_BIL)
      .send({ status: 'completed' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_step');
  });

  test('invalid status → 400 EWS_400_invalid_status', async () => {
    const { app } = makeOnboardApp('admin');
    const r = await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/tenant_provisioned')
      .set(TH_BIL)
      .send({ status: 'done' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_status');
  });

  test('overlong notes → 400 EWS_400_invalid_input', async () => {
    const { app } = makeOnboardApp('admin');
    const r = await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/tenant_provisioned')
      .set(TH_BIL)
      .send({ status: 'completed', notes: 'x'.repeat(1001) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('skipped status accepted', async () => {
    const { app } = makeOnboardApp('admin');
    const r = await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/operator_invited')
      .set(TH_BIL)
      .send({ status: 'skipped', notes: 'defer' });
    expect(r.status).toBe(200);
    expect(r.body.body.skipped_count).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeOnboardApp('case_owner');
    const r = await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/tenant_provisioned')
      .set(TH_BIL)
      .send({ status: 'completed' });
    expect(r.status).toBe(403);
  });

  test('full happy path → is_complete=true after 7 required + 1 optional skipped', async () => {
    const { app } = makeOnboardApp('admin');
    const required = ONBOARDING_STEPS.filter((x) => x.required);
    for (const r of required) {
      await request(app)
        .post(`/v1/tenants/BIL/onboarding/steps/${r.id}`)
        .set(TH_BIL)
        .send({ status: 'completed' });
    }
    const r = await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/operator_invited')
      .set(TH_BIL)
      .send({ status: 'skipped', notes: 'will invite tomorrow' });
    expect(r.body.body.is_complete).toBe(true);
    expect(r.body.body.completed_count).toBe(7);
    expect(r.body.body.skipped_count).toBe(1);
  });
});

describe('POST /v1/tenants/:tenant_id/onboarding/reset', () => {
  test('admin: 200 zeros progress', async () => {
    const { app } = makeOnboardApp('admin');
    await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/tenant_provisioned')
      .set(TH_BIL)
      .send({ status: 'completed' });
    const r = await request(app).post('/v1/tenants/BIL/onboarding/reset').set(TH_BIL).send({});
    expect(r.status).toBe(200);
    expect(r.body.body.completed_count).toBe(0);
    expect(r.body.body.steps.every((s: { status: string }) => s.status === 'pending')).toBe(true);
  });

  test('reset is per-tenant', async () => {
    const { app } = makeOnboardApp('admin');
    await request(app)
      .post('/v1/tenants/BIL/onboarding/steps/tenant_provisioned')
      .set(TH_BIL)
      .send({ status: 'completed' });
    await request(app)
      .post('/v1/tenants/BANK_DEMO/onboarding/steps/tenant_provisioned')
      .set(TH_BIL)
      .send({ status: 'completed' });
    await request(app).post('/v1/tenants/BIL/onboarding/reset').set(TH_BIL).send({});
    const bd = await request(app).get('/v1/tenants/BANK_DEMO/onboarding').set(TH_BIL);
    expect(bd.body.body.completed_count).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeOnboardApp('case_owner');
    const r = await request(app).post('/v1/tenants/BIL/onboarding/reset').set(TH_BIL).send({});
    expect(r.status).toBe(403);
  });
});

// ─── No-regression ────────────────────────────────────────────────────

describe('No-regression: M2.1 + tenant routes still work', () => {
  test('GET /v1/tenants/me still 200', async () => {
    const { app } = makeOnboardApp('admin');
    const r = await request(app).get('/v1/tenants/me').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('GET /v1/tenants/me/readiness still 200', async () => {
    const { app } = makeOnboardApp('admin');
    const r = await request(app).get('/v1/tenants/me/readiness').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('GET /v1/tenants/:tenant_id/readiness still 200 (sub-paths didn\'t shadow)', async () => {
    const { app } = makeOnboardApp('admin');
    const r = await request(app).get('/v1/tenants/BIL/readiness').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
