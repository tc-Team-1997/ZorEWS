// services/bff/__tests__/report_schedule_cadence_stats.test.ts
//
// T6 M12.9 — Report schedule cadence statistics.

import request from 'supertest';
import { buildScheduleCadenceStats } from '../src/report_schedule_cadence_stats';
import {
  InMemoryReportScheduleStore,
  VALID_CADENCES,
  type ReportScheduleInput,
} from '../src/report_schedules';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function dailyInput(name: string, enabled = true): ReportScheduleInput {
  return {
    report_id: 'portfolio_snapshot_daily',
    format: 'pdf',
    name,
    cadence: 'daily',
    hour_utc: 6,
    recipients: ['ops@example.com'],
    enabled,
  };
}

function weeklyInput(name: string, enabled = true): ReportScheduleInput {
  return {
    report_id: 'alerts_activity_weekly',
    format: 'csv',
    name,
    cadence: 'weekly',
    hour_utc: 8,
    day_of_week: 1,
    recipients: ['ops@example.com'],
    enabled,
  };
}

function monthlyInput(name: string, enabled = true): ReportScheduleInput {
  return {
    report_id: 'case_outcomes_monthly',
    format: 'csv',
    name,
    cadence: 'monthly',
    hour_utc: 9,
    day_of_month: 1,
    recipients: ['ops@example.com'],
    enabled,
  };
}

// ─── buildScheduleCadenceStats — pure ────────────────────────────────

describe('M12.9 — fresh tenant (no schedules)', () => {
  test('every cadence present with zero counts', () => {
    const store = new InMemoryReportScheduleStore();
    const stats = buildScheduleCadenceStats(store, 'BIL', NOW);
    expect(stats.tenant_id).toBe('BIL');
    expect(stats.generated_at).toBe(NOW.toISOString());
    expect(stats.total_schedules).toBe(0);
    expect(stats.total_enabled).toBe(0);
    expect(stats.total_disabled).toBe(0);
    expect(stats.cadences.length).toBe(VALID_CADENCES.length);
    for (const c of stats.cadences) {
      expect(c.total_count).toBe(0);
      expect(c.enabled_count).toBe(0);
      expect(c.disabled_count).toBe(0);
      expect(c.next_run_within_24h_count).toBe(0);
      expect(c.next_run_within_7d_count).toBe(0);
      expect(c.earliest_next_run_at).toBeNull();
    }
    expect(stats.most_common_cadence).toBeNull();
    expect(stats.unused_cadences.length).toBe(VALID_CADENCES.length);
  });
});

describe('M12.9 — cadences emitted in canonical order', () => {
  test('cadences[] order matches VALID_CADENCES', () => {
    const store = new InMemoryReportScheduleStore();
    const stats = buildScheduleCadenceStats(store, 'BIL', NOW);
    expect(stats.cadences.map((c) => c.cadence)).toEqual([...VALID_CADENCES]);
  });
});

describe('M12.9 — single enabled schedule', () => {
  test('total + enabled + cadence row populated', () => {
    const store = new InMemoryReportScheduleStore();
    store.create('BIL', dailyInput('s1', true), 'alice', NOW);
    const stats = buildScheduleCadenceStats(store, 'BIL', NOW);
    expect(stats.total_schedules).toBe(1);
    expect(stats.total_enabled).toBe(1);
    const daily = stats.cadences.find((c) => c.cadence === 'daily')!;
    expect(daily.total_count).toBe(1);
    expect(daily.enabled_count).toBe(1);
    expect(daily.disabled_count).toBe(0);
    expect(daily.earliest_next_run_at).not.toBeNull();
  });
});

describe('M12.9 — disabled schedule', () => {
  test('disabled schedule bumps disabled_count + skips next-run windows', () => {
    const store = new InMemoryReportScheduleStore();
    store.create('BIL', dailyInput('s1', false), 'alice', NOW);
    const stats = buildScheduleCadenceStats(store, 'BIL', NOW);
    const daily = stats.cadences.find((c) => c.cadence === 'daily')!;
    expect(daily.total_count).toBe(1);
    expect(daily.enabled_count).toBe(0);
    expect(daily.disabled_count).toBe(1);
    expect(daily.next_run_within_24h_count).toBe(0);
    expect(daily.next_run_within_7d_count).toBe(0);
    expect(daily.earliest_next_run_at).toBeNull();
  });
});

