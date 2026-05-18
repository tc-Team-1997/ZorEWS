// services/bff/__tests__/alert_routing_daily_volume.test.ts
//
// T6 M8.15 — Alert routing daily volume timeline.

import request from 'supertest';
import {
  summarizeAlertRoutingDailyVolume,
  AlertRoutingDailyVolumeError,
  DEFAULT_ALERT_DAILY_WINDOW,
  MAX_ALERT_DAILY_WINDOW,
} from '../src/alert_routing_daily_volume';
import {
  InMemoryRoutingLedger,
  type RoutedAlertRecord,
  type RoutingLedger,
} from '../src/alert_routing_analytics';
import type { BilAlertClass } from '../src/bil_alert_classification';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeRdvApp(role: string = 'admin', routingLedger?: RoutingLedger) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    routingLedger: routingLedger ?? new InMemoryRoutingLedger(),
  });
}

function rec(overrides: Partial<RoutedAlertRecord> = {}): RoutedAlertRecord {
  return {
    alert_id: 'a-' + Math.random(),
    tenant_id: 'BIL',
    created_at: NOW.toISOString(),
    severity_in: 'CRITICAL',
    class: 'red',
    channels: ['email'],
    sla_hours: 4,
    escalate_after_hours: 1,
    monitor_only: false,
    acked_at: null,
    ...overrides,
  };
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M8.15 — empty input', () => {
  test('zero records → 30 zero buckets, leaderboards null', () => {
    const s = summarizeAlertRoutingDailyVolume('BIL', [], 30, NOW);
    expect(s.total_records_in_window).toBe(0);
    expect(s.total_records_observed).toBe(0);
    expect(s.by_day.length).toBe(30);
    for (const b of s.by_day) {
      expect(b.total).toBe(0);
      expect(b.by_class.red).toBe(0);
      expect(b.acked_count).toBe(0);
    }
    expect(s.peak_day).toBeNull();
    expect(s.peak_count).toBe(0);
    expect(s.mean_per_day).toBe(0);
    expect(s.growth_rate).toBeNull();
    expect(s.busiest_class).toBeNull();
  });
});

describe('M8.15 — window mechanics', () => {
  test('default 30-day window starts Apr 18 ends May 17', () => {
    const s = summarizeAlertRoutingDailyVolume('BIL', [], 30, NOW);
    expect(s.days).toBe(30);
    expect(s.window_start).toBe('2026-04-18');
    expect(s.window_end).toBe('2026-05-17');
    expect(s.by_day[0].date).toBe('2026-04-18');
    expect(s.by_day[29].date).toBe('2026-05-17');
  });

  test('days=1 → 1 bucket on NOW UTC date', () => {
    const s = summarizeAlertRoutingDailyVolume('BIL', [], 1, NOW);
    expect(s.by_day.length).toBe(1);
    expect(s.by_day[0].date).toBe('2026-05-17');
  });

  test('days=7 → 7 buckets oldest first', () => {
    const s = summarizeAlertRoutingDailyVolume('BIL', [], 7, NOW);
    expect(s.by_day.length).toBe(7);
    expect(s.by_day[0].date).toBe('2026-05-11');
    expect(s.by_day[6].date).toBe('2026-05-17');
  });
});

describe('M8.15 — single record placement', () => {
  test('1 record at NOW → today\'s bucket count=1', () => {
    const s = summarizeAlertRoutingDailyVolume('BIL', [rec()], 30, NOW);
    expect(s.total_records_in_window).toBe(1);
    const today = s.by_day.find((b) => b.date === '2026-05-17')!;
    expect(today.total).toBe(1);
    expect(today.by_class.red).toBe(1);
    expect(today.open_count).toBe(1);
  });
});

describe('M8.15 — by_class accumulation', () => {
  test('records of different classes contribute to correct rows', () => {
    const records: RoutedAlertRecord[] = [
      rec({ class: 'red' }),
      rec({ class: 'orange' }),
      rec({ class: 'orange' }),
      rec({ class: 'yellow' }),
      rec({ class: 'green', monitor_only: true }),
    ];
    const s = summarizeAlertRoutingDailyVolume('BIL', records, 30, NOW);
    const today = s.by_day.find((b) => b.date === '2026-05-17')!;
    expect(today.by_class.red).toBe(1);
    expect(today.by_class.orange).toBe(2);
    expect(today.by_class.yellow).toBe(1);
    expect(today.by_class.green).toBe(1);
  });
});

