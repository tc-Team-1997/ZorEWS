// services/bff/__tests__/admin_config_actor_rollup.test.ts
//
// T6 M13.16 — Config override per-actor rollup.

import request from 'supertest';
import { summarizeConfigActorRollup } from '../src/admin_config_actor_rollup';
import {
  InMemoryConfigStore,
  listCategories,
  type ConfigStore,
} from '../src/admin_config';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-18T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeArApp(role: string = 'admin', configStore?: ConfigStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    configStore: configStore ?? new InMemoryConfigStore(),
  });
}

function setOverride(
  store: ConfigStore,
  tenant: string,
  key: string,
  value: number | string | boolean,
  by: string,
  at: Date = NOW,
) {
  store.set(tenant, key, value, by, at);
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M13.16 — empty store', () => {
  test('zero overrides → zero rows + leaderboards null/empty', () => {
    const store = new InMemoryConfigStore();
    const s = summarizeConfigActorRollup('BIL', store.list('BIL'), NOW);
    expect(s.total_overrides).toBe(0);
    expect(s.total_actors).toBe(0);
    expect(s.actors).toEqual([]);
    expect(s.most_active_actor).toBeNull();
    expect(s.actors_with_features_overrides).toEqual([]);
  });
});

describe('M13.16 — defaults excluded', () => {
  test('only is_default=false entries counted', () => {
    const store = new InMemoryConfigStore();
    // No overrides — all entries are defaults
    const s = summarizeConfigActorRollup('BIL', store.list('BIL'), NOW);
    expect(s.total_overrides).toBe(0);
  });
});

describe('M13.16 — single actor single override', () => {
  test('alice overrides 1 key → 1 row with total=1', () => {
    const store = new InMemoryConfigStore();
    setOverride(store, 'BIL', 'alerts.red_sla_hours', 2, 'alice');
    const s = summarizeConfigActorRollup('BIL', store.list('BIL'), NOW);
    expect(s.total_overrides).toBe(1);
    expect(s.total_actors).toBe(1);
    expect(s.actors[0].updated_by).toBe('alice');
    expect(s.actors[0].total_overrides).toBe(1);
    expect(s.actors[0].distinct_keys).toEqual(['alerts.red_sla_hours']);
    expect(s.actors[0].distinct_categories).toEqual(['alerts']);
    expect(s.actors[0].by_category.alerts).toBe(1);
  });
});

describe('M13.16 — multi-actor cohort', () => {
  test('alice 3 + bob 1 → sorted desc by total_overrides', () => {
    const store = new InMemoryConfigStore();
    setOverride(store, 'BIL', 'alerts.red_sla_hours', 2, 'alice');
    setOverride(store, 'BIL', 'alerts.orange_sla_hours', 12, 'alice');
    setOverride(store, 'BIL', 'alerts.yellow_sla_hours', 48, 'alice');
    setOverride(store, 'BIL', 'reporting.retention_days', 730, 'bob');
    const s = summarizeConfigActorRollup('BIL', store.list('BIL'), NOW);
    expect(s.total_actors).toBe(2);
    expect(s.actors[0].updated_by).toBe('alice');
    expect(s.actors[0].total_overrides).toBe(3);
    expect(s.actors[1].updated_by).toBe('bob');
    expect(s.actors[1].total_overrides).toBe(1);
    expect(s.most_active_actor).toBe('alice');
  });

  test('canonical username asc tie-break at tied total_overrides', () => {
    const store = new InMemoryConfigStore();
    setOverride(store, 'BIL', 'alerts.red_sla_hours', 2, 'alice');
    setOverride(store, 'BIL', 'alerts.orange_sla_hours', 12, 'bob');
    const s = summarizeConfigActorRollup('BIL', store.list('BIL'), NOW);
    expect(s.actors[0].updated_by).toBe('alice');
    expect(s.actors[1].updated_by).toBe('bob');
  });
});

describe('M13.16 — distinct_keys sorted asc per actor', () => {
  test('keys sorted', () => {
    const store = new InMemoryConfigStore();
    setOverride(store, 'BIL', 'alerts.yellow_sla_hours', 48, 'alice');
    setOverride(store, 'BIL', 'alerts.red_sla_hours', 2, 'alice');
    setOverride(store, 'BIL', 'alerts.orange_sla_hours', 12, 'alice');
    const s = summarizeConfigActorRollup('BIL', store.list('BIL'), NOW);
    expect(s.actors[0].distinct_keys).toEqual([
      'alerts.orange_sla_hours',
      'alerts.red_sla_hours',
      'alerts.yellow_sla_hours',
    ]);
  });
});

describe('M13.16 — by_category every category present', () => {
  test('every category key present (0 when absent)', () => {
    const store = new InMemoryConfigStore();
    setOverride(store, 'BIL', 'alerts.red_sla_hours', 2, 'alice');
    const s = summarizeConfigActorRollup('BIL', store.list('BIL'), NOW);
    for (const cat of listCategories()) {
      expect(s.actors[0].by_category[cat]).toBeGreaterThanOrEqual(0);
    }
    expect(s.actors[0].by_category.alerts).toBe(1);
  });
});

describe('M13.16 — most_recent_at = max updated_at per actor', () => {
  test('newest timestamp wins', () => {
    const store = new InMemoryConfigStore();
    setOverride(store, 'BIL', 'alerts.red_sla_hours', 2, 'alice',
      new Date('2026-05-10T00:00:00.000Z'));
    setOverride(store, 'BIL', 'alerts.orange_sla_hours', 12, 'alice',
      new Date('2026-05-15T00:00:00.000Z'));
    const s = summarizeConfigActorRollup('BIL', store.list('BIL'), NOW);
    expect(s.actors[0].most_recent_at).toBe('2026-05-15T00:00:00.000Z');
  });
});

