// services/bff/__tests__/tenant_onboarding_skip_reason_analytics.test.ts
//
// T6 M2.18 — pure resolver + HTTP route tests for cross-tenant
// onboarding skip-reason analytics.

import { summarizeOnboardingSkipReasons } from '../src/tenant_onboarding_skip_reason_analytics';
import {
  InMemoryOnboardingStore,
  ONBOARDING_STEPS,
  type OnboardingStepId,
} from '../src/tenant_onboarding';
import type { Tenant } from '../src/tenant';

const NOW = new Date('2026-05-22T12:00:00.000Z');

const TENANT_A: Tenant = {
  tenant_id: 'TENANT_A',
  name: 'Tenant A',
  vertical: 'banking',
  channels_allowed: ['API'],
  active: true,
};
const TENANT_B: Tenant = {
  tenant_id: 'TENANT_B',
  name: 'Tenant B',
  vertical: 'insurance',
  channels_allowed: ['API'],
  active: true,
};
const TENANT_C: Tenant = {
  tenant_id: 'TENANT_C',
  name: 'Tenant C',
  vertical: 'banking',
  channels_allowed: ['API'],
  active: true,
};

// Pull the first 3 step ids for fixture work
const STEPS_BY_ORDER = [...ONBOARDING_STEPS].sort((a, b) => a.order - b.order);
const STEP_1 = STEPS_BY_ORDER[0].id;
const STEP_2 = STEPS_BY_ORDER[1].id;
const STEP_3 = STEPS_BY_ORDER[2].id;

