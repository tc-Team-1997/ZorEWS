// services/bff/__tests__/bureau_master.test.ts
//
// Phase B.2 — External Bureau Master Setup.

import request from 'supertest';
import {
  ALL_BUREAU_REFRESH_CADENCES,
  ALL_BUREAU_TYPES,
  BureauMasterError,
  computeBureauWeightOverlay,
  defaultBureauMasterStore,
  InMemoryBureauMasterStore,
  isBureauRefreshCadence,
  isBureauType,
} from '../src/master/bureau_master';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryRecoveryStore } from '../src/recovery/store';

const NOW = new Date('2026-05-21T09:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function makeBureauApp(role: string = 'admin', overrides: {
  bureauMasterStore?: InMemoryBureauMasterStore;
  recoveryStore?: InMemoryRecoveryStore;
} = {}) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    bureauMasterStore: overrides.bureauMasterStore ?? new InMemoryBureauMasterStore(),
    recoveryStore: overrides.recoveryStore ?? new InMemoryRecoveryStore(),
  });
  return app;
}

const validInput = (over: Record<string, unknown> = {}) => ({
  bureau_id: 'CIBIL' as const,
  score_weight: 0.5,
  ...over,
});

// ─── 1. Enums ─────────────────────────────────────────────────────────

describe('Bureau enums', () => {
  test('4 bureau types in declared order', () => {
    expect(ALL_BUREAU_TYPES).toEqual(['CIBIL', 'CRIF', 'EXPERIAN', 'EQUIFAX']);
  });
  test('5 refresh cadences', () => {
    expect(ALL_BUREAU_REFRESH_CADENCES.length).toBe(5);
  });
  test('type guards', () => {
    for (const t of ALL_BUREAU_TYPES) expect(isBureauType(t)).toBe(true);
    expect(isBureauType('cibil')).toBe(false);
    expect(isBureauType('NOVATE')).toBe(false);
    for (const c of ALL_BUREAU_REFRESH_CADENCES) expect(isBureauRefreshCadence(c)).toBe(true);
  });
});

// ─── 2. Store CRUD ────────────────────────────────────────────────────

describe('InMemoryBureauMasterStore — create validation', () => {
  test('happy path returns populated entry with defaults', () => {
    const s = new InMemoryBureauMasterStore();
    const e = s.create('BIL', validInput(), 'alice.admin', NOW);
    expect(e.bureau_id).toBe('CIBIL');
    expect(e.score_weight).toBe(0.5);
    expect(e.score_range_min).toBe(300);
    expect(e.score_range_max).toBe(900);
    expect(e.refresh_cadence).toBe('daily');
    expect(e.fallback_mode).toBe(false);
    expect(e.enabled).toBe(true);
    expect(e.tenant_id).toBe('BIL');
  });

  test('invalid bureau_id rejected', () => {
    const s = new InMemoryBureauMasterStore();
    expect(() =>
      s.create('BIL', validInput({ bureau_id: 'cibil' as never }), 'a', NOW),
    ).toThrow(BureauMasterError);
    expect(() =>
      s.create('BIL', validInput({ bureau_id: 'NOVATE' as never }), 'a', NOW),
    ).toThrow(BureauMasterError);
  });

  test('weight out of [0, 1] rejected', () => {
    const s = new InMemoryBureauMasterStore();
    expect(() => s.create('BIL', validInput({ score_weight: 1.5 }), 'a', NOW)).toThrow(
      BureauMasterError,
    );
    expect(() => s.create('BIL', validInput({ score_weight: -0.1 }), 'a', NOW)).toThrow(
      BureauMasterError,
    );
    expect(() => s.create('BIL', validInput({ score_weight: NaN }), 'a', NOW)).toThrow(
      BureauMasterError,
    );
  });

  test('weight=0 and weight=1 accepted (boundaries)', () => {
    const s = new InMemoryBureauMasterStore();
    expect(s.create('BIL', validInput({ score_weight: 0 }), 'a', NOW).score_weight).toBe(0);
    s.softDelete('BIL', 'CIBIL', 'a', NOW); // free slot
    expect(s.create('BIL', validInput({ score_weight: 1 }), 'a', NOW).score_weight).toBe(1);
  });

  test('invalid score range rejected', () => {
    const s = new InMemoryBureauMasterStore();
    expect(() =>
      s.create('BIL', validInput({ score_range_min: 500, score_range_max: 300 }), 'a', NOW),
    ).toThrow(BureauMasterError);
    expect(() =>
      s.create('BIL', validInput({ score_range_min: -1 }), 'a', NOW),
    ).toThrow(BureauMasterError);
  });

  test('invalid cadence rejected', () => {
    const s = new InMemoryBureauMasterStore();
    expect(() =>
      s.create('BIL', validInput({ refresh_cadence: 'every_3_days' as never }), 'a', NOW),
    ).toThrow(BureauMasterError);
  });

  test('overlong contract_ref / notes rejected', () => {
    const s = new InMemoryBureauMasterStore();
    expect(() =>
      s.create('BIL', validInput({ contract_ref: 'x'.repeat(201) }), 'a', NOW),
    ).toThrow(BureauMasterError);
    expect(() =>
      s.create('BIL', validInput({ notes: 'x'.repeat(1001) }), 'a', NOW),
    ).toThrow(BureauMasterError);
  });

  test('duplicate bureau_id rejected', () => {
    const s = new InMemoryBureauMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    expect(() => s.create('BIL', validInput(), 'a', NOW)).toThrow(BureauMasterError);
  });

  test('missing actor rejected', () => {
    const s = new InMemoryBureauMasterStore();
    expect(() => s.create('BIL', validInput(), '', NOW)).toThrow(BureauMasterError);
  });
});

