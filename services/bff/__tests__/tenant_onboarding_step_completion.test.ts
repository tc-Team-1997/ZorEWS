// services/bff/__tests__/tenant_onboarding_step_completion.test.ts
//
// T6 M2.13 — Per-onboarding-step cross-tenant completion ranking.

import request from 'supertest';
import { summarizeOnboardingStepCompletion } from '../src/tenant_onboarding_step_completion';
import {
  InMemoryOnboardingStore,
  ONBOARDING_STEPS,
} from '../src/tenant_onboarding';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import type { Tenant } from '../src/tenant';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeScApp(role: string = 'admin') {
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

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    tenant_id: 'BIL',
    name: 'BIL test',
    vertical: 'banking',
    channels_allowed: ['API'],
    active: true,
    ...overrides,
  };
}

// ─── summarizeOnboardingStepCompletion — pure ────────────────────────

describe('M2.13 — empty tenant list', () => {
  test('zero tenants → every step row at 0', () => {
    const store = new InMemoryOnboardingStore();
    const s = summarizeOnboardingStepCompletion([], (id) => store.get(id), NOW);
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_tenants).toBe(0);
    expect(s.total_steps).toBe(ONBOARDING_STEPS.length);
    expect(s.steps).toHaveLength(ONBOARDING_STEPS.length);
    for (const row of s.steps) {
      expect(row.total_tenants).toBe(0);
      expect(row.completed_count).toBe(0);
      expect(row.skipped_count).toBe(0);
      expect(row.pending_count).toBe(0);
      expect(row.completion_rate).toBe(0);
      expect(row.pending_tenant_ids).toEqual([]);
    }
    expect(s.biggest_required_bottleneck).toBeNull();
    expect(s.steps_needing_attention).toEqual([]);
    expect(s.fully_adopted_steps).toEqual([]);
  });
});

describe('M2.13 — canonical step.order asc', () => {
  test('steps[] in step.order ascending', () => {
    const s = summarizeOnboardingStepCompletion([], (_id) => new InMemoryOnboardingStore().get(_id), NOW);
    const orders = s.steps.map((r) => r.order);
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]).toBeGreaterThan(orders[i - 1]!);
    }
  });
});

describe('M2.13 — single tenant untouched', () => {
  test('1 tenant with no marks → every step pending_count=1', () => {
    const store = new InMemoryOnboardingStore();
    const t = tenant();
    const s = summarizeOnboardingStepCompletion([t], (id) => store.get(id), NOW);
    expect(s.total_tenants).toBe(1);
    for (const row of s.steps) {
      expect(row.completed_count).toBe(0);
      expect(row.pending_count).toBe(1);
      expect(row.skipped_count).toBe(0);
      expect(row.completion_rate).toBe(0);
      expect(row.pending_tenant_ids).toEqual(['BIL']);
    }
  });
});

describe('M2.13 — tenant with completed step', () => {
  test('completed step shows completed_count=1 + pending_count=0', () => {
    const store = new InMemoryOnboardingStore();
    const t = tenant();
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    const s = summarizeOnboardingStepCompletion([t], (id) => store.get(id), NOW);
    const provisioned = s.steps.find((r) => r.step_id === 'tenant_provisioned')!;
    expect(provisioned.completed_count).toBe(1);
    expect(provisioned.pending_count).toBe(0);
    expect(provisioned.completion_rate).toBe(1.0);
    expect(provisioned.pending_tenant_ids).toEqual([]);

    const channels = s.steps.find((r) => r.step_id === 'channels_configured')!;
    expect(channels.completed_count).toBe(0);
    expect(channels.pending_count).toBe(1);
  });
});