describe('summarizeOnboardingSkipReasons — pure resolver', () => {
  test('empty tenant list → every step row at 0 + null leaderboards', () => {
    const store = new InMemoryOnboardingStore();
    const r = summarizeOnboardingSkipReasons(
      [],
      (id) => store.get(id),
      NOW,
    );
    expect(r.generated_at).toBe('2026-05-22T12:00:00.000Z');
    expect(r.total_tenants_scanned).toBe(0);
    expect(r.total_skips_observed).toBe(0);
    expect(r.total_steps_with_skips).toBe(0);
    expect(r.most_skipped_step).toBeNull();
    expect(r.most_skipped_required_step).toBeNull();
    expect(r.total_legacy_skips).toBe(0);
    expect(r.total_with_reason_skips).toBe(0);
    // Every step present in canonical order at 0
    expect(r.steps).toHaveLength(ONBOARDING_STEPS.length);
    for (const row of r.steps) {
      expect(row.total_skips).toBe(0);
      expect(row.total_with_reason).toBe(0);
      expect(row.total_legacy).toBe(0);
      expect(row.distinct_actors).toBe(0);
      expect(row.distinct_tenants).toBe(0);
      expect(row.sample_skips).toEqual([]);
    }
  });

  test('steps emitted in canonical step.order asc', () => {
    const store = new InMemoryOnboardingStore();
    const r = summarizeOnboardingSkipReasons([], (id) => store.get(id), NOW);
    const orders = r.steps.map((s) => s.order);
    const sorted = [...orders].sort((a, b) => a - b);
    expect(orders).toEqual(sorted);
  });

  test('untouched tenant contributes 0 skips', () => {
    const store = new InMemoryOnboardingStore();
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A],
      (id) => store.get(id),
      NOW,
    );
    expect(r.total_tenants_scanned).toBe(1);
    expect(r.total_skips_observed).toBe(0);
  });

  test('M2.5 skip with reason → total_with_reason + skip_reason in sample', () => {
    const store = new InMemoryOnboardingStore();
    store.skipStepWithReason(
      TENANT_A.tenant_id,
      STEP_1,
      'alice.admin',
      'Customer chose to defer this step',
      NOW,
    );
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A],
      (id) => store.get(id),
      NOW,
    );
    expect(r.total_skips_observed).toBe(1);
    expect(r.total_with_reason_skips).toBe(1);
    expect(r.total_legacy_skips).toBe(0);
    const row = r.steps.find((s) => s.step_id === STEP_1)!;
    expect(row.total_skips).toBe(1);
    expect(row.total_with_reason).toBe(1);
    expect(row.total_legacy).toBe(0);
    expect(row.distinct_actors).toBe(1);
    expect(row.distinct_tenants).toBe(1);
    expect(row.sample_skips).toHaveLength(1);
    expect(row.sample_skips[0].tenant_id).toBe(TENANT_A.tenant_id);
    expect(row.sample_skips[0].actor).toBe('alice.admin');
    expect(row.sample_skips[0].reason).toBe('Customer chose to defer this step');
  });

  test('legacy markStep skipped path → total_legacy (skip_reason=null)', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep(TENANT_A.tenant_id, STEP_2, 'skipped', 'bob.maker', null, NOW);
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A],
      (id) => store.get(id),
      NOW,
    );
    expect(r.total_skips_observed).toBe(1);
    expect(r.total_with_reason_skips).toBe(0);
    expect(r.total_legacy_skips).toBe(1);
    const row = r.steps.find((s) => s.step_id === STEP_2)!;
    expect(row.total_skips).toBe(1);
    expect(row.total_with_reason).toBe(0);
    expect(row.total_legacy).toBe(1);
    expect(row.sample_skips[0].reason).toBeNull();
  });

  test('mixed M2.5 + legacy across same step → both counters bumped', () => {
    const store = new InMemoryOnboardingStore();
    store.skipStepWithReason(
      TENANT_A.tenant_id,
      STEP_1,
      'alice.admin',
      'M2.5 reason',
      NOW,
    );
    store.markStep(TENANT_B.tenant_id, STEP_1, 'skipped', 'bob.maker', null, NOW);
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A, TENANT_B],
      (id) => store.get(id),
      NOW,
    );
    expect(r.total_skips_observed).toBe(2);
    expect(r.total_with_reason_skips).toBe(1);
    expect(r.total_legacy_skips).toBe(1);
    const row = r.steps.find((s) => s.step_id === STEP_1)!;
    expect(row.total_skips).toBe(2);
    expect(row.total_with_reason).toBe(1);
    expect(row.total_legacy).toBe(1);
    expect(row.distinct_tenants).toBe(2);
    expect(row.distinct_actors).toBe(2);
  });

  test('completed status not counted as skip', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep(TENANT_A.tenant_id, STEP_1, 'completed', 'alice.admin', null, NOW);
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A],
      (id) => store.get(id),
      NOW,
    );
    expect(r.total_skips_observed).toBe(0);
  });

  test('pending status not counted as skip', () => {
    const store = new InMemoryOnboardingStore();
    // Default state has all steps pending — should produce 0 skips
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A],
      (id) => store.get(id),
      NOW,
    );
    expect(r.total_skips_observed).toBe(0);
  });

  test('distinct_actors deduplicated within step (alice ×2 + bob ×1 → 2)', () => {
    const store = new InMemoryOnboardingStore();
    store.skipStepWithReason(
      TENANT_A.tenant_id,
      STEP_1,
      'alice.admin',
      'reason 1',
      NOW,
    );
    store.skipStepWithReason(
      TENANT_B.tenant_id,
      STEP_1,
      'alice.admin',
      'reason 2',
      NOW,
    );
    store.skipStepWithReason(
      TENANT_C.tenant_id,
      STEP_1,
      'bob.maker',
      'reason 3',
      NOW,
    );
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A, TENANT_B, TENANT_C],
      (id) => store.get(id),
      NOW,
    );
    const row = r.steps.find((s) => s.step_id === STEP_1)!;
    expect(row.distinct_actors).toBe(2);
    expect(row.distinct_tenants).toBe(3);
  });

  test('sample_skips cap 5 — completed_at always null for skipped so order falls through to tenant_id asc', () => {
    const store = new InMemoryOnboardingStore();
    // 7 tenants skip STEP_1. Even with distinct call timestamps,
    // skipped status sets completed_at=null per InMemoryOnboardingStore
    // contract — so the resolver's primary sort key (completed_at desc)
    // ties uniformly and the tenant_id asc tie-break dominates.
    const tenants: Tenant[] = [];
    for (let i = 0; i < 7; i++) {
      const t: Tenant = {
        ...TENANT_A,
        tenant_id: `T-${String(i).padStart(2, '0')}`,
      };
      tenants.push(t);
      const ts = new Date(NOW.getTime() + i * 60 * 60 * 1000);
      store.skipStepWithReason(t.tenant_id, STEP_1, 'actor', `reason ${i}`, ts);
    }
    const r = summarizeOnboardingSkipReasons(
      tenants,
      (id) => store.get(id),
      NOW,
    );
    const row = r.steps.find((s) => s.step_id === STEP_1)!;
    expect(row.total_skips).toBe(7);
    expect(row.sample_skips).toHaveLength(5);
    // tenant_id asc → T-00 through T-04
    expect(row.sample_skips.map((s) => s.tenant_id)).toEqual([
      'T-00',
      'T-01',
      'T-02',
      'T-03',
      'T-04',
    ]);
  });

  test('sample_skips tenant_id asc tie-break when completed_at equal', () => {
    const store = new InMemoryOnboardingStore();
    const tenants = ['T-zeta', 'T-alpha', 'T-mango'].map((id) => ({
      ...TENANT_A,
      tenant_id: id,
    }));
    for (const t of tenants) {
      store.skipStepWithReason(t.tenant_id, STEP_1, 'actor', 'compliance', NOW);
    }
    const r = summarizeOnboardingSkipReasons(
      tenants,
      (id) => store.get(id),
      NOW,
    );
    const row = r.steps.find((s) => s.step_id === STEP_1)!;
    expect(row.sample_skips.map((s) => s.tenant_id)).toEqual([
      'T-alpha',
      'T-mango',
      'T-zeta',
    ]);
  });

  test('most_skipped_step canonical step.order tie-break (earliest wins)', () => {
    const store = new InMemoryOnboardingStore();
    // STEP_1 (order 1) and STEP_2 (order 2) both at 1 skip → STEP_1 wins
    store.skipStepWithReason(TENANT_A.tenant_id, STEP_1, 'actor', 'compliance', NOW);
    store.skipStepWithReason(TENANT_B.tenant_id, STEP_2, 'actor', 'compliance', NOW);
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A, TENANT_B],
      (id) => store.get(id),
      NOW,
    );
    expect(r.most_skipped_step).toBe(STEP_1);
  });

  test('most_skipped_step highest-count wins regardless of order', () => {
    const store = new InMemoryOnboardingStore();
    // STEP_2 at 2, STEP_1 at 1 → STEP_2 wins despite higher order
    store.skipStepWithReason(TENANT_A.tenant_id, STEP_1, 'actor', 'compliance', NOW);
    store.skipStepWithReason(TENANT_A.tenant_id, STEP_2, 'actor', 'compliance', NOW);
    store.skipStepWithReason(TENANT_B.tenant_id, STEP_2, 'actor', 'compliance', NOW);
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A, TENANT_B],
      (id) => store.get(id),
      NOW,
    );
    expect(r.most_skipped_step).toBe(STEP_2);
  });

  test('most_skipped_step null when nothing skipped', () => {
    const store = new InMemoryOnboardingStore();
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A],
      (id) => store.get(id),
      NOW,
    );
    expect(r.most_skipped_step).toBeNull();
  });

  test('most_skipped_required_step filters to required steps only', () => {
    // Find the first required step + an optional step (or another required)
    const required = ONBOARDING_STEPS.find((s) => s.required)!;
    const optional = ONBOARDING_STEPS.find((s) => !s.required);
    const store = new InMemoryOnboardingStore();
    // Skip 1 required step
    store.skipStepWithReason(TENANT_A.tenant_id, required.id, 'actor', 'compliance', NOW);
    if (optional) {
      // Skip optional 2× — would normally win most_skipped_step but NOT
      // most_skipped_required_step
      store.skipStepWithReason(TENANT_A.tenant_id, optional.id, 'actor', 'compliance', NOW);
      store.skipStepWithReason(TENANT_B.tenant_id, optional.id, 'actor', 'compliance', NOW);
    }
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A, TENANT_B],
      (id) => store.get(id),
      NOW,
    );
    expect(r.most_skipped_required_step).toBe(required.id);
    // most_skipped_step is the optional one (2 > 1) when optional exists,
    // else the required one
    if (optional) {
      expect(r.most_skipped_step).toBe(optional.id);
    } else {
      expect(r.most_skipped_step).toBe(required.id);
    }
  });

  test('most_skipped_required_step null when only optional skipped', () => {
    const optional = ONBOARDING_STEPS.find((s) => !s.required);
    if (!optional) {
      // If catalog has no optional, can't test the null path — skip
      expect(true).toBe(true);
      return;
    }
    const store = new InMemoryOnboardingStore();
    store.skipStepWithReason(TENANT_A.tenant_id, optional.id, 'actor', 'compliance', NOW);
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A],
      (id) => store.get(id),
      NOW,
    );
    expect(r.most_skipped_required_step).toBeNull();
    // But most_skipped_step still surfaces the optional
    expect(r.most_skipped_step).toBe(optional.id);
  });

  test('partition invariant: total_with_reason + total_legacy = total_skips_observed', () => {
    const store = new InMemoryOnboardingStore();
    store.skipStepWithReason(TENANT_A.tenant_id, STEP_1, 'actor', 'compliance', NOW);
    store.skipStepWithReason(TENANT_B.tenant_id, STEP_2, 'bob', 'reason2', NOW);
    store.markStep(TENANT_C.tenant_id, STEP_3, 'skipped', 'carol', null, NOW);
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A, TENANT_B, TENANT_C],
      (id) => store.get(id),
      NOW,
    );
    expect(r.total_with_reason_skips + r.total_legacy_skips).toBe(
      r.total_skips_observed,
    );
    expect(r.total_skips_observed).toBe(3);
    expect(r.total_with_reason_skips).toBe(2);
    expect(r.total_legacy_skips).toBe(1);
  });

  test('per-row partition: total_with_reason + total_legacy = total_skips', () => {
    const store = new InMemoryOnboardingStore();
    store.skipStepWithReason(TENANT_A.tenant_id, STEP_1, 'actor', 'compliance', NOW);
    store.markStep(TENANT_B.tenant_id, STEP_1, 'skipped', 'bob', null, NOW);
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A, TENANT_B],
      (id) => store.get(id),
      NOW,
    );
    const row = r.steps.find((s) => s.step_id === STEP_1)!;
    expect(row.total_with_reason + row.total_legacy).toBe(row.total_skips);
  });

  test('total_steps_with_skips counts rows where total_skips > 0', () => {
    const store = new InMemoryOnboardingStore();
    store.skipStepWithReason(TENANT_A.tenant_id, STEP_1, 'actor', 'compliance', NOW);
    store.skipStepWithReason(TENANT_A.tenant_id, STEP_2, 'actor', 'compliance', NOW);
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A],
      (id) => store.get(id),
      NOW,
    );
    expect(r.total_steps_with_skips).toBe(2);
  });

  test('Σ row.total_skips per step = total_skips_observed', () => {
    const store = new InMemoryOnboardingStore();
    store.skipStepWithReason(TENANT_A.tenant_id, STEP_1, 'actor', 'compliance', NOW);
    store.skipStepWithReason(TENANT_B.tenant_id, STEP_2, 'actor', 'compliance', NOW);
    store.skipStepWithReason(TENANT_C.tenant_id, STEP_3, 'actor', 'compliance', NOW);
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A, TENANT_B, TENANT_C],
      (id) => store.get(id),
      NOW,
    );
    const sum = r.steps.reduce((acc, row) => acc + row.total_skips, 0);
    expect(sum).toBe(r.total_skips_observed);
  });

  test('sample_skips carries actor + reason + completed_at', () => {
    const store = new InMemoryOnboardingStore();
    store.skipStepWithReason(
      TENANT_A.tenant_id,
      STEP_1,
      'alice.admin',
      'compliance defer',
      NOW,
    );
    const r = summarizeOnboardingSkipReasons(
      [TENANT_A],
      (id) => store.get(id),
      NOW,
    );
    const row = r.steps.find((s) => s.step_id === STEP_1)!;
    const sample = row.sample_skips[0];
    expect(sample.tenant_id).toBe(TENANT_A.tenant_id);
    expect(sample.actor).toBe('alice.admin');
    expect(sample.reason).toBe('compliance defer');
    // For skipped status, the underlying store stores completed_at=null
    // (only 'completed' status sets it). Documented in the resolver doc.
    expect(sample.completed_at).toBeNull();
  });

  test('step metadata correctly populated (name, order, required)', () => {
    const store = new InMemoryOnboardingStore();
    const r = summarizeOnboardingSkipReasons([], (id) => store.get(id), NOW);
    for (const row of r.steps) {
      const def = ONBOARDING_STEPS.find((s) => s.id === row.step_id)!;
      expect(row.name).toBe(def.name);
      expect(row.order).toBe(def.order);
      expect(row.required).toBe(def.required);
    }
  });
});

