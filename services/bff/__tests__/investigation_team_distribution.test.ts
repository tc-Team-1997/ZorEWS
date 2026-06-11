// @ts-nocheck
// T6 M9.28 — Investigation team workload distribution.

import request from 'supertest';
import { buildInvestigationTeamDistribution } from '../src/investigation_team_distribution';
import { InMemoryCaseInvestigationStore } from '../src/case_investigation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeDistApp(role = 'admin', store = new InMemoryCaseInvestigationStore()) {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => role, caseInvestigationStore: store });
  return app;
}

describe('M9.28 — empty store', () => {
  test('zero investigations returns zero metrics', () => {
    const store = new InMemoryCaseInvestigationStore();
    const out = buildInvestigationTeamDistribution('BIL', store, NOW);
    expect(out.total_investigators).toBe(0);
    expect(out.total_investigations).toBe(0);
    expect(out.gini_coefficient).toBe(0);
    expect(out.by_investigator).toEqual([]);
  });
});

describe('M9.28 — with investigations', () => {
  test('counts by investigator correctly', () => {
    const store = new InMemoryCaseInvestigationStore();
    store.open('BIL', { case_id: 'c1', customer_id: 'cust1' }, 'alice', NOW);
    store.open('BIL', { case_id: 'c2', customer_id: 'cust2' }, 'alice', NOW);
    store.open('BIL', { case_id: 'c3', customer_id: 'cust3' }, 'bob', NOW);
    const out = buildInvestigationTeamDistribution('BIL', store, NOW);
    expect(out.total_investigators).toBe(2);
    expect(out.total_investigations).toBe(3);
    expect(out.by_investigator[0].investigator).toBe('alice');
    expect(out.by_investigator[0].count).toBe(2);
  });

  test('pct_of_total sums to ~1', () => {
    const store = new InMemoryCaseInvestigationStore();
    store.open('BIL', { case_id: 'c1', customer_id: 'cust1' }, 'alice', NOW);
    store.open('BIL', { case_id: 'c2', customer_id: 'cust2' }, 'bob', NOW);
    const out = buildInvestigationTeamDistribution('BIL', store, NOW);
    const totalPct = out.by_investigator.reduce((s, r) => s + r.pct_of_total, 0);
    expect(totalPct).toBeCloseTo(1, 1);
  });

  test('gini_coefficient in [0,1]', () => {
    const store = new InMemoryCaseInvestigationStore();
    store.open('BIL', { case_id: 'c1', customer_id: 'cust1' }, 'alice', NOW);
    store.open('BIL', { case_id: 'c2', customer_id: 'cust2' }, 'bob', NOW);
    const out = buildInvestigationTeamDistribution('BIL', store, NOW);
    expect(out.gini_coefficient).toBeGreaterThanOrEqual(0);
    expect(out.gini_coefficient).toBeLessThanOrEqual(1);
  });

  test('distribution_tier is valid', () => {
    const store = new InMemoryCaseInvestigationStore();
    store.open('BIL', { case_id: 'c1', customer_id: 'cust1' }, 'alice', NOW);
    const out = buildInvestigationTeamDistribution('BIL', store, NOW);
    expect(['balanced', 'moderate', 'unequal']).toContain(out.distribution_tier);
  });

  test('cross-tenant isolation', () => {
    const store = new InMemoryCaseInvestigationStore();
    store.open('BIL', { case_id: 'c1', customer_id: 'cust1' }, 'alice', NOW);
    const out = buildInvestigationTeamDistribution('BANK_DEMO', store, NOW);
    expect(out.total_investigations).toBe(0);
  });
});

describe('M9.28 — route', () => {
  test('admin GET /v1/investigations/team-distribution returns 200', async () => {
    const app = makeDistApp();
    const res = await request(app).get('/v1/investigations/team-distribution').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('gini_coefficient');
  });

  test('non-admin gets 403', async () => {
    const app = makeDistApp('field_officer');
    const res = await request(app).get('/v1/investigations/team-distribution').set(TH);
    expect(res.status).toBe(403);
  });
});
