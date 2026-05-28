// services/bff/__tests__/insurance_claims_anomaly.test.ts
//
// Coverage for Insurance EWS Module 2 — Claims Anomaly. Pure builders
// (dashboard, suspicious list, ad-hoc analyze) + the 3 BFF routes.

import request from 'supertest';
import {
  buildClaimsAnomalyDashboard,
  listSuspiciousClaims,
  analyzeClaim,
  severityFor,
  ANOMALY_SEVERITIES,
  ANOMALY_REASONS,
  ClaimsAnomalyError,
} from '../src/insurance_claims_anomaly';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-28T12:00:00.000Z');

function makeInsApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── severityFor ─────────────────────────────────────────────────────────

describe('severityFor', () => {
  test('boundary mapping', () => {
    expect(severityFor(0)).toBe('low');
    expect(severityFor(0.24)).toBe('low');
    expect(severityFor(0.25)).toBe('medium');
    expect(severityFor(0.49)).toBe('medium');
    expect(severityFor(0.5)).toBe('high');
    expect(severityFor(0.74)).toBe('high');
    expect(severityFor(0.75)).toBe('critical');
    expect(severityFor(1)).toBe('critical');
  });
});

// ─── buildClaimsAnomalyDashboard ─────────────────────────────────────────

describe('buildClaimsAnomalyDashboard — pure builder', () => {
  test('shape — totals + 4 widget arrays', () => {
    const d = buildClaimsAnomalyDashboard('BANK_DEMO', NOW);
    expect(d.tenant_id).toBe('BANK_DEMO');
    expect(d.generated_at).toBe(NOW.toISOString());
    expect(d.totals.claims_scored).toBeGreaterThan(0);
    expect(Array.isArray(d.suspicious_claims_queue)).toBe(true);
    expect(Array.isArray(d.fraud_score_distribution)).toBe(true);
    expect(Array.isArray(d.claims_heatmap)).toBe(true);
    expect(Array.isArray(d.siu_investigation_queue)).toBe(true);
  });

  test('deterministic — same (tenant, day) yields identical payload', () => {
    const a = buildClaimsAnomalyDashboard('BANK_DEMO', NOW);
    const b = buildClaimsAnomalyDashboard('BANK_DEMO', NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('tenant divergence — BIL scored fewer claims than BANK_DEMO', () => {
    const bank = buildClaimsAnomalyDashboard('BANK_DEMO', NOW);
    const bil = buildClaimsAnomalyDashboard('BIL', NOW);
    expect(bil.totals.claims_scored).toBeLessThan(bank.totals.claims_scored);
  });

  test('suspicious queue — capped at 10, sorted by anomaly_score desc', () => {
    const d = buildClaimsAnomalyDashboard('BANK_DEMO', NOW);
    expect(d.suspicious_claims_queue.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < d.suspicious_claims_queue.length; i++) {
      expect(d.suspicious_claims_queue[i - 1].anomaly_score).toBeGreaterThanOrEqual(
        d.suspicious_claims_queue[i].anomaly_score,
      );
    }
  });

  test('every score in [0,1] + severity matches severityFor', () => {
    const d = buildClaimsAnomalyDashboard('BANK_DEMO', NOW);
    for (const c of d.suspicious_claims_queue) {
      expect(c.anomaly_score).toBeGreaterThanOrEqual(0);
      expect(c.anomaly_score).toBeLessThanOrEqual(1);
      expect(c.severity).toBe(severityFor(c.anomaly_score));
      expect(c.fraud_probability).toBeGreaterThanOrEqual(0);
      expect(c.fraud_probability).toBeLessThanOrEqual(1);
    }
  });

  test('suspicious totals partition — critical + high = suspicious_claims', () => {
    const d = buildClaimsAnomalyDashboard('BANK_DEMO', NOW);
    expect(d.totals.suspicious_claims).toBe(d.totals.critical_count + d.totals.high_count);
  });

  test('fraud_score_distribution — 5 buckets, counts sum to claims_scored', () => {
    const d = buildClaimsAnomalyDashboard('BANK_DEMO', NOW);
    expect(d.fraud_score_distribution).toHaveLength(5);
    const sum = d.fraud_score_distribution.reduce((a, b) => a + b.count, 0);
    expect(sum).toBe(d.totals.claims_scored);
  });

  test('claims_heatmap — 25 cells (5 types × 5 regions)', () => {
    const d = buildClaimsAnomalyDashboard('BANK_DEMO', NOW);
    expect(d.claims_heatmap).toHaveLength(25);
  });

  test('siu_investigation_queue — capped at 12, sorted by fraud_probability desc', () => {
    const d = buildClaimsAnomalyDashboard('BANK_DEMO', NOW);
    expect(d.siu_investigation_queue.length).toBeLessThanOrEqual(12);
    for (let i = 1; i < d.siu_investigation_queue.length; i++) {
      expect(d.siu_investigation_queue[i - 1].fraud_probability).toBeGreaterThanOrEqual(
        d.siu_investigation_queue[i].fraud_probability,
      );
    }
  });

  test('empty tenant_id throws', () => {
    expect(() => buildClaimsAnomalyDashboard('', NOW)).toThrow(ClaimsAnomalyError);
  });
});

// ─── listSuspiciousClaims ────────────────────────────────────────────────

describe('listSuspiciousClaims — pure builder', () => {
  test('default returns only high + critical', () => {
    const l = listSuspiciousClaims('BANK_DEMO', NOW);
    expect(l.severity_filter).toBe('all');
    for (const c of l.claims) expect(['high', 'critical']).toContain(c.severity);
  });

  test('severity=critical narrows', () => {
    const l = listSuspiciousClaims('BANK_DEMO', NOW, { severity: 'critical' });
    for (const c of l.claims) expect(c.severity).toBe('critical');
  });

  test('limit caps rows', () => {
    const l = listSuspiciousClaims('BANK_DEMO', NOW, { limit: 3 });
    expect(l.claims.length).toBeLessThanOrEqual(3);
  });

  test('invalid severity throws', () => {
    expect(() => listSuspiciousClaims('BANK_DEMO', NOW, { severity: 'nonsense' })).toThrow(
      ClaimsAnomalyError,
    );
  });

  test('sorted by anomaly_score desc', () => {
    const l = listSuspiciousClaims('BANK_DEMO', NOW);
    for (let i = 1; i < l.claims.length; i++) {
      expect(l.claims[i - 1].anomaly_score).toBeGreaterThanOrEqual(l.claims[i].anomaly_score);
    }
  });
});

// ─── analyzeClaim ────────────────────────────────────────────────────────

describe('analyzeClaim — ad-hoc scoring', () => {
  test('clean claim scores low + no SIU', () => {
    const r = analyzeClaim(
      { customer_id: 'C1', claims_in_90d: 1, amount_vs_policy_avg: 1, signature_match_score: 1 },
      NOW,
    );
    expect(r.anomaly_score).toBeLessThan(0.5);
    expect(r.siu_recommended).toBe(false);
  });

  test('suspicious claim scores higher than clean', () => {
    const clean = analyzeClaim({ customer_id: 'C1', claims_in_90d: 1, amount_vs_policy_avg: 1 }, NOW);
    const sus = analyzeClaim(
      {
        customer_id: 'C1',
        claims_in_90d: 6,
        amount_vs_policy_avg: 2.5,
        signature_match_score: 0.2,
        is_duplicate: true,
        days_since_last_claim: 3,
      },
      NOW,
    );
    expect(sus.anomaly_score).toBeGreaterThan(clean.anomaly_score);
  });

  test('duplicate claim flags duplicate_claim reason', () => {
    const r = analyzeClaim({ customer_id: 'C1', is_duplicate: true }, NOW);
    expect(r.anomaly_reasons).toContain('duplicate_claim');
  });

  test('deterministic — same inputs same score', () => {
    const a = analyzeClaim({ customer_id: 'C9', claims_in_90d: 4 }, NOW);
    const b = analyzeClaim({ customer_id: 'C9', claims_in_90d: 4 }, NOW);
    expect(a.anomaly_score).toBe(b.anomaly_score);
  });

  test('clamped to [0,1] under extreme inputs', () => {
    const r = analyzeClaim(
      { customer_id: 'C1', claims_in_90d: 99, amount_vs_policy_avg: 99, signature_match_score: 0, is_duplicate: true, days_since_last_claim: 0, documents_off_template: 9 },
      NOW,
    );
    expect(r.anomaly_score).toBeLessThanOrEqual(1);
    expect(r.anomaly_score).toBeGreaterThanOrEqual(0);
  });

  test('severity matches severityFor + drivers sorted desc', () => {
    const r = analyzeClaim(
      { customer_id: 'C1', claims_in_90d: 5, amount_vs_policy_avg: 2, signature_match_score: 0.3 },
      NOW,
    );
    expect(r.severity).toBe(severityFor(r.anomaly_score));
    for (let i = 1; i < r.drivers.length; i++) {
      expect(r.drivers[i - 1].contribution).toBeGreaterThanOrEqual(r.drivers[i].contribution);
    }
  });

  test('high score recommends SIU', () => {
    const r = analyzeClaim(
      { customer_id: 'C1', claims_in_90d: 8, amount_vs_policy_avg: 3, signature_match_score: 0.1, is_duplicate: true },
      NOW,
    );
    expect(['high', 'critical']).toContain(r.severity);
    expect(r.siu_recommended).toBe(true);
  });

  test('missing customer_id throws', () => {
    expect(() => analyzeClaim({} as never, NOW)).toThrow(ClaimsAnomalyError);
  });

  test('signature_match_score out of [0,1] throws', () => {
    expect(() => analyzeClaim({ customer_id: 'C1', signature_match_score: 1.5 }, NOW)).toThrow(
      ClaimsAnomalyError,
    );
  });

  test('negative signal throws', () => {
    expect(() => analyzeClaim({ customer_id: 'C1', claims_in_90d: -1 }, NOW)).toThrow(ClaimsAnomalyError);
  });

  test('non-finite signal throws', () => {
    expect(() => analyzeClaim({ customer_id: 'C1', amount_vs_policy_avg: Infinity }, NOW)).toThrow(
      ClaimsAnomalyError,
    );
  });
});

// ─── enum exports ─────────────────────────────────────────────────────────

describe('exports', () => {
  test('ANOMALY_SEVERITIES canonical order', () => {
    expect(ANOMALY_SEVERITIES).toEqual(['low', 'medium', 'high', 'critical']);
  });
  test('ANOMALY_REASONS has 6 reasons', () => {
    expect(ANOMALY_REASONS).toHaveLength(6);
  });
});

// ─── routes ─────────────────────────────────────────────────────────────

describe('GET /v1/insurance/claims-anomaly/dashboard', () => {
  test('admin happy path — enveloped', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/claims-anomaly/dashboard').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
    expect(r.body.body.suspicious_claims_queue).toBeDefined();
  });

  test('field_officer (read role) accepted', async () => {
    const r = await request(makeInsApp('field_officer').app).get('/v1/insurance/claims-anomaly/dashboard').set(TH);
    expect(r.status).toBe(200);
  });

  test('tenant scoping — BIL diverges', async () => {
    const bank = await request(makeInsApp('admin').app).get('/v1/insurance/claims-anomaly/dashboard').set(TH);
    const bil = await request(makeInsApp('admin').app).get('/v1/insurance/claims-anomaly/dashboard').set(TH_BIL);
    expect(bil.body.body.totals.claims_scored).toBeLessThan(bank.body.body.totals.claims_scored);
  });

  test('missing tenant header → 400', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/claims-anomaly/dashboard').set({ 'X-Channel': 'API' });
    expect(r.status).toBe(400);
  });
});

describe('GET /v1/insurance/claims-anomaly/suspicious', () => {
  test('happy path — only high+critical', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/claims-anomaly/suspicious').set(TH);
    expect(r.status).toBe(200);
    for (const c of r.body.body.claims) expect(['high', 'critical']).toContain(c.severity);
  });

  test('?severity=critical narrows', async () => {
    const r = await request(makeInsApp('admin').app)
      .get('/v1/insurance/claims-anomaly/suspicious?severity=critical')
      .set(TH);
    for (const c of r.body.body.claims) expect(c.severity).toBe('critical');
  });

  test('?severity=bogus → 400 invalid_severity', async () => {
    const r = await request(makeInsApp('admin').app)
      .get('/v1/insurance/claims-anomaly/suspicious?severity=bogus')
      .set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_severity');
  });
});

