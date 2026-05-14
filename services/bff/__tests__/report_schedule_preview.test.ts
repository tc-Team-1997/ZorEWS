// services/bff/__tests__/report_schedule_preview.test.ts
//
// T6 M12.6 — Recurring report schedule preview.

import request from 'supertest';
import {
  PREVIEW_DEFAULT_N,
  PREVIEW_MAX_N,
  SchedulePreviewError,
  previewScheduleRuns,
} from '../src/report_schedule_preview';
import {
  InMemoryReportScheduleStore,
  type ReportScheduleInput,
} from '../src/report_schedules';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── previewScheduleRuns — pure ──────────────────────────────────────

describe('M12.6 — previewScheduleRuns — daily cadence', () => {
  test('produces N consecutive daily fires at the configured hour', () => {
    const out = previewScheduleRuns(
      {
        cadence: 'daily',
        day_of_week: null,
        day_of_month: null,
        hour_utc: 8,
        tz: 'UTC',
      },
      new Date('2026-05-14T12:00:00.000Z'),
      5,
    );
    expect(out.map((r) => r.fire_at)).toEqual([
      '2026-05-15T08:00:00.000Z',
      '2026-05-16T08:00:00.000Z',
      '2026-05-17T08:00:00.000Z',
      '2026-05-18T08:00:00.000Z',
      '2026-05-19T08:00:00.000Z',
    ]);
    expect(out.map((r) => r.run_no)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('M12.6 — previewScheduleRuns — weekly cadence', () => {
  test('lands on the configured day_of_week each week', () => {
    // Wednesday = 3 (Sun=0)
    const out = previewScheduleRuns(
      {
        cadence: 'weekly',
        day_of_week: 3,
        day_of_month: null,
        hour_utc: 9,
        tz: 'UTC',
      },
      // NOW is 2026-05-14 (Thursday); next Wednesday is May 20.
      new Date('2026-05-14T12:00:00.000Z'),
      4,
    );
    // Every fire is a Wednesday.
    for (const r of out) {
      expect(new Date(r.fire_at).getUTCDay()).toBe(3);
    }
    expect(out[0]!.fire_at).toBe('2026-05-20T09:00:00.000Z');
    expect(out[1]!.fire_at).toBe('2026-05-27T09:00:00.000Z');
    expect(out[2]!.fire_at).toBe('2026-06-03T09:00:00.000Z');
    expect(out[3]!.fire_at).toBe('2026-06-10T09:00:00.000Z');
  });
});

describe('M12.6 — previewScheduleRuns — monthly cadence', () => {
  test('fires on the configured day_of_month each month', () => {
    const out = previewScheduleRuns(
      {
        cadence: 'monthly',
        day_of_week: null,
        day_of_month: 15,
        hour_utc: 10,
        tz: 'UTC',
      },
      new Date('2026-05-14T12:00:00.000Z'),
      4,
    );
    // First fire: 2026-05-15 (tomorrow) since today is 2026-05-14.
    expect(out[0]!.fire_at).toBe('2026-05-15T10:00:00.000Z');
    expect(out[1]!.fire_at).toBe('2026-06-15T10:00:00.000Z');
    expect(out[2]!.fire_at).toBe('2026-07-15T10:00:00.000Z');
    expect(out[3]!.fire_at).toBe('2026-08-15T10:00:00.000Z');
  });

  test('rolls Dec → Jan year boundary correctly', () => {
    const out = previewScheduleRuns(
      {
        cadence: 'monthly',
        day_of_week: null,
        day_of_month: 1,
        hour_utc: 0,
        tz: 'UTC',
      },
      new Date('2026-12-15T12:00:00.000Z'),
      3,
    );
    expect(out[0]!.fire_at).toBe('2027-01-01T00:00:00.000Z');
    expect(out[1]!.fire_at).toBe('2027-02-01T00:00:00.000Z');
    expect(out[2]!.fire_at).toBe('2027-03-01T00:00:00.000Z');
  });
});

describe('M12.6 — previewScheduleRuns — quarterly + last_day_of_month', () => {
  test('quarterly fires every 3 months on day_of_month', () => {
    const out = previewScheduleRuns(
      {
        cadence: 'quarterly',
        day_of_week: null,
        day_of_month: 1,
        hour_utc: 0,
        tz: 'UTC',
      },
      new Date('2026-05-14T12:00:00.000Z'),
      4,
    );
    // Quarter anchor depends on impl; just verify months are spaced 3 apart.
    for (let i = 1; i < out.length; i++) {
      const a = new Date(out[i - 1]!.fire_at);
      const b = new Date(out[i]!.fire_at);
      const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
      expect(months).toBe(3);
    }
  });

  test('last_day_of_month handles Feb 28/29 across years', () => {
    const out = previewScheduleRuns(
      {
        cadence: 'last_day_of_month',
        day_of_week: null,
        day_of_month: null,
        hour_utc: 23,
        tz: 'UTC',
      },
      // Span Feb 2027 (non-leap, 28) and Feb 2028 (leap, 29).
      new Date('2027-01-15T12:00:00.000Z'),
      14,
    );
    const feb2027 = out.find((r) => r.fire_at.startsWith('2027-02-'));
    const feb2028 = out.find((r) => r.fire_at.startsWith('2028-02-'));
    expect(feb2027?.fire_at).toBe('2027-02-28T23:00:00.000Z');
    expect(feb2028?.fire_at).toBe('2028-02-29T23:00:00.000Z');
  });
});

describe('M12.6 — previewScheduleRuns — invariants', () => {
  test('consecutive fires are strictly increasing', () => {
    const out = previewScheduleRuns(
      {
        cadence: 'daily',
        day_of_week: null,
        day_of_month: null,
        hour_utc: 0,
        tz: 'UTC',
      },
      NOW,
      20,
    );
    for (let i = 1; i < out.length; i++) {
      expect(new Date(out[i]!.fire_at).getTime()).toBeGreaterThan(
        new Date(out[i - 1]!.fire_at).getTime(),
      );
    }
  });

  test('n bounds: throws on 0, throws on > PREVIEW_MAX_N, throws on non-integer', () => {
    const base = {
      cadence: 'daily' as const,
      day_of_week: null,
      day_of_month: null,
      hour_utc: 0,
      tz: 'UTC' as const,
    };
    expect(() => previewScheduleRuns(base, NOW, 0)).toThrow(SchedulePreviewError);
    expect(() => previewScheduleRuns(base, NOW, PREVIEW_MAX_N + 1)).toThrow(SchedulePreviewError);
    expect(() => previewScheduleRuns(base, NOW, 1.5)).toThrow(SchedulePreviewError);
  });

  test('returns N rows exactly', () => {
    const out = previewScheduleRuns(
      {
        cadence: 'daily',
        day_of_week: null,
        day_of_month: null,
        hour_utc: 0,
        tz: 'UTC',
      },
      NOW,
      PREVIEW_MAX_N,
    );
    expect(out.length).toBe(PREVIEW_MAX_N);
  });
});

describe('M12.6 — previewScheduleRuns — tz handling', () => {
  test('Asia/Kolkata daily 9:00 IST → UTC 03:30', () => {
    const out = previewScheduleRuns(
      {
        cadence: 'daily',
        day_of_week: null,
        day_of_month: null,
        hour_utc: 9, // wall-clock hour in tz
        tz: 'Asia/Kolkata',
      },
      new Date('2026-05-14T00:00:00.000Z'),
      3,
    );
    // 09:00 IST = 03:30 UTC.
    for (const r of out) {
      const t = new Date(r.fire_at);
      expect(t.getUTCHours()).toBe(3);
      expect(t.getUTCMinutes()).toBe(30);
    }
  });
});

// ─── GET /v1/reports/schedules/:schedule_id/preview ──────────────────

function makePreviewApp(role = 'admin') {
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

function seedSchedule(
  store: InMemoryReportScheduleStore,
  tenant: string,
  o: Partial<ReportScheduleInput> = {},
) {
  const input: ReportScheduleInput = {
    report_id: o.report_id ?? 'portfolio_snapshot_daily',
    format: o.format ?? 'json',
    name: o.name ?? 'Daily portfolio',
    cadence: o.cadence ?? 'daily',
    hour_utc: o.hour_utc ?? 8,
    recipients: o.recipients ?? ['ops@example.com'],
    enabled: o.enabled ?? true,
    parameters: o.parameters ?? {},
    tz: o.tz ?? 'UTC',
  };
  if (o.day_of_week !== undefined) input.day_of_week = o.day_of_week;
  if (o.day_of_month !== undefined) input.day_of_month = o.day_of_month;
  return store.create(tenant, input, 'alice', NOW);
}

describe('M12.6 — GET /v1/reports/schedules/:schedule_id/preview', () => {
  test('default n=10 returns 10 rows', async () => {
    const { app, reportScheduleStore } = makePreviewApp('admin');
    const s = seedSchedule(reportScheduleStore, 'BIL');
    const r = await request(app)
      .get(`/v1/reports/schedules/${s.schedule_id}/preview`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.schedule_id).toBe(s.schedule_id);
    expect(r.body.body.runs.length).toBe(PREVIEW_DEFAULT_N);
    expect(r.body.body.n).toBe(PREVIEW_DEFAULT_N);
  });

  test('?n=3 honoured', async () => {
    const { app, reportScheduleStore } = makePreviewApp('admin');
    const s = seedSchedule(reportScheduleStore, 'BIL');
    const r = await request(app)
      .get(`/v1/reports/schedules/${s.schedule_id}/preview?n=3`)
      .set(TH_BIL);
    expect(r.body.body.runs.length).toBe(3);
  });

  test('?n=0 → 400', async () => {
    const { app, reportScheduleStore } = makePreviewApp('admin');
    const s = seedSchedule(reportScheduleStore, 'BIL');
    const r = await request(app)
      .get(`/v1/reports/schedules/${s.schedule_id}/preview?n=0`)
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test(`?n > ${PREVIEW_MAX_N} → 400`, async () => {
    const { app, reportScheduleStore } = makePreviewApp('admin');
    const s = seedSchedule(reportScheduleStore, 'BIL');
    const r = await request(app)
      .get(`/v1/reports/schedules/${s.schedule_id}/preview?n=${PREVIEW_MAX_N + 1}`)
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('?from=ISO honoured', async () => {
    const { app, reportScheduleStore } = makePreviewApp('admin');
    const s = seedSchedule(reportScheduleStore, 'BIL');
    const r = await request(app)
      .get(`/v1/reports/schedules/${s.schedule_id}/preview?from=2026-12-25T00:00:00Z&n=2`)
      .set(TH_BIL);
    // from=2026-12-25T00:00 with daily hour_utc=8 → next fire is
    // 2026-12-25T08 (same day, still strictly future), then 2026-12-26T08.
    expect(r.body.body.runs[0].fire_at).toBe('2026-12-25T08:00:00.000Z');
    expect(r.body.body.runs[1].fire_at).toBe('2026-12-26T08:00:00.000Z');
  });

  test('?from=invalid → 400', async () => {
    const { app, reportScheduleStore } = makePreviewApp('admin');
    const s = seedSchedule(reportScheduleStore, 'BIL');
    const r = await request(app)
      .get(`/v1/reports/schedules/${s.schedule_id}/preview?from=not-a-date`)
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('unknown schedule → 404', async () => {
    const { app } = makePreviewApp('admin');
    const r = await request(app)
      .get('/v1/reports/schedules/sch-does-not-exist/preview')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_schedule');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makePreviewApp('case_owner');
    const r = await request(app)
      .get('/v1/reports/schedules/anything/preview')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BANK_DEMO cannot preview BIL schedule', async () => {
    const { app, reportScheduleStore } = makePreviewApp('admin');
    const s = seedSchedule(reportScheduleStore, 'BIL');
    const r = await request(app)
      .get(`/v1/reports/schedules/${s.schedule_id}/preview`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(404);
  });
});
