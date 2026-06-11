// @ts-nocheck
// services/bff/__tests__/alert_escalation_patterns.test.ts
// T6 M8.23 — Alert escalation pattern analysis

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryRoutingLedger, defaultRoutingLedger } from '../src/alert_routing_analytics';
import { analyzeAlertEscalationPatterns } from '../src/alert_escalation_patterns';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

function makeRecord(overrides = {}) {
  return {
    alert_id: `a-${Math.random().toString(36).slice(2)}`,
    tenant_id: 'BIL',
    created_at: '2026-06-01T10:00:00.000Z',
    severity_in: 'HIGH',
    class: 'orange',
    channels: ['email'],
    sla_hours: 24,
    escalate_after_hours: 12,
    monitor_only: false,
    acked_at: null,
    ...overrides,
  };
}

describe('analyzeAlertEscalationPatterns()', () => {
  test('empty ledger returns zero escalations', () => {
    const ledger = new InMemoryRoutingLedger();
    const result = analyzeAlertEscalationPatterns('BIL', ledger, NOW);
    expect(result.total_escalations).toBe(0);
    expect(result.escalation_rate).toBe(0);
    expect(result.most_escalated_class).toBeNull();
    expect(result.avg_escalation_hours).toBeNull();
  });

  test('on-time acked alert is not escalated', () => {
    const ledger = new InMemoryRoutingLedger();
    const created = new Date('2026-06-01T10:00:00.000Z');
    const acked = new Date('2026-06-01T11:00:00.000Z'); // 1 hour — within 24h SLA
    ledger.record(makeRecord({
      created_at: created.toISOString(),
      acked_at: acked.toISOString(),
    }));
    const result = analyzeAlertEscalationPatterns('BIL', ledger, NOW);
    expect(result.total_escalations).toBe(0);
  });

  test('open alert past SLA is escalated', () => {
    const ledger = new InMemoryRoutingLedger();
    const createdLong = new Date(NOW.getTime() - 48 * 3600 * 1000);
    ledger.record(makeRecord({
      created_at: createdLong.toISOString(),
      acked_at: null,
      sla_hours: 24,
    }));
    const result = analyzeAlertEscalationPatterns('BIL', ledger, NOW);
    expect(result.total_escalations).toBeGreaterThan(0);
  });

  test('monitor_only alert is never escalated', () => {
    const ledger = new InMemoryRoutingLedger();
    const createdLong = new Date(NOW.getTime() - 48 * 3600 * 1000);
    ledger.record(makeRecord({
      created_at: createdLong.toISOString(),
      monitor_only: true,
      class: 'green',
      sla_hours: null,
    }));
    const result = analyzeAlertEscalationPatterns('BIL', ledger, NOW);
    expect(result.total_escalations).toBe(0);
  });

  test('by_class contains all four classes', () => {
    const ledger = new InMemoryRoutingLedger();
    const result = analyzeAlertEscalationPatterns('BIL', ledger, NOW);
    expect(result.by_class).toHaveProperty('red');
    expect(result.by_class).toHaveProperty('orange');
    expect(result.by_class).toHaveProperty('yellow');
    expect(result.by_class).toHaveProperty('green');
  });

  test('tenant isolation', () => {
    const ledger = new InMemoryRoutingLedger();
    const createdLong = new Date(NOW.getTime() - 48 * 3600 * 1000);
    ledger.record(makeRecord({
      tenant_id: 'BANK_DEMO',
      created_at: createdLong.toISOString(),
    }));
    const result = analyzeAlertEscalationPatterns('BIL', ledger, NOW);
    expect(result.total_records_analyzed).toBe(0);
  });

  test('generated_at echoed', () => {
    const ledger = new InMemoryRoutingLedger();
    const result = analyzeAlertEscalationPatterns('BIL', ledger, NOW);
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

describe('GET /v1/alerts/escalation-patterns', () => {
  test('admin returns 200 with escalation fields', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/alerts/escalation-patterns')
      .set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('total_escalations');
    expect(res.body.body).toHaveProperty('escalation_rate');
    expect(res.body.body).toHaveProperty('by_class');
  });

  test('non-admin returns 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/alerts/escalation-patterns')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('missing tenant header returns 400', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/alerts/escalation-patterns')
      .set('X-Channel', 'API');
    expect(res.status).toBe(400);
  });
});