describe('M8.15 — acked/open/monitor partition per day', () => {
  test('per-day acked + open + monitor_only = total', () => {
    const records: RoutedAlertRecord[] = [
      rec({ acked_at: NOW.toISOString() }), // acked
      rec({ acked_at: null }), // open
      rec({ class: 'green', monitor_only: true }), // monitor
    ];
    const s = summarizeAlertRoutingDailyVolume('BIL', records, 30, NOW);
    const today = s.by_day.find((b) => b.date === '2026-05-17')!;
    expect(today.total).toBe(3);
    expect(today.acked_count).toBe(1);
    expect(today.open_count).toBe(1);
    expect(today.monitor_only_count).toBe(1);
    expect(today.acked_count + today.open_count + today.monitor_only_count).toBe(today.total);
  });
});

describe('M8.15 — records outside window excluded from in_window but counted in observed', () => {
  test('record 100 days ago → not in any bucket but counted in observed', () => {
    const oldDate = new Date(NOW.getTime() - 100 * 24 * 60 * 60 * 1000);
    const records: RoutedAlertRecord[] = [
      rec({ created_at: oldDate.toISOString() }),
      rec(),
    ];
    const s = summarizeAlertRoutingDailyVolume('BIL', records, 30, NOW);
    expect(s.total_records_in_window).toBe(1);
    expect(s.total_records_observed).toBe(2);
  });
});

describe('M8.15 — peak_day formula', () => {
  test('highest-count day wins; earliest-day-wins tie-break', () => {
    const dayA = new Date('2026-05-10T12:00:00.000Z');
    const dayB = new Date('2026-05-15T12:00:00.000Z');
    const records: RoutedAlertRecord[] = [
      rec({ created_at: dayA.toISOString() }),
      rec({ created_at: dayB.toISOString() }),
      rec({ created_at: dayB.toISOString() }),
    ];
    const s = summarizeAlertRoutingDailyVolume('BIL', records, 30, NOW);
    expect(s.peak_day).toBe('2026-05-15');
    expect(s.peak_count).toBe(2);
  });

  test('earliest-day-wins on tied counts', () => {
    const dayA = new Date('2026-05-10T12:00:00.000Z');
    const dayB = new Date('2026-05-15T12:00:00.000Z');
    const records: RoutedAlertRecord[] = [
      rec({ created_at: dayA.toISOString() }),
      rec({ created_at: dayB.toISOString() }),
    ];
    const s = summarizeAlertRoutingDailyVolume('BIL', records, 30, NOW);
    expect(s.peak_day).toBe('2026-05-10');
  });

  test('null when zero records', () => {
    const s = summarizeAlertRoutingDailyVolume('BIL', [], 30, NOW);
    expect(s.peak_day).toBeNull();
  });
});

describe('M8.15 — mean_per_day formula', () => {
  test('mean = round(total / days)', () => {
    const records: RoutedAlertRecord[] = [rec(), rec(), rec()];
    const s = summarizeAlertRoutingDailyVolume('BIL', records, 30, NOW);
    expect(s.mean_per_day).toBe(0); // round(3/30) = 0
  });

  test('mean 0 when total=0', () => {
    const s = summarizeAlertRoutingDailyVolume('BIL', [], 30, NOW);
    expect(s.mean_per_day).toBe(0);
  });
});

describe('M8.15 — growth_rate formula', () => {
  test('positive growth when second-half busier', () => {
    // 30 days; second half (last 15) busier than first half
    const firstHalf = new Date('2026-04-22T12:00:00.000Z');
    const secondHalf = new Date('2026-05-10T12:00:00.000Z');
    const records: RoutedAlertRecord[] = [
      rec({ created_at: firstHalf.toISOString() }),
      rec({ created_at: secondHalf.toISOString() }),
      rec({ created_at: secondHalf.toISOString() }),
      rec({ created_at: secondHalf.toISOString() }),
    ];
    const s = summarizeAlertRoutingDailyVolume('BIL', records, 30, NOW);
    expect(s.growth_rate).not.toBeNull();
    expect(s.growth_rate! > 0).toBe(true);
  });

  test('null when first_half=0', () => {
    const recent = new Date('2026-05-10T12:00:00.000Z');
    const records: RoutedAlertRecord[] = [
      rec({ created_at: recent.toISOString() }),
    ];
    const s = summarizeAlertRoutingDailyVolume('BIL', records, 30, NOW);
    expect(s.growth_rate).toBeNull();
  });

  test('null when days=1', () => {
    const s = summarizeAlertRoutingDailyVolume('BIL', [rec()], 1, NOW);
    expect(s.growth_rate).toBeNull();
  });
});

