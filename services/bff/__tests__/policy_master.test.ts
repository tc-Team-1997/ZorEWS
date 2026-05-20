// services/bff/__tests__/policy_master.test.ts
//
// Phase B.4 — Product & Policy Master Setup.

import request from 'supertest';
import {
  ALL_POLICY_CATEGORIES,
  ALL_PREMIUM_FREQUENCIES,
  ALL_RENEWAL_TYPES,
  defaultPolicyMasterStore,
  InMemoryPolicyMasterStore,
  isPolicyCategory,
  isPremiumFrequency,
  isRenewalType,
  POLICY_MASTER_CAP_PER_TENANT,
  PolicyMasterError,
} from '../src/master/policy_master';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryRecoveryStore } from '../src/recovery/store';

const NOW = new Date('2026-05-21T09:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function makePolicyApp(role: string = 'admin', overrides: {
  policyMasterStore?: InMemoryPolicyMasterStore;
  recoveryStore?: InMemoryRecoveryStore;
} = {}) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    policyMasterStore: overrides.policyMasterStore ?? new InMemoryPolicyMasterStore(),
    recoveryStore: overrides.recoveryStore ?? new InMemoryRecoveryStore(),
  });
  return app;
}

const validInput = (over: Record<string, unknown> = {}) => ({
  policy_type_id: 'TERM_LIFE_15Y',
  display_name: 'Term Life 15-year',
  category: 'TERM_LIFE' as const,
  premium_frequency: 'yearly' as const,
  min_premium: 5000,
  max_premium: 50000,
  min_coverage: 1_000_000,
  max_coverage: 50_000_000,
  waiting_period_days: 0,
  grace_period_days: 30,
  renewal_type: 'auto' as const,
  ...over,
});

// ─── Enums ─────────────────────────────────────────────────────────

describe('Policy master enums', () => {
  test('4 BIL categories matching M14.1', () => {
    expect(ALL_POLICY_CATEGORIES).toEqual(['TERM_LIFE', 'ENDOWMENT', 'ULIP', 'GENERAL_HEALTH']);
  });
  test('5 premium frequencies', () => {
    expect(ALL_PREMIUM_FREQUENCIES.length).toBe(5);
  });
  test('3 renewal types', () => {
    expect(ALL_RENEWAL_TYPES).toEqual(['auto', 'manual', 'on_demand']);
  });
  test('type guards', () => {
    for (const c of ALL_POLICY_CATEGORIES) expect(isPolicyCategory(c)).toBe(true);
    expect(isPolicyCategory('term_life')).toBe(false);
    for (const f of ALL_PREMIUM_FREQUENCIES) expect(isPremiumFrequency(f)).toBe(true);
    for (const r of ALL_RENEWAL_TYPES) expect(isRenewalType(r)).toBe(true);
  });
});

// ─── Validation ─────────────────────────────────────────────────────