describe('POST /v1/insurance/claims-anomaly/analyze', () => {
  test('analyst happy path', async () => {
    const r = await request(makeInsApp('risk_analyst').app)
      .post('/v1/insurance/claims-anomaly/analyze')
      .set(TH)
      .send({ customer_id: 'C100', claims_in_90d: 5, amount_vs_policy_avg: 2, is_duplicate: true });
    expect(r.status).toBe(200);
    expect(r.body.body.anomaly_score).toBeGreaterThan(0);
    expect(r.body.body.severity).toBeDefined();
  });

  test('enveloped body accepted', async () => {
    const r = await request(makeInsApp('admin').app)
      .post('/v1/insurance/claims-anomaly/analyze')
      .set(TH)
      .send({ header: {}, body: { customer_id: 'C200', claims_in_90d: 2 } });
    expect(r.status).toBe(200);
    expect(r.body.body.customer_id).toBe('C200');
  });

  test('missing customer_id → 400', async () => {
    const r = await request(makeInsApp('admin').app).post('/v1/insurance/claims-anomaly/analyze').set(TH).send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('field_officer lacks analyze scope → 403', async () => {
    const r = await request(makeInsApp('field_officer').app)
      .post('/v1/insurance/claims-anomaly/analyze')
      .set(TH)
      .send({ customer_id: 'C1' });
    expect(r.status).toBe(403);
  });
});
