// services/bff/__tests__/report_schedules.test.ts
//
// T6 M12.2 — Recurring report schedules.

import request from 'supertest';
import {
  InMemoryReportScheduleStore,
  ScheduleError,
  computeNextRun,
  isScheduleCadence,
  type ReportScheduleInput,
} from '../src/report_schedules';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T12:00:00.000Z'); // Tue
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const VALID: ReportScheduleInput = {
  report_id: 'portfolio_snapshot_daily',
  format: 'pdf',
  name: 'Portfolio daily PDF',
  cadence: 'daily',
  hour_utc: 6,
  recipients: ['compliance.lead@bil.example.com'],
};

function makeSchedApp(role: string = 'admin') {
  const store = new InMemoryReportScheduleStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    reportScheduleStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

// ─── Type guards ──────────────────────────────────────────────────────

describe('isScheduleCadence', () => {
  test('accepts daily/weekly/monthly', () => {
    expect(isScheduleCadence('daily')).toBe(true);
    expect(isScheduleCadence('weekly')).toBe(true);
    expect(isScheduleCadence('monthly')).toBe(true);
  });
  test('accepts quarterly + last_day_of_month (M12.3 additive)', () => {
    expect(isScheduleCadence('quarterly')).toBe(true);
    expect(isScheduleCadence('last_day_of_month')).toBe(true);
  });
  test('rejects others', () => {
    expect(isScheduleCadence('hourly')).toBe(false);
    expect(isScheduleCadence('annual')).toBe(false);
    expect(isScheduleCadence(42)).toBe(false);
  });
});

// ─── computeNextRun ────────────────────────────────────────────────────

describe('computeNextRun', () => {
  test('daily — same day if hour is in the future', () => {
    const after = new Date('2026-05-05T05:00:00Z');
    const next = computeNextRun('daily', null, null, 6, after);
    expect(next.toISOString()).toBe('2026-05-05T06:00:00.000Z');
  });

  test('daily — tomorrow if hour has passed', () => {
    const after = new Date('2026-05-05T07:00:00Z');
    const next = computeNextRun('daily', null, null, 6, after);
    expect(next.toISOString()).toBe('2026-05-06T06:00:00.000Z');
  });

  test('daily — exactly at the hour rolls forward to tomorrow (strictly future)', () => {
    const after = new Date('2026-05-05T06:00:00Z');
    const next = computeNextRun('daily', null, null, 6, after);
    expect(next.toISOString()).toBe('2026-05-06T06:00:00.000Z');
  });

  test('weekly — same week if dow is later', () => {
    // 2026-05-05 is Tuesday (dow=2). Targeting Friday (5).
    const next = computeNextRun('weekly', 5, null, 9, NOW);
    expect(next.toISOString()).toBe('2026-05-08T09:00:00.000Z');
  });

  test('weekly — same dow but earlier hour rolls a week', () => {
    // Tue 12:00 UTC, target Tue 09:00 → next Tue
    const next = computeNextRun('weekly', 2, null, 9, NOW);
    expect(next.toISOString()).toBe('2026-05-12T09:00:00.000Z');
  });

  test('weekly — same dow same hour rolls a week (strictly future)', () => {
    const after = new Date('2026-05-05T09:00:00Z');
    const next = computeNextRun('weekly', 2, null, 9, after);
    expect(next.toISOString()).toBe('2026-05-12T09:00:00.000Z');
  });

  test('weekly — earlier dow this week rolls forward', () => {
    // Tue 12:00. Target Monday (1). Should jump to next Monday.
    const next = computeNextRun('weekly', 1, null, 9, NOW);
    expect(next.toISOString()).toBe('2026-05-11T09:00:00.000Z');
  });

  test('weekly — throws when day_of_week is null', () => {
    expect(() => computeNextRun('weekly', null, null, 9, NOW)).toThrow(/day_of_week/);
  });

  test('monthly — this month if dom is later', () => {
    // 2026-05-05 → target 15th
    const next = computeNextRun('monthly', null, 15, 6, NOW);
    expect(next.toISOString()).toBe('2026-05-15T06:00:00.000Z');
  });

  test('monthly — next month if dom has passed', () => {
    // 2026-05-05 → target 1st of month
    const next = computeNextRun('monthly', null, 1, 6, NOW);
    expect(next.toISOString()).toBe('2026-06-01T06:00:00.000Z');
  });

  test('monthly — same dom same hour rolls a month', () => {
    const after = new Date('2026-05-15T06:00:00Z');
    const next = computeNextRun('monthly', null, 15, 6, after);
    expect(next.toISOString()).toBe('2026-06-15T06:00:00.000Z');
  });

  test('monthly — throws when day_of_month is null', () => {
    expect(() => computeNextRun('monthly', null, null, 6, NOW)).toThrow(/day_of_month/);
  });

  test('monthly — December → January year roll', () => {
    const after = new Date('2026-12-20T06:00:00Z');
    const next = computeNextRun('monthly', null, 15, 6, after);
    expect(next.toISOString()).toBe('2027-01-15T06:00:00.000Z');
  });

  // ── M12.3 — Quarterly + last_day_of_month cadences ─────────────────
  test('quarterly — fires on quarter-start month at day_of_month', () => {
    // 2026-05-05 is in Q2 (Apr-Jun). Quarter start = April. day_of_month=15 has passed?
    // Apr 15 06:00 vs May 5 12:00 → past → next quarter (Jul 15)
    const after = new Date('2026-05-05T12:00:00Z');
    const next = computeNextRun('quarterly', null, 15, 6, after);
    expect(next.toISOString()).toBe('2026-07-15T06:00:00.000Z');
  });

  test('quarterly — same quarter when day_of_month is in the future', () => {
    // 2026-04-01 in Q2. Quarter start month = April. dom=15 not yet passed.
    const after = new Date('2026-04-01T00:00:00Z');
    const next = computeNextRun('quarterly', null, 15, 6, after);
    expect(next.toISOString()).toBe('2026-04-15T06:00:00.000Z');
  });

  test('quarterly — Q4 → Q1 year roll', () => {
    const after = new Date('2026-11-15T00:00:00Z');
    const next = computeNextRun('quarterly', null, 1, 6, after);
    // Q4 starts Oct. Oct 1 06:00 past → next Q1 = Jan 1 2027
    expect(next.toISOString()).toBe('2027-01-01T06:00:00.000Z');
  });

  test('quarterly — throws when day_of_month is null', () => {
    expect(() => computeNextRun('quarterly', null, null, 6, new Date())).toThrow(/day_of_month/);
  });

  test('last_day_of_month — fires on last day of THIS month', () => {
    const after = new Date('2026-05-05T00:00:00Z');
    const next = computeNextRun('last_day_of_month', null, null, 23, after);
    // May has 31 days
    expect(next.toISOString()).toBe('2026-05-31T23:00:00.000Z');
  });

  test('last_day_of_month — Feb non-leap year (28 days)', () => {
    const after = new Date('2026-02-01T00:00:00Z');
    const next = computeNextRun('last_day_of_month', null, null, 6, after);
    expect(next.toISOString()).toBe('2026-02-28T06:00:00.000Z');
  });

  test('last_day_of_month — leap-year Feb (29 days)', () => {
    const after = new Date('2024-02-01T00:00:00Z');
    const next = computeNextRun('last_day_of_month', null, null, 6, after);
    expect(next.toISOString()).toBe('2024-02-29T06:00:00.000Z');
  });

  test('last_day_of_month — past last day rolls to next month', () => {
    const after = new Date('2026-05-31T23:00:01Z');
    const next = computeNextRun('last_day_of_month', null, null, 23, after);
    expect(next.toISOString()).toBe('2026-06-30T23:00:00.000Z');
  });

  test('last_day_of_month — December → January', () => {
    const after = new Date('2026-12-31T23:00:01Z');
    const next = computeNextRun('last_day_of_month', null, null, 23, after);
    expect(next.toISOString()).toBe('2027-01-31T23:00:00.000Z');
  });
});

// ─── Store: create ────────────────────────────────────────────────────

describe('InMemoryReportScheduleStore.create', () => {
  test('happy path returns entry with computed next_run_at', () => {
    const s = new InMemoryReportScheduleStore();
    const e = s.create('BIL', VALID, 'admin', NOW);
    expect(e.schedule_id).toMatch(/^sch-/);
    expect(e.tenant_id).toBe('BIL');
    expect(e.report_id).toBe('portfolio_snapshot_daily');
    expect(e.cadence).toBe('daily');
    expect(e.enabled).toBe(true);
    expect(e.last_run_at).toBeNull();
    expect(e.next_run_at).toBe('2026-05-06T06:00:00.000Z'); // 06:00 next day
  });

  test('weekly entry stores day_of_week, nulls day_of_month', () => {
    const s = new InMemoryReportScheduleStore();
    const e = s.create('BIL', { ...VALID, cadence: 'weekly', day_of_week: 5, hour_utc: 9 }, 'admin', NOW);
    expect(e.day_of_week).toBe(5);
    expect(e.day_of_month).toBeNull();
    expect(e.next_run_at).toBe('2026-05-08T09:00:00.000Z'); // next Friday
  });

  test('monthly entry stores day_of_month, nulls day_of_week', () => {
    const s = new InMemoryReportScheduleStore();
    const e = s.create('BIL', { ...VALID, cadence: 'monthly', day_of_month: 15, hour_utc: 6 }, 'admin', NOW);
    expect(e.day_of_month).toBe(15);
    expect(e.day_of_week).toBeNull();
  });

  test('explicit enabled=false honoured', () => {
    const s = new InMemoryReportScheduleStore();
    const e = s.create('BIL', { ...VALID, enabled: false }, 'admin', NOW);
    expect(e.enabled).toBe(false);
  });

  test('parameters defaulted to empty object', () => {
    const s = new InMemoryReportScheduleStore();
    const e = s.create('BIL', VALID, 'admin', NOW);
    expect(e.parameters).toEqual({});
  });

  test('parameters echoed when supplied', () => {
    const s = new InMemoryReportScheduleStore();
    const e = s.create('BIL', { ...VALID, parameters: { period: 'monthly' } }, 'admin', NOW);
    expect(e.parameters).toEqual({ period: 'monthly' });
  });

  test('rejects unknown report_id (cross-checks M12.1 catalog)', () => {
    const s = new InMemoryReportScheduleStore();
    try {
      s.create('BIL', { ...VALID, report_id: 'NO-SUCH' }, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ScheduleError).code).toBe('invalid_report_id');
    }
  });

  test('rejects format not in supported_formats for the report', () => {
    // sla_breach_digest only supports json + csv
    const s = new InMemoryReportScheduleStore();
    try {
      s.create('BIL', { ...VALID, report_id: 'sla_breach_digest', format: 'pdf' }, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ScheduleError).code).toBe('invalid_format');
    }
  });

  test('rejects bad cadence', () => {
    const s = new InMemoryReportScheduleStore();
    try {
      s.create('BIL', { ...VALID, cadence: 'hourly' as never }, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ScheduleError).code).toBe('invalid_cadence');
    }
  });

  test('rejects hour_utc out of range', () => {
    const s = new InMemoryReportScheduleStore();
    expect(() => s.create('BIL', { ...VALID, hour_utc: 24 }, 'admin', NOW)).toThrow(/hour_utc/);
    expect(() => s.create('BIL', { ...VALID, hour_utc: -1 }, 'admin', NOW)).toThrow(/hour_utc/);
    expect(() => s.create('BIL', { ...VALID, hour_utc: 5.5 }, 'admin', NOW)).toThrow(/hour_utc/);
  });

  test('weekly without day_of_week → invalid_input', () => {
    const s = new InMemoryReportScheduleStore();
    expect(() => s.create('BIL', { ...VALID, cadence: 'weekly' }, 'admin', NOW)).toThrow(/day_of_week/);
  });

  test('monthly day_of_month > 28 rejected', () => {
    const s = new InMemoryReportScheduleStore();
    expect(() =>
      s.create('BIL', { ...VALID, cadence: 'monthly', day_of_month: 29 }, 'admin', NOW),
    ).toThrow(/1-28/);
  });

  test('empty recipients[] rejected', () => {
    const s = new InMemoryReportScheduleStore();
    try {
      s.create('BIL', { ...VALID, recipients: [] }, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ScheduleError).code).toBe('invalid_recipients');
    }
  });

  test('> 25 recipients rejected', () => {
    const s = new InMemoryReportScheduleStore();
    const many = new Array(26).fill('x@bil.example.com');
    try {
      s.create('BIL', { ...VALID, recipients: many }, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ScheduleError).code).toBe('invalid_recipients');
    }
  });

  test('non-email recipient rejected', () => {
    const s = new InMemoryReportScheduleStore();
    try {
      s.create('BIL', { ...VALID, recipients: ['not-an-email'] }, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ScheduleError).code).toBe('invalid_recipients');
    }
  });

  test('cap_reached error after 50 schedules', () => {
    const s = new InMemoryReportScheduleStore({ cap: 3 });
    s.create('BIL', VALID, 'admin', NOW);
    s.create('BIL', VALID, 'admin', NOW);
    s.create('BIL', VALID, 'admin', NOW);
    try {
      s.create('BIL', VALID, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ScheduleError).code).toBe('cap_reached');
    }
  });

  test('missing created_by rejected', () => {
    const s = new InMemoryReportScheduleStore();
    expect(() => s.create('BIL', VALID, '', NOW)).toThrow(/created_by/);
  });

  test('non-object parameters rejected', () => {
    const s = new InMemoryReportScheduleStore();
    expect(() =>
      s.create('BIL', { ...VALID, parameters: [] as unknown as Record<string, unknown> }, 'admin', NOW),
    ).toThrow(/parameters/);
  });
});

