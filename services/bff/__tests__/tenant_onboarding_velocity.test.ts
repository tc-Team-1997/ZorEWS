// services/bff/__tests__/tenant_onboarding_velocity.test.ts
//
// T6 M2.19 — Tenant onboarding velocity rollup.

import request from 'supertest';
import {
  ALL_ONBOARDING_VELOCITY_BUCKETS,
  SAMPLE_TENANTS_CAP,
  bucketForVelocity,
  summarizeOnboardingVelocity,
} from '../src/tenant_onboarding_velocity';
import {
  InMemoryOnboardingStore,
  ONBOARDING_STEPS,
  type OnboardingState,
} from '../src/tenant_onboarding';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import type { Tenant, TenantLookup } from '../src/tenant';

const NOW = new Date('2026-05-23T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── helpers ────────────────────────────────────────────────────────

function mkTenant(tenant_id: string, name = `Tenant ${tenant_id}`): Tenant {
  return {
    tenant_id,
    name,
    vertical: 'banking',
    channels_allowed: ['API'],
    active: true,
  };
}

/** Build an OnboardingState where required steps were completed at the
 *  given offsets (days before NOW). 0 = right now; 10 = 10 days ago. */
function mkCompleteState(
  tenant_id: string,
  offsets: number[],
): OnboardingState {
  const store = new InMemoryOnboardingStore();
  const requiredIds = ONBOARDING_STEPS.filter((s) => s.required).map((s) => s.id);
  if (offsets.length !== requiredIds.length) {
    throw new Error(
      `mkCompleteState: need ${requiredIds.length} offsets, got ${offsets.length}`,
    );
  }
  for (let i = 0; i < requiredIds.length; i++) {
    const ts = new Date(NOW.getTime() - offsets[i]! * DAY_MS);
    store.markStep(tenant_id, requiredIds[i]!, 'completed', 'admin', null, ts);
  }
  return store.get(tenant_id);
}

/** State with some required steps completed but not all (in progress). */
function mkPartialState(
  tenant_id: string,
  completedCount: number,
  firstOffset: number,
): OnboardingState {
  const store = new InMemoryOnboardingStore();
  const requiredIds = ONBOARDING_STEPS.filter((s) => s.required).map((s) => s.id);
  for (let i = 0; i < completedCount; i++) {
    // Spread evenly between firstOffset and 0 days ago
    const offset = firstOffset - (i * firstOffset) / Math.max(1, completedCount - 1);
    const ts = new Date(NOW.getTime() - offset * DAY_MS);
    store.markStep(tenant_id, requiredIds[i]!, 'completed', 'admin', null, ts);
  }
  return store.get(tenant_id);
}

/** A fresh tenant — never-touched state. */
function mkNeverStartedState(tenant_id: string): OnboardingState {
  return new InMemoryOnboardingStore().get(tenant_id);
}

// ─── enum + helper invariants ───────────────────────────────────────

describe('M2.19 — canonical enum + helper', () => {
  test('ALL_ONBOARDING_VELOCITY_BUCKETS has 5 canonical values', () => {
    expect([...ALL_ONBOARDING_VELOCITY_BUCKETS]).toEqual([
      'fast',
      'normal',
      'slow',
      'stalled',
      'not_started',
    ]);
  });

  test('SAMPLE_TENANTS_CAP is 3', () => {
    expect(SAMPLE_TENANTS_CAP).toBe(3);
  });

  test('bucketForVelocity completed mapping', () => {
    expect(bucketForVelocity(0, true)).toBe('fast');
    expect(bucketForVelocity(5, true)).toBe('fast');
    expect(bucketForVelocity(7, true)).toBe('normal'); // strict-<
    expect(bucketForVelocity(15, true)).toBe('normal');
    expect(bucketForVelocity(30, true)).toBe('slow'); // strict-<
    expect(bucketForVelocity(60, true)).toBe('slow');
    expect(bucketForVelocity(90, true)).toBe('stalled'); // strict-<
    expect(bucketForVelocity(200, true)).toBe('stalled');
  });

  test('bucketForVelocity in-progress mapping', () => {
    // <90d in-progress → not_started bucket (no completion-speed yet)
    expect(bucketForVelocity(5, false)).toBe('not_started');
    expect(bucketForVelocity(60, false)).toBe('not_started');
    // ≥90d in-progress → stalled
    expect(bucketForVelocity(90, false)).toBe('stalled');
    expect(bucketForVelocity(200, false)).toBe('stalled');
  });

  test('bucketForVelocity null days → not_started', () => {
    expect(bucketForVelocity(null, true)).toBe('not_started');
    expect(bucketForVelocity(null, false)).toBe('not_started');
  });
});

// ─── empty fleet ────────────────────────────────────────────────────

describe('M2.19 — empty fleet', () => {
  test('no tenants → 5 zero buckets + null leaderboards', () => {
    const r = summarizeOnboardingVelocity([], NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(r.total_tenants).toBe(0);
    expect(r.total_complete).toBe(0);
    expect(r.total_in_progress).toBe(0);
    expect(r.total_not_started).toBe(0);
    expect(r.tenants).toEqual([]);
    expect(r.peak_bucket).toBeNull();
    expect(r.peak_count).toBe(0);
    expect(r.mean_completion_days).toBeNull();
    expect(r.min_completion_days).toBeNull();
    expect(r.max_completion_days).toBeNull();
    expect(r.fastest_tenant).toBeNull();
    expect(r.slowest_tenant).toBeNull();
    expect(r.most_stalled_tenant).toBeNull();
    for (const row of r.buckets) {
      expect(row.count).toBe(0);
      expect(row.sample_tenant_ids).toEqual([]);
    }
  });
});

// ─── bucket placement ──────────────────────────────────────────────

describe('M2.19 — bucket placement', () => {
  test('completed tenant in 5 days → fast bucket', () => {
    // First step 5d ago, all 7 required steps spread 5→0d, last today
    const r = summarizeOnboardingVelocity(
      [{ tenant: mkTenant('T1'), state: mkCompleteState('T1', [5, 4, 3, 2, 1, 1, 0]) }],
      NOW,
    );
    expect(r.total_complete).toBe(1);
    const t = r.tenants[0]!;
    expect(t.is_complete).toBe(true);
    expect(t.duration_days).toBe(5);
    expect(t.velocity_bucket).toBe('fast');
    expect(r.peak_bucket).toBe('fast');
  });

  test('completed tenant in 15 days → normal bucket', () => {
    const r = summarizeOnboardingVelocity(
      [{ tenant: mkTenant('T2'), state: mkCompleteState('T2', [15, 13, 10, 8, 5, 3, 0]) }],
      NOW,
    );
    const t = r.tenants[0]!;
    expect(t.duration_days).toBe(15);
    expect(t.velocity_bucket).toBe('normal');
  });

  test('completed tenant in 60 days → slow bucket', () => {
    const r = summarizeOnboardingVelocity(
      [{ tenant: mkTenant('T3'), state: mkCompleteState('T3', [60, 50, 40, 30, 20, 10, 0]) }],
      NOW,
    );
    const t = r.tenants[0]!;
    expect(t.duration_days).toBe(60);
    expect(t.velocity_bucket).toBe('slow');
  });

  test('completed tenant in 200 days → stalled bucket', () => {
    const r = summarizeOnboardingVelocity(
      [{ tenant: mkTenant('T4'), state: mkCompleteState('T4', [200, 180, 150, 100, 50, 20, 0]) }],
      NOW,
    );
    const t = r.tenants[0]!;
    expect(t.duration_days).toBe(200);
    expect(t.velocity_bucket).toBe('stalled');
  });

  test('in-progress < 90d → not_started bucket (in-progress with activity)', () => {
    const r = summarizeOnboardingVelocity(
      [{ tenant: mkTenant('T5'), state: mkPartialState('T5', 3, 20) }],
      NOW,
    );
    const t = r.tenants[0]!;
    expect(t.is_complete).toBe(false);
    expect(t.velocity_bucket).toBe('not_started');
    expect(r.total_complete).toBe(0);
    // T5 has activity but is < 90d → counted as "not_started" velocity-bucket
    // even though it has timestamps. M2.19 uses 'not_started' to mean
    // "no completion-speed determined yet".
  });

  test('in-progress ≥ 90d → stalled bucket', () => {
    const r = summarizeOnboardingVelocity(
      [{ tenant: mkTenant('T6'), state: mkPartialState('T6', 3, 100) }],
      NOW,
    );
    const t = r.tenants[0]!;
    expect(t.is_complete).toBe(false);
    expect(t.velocity_bucket).toBe('stalled');
    expect(r.most_stalled_tenant?.tenant_id).toBe('T6');
  });

  test('never-touched tenant → not_started bucket', () => {
    const r = summarizeOnboardingVelocity(
      [{ tenant: mkTenant('T7'), state: mkNeverStartedState('T7') }],
      NOW,
    );
    const t = r.tenants[0]!;
    expect(t.first_action_at).toBeNull();
    expect(t.duration_days).toBeNull();
    expect(t.velocity_bucket).toBe('not_started');
    expect(r.total_not_started).toBe(1);
  });

  test('buckets emitted in canonical order regardless of input', () => {
    const r = summarizeOnboardingVelocity([], NOW);
    expect(r.buckets.map((b) => b.bucket)).toEqual([
      ...ALL_ONBOARDING_VELOCITY_BUCKETS,
    ]);
  });
});

// ─── partition invariants ──────────────────────────────────────────

describe('M2.19 — partition invariants', () => {
  test('total_complete + total_in_progress + total_not_started = total_tenants', () => {
    const fleet = [
      { tenant: mkTenant('A'), state: mkCompleteState('A', [5, 4, 3, 2, 1, 1, 0]) },
      { tenant: mkTenant('B'), state: mkPartialState('B', 3, 100) }, // stalled in-progress
      { tenant: mkTenant('C'), state: mkPartialState('C', 3, 20) }, // in-progress < 90d
      { tenant: mkTenant('D'), state: mkNeverStartedState('D') }, // not started
    ];
    const r = summarizeOnboardingVelocity(fleet, NOW);
    expect(r.total_tenants).toBe(4);
    expect(r.total_complete + r.total_in_progress + r.total_not_started).toBe(
      r.total_tenants,
    );
  });

  test('Σ buckets.count = total_tenants', () => {
    const fleet = [
      { tenant: mkTenant('A'), state: mkCompleteState('A', [5, 4, 3, 2, 1, 1, 0]) },
      { tenant: mkTenant('B'), state: mkCompleteState('B', [60, 50, 40, 30, 20, 10, 0]) },
      { tenant: mkTenant('C'), state: mkPartialState('C', 3, 100) },
      { tenant: mkTenant('D'), state: mkNeverStartedState('D') },
    ];
    const r = summarizeOnboardingVelocity(fleet, NOW);
    const sum = r.buckets.reduce((acc, b) => acc + b.count, 0);
    expect(sum).toBe(r.total_tenants);
  });
});

// ─── aggregate stats ───────────────────────────────────────────────

describe('M2.19 — aggregate stats', () => {
  test('mean/min/max_completion_days computed over completed only', () => {
    const fleet = [
      { tenant: mkTenant('A'), state: mkCompleteState('A', [5, 4, 3, 2, 1, 1, 0]) }, // 5d
      { tenant: mkTenant('B'), state: mkCompleteState('B', [15, 13, 10, 8, 5, 3, 0]) }, // 15d
      { tenant: mkTenant('C'), state: mkCompleteState('C', [25, 20, 15, 10, 5, 3, 0]) }, // 25d
      { tenant: mkTenant('D'), state: mkPartialState('D', 3, 100) }, // in-progress, excluded
    ];
    const r = summarizeOnboardingVelocity(fleet, NOW);
    expect(r.mean_completion_days).toBe(15); // (5+15+25)/3
    expect(r.min_completion_days).toBe(5);
    expect(r.max_completion_days).toBe(25);
  });

  test('null when no completed tenants', () => {
    const fleet = [
      { tenant: mkTenant('A'), state: mkPartialState('A', 3, 20) },
      { tenant: mkTenant('B'), state: mkNeverStartedState('B') },
    ];
    const r = summarizeOnboardingVelocity(fleet, NOW);
    expect(r.mean_completion_days).toBeNull();
    expect(r.min_completion_days).toBeNull();
    expect(r.max_completion_days).toBeNull();
    expect(r.fastest_tenant).toBeNull();
    expect(r.slowest_tenant).toBeNull();
  });
});

// ─── leaderboards ──────────────────────────────────────────────────

describe('M2.19 — leaderboards', () => {
  test('fastest_tenant = lowest duration_days among completed', () => {
    const fleet = [
      { tenant: mkTenant('slow-T'), state: mkCompleteState('slow-T', [25, 20, 15, 10, 5, 3, 0]) },
      { tenant: mkTenant('fast-T'), state: mkCompleteState('fast-T', [3, 2, 1, 1, 1, 0, 0]) },
      { tenant: mkTenant('mid-T'), state: mkCompleteState('mid-T', [15, 12, 10, 8, 5, 2, 0]) },
    ];
    const r = summarizeOnboardingVelocity(fleet, NOW);
    expect(r.fastest_tenant?.tenant_id).toBe('fast-T');
    expect(r.fastest_tenant?.duration_days).toBe(3);
  });

  test('slowest_tenant = highest duration_days among completed', () => {
    const fleet = [
      { tenant: mkTenant('slow-T'), state: mkCompleteState('slow-T', [200, 180, 150, 100, 50, 20, 0]) },
      { tenant: mkTenant('fast-T'), state: mkCompleteState('fast-T', [3, 2, 1, 1, 1, 0, 0]) },
    ];
    const r = summarizeOnboardingVelocity(fleet, NOW);
    expect(r.slowest_tenant?.tenant_id).toBe('slow-T');
    expect(r.slowest_tenant?.duration_days).toBe(200);
  });

  test('most_stalled_tenant = max duration_days among stalled in-progress', () => {
    const fleet = [
      { tenant: mkTenant('mild-stall'), state: mkPartialState('mild-stall', 3, 100) },
      { tenant: mkTenant('big-stall'), state: mkPartialState('big-stall', 3, 250) },
      { tenant: mkTenant('in-prog-fine'), state: mkPartialState('in-prog-fine', 3, 20) },
    ];
    const r = summarizeOnboardingVelocity(fleet, NOW);
    expect(r.most_stalled_tenant?.tenant_id).toBe('big-stall');
    expect(r.most_stalled_tenant?.is_complete).toBe(false);
  });

  test('most_stalled_tenant null when no in-progress is stalled', () => {
    const fleet = [
      { tenant: mkTenant('A'), state: mkCompleteState('A', [5, 4, 3, 2, 1, 1, 0]) },
      { tenant: mkTenant('B'), state: mkPartialState('B', 3, 20) },
    ];
    const r = summarizeOnboardingVelocity(fleet, NOW);
    expect(r.most_stalled_tenant).toBeNull();
  });
});

// ─── peak_bucket ───────────────────────────────────────────────────

describe('M2.19 — peak_bucket', () => {
  test('peak_bucket = bucket with most tenants', () => {
    const fleet = [
      { tenant: mkTenant('A'), state: mkCompleteState('A', [3, 2, 1, 1, 1, 0, 0]) }, // fast
      { tenant: mkTenant('B'), state: mkCompleteState('B', [3, 2, 1, 1, 1, 0, 0]) }, // fast
      { tenant: mkTenant('C'), state: mkCompleteState('C', [3, 2, 1, 1, 1, 0, 0]) }, // fast
      { tenant: mkTenant('D'), state: mkPartialState('D', 3, 100) }, // stalled
    ];
    const r = summarizeOnboardingVelocity(fleet, NOW);
    expect(r.peak_bucket).toBe('fast');
    expect(r.peak_count).toBe(3);
  });

  test('canonical iteration tie-break — fast wins over normal at tied 1', () => {
    const fleet = [
      { tenant: mkTenant('fast-T'), state: mkCompleteState('fast-T', [3, 2, 1, 1, 1, 0, 0]) },
      { tenant: mkTenant('norm-T'), state: mkCompleteState('norm-T', [15, 13, 10, 8, 5, 3, 0]) },
    ];
    const r = summarizeOnboardingVelocity(fleet, NOW);
    expect(r.peak_bucket).toBe('fast');
    expect(r.peak_count).toBe(1);
  });
});

// ─── sample_tenant_ids sort ────────────────────────────────────────

describe('M2.19 — sample_tenant_ids sort', () => {
  test('fast bucket: sorted by duration_days asc (fastest first)', () => {
    const fleet = [
      { tenant: mkTenant('T-slow6'), state: mkCompleteState('T-slow6', [6, 5, 4, 3, 2, 1, 0]) },
      { tenant: mkTenant('T-fast2'), state: mkCompleteState('T-fast2', [2, 1, 1, 1, 0, 0, 0]) },
      { tenant: mkTenant('T-mid4'), state: mkCompleteState('T-mid4', [4, 3, 2, 1, 1, 0, 0]) },
    ];
    const r = summarizeOnboardingVelocity(fleet, NOW);
    const fast = r.buckets.find((b) => b.bucket === 'fast')!;
    expect(fast.count).toBe(3);
    expect(fast.sample_tenant_ids).toEqual(['T-fast2', 'T-mid4', 'T-slow6']);
  });

  test('stalled bucket: sorted by duration_days desc (worst first)', () => {
    const fleet = [
      { tenant: mkTenant('mild'), state: mkPartialState('mild', 3, 100) },
      { tenant: mkTenant('big'), state: mkPartialState('big', 3, 250) },
      { tenant: mkTenant('mid'), state: mkPartialState('mid', 3, 150) },
    ];
    const r = summarizeOnboardingVelocity(fleet, NOW);
    const stalled = r.buckets.find((b) => b.bucket === 'stalled')!;
    expect(stalled.sample_tenant_ids).toEqual(['big', 'mid', 'mild']);
  });

  test('not_started bucket: sorted tenant_id asc', () => {
    const fleet = [
      { tenant: mkTenant('zebra'), state: mkNeverStartedState('zebra') },
      { tenant: mkTenant('alpha'), state: mkNeverStartedState('alpha') },
      { tenant: mkTenant('beta'), state: mkNeverStartedState('beta') },
    ];
    const r = summarizeOnboardingVelocity(fleet, NOW);
    const ns = r.buckets.find((b) => b.bucket === 'not_started')!;
    expect(ns.sample_tenant_ids).toEqual(['alpha', 'beta', 'zebra']);
  });

  test('cap 3 enforced when bucket has > 3 tenants', () => {
    const fleet = Array.from({ length: 5 }, (_, i) => ({
      tenant: mkTenant(`T-${i}`),
      state: mkCompleteState(`T-${i}`, [i + 1, i, i, 0, 0, 0, 0]),
    }));
    const r = summarizeOnboardingVelocity(fleet, NOW);
    const fast = r.buckets.find((b) => b.bucket === 'fast')!;
    expect(fast.count).toBe(5);
    expect(fast.sample_tenant_ids).toHaveLength(3);
  });
});

// ─── HTTP route ─────────────────────────────────────────────────────

function makeVelocityApp(role = 'admin', tenants?: Tenant[]) {
  const onboardingStore = new InMemoryOnboardingStore();
  const lookup: TenantLookup = ((id: string) => {
    return tenants?.find((t) => t.tenant_id === id) ?? null;
  }) as TenantLookup;
  if (tenants !== undefined) {
    (lookup as TenantLookup).all = async () => tenants;
  }
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    onboardingStore,
    tenantLookup: lookup,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, onboardingStore, lookup };
}

describe('M2.19 — GET /v1/tenants/onboarding/velocity', () => {
  test('admin → 200 with envelope (default tenant lookup with .all)', async () => {
    const tenants = [mkTenant('BANK_DEMO', 'Bank Demo'), mkTenant('BIL', 'BIL')];
    const { app } = makeVelocityApp('admin', tenants);
    const r = await request(app)
      .get('/v1/tenants/onboarding/velocity')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_tenants).toBe(2);
    expect(r.body.body.buckets).toHaveLength(5);
  });

  test('populated via markStep reflects in velocity buckets', async () => {
    const tenants = [mkTenant('BANK_DEMO', 'Bank Demo'), mkTenant('BIL', 'BIL')];
    const { app, onboardingStore } = makeVelocityApp('admin', tenants);
    // Complete BANK_DEMO in 5 days (all required steps)
    const reqIds = ONBOARDING_STEPS.filter((s) => s.required).map((s) => s.id);
    for (let i = 0; i < reqIds.length; i++) {
      const offset = 5 - (i * 5) / Math.max(1, reqIds.length - 1);
      onboardingStore.markStep(
        'BANK_DEMO',
        reqIds[i]!,
        'completed',
        'admin',
        null,
        new Date(NOW.getTime() - offset * DAY_MS),
      );
    }
    const r = await request(app)
      .get('/v1/tenants/onboarding/velocity')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_complete).toBe(1);
    expect(r.body.body.fastest_tenant.tenant_id).toBe('BANK_DEMO');
    expect(r.body.body.fastest_tenant.velocity_bucket).toBe('fast');
  });

  test('non-allowed role → 403', async () => {
    const tenants = [mkTenant('BIL')];
    const { app } = makeVelocityApp('case_owner', tenants);
    const r = await request(app)
      .get('/v1/tenants/onboarding/velocity')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('501 when tenant lookup does not expose .all()', async () => {
    // Build a lookup without .all
    const lookup: TenantLookup = ((id: string) =>
      id === 'BIL' ? mkTenant('BIL') : null) as TenantLookup;
    const built = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      tenantLookup: lookup,
      now: () => NOW,
      getRole: () => 'admin',
    });
    const r = await request(built.app)
      .get('/v1/tenants/onboarding/velocity')
      .set(TH_BIL);
    expect(r.status).toBe(501);
    expect(r.body.error.code).toBe('EWS_501_not_implemented');
  });

  test('literal /velocity not captured by /:tenant_id wildcard', async () => {
    const tenants = [mkTenant('BIL')];
    const { app } = makeVelocityApp('admin', tenants);
    const r = await request(app)
      .get('/v1/tenants/onboarding/velocity')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    // Envelope carries buckets[] of 5, not single-tenant shape
    expect(Array.isArray(r.body.body.buckets)).toBe(true);
    expect(r.body.body.buckets).toHaveLength(5);
  });

  test('M2.15 /actor-fleet sibling route still works', async () => {
    const tenants = [mkTenant('BIL')];
    const { app } = makeVelocityApp('admin', tenants);
    const r = await request(app)
      .get('/v1/tenants/onboarding/actor-fleet')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M2.16 /completion-timeline sibling route still works', async () => {
    const tenants = [mkTenant('BIL')];
    const { app } = makeVelocityApp('admin', tenants);
    const r = await request(app)
      .get('/v1/tenants/onboarding/completion-timeline')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
