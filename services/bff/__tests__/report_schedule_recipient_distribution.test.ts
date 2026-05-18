// services/bff/__tests__/report_schedule_recipient_distribution.test.ts
//
// T6 M12.16 — Schedule recipient distribution.

import request from 'supertest';
import {
  summarizeScheduleRecipientDistribution,
  FLOODED_THRESHOLD,
} from '../src/report_schedule_recipient_distribution';
import {
  InMemoryReportScheduleStore,
  type ReportScheduleEntry,
  type ReportScheduleStore,
} from '../src/report_schedules';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-18T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeRdApp(role: string = 'admin', reportScheduleStore?: ReportScheduleStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    reportScheduleStore: reportScheduleStore ?? new InMemoryReportScheduleStore(),
  });
}

function sched(overrides: Partial<ReportScheduleEntry> = {}): ReportScheduleEntry {
  return {
    schedule_id: 'sch-' + Math.random(),
    tenant_id: 'BIL',
    report_id: 'rbi_quarterly_summary',
    format: 'pdf',
    name: 'Default schedule',
    cadence: 'daily',
    hour_utc: 6,
    day_of_week: null,
    day_of_month: null,
    recipients: ['compliance@bil.bt'],
    enabled: true,
    parameters: {},
    created_by: 'admin',
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    next_run_at: '2026-05-19T06:00:00.000Z',
    last_run_at: null,
    tz: 'UTC',
    ...overrides,
  };
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M12.16 — empty input', () => {
  test('zero schedules → zero rows + null/empty leaderboards', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [], NOW);
    expect(s.total_schedules).toBe(0);
    expect(s.total_recipients).toBe(0);
    expect(s.total_subscriptions).toBe(0);
    expect(s.recipients).toEqual([]);
    expect(s.most_subscribed_recipient).toBeNull();
    expect(s.flooded_recipients).toEqual([]);
  });
});

describe('M12.16 — single schedule single recipient', () => {
  test('1 schedule with 1 recipient → 1 row total_schedules=1', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [
      sched({ recipients: ['alice@bil.bt'], cadence: 'daily', format: 'pdf' }),
    ], NOW);
    expect(s.total_schedules).toBe(1);
    expect(s.total_recipients).toBe(1);
    expect(s.total_subscriptions).toBe(1);
    const alice = s.recipients[0];
    expect(alice.recipient).toBe('alice@bil.bt');
    expect(alice.total_schedules).toBe(1);
    expect(alice.enabled_schedules).toBe(1);
    expect(alice.disabled_schedules).toBe(0);
    expect(alice.by_cadence.daily).toBe(1);
    expect(alice.by_format.pdf).toBe(1);
  });
});

describe('M12.16 — multi-recipient single schedule', () => {
  test('1 schedule with 2 recipients → 2 rows, each total=1', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [
      sched({ recipients: ['alice@bil.bt', 'bob@bil.bt'] }),
    ], NOW);
    expect(s.total_schedules).toBe(1);
    expect(s.total_recipients).toBe(2);
    expect(s.total_subscriptions).toBe(2);
    for (const r of s.recipients) {
      expect(r.total_schedules).toBe(1);
    }
  });
});

describe('M12.16 — recipient on multiple schedules', () => {
  test('alice on 3 schedules → 1 row total=3', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [
      sched({ recipients: ['alice@bil.bt'], cadence: 'daily' }),
      sched({ recipients: ['alice@bil.bt'], cadence: 'weekly' }),
      sched({ recipients: ['alice@bil.bt'], cadence: 'monthly' }),
    ], NOW);
    expect(s.total_recipients).toBe(1);
    const alice = s.recipients[0];
    expect(alice.total_schedules).toBe(3);
    expect(alice.by_cadence.daily).toBe(1);
    expect(alice.by_cadence.weekly).toBe(1);
    expect(alice.by_cadence.monthly).toBe(1);
  });
});

describe('M12.16 — by_cadence + by_format every key present', () => {
  test('all 5 cadence keys + all 4 format keys present (0 when absent)', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [
      sched({ recipients: ['alice@bil.bt'], cadence: 'daily', format: 'pdf' }),
    ], NOW);
    const alice = s.recipients[0];
    expect(Object.keys(alice.by_cadence).sort()).toEqual(
      ['daily', 'last_day_of_month', 'monthly', 'quarterly', 'weekly'],
    );
    expect(Object.keys(alice.by_format).sort()).toEqual(
      ['csv', 'json', 'pdf', 'xlsx'],
    );
  });
});