// ─── Store: list / get / delete ───────────────────────────────────────

describe('InMemoryReportScheduleStore.list / get / delete', () => {
  test('list returns newest-first', async () => {
    const s = new InMemoryReportScheduleStore();
    s.create('BIL', VALID, 'admin', new Date('2026-05-01T00:00:00Z'));
    s.create('BIL', VALID, 'admin', new Date('2026-05-02T00:00:00Z'));
    s.create('BIL', VALID, 'admin', new Date('2026-05-03T00:00:00Z'));
    const r = s.list('BIL', 1, 10);
    expect(r.total).toBe(3);
    expect(r.items[0]!.created_at).toBe('2026-05-03T00:00:00.000Z');
    expect(r.items[2]!.created_at).toBe('2026-05-01T00:00:00.000Z');
  });

  test('list pagination', () => {
    const s = new InMemoryReportScheduleStore();
    for (let i = 0; i < 5; i++) {
      s.create('BIL', VALID, 'admin', new Date(`2026-05-0${i + 1}T00:00:00Z`));
    }
    const r = s.list('BIL', 2, 2);
    expect(r.items.length).toBe(2);
    expect(r.page).toBe(2);
  });

  test('get round-trip + cross-tenant isolation', () => {
    const s = new InMemoryReportScheduleStore();
    const a = s.create('BIL', VALID, 'admin', NOW);
    const b = s.create('BANK_DEMO', VALID, 'admin', NOW);
    expect(s.get('BIL', a.schedule_id)?.schedule_id).toBe(a.schedule_id);
    expect(s.get('BIL', b.schedule_id)).toBeNull();
    expect(s.get('BANK_DEMO', a.schedule_id)).toBeNull();
  });

  test('delete returns true on hit, false on miss', () => {
    const s = new InMemoryReportScheduleStore();
    const e = s.create('BIL', VALID, 'admin', NOW);
    expect(s.delete('BIL', e.schedule_id)).toBe(true);
    expect(s.delete('BIL', e.schedule_id)).toBe(false);
    expect(s.get('BIL', e.schedule_id)).toBeNull();
  });
});

