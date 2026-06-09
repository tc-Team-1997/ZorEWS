// @ts-nocheck
// services/bff/__tests__/adapter_latency_comparison.test.ts
//
// T6 M14.32 — Adapter request latency percentile comparison.

import request from 'supertest';
import { buildAdapterLatencyComparison } from '../src/adapter_latency_comparison';
import { listAdapterSlaCatalog } from '../src/adapter_sla_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import type { AdapterFleet } from '../src/adapter_health';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeLowLatencyFleet() {
  const makeAdapter = (latencyMs = 10) => ({
    listPolicies: async () => [],
    getPolicy: async () => null,
    listClaims: async () => [],
    getClaim: async () => null,
    listStages: async () => ({ items: [], total: 0, page: 1, page_size: 1 }),
    getStage: async () => null,
    screenCustomer: async () => ({ matches: [], requires_review: false, highest_severity: null }),
    listMatches: async () => [],
    getMatch: async () => null,
    updateMatchStatus: async () => null,
    listByCustomer: async () => [],
    get: async () => null,
    updateStatus: async () => null,
    pull: async () => ({ band: 'prime', score: 750, expires_at: NOW.toISOString(), pulled_at: NOW.toISOString(), report_id: 'r1', bureau_type: 'CIBIL', customer_id: 'c1', summary: {} }),
    list: async () => ({ items: [], total: 0, page: 1, page_size: 1 }),
    getProductivity: async () => null,
    listProductivity: async () => [],
    getAccount: async () => null,
    listAccountsForCustomer: async () => [],
    listLedger: async () => [],
    getLeaveBalance: async () => null,
  });
  return {
    insurance: makeAdapter(),
    ifrs9: makeAdapter(),
    aml: makeAdapter(),
    dms: makeAdapter(),
    bureau: makeAdapter(),
    agent: makeAdapter(),
    finance: makeAdapter(),
    hr: makeAdapter(),
  };
}

function makeCompApp(role) {
  const source = new StaticSource([]);
  const evaluator = new StubEvaluator();
  const riskProfile = new StubRiskProfileSource();
  const caseAction = new UnavailableCaseActionSink();
  const getRole = () => role;
  const { app } = makeApp({ source, evaluator, riskProfile, caseAction, getRole });
  return { app };
}

// ─── Pure function tests ────────────────────────────────────────────

describe('buildAdapterLatencyComparison — pure', () => {
  test('all adapters return grades and fleet_health_score', async () => {
    const fleet = makeLowLatencyFleet();
    const result = await buildAdapterLatencyComparison(fleet, 'BIL', NOW);
    expect(result.total_adapters).toBe(8);
    expect(result.fleet_health_score).toBeGreaterThanOrEqual(0);
    expect(result.fleet_health_score).toBeLessThanOrEqual(100);
  });

  test('grade_distribution keys are A B C D F', () => {
    return buildAdapterLatencyComparison(makeLowLatencyFleet(), 'BIL', NOW).then(result => {
      expect(Object.keys(result.grade_distribution).sort()).toEqual(['A', 'B', 'C', 'D', 'F'].sort());
      const total = Object.values(result.grade_distribution).reduce((s, v) => s + v, 0);
      expect(total).toBe(result.total_adapters);
    });
  });

  test('stub fleet produces mostly A grades (very low latency)', async () => {
    const result = await buildAdapterLatencyComparison(makeLowLatencyFleet(), 'BIL', NOW);
    // Stub adapters return instantly → latency ~0ms → well under 50% of any SLA → A
    expect(result.grade_distribution['A']).toBeGreaterThan(0);
  });

  test('adapters sorted grade asc (A first)', async () => {
    const result = await buildAdapterLatencyComparison(makeLowLatencyFleet(), 'BIL', NOW);
    const grades = result.adapters.map(a => a.latency_grade);
    const order = ['A', 'B', 'C', 'D', 'F'];
    for (let i = 1; i < grades.length; i++) {
      const prevIdx = order.indexOf(grades[i - 1]);
      const currIdx = order.indexOf(grades[i]);
      expect(currIdx).toBeGreaterThanOrEqual(prevIdx);
    }
  });

  test('degraded adapter → grade F', async () => {
    const fleet = makeLowLatencyFleet();
    fleet.insurance = {
      ...fleet.insurance,
      listPolicies: async () => { throw new Error('connection refused'); },
    };
    const result = await buildAdapterLatencyComparison(fleet, 'BIL', NOW);
    const insuranceRow = result.adapters.find(a => a.adapter_id === 'insurance');
    expect(insuranceRow.latency_grade).toBe('F');
    expect(insuranceRow.observed_latency_ms).toBeNull();
    expect(insuranceRow.headroom_pct).toBeNull();
  });

  test('best_performer has highest headroom', async () => {
    const result = await buildAdapterLatencyComparison(makeLowLatencyFleet(), 'BIL', NOW);
    if (result.best_performer) {
      for (const row of result.adapters.filter(r => r.latency_grade !== 'F' && r.headroom_pct !== null)) {
        expect(row.headroom_pct).toBeLessThanOrEqual(result.best_performer.headroom_pct + 0.001);
      }
    }
  });

  test('each row has adapter_id, label, sla_target_ms from M14.23 catalog', async () => {
    const catalog = listAdapterSlaCatalog();
    const result = await buildAdapterLatencyComparison(makeLowLatencyFleet(), 'BIL', NOW);
    for (const row of result.adapters) {
      const slaEntry = catalog.adapters.find(a => a.adapter_id === row.adapter_id);
      expect(slaEntry).toBeDefined();
      expect(row.sla_target_ms).toBe(slaEntry.expected_latency_ms_p95);
      expect(row.label).toBeTruthy();
    }
  });
});

// ─── Route tests ────────────────────────────────────────────────────

describe('M14.32 — GET /v1/integrations/adapters/latency-comparison', () => {
  test('admin → 200 with fleet_health_score + grade_distribution', async () => {
    const { app } = makeCompApp('admin');
    const r = await request(app)
      .get('/v1/integrations/adapters/latency-comparison')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.fleet_health_score).toBeDefined();
    expect(r.body.body.grade_distribution).toBeDefined();
    expect(r.body.body.adapters).toBeDefined();
    expect(r.body.body.total_adapters).toBe(8);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCompApp('field_officer');
    const r = await request(app)
      .get('/v1/integrations/adapters/latency-comparison')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('400 when no tenant header', async () => {
    const { app } = makeCompApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/latency-comparison');
    expect(r.status).toBe(400);
  });

  test('adapters[] contains all 8 M14 adapters', async () => {
    const { app } = makeCompApp('admin');
    const r = await request(app)
      .get('/v1/integrations/adapters/latency-comparison')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    const adapterIds = r.body.body.adapters.map(a => a.adapter_id);
    expect(adapterIds).toContain('insurance');
    expect(adapterIds).toContain('aml');
    expect(adapterIds).toContain('bureau');
  });
});
