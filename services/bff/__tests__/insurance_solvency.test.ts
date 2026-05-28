// services/bff/__tests__/insurance_solvency.test.ts
//
// Coverage for Insurance EWS Module 4 — Solvency Watch. Pure builders
// (dashboard, forecast, compliance) + the 3 BFF routes.

import request from 'supertest';
import {
  buildSolvencyDashboard,
  forecastSolvency,
  listComplianceAlerts,
  statusFor,
  CONTROL_LEVEL,
  WATCH_CEILING,
  SOLVENCY_HORIZONS,
  STRESS_SCENARIOS,
  ALERT_SEVERITIES,
  SolvencyError,
} from '../src/insurance_solvency';
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

// ─── statusFor ────────────────────────────────────────────────────────────

describe('statusFor', () => {
  test('boundary mapping around the 1.50 control level + 1.60 watch ceiling', () => {
    expect(statusFor(1.49)).toBe('breach');
    expect(statusFor(CONTROL_LEVEL)).toBe('watch');
    expect(statusFor(1.59)).toBe('watch');
    expect(statusFor(WATCH_CEILING)).toBe('compliant');
    expect(statusFor(2.1)).toBe('compliant');
  });
});

// ─── buildSolvencyDashboard ──────────────────────────────────────────────

describe('buildSolvencyDashboard — pure builder', () => {
  test('shape — current + 4 widgets', () => {
    const d = buildSolvencyDashboard('BANK_DEMO', NOW);
    expect(d.tenant_id).toBe('BANK_DEMO');
    expect(d.generated_at).toBe(NOW.toISOString());
    expect(d.current).toBeDefined();
    expect(Array.isArray(d.forecast_trend)).toBe(true);
    expect(Array.isArray(d.capital_stress_simulation)).toBe(true);
    expect(Array.isArray(d.compliance_alerts)).toBe(true);
  });

  test('deterministic — same (tenant, day) identical', () => {
    const a = buildSolvencyDashboard('BANK_DEMO', NOW);
    const b = buildSolvencyDashboard('BANK_DEMO', NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('tenant divergence — BIL has a smaller required margin (scaled)', () => {
    const bank = buildSolvencyDashboard('BANK_DEMO', NOW);
    const bil = buildSolvencyDashboard('BIL', NOW);
    expect(bil.current.required_solvency_margin_kes).toBeLessThan(bank.current.required_solvency_margin_kes);
  });

  test('current snapshot — ratio = ASM/RSM, status matches statusFor', () => {
    const d = buildSolvencyDashboard('BANK_DEMO', NOW);
    const c = d.current;
    expect(c.solvency_ratio).toBeCloseTo(c.available_solvency_margin_kes / c.required_solvency_margin_kes, 2);
    expect(c.status).toBe(statusFor(c.solvency_ratio));
    expect(c.control_level).toBe(CONTROL_LEVEL);
  });

  test('forecast trend — 12 actual + current + 3 forward, forward flagged', () => {
    const d = buildSolvencyDashboard('BANK_DEMO', NOW);
    expect(d.forecast_trend).toHaveLength(16); // 12 trailing + current + 3 forward
    const fwd = d.forecast_trend.filter((p) => p.is_forecast);
    expect(fwd).toHaveLength(3);
    for (const p of d.forecast_trend) expect(p.status).toBe(statusFor(p.solvency_ratio));
  });

  test('capital stress simulation — 3 scenarios, severe ≤ adverse ≤ baseline ratio', () => {
    const d = buildSolvencyDashboard('BANK_DEMO', NOW);
    expect(d.capital_stress_simulation.map((s) => s.scenario)).toEqual(['baseline', 'adverse', 'severe']);
    const [base, adv, sev] = d.capital_stress_simulation;
    expect(base.projected_ratio).toBeGreaterThanOrEqual(adv.projected_ratio);
    expect(adv.projected_ratio).toBeGreaterThanOrEqual(sev.projected_ratio);
    for (const s of d.capital_stress_simulation) {
      expect(s.breach_probability).toBeGreaterThanOrEqual(0);
      expect(s.breach_probability).toBeLessThanOrEqual(1);
      expect(s.capital_shortfall_kes).toBeGreaterThanOrEqual(0);
    }
  });

  test('compliance_alerts are all open + sorted critical-first', () => {
    const d = buildSolvencyDashboard('BANK_DEMO', NOW);
    for (const a of d.compliance_alerts) expect(a.status).toBe('open');
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < d.compliance_alerts.length; i++) {
      expect(rank[d.compliance_alerts[i - 1].severity]).toBeLessThanOrEqual(rank[d.compliance_alerts[i].severity]);
    }
  });

  test('totals — open/critical counts + min_forecast_ratio consistent', () => {
    const d = buildSolvencyDashboard('BANK_DEMO', NOW);
    expect(d.totals.open_alerts).toBe(d.compliance_alerts.length);
    expect(d.totals.critical_alerts).toBe(d.compliance_alerts.filter((a) => a.severity === 'critical').length);
    const fwdMin = Math.min(...d.forecast_trend.filter((p) => p.is_forecast).map((p) => p.solvency_ratio));
    expect(d.totals.min_forecast_ratio).toBeCloseTo(fwdMin, 4);
  });

  test('empty tenant_id throws', () => {
    expect(() => buildSolvencyDashboard('', NOW)).toThrow(SolvencyError);
  });
});

// ─── forecastSolvency ─────────────────────────────────────────────────────

describe('forecastSolvency — ad-hoc', () => {
  test('from current_ratio — no claims growth ≈ baseline', () => {
    const f = forecastSolvency({ current_ratio: 1.8, claims_growth_pct: 0 }, NOW);
    expect(f.baseline_ratio).toBe(1.8);
    expect(f.projected_ratio).toBeCloseTo(1.8, 1);
    expect(f.capital_shortfall_kes).toBeNull();
  });

  test('claims growth erodes the ratio', () => {
    const calm = forecastSolvency({ current_ratio: 1.8, claims_growth_pct: 0 }, NOW);
    const stressed = forecastSolvency({ current_ratio: 1.8, claims_growth_pct: 0.4 }, NOW);
    expect(stressed.projected_ratio).toBeLessThan(calm.projected_ratio);
  });

  test('severe scenario drags harder than baseline', () => {
    const base = forecastSolvency({ current_ratio: 1.8, claims_growth_pct: 0.3, scenario: 'baseline' }, NOW);
    const severe = forecastSolvency({ current_ratio: 1.8, claims_growth_pct: 0.3, scenario: 'severe' }, NOW);
    expect(severe.projected_ratio).toBeLessThan(base.projected_ratio);
  });

  test('longer horizon compounds the drag', () => {
    const h30 = forecastSolvency({ current_ratio: 1.8, claims_growth_pct: 0.3, horizon_days: 30 }, NOW);
    const h90 = forecastSolvency({ current_ratio: 1.8, claims_growth_pct: 0.3, horizon_days: 90 }, NOW);
    expect(h90.projected_ratio).toBeLessThanOrEqual(h30.projected_ratio);
  });

  test('ASM/RSM path computes ratio + capital_shortfall', () => {
    const f = forecastSolvency(
      { available_solvency_margin_kes: 9_000_000_000, required_solvency_margin_kes: 5_000_000_000, claims_growth_pct: 0.5, horizon_days: 90, scenario: 'severe' },
      NOW,
    );
    expect(f.baseline_ratio).toBeCloseTo(1.8, 2);
    expect(f.capital_shortfall_kes).not.toBeNull();
    expect(f.capital_shortfall_kes).toBeGreaterThanOrEqual(0);
  });

  test('status + breach_probability move with the projection', () => {
    const f = forecastSolvency({ current_ratio: 1.55, claims_growth_pct: 0.5, scenario: 'severe', horizon_days: 90 }, NOW);
    expect(f.status).toBe(statusFor(f.projected_ratio));
    expect(f.breach_probability).toBeGreaterThan(0);
  });

  test('deterministic', () => {
    const a = forecastSolvency({ current_ratio: 1.7, claims_growth_pct: 0.2 }, NOW);
    const b = forecastSolvency({ current_ratio: 1.7, claims_growth_pct: 0.2 }, NOW);
    expect(a.projected_ratio).toBe(b.projected_ratio);
  });

  test('drivers sorted by absolute contribution', () => {
    const f = forecastSolvency({ current_ratio: 1.8, claims_growth_pct: 0.3, premium_growth_pct: 0.1 }, NOW);
    for (let i = 1; i < f.drivers.length; i++) {
      expect(Math.abs(f.drivers[i - 1].contribution)).toBeGreaterThanOrEqual(Math.abs(f.drivers[i].contribution));
    }
  });

  test('missing inputs throws', () => {
    expect(() => forecastSolvency({}, NOW)).toThrow(SolvencyError);
  });
  test('invalid horizon throws', () => {
    expect(() => forecastSolvency({ current_ratio: 1.8, horizon_days: 45 }, NOW)).toThrow(/horizon/);
  });
  test('invalid scenario throws', () => {
    expect(() => forecastSolvency({ current_ratio: 1.8, scenario: 'apocalypse' }, NOW)).toThrow(/scenario/);
  });
  test('negative growth throws', () => {
    expect(() => forecastSolvency({ current_ratio: 1.8, claims_growth_pct: -0.1 }, NOW)).toThrow(SolvencyError);
  });
  test('RSM ≤ 0 throws', () => {
    expect(() =>
      forecastSolvency({ available_solvency_margin_kes: 5_000_000, required_solvency_margin_kes: 0 }, NOW),
    ).toThrow(SolvencyError);
  });
});

// ─── listComplianceAlerts ─────────────────────────────────────────────────

describe('listComplianceAlerts — pure builder', () => {
  test('returns alerts with IRDAI regulator', () => {
    const l = listComplianceAlerts('BANK_DEMO', NOW);
    expect(l.severity_filter).toBe('all');
    for (const a of l.alerts) expect(a.regulator).toBe('IRDAI');
  });

  test('severity filter narrows', () => {
    const l = listComplianceAlerts('BANK_DEMO', NOW, { severity: 'critical' });
    for (const a of l.alerts) expect(a.severity).toBe('critical');
  });

  test('status filter narrows', () => {
    const l = listComplianceAlerts('BANK_DEMO', NOW, { status: 'open' });
    for (const a of l.alerts) expect(a.status).toBe('open');
  });

  test('invalid severity throws', () => {
    expect(() => listComplianceAlerts('BANK_DEMO', NOW, { severity: 'nonsense' })).toThrow(SolvencyError);
  });

  test('invalid status throws', () => {
    expect(() => listComplianceAlerts('BANK_DEMO', NOW, { status: 'nonsense' })).toThrow(SolvencyError);
  });

  test('sorted critical-first', () => {
    const l = listComplianceAlerts('BANK_DEMO', NOW);
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < l.alerts.length; i++) {
      expect(rank[l.alerts[i - 1].severity]).toBeLessThanOrEqual(rank[l.alerts[i].severity]);
    }
  });
});

// ─── enum exports ─────────────────────────────────────────────────────────

describe('exports', () => {
  test('control level + watch ceiling', () => {
    expect(CONTROL_LEVEL).toBe(1.5);
    expect(WATCH_CEILING).toBe(1.6);
  });
  test('horizons + scenarios + severities', () => {
    expect(SOLVENCY_HORIZONS).toEqual([30, 60, 90]);
    expect(STRESS_SCENARIOS).toEqual(['baseline', 'adverse', 'severe']);
    expect(ALERT_SEVERITIES).toEqual(['info', 'warning', 'critical']);
  });
});

// ─── routes ─────────────────────────────────────────────────────────────

describe('GET /v1/insurance/solvency/dashboard', () => {
  test('admin happy path — enveloped', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/solvency/dashboard').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.current).toBeDefined();
    expect(r.body.body.capital_stress_simulation).toBeDefined();
  });

  test('field_officer (read) accepted', async () => {
    const r = await request(makeInsApp('field_officer').app).get('/v1/insurance/solvency/dashboard').set(TH);
    expect(r.status).toBe(200);
  });

  test('tenant scoping — BIL diverges', async () => {
    const bank = await request(makeInsApp('admin').app).get('/v1/insurance/solvency/dashboard').set(TH);
    const bil = await request(makeInsApp('admin').app).get('/v1/insurance/solvency/dashboard').set(TH_BIL);
    expect(bil.body.body.current.required_solvency_margin_kes).toBeLessThan(
      bank.body.body.current.required_solvency_margin_kes,
    );
  });

  test('missing tenant header → 400', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/solvency/dashboard').set({ 'X-Channel': 'API' });
    expect(r.status).toBe(400);
  });
});