describe('M8.15 — busiest_class formula', () => {
  test('class with highest total across window', () => {
    const records: RoutedAlertRecord[] = [
      rec({ class: 'red' }),
      rec({ class: 'orange' }),
      rec({ class: 'orange' }),
      rec({ class: 'orange' }),
    ];
    const s = summarizeAlertRoutingDailyVolume('BIL', records, 30, NOW);
    expect(s.busiest_class).toBe('orange');
  });

  test('canonical tie-break: red wins over orange at tied 1', () => {
    const records: RoutedAlertRecord[] = [
      rec({ class: 'red' }),
      rec({ class: 'orange' }),
    ];
    const s = summarizeAlertRoutingDailyVolume('BIL', records, 30, NOW);
    expect(s.busiest_class).toBe('red');
  });

  test('null on empty', () => {
    const s = summarizeAlertRoutingDailyVolume('BIL', [], 30, NOW);
    expect(s.busiest_class).toBeNull();
  });
});

describe('M8.15 — partition invariants', () => {
  test('Σ by_day.total = total_records_in_window', () => {
    const records: RoutedAlertRecord[] = [rec(), rec(), rec()];
    const s = summarizeAlertRoutingDailyVolume('BIL', records, 30, NOW);
    const sum = s.by_day.reduce((acc, b) => acc + b.total, 0);
    expect(sum).toBe(s.total_records_in_window);
  });
});

describe('M8.15 — invalid days validation', () => {
  test('days=0 throws', () => {
    expect(() => summarizeAlertRoutingDailyVolume('BIL', [], 0, NOW))
      .toThrow(AlertRoutingDailyVolumeError);
  });

  test('days=366 throws', () => {
    expect(() => summarizeAlertRoutingDailyVolume('BIL', [], 366, NOW))
      .toThrow(AlertRoutingDailyVolumeError);
  });

  test('days=365 accepted at boundary', () => {
    const s = summarizeAlertRoutingDailyVolume('BIL', [], 365, NOW);
    expect(s.by_day.length).toBe(365);
  });

  test('non-integer throws', () => {
    expect(() => summarizeAlertRoutingDailyVolume('BIL', [], 3.5, NOW))
      .toThrow(AlertRoutingDailyVolumeError);
  });
});

describe('M8.15 — tenant_id + generated_at echo', () => {
  test('envelope echoes inputs', () => {
    const s = summarizeAlertRoutingDailyVolume('BIL', [], 30, NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

describe('M8.15 — exports + constants', () => {
  test('DEFAULT/MAX constants exposed', () => {
    expect(DEFAULT_ALERT_DAILY_WINDOW).toBe(30);
    expect(MAX_ALERT_DAILY_WINDOW).toBe(365);
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M8.15 — GET /v1/alerts/daily-volume', () => {
  test('admin → 200 with empty ledger', async () => {
    const { app } = makeRdvApp('admin');
    const r = await request(app).get('/v1/alerts/daily-volume').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_records_in_window).toBe(0);
    expect(r.body.body.by_day.length).toBe(30);
  });

  test('populated → reflects ledger records', async () => {
    const ledger = new InMemoryRoutingLedger();
    ledger.record(rec({ class: 'red' }));
    ledger.record(rec({ class: 'orange' }));
    const { app } = makeRdvApp('admin', ledger);
    const r = await request(app).get('/v1/alerts/daily-volume').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_records_in_window).toBe(2);
    expect(r.body.body.busiest_class).toBe('red');
  });

  test('?days=7 narrows window', async () => {
    const { app } = makeRdvApp('admin');
    const r = await request(app).get('/v1/alerts/daily-volume?days=7').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(7);
    expect(r.body.body.by_day.length).toBe(7);
  });

  test('?days=0 → 400 envelope', async () => {
    const { app } = makeRdvApp('admin');
    const r = await request(app).get('/v1/alerts/daily-volume?days=0').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?days=400 → 400 envelope', async () => {
    const { app } = makeRdvApp('admin');
    const r = await request(app).get('/v1/alerts/daily-volume?days=400').set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRdvApp('case_owner');
    const r = await request(app).get('/v1/alerts/daily-volume').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility (BIL ledger invisible to BANK_DEMO)', async () => {
    const ledger = new InMemoryRoutingLedger();
    ledger.record(rec({ tenant_id: 'BIL' }));
    const { app } = makeRdvApp('admin', ledger);
    const bankR = await request(app).get('/v1/alerts/daily-volume').set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.total_records_in_window).toBe(0);
    const bilR = await request(app).get('/v1/alerts/daily-volume').set(TH_BIL);
    expect(bilR.body.body.total_records_in_window).toBe(1);
  });

  test('M8.11 /v1/alerts/sla-breaches/detail sibling regression still 200', async () => {
    const { app } = makeRdvApp('admin');
    const r = await request(app)
      .get('/v1/alerts/sla-breaches/detail')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