describe('InMemoryBureauMasterStore — list/update/delete/restore', () => {
  test('list orders by canonical ALL_BUREAU_TYPES sequence', () => {
    const s = new InMemoryBureauMasterStore();
    // Insert in reverse order — list output must be canonical.
    s.create('BIL', validInput({ bureau_id: 'EQUIFAX', score_weight: 0.1 }), 'a', NOW);
    s.create('BIL', validInput({ bureau_id: 'CRIF', score_weight: 0.2 }), 'a', NOW);
    s.create('BIL', validInput({ bureau_id: 'CIBIL', score_weight: 0.3 }), 'a', NOW);
    expect(s.list('BIL').map((e) => e.bureau_id)).toEqual(['CIBIL', 'CRIF', 'EQUIFAX']);
  });

  test('list filter enabled=true narrows', () => {
    const s = new InMemoryBureauMasterStore();
    s.create('BIL', validInput({ bureau_id: 'CIBIL', enabled: true }), 'a', NOW);
    s.create('BIL', validInput({ bureau_id: 'CRIF', enabled: false }), 'a', NOW);
    expect(s.list('BIL', { enabled: true }).map((e) => e.bureau_id)).toEqual(['CIBIL']);
    expect(s.list('BIL', { enabled: false }).map((e) => e.bureau_id)).toEqual(['CRIF']);
  });

  test('update applies patch + bumps audit fields', () => {
    const s = new InMemoryBureauMasterStore();
    s.create('BIL', validInput(), 'alice', NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const u = s.update(
      'BIL',
      'CIBIL',
      { score_weight: 0.75, enabled: false, fallback_mode: true, refresh_cadence: 'hourly' },
      'bob',
      later,
    );
    expect(u.score_weight).toBe(0.75);
    expect(u.enabled).toBe(false);
    expect(u.fallback_mode).toBe(true);
    expect(u.refresh_cadence).toBe('hourly');
    expect(u.updated_by).toBe('bob');
    expect(u.created_by).toBe('alice');
  });

  test('update unknown_bureau throws', () => {
    const s = new InMemoryBureauMasterStore();
    expect(() => s.update('BIL', 'CIBIL', { enabled: false }, 'a', NOW)).toThrow(
      BureauMasterError,
    );
  });

  test('update invariant: when patch raises min above existing max it fails', () => {
    const s = new InMemoryBureauMasterStore();
    s.create('BIL', validInput({ score_range_min: 300, score_range_max: 900 }), 'a', NOW);
    expect(() =>
      s.update('BIL', 'CIBIL', { score_range_min: 1000 }, 'a', NOW),
    ).toThrow(BureauMasterError);
  });

  test('softDelete + restore round-trip', () => {
    const s = new InMemoryBureauMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    const t = s.softDelete('BIL', 'CIBIL', 'b', NOW);
    expect(t.deleted_at).toBe(NOW.toISOString());
    expect(s.get('BIL', 'CIBIL')).toBeNull();
    expect(s.restore(t)).toBe(true);
    expect(s.get('BIL', 'CIBIL')?.deleted_at).toBeNull();
  });

  test('restore rejects malformed payload', () => {
    const s = new InMemoryBureauMasterStore();
    expect(s.restore(null as never)).toBe(false);
    expect(s.restore({} as never)).toBe(false);
    expect(s.restore({ bureau_id: 'INVALID', tenant_id: 'BIL' } as never)).toBe(false);
  });

  test('restore conflict on live row', () => {
    const s = new InMemoryBureauMasterStore();
    const e = s.create('BIL', validInput(), 'a', NOW);
    expect(s.restore(e)).toBe(false);
  });

  test('tenant scoping — BIL invisible to BANK_DEMO', () => {
    const s = new InMemoryBureauMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    s.create('BANK_DEMO', validInput({ bureau_id: 'EXPERIAN' }), 'a', NOW);
    expect(s.list('BIL').map((e) => e.bureau_id)).toEqual(['CIBIL']);
    expect(s.list('BANK_DEMO').map((e) => e.bureau_id)).toEqual(['EXPERIAN']);
  });
});

// ─── 3. Weight-overlay helper ────────────────────────────────────────

describe('computeBureauWeightOverlay', () => {
  test('empty store → empty overlay', () => {
    const s = new InMemoryBureauMasterStore();
    const o = computeBureauWeightOverlay(s, 'BIL');
    expect(o.enabled_bureaus).toEqual([]);
    expect(o.total_raw_weight).toBe(0);
    expect(Object.keys(o.normalised_weights)).toEqual([]);
  });

  test('only enabled bureaus contribute', () => {
    const s = new InMemoryBureauMasterStore();
    s.create('BIL', validInput({ bureau_id: 'CIBIL', score_weight: 0.6, enabled: true }), 'a', NOW);
    s.create('BIL', validInput({ bureau_id: 'CRIF', score_weight: 0.4, enabled: false }), 'a', NOW);
    s.create('BIL', validInput({ bureau_id: 'EXPERIAN', score_weight: 0.3, enabled: true }), 'a', NOW);
    const o = computeBureauWeightOverlay(s, 'BIL');
    expect(o.enabled_bureaus).toEqual(['CIBIL', 'EXPERIAN']);
    expect(o.total_raw_weight).toBeCloseTo(0.9, 5);
    expect(o.raw_weights.CIBIL).toBe(0.6);
    expect(o.raw_weights.EXPERIAN).toBe(0.3);
    expect(o.normalised_weights.CIBIL).toBeCloseTo(0.6667, 3);
    expect(o.normalised_weights.EXPERIAN).toBeCloseTo(0.3333, 3);
  });

  test('zero total weight → empty normalised map (no NaN)', () => {
    const s = new InMemoryBureauMasterStore();
    s.create('BIL', validInput({ score_weight: 0, enabled: true }), 'a', NOW);
    const o = computeBureauWeightOverlay(s, 'BIL');
    expect(o.enabled_bureaus).toEqual(['CIBIL']);
    expect(o.total_raw_weight).toBe(0);
    expect(Object.keys(o.normalised_weights)).toEqual([]);
  });

  test('normalised weights sum to ≈1', () => {
    const s = new InMemoryBureauMasterStore();
    s.create('BIL', validInput({ bureau_id: 'CIBIL', score_weight: 0.25 }), 'a', NOW);
    s.create('BIL', validInput({ bureau_id: 'CRIF', score_weight: 0.25 }), 'a', NOW);
    s.create('BIL', validInput({ bureau_id: 'EXPERIAN', score_weight: 0.50 }), 'a', NOW);
    const o = computeBureauWeightOverlay(s, 'BIL');
    const sum = Object.values(o.normalised_weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 3);
  });
});

// ─── 4. Routes ─────────────────────────────────────────────────────────

describe('GET /v1/master/bureaus/types', () => {
  test('admin happy', async () => {
    const app = makeBureauApp('admin');
    const r = await request(app).get('/v1/master/bureaus/types').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.bureau_types).toEqual([...ALL_BUREAU_TYPES]);
    expect(r.body.body.refresh_cadences).toEqual([...ALL_BUREAU_REFRESH_CADENCES]);
  });

  test('non-admin → 403', async () => {
    const app = makeBureauApp('field_officer');
    const r = await request(app).get('/v1/master/bureaus/types').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/master/bureaus', () => {
  test('happy 201', async () => {
    const app = makeBureauApp('admin');
    const r = await request(app).post('/v1/master/bureaus').set(TH_BIL).send(validInput());
    expect(r.status).toBe(201);
    expect(r.body.body.bureau_id).toBe('CIBIL');
  });

  test('enveloped body honoured', async () => {
    const app = makeBureauApp('admin');
    const r = await request(app)
      .post('/v1/master/bureaus')
      .set(TH_BIL)
      .send({ header: {}, body: validInput() });
    expect(r.status).toBe(201);
  });

  test('duplicate → 409', async () => {
    const store = new InMemoryBureauMasterStore();
    const app = makeBureauApp('admin', { bureauMasterStore: store });
    await request(app).post('/v1/master/bureaus').set(TH_BIL).send(validInput());
    const r = await request(app).post('/v1/master/bureaus').set(TH_BIL).send(validInput());
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_bureau');
  });

  test('invalid bureau_id → 400', async () => {
    const app = makeBureauApp('admin');
    const r = await request(app)
      .post('/v1/master/bureaus')
      .set(TH_BIL)
      .send(validInput({ bureau_id: 'cibil' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_bureau_id');
  });

  test('invalid weight → 400', async () => {
    const app = makeBureauApp('admin');
    const r = await request(app)
      .post('/v1/master/bureaus')
      .set(TH_BIL)
      .send(validInput({ score_weight: 1.5 }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_weight');
  });

  test('non-admin → 403', async () => {
    const app = makeBureauApp('field_officer');
    const r = await request(app).post('/v1/master/bureaus').set(TH_BIL).send(validInput());
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/master/bureaus + filters', () => {
  test('tenant scoping', async () => {
    const store = new InMemoryBureauMasterStore();
    const app = makeBureauApp('admin', { bureauMasterStore: store });
    await request(app).post('/v1/master/bureaus').set(TH_BIL).send(validInput());
    await request(app).post('/v1/master/bureaus').set(TH_BANK).send(validInput({ bureau_id: 'CRIF' }));
    const rBIL = await request(app).get('/v1/master/bureaus').set(TH_BIL);
    expect(rBIL.body.body.items[0].bureau_id).toBe('CIBIL');
    const rBANK = await request(app).get('/v1/master/bureaus').set(TH_BANK);
    expect(rBANK.body.body.items[0].bureau_id).toBe('CRIF');
  });

  test('?enabled=true narrows', async () => {
    const store = new InMemoryBureauMasterStore();
    const app = makeBureauApp('admin', { bureauMasterStore: store });
    await request(app).post('/v1/master/bureaus').set(TH_BIL).send(validInput({ enabled: true }));
    await request(app)
      .post('/v1/master/bureaus')
      .set(TH_BIL)
      .send(validInput({ bureau_id: 'CRIF', enabled: false }));
    const r = await request(app).get('/v1/master/bureaus?enabled=true').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].bureau_id).toBe('CIBIL');
  });

  test('?enabled=foo → 400', async () => {
    const app = makeBureauApp('admin');
    const r = await request(app).get('/v1/master/bureaus?enabled=foo').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_enabled');
  });
});

describe('GET /v1/master/bureaus/:bureau_id', () => {
  test('case-insensitive path', async () => {
    const store = new InMemoryBureauMasterStore();
    const app = makeBureauApp('admin', { bureauMasterStore: store });
    await request(app).post('/v1/master/bureaus').set(TH_BIL).send(validInput());
    const r = await request(app).get('/v1/master/bureaus/cibil').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.bureau_id).toBe('CIBIL');
  });

  test('unknown bureau type → 404', async () => {
    const app = makeBureauApp('admin');
    const r = await request(app).get('/v1/master/bureaus/NOVATE').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_bureau');
  });

  test('valid bureau type but not configured → 404', async () => {
    const app = makeBureauApp('admin');
    const r = await request(app).get('/v1/master/bureaus/CIBIL').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('cross-tenant lookup → 404', async () => {
    const store = new InMemoryBureauMasterStore();
    const app = makeBureauApp('admin', { bureauMasterStore: store });
    await request(app).post('/v1/master/bureaus').set(TH_BIL).send(validInput());
    const r = await request(app).get('/v1/master/bureaus/CIBIL').set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('PATCH /v1/master/bureaus/:bureau_id', () => {
  test('happy', async () => {
    const store = new InMemoryBureauMasterStore();
    const app = makeBureauApp('admin', { bureauMasterStore: store });
    await request(app).post('/v1/master/bureaus').set(TH_BIL).send(validInput());
    const r = await request(app)
      .patch('/v1/master/bureaus/CIBIL')
      .set(TH_BIL)
      .send({ enabled: false, score_weight: 0.8 });
    expect(r.status).toBe(200);
    expect(r.body.body.enabled).toBe(false);
    expect(r.body.body.score_weight).toBe(0.8);
  });

  test('unknown bureau type → 404', async () => {
    const app = makeBureauApp('admin');
    const r = await request(app).patch('/v1/master/bureaus/BOGUS').set(TH_BIL).send({ enabled: false });
    expect(r.status).toBe(404);
  });

  test('invalid patch → 400', async () => {
    const store = new InMemoryBureauMasterStore();
    const app = makeBureauApp('admin', { bureauMasterStore: store });
    await request(app).post('/v1/master/bureaus').set(TH_BIL).send(validInput());
    const r = await request(app)
      .patch('/v1/master/bureaus/CIBIL')
      .set(TH_BIL)
      .send({ score_weight: 2 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_weight');
  });
});

describe('DELETE /v1/master/bureaus/:bureau_id + recovery', () => {
  test('soft-delete + archive', async () => {
    const store = new InMemoryBureauMasterStore();
    const recovery = new InMemoryRecoveryStore();
    const app = makeBureauApp('admin', { bureauMasterStore: store, recoveryStore: recovery });
    await request(app).post('/v1/master/bureaus').set(TH_BIL).send(validInput());
    const r = await request(app).delete('/v1/master/bureaus/CIBIL').set(TH_BIL);
    expect(r.status).toBe(204);
    const archived = await recovery.list({ tenant_id: 'BIL', entity_type: 'bureau_master' });
    expect(archived.items.length).toBe(1);
    expect(archived.items[0].original_id).toBe('CIBIL');
    expect(archived.items[0].original_table).toBe('app_master.bureaus');
  });

  test('unknown → 404', async () => {
    const app = makeBureauApp('admin');
    const r = await request(app).delete('/v1/master/bureaus/CIBIL').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('non-admin → 403', async () => {
    const app = makeBureauApp('field_officer');
    const r = await request(app).delete('/v1/master/bureaus/CIBIL').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/master/bureaus/weight-overlay', () => {
  test('empty → zero overlay', async () => {
    const app = makeBureauApp('admin');
    const r = await request(app).get('/v1/master/bureaus/weight-overlay').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_raw_weight).toBe(0);
    expect(r.body.body.enabled_bureaus).toEqual([]);
  });

  test('populated → normalised weights', async () => {
    const store = new InMemoryBureauMasterStore();
    const app = makeBureauApp('admin', { bureauMasterStore: store });
    await request(app)
      .post('/v1/master/bureaus')
      .set(TH_BIL)
      .send(validInput({ bureau_id: 'CIBIL', score_weight: 0.6 }));
    await request(app)
      .post('/v1/master/bureaus')
      .set(TH_BIL)
      .send(validInput({ bureau_id: 'CRIF', score_weight: 0.3 }));
    const r = await request(app).get('/v1/master/bureaus/weight-overlay').set(TH_BIL);
    expect(r.body.body.enabled_bureaus).toEqual(['CIBIL', 'CRIF']);
    expect(r.body.body.total_raw_weight).toBeCloseTo(0.9, 5);
    expect(r.body.body.normalised_weights.CIBIL).toBeCloseTo(0.6667, 3);
  });
});

// ─── 5. Singleton sanity ──────────────────────────────────────────────

describe('defaultBureauMasterStore', () => {
  test('exposes interface', () => {
    expect(defaultBureauMasterStore).toBeDefined();
    expect(typeof defaultBureauMasterStore.list).toBe('function');
    expect(typeof defaultBureauMasterStore.create).toBe('function');
    expect(typeof defaultBureauMasterStore.softDelete).toBe('function');
    expect(typeof defaultBureauMasterStore.restore).toBe('function');
  });
});