describe('InMemoryPolicyMasterStore — create', () => {
  test('happy path returns populated entry', () => {
    const s = new InMemoryPolicyMasterStore();
    const e = s.create('BIL', validInput(), 'alice.admin', NOW);
    expect(e.policy_type_id).toBe('TERM_LIFE_15Y');
    expect(e.category).toBe('TERM_LIFE');
    expect(e.min_premium).toBe(5000);
    expect(e.max_coverage).toBe(50_000_000);
    expect(e.grace_period_days).toBe(30);
    expect(e.renewal_type).toBe('auto');
    expect(e.active).toBe(true);
    expect(e.tenant_id).toBe('BIL');
  });

  test('defaults: yearly + 0 waiting + 30 grace + manual renewal', () => {
    const s = new InMemoryPolicyMasterStore();
    const e = s.create(
      'BIL',
      {
        policy_type_id: 'BASIC_HEALTH',
        display_name: 'Basic Health',
        category: 'GENERAL_HEALTH',
        min_premium: 1000,
        max_premium: 10000,
        min_coverage: 100000,
        max_coverage: 5_000_000,
      },
      'a',
      NOW,
    );
    expect(e.premium_frequency).toBe('yearly');
    expect(e.waiting_period_days).toBe(0);
    expect(e.grace_period_days).toBe(30);
    expect(e.renewal_type).toBe('manual');
  });

  test('invalid policy_type_id rejected', () => {
    const s = new InMemoryPolicyMasterStore();
    expect(() =>
      s.create('BIL', validInput({ policy_type_id: 'lowercase' }), 'a', NOW),
    ).toThrow(PolicyMasterError);
    expect(() =>
      s.create('BIL', validInput({ policy_type_id: 'X' }), 'a', NOW),
    ).toThrow(PolicyMasterError);
  });

  test('invalid category rejected', () => {
    const s = new InMemoryPolicyMasterStore();
    expect(() =>
      s.create('BIL', validInput({ category: 'AUTO' }), 'a', NOW),
    ).toThrow(PolicyMasterError);
  });

  test('inverted premium range rejected (max < min)', () => {
    const s = new InMemoryPolicyMasterStore();
    expect(() =>
      s.create('BIL', validInput({ min_premium: 50000, max_premium: 5000 }), 'a', NOW),
    ).toThrow(PolicyMasterError);
  });

  test('inverted coverage range rejected', () => {
    const s = new InMemoryPolicyMasterStore();
    expect(() =>
      s.create('BIL', validInput({ min_coverage: 100, max_coverage: 50 }), 'a', NOW),
    ).toThrow(PolicyMasterError);
  });

  test('negative premium/coverage rejected', () => {
    const s = new InMemoryPolicyMasterStore();
    expect(() =>
      s.create('BIL', validInput({ min_premium: -1 }), 'a', NOW),
    ).toThrow(PolicyMasterError);
    expect(() =>
      s.create('BIL', validInput({ min_coverage: -1 }), 'a', NOW),
    ).toThrow(PolicyMasterError);
  });

  test('out-of-range waiting/grace periods rejected', () => {
    const s = new InMemoryPolicyMasterStore();
    expect(() =>
      s.create('BIL', validInput({ waiting_period_days: -1 }), 'a', NOW),
    ).toThrow(PolicyMasterError);
    expect(() =>
      s.create('BIL', validInput({ grace_period_days: 366 }), 'a', NOW),
    ).toThrow(PolicyMasterError);
  });

  test('overlong description/notes rejected', () => {
    const s = new InMemoryPolicyMasterStore();
    expect(() =>
      s.create('BIL', validInput({ description: 'x'.repeat(501) }), 'a', NOW),
    ).toThrow(PolicyMasterError);
    expect(() =>
      s.create('BIL', validInput({ notes: 'x'.repeat(1001) }), 'a', NOW),
    ).toThrow(PolicyMasterError);
  });

  test('duplicate policy_type_id rejected', () => {
    const s = new InMemoryPolicyMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    expect(() => s.create('BIL', validInput(), 'a', NOW)).toThrow(PolicyMasterError);
  });

  test('missing actor rejected', () => {
    const s = new InMemoryPolicyMasterStore();
    expect(() => s.create('BIL', validInput(), '', NOW)).toThrow(PolicyMasterError);
  });
});

