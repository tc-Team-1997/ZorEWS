// @ts-nocheck
// T6 M9.27 — Investigation closure by decision tests.

import request from 'supertest';
import { buildInvestigationClosureByDecision } from '../src/investigation_closure_by_decision';
import { InMemoryCaseInvestigationStore } from '../src/case_investigation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin', caseInvestigationStore) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    caseInvestigationStore: caseInvestigationStore,
  });
  return app;
}

function openAndClose(store, tenant, decisionVal, daysToClose = 5) {
  const opened = new Date(NOW.getTime() - daysToClose * 86_400_000);
  const inv = store.open(tenant, { case_id: `case-${Math.random().toString(36).slice(2)}`, customer_id: 'c-1' }, 'alice', opened);
  // Fast-forward to closed with a decision
  store.updateStatus(tenant, inv.investigation_id, 'gathering_evidence', null, 'alice', opened);
  store.updateStatus(tenant, inv.investigation_id, 'review', null, 'alice', opened);
  store.updateStatus(tenant, inv.investigation_id, 'decision', null, 'alice', opened);
  store.updateStatus(tenant, inv.investigation_id, 'closed', decisionVal, 'alice', NOW);
  return inv;
}

describe('M9.27 — buildInvestigationClosureByDecision pure', () => {
  test('empty store returns zero result', () => {
    const store = new InMemoryCaseInvestigationStore();
    const result = buildInvestigationClosureByDecision(store, 'BIL', NOW);
    expect(result.total_closed_with_decision).toBe(0);
    expect(result.by_decision).toHaveLength(0);
    expect(result.fastest_decision_type).toBeNull();
    expect(result.slowest_decision_type).toBeNull();
    expect(result.overall_avg_days).toBe(0);
  });

  test('single closed investigation with decision', () => {
    const store = new InMemoryCaseInvestigationStore();
    openAndClose(store, 'BIL', 'fraud_confirmed', 5);
    const result = buildInvestigationClosureByDecision(store, 'BIL', NOW);
    expect(result.total_closed_with_decision).toBe(1);
    expect(result.by_decision).toHaveLength(1);
    expect(result.by_decision[0].decision).toBe('fraud_confirmed');
    expect(result.by_decision[0].count).toBe(1);
  });

  test('multiple decisions grouped correctly', () => {
    const store = new InMemoryCaseInvestigationStore();
    openAndClose(store, 'BIL', 'fraud_confirmed', 10);
    openAndClose(store, 'BIL', 'fraud_confirmed', 20);
    openAndClose(store, 'BIL', 'fraud_unsubstantiated', 5);
    const result = buildInvestigationClosureByDecision(store, 'BIL', NOW);
    const confirmed = result.by_decision.find((d) => d.decision === 'fraud_confirmed');
    expect(confirmed.count).toBe(2);
  });

  test('sorted by avg_days_to_close desc', () => {
    const store = new InMemoryCaseInvestigationStore();
    openAndClose(store, 'BIL', 'fraud_confirmed', 30);
    openAndClose(store, 'BIL', 'data_quality', 5);
    const result = buildInvestigationClosureByDecision(store, 'BIL', NOW);
    if (result.by_decision.length >= 2) {
      expect(result.by_decision[0].avg_days_to_close).toBeGreaterThanOrEqual(result.by_decision[1].avg_days_to_close);
    }
  });

  test('tenant_id and generated_at echoed', () => {
    const store = new InMemoryCaseInvestigationStore();
    const result = buildInvestigationClosureByDecision(store, 'BIL', NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

describe('M9.27 — GET /v1/investigations/closure-by-decision route', () => {
  test('admin 200 with envelope', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/investigations/closure-by-decision').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toBeDefined();
    expect(res.body.body.by_decision).toBeInstanceOf(Array);
  });

  test('field_officer 403', async () => {
    const app = makeTestApp('field_officer');
    const res = await request(app).get('/v1/investigations/closure-by-decision').set(TH);
    expect(res.status).toBe(403);
  });

  test('cross-tenant isolation', async () => {
    const store = new InMemoryCaseInvestigationStore();
    openAndClose(store, 'BANK_DEMO', 'fraud_confirmed', 5);
    const app = makeTestApp('admin', store);
    const res = await request(app).get('/v1/investigations/closure-by-decision').set(TH); // BIL
    expect(res.body.body.total_closed_with_decision).toBe(0);
  });

  test('no tenant header → 400', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/investigations/closure-by-decision');
    expect(res.status).toBe(400);
  });
});
