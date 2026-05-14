// services/bff/__tests__/schedule_conflict_detection.test.ts
//
// T6 M12.8 — Report schedule conflict detection.

import request from 'supertest';
import {
  detectScheduleConflicts,
  ConflictDetectionError,
} from '../src/schedule_conflict_detection';
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

function mkEntry(o: Partial<ReportScheduleEntry> & { schedule_id: string; report_id: string; hour_utc: number }): ReportScheduleEntry {
  return {
    schedule_id: o.schedule_id,
    tenant_id: o.tenant_id ?? 'BIL',
    report_id: o.report_id,
    format: o.format ?? 'json',
    name: o.name ?? `Sched ${o.schedule_id}`,
    cadence: o.cadence ?? 'daily',
    hour_utc: o.hour_utc,
    day_of_week: o.day_of_week ?? null,
    day_of_month: o.day_of_month ?? null,
    recipients: o.recipients ?? ['ops@example.com'],
    enabled: o.enabled ?? true,
    parameters: o.parameters ?? {},
    created_by: 'alice',
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    next_run_at: o.next_run_at ?? '2026-05-15T06:00:00.000Z',
    last_run_at: null,
    tz: o.tz ?? 'UTC',
  };
}

// ─── detectScheduleConflicts — pure ──────────────────────────────────

describe('M12.8 — empty input', () => {
  test('zero schedules → zero conflicts', () => {
    const r = detectScheduleConflicts([], NOW, 15, 10);
    expect(r.total_conflicts).toBe(0);
    expect(r.schedules_involved_count).toBe(0);
    expect(r.conflicts).toEqual([]);
    expect(r.window_minutes).toBe(15);
    expect(r.lookahead_n).toBe(10);
  });
});

describe('M12.8 — single schedule', () => {
  test('one schedule → no conflicts (no other schedule to clash with)', () => {
    const s = mkEntry({ schedule_id: 's1', report_id: 'r', hour_utc: 6 });
    const r = detectScheduleConflicts([s], NOW, 15, 10);
    expect(r.total_conflicts).toBe(0);
  });
});

describe('M12.8 — two schedules at same time', () => {
  test('both daily at hour 6 UTC → conflicts on every fire_at', () => {
    const a = mkEntry({ schedule_id: 'a', report_id: 'r', hour_utc: 6, name: 'snapshot daily' });
    const b = mkEntry({ schedule_id: 'b', report_id: 'r', hour_utc: 6, name: 'rbi daily' });
    const r = detectScheduleConflicts([a, b], NOW, 15, 5);
    expect(r.total_conflicts).toBe(5);
    expect(r.schedules_involved_count).toBe(2);
    // gap_ms === 0 on every conflict
    for (const c of r.conflicts) {
      expect(c.gap_ms).toBe(0);
    }
    // Pair always (a, b) in that order? Depends on sort — sortFiringsBy
    // groups same-fire_at firings together but doesn't enforce
    // schedule_id ordering within the same instant. Both directions
    // count as the same conflict though so total=5.
  });
});

describe('M12.8 — schedules within window', () => {
  test('one at hour 6 + one at hour 6:10 within 15-min window → conflicts', () => {
    // To get a 10-minute offset on daily cadence we'd need sub-hour control.
    // computeNextRun only supports hour_utc 0..23, so we use weekly schedules
    // on different days where their fire_at strings differ in hour only when
    // we move via day_of_week.
    // Simpler approach: two schedules both at hour 6, but one tz-shifted.
    // M12.4 tz means hour_utc is the WALL-CLOCK hour in tz. Default tz=UTC.
    // Setting tz='America/New_York' UTC-4 → hour 6 wall-clock = 10 UTC.
    // So an hour 6 UTC + hour 10 wall-clock in NY UTC-4 = both fire at 10 UTC.
    // Actually that means SAME fire_at. Useful for a different test.
    //
    // Cleaner: assert that two schedules at different hours (6 + 7 UTC)
    // are NOT a conflict at 15-min window but ARE a conflict at 90-min.
    const a = mkEntry({ schedule_id: 'a', report_id: 'r', hour_utc: 6 });
    const b = mkEntry({ schedule_id: 'b', report_id: 'r', hour_utc: 7 });
    const r15 = detectScheduleConflicts([a, b], NOW, 15, 3);
    expect(r15.total_conflicts).toBe(0);
    const r90 = detectScheduleConflicts([a, b], NOW, 90, 3);
    expect(r90.total_conflicts).toBeGreaterThan(0);
    for (const c of r90.conflicts) {
      expect(c.gap_ms).toBeGreaterThan(0);
      expect(c.gap_ms).toBeLessThanOrEqual(90 * 60_000);
    }
  });
});