describe('M12.9 — next_run windows', () => {
  test('daily enabled schedule → next_run_within_24h_count=1 + 7d_count=1', () => {
    const store = new InMemoryReportScheduleStore();
    store.create('BIL', dailyInput('s1', true), 'alice', NOW);
    const stats = buildScheduleCadenceStats(store, 'BIL', NOW);
    const daily = stats.cadences.find((c) => c.cadence === 'daily')!;
    expect(daily.next_run_within_24h_count).toBe(1);
    expect(daily.next_run_within_7d_count).toBe(1);
  });

  test('weekly enabled schedule → within_7d_count=1 (next firing within a week)', () => {
    const store = new InMemoryReportScheduleStore();
    store.create('BIL', weeklyInput('w1', true), 'alice', NOW);
    const stats = buildScheduleCadenceStats(store, 'BIL', NOW);
    const weekly = stats.cadences.find((c) => c.cadence === 'weekly')!;
    expect(weekly.next_run_within_7d_count).toBe(1);
  });

  test('monthly enabled schedule with next_run > 7d → within_7d_count=0', () => {
    const store = new InMemoryReportScheduleStore();
    // Monthly schedule firing on day 1 at 09:00 UTC; if NOW is mid-month
    // the next firing is ~2-3 weeks out → outside 7d window.
    const mid = new Date('2026-05-10T12:00:00.000Z');
    store.create('BIL', monthlyInput('m1', true), 'alice', mid);
    const stats = buildScheduleCadenceStats(store, 'BIL', mid);
    const monthly = stats.cadences.find((c) => c.cadence === 'monthly')!;
    // next run on 2026-06-01 09:00 UTC = ~22 days later — outside 7d
    expect(monthly.next_run_within_7d_count).toBe(0);
  });
});

describe('M12.9 — multiple cadences', () => {
  test('mixed cadences tracked independently', () => {
    const store = new InMemoryReportScheduleStore();
    store.create('BIL', dailyInput('d1', true), 'alice', NOW);
    store.create('BIL', dailyInput('d2', true), 'alice', NOW);
    store.create('BIL', weeklyInput('w1', true), 'alice', NOW);
    const stats = buildScheduleCadenceStats(store, 'BIL', NOW);
    const daily = stats.cadences.find((c) => c.cadence === 'daily')!;
    const weekly = stats.cadences.find((c) => c.cadence === 'weekly')!;
    expect(daily.total_count).toBe(2);
    expect(weekly.total_count).toBe(1);
    expect(stats.total_schedules).toBe(3);
  });
});

describe('M12.9 — most_common_cadence', () => {
  test('cadence with highest total_count wins', () => {
    const store = new InMemoryReportScheduleStore();
    store.create('BIL', dailyInput('d1', true), 'alice', NOW);
    store.create('BIL', dailyInput('d2', true), 'alice', NOW);
    store.create('BIL', dailyInput('d3', false), 'alice', NOW);
    store.create('BIL', weeklyInput('w1', true), 'alice', NOW);
    const stats = buildScheduleCadenceStats(store, 'BIL', NOW);
    expect(stats.most_common_cadence).toBe('daily');
  });

  test('null when no schedules at all', () => {
    const store = new InMemoryReportScheduleStore();
    const stats = buildScheduleCadenceStats(store, 'BIL', NOW);
    expect(stats.most_common_cadence).toBeNull();
  });

  test('tie-break by VALID_CADENCES declared order (daily wins over weekly at same count)', () => {
    const store = new InMemoryReportScheduleStore();
    store.create('BIL', dailyInput('d1', true), 'alice', NOW);
    store.create('BIL', weeklyInput('w1', true), 'alice', NOW);
    const stats = buildScheduleCadenceStats(store, 'BIL', NOW);
    // VALID_CADENCES is [daily, weekly, monthly, quarterly, last_day_of_month]
    // so daily wins the tie.
    expect(stats.most_common_cadence).toBe('daily');
  });
});

