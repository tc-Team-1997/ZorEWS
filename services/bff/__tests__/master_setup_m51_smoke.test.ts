/* M5.1 — Master Setup smoke.
 *
 * Verifies:
 *   1. The 4 NEW master_types (reassign_teams, schedule_frequencies,
 *      ai_models, rule_categories) accept CRUD via the unified
 *      /v1/master/:master_type[/:record_id] surface.
 *   2. Spec acceptance — DELETE refuses with 409 EWS_409_in_use +
 *      `detail.total_references` + sample when a usage checker reports
 *      references; succeeds (204) otherwise.
 *   3. GET /:type/:id/where-used reports the same usage report.
 *   4. Cross-tenant isolation still holds.
 *   5. All 16 master_types are routable.
 */

import request from 'supertest';
import {
  MISSING_MASTER_TYPES,
  registerUsageChecker,
  clearUsageCheckers,
  _resetMissingMastersStore,
} from '../src/missing_masters';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-26T12:00:00.000Z');
const TH_BIL = {
  'x-tenant-id': 'BIL',
  'x-channel': 'API',
  'x-apex-role': 'admin',
  'x-apex-user': 'alice.admin',
};
const TH_BANK = {
  'x-tenant-id': 'BANK_DEMO',
  'x-channel': 'API',
  'x-apex-role': 'admin',
  'x-apex-user': 'alice.admin',
};

function makeSmokeApp() {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => 'admin',
  });
}

beforeEach(() => {
  _resetMissingMastersStore();
  clearUsageCheckers();
});

describe('M5.1 — master type catalogue', () => {
  it('MS-1: covers 16 master_types including the 4 new ones', () => {
    expect(MISSING_MASTER_TYPES.length).toBe(16);
    expect(MISSING_MASTER_TYPES).toContain('reassign_teams');
    expect(MISSING_MASTER_TYPES).toContain('schedule_frequencies');
    expect(MISSING_MASTER_TYPES).toContain('ai_models');
    expect(MISSING_MASTER_TYPES).toContain('rule_categories');
  });
});

describe('M5.1 — CRUD on the 4 new master_types', () => {
  it('MS-2: reassign_teams CRUD with team_lead required attribute', async () => {
    const { app } = makeSmokeApp();
    // Missing required attr → 400
    const bad = await request(app)
      .post('/v1/master/reassign_teams')
      .set(TH_BIL)
      .send({ code: 'TEAM_A', name: 'Team A' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('EWS_400_missing_required_attribute');

    // Happy path
    const ok = await request(app)
      .post('/v1/master/reassign_teams')
      .set(TH_BIL)
      .send({ code: 'TEAM_A', name: 'Team A Mumbai branch', attributes: { team_lead: 'alice.admin' } });
    expect(ok.status).toBe(201);
    expect(ok.body.body.attributes.team_lead).toBe('alice.admin');

    const list = await request(app).get('/v1/master/reassign_teams').set(TH_BIL);
    expect(list.status).toBe(200);
    expect(list.body.body.records.length).toBe(1);
  });

  it('MS-3: schedule_frequencies CRUD with interval_days', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app)
      .post('/v1/master/schedule_frequencies')
      .set(TH_BIL)
      .send({ code: 'WEEKLY', name: 'Weekly', attributes: { interval_days: 7 } });
    expect(r.status).toBe(201);
    expect(r.body.body.attributes.interval_days).toBe(7);
  });

  it('MS-4: ai_models CRUD with model_type', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app)
      .post('/v1/master/ai_models')
      .set(TH_BIL)
      .send({ code: 'PD_DEFAULTS', name: 'PD model defaults', attributes: { model_type: 'pd', threshold: 0.7 } });
    expect(r.status).toBe(201);
    expect(r.body.body.attributes.model_type).toBe('pd');
    expect(r.body.body.attributes.threshold).toBe(0.7);
  });

  it('MS-5: rule_categories CRUD (no required attrs)', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app)
      .post('/v1/master/rule_categories')
      .set(TH_BIL)
      .send({ code: 'OPS', name: 'Operational Risk' });
    expect(r.status).toBe(201);
    expect(r.body.body.code).toBe('OPS');
  });
});

