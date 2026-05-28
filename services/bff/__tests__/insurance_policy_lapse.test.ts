// services/bff/__tests__/insurance_policy_lapse.test.ts
//
// Coverage for Insurance EWS Module 1 — Policy Lapse Risk. Pure builders
// (dashboard, high-risk list, ad-hoc predict) + the 3 BFF routes.

import request from 'supertest';
import {
  buildPolicyLapseDashboard,
  listHighRiskPolicies,
  predictPolicyLapse,
  bandFor,
  LAPSE_HORIZONS,
  RETENTION_BANDS,
  PolicyLapseError,
} from '../src/insurance_policy_lapse';
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

// ─── bandFor helper ────────────────────────────────────────────────────

describe('bandFor', () => {
  test('boundary mapping', () => {
    expect(bandFor(0.0)).toBe('low');
    expect(bandFor(0.24)).toBe('low');
    expect(bandFor(0.25)).toBe('medium');
    expect(bandFor(0.49)).toBe('medium');
    expect(bandFor(0.5)).toBe('high');
    expect(bandFor(0.74)).toBe('high');
    expect(bandFor(0.75)).toBe('critical');
    expect(bandFor(1.0)).toBe('critical');
  });
});

// ─── buildPolicyLapseDashboard ──────────────────────────────────────────

