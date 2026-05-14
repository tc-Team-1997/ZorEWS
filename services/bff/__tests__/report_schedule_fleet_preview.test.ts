// services/bff/__tests__/report_schedule_fleet_preview.test.ts
//
// T6 M12.7 — Report schedule fleet-wide upcoming runs.

import request from 'supertest';
import {
  previewScheduleFleet,
  FleetPreviewError,
} from '../src/report_schedule_fleet_preview';
import {
  InMemoryReportScheduleStore,
  type ReportScheduleEntry,
} from '../src/report_schedules';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkEntry(o: Partial<ReportScheduleEntry> & { schedule_id: string; report_id: string }): ReportScheduleEntry {
  return {
    schedule_id: o.schedule_id,
    tenant_id: o.tenant_id ?? 'BIL',
    report_id: o.report_id,
    format: o.format ?? 'json',
    name: o.name ?? `Sched ${o.schedule_id}`,
    cadence: o.cadence ?? 'daily',
    hour_utc: o.hour_utc ?? 6,
    day_of_week: o.day_of_week ?? null,
    day_of_month: o.day_of_month ?? null,
    recipients: o.recipients ?? ['compliance@example.com'],
    enabled: o.enabled ?? true,
    parameters: o.parameters ?? {},
    created_by: o.created_by ?? 'alice',
    created_at: o.created_at ?? '2026-05-01T00:00:00.000Z',
    updated_at: o.updated_at ?? '2026-05-01T00:00:00.000Z',
    next_run_at: o.next_run_at ?? '2026-05-15T06:00:00.000Z',
    last_run_at: o.last_run_at ?? null,
    tz: o.tz ?? 'UTC',
  };
}

// ─── previewScheduleFleet — pure ─────────────────────────────────────

describe('M12.7 — empty input', () => {
  test('zero schedules → empty items', () => {
    const out = previewScheduleFleet([], NOW, 10);
    expect(out.total_schedules_considered).toBe(0);
    expect(out.total_enabled).toBe(0);
    expect(out.total_returned).toBe(0);
    expect(out.items).toEqual([]);
    expect(out.from).toBe(NOW.toISOString());
  });
});

describe('M12.7 — single schedule', () => {
  test('returns top-n firings of the schedule', () => {
    const sched = mkEntry({
      schedule_id: 's1',
      report_id: 'rpt_daily',
      cadence: 'daily',
      hour_utc: 6,
    });
    const out = previewScheduleFleet([sched], NOW, 5);
    expect(out.total_returned).toBe(5);
    expect(out.items).toHaveLength(5);
    // All items reference our schedule
    for (const item of out.items) {
      expect(item.schedule_id).toBe('s1');
      expect(item.report_id).toBe('rpt_daily');
    }
    // Strictly increasing fire_at
    const ts = out.items.map((i) => i.fire_at);
    expect(ts).toEqual([...ts].sort());
  });
});

describe('M12.7 — multi-schedule merge', () => {
  test('items sorted by fire_at across schedules', () => {
    const dailyMorning = mkEntry({
      schedule_id: 's_morning',
      report_id: 'rpt_morning',
      cadence: 'daily',
      hour_utc: 6,
    });
    const dailyEvening = mkEntry({
      schedule_id: 's_evening',
      report_id: 'rpt_evening',
      cadence: 'daily',
      hour_utc: 18,
    });
    const out = previewScheduleFleet([dailyMorning, dailyEvening], NOW, 6);
    expect(out.total_schedules_considered).toBe(2);
    expect(out.total_enabled).toBe(2);
    expect(out.total_returned).toBe(6);
    const ts = out.items.map((i) => i.fire_at);
    expect(ts).toEqual([...ts].sort());
    // Should interleave morning + evening
    const scheds = out.items.map((i) => i.schedule_id);
    expect(scheds).toContain('s_morning');
    expect(scheds).toContain('s_evening');
  });

  test('top-n cap honoured even when pool is larger', () => {
    const s1 = mkEntry({ schedule_id: 'a', report_id: 'r', cadence: 'daily', hour_utc: 6 });
    const s2 = mkEntry({ schedule_id: 'b', report_id: 'r', cadence: 'daily', hour_utc: 18 });
    const s3 = mkEntry({ schedule_id: 'c', report_id: 'r', cadence: 'daily', hour_utc: 12 });
    const out = previewScheduleFleet([s1, s2, s3], NOW, 5);
    expect(out.total_returned).toBe(5);
    // Pool was 3 schedules × 5 = 15 candidates; output trimmed to 5.
    expect(out.items.length).toBe(5);
  });
});