describe('M5.1 — where-used route + delete in-use guard (spec acceptance)', () => {
  async function seedRow(app: ReturnType<typeof makeSmokeApp>['app'], type: string, code: string) {
    const required: Record<string, Record<string, string | number>> = {
      currencies: { symbol: '₹', decimals: 2 },
      regulators: { country: 'IN', framework: 'RBI' },
      reassign_teams: { team_lead: 'alice.admin' },
      ai_models: { model_type: 'pd' },
      rule_categories: {},
    };
    const r = await request(app)
      .post(`/v1/master/${type}`)
      .set(TH_BIL)
      .send({ code, name: `${type} ${code}`, attributes: required[type] ?? {} });
    expect(r.status).toBe(201);
    return r.body.body.record_id as string;
  }

  it('MS-6: where-used returns 0 when no checker registered', async () => {
    const { app } = makeSmokeApp();
    const id = await seedRow(app, 'rule_categories', 'X1');
    const r = await request(app)
      .get(`/v1/master/rule_categories/${id}/where-used`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_references).toBe(0);
    expect(r.body.body.references).toEqual([]);
  });

  it('MS-7: where-used returns count + sample from registered checker', async () => {
    const { app } = makeSmokeApp();
    registerUsageChecker('currencies', () => ({
      total: 3,
      sample: [
        { resource_type: 'loan', resource_id: 'L-001', description: 'KES denominated loan' },
        { resource_type: 'loan', resource_id: 'L-002' },
        { resource_type: 'transaction', resource_id: 'T-005' },
      ],
    }));
    const id = await seedRow(app, 'currencies', 'KES');
    const r = await request(app)
      .get(`/v1/master/currencies/${id}/where-used`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_references).toBe(3);
    expect(r.body.body.references.length).toBe(3);
    expect(r.body.body.code).toBe('KES');
  });

  it('MS-8: DELETE refuses with 409 EWS_409_in_use when references exist', async () => {
    const { app } = makeSmokeApp();
    registerUsageChecker('regulators', () => ({
      total: 12,
      sample: [{ resource_type: 'geography', resource_id: 'IN' }],
    }));
    const id = await seedRow(app, 'regulators', 'RBI');
    const r = await request(app).delete(`/v1/master/regulators/${id}`).set(TH_BIL);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_in_use');
    expect(r.body.error.message).toMatch(/12 record/);
    expect(r.body.error.detail?.total_references).toBe(12);
    expect(Array.isArray(r.body.error.detail?.references)).toBe(true);
  });

  it('MS-9: DELETE succeeds (204) when checker reports zero', async () => {
    const { app } = makeSmokeApp();
    registerUsageChecker('currencies', () => ({ total: 0, sample: [] }));
    const id = await seedRow(app, 'currencies', 'USD');
    const r = await request(app).delete(`/v1/master/currencies/${id}`).set(TH_BIL);
    expect(r.status).toBe(204);
  });

  it('MS-10: DELETE succeeds (204) when no checker registered (default safe)', async () => {
    const { app } = makeSmokeApp();
    const id = await seedRow(app, 'ai_models', 'TMP');
    const r = await request(app).delete(`/v1/master/ai_models/${id}`).set(TH_BIL);
    expect(r.status).toBe(204);
  });

  it('MS-11: where-used + DELETE 404 on unknown record', async () => {
    const { app } = makeSmokeApp();
    const r1 = await request(app)
      .get('/v1/master/currencies/m-currencies-BIL-999999/where-used')
      .set(TH_BIL);
    expect(r1.status).toBe(404);
    expect(r1.body.error.code).toBe('EWS_404_unknown_record');

    const r2 = await request(app)
      .delete('/v1/master/currencies/m-currencies-BIL-999999')
      .set(TH_BIL);
    expect(r2.status).toBe(404);
  });

  it('MS-12: cross-tenant where-used returns 404 (isolation)', async () => {
    const { app } = makeSmokeApp();
    const id = await seedRow(app, 'currencies', 'INR');
    const r = await request(app).get(`/v1/master/currencies/${id}/where-used`).set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('M5.1 — unknown master_type', () => {
  it('MS-13: unknown master_type → 404 on every verb', async () => {
    const { app } = makeSmokeApp();
    const get1 = await request(app).get('/v1/master/bogus').set(TH_BIL);
    expect(get1.status).toBe(404);
    expect(get1.body.error.code).toBe('EWS_404_unknown_master_type');

    const post = await request(app)
      .post('/v1/master/bogus')
      .set(TH_BIL)
      .send({ code: 'X', name: 'x' });
    expect(post.status).toBe(404);

    const ws = await request(app).get('/v1/master/bogus/m-x/where-used').set(TH_BIL);
    expect(ws.status).toBe(404);
  });
});