describe('buildPolicyLapseDashboard — pure builder', () => {
  test('shape — totals + 5 widget arrays', () => {
    const d = buildPolicyLapseDashboard('BANK_DEMO', NOW);
    expect(d.tenant_id).toBe('BANK_DEMO');
    expect(d.generated_at).toBe(NOW.toISOString());
    expect(d.totals.in_force_policies).toBeGreaterThan(0);
    expect(Array.isArray(d.high_risk_policies)).toBe(true);
    expect(Array.isArray(d.upcoming_lapse_trend)).toBe(true);
    expect(Array.isArray(d.channel_lapse_risk)).toBe(true);
    expect(Array.isArray(d.region_lapse_risk)).toBe(true);
    expect(Array.isArray(d.top_retention_opportunities)).toBe(true);
  });

  test('deterministic — same (tenant, day) yields identical payload', () => {
    const a = buildPolicyLapseDashboard('BANK_DEMO', NOW);
    const b = buildPolicyLapseDashboard('BANK_DEMO', NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('different tenants diverge in scale (BIL < BANK_DEMO)', () => {
    const bank = buildPolicyLapseDashboard('BANK_DEMO', NOW);
    const bil = buildPolicyLapseDashboard('BIL', NOW);
    expect(bil.totals.in_force_policies).toBeLessThan(bank.totals.in_force_policies);
  });

  test('high_risk_policies — capped at 10, sorted by lapse_probability desc', () => {
    const d = buildPolicyLapseDashboard('BANK_DEMO', NOW);
    expect(d.high_risk_policies.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < d.high_risk_policies.length; i++) {
      expect(d.high_risk_policies[i - 1].lapse_probability).toBeGreaterThanOrEqual(
        d.high_risk_policies[i].lapse_probability,
      );
    }
  });

  test('every probability in [0,1] and band matches bandFor', () => {
    const d = buildPolicyLapseDashboard('BANK_DEMO', NOW);
    for (const p of d.high_risk_policies) {
      expect(p.lapse_probability).toBeGreaterThanOrEqual(0);
      expect(p.lapse_probability).toBeLessThanOrEqual(1);
      expect(p.retention_risk_band).toBe(bandFor(p.lapse_probability));
    }
  });

  test('at_risk totals partition — critical + high counts agree with band filter', () => {
    const d = buildPolicyLapseDashboard('BANK_DEMO', NOW);
    expect(d.totals.at_risk_policies).toBe(d.totals.critical_count + d.totals.high_count);
  });

  test('upcoming_lapse_trend — 12 weekly points, dates strictly increasing', () => {
    const d = buildPolicyLapseDashboard('BANK_DEMO', NOW);
    expect(d.upcoming_lapse_trend).toHaveLength(12);
    for (let i = 1; i < d.upcoming_lapse_trend.length; i++) {
      expect(d.upcoming_lapse_trend[i].date > d.upcoming_lapse_trend[i - 1].date).toBe(true);
    }
  });

  test('channel + region widgets cover every enum value', () => {
    const d = buildPolicyLapseDashboard('BANK_DEMO', NOW);
    expect(d.channel_lapse_risk).toHaveLength(5);
    expect(d.region_lapse_risk).toHaveLength(5);
  });

  test('top_retention_opportunities — capped at 5, expected_gwp_saved present', () => {
    const d = buildPolicyLapseDashboard('BANK_DEMO', NOW);
    expect(d.top_retention_opportunities.length).toBeLessThanOrEqual(5);
    for (const o of d.top_retention_opportunities) {
      expect(o.expected_gwp_saved_kes).toBeGreaterThanOrEqual(0);
      expect(o.expected_gwp_saved_kes).toBeLessThanOrEqual(o.gwp_kes);
    }
  });

  test('empty tenant_id throws', () => {
    expect(() => buildPolicyLapseDashboard('', NOW)).toThrow(PolicyLapseError);
  });
});

// ─── listHighRiskPolicies ────────────────────────────────────────────────

describe('listHighRiskPolicies — pure builder', () => {
  test('returns only high + critical bands by default', () => {
    const l = listHighRiskPolicies('BANK_DEMO', NOW);
    expect(l.band_filter).toBe('all');
    for (const p of l.policies) {
      expect(['high', 'critical']).toContain(p.retention_risk_band);
    }
  });

  test('band=critical narrows to critical only', () => {
    const l = listHighRiskPolicies('BANK_DEMO', NOW, { band: 'critical' });
    for (const p of l.policies) expect(p.retention_risk_band).toBe('critical');
  });

  test('limit caps the returned rows', () => {
    const l = listHighRiskPolicies('BANK_DEMO', NOW, { limit: 3 });
    expect(l.policies.length).toBeLessThanOrEqual(3);
  });

  test('horizon_days honoured + echoed', () => {
    for (const h of LAPSE_HORIZONS) {
      const l = listHighRiskPolicies('BANK_DEMO', NOW, { horizon_days: h });
      expect(l.horizon_days).toBe(h);
    }
  });

  test('invalid horizon throws invalid_horizon', () => {
    expect(() => listHighRiskPolicies('BANK_DEMO', NOW, { horizon_days: 45 })).toThrow(
      /horizon/,
    );
  });

  test('invalid band throws', () => {
    expect(() => listHighRiskPolicies('BANK_DEMO', NOW, { band: 'nonsense' })).toThrow(
      PolicyLapseError,
    );
  });

  test('sorted by lapse_probability desc', () => {
    const l = listHighRiskPolicies('BANK_DEMO', NOW);
    for (let i = 1; i < l.policies.length; i++) {
      expect(l.policies[i - 1].lapse_probability).toBeGreaterThanOrEqual(
        l.policies[i].lapse_probability,
      );
    }
  });
});

// ─── predictPolicyLapse ──────────────────────────────────────────────────

describe('predictPolicyLapse — ad-hoc scoring', () => {
  test('healthy customer scores low', () => {
    const p = predictPolicyLapse(
      { customer_id: 'C1', missed_instalments_12m: 0, days_since_last_payment: 10, tenure_months: 60 },
      NOW,
    );
    expect(p.lapse_probability).toBeLessThan(0.5);
    expect(p.renewal_probability).toBeCloseTo(1 - p.lapse_probability, 4);
  });

  test('stressed customer scores higher than healthy', () => {
    const healthy = predictPolicyLapse(
      { customer_id: 'C1', missed_instalments_12m: 0, days_since_last_payment: 10 },
      NOW,
    );
    const stressed = predictPolicyLapse(
      { customer_id: 'C1', missed_instalments_12m: 5, days_since_last_payment: 200, prior_lapses: 2 },
      NOW,
    );
    expect(stressed.lapse_probability).toBeGreaterThan(healthy.lapse_probability);
  });

  test('deterministic — same inputs yield same score', () => {
    const a = predictPolicyLapse({ customer_id: 'C9', missed_instalments_12m: 3 }, NOW);
    const b = predictPolicyLapse({ customer_id: 'C9', missed_instalments_12m: 3 }, NOW);
    expect(a.lapse_probability).toBe(b.lapse_probability);
  });

  test('probability clamped to [0,1] under extreme inputs', () => {
    const p = predictPolicyLapse(
      { customer_id: 'C1', missed_instalments_12m: 99, days_since_last_payment: 9999, prior_lapses: 99 },
      NOW,
    );
    expect(p.lapse_probability).toBeLessThanOrEqual(1);
    expect(p.lapse_probability).toBeGreaterThanOrEqual(0);
  });

  test('band matches bandFor(probability)', () => {
    const p = predictPolicyLapse({ customer_id: 'C1', missed_instalments_12m: 4, days_since_last_payment: 120 }, NOW);
    expect(p.retention_risk_band).toBe(bandFor(p.lapse_probability));
  });

  test('top_drivers sorted by absolute contribution desc', () => {
    const p = predictPolicyLapse(
      { customer_id: 'C1', missed_instalments_12m: 3, days_since_last_payment: 90, prior_lapses: 1 },
      NOW,
    );
    for (let i = 1; i < p.top_drivers.length; i++) {
      expect(Math.abs(p.top_drivers[i - 1].contribution)).toBeGreaterThanOrEqual(
        Math.abs(p.top_drivers[i].contribution),
      );
    }
  });

  test('longer horizon raises risk', () => {
    const h30 = predictPolicyLapse({ customer_id: 'C1', missed_instalments_12m: 2, horizon_days: 30 }, NOW);
    const h90 = predictPolicyLapse({ customer_id: 'C1', missed_instalments_12m: 2, horizon_days: 90 }, NOW);
    expect(h90.lapse_probability).toBeGreaterThanOrEqual(h30.lapse_probability);
  });

  test('missing customer_id throws', () => {
    expect(() => predictPolicyLapse({} as never, NOW)).toThrow(PolicyLapseError);
  });

  test('invalid horizon throws', () => {
    expect(() => predictPolicyLapse({ customer_id: 'C1', horizon_days: 45 }, NOW)).toThrow(/horizon/);
  });

  test('negative behaviour signal throws', () => {
    expect(() => predictPolicyLapse({ customer_id: 'C1', missed_instalments_12m: -1 }, NOW)).toThrow(
      PolicyLapseError,
    );
  });

  test('non-finite signal throws', () => {
    expect(() =>
      predictPolicyLapse({ customer_id: 'C1', days_since_last_payment: Infinity }, NOW),
    ).toThrow(PolicyLapseError);
  });
});

// ─── enum exports ─────────────────────────────────────────────────────────

describe('exports', () => {
  test('RETENTION_BANDS canonical order', () => {
    expect(RETENTION_BANDS).toEqual(['low', 'medium', 'high', 'critical']);
  });
  test('LAPSE_HORIZONS canonical', () => {
    expect(LAPSE_HORIZONS).toEqual([30, 60, 90]);
  });
});

// ─── routes ────────────────────────────────────────────────────────────────

describe('GET /v1/insurance/policy-lapse/dashboard', () => {
  test('admin happy path — enveloped', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/policy-lapse/dashboard').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
    expect(r.body.body.high_risk_policies).toBeDefined();
  });

  test('field_officer (read role) accepted', async () => {
    const r = await request(makeInsApp('field_officer').app).get('/v1/insurance/policy-lapse/dashboard').set(TH);
    expect(r.status).toBe(200);
  });

  test('tenant scoping — BIL diverges from BANK_DEMO', async () => {
    const bank = await request(makeInsApp('admin').app).get('/v1/insurance/policy-lapse/dashboard').set(TH);
    const bil = await request(makeInsApp('admin').app).get('/v1/insurance/policy-lapse/dashboard').set(TH_BIL);
    expect(bil.body.body.tenant_id).toBe('BIL');
    expect(bil.body.body.totals.in_force_policies).toBeLessThan(bank.body.body.totals.in_force_policies);
  });

  test('missing tenant header → 400 envelope', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/policy-lapse/dashboard').set({ 'X-Channel': 'API' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/X-Tenant-ID/);
  });
});

describe('GET /v1/insurance/policy-lapse/high-risk', () => {
  test('happy path — only high+critical', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/policy-lapse/high-risk').set(TH);
    expect(r.status).toBe(200);
    for (const p of r.body.body.policies) {
      expect(['high', 'critical']).toContain(p.retention_risk_band);
    }
  });

  test('?band=critical narrows', async () => {
    const r = await request(makeInsApp('admin').app)
      .get('/v1/insurance/policy-lapse/high-risk?band=critical')
      .set(TH);
    expect(r.status).toBe(200);
    for (const p of r.body.body.policies) expect(p.retention_risk_band).toBe('critical');
  });

  test('?horizon_days=45 → 400 invalid_horizon', async () => {
    const r = await request(makeInsApp('admin').app)
      .get('/v1/insurance/policy-lapse/high-risk?horizon_days=45')
      .set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_horizon');
  });

  test('?limit=2 caps rows', async () => {
    const r = await request(makeInsApp('admin').app)
      .get('/v1/insurance/policy-lapse/high-risk?limit=2')
      .set(TH);
    expect(r.body.body.policies.length).toBeLessThanOrEqual(2);
  });
});