describe('M13.16 — actors_with_features_overrides security signal', () => {
  test('actor touching features.* surfaces in subset', () => {
    const store = new InMemoryConfigStore();
    setOverride(store, 'BIL', 'features.scenario_simulation_enabled', false, 'alice');
    setOverride(store, 'BIL', 'alerts.red_sla_hours', 2, 'bob');
    const s = summarizeConfigActorRollup('BIL', store.list('BIL'), NOW);
    expect(s.actors_with_features_overrides).toEqual(['alice']);
    expect(s.actors_with_features_overrides).not.toContain('bob');
  });

  test('subset sorted asc', () => {
    const store = new InMemoryConfigStore();
    setOverride(store, 'BIL', 'features.scenario_simulation_enabled', false, 'zoe');
    setOverride(store, 'BIL', 'features.copilot_enabled', false, 'alice');
    const s = summarizeConfigActorRollup('BIL', store.list('BIL'), NOW);
    expect(s.actors_with_features_overrides).toEqual(['alice', 'zoe']);
  });

  test('empty when no features overrides', () => {
    const store = new InMemoryConfigStore();
    setOverride(store, 'BIL', 'alerts.red_sla_hours', 2, 'alice');
    const s = summarizeConfigActorRollup('BIL', store.list('BIL'), NOW);
    expect(s.actors_with_features_overrides).toEqual([]);
  });
});

describe('M13.16 — partition invariant', () => {
  test('Σ actors.total_overrides = envelope.total_overrides', () => {
    const store = new InMemoryConfigStore();
    setOverride(store, 'BIL', 'alerts.red_sla_hours', 2, 'alice');
    setOverride(store, 'BIL', 'reporting.retention_days', 730, 'bob');
    setOverride(store, 'BIL', 'features.copilot_enabled', false, 'carol');
    const s = summarizeConfigActorRollup('BIL', store.list('BIL'), NOW);
    const sum = s.actors.reduce((acc, a) => acc + a.total_overrides, 0);
    expect(sum).toBe(s.total_overrides);
    expect(s.total_overrides).toBe(3);
  });

  test('Σ by_category per actor = actor.total_overrides', () => {
    const store = new InMemoryConfigStore();
    setOverride(store, 'BIL', 'alerts.red_sla_hours', 2, 'alice');
    setOverride(store, 'BIL', 'alerts.orange_sla_hours', 12, 'alice');
    setOverride(store, 'BIL', 'features.copilot_enabled', false, 'alice');
    const s = summarizeConfigActorRollup('BIL', store.list('BIL'), NOW);
    const a = s.actors[0];
    const sum = listCategories().reduce((acc, c) => acc + a.by_category[c], 0);
    expect(sum).toBe(a.total_overrides);
  });
});

describe('M13.16 — tenant scoping', () => {
  test('BIL overrides invisible to BANK_DEMO', () => {
    const store = new InMemoryConfigStore();
    setOverride(store, 'BIL', 'alerts.red_sla_hours', 2, 'alice');
    const bil = summarizeConfigActorRollup('BIL', store.list('BIL'), NOW);
    const bank = summarizeConfigActorRollup('BANK_DEMO', store.list('BANK_DEMO'), NOW);
    expect(bil.total_overrides).toBe(1);
    expect(bank.total_overrides).toBe(0);
  });
});

describe('M13.16 — tenant_id + generated_at echo', () => {
  test('envelope echoes inputs', () => {
    const s = summarizeConfigActorRollup('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M13.16 — GET /v1/admin/config/actor-rollup', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeArApp('admin');
    const r = await request(app)
      .get('/v1/admin/config/actor-rollup')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(0);
    expect(r.body.body.actors).toEqual([]);
    expect(r.body.body.most_active_actor).toBeNull();
  });

  test('populated → reflects overrides', async () => {
    const store = new InMemoryConfigStore();
    setOverride(store, 'BIL', 'alerts.red_sla_hours', 2, 'alice');
    setOverride(store, 'BIL', 'features.copilot_enabled', false, 'alice');
    setOverride(store, 'BIL', 'reporting.retention_days', 730, 'bob');
    const { app } = makeArApp('admin', store);
    const r = await request(app)
      .get('/v1/admin/config/actor-rollup')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(3);
    expect(r.body.body.most_active_actor).toBe('alice');
    expect(r.body.body.actors_with_features_overrides).toEqual(['alice']);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeArApp('case_owner');
    const r = await request(app)
      .get('/v1/admin/config/actor-rollup')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryConfigStore();
    setOverride(store, 'BIL', 'alerts.red_sla_hours', 2, 'alice');
    const { app } = makeArApp('admin', store);
    const bankR = await request(app)
      .get('/v1/admin/config/actor-rollup')
      .set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.total_overrides).toBe(0);
    const bilR = await request(app)
      .get('/v1/admin/config/actor-rollup')
      .set(TH_BIL);
    expect(bilR.body.body.total_overrides).toBe(1);
  });

  test('M13.12 /v1/admin/config/override-rate sibling regression still 200', async () => {
    const { app } = makeArApp('admin');
    const r = await request(app)
      .get('/v1/admin/config/override-rate')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('literal `/actor-rollup` not captured by `:key` wildcard', async () => {
    const { app } = makeArApp('admin');
    const r = await request(app)
      .get('/v1/admin/config/actor-rollup')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBeDefined();
  });
});