describe('M2.13 — completion_rate', () => {
  test('= completed / total_tenants', () => {
    const store = new InMemoryOnboardingStore();
    const a = tenant({ tenant_id: 'TA' });
    const b = tenant({ tenant_id: 'TB' });
    const c = tenant({ tenant_id: 'TC' });
    const d = tenant({ tenant_id: 'TD' });
    // 2 of 4 tenants complete tenant_provisioned
    store.markStep('TA', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    store.markStep('TB', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    const s = summarizeOnboardingStepCompletion([a, b, c, d], (id) => store.get(id), NOW);
    const row = s.steps.find((r) => r.step_id === 'tenant_provisioned')!;
    expect(row.completion_rate).toBe(0.5);
    expect(row.completed_count).toBe(2);
    expect(row.pending_count).toBe(2);
  });
});

describe('M2.13 — skipped counted separately from pending', () => {
  test('skipped status increments skipped_count, not pending', () => {
    const store = new InMemoryOnboardingStore();
    const t = tenant();
    store.markStep('BIL', 'operator_invited', 'skipped', 'admin', null, NOW);
    const s = summarizeOnboardingStepCompletion([t], (id) => store.get(id), NOW);
    const row = s.steps.find((r) => r.step_id === 'operator_invited')!;
    expect(row.skipped_count).toBe(1);
    expect(row.pending_count).toBe(0);
    expect(row.completed_count).toBe(0);
  });
});

describe('M2.13 — pending_tenant_ids', () => {
  test('lists tenant_ids whose step is pending, sorted asc', () => {
    const store = new InMemoryOnboardingStore();
    const a = tenant({ tenant_id: 'ZEBRA' });
    const b = tenant({ tenant_id: 'ALPHA' });
    const c = tenant({ tenant_id: 'MIKE' });
    // ZEBRA completes; others pending
    store.markStep('ZEBRA', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    const s = summarizeOnboardingStepCompletion([a, b, c], (id) => store.get(id), NOW);
    const row = s.steps.find((r) => r.step_id === 'tenant_provisioned')!;
    expect(row.pending_tenant_ids).toEqual(['ALPHA', 'MIKE']);
  });
});

describe('M2.13 — biggest_required_bottleneck', () => {
  test('points at required step with highest pending_count', () => {
    const store = new InMemoryOnboardingStore();
    const tenants = ['T1', 'T2', 'T3', 'T4'].map((id) => tenant({ tenant_id: id }));
    // T1, T2 complete tenant_provisioned + channels_configured
    // T3, T4 complete only tenant_provisioned
    for (const t of ['T1', 'T2']) {
      store.markStep(t, 'tenant_provisioned', 'completed', 'admin', null, NOW);
      store.markStep(t, 'channels_configured', 'completed', 'admin', null, NOW);
    }
    for (const t of ['T3', 'T4']) {
      store.markStep(t, 'tenant_provisioned', 'completed', 'admin', null, NOW);
    }
    const s = summarizeOnboardingStepCompletion(tenants, (id) => store.get(id), NOW);
    // channels_configured has 2 pending; tenant_provisioned has 0;
    // all other required steps have 4 pending
    expect(s.biggest_required_bottleneck).not.toBeNull();
    expect(s.biggest_required_bottleneck!.pending_count).toBe(4);
  });

  test('null when no required steps have pending', () => {
    const store = new InMemoryOnboardingStore();
    const t = tenant();
    // Complete every required step
    for (const step of ONBOARDING_STEPS) {
      if (step.required) {
        store.markStep('BIL', step.id, 'completed', 'admin', null, NOW);
      }
    }
    const s = summarizeOnboardingStepCompletion([t], (id) => store.get(id), NOW);
    expect(s.biggest_required_bottleneck).toBeNull();
  });

  test('only considers required steps (optional skipped)', () => {
    const store = new InMemoryOnboardingStore();
    const t = tenant();
    // Only operator_invited is optional; leave it pending
    // and complete every required step
    for (const step of ONBOARDING_STEPS) {
      if (step.required) {
        store.markStep('BIL', step.id, 'completed', 'admin', null, NOW);
      }
    }
    const s = summarizeOnboardingStepCompletion([t], (id) => store.get(id), NOW);
    // operator_invited has pending_count=1 BUT it's optional → no bottleneck
    expect(s.biggest_required_bottleneck).toBeNull();
  });
});

describe('M2.13 — steps_needing_attention', () => {
  test('lists steps with completion_rate < 0.5; sorted asc', () => {
    const store = new InMemoryOnboardingStore();
    const tenants = ['T1', 'T2', 'T3', 'T4'].map((id) => tenant({ tenant_id: id }));
    // T1, T2 complete tenant_provisioned (50% — NOT in attention list since strict <)
    // T1 completes channels_configured (25% — IN attention list)
    store.markStep('T1', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    store.markStep('T2', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    store.markStep('T1', 'channels_configured', 'completed', 'admin', null, NOW);
    const s = summarizeOnboardingStepCompletion(tenants, (id) => store.get(id), NOW);
    const attention_ids = s.steps_needing_attention.map((r) => r.step_id);
    expect(attention_ids).toContain('channels_configured'); // 0.25 < 0.5
    expect(attention_ids).not.toContain('tenant_provisioned'); // 0.5 NOT < 0.5 strict
    // All other steps at 0/4=0 are also < 0.5
    expect(s.steps_needing_attention[0]!.completion_rate).toBeLessThanOrEqual(
      s.steps_needing_attention[s.steps_needing_attention.length - 1]!.completion_rate,
    );
  });

  test('empty when total_tenants=0', () => {
    const store = new InMemoryOnboardingStore();
    const s = summarizeOnboardingStepCompletion([], (id) => store.get(id), NOW);
    expect(s.steps_needing_attention).toEqual([]);
  });
});

describe('M2.13 — fully_adopted_steps', () => {
  test('completion_rate=1.0 steps in canonical order', () => {
    const store = new InMemoryOnboardingStore();
    const t = tenant();
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    const s = summarizeOnboardingStepCompletion([t], (id) => store.get(id), NOW);
    const ids = s.fully_adopted_steps.map((r) => r.step_id);
    expect(ids).toEqual(['tenant_provisioned']);
  });

  test('empty when total_tenants=0', () => {
    const store = new InMemoryOnboardingStore();
    const s = summarizeOnboardingStepCompletion([], (id) => store.get(id), NOW);
    expect(s.fully_adopted_steps).toEqual([]);
  });
});

describe('M2.13 — partition invariant', () => {
  test('completed + skipped + pending = total_tenants per row', () => {
    const store = new InMemoryOnboardingStore();
    const tenants = ['A', 'B', 'C', 'D', 'E'].map((id) => tenant({ tenant_id: id }));
    store.markStep('A', 'operator_invited', 'completed', 'admin', null, NOW);
    store.markStep('B', 'operator_invited', 'skipped', 'admin', null, NOW);
    // C, D, E remain pending
    const s = summarizeOnboardingStepCompletion(tenants, (id) => store.get(id), NOW);
    for (const row of s.steps) {
      expect(row.completed_count + row.skipped_count + row.pending_count).toBe(row.total_tenants);
      expect(row.total_tenants).toBe(5);
    }
    const op = s.steps.find((r) => r.step_id === 'operator_invited')!;
    expect(op.completed_count).toBe(1);
    expect(op.skipped_count).toBe(1);
    expect(op.pending_count).toBe(3);
  });
});

describe('M2.13 — total_steps matches catalog', () => {
  test('every ONBOARDING_STEPS entry surfaces once', () => {
    const store = new InMemoryOnboardingStore();
    const s = summarizeOnboardingStepCompletion([], (id) => store.get(id), NOW);
    expect(s.total_steps).toBe(ONBOARDING_STEPS.length);
    const ids = new Set(s.steps.map((r) => r.step_id));
    for (const step of ONBOARDING_STEPS) {
      expect(ids.has(step.id)).toBe(true);
    }
  });
});

// ─── GET /v1/tenants/onboarding/step-completion ──────────────────────

describe('M2.13 — GET /v1/tenants/onboarding/step-completion', () => {
  test('admin → 200 with default tenant registry (BANK_DEMO + BIL = 2 untouched tenants)', async () => {
    const { app } = makeScApp('admin');
    const r = await request(app).get('/v1/tenants/onboarding/step-completion').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_tenants).toBeGreaterThanOrEqual(2);
    expect(r.body.body.total_steps).toBe(ONBOARDING_STEPS.length);
    // Every step row is pending for both BANK_DEMO + BIL since untouched.
    for (const row of r.body.body.steps) {
      expect(row.completed_count).toBe(0);
    }
  });

  test('populated rollup after a markStep', async () => {
    const { app, store } = makeScApp('admin');
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    const r = await request(app).get('/v1/tenants/onboarding/step-completion').set(TH_BIL);
    expect(r.status).toBe(200);
    const provisioned = r.body.body.steps.find((s: { step_id: string }) => s.step_id === 'tenant_provisioned');
    expect(provisioned.completed_count).toBe(1);
    expect(provisioned.pending_count).toBe(r.body.body.total_tenants - 1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeScApp('case_owner');
    const r = await request(app).get('/v1/tenants/onboarding/step-completion').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('literal `/step-completion` not captured as :tenant_id wildcard', async () => {
    const { app } = makeScApp('admin');
    // If shadowed by /:tenant_id, would attempt a tenant lookup.
    const r = await request(app).get('/v1/tenants/onboarding/step-completion').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_steps).toBe(ONBOARDING_STEPS.length);
  });

  test('M2.12 /v1/tenants/onboarding/fleet still 200 (sibling regression)', async () => {
    const { app } = makeScApp('admin');
    const r = await request(app).get('/v1/tenants/onboarding/fleet').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
