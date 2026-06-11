// @ts-nocheck
// T6 M12.27 — Report schedule optimizer tests.

import request from 'supertest';
import { buildReportScheduleOptimization } from '../src/report_schedule_optimizer';
import { InMemoryReportScheduleStore } from '../src/report_schedules';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin', reportScheduleStore?) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    reportScheduleStore,
  });
  return { app };
}

describe('M12.27 — buildReportScheduleOptimization pure', () => {
  test('empty store returns no findings', async () => {
    const store = new InMemoryReportScheduleStore();
    const result = await buildReportScheduleOptimization('BIL', NOW, store);
    expect(result.tenant_id).toBe('BIL');
    expect(result.total_schedules).toBe(0);
    expect(result.findings).toHaveLength(0);
    expect(result.optimization_score).toBe(100);
    expect(result.total_savings_estimate_usd).toBe(0);
  });

  test('duplicate schedules identified', async () => {
    const store = new InMemoryReportScheduleStore();
    const base = {
      name: 'S1',
      report_id: 'portfolio_snapshot_daily',
      format: 'json',
      cadence: 'daily',
      hour_utc: 6,
      recipients: ['a@b.com'],
    };
    store.create('BIL', { ...base, name: 'S1' }, 'alice', NOW);
    store.create('BIL', { ...base, name: 'S2' }, 'bob', NOW);
    const result = await buildReportScheduleOptimization('BIL', NOW, store);
    const dup = result.findings.find(f => f.type === 'duplicate_schedules');
    expect(dup).toBeDefined();
    expect(dup.schedule_ids.length).toBeGreaterThanOrEqual(2);
  });

  test('optimization_score decreases with findings', async () => {
    const store = new InMemoryReportScheduleStore();
    const base = { name: 'X', report_id: 'portfolio_snapshot_daily', format: 'json', cadence: 'daily', hour_utc: 6, recipients: ['a@b.com'] };
    for (let i = 0; i < 4; i++) {
      store.create('BIL', { ...base, name: `S${i}` }, 'alice', NOW);
    }
    const result = await buildReportScheduleOptimization('BIL', NOW, store);
    expect(result.optimization_score).toBeLessThanOrEqual(100);
  });

  test('throws on empty tenant_id', async () => {
    const store = new InMemoryReportScheduleStore();
    await expect(buildReportScheduleOptimization('', NOW, store)).rejects.toThrow();
  });
});

describe('M12.27 — GET /v1/reports/schedules/optimization route', () => {
  test('admin returns 200', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/reports/schedules/optimization')
      .set(TH);
    expect(res.status).toBe(200);
    expect(typeof res.body.body.optimization_score).toBe('number');
    expect(Array.isArray(res.body.body.findings)).toBe(true);
  });

  test('field_officer returns 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/reports/schedules/optimization')
      .set(TH);
    expect(res.status).toBe(403);
  });
});