describe('InMemoryPolicyMasterStore — list/update/delete/restore', () => {
  test('list orders by canonical category then display_name', () => {
    const s = new InMemoryPolicyMasterStore();
    s.create('BIL', validInput({ policy_type_id: 'HEALTH_BASIC', display_name: 'Basic Health', category: 'GENERAL_HEALTH', min_coverage: 100, max_coverage: 1000 }), 'a', NOW);
    s.create('BIL', validInput({ policy_type_id: 'ULIP_PLAN', display_name: 'ULIP Plan', category: 'ULIP', min_coverage: 100, max_coverage: 1000 }), 'a', NOW);
    s.create('BIL', validInput({ policy_type_id: 'ENDOW_15Y', display_name: 'Endowment 15y', category: 'ENDOWMENT', min_coverage: 100, max_coverage: 1000 }), 'a', NOW);
    s.create('BIL', validInput({ policy_type_id: 'TERM_30Y', display_name: 'Term 30y', category: 'TERM_LIFE', min_coverage: 100, max_coverage: 1000 }), 'a', NOW);
    const items = s.list('BIL');
    expect(items.map((e) => e.policy_type_id)).toEqual([
      'TERM_30Y',     // TERM_LIFE first
      'ENDOW_15Y',    // ENDOWMENT
      'ULIP_PLAN',    // ULIP
      'HEALTH_BASIC', // GENERAL_HEALTH last
    ]);
  });

  test('filter by category narrows', () => {
    const s = new InMemoryPolicyMasterStore();
    s.create('BIL', validInput({ policy_type_id: 'TERM_A' }), 'a', NOW);
    s.create('BIL', validInput({ policy_type_id: 'HEALTH_A', category: 'GENERAL_HEALTH' }), 'a', NOW);
    expect(s.list('BIL', { category: 'GENERAL_HEALTH' }).map((e) => e.policy_type_id)).toEqual([
      'HEALTH_A',
    ]);
  });

  test('filter active=false narrows', () => {
    const s = new InMemoryPolicyMasterStore();
    s.create('BIL', validInput({ policy_type_id: 'ACTIVE_X', active: true }), 'a', NOW);
    s.create('BIL', validInput({ policy_type_id: 'INACTIVE_Y', active: false }), 'a', NOW);
    expect(s.list('BIL', { active: false }).map((e) => e.policy_type_id)).toEqual(['INACTIVE_Y']);
  });

  test('update applies patch', () => {
    const s = new InMemoryPolicyMasterStore();
    s.create('BIL', validInput(), 'alice', NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const u = s.update(
      'BIL',
      'TERM_LIFE_15Y',
      { active: false, waiting_period_days: 90, max_coverage: 100_000_000 },
      'bob',
      later,
    );
    expect(u.active).toBe(false);
    expect(u.waiting_period_days).toBe(90);
    expect(u.max_coverage).toBe(100_000_000);
    expect(u.updated_by).toBe('bob');
  });

  test('update validates premium range with merged-effective semantics', () => {
    const s = new InMemoryPolicyMasterStore();
    s.create('BIL', validInput({ min_premium: 5000, max_premium: 50000 }), 'a', NOW);
    // Patch min_premium > existing max_premium should fail.
    expect(() =>
      s.update('BIL', 'TERM_LIFE_15Y', { min_premium: 100000 }, 'a', NOW),
    ).toThrow(PolicyMasterError);
    // Patch both should succeed.
    const u = s.update(
      'BIL',
      'TERM_LIFE_15Y',
      { min_premium: 100000, max_premium: 200000 },
      'a',
      NOW,
    );
    expect(u.min_premium).toBe(100000);
    expect(u.max_premium).toBe(200000);
  });

  test('update unknown_policy_type → throws', () => {
    const s = new InMemoryPolicyMasterStore();
    expect(() =>
      s.update('BIL', 'GHOST', { active: false }, 'a', NOW),
    ).toThrow(PolicyMasterError);
  });

  test('softDelete + restore round-trip', () => {
    const s = new InMemoryPolicyMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    const t = s.softDelete('BIL', 'TERM_LIFE_15Y', 'b', NOW);
    expect(t.deleted_at).toBe(NOW.toISOString());
    expect(s.get('BIL', 'TERM_LIFE_15Y')).toBeNull();
    expect(s.restore(t)).toBe(true);
    expect(s.get('BIL', 'TERM_LIFE_15Y')?.deleted_at).toBeNull();
  });

  test('tenant scoping', () => {
    const s = new InMemoryPolicyMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    s.create('BANK_DEMO', validInput({ policy_type_id: 'OTHER_PLAN' }), 'a', NOW);
    expect(s.list('BIL').map((e) => e.policy_type_id)).toEqual(['TERM_LIFE_15Y']);
    expect(s.list('BANK_DEMO').map((e) => e.policy_type_id)).toEqual(['OTHER_PLAN']);
  });
});

// ─── Routes ─────────────────────────────────────────────────────────

describe('GET /v1/master/policies/categories', () => {
  test('admin happy', async () => {
    const app = makePolicyApp('admin');
    const r = await request(app).get('/v1/master/policies/categories').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.categories).toEqual([...ALL_POLICY_CATEGORIES]);
    expect(r.body.body.premium_frequencies).toEqual([...ALL_PREMIUM_FREQUENCIES]);
    expect(r.body.body.renewal_types).toEqual([...ALL_RENEWAL_TYPES]);
  });

  test('non-admin → 403', async () => {
    const app = makePolicyApp('field_officer');
    expect((await request(app).get('/v1/master/policies/categories').set(TH_BIL)).status).toBe(403);
  });
});

