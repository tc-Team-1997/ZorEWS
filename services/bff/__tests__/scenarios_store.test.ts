// Unit + integration tests for the scenario store + /v1/scenarios routes.
//
// In-memory tests run unconditionally. The pg integration suite is gated
// on BFF_PG_URL — skipped by default to keep CI hermetic. Run locally:
//
//   BFF_PG_URL=postgres://zorews_user:apex@localhost:55432/zorews \
//     npm test -- scenarios_store

import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import {
  InMemoryScenarioStore,
  PgScenarioStore,
  type IScenarioStore,
} from '../src/scenario/store';
import { makeApp } from '../src/server';
import type { ScenarioResult, ShockInputs } from '../src/scenario/types';

const PG_URL = process.env.BFF_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

function fakeResult(): ScenarioResult {
  return {
    inputs: { gdp: -2, rate: 100, fx: 5 },
    portfolio_size: 10,
    total_ead_kes: 1_000_000,
    baseline_ecl_kes: 50_000,
    stressed_ecl_kes: 75_000,
    ecl_delta_kes: 25_000,
    baseline_bands: { low: 5, medium: 3, high: 2 },
    stressed_bands: { low: 3, medium: 4, high: 3 },
    baseline_stages: { stage_1: 5, stage_2: 3, stage_3: 2 },
    stressed_stages: { stage_1: 3, stage_2: 4, stage_3: 3 },
    stage_migration: {
      s1: { s1: 3, s2: 2, s3: 0 },
      s2: { s1: 0, s2: 2, s3: 1 },
      s3: { s1: 0, s2: 0, s3: 2 },
    },
    segments: [],
    segment_risk_matrix: [],
    baseline_portfolio_pd: 0.05,
    stressed_portfolio_pd: 0.075,
    baseline_npa_pct: 0.2,
    stressed_npa_pct: 0.3,
    top_affected: [],
    computed_at: '2026-05-03T12:00:00.000Z',
  };
}

function fakeInputs(): ShockInputs {
  return { gdp: -2, rate: 100, fx: 5 };
}

