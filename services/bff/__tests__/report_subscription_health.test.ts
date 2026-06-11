// @ts-nocheck
// T6 M12.26 — Report subscription health check.

import request from 'supertest';
import { buildReportSubscriptionHealth } from '../src/report_subscription_health';
import { InMemoryReportScheduleStore } from '../src/report_schedules';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeHealthApp(role = 'admin', store = new InMemoryReportScheduleStore()) {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => role, reportScheduleStore: store });
  return app;
}

describe('M12.26 — empty store', () => {
  test('empty store → health_score 100', () => {
    const store = new InMemoryReportScheduleStore();
    const out = buildReportSubscriptionHealth('BIL', store, NOW);
    expect(out.total_enabled).toBe(0);
    expect(out.health_score).toBe(100);
    expect(out.most_overdue_schedule).toBeNull();
  });
});

describe('M12.26 — with schedules', () => {
  test('never_run schedule classified correctly', () => {
    const store = new InMemoryReportScheduleStore();
    store.create('BIL', { report_id: 'portfolio_snapshot_daily', format: 'json', name: 'Test', cadence: 'daily', hour_utc: 6, recipients: ['a@b.com'], enabled: true }, 'alice', NOW);
    const out = buildReportSubscriptionHealth('BIL', store, NOW);
    expect(out.never_run_count).toBe(1);
    expect(out.schedules[0].status).toBe('never_run');
  });

  test('healthy schedule has last_run_at within interval', () => {
    const store = new InMemoryReportScheduleStore();
    const sched = store.create('BIL', { report_id: 'portfolio_snapshot_daily', format: 'json', name: 'Test', cadence: 'daily', hour_utc: 6, recipients: ['a@b.com'], enabled: true }, 'alice', NOW);
    store.markRun('BIL', sched.schedule_id, NOW);
    const out = buildReportSubscriptionHealth('BIL', store, NOW);
    expect(out.healthy_count).toBe(1);
    expect(out.schedules[0].status).toBe('healthy');
  });

  test('disabled schedules excluded', () => {
    const store = new InMemoryReportScheduleStore();
    store.create('BIL', { report_id: 'portfolio_snapshot_daily', format: 'json', name: 'Disabled', cadence: 'daily', hour_utc: 6, recipients: ['a@b.com'], enabled: false }, 'alice', NOW);
    const out = buildReportSubscriptionHealth('BIL', store, NOW);
    expect(out.total_enabled).toBe(0);
  });

  test('health_score in [0,100]', () => {
    const store = new InMemoryReportScheduleStore();
    store.create('BIL', { report_id: 'portfolio_snapshot_daily', format: 'json', name: 'Test', cadence: 'daily', hour_utc: 6, recipients: ['a@b.com'], enabled: true }, 'alice', NOW);
    const out = buildReportSubscriptionHealth('BIL', store, NOW);
    expect(out.health_score).toBeGreaterThanOrEqual(0);
    expect(out.health_score).toBeLessThanOrEqual(100);
  });
});

describe('M12.26 — route', () => {
  test('admin GET /v1/reports/schedules/subscription-health returns 200', async () => {
    const app = makeHealthApp();
    const res = await request(app).get('/v1/reports/schedules/subscription-health').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('health_score');
  });

  test('non-admin gets 403', async () => {
    const app = makeHealthApp('field_officer');
    const res = await request(app).get('/v1/reports/schedules/subscription-health').set(TH);
    expect(res.status).toBe(403);
  });
});