describe('POST /v1/master/policies', () => {
  test('happy 201', async () => {
    const app = makePolicyApp('admin');
    const r = await request(app).post('/v1/master/policies').set(TH_BIL).send(validInput());
    expect(r.status).toBe(201);
    expect(r.body.body.policy_type_id).toBe('TERM_LIFE_15Y');
  });

  test('enveloped body honoured', async () => {
    const app = makePolicyApp('admin');
    const r = await request(app)
      .post('/v1/master/policies')
      .set(TH_BIL)
      .send({ header: {}, body: validInput() });
    expect(r.status).toBe(201);
  });

  test('duplicate → 409', async () => {
    const store = new InMemoryPolicyMasterStore();
    const app = makePolicyApp('admin', { policyMasterStore: store });
    await request(app).post('/v1/master/policies').set(TH_BIL).send(validInput());
    const r = await request(app).post('/v1/master/policies').set(TH_BIL).send(validInput());
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_policy_type_id');
  });

  test('invalid category → 400', async () => {
    const app = makePolicyApp('admin');
    const r = await request(app)
      .post('/v1/master/policies')
      .set(TH_BIL)
      .send(validInput({ category: 'AUTO' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_category');
  });

  test('inverted premium range → 400', async () => {
    const app = makePolicyApp('admin');
    const r = await request(app)
      .post('/v1/master/policies')
      .set(TH_BIL)
      .send(validInput({ min_premium: 50000, max_premium: 5000 }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_premium_range');
  });

  test('non-admin → 403', async () => {
    const app = makePolicyApp('field_officer');
    expect((await request(app).post('/v1/master/policies').set(TH_BIL).send(validInput())).status).toBe(403);
  });
});

describe('GET /v1/master/policies list', () => {
  test('?category=TERM_LIFE narrows', async () => {
    const store = new InMemoryPolicyMasterStore();
    const app = makePolicyApp('admin', { policyMasterStore: store });
    await request(app).post('/v1/master/policies').set(TH_BIL).send(validInput());
    await request(app)
      .post('/v1/master/policies')
      .set(TH_BIL)
      .send(validInput({ policy_type_id: 'HEALTH_BASIC', display_name: 'Basic Health', category: 'GENERAL_HEALTH', min_coverage: 100, max_coverage: 1000 }));
    const r = await request(app).get('/v1/master/policies?category=TERM_LIFE').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].policy_type_id).toBe('TERM_LIFE_15Y');
  });

  test('?category=bogus → 400', async () => {
    const app = makePolicyApp('admin');
    expect((await request(app).get('/v1/master/policies?category=bogus').set(TH_BIL)).status).toBe(400);
  });

  test('?active=foo → 400', async () => {
    const app = makePolicyApp('admin');
    expect((await request(app).get('/v1/master/policies?active=foo').set(TH_BIL)).status).toBe(400);
  });

  test('tenant scoping', async () => {
    const store = new InMemoryPolicyMasterStore();
    const app = makePolicyApp('admin', { policyMasterStore: store });
    await request(app).post('/v1/master/policies').set(TH_BIL).send(validInput());
    expect((await request(app).get('/v1/master/policies').set(TH_BANK)).body.body.total).toBe(0);
  });
});

describe('Single GET / PATCH / DELETE', () => {
  test('GET unknown → 404', async () => {
    const app = makePolicyApp('admin');
    expect((await request(app).get('/v1/master/policies/GHOST').set(TH_BIL)).status).toBe(404);
  });

  test('PATCH happy', async () => {
    const store = new InMemoryPolicyMasterStore();
    const app = makePolicyApp('admin', { policyMasterStore: store });
    await request(app).post('/v1/master/policies').set(TH_BIL).send(validInput());
    const r = await request(app)
      .patch('/v1/master/policies/TERM_LIFE_15Y')
      .set(TH_BIL)
      .send({ active: false, waiting_period_days: 45 });
    expect(r.status).toBe(200);
    expect(r.body.body.active).toBe(false);
    expect(r.body.body.waiting_period_days).toBe(45);
  });

  test('PATCH inverted range → 400', async () => {
    const store = new InMemoryPolicyMasterStore();
    const app = makePolicyApp('admin', { policyMasterStore: store });
    await request(app).post('/v1/master/policies').set(TH_BIL).send(validInput());
    const r = await request(app)
      .patch('/v1/master/policies/TERM_LIFE_15Y')
      .set(TH_BIL)
      .send({ min_premium: 1_000_000 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_premium_range');
  });

  test('PATCH unknown → 404', async () => {
    const app = makePolicyApp('admin');
    expect(
      (await request(app).patch('/v1/master/policies/GHOST').set(TH_BIL).send({ active: false })).status,
    ).toBe(404);
  });

  test('DELETE + archive', async () => {
    const store = new InMemoryPolicyMasterStore();
    const recovery = new InMemoryRecoveryStore();
    const app = makePolicyApp('admin', { policyMasterStore: store, recoveryStore: recovery });
    await request(app).post('/v1/master/policies').set(TH_BIL).send(validInput());
    const r = await request(app).delete('/v1/master/policies/TERM_LIFE_15Y').set(TH_BIL);
    expect(r.status).toBe(204);
    const archived = await recovery.list({ tenant_id: 'BIL', entity_type: 'policy_master' });
    expect(archived.items.length).toBe(1);
    expect(archived.items[0].original_id).toBe('TERM_LIFE_15Y');
    expect(archived.items[0].original_table).toBe('app_master.policies');
  });
});

describe('singleton + cap', () => {
  test('cap sensible', () => {
    expect(POLICY_MASTER_CAP_PER_TENANT).toBeGreaterThan(0);
    expect(POLICY_MASTER_CAP_PER_TENANT).toBeLessThan(10_000);
  });
  test('default store interface', () => {
    expect(typeof defaultPolicyMasterStore.create).toBe('function');
    expect(typeof defaultPolicyMasterStore.restore).toBe('function');
  });
});
