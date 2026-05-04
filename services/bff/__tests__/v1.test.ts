import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import {
  CaseActionError,
  HttpCaseActionSink,
  UnavailableCaseActionSink,
  type CaseActionInput,
  type CaseActionSink,
} from '../src/case_action';
import type { CanonicalAlert } from '../src/types';

const NOW = new Date('2026-04-27T12:00:00.000Z');

function fixture(overrides: Partial<CanonicalAlert> = {}): CanonicalAlert {
  return {
    alert_id: 'a-1',
    raised_at: '2026-04-27T11:30:00.000Z',
    customer_id: 'c-101',
    severity: 'CRITICAL',
    rule_id: 'r-22',
    indicators_fired: ['IND_BEH_03'],
    ...overrides,
  };
}

function makeV1App(overrides: { caseAction?: CaseActionSink } = {}) {
  return makeApp({
    source: new StaticSource([fixture()]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: overrides.caseAction ?? new UnavailableCaseActionSink(),
    now: () => NOW,
    // RBAC is exercised separately in rbac.test.ts; this suite asserts business
    // logic, so inject an admin getRole to bypass the matrix here.
    getRole: () => 'admin',
  });
}

describe('GET /v1/alerts (public alias of /api/alerts, T4.24 enveloped)', () => {
  const TENANT_HEADERS = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

  test('returns the same data wrapped in the bank-grade envelope', async () => {
    const { app } = makeV1App();
    const a = await request(app).get('/api/alerts');
    const b = await request(app).get('/v1/alerts').set(TENANT_HEADERS);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // /api/alerts stays raw for the SPA; /v1/alerts is enveloped.
    expect(b.body.header.status).toBe('SUCCESS');
    expect(b.body.body).toEqual(a.body);
  });

  test('honours ?severity= filter', async () => {
    const { app } = makeV1App();
    const r = await request(app).get('/v1/alerts?severity=critical').set(TENANT_HEADERS);
    expect(r.body.body.total).toBe(1);
  });

  test('400 envelope for invalid severity', async () => {
    const { app } = makeV1App();
    const r = await request(app).get('/v1/alerts?severity=ULTRA').set(TENANT_HEADERS);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400');
    expect(r.body.error.message).toMatch(/severity must be one of/);
  });

  test('400 envelope when X-Tenant-ID missing', async () => {
    const { app } = makeV1App();
    const r = await request(app).get('/v1/alerts').set({ 'X-Channel': 'API' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/X-Tenant-ID/);
  });
});

describe('POST /v1/ews/evaluate', () => {
  // T4.19 — endpoint now requires X-Tenant-ID + X-Channel and returns the
  // bank-grade {header, body} envelope. Helper centralises the headers so
  // assertions focus on body content.
  const TENANT_HEADERS = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

  test('returns a score envelope for given features', async () => {
    const { app } = makeV1App();
    const r = await request(app)
      .post('/v1/ews/evaluate')
      .set(TENANT_HEADERS)
      .send({
        customer_id: 'c-test',
        features: {
          utilization: 0.95,
          dpd_max_90d: 60,
          bureau_score: 540,
          tenure_months: 18,
        },
      });
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.header.code).toBe('EWS_200');
    expect(typeof r.body.header.requestId).toBe('string');
    expect(r.body.header.timestamp).toBeDefined();
    const score = r.body.body;
    expect(score.customer_id).toBe('c-test');
    expect(typeof score.pd).toBe('number');
    expect(['Low', 'Medium', 'High']).toContain(score.level);
    expect(Array.isArray(score.top_reasons)).toBe(true);
    const abs = score.top_reasons.map((x: { shap_value: number }) => Math.abs(x.shap_value));
    for (let i = 1; i < abs.length; i++) {
      expect(abs[i - 1]).toBeGreaterThanOrEqual(abs[i]);
    }
    expect(score.model_name).toBe('pd_xgboost');
    expect(score.model_version).toBe('0.1.0');
  });

  test('400 envelope when neither customer_id nor features supplied', async () => {
    const { app } = makeV1App();
    const r = await request(app).post('/v1/ews/evaluate').set(TENANT_HEADERS).send({});
    expect(r.status).toBe(400);
    expect(r.body.header.status).toBe('FAILURE');
    expect(r.body.error.code).toBe('EWS_400');
    expect(r.body.error.severity).toBe('MEDIUM');
    expect(r.body.error.message).toMatch(/customer_id or features/);
  });

  test('low-risk inputs map to Low level', async () => {
    const { app } = makeV1App();
    const r = await request(app)
      .post('/v1/ews/evaluate')
      .set(TENANT_HEADERS)
      .send({
        customer_id: 'c-low',
        features: {
          utilization: 0.1,
          dpd_max_90d: 0,
          bureau_score: 820,
          tenure_months: 60,
        },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.level).toBe('Low');
  });

  test('echoes caller-supplied requestId in the response header', async () => {
    const { app } = makeV1App();
    const requestId = '11111111-2222-3333-4444-555555555555';
    const r = await request(app)
      .post('/v1/ews/evaluate')
      .set(TENANT_HEADERS)
      .send({
        header: {
          tenantId: 'BANK_DEMO',
          channel: 'API',
          requestId,
          timestamp: '2026-05-03T12:00:00.000Z',
        },
        body: { customer_id: 'c-1', features: { utilization: 0.5, dpd_max_90d: 0, bureau_score: 700, tenure_months: 24 } },
      });
    expect(r.status).toBe(200);
    expect(r.body.header.requestId).toBe(requestId);
  });

  test('400 envelope when X-Tenant-ID missing', async () => {
    const { app } = makeV1App();
    const r = await request(app)
      .post('/v1/ews/evaluate')
      .set({ 'X-Channel': 'API' })
      .send({ customer_id: 'c-1' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400');
    expect(r.body.error.message).toMatch(/X-Tenant-ID/);
  });

  test('400 envelope when X-Channel missing', async () => {
    const { app } = makeV1App();
    const r = await request(app)
      .post('/v1/ews/evaluate')
      .set({ 'X-Tenant-ID': 'BANK_DEMO' })
      .send({ customer_id: 'c-1' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/X-Channel/);
  });

  test('403 envelope when tenant unknown', async () => {
    const { app } = makeV1App();
    const r = await request(app)
      .post('/v1/ews/evaluate')
      .set({ 'X-Tenant-ID': 'NOPE', 'X-Channel': 'API' })
      .send({ customer_id: 'c-1' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('EWS_403');
    expect(r.body.error.message).toMatch(/not registered/);
  });

  test('403 envelope when channel not allowed for tenant', async () => {
    const { app } = makeV1App();
    // BIL allows ['BRANCH','AGENT_PORTAL','API']; LOS is bank-only.
    const r = await request(app)
      .post('/v1/ews/evaluate')
      .set({ 'X-Tenant-ID': 'BIL', 'X-Channel': 'LOS' })
      .send({ customer_id: 'c-1' });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/channel 'LOS' not permitted/);
  });
});

describe('GET /v1/risk-profile/:customer_id (T4.24 enveloped)', () => {
  const TENANT_HEADERS = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

  test('returns the canned profile wrapped in envelope for a known customer', async () => {
    const { app } = makeV1App();
    const r = await request(app).get('/v1/risk-profile/c-101').set(TENANT_HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.id).toBe('c-101');
    expect(r.body.body.name).toBe('Achieng Otieno');
    expect(r.body.body.level).toBe('High');
    expect(r.body.body.top_reasons).toHaveLength(5);
    expect(r.body.body.model_name).toBe('pd_xgboost');
  });

  test('404 envelope for an unknown customer', async () => {
    const { app } = makeV1App();
    const r = await request(app).get('/v1/risk-profile/c-nope').set(TENANT_HEADERS);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404');
    expect(r.body.error.severity).toBe('LOW');
    expect(r.body.error.message).toMatch(/c-nope not found/);
  });

  test('400 envelope when tenant headers missing', async () => {
    const { app } = makeV1App();
    const r = await request(app).get('/v1/risk-profile/c-101');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400');
  });
});

describe('POST /v1/action (T4.24 enveloped)', () => {
  const TENANT_HEADERS = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

  test('proxies to the cases service and returns 201 envelope', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          id: 'case-501',
          state: 'in_action',
          actions: [{ action_id: 'act-1', kind: 'call' }],
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const sink = new HttpCaseActionSink('http://cases:8083', fakeFetch as never);
    const { app } = makeV1App({ caseAction: sink });

    const r = await request(app)
      .post('/v1/action')
      .set(TENANT_HEADERS)
      .send({
        case_id: 'case-501',
        kind: 'call',
        officer_id: 'fiona.field',
        outcome_note: 'Promised by Friday',
      });
    expect(r.status).toBe(201);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.header.code).toBe('EWS_201');
    expect(r.body.body.state).toBe('in_action');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://cases:8083/cases/case-501/actions');
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent).toMatchObject({ kind: 'call', officer_id: 'fiona.field' });
  });

  test('400 envelope when case_id / kind / officer_id missing', async () => {
    const { app } = makeV1App();
    const r = await request(app).post('/v1/action').set(TENANT_HEADERS).send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400');
    expect(r.body.error.message).toMatch(/case_id is required/);
    expect(r.body.error.message).toMatch(/kind/);
    expect(r.body.error.message).toMatch(/officer_id is required/);
  });

  test('400 envelope on bad GPS', async () => {
    const { app } = makeV1App();
    const r = await request(app)
      .post('/v1/action')
      .set(TENANT_HEADERS)
      .send({
        case_id: 'case-501',
        kind: 'visit',
        officer_id: 'fo',
        gps: { lat: 'nope', lng: 36.82 },
      });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/gps/);
  });

  test('forwards upstream errors as enterprise error envelope with their status', async () => {
    const failing: CaseActionSink = {
      log: async (_input: CaseActionInput) => {
        throw new CaseActionError(409, 'cannot logAction a case in state open', {
          current_state: 'open',
          attempted: 'logAction',
        });
      },
    };
    const { app } = makeV1App({ caseAction: failing });
    const r = await request(app)
      .post('/v1/action')
      .set(TENANT_HEADERS)
      .send({ case_id: 'case-503', kind: 'call', officer_id: 'fo' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409');
    expect(r.body.error.message).toMatch(/cannot logAction/);
    expect(r.body.error.detail.current_state).toBe('open');
  });

  test('503 envelope when cases service is not configured', async () => {
    const { app } = makeV1App({ caseAction: new UnavailableCaseActionSink() });
    const r = await request(app)
      .post('/v1/action')
      .set(TENANT_HEADERS)
      .send({ case_id: 'case-501', kind: 'call', officer_id: 'fo' });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('EWS_503');
    expect(r.body.error.message).toMatch(/APEX_CASES_URL/);
  });

  test('accepts wrapped {header, body} request envelope', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ id: 'case-501', state: 'in_action', actions: [] }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const sink = new HttpCaseActionSink('http://cases:8083', fakeFetch as never);
    const { app } = makeV1App({ caseAction: sink });
    const requestId = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    const r = await request(app)
      .post('/v1/action')
      .set(TENANT_HEADERS)
      .send({
        header: { tenantId: 'BANK_DEMO', channel: 'API', requestId, timestamp: '2026-05-03T12:00:00.000Z' },
        body: { case_id: 'case-501', kind: 'call', officer_id: 'fo' },
      });
    expect(r.status).toBe(201);
    expect(r.body.header.requestId).toBe(requestId);
  });
});

// T4.24 Phase 9 — multi-tenant introspection endpoints.
describe('GET /v1/tenants/me + GET /v1/tenants (T4.24 Phase 9)', () => {
  const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };
  const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

  test('GET /v1/tenants/me returns the caller\'s tenant from X-Tenant-ID', async () => {
    const { app } = makeV1App();
    const r = await request(app).get('/v1/tenants/me').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
    expect(r.body.body.vertical).toBe('banking');
    // Channels must be exposed so admins know which channels are allowed.
    expect(r.body.body.channels_allowed).toEqual(expect.arrayContaining(['API']));
  });

  test('GET /v1/tenants/me returns BIL when caller is in BIL', async () => {
    const { app } = makeV1App();
    const r = await request(app).get('/v1/tenants/me').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.vertical).toBe('insurance');
  });

  test('GET /v1/tenants/me requires tenant context — 400 envelope when missing', async () => {
    const { app } = makeV1App();
    const r = await request(app).get('/v1/tenants/me').set({ 'X-Channel': 'API' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400');
  });

  test('GET /v1/tenants admin lists every configured tenant', async () => {
    const { app } = makeV1App();
    const r = await request(app).get('/v1/tenants').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(Array.isArray(r.body.body.items)).toBe(true);
    expect(r.body.body.total).toBeGreaterThanOrEqual(2);
    const ids = r.body.body.items.map((t: { tenant_id: string }) => t.tenant_id).sort();
    expect(ids).toEqual(expect.arrayContaining(['BANK_DEMO', 'BIL']));
  });

  test('GET /v1/tenants requires admin (audit:read)', async () => {
    // makeV1App sets getRole=admin; build a fresh app with field_officer
    // to assert the RBAC gate.
    const { makeApp } = jest.requireActual('../src/server') as typeof import('../src/server');
    const { StaticSource } = jest.requireActual('../src/source') as typeof import('../src/source');
    const { StubEvaluator } = jest.requireActual('../src/score') as typeof import('../src/score');
    const { StubRiskProfileSource } = jest.requireActual('../src/risk_profile') as typeof import('../src/risk_profile');
    const { UnavailableCaseActionSink } = jest.requireActual('../src/case_action') as typeof import('../src/case_action');
    const fieldOnly = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      now: () => NOW,
      getRole: () => 'field_officer',
    });
    const r = await request(fieldOnly.app).get('/v1/tenants').set(TH);
    expect(r.status).toBe(403);
  });
});