describe('POST /v1/insurance/solvency/forecast', () => {
  test('analyst happy path', async () => {
    const r = await request(makeInsApp('risk_analyst').app)
      .post('/v1/insurance/solvency/forecast')
      .set(TH)
      .send({ current_ratio: 1.7, claims_growth_pct: 0.3, scenario: 'adverse', horizon_days: 90 });
    expect(r.status).toBe(200);
    expect(r.body.body.projected_ratio).toBeGreaterThan(0);
    expect(r.body.body.status).toBeDefined();
  });

  test('enveloped body accepted', async () => {
    const r = await request(makeInsApp('admin').app)
      .post('/v1/insurance/solvency/forecast')
      .set(TH)
      .send({ header: {}, body: { current_ratio: 1.9, claims_growth_pct: 0.1 } });
    expect(r.status).toBe(200);
    expect(r.body.body.baseline_ratio).toBe(1.9);
  });

  test('missing inputs → 400', async () => {
    const r = await request(makeInsApp('admin').app).post('/v1/insurance/solvency/forecast').set(TH).send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('invalid horizon → 400', async () => {
    const r = await request(makeInsApp('admin').app)
      .post('/v1/insurance/solvency/forecast')
      .set(TH)
      .send({ current_ratio: 1.8, horizon_days: 45 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_horizon');
  });

  test('field_officer lacks forecast scope → 403', async () => {
    const r = await request(makeInsApp('field_officer').app)
      .post('/v1/insurance/solvency/forecast')
      .set(TH)
      .send({ current_ratio: 1.8 });
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/insurance/solvency/compliance', () => {
  test('admin happy path', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/solvency/compliance').set(TH);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.body.alerts)).toBe(true);
  });

  test('supervisor accepted', async () => {
    const r = await request(makeInsApp('supervisor').app).get('/v1/insurance/solvency/compliance').set(TH);
    expect(r.status).toBe(200);
  });

  test('?severity=critical narrows', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/solvency/compliance?severity=critical').set(TH);
    for (const a of r.body.body.alerts) expect(a.severity).toBe('critical');
  });

  test('?severity=bogus → 400', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/solvency/compliance?severity=bogus').set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('risk_analyst lacks compliance:read → 403', async () => {
    const r = await request(makeInsApp('risk_analyst').app).get('/v1/insurance/solvency/compliance').set(TH);
    expect(r.status).toBe(403);
  });
});