// ─── Store: update ────────────────────────────────────────────────────

describe('InMemoryReportScheduleStore.update', () => {
  test('patch name + recipients', () => {
    const s = new InMemoryReportScheduleStore();
    const e = s.create('BIL', VALID, 'admin', NOW);
    const u = s.update('BIL', e.schedule_id, {
      name: 'New name',
      recipients: ['x@bil.example.com', 'y@bil.example.com'],
    }, NOW);
    expect(u.name).toBe('New name');
    expect(u.recipients).toEqual(['x@bil.example.com', 'y@bil.example.com']);
  });

  test('patching cadence recomputes next_run_at', () => {
    const s = new InMemoryReportScheduleStore();
    const e = s.create('BIL', VALID, 'admin', NOW); // daily 06 UTC → 2026-05-06T06
    const u = s.update('BIL', e.schedule_id, {
      cadence: 'weekly',
      day_of_week: 5,
      hour_utc: 9,
    }, NOW);
    expect(u.cadence).toBe('weekly');
    expect(u.day_of_week).toBe(5);
    expect(u.next_run_at).toBe('2026-05-08T09:00:00.000Z');
  });

  test('toggling enabled does not recompute next_run_at', () => {
    const s = new InMemoryReportScheduleStore();
    const e = s.create('BIL', VALID, 'admin', NOW);
    const u = s.update('BIL', e.schedule_id, { enabled: false }, NOW);
    expect(u.next_run_at).toBe(e.next_run_at);
    expect(u.enabled).toBe(false);
  });

  test('cadence switch clears the irrelevant timing field', () => {
    const s = new InMemoryReportScheduleStore();
    const e = s.create(
      'BIL',
      { ...VALID, cadence: 'weekly', day_of_week: 5, hour_utc: 9 },
      'admin',
      NOW,
    );
    expect(e.day_of_week).toBe(5);
    const u = s.update('BIL', e.schedule_id, {
      cadence: 'monthly',
      day_of_month: 1,
      hour_utc: 9,
    }, NOW);
    expect(u.day_of_week).toBeNull();
    expect(u.day_of_month).toBe(1);
  });

  test('unknown_schedule on miss', () => {
    const s = new InMemoryReportScheduleStore();
    try {
      s.update('BIL', 'NO-SUCH', { name: 'x' }, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ScheduleError).code).toBe('unknown_schedule');
    }
  });

  test('invalid patch (bad recipient) rejected', () => {
    const s = new InMemoryReportScheduleStore();
    const e = s.create('BIL', VALID, 'admin', NOW);
    expect(() => s.update('BIL', e.schedule_id, { recipients: ['x'] }, NOW)).toThrow(/valid email/);
  });
});

