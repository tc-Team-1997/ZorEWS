// services/bff/__tests__/tenant_onboarding_actor_fleet.test.ts
//
// T6 M2.15 — Fleet-wide onboarding contribution by actor.

import request from 'supertest';
import { summarizeOnboardingFleetActors } from '../src/tenant_onboarding_actor_fleet';
import {
  InMemoryOnboardingStore,
  type OnboardingStore,
  type StepProgress,
} from '../src/tenant_onboarding';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-18T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeAfApp(role: string = 'admin', onboardingStore?: OnboardingStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    onboardingStore: onboardingStore ?? new InMemoryOnboardingStore(),
  });
}

function step(
  id: string,
  status: 'completed' | 'skipped' | 'pending',
  actor: string | null,
  at: string | null = NOW.toISOString(),
): StepProgress {
  return {
    step_id: id as never,
    status: status as never,
    completed_at: status === 'pending' ? null : at,
    completed_by: status === 'pending' ? null : actor,
    notes: null,
    skip_reason: null,
  };
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M2.15 — empty fleet', () => {
  test('zero tenants → zero rows + leaderboards null', () => {
    const s = summarizeOnboardingFleetActors([], NOW);
    expect(s.total_tenants_scanned).toBe(0);
    expect(s.total_actions).toBe(0);
    expect(s.total_actors).toBe(0);
    expect(s.actors).toEqual([]);
    expect(s.most_prolific_actor).toBeNull();
    expect(s.most_broad_actor).toBeNull();
  });
});

describe('M2.15 — tenant with all-pending steps → no actor counted', () => {
  test('pending status not counted', () => {
    const fleet = [
      { tenant_id: 't1', steps: [step('tenant_provisioned', 'pending', null)] },
    ];
    const s = summarizeOnboardingFleetActors(fleet, NOW);
    expect(s.total_tenants_scanned).toBe(1);
    expect(s.total_actions).toBe(0);
    expect(s.total_actors).toBe(0);
  });
});

describe('M2.15 — single tenant single actor', () => {
  test('alice completes 2 steps → 1 row with total_actions=2', () => {
    const fleet = [
      {
        tenant_id: 't1',
        steps: [
          step('tenant_provisioned', 'completed', 'alice'),
          step('channels_configured', 'completed', 'alice'),
        ],
      },
    ];
    const s = summarizeOnboardingFleetActors(fleet, NOW);
    expect(s.total_actions).toBe(2);
    expect(s.total_actors).toBe(1);
    expect(s.actors[0].actor_username).toBe('alice');
    expect(s.actors[0].total_actions).toBe(2);
    expect(s.actors[0].completed_count).toBe(2);
    expect(s.actors[0].skipped_count).toBe(0);
    expect(s.actors[0].distinct_tenants).toBe(1);
    expect(s.actors[0].distinct_steps).toBe(2);
  });
});

describe('M2.15 — distinct_tenants across multiple tenants', () => {
  test('alice in 3 tenants → distinct_tenants=3', () => {
    const fleet = [
      { tenant_id: 't1', steps: [step('tenant_provisioned', 'completed', 'alice')] },
      { tenant_id: 't2', steps: [step('tenant_provisioned', 'completed', 'alice')] },
      { tenant_id: 't3', steps: [step('tenant_provisioned', 'completed', 'alice')] },
    ];
    const s = summarizeOnboardingFleetActors(fleet, NOW);
    const alice = s.actors.find((a) => a.actor_username === 'alice')!;
    expect(alice.distinct_tenants).toBe(3);
    expect(alice.tenant_ids).toEqual(['t1', 't2', 't3']);
  });
});

describe('M2.15 — multi-actor cohort', () => {
  test('alice 3 + bob 2 + carol 1 → sorted descending', () => {
    const fleet = [
      {
        tenant_id: 't1',
        steps: [
          step('tenant_provisioned', 'completed', 'alice'),
          step('channels_configured', 'completed', 'alice'),
          step('vertical_set', 'completed', 'alice'),
          step('config_baseline', 'completed', 'bob'),
          step('email_channel', 'completed', 'bob'),
          step('alert_routing', 'completed', 'carol'),
        ],
      },
    ];
    const s = summarizeOnboardingFleetActors(fleet, NOW);
    expect(s.total_actions).toBe(6);
    expect(s.total_actors).toBe(3);
    expect(s.actors[0].actor_username).toBe('alice');
    expect(s.actors[1].actor_username).toBe('bob');
    expect(s.actors[2].actor_username).toBe('carol');
    expect(s.most_prolific_actor).toBe('alice');
  });
});