// T4.24 Phase 10 — tenant mutation endpoints. Each test runs against a
// fresh app (and therefore a fresh defaultTenantLookup) so create/delete
// across tests don't leak.
describe('Tenant mutations: POST + PATCH + DELETE /v1/tenants (T4.24 Phase 10)', () => {
  const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

  test('POST /v1/tenants creates a new tenant + returns 201 envelope', async () => {
    const { app } = makeV1App();
    const r = await request(app).post('/v1/tenants').set(TH).send({
      tenant_id: 'TEST_BANK',
      name: 'Test Bank',
      vertical: 'banking',
      channels_allowed: ['API', 'MOBILE'],
    });
    expect(r.status).toBe(201);
    expect(r.body.header.code).toBe('EWS_201');
    expect(r.body.body.tenant_id).toBe('TEST_BANK');
    expect(r.body.body.vertical).toBe('banking');
    expect(r.body.body.active).toBe(true);
    // Round-trip: the new tenant shows up in /v1/tenants
    const list = await request(app).get('/v1/tenants').set(TH);
    const ids = list.body.body.items.map((t: { tenant_id: string }) => t.tenant_id);
    expect(ids).toContain('TEST_BANK');
  });

  test('POST /v1/tenants — 409 envelope on duplicate', async () => {
    const { app } = makeV1App();
    const dup = {
      tenant_id: 'BANK_DEMO',
      name: 'Duplicate',
      vertical: 'banking',
      channels_allowed: ['API'],
    };
    const r = await request(app).post('/v1/tenants').set(TH).send(dup);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409');
    expect(r.body.error.detail.tenant_id).toBe('BANK_DEMO');
  });

  test('POST /v1/tenants — 400 envelope when tenant_id is malformed', async () => {
    const { app } = makeV1App();
    const r = await request(app).post('/v1/tenants').set(TH).send({
      tenant_id: 'lowercase-bad',
      name: 'X',
      vertical: 'banking',
      channels_allowed: ['API'],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400');
    expect(r.body.error.message).toMatch(/tenant_id/);
  });

  test('POST /v1/tenants — 400 envelope on bad vertical', async () => {
    const { app } = makeV1App();
    const r = await request(app).post('/v1/tenants').set(TH).send({
      tenant_id: 'NEW_OK',
      name: 'X',
      vertical: 'crypto', // invalid
      channels_allowed: ['API'],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/vertical/);
  });

  test('POST /v1/tenants requires admin (audit:read)', async () => {
    const { makeApp } = jest.requireActual('../src/server') as typeof import('../src/server');
    const { StaticSource } = jest.requireActual('../src/source') as typeof import('../src/source');
    const { StubEvaluator } = jest.requireActual('../src/score') as typeof import('../src/score');
    const { StubRiskProfileSource } = jest.requireActual('../src/risk_profile') as typeof import('../src/risk_profile');
    const { UnavailableCaseActionSink } = jest.requireActual('../src/case_action') as typeof import('../src/case_action');
    const fieldOnly = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      now: () => NOW,
      getRole: () => 'field_officer',
    });
    const r = await request(fieldOnly.app).post('/v1/tenants').set(TH).send({
      tenant_id: 'NEW_TENANT',
      name: 'X',
      vertical: 'banking',
      channels_allowed: ['API'],
    });
    expect(r.status).toBe(403);
  });

  test('PATCH /v1/tenants/:id updates name + channels + active', async () => {
    const { app } = makeV1App();
    const r = await request(app).patch('/v1/tenants/BIL').set(TH).send({
      name: 'BIL Updated',
      channels_allowed: ['API'],
      active: false,
    });
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.name).toBe('BIL Updated');
    expect(r.body.body.channels_allowed).toEqual(['API']);
    expect(r.body.body.active).toBe(false);
  });

  test('PATCH /v1/tenants/:id — 404 envelope when tenant unknown', async () => {
    const { app } = makeV1App();
    const r = await request(app).patch('/v1/tenants/DOES_NOT_EXIST').set(TH).send({
      name: 'X',
    });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404');
  });

  test('PATCH /v1/tenants/:id — 400 envelope on invalid patch field', async () => {
    const { app } = makeV1App();
    const r = await request(app).patch('/v1/tenants/BIL').set(TH).send({
      active: 'yes', // must be boolean
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/active/);
  });

  test('DELETE /v1/tenants/:id removes a non-system tenant', async () => {
    const { app } = makeV1App();
    // Create a deletable one first.
    await request(app).post('/v1/tenants').set(TH).send({
      tenant_id: 'TEMP_TENANT',
      name: 'Temp',
      vertical: 'banking',
      channels_allowed: ['API'],
    });
    const d = await request(app).delete('/v1/tenants/TEMP_TENANT').set(TH);
    expect(d.status).toBe(204);
    // Subsequent delete returns 404 envelope
    const d2 = await request(app).delete('/v1/tenants/TEMP_TENANT').set(TH);
    expect(d2.status).toBe(404);
    expect(d2.body.error.code).toBe('EWS_404');
  });

  test('DELETE /v1/tenants/BANK_DEMO is refused with 409 (system-protected)', async () => {
    const { app } = makeV1App();
    const r = await request(app).delete('/v1/tenants/BANK_DEMO').set(TH);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409');
    expect(r.body.error.message).toMatch(/system-protected/);
    // Tenant must still exist after the refused delete
    const list = await request(app).get('/v1/tenants').set(TH);
    const ids = list.body.body.items.map((t: { tenant_id: string }) => t.tenant_id);
    expect(ids).toContain('BANK_DEMO');
  });
});