// ─── Store: listDue / markRun ─────────────────────────────────────────

describe('listDue / markRun', () => {
  test('listDue returns enabled schedules whose next_run_at <= as_of', () => {
    const s = new InMemoryReportScheduleStore();
    // hour 6, daily — next_run = 2026-05-06T06:00
    const a = s.create('BIL', VALID, 'admin', NOW);
    // Re-build store with an entry that should fire later
    const b = s.create(
      'BIL',
      { ...VALID, name: 'later', cadence: 'monthly', day_of_month: 28, hour_utc: 6 },
      'admin',
      NOW,
    );
    const due = s.listDue('BIL', new Date('2026-05-06T06:00:00.000Z'));
    expect(due.map((e) => e.schedule_id)).toContain(a.schedule_id);
    expect(due.map((e) => e.schedule_id)).not.toContain(b.schedule_id);
  });

  test('listDue skips disabled schedules', () => {
    const s = new InMemoryReportScheduleStore();
    s.create('BIL', { ...VALID, enabled: false }, 'admin', NOW);
    const due = s.listDue('BIL', new Date('2030-01-01T00:00:00Z'));
    expect(due).toEqual([]);
  });

  test('listDue returns earliest-first', () => {
    const s = new InMemoryReportScheduleStore();
    const later = s.create(
      'BIL',
      { ...VALID, name: 'later', cadence: 'monthly', day_of_month: 28, hour_utc: 6 },
      'admin',
      NOW,
    );
    const sooner = s.create('BIL', VALID, 'admin', NOW);
    const due = s.listDue('BIL', new Date('2030-01-01T00:00:00Z'));
    expect(due[0]!.schedule_id).toBe(sooner.schedule_id);
    expect(due[1]!.schedule_id).toBe(later.schedule_id);
  });

  test('markRun bumps last_run_at + advances next_run_at', () => {
    const s = new InMemoryReportScheduleStore();
    const e = s.create('BIL', VALID, 'admin', NOW); // next = 2026-05-06T06
    const fired = new Date('2026-05-06T06:00:30.000Z');
    const u = s.markRun('BIL', e.schedule_id, fired);
    expect(u.last_run_at).toBe('2026-05-06T06:00:30.000Z');
    expect(u.next_run_at).toBe('2026-05-07T06:00:00.000Z');
  });

  test('markRun on unknown schedule throws', () => {
    const s = new InMemoryReportScheduleStore();
    try {
      s.markRun('BIL', 'NO-SUCH', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ScheduleError).code).toBe('unknown_schedule');
    }
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('POST /v1/reports/schedules', () => {
  test('admin: 201 with entry body', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app)
      .post('/v1/reports/schedules')
      .set(TH_BIL)
      .set('X-APEX-USER', 'compliance.lead')
      .send(VALID);
    expect(r.status).toBe(201);
    expect(r.body.body.schedule_id).toMatch(/^sch-/);
    expect(r.body.body.created_by).toBe('compliance.lead');
    expect(r.body.body.next_run_at).toBe('2026-05-06T06:00:00.000Z');
  });

  test('accepts enveloped body', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app)
      .post('/v1/reports/schedules')
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: VALID });
    expect(r.status).toBe(201);
  });

  test('invalid_report_id → 400', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app)
      .post('/v1/reports/schedules')
      .set(TH_BIL)
      .send({ ...VALID, report_id: 'NO-SUCH' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_report_id');
  });

  test('invalid_format (not in supported_formats) → 400', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app)
      .post('/v1/reports/schedules')
      .set(TH_BIL)
      .send({ ...VALID, report_id: 'sla_breach_digest', format: 'pdf' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_format');
  });

  test('invalid_cadence → 400', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app)
      .post('/v1/reports/schedules')
      .set(TH_BIL)
      .send({ ...VALID, cadence: 'hourly' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_cadence');
  });

  test('invalid_recipients (empty) → 400', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app)
      .post('/v1/reports/schedules')
      .set(TH_BIL)
      .send({ ...VALID, recipients: [] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_recipients');
  });

  test('invalid_recipients (non-email) → 400', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app)
      .post('/v1/reports/schedules')
      .set(TH_BIL)
      .send({ ...VALID, recipients: ['plain text'] });
    expect(r.status).toBe(400);
  });

  test('cap_reached → 409', async () => {
    const { app } = makeSchedApp('admin');
    // Build app with cap 1 by directly using the store.
    const store = new InMemoryReportScheduleStore({ cap: 1 });
    const built = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      reportScheduleStore: store,
      now: () => NOW,
      getRole: () => 'admin',
    });
    await request(built.app).post('/v1/reports/schedules').set(TH_BIL).send(VALID);
    const r = await request(built.app).post('/v1/reports/schedules').set(TH_BIL).send(VALID);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_cap_reached');
    void app;
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSchedApp('case_owner');
    const r = await request(app).post('/v1/reports/schedules').set(TH_BIL).send(VALID);
    expect(r.status).toBe(403);
  });

  // ── M12.3 — quarterly + last_day_of_month cadences via routes ──────
  test('quarterly cadence accepted with day_of_month', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app)
      .post('/v1/reports/schedules')
      .set(TH_BIL)
      .send({ ...VALID, cadence: 'quarterly', day_of_month: 1, hour_utc: 6 });
    expect(r.status).toBe(201);
    expect(r.body.body.cadence).toBe('quarterly');
    expect(r.body.body.day_of_month).toBe(1);
  });

  test('quarterly without day_of_month → 400', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app)
      .post('/v1/reports/schedules')
      .set(TH_BIL)
      .send({ ...VALID, cadence: 'quarterly', hour_utc: 6 });
    expect(r.status).toBe(400);
  });

  test('last_day_of_month cadence accepted (no day_of_month)', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app)
      .post('/v1/reports/schedules')
      .set(TH_BIL)
      .send({ ...VALID, cadence: 'last_day_of_month', hour_utc: 23 });
    expect(r.status).toBe(201);
    expect(r.body.body.cadence).toBe('last_day_of_month');
    expect(r.body.body.day_of_month).toBeNull();
  });
});