describe('M2.15 — canonical username asc tie-break on total_actions', () => {
  test('alice + bob tied at 2 → alice first', () => {
    const fleet = [
      {
        tenant_id: 't1',
        steps: [
          step('tenant_provisioned', 'completed', 'alice'),
          step('channels_configured', 'completed', 'alice'),
          step('vertical_set', 'completed', 'bob'),
          step('config_baseline', 'completed', 'bob'),
        ],
      },
    ];
    const s = summarizeOnboardingFleetActors(fleet, NOW);
    expect(s.actors[0].actor_username).toBe('alice');
    expect(s.actors[1].actor_username).toBe('bob');
    expect(s.most_prolific_actor).toBe('alice');
  });
});

describe('M2.15 — skipped status counted in skipped_count', () => {
  test('1 completed + 1 skipped → total=2 with split counts', () => {
    const fleet = [
      {
        tenant_id: 't1',
        steps: [
          step('tenant_provisioned', 'completed', 'alice'),
          step('operator_invited', 'skipped', 'alice'),
        ],
      },
    ];
    const s = summarizeOnboardingFleetActors(fleet, NOW);
    expect(s.actors[0].total_actions).toBe(2);
    expect(s.actors[0].completed_count).toBe(1);
    expect(s.actors[0].skipped_count).toBe(1);
  });
});

describe('M2.15 — most_recent_at = max completed_at across actor', () => {
  test('newest timestamp wins across tenants', () => {
    const fleet = [
      {
        tenant_id: 't1',
        steps: [
          step('tenant_provisioned', 'completed', 'alice', '2026-05-10T00:00:00.000Z'),
        ],
      },
      {
        tenant_id: 't2',
        steps: [
          step('tenant_provisioned', 'completed', 'alice', '2026-05-15T00:00:00.000Z'),
        ],
      },
      {
        tenant_id: 't3',
        steps: [
          step('tenant_provisioned', 'completed', 'alice', '2026-05-12T00:00:00.000Z'),
        ],
      },
    ];
    const s = summarizeOnboardingFleetActors(fleet, NOW);
    expect(s.actors[0].most_recent_at).toBe('2026-05-15T00:00:00.000Z');
  });
});

describe('M2.15 — distinct_steps dedup', () => {
  test('alice in 3 tenants same step → distinct_steps=1', () => {
    const fleet = [
      { tenant_id: 't1', steps: [step('tenant_provisioned', 'completed', 'alice')] },
      { tenant_id: 't2', steps: [step('tenant_provisioned', 'completed', 'alice')] },
      { tenant_id: 't3', steps: [step('tenant_provisioned', 'completed', 'alice')] },
    ];
    const s = summarizeOnboardingFleetActors(fleet, NOW);
    expect(s.actors[0].distinct_steps).toBe(1);
    expect(s.actors[0].distinct_tenants).toBe(3);
  });
});

describe('M2.15 — most_broad_actor formula', () => {
  test('actor with highest distinct_tenants (not highest total_actions)', () => {
    const fleet = [
      // alice in 3 tenants (1 action each = 3 total)
      { tenant_id: 't1', steps: [step('tenant_provisioned', 'completed', 'alice')] },
      { tenant_id: 't2', steps: [step('tenant_provisioned', 'completed', 'alice')] },
      { tenant_id: 't3', steps: [step('tenant_provisioned', 'completed', 'alice')] },
    ];
    // Now add bob with 5 actions in just 1 tenant
    fleet[0].steps.push(
      step('channels_configured', 'completed', 'bob'),
      step('vertical_set', 'completed', 'bob'),
      step('config_baseline', 'completed', 'bob'),
      step('email_channel', 'completed', 'bob'),
      step('alert_routing', 'completed', 'bob'),
    );
    const s = summarizeOnboardingFleetActors(fleet, NOW);
    expect(s.most_prolific_actor).toBe('bob');
    expect(s.most_broad_actor).toBe('alice');
  });
});

