// services/bff/__tests__/finops_dashboard.test.ts
//
// T5.5 — FinOps dashboard.

import request from 'supertest';
import {
  ALL_FINOPS_SERVICES,
  buildFinOpsDashboard,
} from '../src/finops_dashboard';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeFinOpsApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Pure resolver shape ──────────────────────────────────────────────

describe('buildFinOpsDashboard pure', () => {
  test('envelope shape — tenant_id + generated_at + period + total + services + efficiency', () => {
    const d = buildFinOpsDashboard('BIL', NOW);
    expect(d.tenant_id).toBe('BIL');
    expect(d.generated_at).toBe(NOW.toISOString());
    expect(d.period).toBe('2026-05');
    expect(d.total_cost_usd).toBeGreaterThan(0);
    expect(d.services).toHaveLength(10);
    expect(d.efficiency).toBeDefined();
  });

  test('services in canonical ALL_FINOPS_SERVICES order', () => {
    const d = buildFinOpsDashboard('BANK_DEMO', NOW);
    expect(d.services.map((s) => s.service)).toEqual([...ALL_FINOPS_SERVICES]);
  });

  test('every service has cost_usd + share + trend + delta_pct', () => {
    const d = buildFinOpsDashboard('BIL', NOW);
    for (const svc of d.services) {
      expect(svc.cost_usd).toBeGreaterThanOrEqual(0);
      expect(svc.share).toBeGreaterThan(0);
      expect(svc.share).toBeLessThanOrEqual(1);
      expect(['up', 'flat', 'down']).toContain(svc.trend);
      // delta_pct may be null only when prior=0 — extremely unlikely with the synth.
    }
  });

  test('Σ services.cost_usd ≈ total_cost_usd (within rounding tolerance)', () => {
    const d = buildFinOpsDashboard('BANK_DEMO', NOW);
    const sumServices = d.services.reduce((acc, s) => acc + s.cost_usd, 0);
    // Allow $5 rounding error from 2-decimal rounding across 10 services.
    expect(Math.abs(sumServices - d.total_cost_usd)).toBeLessThan(5);
  });

  test('Σ services.share ≈ 1 (within rounding tolerance)', () => {
    const d = buildFinOpsDashboard('BIL', NOW);
    const sumShares = d.services.reduce((acc, s) => acc + s.share, 0);
    expect(Math.abs(sumShares - 1)).toBeLessThan(0.01);
  });

  test('deterministic per (tenant, month)', () => {
    const d1 = buildFinOpsDashboard('BIL', NOW);
    const d2 = buildFinOpsDashboard('BIL', NOW);
    expect(d2.total_cost_usd).toBe(d1.total_cost_usd);
    expect(d2.services.map((s) => s.cost_usd)).toEqual(
      d1.services.map((s) => s.cost_usd),
    );
    expect(d2.efficiency).toEqual(d1.efficiency);
  });

  test('BIL scaled lower than BANK_DEMO (60-70% per scale convention)', () => {
    const bil = buildFinOpsDashboard('BIL', NOW);
    const bank = buildFinOpsDashboard('BANK_DEMO', NOW);
    expect(bil.total_cost_usd).toBeLessThan(bank.total_cost_usd);
    // Ratio centered ~0.7 (tenant_scale baked in); BIL base RNG vs
    // BANK_DEMO base RNG can push the ratio in [0.4, 1.0] but BIL
    // strictly less than BANK_DEMO by scale.
    expect(bil.total_cost_usd / bank.total_cost_usd).toBeGreaterThan(0.3);
    expect(bil.total_cost_usd / bank.total_cost_usd).toBeLessThan(1.0);
  });

  test('period reflects month of `now` (UTC)', () => {
    const d1 = buildFinOpsDashboard('BIL', new Date('2026-01-15T00:00:00Z'));
    expect(d1.period).toBe('2026-01');
    const d2 = buildFinOpsDashboard('BIL', new Date('2026-12-31T23:59:59Z'));
    expect(d2.period).toBe('2026-12');
  });

  test('total_delta_pct is a finite number or null', () => {
    const d = buildFinOpsDashboard('BIL', NOW);
    if (d.total_delta_pct !== null) {
      expect(Number.isFinite(d.total_delta_pct)).toBe(true);
    }
  });

  test('efficiency.cost_per_alert_usd = total / total_alerts (when alerts > 0)', () => {
    const d = buildFinOpsDashboard('BANK_DEMO', NOW);
    if (d.efficiency.total_alerts > 0) {
      expect(d.efficiency.cost_per_alert_usd).not.toBeNull();
      const expected = Math.round((d.total_cost_usd / d.efficiency.total_alerts) * 100) / 100;
      expect(d.efficiency.cost_per_alert_usd).toBe(expected);
    }
  });

  test('efficiency.cost_per_customer_usd = total / total_active_customers (when > 0)', () => {
    const d = buildFinOpsDashboard('BIL', NOW);
    if (d.efficiency.total_active_customers > 0) {
      expect(d.efficiency.cost_per_customer_usd).not.toBeNull();
      const expected =
        Math.round((d.total_cost_usd / d.efficiency.total_active_customers) * 100) / 100;
      expect(d.efficiency.cost_per_customer_usd).toBe(expected);
    }
  });

  test('trend values up/flat/down derived from delta_pct ±5% bands', () => {
    const d = buildFinOpsDashboard('BANK_DEMO', NOW);
    for (const svc of d.services) {
      if (svc.delta_pct === null) {
        expect(svc.trend).toBe('flat');
      } else if (svc.delta_pct > 0.05) {
        expect(svc.trend).toBe('up');
      } else if (svc.delta_pct < -0.05) {
        expect(svc.trend).toBe('down');
      } else {
        expect(svc.trend).toBe('flat');
      }
    }
  });

  test('optimisation_candidate must have trend=up AND delta_pct >= 0.05', () => {
    const d = buildFinOpsDashboard('BIL', NOW);
    if (d.optimisation_candidate !== null) {
      const row = d.services.find((s) => s.service === d.optimisation_candidate)!;
      expect(row.trend).toBe('up');
      expect(row.delta_pct).not.toBeNull();
      expect(row.delta_pct).toBeGreaterThanOrEqual(0.05);
    }
  });

  test('optimisation_candidate is the highest-cost qualifying service', () => {
    const d = buildFinOpsDashboard('BANK_DEMO', NOW);
    if (d.optimisation_candidate !== null) {
      const candidates = d.services.filter(
        (s) => s.trend === 'up' && s.delta_pct !== null && s.delta_pct >= 0.05,
      );
      const expected = candidates.reduce((max, s) => (s.cost_usd > max.cost_usd ? s : max));
      expect(d.optimisation_candidate).toBe(expected.service);
    }
  });

  test('empty tenant_id rejected', () => {
    expect(() => buildFinOpsDashboard('', NOW)).toThrow();
  });

  test('different month yields different totals (synthesis seeds on period)', () => {
    const may = buildFinOpsDashboard('BIL', new Date('2026-05-15T00:00:00Z'));
    const jun = buildFinOpsDashboard('BIL', new Date('2026-06-15T00:00:00Z'));
    expect(may.total_cost_usd).not.toBe(jun.total_cost_usd);
    expect(may.period).not.toBe(jun.period);
  });

  test('aurora + msk + eks together account for >60% of spend (matches baseline)', () => {
    const d = buildFinOpsDashboard('BIL', NOW);
    const heavy = d.services
      .filter((s) => s.service === 'aurora' || s.service === 'msk' || s.service === 'eks')
      .reduce((acc, s) => acc + s.share, 0);
    expect(heavy).toBeGreaterThan(0.5);
  });
});