describe('GET /v1/reports/schedules', () => {
  test('admin: 200 newest-first', async () => {
    const { app } = makeSchedApp('admin');
    await request(app).post('/v1/reports/schedules').set(TH_BIL).send({ ...VALID, name: 'A' });
    await request(app).post('/v1/reports/schedules').set(TH_BIL).send({ ...VALID, name: 'B' });
    const r = await request(app).get('/v1/reports/schedules').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSchedApp('case_owner');
    const r = await request(app).get('/v1/reports/schedules').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/reports/schedules/due', () => {
  test('returns due schedules at as_of', async () => {
    const { app } = makeSchedApp('admin');
    await request(app).post('/v1/reports/schedules').set(TH_BIL).send(VALID);
    const r = await request(app)
      .get('/v1/reports/schedules/due?as_of=2026-05-06T06:00:00Z')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(1);
  });

  test('default as_of = now (no due ones immediately after creation)', async () => {
    const { app } = makeSchedApp('admin');
    await request(app).post('/v1/reports/schedules').set(TH_BIL).send(VALID);
    const r = await request(app).get('/v1/reports/schedules/due').set(TH_BIL);
    expect(r.body.body.total).toBe(0);
  });

  test('invalid as_of → 400', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app)
      .get('/v1/reports/schedules/due?as_of=not-a-date')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('literal "due" route is not shadowed by /:schedule_id', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app).get('/v1/reports/schedules/due').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.body.items)).toBe(true);
  });
});