describe('M12.16 — enabled/disabled partition', () => {
  test('enabled_schedules + disabled_schedules = total_schedules', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [
      sched({ recipients: ['alice@bil.bt'], enabled: true }),
      sched({ recipients: ['alice@bil.bt'], enabled: false }),
      sched({ recipients: ['alice@bil.bt'], enabled: true }),
    ], NOW);
    const alice = s.recipients[0];
    expect(alice.enabled_schedules).toBe(2);
    expect(alice.disabled_schedules).toBe(1);
    expect(alice.enabled_schedules + alice.disabled_schedules).toBe(alice.total_schedules);
  });
});

describe('M12.16 — earliest_next_run_at across enabled only', () => {
  test('earliest enabled next_run_at; null when no enabled', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [
      sched({
        recipients: ['alice@bil.bt'],
        enabled: true,
        next_run_at: '2026-05-25T06:00:00.000Z',
      }),
      sched({
        recipients: ['alice@bil.bt'],
        enabled: true,
        next_run_at: '2026-05-20T06:00:00.000Z',
      }),
      sched({
        recipients: ['alice@bil.bt'],
        enabled: false,
        next_run_at: '2026-05-15T06:00:00.000Z',
      }),
    ], NOW);
    const alice = s.recipients[0];
    expect(alice.earliest_next_run_at).toBe('2026-05-20T06:00:00.000Z');
  });

  test('null when only disabled schedules', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [
      sched({
        recipients: ['alice@bil.bt'],
        enabled: false,
        next_run_at: '2026-05-15T06:00:00.000Z',
      }),
    ], NOW);
    expect(s.recipients[0].earliest_next_run_at).toBeNull();
  });
});

describe('M12.16 — report_ids sorted asc + deduped', () => {
  test('distinct report_ids sorted', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [
      sched({ recipients: ['alice@bil.bt'], report_id: 'zebra' }),
      sched({ recipients: ['alice@bil.bt'], report_id: 'alpha' }),
      sched({ recipients: ['alice@bil.bt'], report_id: 'alpha' }), // dup
      sched({ recipients: ['alice@bil.bt'], report_id: 'middle' }),
    ], NOW);
    expect(s.recipients[0].report_ids).toEqual(['alpha', 'middle', 'zebra']);
  });
});

describe('M12.16 — multi-recipient cohort sorted desc', () => {
  test('alice 3 + bob 2 + carol 1 → sorted desc', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [
      sched({ recipients: ['alice@bil.bt', 'bob@bil.bt'] }),
      sched({ recipients: ['alice@bil.bt', 'bob@bil.bt'] }),
      sched({ recipients: ['alice@bil.bt', 'carol@bil.bt'] }),
    ], NOW);
    expect(s.recipients[0].recipient).toBe('alice@bil.bt');
    expect(s.recipients[0].total_schedules).toBe(3);
    expect(s.recipients[1].recipient).toBe('bob@bil.bt');
    expect(s.recipients[1].total_schedules).toBe(2);
    expect(s.recipients[2].recipient).toBe('carol@bil.bt');
    expect(s.recipients[2].total_schedules).toBe(1);
  });

  test('canonical email asc tie-break at tied counts', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [
      sched({ recipients: ['zoe@bil.bt'] }),
      sched({ recipients: ['alice@bil.bt'] }),
    ], NOW);
    expect(s.recipients[0].recipient).toBe('alice@bil.bt');
    expect(s.recipients[1].recipient).toBe('zoe@bil.bt');
  });
});

describe('M12.16 — most_subscribed_recipient', () => {
  test('highest total_schedules wins', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [
      sched({ recipients: ['alice@bil.bt'] }),
      sched({ recipients: ['alice@bil.bt'] }),
      sched({ recipients: ['bob@bil.bt'] }),
    ], NOW);
    expect(s.most_subscribed_recipient).toBe('alice@bil.bt');
  });

  test('null on empty', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [], NOW);
    expect(s.most_subscribed_recipient).toBeNull();
  });
});

