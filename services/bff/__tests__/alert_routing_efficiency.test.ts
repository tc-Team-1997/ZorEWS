// @ts-nocheck
// T6 M8.28 — Alert routing efficiency tests.

import request from 'supertest';
import { buildAlertRoutingEfficiency } from '../src/alert_routing_efficiency';
import { InMemoryRoutingLedger } from '../src/alert_routing_analytics';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeRecord(overrides = {}) {
  return {
    tenant_id: 'BIL',
    alert_id: 'a-001',
    severity_in: 'HIGH',
    class: 'orange',
    channels: ['email'],
    sla_hours: 24,
    escalate_after_hours: 12,
    monitor_only: false,
    acked_at: null,
    created_at: new Date(NOW.getTime() - 3600000).toISOString(),
    ...overrides,
  };
}

function makeTestApp(role = 'admin', routingLedger?) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    routingLedger,
  });
  return { app };
}

describe('M8.28 — buildAlertRoutingEfficiency pure', () => {
  test('empty ledger returns 100% efficiency', () => {
    const ledger = new InMemoryRoutingLedger();
    const result = buildAlertRoutingEfficiency('BIL', NOW, ledger);
    expect(result.overall_routing_efficiency_pct).toBe(100);
    expect(result.total_routed).toBe(0);
    expect(result.by_class).toHaveLength(4);
  });

  test('acked on time counts as routed correctly', () => {
    const ledger = new InMemoryRoutingLedger();
    const ackedAt = new Date(NOW.getTime() - 3600000).toISOString();
    const createdAt = new Date(NOW.getTime() - 7200000).toISOString();
    ledger.record(makeRecord({ class: 'red', sla_hours: 4, created_at: createdAt, acked_at: ackedAt }));
    const result = buildAlertRoutingEfficiency('BIL', NOW, ledger);
    expect(result.by_class.find(c => c.class === 'red').routed_correctly).toBe(1);
    expect(result.by_class.find(c => c.class === 'red').escalated).toBe(0);
  });

  test('monitor_only (green) counts as routed correctly', () => {
    const ledger = new InMemoryRoutingLedger();
    ledger.record(makeRecord({ class: 'green', monitor_only: true, sla_hours: null }));
    const result = buildAlertRoutingEfficiency('BIL', NOW, ledger);
    expect(result.by_class.find(c => c.class === 'green').routed_correctly).toBe(1);
  });

  test('by_class has all 4 classes', () => {
    const ledger = new InMemoryRoutingLedger();
    const result = buildAlertRoutingEfficiency('BIL', NOW, ledger);
    const classes = result.by_class.map(c => c.class);
    expect(classes).toContain('red');
    expect(classes).toContain('orange');
    expect(classes).toContain('yellow');
    expect(classes).toContain('green');
  });

  test('throws on empty tenant_id', () => {
    const ledger = new InMemoryRoutingLedger();
    expect(() => buildAlertRoutingEfficiency('', NOW, ledger)).toThrow();
  });
});

describe('M8.28 — GET /v1/alerts/routing-efficiency route', () => {
  test('admin returns 200', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/alerts/routing-efficiency')
      .set(TH);
    expect(res.status).toBe(200);
    expect(typeof res.body.body.overall_routing_efficiency_pct).toBe('number');
    expect(Array.isArray(res.body.body.by_class)).toBe(true);
  });

  test('field_officer returns 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/alerts/routing-efficiency')
      .set(TH);
    expect(res.status).toBe(403);
  });
});