// ---------------------------------------------------------------------
// HTTP route tests
// ---------------------------------------------------------------------

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('GET /v1/tenants/onboarding/skip-reason-analytics', () => {
  test('admin happy path returns envelope + every step row at 0', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/tenants/onboarding/skip-reason-analytics')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.steps).toHaveLength(ONBOARDING_STEPS.length);
    expect(r.body.body.most_skipped_step).toBeNull();
    expect(r.body.body.total_with_reason_skips).toBe(0);
    expect(r.body.body.total_legacy_skips).toBe(0);
  });

  test('403 when role lacks audit:read', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/tenants/onboarding/skip-reason-analytics')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/tenants/onboarding/skip-reason-analytics')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });

  test('501 when tenantLookup lacks all()', async () => {
    // Supply a callable tenantLookup without the all() method.
    const tenantLookup = ((tenant_id: string) =>
      ({
        tenant_id,
        name: tenant_id,
        vertical: 'banking' as const,
        channels_allowed: ['API'],
        active: true,
      })) as never; // never to match the union TenantLookup type
    const { app } = makeApp({ tenantLookup });
    const r = await request(app)
      .get('/v1/tenants/onboarding/skip-reason-analytics')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(501);
    expect(r.body.error.code).toBe('EWS_501_not_implemented');
  });

  test('route mounted BEFORE /v1/tenants/:tenant_id catch-all', async () => {
    // If /:tenant_id were mounted first, the literal segment would be
    // captured as a tenant_id lookup → 404 (or success with the
    // tenant payload, depending on the catch-all). Since our route is
    // mounted first + matches, we get a 200 envelope with the
    // analytics body.
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/tenants/onboarding/skip-reason-analytics')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    // Confirm it's the analytics body (steps[] present, not a Tenant
    // shape with vertical/active)
    expect(r.body.body.steps).toBeDefined();
    expect(r.body.body.vertical).toBeUndefined();
  });
});
