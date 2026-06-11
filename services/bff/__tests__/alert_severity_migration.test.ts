// @ts-nocheck
// T6 M8.26 — Alert severity migration tests.

import request from 'supertest';
import { buildAlertSeverityMigration } from '../src/alert_severity_migration';
import { InMemoryRoutingLedger } from '../src/alert_routing_analytics';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin', routingLedger) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    routingLedger: routingLedger,
  });
  return app;
}

function addRecord(ledger, tenant, cls) {
  ledger.record({
    tenant_id: tenant,
    alert_id: `a-${Math.random().toString(36).slice(2)}`,
    severity_in: cls === 'red' ? 'CRITICAL' : cls === 'orange' ? 'HIGH' : cls === 'yellow' ? 'MEDIUM' : 'LOW',
    class: cls,
    channels: ['email'],
    sla_hours: cls === 'green' ? null : 4,
    escalate_after_hours: cls === 'green' ? null : 1,
    monitor_only: cls === 'green',
    created_at: NOW.toISOString(),
    acked_at: null,
  });
}

describe('M8.26 — buildAlertSeverityMigration pure', () => {
  test('empty ledger → stable, zero escalation rate', () => {
    const ledger = new InMemoryRoutingLedger();
    const result = buildAlertSeverityMigration(ledger, 'BIL', NOW);
    expect(result.total_records).toBe(0);
    expect(result.red_trend).toBe('stable');
    expect(result.critical_escalation_rate).toBe(0);
    expect(result.risk_trajectory).toBe('stable');
    expect(result.windows).toHaveLength(3);
  });

  test('three windows are always returned', () => {
    const ledger = new InMemoryRoutingLedger();
    for (let i = 0; i < 9; i++) addRecord(ledger, 'BIL', 'orange');
    const result = buildAlertSeverityMigration(ledger, 'BIL', NOW);
    expect(result.windows.map((w) => w.window)).toEqual(['early', 'mid', 'recent']);
  });

  test('critical_escalation_rate = red_count / total', () => {
    const ledger = new InMemoryRoutingLedger();
    for (let i = 0; i < 8; i++) addRecord(ledger, 'BIL', 'orange');
    for (let i = 0; i < 2; i++) addRecord(ledger, 'BIL', 'red');
    const result = buildAlertSeverityMigration(ledger, 'BIL', NOW);
    expect(result.critical_escalation_rate).toBeCloseTo(0.2, 2);
  });

  test('tenant_id and generated_at echoed', () => {
    const ledger = new InMemoryRoutingLedger();
    const result = buildAlertSeverityMigration(ledger, 'BIL', NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.generated_at).toBe(NOW.toISOString());
  });

  test('risk_trajectory stable when no trend', () => {
    const ledger = new InMemoryRoutingLedger();
    // Equal red across all windows
    for (let i = 0; i < 9; i++) addRecord(ledger, 'BIL', 'red');
    const result = buildAlertSeverityMigration(ledger, 'BIL', NOW);
    // All red → same pct in each window → stable
    expect(result.red_trend).toBe('stable');
    expect(result.risk_trajectory).toBe('stable');
  });
});

describe('M8.26 — GET /v1/alerts/severity-migration route', () => {
  test('admin 200 with envelope', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/alerts/severity-migration').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body.windows).toHaveLength(3);
  });

  test('field_officer 403', async () => {
    const app = makeTestApp('field_officer');
    const res = await request(app).get('/v1/alerts/severity-migration').set(TH);
    expect(res.status).toBe(403);
  });

  test('cross-tenant isolation', async () => {
    const ledger = new InMemoryRoutingLedger();
    addRecord(ledger, 'BANK_DEMO', 'red');
    const app = makeTestApp('admin', ledger);
    const res = await request(app).get('/v1/alerts/severity-migration').set(TH); // BIL
    expect(res.body.body.total_records).toBe(0);
  });

  test('no tenant header → 400', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/alerts/severity-migration');
    expect(res.status).toBe(400);
  });
});
