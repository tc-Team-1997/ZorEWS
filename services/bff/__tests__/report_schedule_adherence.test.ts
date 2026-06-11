// @ts-nocheck
// services/bff/__tests__/report_schedule_adherence.test.ts
// T6 M12.21 — Report schedule adherence tracking.

import request from 'supertest';
import { buildScheduleAdherence } from '../src/report_schedule_adherence';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryReportScheduleStore } from '../src/report_schedules';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeStore() {
  return new InMemoryReportScheduleStore();
}

function fakeApp(role = 'admin', store = makeStore()) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    reportScheduleStore: store,
    getRole: () => role,
    now: () => NOW,
  });
  return { app, store };
}

// ─── Pure function tests ────────────────────────────────────────────────

describe('M12.21 — buildScheduleAdherence — empty', () => {
  test('no enabled schedules → empty results, fleet_adherence_rate=1', () => {
    const store = makeStore();
    const out = buildScheduleAdherence(store, 'BIL', NOW);
    expect(out.total_enabled_schedules).toBe(0);
    expect(out.schedules).toHaveLength(0);
    expect(out.worst_adherence).toBeNull();
    expect(out.fleet_adherence_rate).toBe(1);
  });
});

describe('M12.21 — disabled schedules excluded', () => {
  test('disabled schedule not counted', () => {
    const store = makeStore();
    store.create('BIL', {
      report_id: 'portfolio_snapshot_daily', format: 'json',
      name: 'Disabled', cadence: 'daily', hour_utc: 6,
      recipients: ['a@b.com'], enabled: false,
    }, 'admin', NOW);
    const out = buildScheduleAdherence(store, 'BIL', NOW);
    expect(out.total_enabled_schedules).toBe(0);
  });
});

describe('M12.21 — adherence computation', () => {
  test('daily schedule with last_run_at in window → actual_runs=1', () => {
    const store = makeStore();
    const entry = store.create('BIL', {
      report_id: 'portfolio_snapshot_daily', format: 'json',
      name: 'Daily Report', cadence: 'daily', hour_utc: 6,
      recipients: ['a@b.com'], enabled: true,
    }, 'admin', NOW);
    // Simulate a run within 30-day window
    store.markRun('BIL', entry.schedule_id, new Date(NOW.getTime() - 5 * 86400000));
    const out = buildScheduleAdherence(store, 'BIL', NOW);
    expect(out.schedules[0].actual_runs_30d).toBe(1);
    expect(out.schedules[0].expected_runs_30d).toBe(30);
    expect(out.schedules[0].adherence_rate).toBeLessThan(1);
    expect(out.schedules[0].status).toBe('behind');
  });
});

describe('M12.21 — schedule without any runs', () => {
  test('monthly with no last_run → actual=0, expected=1', () => {
    const store = makeStore();
    store.create('BIL', {
      report_id: 'rbi_quarterly_summary', format: 'json',
      name: 'Monthly', cadence: 'monthly', hour_utc: 6, day_of_month: 1,
      recipients: ['a@b.com'], enabled: true,
    }, 'admin', NOW);
    const out = buildScheduleAdherence(store, 'BIL', NOW);
    expect(out.schedules[0].actual_runs_30d).toBe(0);
    expect(out.schedules[0].expected_runs_30d).toBe(1);
    expect(out.schedules[0].adherence_rate).toBe(0);
    expect(out.worst_adherence).not.toBeNull();
  });
});

describe('M12.21 — sort order', () => {
  test('sorted adherence_rate asc (worst first)', () => {
    const store = makeStore();
    // Good schedule: had a recent run
    const s1 = store.create('BIL', {
      report_id: 'portfolio_snapshot_daily', format: 'json',
      name: 'Good', cadence: 'daily', hour_utc: 6,
      recipients: ['a@b.com'], enabled: true,
    }, 'admin', NOW);
    store.markRun('BIL', s1.schedule_id, new Date(NOW.getTime() - 5 * 86400000));
    // Bad schedule: never ran
    store.create('BIL', {
      report_id: 'rbi_quarterly_summary', format: 'json',
      name: 'Bad', cadence: 'monthly', hour_utc: 6, day_of_month: 1,
      recipients: ['b@b.com'], enabled: true,
    }, 'admin', NOW);
    const out = buildScheduleAdherence(store, 'BIL', NOW);
    // First entry should be the worst (most behind)
    expect(out.schedules[0].adherence_rate).toBeLessThanOrEqual(out.schedules[out.schedules.length - 1].adherence_rate);
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M12.21 — route', () => {
  test('GET /v1/reports/schedules/adherence → 200', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/reports/schedules/adherence')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(typeof res.body.body.total_enabled_schedules).toBe('number');
    expect(Array.isArray(res.body.body.schedules)).toBe(true);
  });

  test('403 for unknown role', async () => {
    const { app } = fakeApp('viewer');
    const res = await request(app)
      .get('/v1/reports/schedules/adherence')
      .set(TH_BIL)
      .set('x-apex-role', 'viewer');
    expect(res.status).toBe(403);
  });

  test('400 when no tenant header', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/reports/schedules/adherence')
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });
});