describe('GET /v1/reports/schedules/:id', () => {
  test('200 on hit', async () => {
    const { app } = makeSchedApp('admin');
    const created = await request(app).post('/v1/reports/schedules').set(TH_BIL).send(VALID);
    const id = created.body.body.schedule_id;
    const r = await request(app).get(`/v1/reports/schedules/${id}`).set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.schedule_id).toBe(id);
  });

  test('404 on miss with EWS_404_unknown_schedule', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app).get('/v1/reports/schedules/sch-NO').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_schedule');
  });

  test('cross-tenant 404', async () => {
    const { app } = makeSchedApp('admin');
    const created = await request(app).post('/v1/reports/schedules').set(TH_BIL).send(VALID);
    const id = created.body.body.schedule_id;
    const r = await request(app)
      .get(`/v1/reports/schedules/${id}`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(404);
  });
});

describe('PATCH /v1/reports/schedules/:id', () => {
  test('updates name + recipients', async () => {
    const { app } = makeSchedApp('admin');
    const created = await request(app).post('/v1/reports/schedules').set(TH_BIL).send(VALID);
    const id = created.body.body.schedule_id;
    const r = await request(app)
      .patch(`/v1/reports/schedules/${id}`)
      .set(TH_BIL)
      .send({ name: 'Renamed', enabled: false });
    expect(r.status).toBe(200);
    expect(r.body.body.name).toBe('Renamed');
    expect(r.body.body.enabled).toBe(false);
  });

  test('404 on unknown', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app)
      .patch('/v1/reports/schedules/sch-NO')
      .set(TH_BIL)
      .send({ name: 'x' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_schedule');
  });

  test('400 on invalid patch', async () => {
    const { app } = makeSchedApp('admin');
    const created = await request(app).post('/v1/reports/schedules').set(TH_BIL).send(VALID);
    const id = created.body.body.schedule_id;
    const r = await request(app)
      .patch(`/v1/reports/schedules/${id}`)
      .set(TH_BIL)
      .send({ recipients: ['plain text'] });
    expect(r.status).toBe(400);
  });
});