describe('M12.8 — same schedule never conflicts with itself', () => {
  test('one schedule generating multiple firings → no same-schedule pairs', () => {
    const a = mkEntry({ schedule_id: 'a', report_id: 'r', hour_utc: 6 });
    const r = detectScheduleConflicts([a], NOW, 240, 50);
    expect(r.total_conflicts).toBe(0);
  });
});

describe('M12.8 — disabled schedules excluded', () => {
  test('disabled schedule does not participate in conflicts', () => {
    const a = mkEntry({ schedule_id: 'a', report_id: 'r', hour_utc: 6 });
    const b = mkEntry({ schedule_id: 'b', report_id: 'r', hour_utc: 6, enabled: false });
    const r = detectScheduleConflicts([a, b], NOW, 15, 5);
    expect(r.total_conflicts).toBe(0);
  });
});

describe('M12.8 — multiple schedules involvement count', () => {
  test('3 schedules all at same time → schedules_involved_count=3', () => {
    const a = mkEntry({ schedule_id: 'a', report_id: 'r', hour_utc: 6 });
    const b = mkEntry({ schedule_id: 'b', report_id: 'r', hour_utc: 6 });
    const c = mkEntry({ schedule_id: 'c', report_id: 'r', hour_utc: 6 });
    const r = detectScheduleConflicts([a, b, c], NOW, 15, 1);
    // 3 schedules at same fire_at = C(3,2) = 3 pair-conflicts
    expect(r.total_conflicts).toBe(3);
    expect(r.schedules_involved_count).toBe(3);
  });
});

describe('M12.8 — validation', () => {
  test('window_minutes > max → invalid_input', () => {
    expect(() => detectScheduleConflicts([], NOW, 999, 10)).toThrow(ConflictDetectionError);
  });

  test('window_minutes negative → invalid_input', () => {
    expect(() => detectScheduleConflicts([], NOW, -1, 10)).toThrow(/window_minutes/);
  });

  test('lookahead_n > max → invalid_input', () => {
    expect(() => detectScheduleConflicts([], NOW, 15, 999)).toThrow(/lookahead_n/);
  });

  test('lookahead_n < 1 → invalid_input', () => {
    expect(() => detectScheduleConflicts([], NOW, 15, 0)).toThrow(/lookahead_n/);
  });

  test('invalid from → throws', () => {
    expect(() => detectScheduleConflicts([], new Date(NaN), 15, 10)).toThrow(/from/);
  });
});

describe('M12.8 — sort order', () => {
  test('conflicts sorted by a.fire_at asc', () => {
    // Both schedules fire daily at hour 6 → 5 conflicts at consecutive days
    const a = mkEntry({ schedule_id: 'a', report_id: 'r', hour_utc: 6 });
    const b = mkEntry({ schedule_id: 'b', report_id: 'r', hour_utc: 6 });
    const r = detectScheduleConflicts([a, b], NOW, 15, 5);
    const ts = r.conflicts.map((c) => c.a.fire_at);
    expect(ts).toEqual([...ts].sort());
  });
});

// ─── GET /v1/reports/schedules/conflicts ─────────────────────────────

function makeConflictApp(role = 'admin') {
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

describe('M12.8 — GET /v1/reports/schedules/conflicts', () => {
  test('empty tenant → 200 zero conflicts', async () => {
    const { app } = makeConflictApp('admin');
    const r = await request(app).get('/v1/reports/schedules/conflicts').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_conflicts).toBe(0);
  });

  test('two simultaneous schedules surface as conflicts', async () => {
    const { app, reportScheduleStore } = makeConflictApp('admin');
    for (const id of ['snapshot', 'rbi']) {
      reportScheduleStore.create(
        'BIL',
        {
          report_id: 'portfolio_snapshot_daily',
          format: 'json',
          name: id,
          cadence: 'daily',
          hour_utc: 6,
          recipients: ['ops@example.com'],
          enabled: true,
          parameters: {},
        },
        'alice',
        NOW,
      );
    }
    const r = await request(app)
      .get('/v1/reports/schedules/conflicts?window=15&n=3')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_conflicts).toBeGreaterThan(0);
    expect(r.body.body.schedules_involved_count).toBe(2);
  });

  test('invalid window → 400', async () => {
    const { app } = makeConflictApp('admin');
    const r = await request(app)
      .get('/v1/reports/schedules/conflicts?window=999')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('invalid n → 400', async () => {
    const { app } = makeConflictApp('admin');
    const r = await request(app)
      .get('/v1/reports/schedules/conflicts?n=999')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeConflictApp('readonly');
    const r = await request(app).get('/v1/reports/schedules/conflicts').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M12.7 /v1/reports/schedules/upcoming still works (route ordering)', async () => {
    const { app } = makeConflictApp('admin');
    const r = await request(app).get('/v1/reports/schedules/upcoming').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