describe('InMemoryScenarioStore — pure unit (T4.24 Phase 4 tenant-scoped)', () => {
  let store: InMemoryScenarioStore;
  const T = 'BANK_DEMO';
  beforeEach(() => {
    store = new InMemoryScenarioStore();
  });

  test('save() trims name + assigns id + saved_at + tenant_id', () => {
    const s = store.save({
      tenant_id: T,
      name: '  Hot summer  ',
      saved_by: 'alice.admin',
      inputs: fakeInputs(),
      result: fakeResult(),
    });
    expect(s.name).toBe('Hot summer');
    expect(s.tenant_id).toBe(T);
    expect(s.saved_by).toBe('alice.admin');
    expect(s.id).toMatch(/^s-/);
    expect(s.saved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('save() throws on empty name', () => {
    expect(() =>
      store.save({
        tenant_id: T,
        name: '   ',
        saved_by: 'alice.admin',
        inputs: fakeInputs(),
        result: fakeResult(),
      }),
    ).toThrow(/name is required/);
  });

  test('list() filters by saved_by + sorts newest-first', async () => {
    const a = store.save({ tenant_id: T, name: 'a', saved_by: 'alice', inputs: fakeInputs(), result: fakeResult() });
    await new Promise((r) => setTimeout(r, 5));
    const b = store.save({ tenant_id: T, name: 'b', saved_by: 'bob', inputs: fakeInputs(), result: fakeResult() });
    await new Promise((r) => setTimeout(r, 5));
    const c = store.save({ tenant_id: T, name: 'c', saved_by: 'alice', inputs: fakeInputs(), result: fakeResult() });

    const all = store.list({ tenant_id: T });
    expect(all.map((s) => s.id)).toEqual([c.id, b.id, a.id]);

    const aliceOnly = store.list({ tenant_id: T, saved_by: 'alice' });
    expect(aliceOnly.map((s) => s.id)).toEqual([c.id, a.id]);
  });

  test('delete() removes the row + returns false on unknown id', () => {
    const s = store.save({ tenant_id: T, name: 'x', saved_by: 'u', inputs: fakeInputs(), result: fakeResult() });
    expect(store.delete(s.id, T)).toBe(true);
    expect(store.get(s.id, T)).toBeUndefined();
    expect(store.delete('no-such-id', T)).toBe(false);
  });

  // T4.24 Phase 4 — cross-tenant isolation
  test('cross-tenant isolation — BIL scenarios are invisible to BANK_DEMO and vice-versa', () => {
    const bank = store.save({ tenant_id: 'BANK_DEMO', name: 'bank-stress', saved_by: 'alice', inputs: fakeInputs(), result: fakeResult() });
    const bil = store.save({ tenant_id: 'BIL', name: 'bil-stress', saved_by: 'bil.admin', inputs: fakeInputs(), result: fakeResult() });

    // List is tenant-scoped.
    expect(store.list({ tenant_id: 'BANK_DEMO' }).map((s) => s.id)).toEqual([bank.id]);
    expect(store.list({ tenant_id: 'BIL' }).map((s) => s.id)).toEqual([bil.id]);

    // Cross-tenant get returns undefined (no enumeration leak).
    expect(store.get(bil.id, 'BANK_DEMO')).toBeUndefined();
    expect(store.get(bank.id, 'BIL')).toBeUndefined();

    // Cross-tenant delete returns false; the row stays.
    expect(store.delete(bil.id, 'BANK_DEMO')).toBe(false);
    expect(store.get(bil.id, 'BIL')).toBeDefined();
  });
});

describe('/v1/scenarios — routes against InMemoryScenarioStore (T4.24 enveloped)', () => {
  const TENANT_HEADERS = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };
  let store: IScenarioStore;
  let app: express.Express;

  beforeEach(() => {
    store = new InMemoryScenarioStore();
    const built = makeApp({ scenarioStore: store, getRole: () => 'risk_analyst' });
    app = built.app;
  });

  test('POST /v1/scenarios → 201 envelope and persists', async () => {
    const res = await request(app)
      .post('/v1/scenarios')
      .set(TENANT_HEADERS)
      .set('x-apex-role', 'risk_analyst')
      .set('x-apex-user', 'alice')
      .send({ name: 'Drought', inputs: fakeInputs(), result: fakeResult() });
    expect(res.status).toBe(201);
    expect(res.body.header.code).toBe('EWS_201');
    expect(res.body.body.name).toBe('Drought');
    expect(res.body.body.saved_by).toBe('alice');
    expect(store.list({ tenant_id: 'BANK_DEMO' }).length).toBe(1);
  });

  test('POST /v1/scenarios → 400 envelope on missing name', async () => {
    const res = await request(app)
      .post('/v1/scenarios')
      .set(TENANT_HEADERS)
      .set('x-apex-role', 'risk_analyst')
      .set('x-apex-user', 'alice')
      .send({ inputs: fakeInputs(), result: fakeResult() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EWS_400');
  });

  test('POST /v1/scenarios → 400 envelope on bad inputs shape', async () => {
    const res = await request(app)
      .post('/v1/scenarios')
      .set(TENANT_HEADERS)
      .set('x-apex-role', 'risk_analyst')
      .set('x-apex-user', 'alice')
      .send({ name: 'x', inputs: { gdp: 'NaN' }, result: fakeResult() });
    expect(res.status).toBe(400);
  });

  test('GET /v1/scenarios scopes to caller (non-admin)', async () => {
    store.save({ tenant_id: 'BANK_DEMO', name: 'mine', saved_by: 'alice', inputs: fakeInputs(), result: fakeResult() });
    store.save({ tenant_id: 'BANK_DEMO', name: 'theirs', saved_by: 'bob', inputs: fakeInputs(), result: fakeResult() });

    const res = await request(app)
      .get('/v1/scenarios')
      .set(TENANT_HEADERS)
      .set('x-apex-role', 'risk_analyst')
      .set('x-apex-user', 'alice');
    expect(res.status).toBe(200);
    expect(res.body.body.total).toBe(1);
    expect(res.body.body.items[0].name).toBe('mine');
  });

  test('GET /v1/scenarios as admin sees everyone', async () => {
    store.save({ tenant_id: 'BANK_DEMO', name: 'mine', saved_by: 'alice', inputs: fakeInputs(), result: fakeResult() });
    store.save({ tenant_id: 'BANK_DEMO', name: 'theirs', saved_by: 'bob', inputs: fakeInputs(), result: fakeResult() });

    const adminApp = makeApp({ scenarioStore: store, getRole: () => 'admin' }).app;
    const res = await request(adminApp)
      .get('/v1/scenarios')
      .set(TENANT_HEADERS)
      .set('x-apex-role', 'admin')
      .set('x-apex-user', 'alice');
    expect(res.body.body.total).toBe(2);
  });

  test('GET /v1/scenarios/:id 404 envelope for other user (no enumeration)', async () => {
    const s = store.save({ tenant_id: 'BANK_DEMO', name: 'theirs', saved_by: 'bob', inputs: fakeInputs(), result: fakeResult() });
    const res = await request(app)
      .get(`/v1/scenarios/${s.id}`)
      .set(TENANT_HEADERS)
      .set('x-apex-role', 'risk_analyst')
      .set('x-apex-user', 'alice');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EWS_404');
  });

  test('cross-tenant — BIL request never sees BANK_DEMO scenarios', async () => {
    // BANK_DEMO scenario, saved by BANK_DEMO's alice.
    const bankS = store.save({
      tenant_id: 'BANK_DEMO',
      name: 'bank-stress',
      saved_by: 'alice',
      inputs: fakeInputs(),
      result: fakeResult(),
    });
    // BIL admin lists their own — gets nothing.
    const list = await request(app)
      .get('/v1/scenarios')
      .set({ 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' })
      .set('x-apex-role', 'admin')
      .set('x-apex-user', 'bil.admin');
    expect(list.status).toBe(200);
    expect(list.body.body.total).toBe(0);
    // BIL admin tries to fetch BANK_DEMO's scenario by id — 404 (no enumeration).
    const get = await request(app)
      .get(`/v1/scenarios/${bankS.id}`)
      .set({ 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' })
      .set('x-apex-role', 'admin')
      .set('x-apex-user', 'bil.admin');
    expect(get.status).toBe(404);
    expect(get.body.error.code).toBe('EWS_404');
    // BIL admin tries to delete BANK_DEMO's scenario — 404, row stays.
    const del = await request(app)
      .delete(`/v1/scenarios/${bankS.id}`)
      .set({ 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' })
      .set('x-apex-role', 'admin')
      .set('x-apex-user', 'bil.admin');
    expect(del.status).toBe(404);
    expect(store.get(bankS.id, 'BANK_DEMO')).toBeDefined();
  });

  test('DELETE /v1/scenarios/:id → 204 then 404', async () => {
    const s = store.save({ tenant_id: 'BANK_DEMO', name: 'mine', saved_by: 'alice', inputs: fakeInputs(), result: fakeResult() });
    const r1 = await request(app)
      .delete(`/v1/scenarios/${s.id}`)
      .set(TENANT_HEADERS)
      .set('x-apex-role', 'risk_analyst')
      .set('x-apex-user', 'alice');
    expect(r1.status).toBe(204);
    const r2 = await request(app)
      .delete(`/v1/scenarios/${s.id}`)
      .set(TENANT_HEADERS)
      .set('x-apex-role', 'risk_analyst')
      .set('x-apex-user', 'alice');
    expect(r2.status).toBe(404);
  });
});

describeIfPg('PgScenarioStore (integration — requires BFF_PG_URL)', () => {
  let pool: Pool;
  let store: PgScenarioStore;

  beforeAll(() => {
    pool = new Pool({ connectionString: PG_URL, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    store = new PgScenarioStore(pool, () => undefined);
    await store.init();
    await store.reset();
  });

  test('save() persists to app_scenario.saved_scenarios', async () => {
    const s = store.save({
      tenant_id: 'BANK_DEMO',
      name: 'pg-scenario-1',
      saved_by: 'alice.admin',
      inputs: { gdp: -2.5, rate: 150, fx: 7.25 },
      result: fakeResult(),
    });
    await new Promise((r) => setTimeout(r, 150));
    const r = await pool.query(
      `SELECT name, saved_by,
              gdp_shock_pct::text AS gdp,
              rate_shock_bps,
              fx_shock_pct::text AS fx
         FROM app_scenario.saved_scenarios WHERE scenario_id = $1`,
      [s.id],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].name).toBe('pg-scenario-1');
    expect(r.rows[0].saved_by).toBe('alice.admin');
    expect(Number(r.rows[0].gdp)).toBeCloseTo(-2.5, 2);
    expect(r.rows[0].rate_shock_bps).toBe(150);
    expect(Number(r.rows[0].fx)).toBeCloseTo(7.25, 2);
  });

  test('init() rebuilds cache (inputs + result intact) after a "restart"', async () => {
    const s = store.save({
      tenant_id: 'BANK_DEMO',
      name: 'survives-restart',
      saved_by: 'ravi.risk',
      inputs: { gdp: -3, rate: 200, fx: 10 },
      result: fakeResult(),
    });
    await new Promise((r) => setTimeout(r, 150));

    const fresh = new PgScenarioStore(pool, () => undefined);
    await fresh.init();
    const recovered = fresh.get(s.id, 'BANK_DEMO');
    expect(recovered).toBeDefined();
    expect(recovered?.name).toBe('survives-restart');
    expect(recovered?.saved_by).toBe('ravi.risk');
    expect(recovered?.inputs).toEqual({ gdp: -3, rate: 200, fx: 10 });
    expect(recovered?.result.ecl_delta_kes).toBe(25_000);
  });

  test('delete() removes from cache + pg', async () => {
    const s = store.save({
      tenant_id: 'BANK_DEMO',
      name: 'transient',
      saved_by: 'sue.super',
      inputs: fakeInputs(),
      result: fakeResult(),
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(store.delete(s.id, 'BANK_DEMO')).toBe(true);
    expect(store.get(s.id, 'BANK_DEMO')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 150));
    const r = await pool.query(
      `SELECT 1 FROM app_scenario.saved_scenarios WHERE scenario_id = $1`,
      [s.id],
    );
    expect(r.rowCount).toBe(0);
  });

  test('list({saved_by}) returns only the user’s rows, newest-first', async () => {
    store.save({ tenant_id: 'BANK_DEMO', name: 'a', saved_by: 'alice', inputs: fakeInputs(), result: fakeResult() });
    await new Promise((r) => setTimeout(r, 5));
    store.save({ tenant_id: 'BANK_DEMO', name: 'b', saved_by: 'bob', inputs: fakeInputs(), result: fakeResult() });
    await new Promise((r) => setTimeout(r, 5));
    const c = store.save({ tenant_id: 'BANK_DEMO', name: 'c', saved_by: 'alice', inputs: fakeInputs(), result: fakeResult() });

    const aliceOnly = store.list({ tenant_id: 'BANK_DEMO', saved_by: 'alice' }).map((s) => s.id);
    expect(aliceOnly).toEqual([c.id, expect.stringMatching(/^s-/)]);
    expect(aliceOnly.length).toBe(2);
  });
});
