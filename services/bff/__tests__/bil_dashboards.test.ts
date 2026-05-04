// services/bff/__tests__/bil_dashboards.test.ts
//
// Coverage for the BIL Claims dashboard (T6 M11.1) — both the pure
// builder and the BFF route.

import request from 'supertest';
import { buildClaimsDashboard } from '../src/bil_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');

function makeBilApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('buildClaimsDashboard — pure builder', () => {
  test('shape — totals + 3 panel arrays', () => {
    const d = buildClaimsDashboard('BIL', NOW);
    expect(d.tenant_id).toBe('BIL');
    expect(d.as_of).toBe(NOW.toISOString());
    expect(d.totals.claims_filed_30d).toBeGreaterThan(0);
    expect(d.totals.claims_closed_30d).toBeLessThanOrEqual(d.totals.claims_filed_30d);
    expect(d.totals.fraud_flagged_pct).toBeGreaterThan(0);
    expect(d.totals.average_tat_hours).toBeGreaterThan(0);
    expect(Array.isArray(d.abnormal_claim_patterns)).toBe(true);
    expect(d.abnormal_claim_patterns.length).toBe(4);
    expect(Array.isArray(d.flagged_hospitals)).toBe(true);
    expect(d.flagged_hospitals.length).toBe(5);
    expect(Array.isArray(d.turnaround_anomalies)).toBe(true);
    expect(d.turnaround_anomalies.length).toBe(6);
  });

  test('deterministic — same (tenant, day) → identical payload', () => {
    const a = buildClaimsDashboard('BANK_DEMO', NOW);
    const b = buildClaimsDashboard('BANK_DEMO', NOW);
    expect(a).toEqual(b);
  });

  test('different tenants get different scale + content', () => {
    const bil = buildClaimsDashboard('BIL', NOW);
    const bank = buildClaimsDashboard('BANK_DEMO', NOW);
    // BIL operates at smaller scale (60% multiplier); BANK_DEMO claims_filed
    // should be measurably higher.
    expect(bank.totals.claims_filed_30d).toBeGreaterThan(bil.totals.claims_filed_30d);
  });

  test('flagged_hospitals are ranked 1..5 in fraud_score order', () => {
    const d = buildClaimsDashboard('BIL', NOW);
    expect(d.flagged_hospitals.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5]);
    // The seed catalog declares fraud_score as 0.9, 0.8, 0.7, … with noise;
    // rank 1 should have fraud_score >= rank 5's.
    expect(d.flagged_hospitals[0]!.fraud_score).toBeGreaterThanOrEqual(
      d.flagged_hospitals[4]!.fraud_score,
    );
  });

  test('every abnormal pattern has a known severity bucket', () => {
    const d = buildClaimsDashboard('BANK_DEMO', NOW);
    for (const p of d.abnormal_claim_patterns) {
      expect(['critical', 'high', 'medium', 'low']).toContain(p.severity);
      expect(p.count_30d).toBeGreaterThanOrEqual(0);
    }
  });

  test('turnaround anomalies have actual_tat > expected_tat', () => {
    const d = buildClaimsDashboard('BANK_DEMO', NOW);
    for (const t of d.turnaround_anomalies) {
      expect(t.actual_tat_hours).toBeGreaterThan(t.expected_tat_hours);
      expect(['pending', 'investigating', 'escalated']).toContain(t.status);
    }
  });
});

describe('GET /v1/dashboards/bil/claims', () => {
  const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };
  const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

  test('admin gets the enveloped dashboard payload', async () => {
    const { app } = makeBilApp();
    const r = await request(app).get('/v1/dashboards/bil/claims').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
    expect(r.body.body.as_of).toBe(NOW.toISOString());
    expect(r.body.body.totals.claims_filed_30d).toBeGreaterThan(0);
    expect(r.body.body.abnormal_claim_patterns).toHaveLength(4);
    expect(r.body.body.flagged_hospitals).toHaveLength(5);
    expect(r.body.body.turnaround_anomalies).toHaveLength(6);
  });

  test('BIL tenant gets a BIL-scoped payload', async () => {
    const { app } = makeBilApp();
    const r = await request(app).get('/v1/dashboards/bil/claims').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('non-admin without audit:read → 403', async () => {
    const { app } = makeBilApp('field_officer');
    const r = await request(app).get('/v1/dashboards/bil/claims').set(TH);
    expect(r.status).toBe(403);
  });

  test('missing tenant headers → 400 envelope', async () => {
    const { app } = makeBilApp();
    const r = await request(app).get('/v1/dashboards/bil/claims').set({ 'X-Channel': 'API' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400');
    expect(r.body.error.message).toMatch(/X-Tenant-ID/);
  });
});