describe('M2.15 — partition invariant', () => {
  test('Σ actors.total_actions = envelope.total_actions', () => {
    const fleet = [
      {
        tenant_id: 't1',
        steps: [
          step('tenant_provisioned', 'completed', 'alice'),
          step('channels_configured', 'completed', 'bob'),
          step('vertical_set', 'skipped', 'carol'),
        ],
      },
    ];
    const s = summarizeOnboardingFleetActors(fleet, NOW);
    const sum = s.actors.reduce((acc, a) => acc + a.total_actions, 0);
    expect(sum).toBe(s.total_actions);
    expect(s.total_actions).toBe(3);
  });
});

describe('M2.15 — null actor defensively skipped', () => {
  test('completed step with null actor (shouldn\'t happen but defensively handled) not counted', () => {
    const fleet = [
      {
        tenant_id: 't1',
        steps: [
          step('tenant_provisioned', 'completed', null),
          step('channels_configured', 'completed', 'alice'),
        ],
      },
    ];
    const s = summarizeOnboardingFleetActors(fleet, NOW);
    expect(s.total_actions).toBe(1);
    expect(s.total_actors).toBe(1);
  });
});

describe('M2.15 — tenant_ids sorted asc', () => {
  test('tenant_ids in alphabetical order regardless of input order', () => {
    const fleet = [
      { tenant_id: 'zebra', steps: [step('tenant_provisioned', 'completed', 'alice')] },
      { tenant_id: 'alpha', steps: [step('tenant_provisioned', 'completed', 'alice')] },
      { tenant_id: 'middle', steps: [step('tenant_provisioned', 'completed', 'alice')] },
    ];
    const s = summarizeOnboardingFleetActors(fleet, NOW);
    expect(s.actors[0].tenant_ids).toEqual(['alpha', 'middle', 'zebra']);
  });
});

describe('M2.15 — generated_at echo', () => {
  test('ISO timestamp echoed', () => {
    const s = summarizeOnboardingFleetActors([], NOW);
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M2.15 — GET /v1/tenants/onboarding/actor-fleet', () => {
  test('admin → 200 with empty store (default 2-tenant registry)', async () => {
    const { app } = makeAfApp('admin');
    const r = await request(app)
      .get('/v1/tenants/onboarding/actor-fleet')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    // 2 tenants in default registry, but both have all-pending → 0 actions
    expect(r.body.body.total_tenants_scanned).toBe(2);
    expect(r.body.body.total_actions).toBe(0);
    expect(r.body.body.actors).toEqual([]);
  });

  test('populated → reflects markStep calls across tenants', async () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('BANK_DEMO', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    store.markStep('BANK_DEMO', 'channels_configured', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'channels_configured', 'completed', 'bob', null, NOW);
    const { app } = makeAfApp('admin', store);
    const r = await request(app)
      .get('/v1/tenants/onboarding/actor-fleet')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_tenants_scanned).toBe(2);
    expect(r.body.body.total_actions).toBe(4);
    expect(r.body.body.most_prolific_actor).toBe('alice');
    const alice = r.body.body.actors.find((a: { actor_username: string }) =>
      a.actor_username === 'alice',
    )!;
    expect(alice.total_actions).toBe(3);
    expect(alice.distinct_tenants).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAfApp('case_owner');
    const r = await request(app)
      .get('/v1/tenants/onboarding/actor-fleet')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M2.12 /v1/tenants/onboarding/fleet sibling regression still 200', async () => {
    const { app } = makeAfApp('admin');
    const r = await request(app)
      .get('/v1/tenants/onboarding/fleet')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('literal `/actor-fleet` not captured by `:tenant_id` wildcard', async () => {
    const { app } = makeAfApp('admin');
    const r = await request(app)
      .get('/v1/tenants/onboarding/actor-fleet')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_tenants_scanned).toBeDefined();
  });
});
