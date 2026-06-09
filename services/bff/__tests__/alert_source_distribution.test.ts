// @ts-nocheck
// __tests__/alert_source_distribution.test.ts
// T6 M8.20 — Alert source system distribution

import request from 'supertest';
import {
  buildAlertSourceDistribution,
} from '../src/alert_source_distribution';
import {
  InMemoryRoutingLedger,
} from '../src/alert_routing_analytics';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-08T12:00:00Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeSourceApp(role = 'admin', ledger) {
  const reg = ledger ?? new InMemoryRoutingLedger();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    routingLedger: reg,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, ledger: reg };
}

function makeRec(overrides = {}) {
  return {
    alert_id: `a-${Math.random()}`,
    tenant_id: 'BIL',
    created_at: NOW.toISOString(),
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

// ─── Pure function tests ───────────────────────────────────────────────

describe('buildAlertSourceDistribution — M8.20', () => {
  it('empty records → zeroed envelope, null dominant/accuracy', () => {
    const result = buildAlertSourceDistribution('BIL', [], 50, NOW);
    expect(result.total_records).toBe(0);
    expect(result.by_source_severity).toHaveLength(0);
    expect(result.dominant_source_severity).toBeNull();
    expect(result.severity_to_class_mapping_accuracy).toBeNull();
  });

  it('single HIGH record → 1 row', () => {
    const records = [makeRec({ severity_in: 'HIGH', class: 'orange' })];
    const result = buildAlertSourceDistribution('BIL', records, 50, NOW);
    expect(result.total_records).toBe(1);
    expect(result.by_source_severity).toHaveLength(1);
    expect(result.by_source_severity[0].severity).toBe('HIGH');
    expect(result.by_source_severity[0].count).toBe(1);
    expect(result.by_source_severity[0].pct).toBeCloseTo(1.0, 5);
    expect(result.dominant_source_severity).toBe('HIGH');
  });

  it('multiple severities → rows sorted by count desc', () => {
    const records = [
      makeRec({ severity_in: 'HIGH' }),
      makeRec({ severity_in: 'HIGH' }),
      makeRec({ severity_in: 'LOW' }),
    ];
    const result = buildAlertSourceDistribution('BIL', records, 50, NOW);
    expect(result.by_source_severity[0].severity).toBe('HIGH');
    expect(result.by_source_severity[0].count).toBe(2);
    expect(result.dominant_source_severity).toBe('HIGH');
  });

  it('by_class keys present for each row', () => {
    const records = [makeRec({ severity_in: 'CRITICAL', class: 'red' })];
    const result = buildAlertSourceDistribution('BIL', records, 50, NOW);
    const row = result.by_source_severity[0];
    expect(row.by_class).toHaveProperty('red');
    expect(row.by_class).toHaveProperty('orange');
    expect(row.by_class).toHaveProperty('yellow');
    expect(row.by_class).toHaveProperty('green');
    expect(row.by_class.red).toBe(1);
    expect(row.by_class.orange).toBe(0);
  });

  it('acked_count + open_count = count per row', () => {
    const records = [
      makeRec({ severity_in: 'HIGH', acked_at: NOW.toISOString() }),
      makeRec({ severity_in: 'HIGH', acked_at: null }),
      makeRec({ severity_in: 'HIGH', acked_at: null }),
    ];
    const result = buildAlertSourceDistribution('BIL', records, 50, NOW);
    const row = result.by_source_severity[0];
    expect(row.acked_count + row.open_count).toBe(row.count);
    expect(row.acked_count).toBe(1);
    expect(row.open_count).toBe(2);
  });

  it('mapping accuracy = 1.0 when all map correctly', () => {
    const records = [
      makeRec({ severity_in: 'LOW', class: 'green' }),
      makeRec({ severity_in: 'MEDIUM', class: 'yellow' }),
      makeRec({ severity_in: 'HIGH', class: 'orange' }),
      makeRec({ severity_in: 'CRITICAL', class: 'red' }),
    ];
    const result = buildAlertSourceDistribution('BIL', records, 50, NOW);
    expect(result.severity_to_class_mapping_accuracy).toBeCloseTo(1.0, 5);
  });

  it('mapping accuracy = 0.0 when all map incorrectly', () => {
    const records = [
      makeRec({ severity_in: 'LOW', class: 'red' }),
      makeRec({ severity_in: 'HIGH', class: 'green' }),
    ];
    const result = buildAlertSourceDistribution('BIL', records, 50, NOW);
    expect(result.severity_to_class_mapping_accuracy).toBeCloseTo(0.0, 5);
  });

  it('tenant_id and window echoed', () => {
    const result = buildAlertSourceDistribution('BANK_DEMO', [], 100, NOW);
    expect(result.tenant_id).toBe('BANK_DEMO');
    expect(result.window).toBe(100);
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ───────────────────────────────────────────────────────

describe('GET /v1/alerts/source-distribution — M8.20 route', () => {
  it('admin GET → 200 with shape', async () => {
    const { app } = makeSourceApp('admin');
    const res = await request(app)
      .get('/v1/alerts/source-distribution')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.total_records).toBe(0);
    expect(Array.isArray(res.body.body.by_source_severity)).toBe(true);
  });

  it('?window=100 accepted', async () => {
    const { app } = makeSourceApp('admin');
    const res = await request(app)
      .get('/v1/alerts/source-distribution?window=100')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.window).toBe(100);
  });

  it('?window=0 → 400', async () => {
    const { app } = makeSourceApp('admin');
    const res = await request(app)
      .get('/v1/alerts/source-distribution?window=0')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });

  it('unknown_role → 403', async () => {
    const { app } = makeSourceApp('unknown_role');
    const res = await request(app)
      .get('/v1/alerts/source-distribution')
      .set(TH_BIL)
      .set('x-apex-role', 'unknown_role');
    expect(res.status).toBe(403);
  });

  it('no tenant header → 400', async () => {
    const { app } = makeSourceApp('admin');
    const res = await request(app)
      .get('/v1/alerts/source-distribution')
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });
});