describe('M12.9 — unused_cadences', () => {
  test('captures cadences with zero schedules in canonical order', () => {
    const store = new InMemoryReportScheduleStore();
    store.create('BIL', dailyInput('d1', true), 'alice', NOW);
    const stats = buildScheduleCadenceStats(store, 'BIL', NOW);
    expect(stats.unused_cadences).not.toContain('daily');
    expect(stats.unused_cadences).toContain('weekly');
    expect(stats.unused_cadences).toContain('monthly');
    // Should be in VALID_CADENCES order
    const cadenceOrder = (c: string) => VALID_CADENCES.indexOf(c as never);
    for (let i = 1; i < stats.unused_cadences.length; i++) {
      expect(cadenceOrder(stats.unused_cadences[i - 1]!)).toBeLessThan(cadenceOrder(stats.unused_cadences[i]!));
    }
  });
});

describe('M12.9 — aggregate totals', () => {
  test('total_schedules + total_enabled + total_disabled consistency', () => {
    const store = new InMemoryReportScheduleStore();
    store.create('BIL', dailyInput('d1', true), 'alice', NOW);
    store.create('BIL', dailyInput('d2', false), 'alice', NOW);
    store.create('BIL', weeklyInput('w1', true), 'alice', NOW);
    const stats = buildScheduleCadenceStats(store, 'BIL', NOW);
    expect(stats.total_schedules).toBe(3);
    expect(stats.total_enabled).toBe(2);
    expect(stats.total_disabled).toBe(1);
    expect(stats.total_enabled + stats.total_disabled).toBe(stats.total_schedules);
    // Per-cadence sums also align
    const sumCount = stats.cadences.reduce((acc, c) => acc + c.total_count, 0);
    expect(sumCount).toBe(stats.total_schedules);
  });
});

describe('M12.9 — cross-tenant isolation', () => {
  test('BIL schedules invisible to BANK_DEMO', () => {
    const store = new InMemoryReportScheduleStore();
    store.create('BIL', dailyInput('d1', true), 'alice', NOW);
    const bank = buildScheduleCadenceStats(store, 'BANK_DEMO', NOW);
    expect(bank.total_schedules).toBe(0);
    expect(bank.most_common_cadence).toBeNull();
  });
});

// ─── GET /v1/reports/schedules/cadence-stats ─────────────────────────

function makeStatsApp(role = 'admin') {
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

describe('M12.9 — GET /v1/reports/schedules/cadence-stats', () => {
  test('admin → 200 with empty stats for fresh tenant', async () => {
    const { app } = makeStatsApp('admin');
    const r = await request(app).get('/v1/reports/schedules/cadence-stats').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_schedules).toBe(0);
    expect(r.body.body.cadences.length).toBe(VALID_CADENCES.length);
  });

  test('populated stats reflect schedule', async () => {
    const { app, reportScheduleStore } = makeStatsApp('admin');
    reportScheduleStore.create('BIL', dailyInput('d1', true), 'alice', NOW);
    const r = await request(app).get('/v1/reports/schedules/cadence-stats').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_schedules).toBe(1);
    expect(r.body.body.most_common_cadence).toBe('daily');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeStatsApp('case_owner');
    const r = await request(app).get('/v1/reports/schedules/cadence-stats').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL schedules invisible to BANK_DEMO', async () => {
    const { app, reportScheduleStore } = makeStatsApp('admin');
    reportScheduleStore.create('BIL', dailyInput('d1', true), 'alice', NOW);
    const bank = await request(app)
      .get('/v1/reports/schedules/cadence-stats')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_schedules).toBe(0);
  });

  test('M12.7 /v1/reports/schedules/upcoming still works (sibling route)', async () => {
    const { app } = makeStatsApp('admin');
    const r = await request(app).get('/v1/reports/schedules/upcoming').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