describe('M12.16 — flooded_recipients', () => {
  test('recipients with total_schedules >= FLOODED_THRESHOLD surface', () => {
    expect(FLOODED_THRESHOLD).toBe(5);
    const schedules: ReportScheduleEntry[] = [];
    for (let i = 0; i < 5; i++) {
      schedules.push(sched({ recipients: ['flooded@bil.bt'] }));
    }
    schedules.push(sched({ recipients: ['ok@bil.bt'] }));
    const s = summarizeScheduleRecipientDistribution('BIL', schedules, NOW);
    expect(s.flooded_recipients).toEqual(['flooded@bil.bt']);
  });

  test('empty when no recipient hits threshold', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [
      sched({ recipients: ['alice@bil.bt'] }),
      sched({ recipients: ['alice@bil.bt'] }),
    ], NOW);
    expect(s.flooded_recipients).toEqual([]);
  });
});

describe('M12.16 — schedule_names cap 20 sorted asc', () => {
  test('caps at 20 + sorted', () => {
    const schedules: ReportScheduleEntry[] = [];
    for (let i = 25; i >= 1; i--) {
      schedules.push(sched({
        recipients: ['alice@bil.bt'],
        name: `Sched-${String(i).padStart(2, '0')}`,
      }));
    }
    const s = summarizeScheduleRecipientDistribution('BIL', schedules, NOW);
    const alice = s.recipients[0];
    expect(alice.schedule_names.length).toBe(20);
    // first 20 by alphabetical order
    expect(alice.schedule_names[0]).toBe('Sched-01');
  });
});

describe('M12.16 — total_subscriptions partition', () => {
  test('Σ recipients.total_schedules = envelope.total_subscriptions', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [
      sched({ recipients: ['alice@bil.bt', 'bob@bil.bt'] }),
      sched({ recipients: ['alice@bil.bt'] }),
    ], NOW);
    const sum = s.recipients.reduce((acc, r) => acc + r.total_schedules, 0);
    expect(sum).toBe(s.total_subscriptions);
    expect(s.total_subscriptions).toBe(3); // 2 + 1
  });
});

describe('M12.16 — intra-schedule duplicate recipients counted once', () => {
  test('schedule with [alice, alice] → alice total=1', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [
      sched({ recipients: ['alice@bil.bt', 'alice@bil.bt'] }),
    ], NOW);
    expect(s.recipients[0].total_schedules).toBe(1);
  });
});

describe('M12.16 — tenant_id + generated_at echo', () => {
  test('envelope echoes inputs', () => {
    const s = summarizeScheduleRecipientDistribution('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M12.16 — GET /v1/reports/schedules/recipient-distribution', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeRdApp('admin');
    const r = await request(app)
      .get('/v1/reports/schedules/recipient-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_schedules).toBe(0);
    expect(r.body.body.recipients).toEqual([]);
  });

  test('populated → reflects schedules', async () => {
    const store = new InMemoryReportScheduleStore();
    store.create('BIL', {
      report_id: 'rbi_quarterly_summary',
      format: 'pdf',
      name: 'RBI quarterly',
      cadence: 'quarterly',
      hour_utc: 6,
      day_of_month: 1,
      recipients: ['compliance@bil.bt', 'risk@bil.bt'],
      enabled: true,
    }, 'admin', NOW);
    const { app } = makeRdApp('admin', store);
    const r = await request(app)
      .get('/v1/reports/schedules/recipient-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_schedules).toBe(1);
    expect(r.body.body.total_recipients).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRdApp('case_owner');
    const r = await request(app)
      .get('/v1/reports/schedules/recipient-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryReportScheduleStore();
    store.create('BIL', {
      report_id: 'rbi_quarterly_summary',
      format: 'pdf',
      name: 'BIL',
      cadence: 'daily',
      hour_utc: 6,
      recipients: ['alice@bil.bt'],
      enabled: true,
    }, 'admin', NOW);
    const { app } = makeRdApp('admin', store);
    const bankR = await request(app)
      .get('/v1/reports/schedules/recipient-distribution')
      .set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.total_schedules).toBe(0);
    const bilR = await request(app)
      .get('/v1/reports/schedules/recipient-distribution')
      .set(TH_BIL);
    expect(bilR.body.body.total_schedules).toBe(1);
  });

  test('M12.9 /v1/reports/schedules/cadence-stats sibling regression still 200', async () => {
    const { app } = makeRdApp('admin');
    const r = await request(app)
      .get('/v1/reports/schedules/cadence-stats')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('literal `/recipient-distribution` not captured by `:schedule_id` wildcard', async () => {
    const { app } = makeRdApp('admin');
    const r = await request(app)
      .get('/v1/reports/schedules/recipient-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.recipients).toBeDefined();
  });
});