describe('POST /v1/insurance/policy-lapse/predict', () => {
  test('analyst happy path — raw body', async () => {
    const r = await request(makeInsApp('risk_analyst').app)
      .post('/v1/insurance/policy-lapse/predict')
      .set(TH)
      .send({ customer_id: 'C100', missed_instalments_12m: 4, days_since_last_payment: 120 });
    expect(r.status).toBe(200);
    expect(r.body.body.lapse_probability).toBeGreaterThan(0);
    expect(r.body.body.retention_risk_band).toBeDefined();
  });

  test('enveloped {header, body} request accepted', async () => {
    const r = await request(makeInsApp('admin').app)
      .post('/v1/insurance/policy-lapse/predict')
      .set(TH)
      .send({ header: {}, body: { customer_id: 'C200', missed_instalments_12m: 1 } });
    expect(r.status).toBe(200);
    expect(r.body.body.customer_id).toBe('C200');
  });

  test('missing customer_id → 400', async () => {
    const r = await request(makeInsApp('admin').app).post('/v1/insurance/policy-lapse/predict').set(TH).send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('field_officer lacks predict scope → 403', async () => {
    const r = await request(makeInsApp('field_officer').app)
      .post('/v1/insurance/policy-lapse/predict')
      .set(TH)
      .send({ customer_id: 'C1' });
    expect(r.status).toBe(403);
  });
});