describe('M12.7 — disabled schedules excluded', () => {
  test('disabled schedule does not contribute any firings', () => {
    const enabled = mkEntry({ schedule_id: 'on', report_id: 'r', cadence: 'daily', hour_utc: 6, enabled: true });
    const disabled = mkEntry({ schedule_id: 'off', report_id: 'r', cadence: 'daily', hour_utc: 18, enabled: false });
    const out = previewScheduleFleet([enabled, disabled], NOW, 6);
    expect(out.total_schedules_considered).toBe(2);
    expect(out.total_enabled).toBe(1);
    for (const i of out.items) expect(i.schedule_id).toBe('on');
  });
});

describe('M12.7 — validation', () => {
  test('n=0 throws invalid_input', () => {
    expect(() => previewScheduleFleet([], NOW, 0)).toThrow(FleetPreviewError);
  });
  test('n > max throws invalid_input', () => {
    expect(() => previewScheduleFleet([], NOW, 999)).toThrow(/n must be an integer/);
  });
  test('invalid from throws', () => {
    expect(() => previewScheduleFleet([], new Date(NaN), 5)).toThrow(/from must be a valid Date/);
  });
});

describe('M12.7 — tie-break', () => {
  test('same fire_at sorted by schedule_id asc', () => {
    // Two daily-6am schedules will fire at the same minute.
    const s1 = mkEntry({ schedule_id: 'b_sched', report_id: 'r', cadence: 'daily', hour_utc: 6 });
    const s2 = mkEntry({ schedule_id: 'a_sched', report_id: 'r', cadence: 'daily', hour_utc: 6 });
    const out = previewScheduleFleet([s1, s2], NOW, 4);
    // First two items share fire_at; sorted by schedule_id asc.
    expect(out.items[0]!.fire_at).toBe(out.items[1]!.fire_at);
    expect(out.items[0]!.schedule_id).toBe('a_sched');
    expect(out.items[1]!.schedule_id).toBe('b_sched');
  });
});

// ─── GET /v1/reports/schedules/upcoming ──────────────────────────────

function makeUpcomingApp(role = 'admin') {
  const reportScheduleStore = new InMemoryReportScheduleStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    reportScheduleStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, reportScheduleStore };
}

describe('M12.7 — GET /v1/reports/schedules/upcoming', () => {
  test('empty tenant → 200 zero envelope', async () => {
    const { app } = makeUpcomingApp('admin');
    const r = await request(app).get('/v1/reports/schedules/upcoming').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_returned).toBe(0);
    expect(r.body.body.items).toEqual([]);
  });

  test('records show up in the fleet preview', async () => {
    const { app, reportScheduleStore } = makeUpcomingApp('admin');
    reportScheduleStore.create(
      'BIL',
      {
        report_id: 'portfolio_snapshot_daily',
        format: 'json',
        name: 'daily snapshot',
        cadence: 'daily',
        hour_utc: 6,
        recipients: ['compliance@example.com'],
        enabled: true,
        parameters: {},
      },
      'alice',
      NOW,
    );
    const r = await request(app)
      .get('/v1/reports/schedules/upcoming?n=3')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_enabled).toBe(1);
    expect(r.body.body.total_returned).toBe(3);
    expect(r.body.body.items[0].name).toBe('daily snapshot');
  });

  test('invalid n → 400', async () => {
    const { app } = makeUpcomingApp('admin');
    const r = await request(app).get('/v1/reports/schedules/upcoming?n=999').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('invalid from → 400', async () => {
    const { app } = makeUpcomingApp('admin');
    const r = await request(app)
      .get('/v1/reports/schedules/upcoming?from=not-a-date')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeUpcomingApp('readonly');
    const r = await request(app).get('/v1/reports/schedules/upcoming').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL schedule invisible to BANK_DEMO', async () => {
    const { app, reportScheduleStore } = makeUpcomingApp('admin');
    reportScheduleStore.create(
      'BIL',
      {
        report_id: 'portfolio_snapshot_daily',
        format: 'json',
        name: 'bil-only',
        cadence: 'daily',
        hour_utc: 6,
        recipients: ['x@y.com'],
        enabled: true,
        parameters: {},
      },
      'alice',
      NOW,
    );
    const r = await request(app)
      .get('/v1/reports/schedules/upcoming')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total_returned).toBe(0);
  });
});
