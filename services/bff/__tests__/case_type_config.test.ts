import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  InMemoryCaseTypeConfigStore,
  CaseTypeConfigError,
  summarizeCaseTypes,
  isCasePriority,
  ALL_CASE_PRIORITIES,
  CASE_TYPES_PER_TENANT_MAX,
  SLA_HOURS_MAX,
  _resetCaseTypeConfigStore,
  type CaseTypeConfig,
} from '../src/case_type_config';

const NOW = new Date('2026-05-29T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const TENANT = 'BANK_DEMO';
const H = { 'X-Tenant-ID': TENANT, 'X-Channel': 'API', 'x-apex-user': 'alice.admin' };

function app(role = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
  return app;
}

// ─── Enums + summary ─────────────────────────────────────────────────

describe('case_type_config — enums + summary', () => {
  it('ALL_CASE_PRIORITIES is P1..P4 + guard agrees', () => {
    expect(ALL_CASE_PRIORITIES).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(isCasePriority('P1')).toBe(true);
    expect(isCasePriority('P5')).toBe(false);
  });

  it('summarizeCaseTypes counts by priority + SLA stats over enabled', () => {
    const s = new InMemoryCaseTypeConfigStore();
    const sum = summarizeCaseTypes(TENANT, s.list(TENANT));
    expect(sum.total).toBe(4);
    expect(sum.enabled_count).toBe(4);
    expect(sum.by_priority).toEqual({ P1: 1, P2: 1, P3: 1, P4: 1 });
    expect(sum.fastest_sla_hours).toBe(4);
    expect(sum.slowest_sla_hours).toBe(168);
    expect(sum.mean_sla_hours).toBeCloseTo((4 + 24 + 72 + 168) / 4, 2);
  });

  it('mean SLA only counts enabled types; null when none enabled', () => {
    const s = new InMemoryCaseTypeConfigStore();
    const rows = s.list(TENANT);
    rows.forEach((r) => s.update(TENANT, r.case_type_id, { enabled: false }, NOW_MS));
    const sum = summarizeCaseTypes(TENANT, s.list(TENANT));
    expect(sum.enabled_count).toBe(0);
    expect(sum.mean_sla_hours).toBeNull();
    expect(sum.fastest_sla_hours).toBeNull();
  });
});

// ─── Store ───────────────────────────────────────────────────────────

describe('case_type_config — store', () => {
  function fresh() {
    return new InMemoryCaseTypeConfigStore();
  }

  it('seeds the 4 MASTER SETUP example case types', () => {
    const rows = fresh().list(TENANT);
    expect(rows.length).toBe(4);
    expect(rows.map((r) => r.code)).toContain('FRAUD_INVESTIGATION');
    const fraud = rows.find((r) => r.code === 'FRAUD_INVESTIGATION')!;
    expect(fraud.priority).toBe('P1');
    expect(fraud.sla_hours).toBe(4);
    expect(fraud.assigned_team).toBe('Fraud Desk');
  });

  it('list filters by priority + enabled; returns defensive copies', () => {
    const s = fresh();
    expect(s.list(TENANT, 'P1').length).toBe(1);
    expect(s.list(TENANT, 'P1')[0].code).toBe('FRAUD_INVESTIGATION');
    const all = s.list(TENANT);
    all[0].sla_hours = 9999;
    expect(s.list(TENANT)[0].sla_hours).not.toBe(9999);
    // enabledOnly
    s.update(TENANT, all[0].case_type_id, { enabled: false }, NOW_MS);
    expect(s.list(TENANT, 'all', true).length).toBe(3);
  });

  it('create mints id + rejects dup code / bad priority / bad SLA', () => {
    const s = fresh();
    const c = s.create(TENANT, { code: 'aml_escalation', name: 'AML Escalation', priority: 'P1', sla_hours: 6, assigned_team: 'Compliance' }, 'alice', NOW_MS);
    expect(c.case_type_id).toMatch(/^cty-BANK_DEMO-\d{4}$/);
    expect(c.code).toBe('AML_ESCALATION');
    expect(s.list(TENANT).length).toBe(5);
    expect(() => s.create(TENANT, { code: 'FRAUD_INVESTIGATION', name: 'dup', priority: 'P1', sla_hours: 4, assigned_team: 'x' }, 'a', NOW_MS)).toThrow(/already exists/);
    expect(() => s.create(TENANT, { code: 'BADP', name: 'x', priority: 'P9' as never, sla_hours: 4, assigned_team: 'x' }, 'a', NOW_MS)).toThrow(/priority/);
    expect(() => s.create(TENANT, { code: 'BADS', name: 'x', priority: 'P1', sla_hours: 0, assigned_team: 'x' }, 'a', NOW_MS)).toThrow(/sla_hours/);
    expect(() => s.create(TENANT, { code: 'BADS2', name: 'x', priority: 'P1', sla_hours: SLA_HOURS_MAX + 1, assigned_team: 'x' }, 'a', NOW_MS)).toThrow(/sla_hours/);
    expect(() => s.create(TENANT, { code: 'NOTEAM', name: 'x', priority: 'P1', sla_hours: 4, assigned_team: '' }, 'a', NOW_MS)).toThrow(/assigned_team/);
  });

  it('update edits fields + throws unknown_case_type', () => {
    const s = fresh();
    const row = s.list(TENANT)[0];
    const up = s.update(TENANT, row.case_type_id, { priority: 'P3', sla_hours: 48, assigned_team: 'New Team' }, NOW_MS);
    expect(up.priority).toBe('P3');
    expect(up.sla_hours).toBe(48);
    expect(up.assigned_team).toBe('New Team');
    expect(() => s.update(TENANT, 'cty-NOPE-9999', { sla_hours: 1 }, NOW_MS)).toThrow(/unknown case type/);
  });

  it('remove drops the row + throws on miss', () => {
    const s = fresh();
    const row = s.list(TENANT)[0];
    s.remove(TENANT, row.case_type_id);
    expect(s.list(TENANT).length).toBe(3);
    expect(() => s.remove(TENANT, row.case_type_id)).toThrow(/unknown case type/);
  });

  it('enforces the per-tenant cap', () => {
    const s = fresh();
    for (let i = s.list(TENANT).length; i < CASE_TYPES_PER_TENANT_MAX; i++) {
      s.create(TENANT, { code: `T${i}`, name: `T${i}`, priority: 'P4', sla_hours: 24, assigned_team: 'Team' }, 'a', NOW_MS);
    }
    expect(() => s.create(TENANT, { code: 'OVERFLOW', name: 'x', priority: 'P4', sla_hours: 24, assigned_team: 'Team' }, 'a', NOW_MS)).toThrow(/cap/);
  });

  it('is tenant-scoped', () => {
    const s = fresh();
    const c = s.create(TENANT, { code: 'ONLYBANK', name: 'x', priority: 'P1', sla_hours: 4, assigned_team: 'x' }, 'a', NOW_MS);
    expect(s.get('BIL', c.case_type_id)).toBeNull();
  });
});

// ─── Routes ──────────────────────────────────────────────────────────

describe('case_type_config — routes', () => {
  beforeEach(() => _resetCaseTypeConfigStore());

  it('GET /case-types returns seeded; ?priority filters', async () => {
    const all = await request(app()).get('/v1/config/case-types').set(H);
    expect(all.status).toBe(200);
    expect(all.body.body.total).toBe(4);
    const p1 = await request(app()).get('/v1/config/case-types?priority=P1').set(H);
    expect(p1.body.body.case_types.every((c: CaseTypeConfig) => c.priority === 'P1')).toBe(true);
    expect(p1.body.body.case_types.length).toBe(1);
  });

  it('GET /case-types/summary returns priority counts + SLA stats (literal not captured by :id)', async () => {
    const r = await request(app()).get('/v1/config/case-types/summary').set(H);
    expect(r.status).toBe(200);
    expect(r.body.body.by_priority).toEqual({ P1: 1, P2: 1, P3: 1, P4: 1 });
    expect(r.body.body.fastest_sla_hours).toBe(4);
  });

  it('POST creates (201) + 409 dup + 400 bad priority/sla', async () => {
    const ok = await request(app()).post('/v1/config/case-types').set(H).send({ code: 'AML_ESC', name: 'AML Escalation', priority: 'P1', sla_hours: 6, assigned_team: 'Compliance' });
    expect(ok.status).toBe(201);
    expect(ok.body.body.code).toBe('AML_ESC');
    const dup = await request(app()).post('/v1/config/case-types').set(H).send({ code: 'FRAUD_INVESTIGATION', name: 'dup', priority: 'P1', sla_hours: 4, assigned_team: 'x' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EWS_409_duplicate_code');
    const badP = await request(app()).post('/v1/config/case-types').set(H).send({ code: 'BADP', name: 'x', priority: 'P9', sla_hours: 4, assigned_team: 'x' });
    expect(badP.status).toBe(400);
    expect(badP.body.error.code).toBe('EWS_400_invalid_priority');
    const badS = await request(app()).post('/v1/config/case-types').set(H).send({ code: 'BADS', name: 'x', priority: 'P1', sla_hours: -1, assigned_team: 'x' });
    expect(badS.status).toBe(400);
    expect(badS.body.error.code).toBe('EWS_400_invalid_sla');
  });

  it('GET /:id 200 then 404', async () => {
    const list = await request(app()).get('/v1/config/case-types').set(H);
    const id = list.body.body.case_types[0].case_type_id;
    expect((await request(app()).get(`/v1/config/case-types/${id}`).set(H)).status).toBe(200);
    const miss = await request(app()).get('/v1/config/case-types/cty-NOPE-9999').set(H);
    expect(miss.status).toBe(404);
    expect(miss.body.error.code).toBe('EWS_404_unknown_case_type');
  });

  it('PATCH updates; 404 on unknown', async () => {
    const list = await request(app()).get('/v1/config/case-types').set(H);
    const id = list.body.body.case_types[0].case_type_id;
    const up = await request(app()).patch(`/v1/config/case-types/${id}`).set(H).send({ sla_hours: 12, priority: 'P2' });
    expect(up.status).toBe(200);
    expect(up.body.body.sla_hours).toBe(12);
    expect(up.body.body.priority).toBe('P2');
    expect((await request(app()).patch('/v1/config/case-types/cty-NOPE-9999').set(H).send({ sla_hours: 1 })).status).toBe(404);
  });

  it('DELETE 204 then 404', async () => {
    const list = await request(app()).get('/v1/config/case-types').set(H);
    const id = list.body.body.case_types[0].case_type_id;
    expect((await request(app()).delete(`/v1/config/case-types/${id}`).set(H)).status).toBe(204);
    expect((await request(app()).delete(`/v1/config/case-types/${id}`).set(H)).status).toBe(404);
  });

  it('non-admin → 403; missing tenant header → 400', async () => {
    expect((await request(app('field_officer')).get('/v1/config/case-types').set(H)).status).toBe(403);
    expect((await request(app()).get('/v1/config/case-types').set({ 'X-Channel': 'API' })).status).toBe(400);
  });

  it('cross-tenant isolation — BIL case type invisible to BANK_DEMO', async () => {
    const bilH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'x-apex-user': 'bil.admin' };
    const created = await request(app()).post('/v1/config/case-types').set(bilH).send({ code: 'BILONLY', name: 'x', priority: 'P1', sla_hours: 4, assigned_team: 'x' });
    expect(created.status).toBe(201);
    const bank = await request(app()).get('/v1/config/case-types').set(H);
    expect(bank.body.body.case_types.every((c: CaseTypeConfig) => c.code !== 'BILONLY')).toBe(true);
  });
});