describe('DELETE /v1/reports/schedules/:id', () => {
  test('204 on success then 404 on second delete', async () => {
    const { app } = makeSchedApp('admin');
    const created = await request(app).post('/v1/reports/schedules').set(TH_BIL).send(VALID);
    const id = created.body.body.schedule_id;
    const r = await request(app).delete(`/v1/reports/schedules/${id}`).set(TH_BIL);
    expect(r.status).toBe(204);
    const again = await request(app).delete(`/v1/reports/schedules/${id}`).set(TH_BIL);
    expect(again.status).toBe(404);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSchedApp('case_owner');
    const r = await request(app).delete('/v1/reports/schedules/sch-X').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/reports/schedules/:id/mark-run', () => {
  test('200 advances next_run_at + records last_run_at', async () => {
    const { app } = makeSchedApp('admin');
    const created = await request(app).post('/v1/reports/schedules').set(TH_BIL).send(VALID);
    const id = created.body.body.schedule_id;
    const r = await request(app)
      .post(`/v1/reports/schedules/${id}/mark-run`)
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.body.last_run_at).toBe(NOW.toISOString());
    // NOW=12:00, daily 06:00 → next would be tomorrow at 06
    expect(r.body.body.next_run_at).toBe('2026-05-06T06:00:00.000Z');
  });

  test('404 on unknown', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app)
      .post('/v1/reports/schedules/sch-NO/mark-run')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(404);
  });
});

// ─── No-regression ────────────────────────────────────────────────────

describe('No-regression: M12.1 reports routes still work', () => {
  test('GET /v1/reports/catalog still 200', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app).get('/v1/reports/catalog').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('GET /v1/reports/catalog/:id still 200 (sub-paths didn\'t shadow)', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app).get('/v1/reports/catalog/portfolio_snapshot_daily').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('GET /v1/reports/jobs still 200', async () => {
    const { app } = makeSchedApp('admin');
    const r = await request(app).get('/v1/reports/jobs').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