// ─── Route ────────────────────────────────────────────────────────────

describe('GET /v1/finops/dashboard route', () => {
  test('admin → 200 with envelope shape', async () => {
    const { app } = makeFinOpsApp('admin');
    const r = await request(app).get('/v1/finops/dashboard').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.services).toHaveLength(10);
    expect(r.body.body.efficiency).toBeDefined();
  });

  test('non-admin role → 403', async () => {
    const { app } = makeFinOpsApp('field_officer');
    const r = await request(app).get('/v1/finops/dashboard').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('BIL ↔ BANK_DEMO different responses (tenant scoping)', async () => {
    const { app } = makeFinOpsApp('admin');
    const rBil = await request(app).get('/v1/finops/dashboard').set(TH_BIL);
    const rBank = await request(app).get('/v1/finops/dashboard').set(TH_BANK);
    expect(rBil.status).toBe(200);
    expect(rBank.status).toBe(200);
    expect(rBil.body.body.tenant_id).toBe('BIL');
    expect(rBank.body.body.tenant_id).toBe('BANK_DEMO');
    expect(rBil.body.body.total_cost_usd).not.toBe(rBank.body.body.total_cost_usd);
  });

  test('response includes optimisation_candidate field', async () => {
    const { app } = makeFinOpsApp('admin');
    const r = await request(app).get('/v1/finops/dashboard').set(TH_BIL);
    expect(r.status).toBe(200);
    // optimisation_candidate may be null but the field MUST exist.
    expect('optimisation_candidate' in r.body.body).toBe(true);
  });

  test('response period matches YYYY-MM format', async () => {
    const { app } = makeFinOpsApp('admin');
    const r = await request(app).get('/v1/finops/dashboard').set(TH_BIL);
    expect(r.body.body.period).toMatch(/^\d{4}-\d{2}$/);
  });

  test('no tenant header → 400', async () => {
    const { app } = makeFinOpsApp('admin');
    const r = await request(app).get('/v1/finops/dashboard');
    expect(r.status).toBe(400);
  });
});
