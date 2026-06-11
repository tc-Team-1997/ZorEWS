// @ts-nocheck
// T6 M8.22 — Alert lifecycle SLA efficiency score tests.

import request from 'supertest';
import { buildAlertLifecycleEfficiency } from '../src/alert_lifecycle_efficiency';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const H = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeRecord(overrides) {
  return {
    alert_id: overrides.alert_id || `a-${Math.random().toString(36).slice(2)}`,
    tenant_id: 'BIL',
    created_at: overrides.created_at || new Date(NOW.getTime() - 2 * 3600_000).toISOString(),
    severity_in: 'HIGH',
    class: overrides.class || 'orange',
    channels: ['email'],
    sla_hours: overrides.sla_hours !== undefined ? overrides.sla_hours : 24,
    escalate_after_hours: 12,
    monitor_only: overrides.monitor_only !== undefined ? overrides.monitor_only : false,
    acked_at: overrides.acked_at !== undefined ? overrides.acked_at : new Date(NOW.getTime() - 1 * 3600_000).toISOString(),
  };
}

describe('buildAlertLifecycleEfficiency — empty input', () => {
  test('returns correct envelope with 100 fleet score', () => {
    const r = buildAlertLifecycleEfficiency('BIL', [], null, 50, NOW);
    expect(r.tenant_id).toBe('BIL');
    expect(r.total_records).toBe(0);
    expect(r.fleet_efficiency_score).toBe(100);
    expect(r.most_efficient_class).toBeNull();
    expect(r.least_efficient_class).toBeNull();
  });

  test('all 4 classes present in by_class', () => {
    const r = buildAlertLifecycleEfficiency('BIL', [], null, 50, NOW);
    expect(r.by_class.red).toBeDefined();
    expect(r.by_class.orange).toBeDefined();
    expect(r.by_class.yellow).toBeDefined();
    expect(r.by_class.green).toBeDefined();
  });
});

describe('buildAlertLifecycleEfficiency — SLA computation', () => {
  test('acked within SLA → met_sla_count incremented', () => {
    const record = makeRecord({
      class: 'orange',
      created_at: new Date(NOW.getTime() - 4 * 3600_000).toISOString(),
      acked_at: new Date(NOW.getTime() - 2 * 3600_000).toISOString(),
      sla_hours: 24,
    });
    const r = buildAlertLifecycleEfficiency('BIL', [record], null, 50, NOW);
    expect(r.by_class.orange.met_sla_count).toBe(1);
    expect(r.by_class.orange.met_sla_pct).toBe(1);
  });

  test('acked after SLA → not counted as met', () => {
    const record = makeRecord({
      class: 'red',
      created_at: new Date(NOW.getTime() - 10 * 3600_000).toISOString(),
      acked_at: new Date(NOW.getTime() - 1 * 3600_000).toISOString(),
      sla_hours: 4, // 4h SLA, acked after 9h → breached
    });
    const r = buildAlertLifecycleEfficiency('BIL', [record], null, 50, NOW);
    expect(r.by_class.red.met_sla_count).toBe(0);
    expect(r.by_class.red.met_sla_pct).toBe(0);
  });

  test('monitor_only records excluded from SLA eligibility', () => {
    const record = makeRecord({
      class: 'green',
      monitor_only: true,
    });
    const r = buildAlertLifecycleEfficiency('BIL', [record], null, 50, NOW);
    expect(r.by_class.green.sla_eligible).toBe(0);
  });

  test('efficiency_grade A for 100% met_sla', () => {
    const record = makeRecord({
      class: 'orange',
      created_at: new Date(NOW.getTime() - 2 * 3600_000).toISOString(),
      acked_at: new Date(NOW.getTime() - 1 * 3600_000).toISOString(),
      sla_hours: 24,
    });
    const r = buildAlertLifecycleEfficiency('BIL', [record], null, 50, NOW);
    expect(r.by_class.orange.efficiency_grade).toBe('A');
  });

  test('efficiency_grade F for 0% met_sla', () => {
    const record = makeRecord({
      class: 'red',
      created_at: new Date(NOW.getTime() - 20 * 3600_000).toISOString(),
      acked_at: new Date(NOW.getTime() - 1 * 3600_000).toISOString(),
      sla_hours: 4,
    });
    const r = buildAlertLifecycleEfficiency('BIL', [record], null, 50, NOW);
    expect(['D', 'F']).toContain(r.by_class.red.efficiency_grade);
  });

  test('fleet_efficiency_score is 0-100', () => {
    const records = [
      makeRecord({ class: 'red', sla_hours: 4, created_at: new Date(NOW.getTime() - 2 * 3600_000).toISOString(), acked_at: new Date(NOW.getTime() - 1 * 3600_000).toISOString() }),
      makeRecord({ class: 'orange', sla_hours: 24, created_at: new Date(NOW.getTime() - 2 * 3600_000).toISOString(), acked_at: new Date(NOW.getTime() - 1 * 3600_000).toISOString() }),
    ];
    const r = buildAlertLifecycleEfficiency('BIL', records, null, 50, NOW);
    expect(r.fleet_efficiency_score).toBeGreaterThanOrEqual(0);
    expect(r.fleet_efficiency_score).toBeLessThanOrEqual(100);
  });

  test('returns correct generated_at and window', () => {
    const r = buildAlertLifecycleEfficiency('BIL', [], null, 100, NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(r.window).toBe(100);
  });
});

describe('route — /v1/alerts/lifecycle-efficiency', () => {
  test('GET returns 200', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
    });
    const res = await request(app).get('/v1/alerts/lifecycle-efficiency').set(H);
    expect(res.status).toBe(200);
    expect(typeof res.body.body.fleet_efficiency_score).toBe('number');
    expect(res.body.body.by_class).toBeDefined();
  });

  test('400 on invalid window', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
    });
    const res = await request(app).get('/v1/alerts/lifecycle-efficiency?window=0').set(H);
    expect(res.status).toBe(400);
  });

  test('403 for wrong role', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'field_officer',
    });
    const res = await request(app).get('/v1/alerts/lifecycle-efficiency').set(H);
    expect(res.status).toBe(403);
  });
});
