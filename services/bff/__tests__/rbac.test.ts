import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
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

/** App factory using the *real* default getRole (header-based). */
function makeRealApp() {
  return makeApp({
    source: new StaticSource([fixture()]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
  });
}

describe('bff — RBAC enforcement', () => {
  test('GET /healthz is unauthenticated', async () => {
    const { app } = makeRealApp();
    expect((await request(app).get('/healthz')).status).toBe(200);
  });

  test('GET /api/alerts without role → 401', async () => {
    const { app } = makeRealApp();
    const r = await request(app).get('/api/alerts');
    expect(r.status).toBe(401);
  });

  test('GET /v1/alerts with field_officer is allowed (alerts:list)', async () => {
    const { app } = makeRealApp();
    const r = await request(app).get('/v1/alerts').set('x-apex-role', 'field_officer');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
  });

  test('POST /v1/ews/evaluate without role → 401', async () => {
    const { app } = makeRealApp();
    // T4.19: tenant headers required even on unauth path; we still want
    // the role check (not the tenant check) to be the gate that rejects.
    const r = await request(app)
      .post('/v1/ews/evaluate')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' })
      .send({ customer_id: 'c-1', features: { utilization: 0.5 } });
    expect(r.status).toBe(401);
  });

  test('POST /v1/ews/evaluate with risk_analyst role passes', async () => {
    const { app } = makeRealApp();
    const r = await request(app)
      .post('/v1/ews/evaluate')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' })
      .set('x-apex-role', 'risk_analyst')
      .send({ customer_id: 'c-1', features: { utilization: 0.5 } });
    expect(r.status).toBe(200);
    expect(typeof r.body.body.pd).toBe('number');
  });

  test('GET /v1/risk-profile/c-101 with field_officer is allowed', async () => {
    const { app } = makeRealApp();
    const r = await request(app)
      .get('/v1/risk-profile/c-101')
      .set('x-apex-role', 'field_officer');
    expect(r.status).toBe(200);
    expect(r.body.id).toBe('c-101');
  });

  test('GET /v1/risk-profile with unknown role → 403', async () => {
    const { app } = makeRealApp();
    const r = await request(app)
      .get('/v1/risk-profile/c-101')
      .set('x-apex-role', 'ghost');
    expect(r.status).toBe(403);
  });

  test('POST /v1/action with field_officer is allowed (cases:log_action)', async () => {
    // Note: caseAction is UnavailableCaseActionSink → 503 from upstream proxy,
    // but RBAC must pass first (we want 503 not 403/401).
    const { app } = makeRealApp();
    const r = await request(app)
      .post('/v1/action')
      .set('x-apex-role', 'field_officer')
      .send({ case_id: 'case-1', kind: 'call', officer_id: 'fo' });
    expect(r.status).toBe(503);  // RBAC passed; upstream cases-svc unconfigured
  });

  test('POST /v1/action without role → 401, never reaches upstream', async () => {
    const { app } = makeRealApp();
    const r = await request(app)
      .post('/v1/action')
      .send({ case_id: 'case-1', kind: 'call', officer_id: 'fo' });
    expect(r.status).toBe(401);
  });
});
