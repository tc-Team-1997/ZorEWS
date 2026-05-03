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

describe('GET /v1/alerts (public alias of /api/alerts)', () => {
  test('returns the same shape', async () => {
    const { app } = makeV1App();
    const a = await request(app).get('/api/alerts');
    const b = await request(app).get('/v1/alerts');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
  });

  test('honours ?severity= filter', async () => {
    const { app } = makeV1App();
    const r = await request(app).get('/v1/alerts?severity=critical');
    expect(r.body.total).toBe(1);
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

describe('GET /v1/risk-profile/:customer_id', () => {
  test('returns the canned profile for a known customer', async () => {
    const { app } = makeV1App();
    const r = await request(app).get('/v1/risk-profile/c-101');
    expect(r.status).toBe(200);
    expect(r.body.id).toBe('c-101');
    expect(r.body.name).toBe('Achieng Otieno');
    expect(r.body.level).toBe('High');
    expect(r.body.top_reasons).toHaveLength(5);
    expect(r.body.model_name).toBe('pd_xgboost');
  });

  test('404 for an unknown customer', async () => {
    const { app } = makeV1App();
    const r = await request(app).get('/v1/risk-profile/c-nope');
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/c-nope not found/);
  });
});

describe('POST /v1/action', () => {
  test('proxies to the cases service when configured', async () => {
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

    const r = await request(app).post('/v1/action').send({
      case_id: 'case-501',
      kind: 'call',
      officer_id: 'fiona.field',
      outcome_note: 'Promised by Friday',
    });
    expect(r.status).toBe(201);
    expect(r.body.state).toBe('in_action');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://cases:8083/cases/case-501/actions');
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent).toMatchObject({ kind: 'call', officer_id: 'fiona.field' });
  });

  test('400 when case_id / kind / officer_id missing', async () => {
    const { app } = makeV1App();
    const r = await request(app).post('/v1/action').send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/case_id is required/);
    expect(r.body.error).toMatch(/kind/);
    expect(r.body.error).toMatch(/officer_id is required/);
  });

  test('400 on bad GPS', async () => {
    const { app } = makeV1App();
    const r = await request(app).post('/v1/action').send({
      case_id: 'case-501',
      kind: 'visit',
      officer_id: 'fo',
      gps: { lat: 'nope', lng: 36.82 },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/gps/);
  });

  test('forwards upstream errors with their status code', async () => {
    const failing: CaseActionSink = {
      log: async (_input: CaseActionInput) => {
        throw new CaseActionError(409, 'cannot logAction a case in state open', {
          current_state: 'open',
          attempted: 'logAction',
        });
      },
    };
    const { app } = makeV1App({ caseAction: failing });
    const r = await request(app).post('/v1/action').send({
      case_id: 'case-503',
      kind: 'call',
      officer_id: 'fo',
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cannot logAction/);
    expect(r.body.body.current_state).toBe('open');
  });

  test('503 when cases service is not configured', async () => {
    const { app } = makeV1App({ caseAction: new UnavailableCaseActionSink() });
    const r = await request(app).post('/v1/action').send({
      case_id: 'case-501',
      kind: 'call',
      officer_id: 'fo',
    });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/APEX_CASES_URL/);
  });
});
