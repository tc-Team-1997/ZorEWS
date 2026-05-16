// services/bff/__tests__/audit_daily_volume.test.ts
//
// T6 M15.11 — Audit log daily volume timeline.

import request from 'supertest';
import {
  summarizeAuditDailyVolume,
  AuditDailyVolumeError,
  DEFAULT_DAILY_WINDOW,
  MAX_DAILY_WINDOW,
} from '../src/audit_daily_volume';
import {
  InMemoryAuditTrailStore,
  type AuditEvent,
  type AuditEventInput,
} from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

// Fixed "now" at midnight UTC so window boundaries are predictable.
const NOW = new Date('2026-05-16T00:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function daysBackAt(daysBack: number, hour = 12): Date {
  return new Date(
    Date.UTC(2026, 4, 16, hour, 0, 0) - daysBack * 24 * 60 * 60 * 1000,
  );
}

function record(
  store: InMemoryAuditTrailStore,
  tenant: string,
  input: AuditEventInput,
  at: Date,
): AuditEvent {
  return store.record(tenant, input, at);
}

function listAll(store: InMemoryAuditTrailStore, tenant: string): AuditEvent[] {
  return store.list(tenant, { page_size: 1000 }).items;
}

const baseInput = (overrides: Partial<AuditEventInput> = {}): AuditEventInput => ({
  actor_username: 'alice',
  actor_role: 'admin',
  action: 'config.update',
  resource_type: 'config',
  resource_id: 'k1',
  outcome: 'success',
  ...overrides,
});

function makeDvApp(role = 'admin') {
  const auditTrailStore = new InMemoryAuditTrailStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    auditTrailStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, auditTrailStore };
}

// ─── summarizeAuditDailyVolume — pure ────────────────────────────────

describe('M15.11 — empty input', () => {
  test('zero events → every day in window emitted at 0', () => {
    const s = summarizeAuditDailyVolume('BIL', [], 7, NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.days).toBe(7);
    expect(s.by_day.length).toBe(7);
    expect(s.total_events_in_window).toBe(0);
    expect(s.total_events_observed).toBe(0);
    expect(s.peak_day).toBeNull();
    expect(s.peak_count).toBe(0);
    expect(s.mean_per_day).toBe(0);
    expect(s.growth_rate).toBeNull();
    expect(s.busiest_severity).toBeNull();
    for (const b of s.by_day) {
      expect(b.total).toBe(0);
      expect(b.by_severity.critical).toBe(0);
      expect(b.by_severity.warning).toBe(0);
      expect(b.by_severity.info).toBe(0);
      expect(b.by_outcome.success).toBe(0);
    }
  });
});

describe('M15.11 — window boundaries', () => {
  test('window_start = now - (days-1) days; window_end = now', () => {
    const s = summarizeAuditDailyVolume('BIL', [], 7, NOW);
    expect(s.window_end).toBe('2026-05-16');
    expect(s.window_start).toBe('2026-05-10');
    expect(s.by_day[0]!.date).toBe('2026-05-10');
    expect(s.by_day[6]!.date).toBe('2026-05-16');
  });

  test('days=1 → only today in window', () => {
    const s = summarizeAuditDailyVolume('BIL', [], 1, NOW);
    expect(s.by_day.length).toBe(1);
    expect(s.window_start).toBe('2026-05-16');
    expect(s.window_end).toBe('2026-05-16');
  });

  test('by_day is oldest-first', () => {
    const s = summarizeAuditDailyVolume('BIL', [], 5, NOW);
    const dates = s.by_day.map((b) => b.date);
    expect(dates).toEqual(['2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15', '2026-05-16']);
  });
});

describe('M15.11 — single event placement', () => {
  test('event lands in correct UTC day bucket', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput(), daysBackAt(2, 18));
    const s = summarizeAuditDailyVolume('BIL', listAll(store, 'BIL'), 7, NOW);
    const target = s.by_day.find((b) => b.date === '2026-05-14')!;
    expect(target.total).toBe(1);
    expect(s.total_events_in_window).toBe(1);
  });
});

describe('M15.11 — events outside window excluded', () => {
  test('old event ignored, but counted in total_events_observed', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput(), daysBackAt(2, 12));
    record(store, 'BIL', baseInput(), daysBackAt(60, 12)); // outside 7-day window
    const events = listAll(store, 'BIL');
    expect(events.length).toBe(2);
    const s = summarizeAuditDailyVolume('BIL', events, 7, NOW);
    expect(s.total_events_observed).toBe(2);
    expect(s.total_events_in_window).toBe(1);
  });
});

describe('M15.11 — by_severity / by_outcome partition per day', () => {
  test('Σ by_severity per day = total; Σ by_outcome per day = total', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ severity: 'critical', outcome: 'failure' }), daysBackAt(1, 10));
    record(store, 'BIL', baseInput({ severity: 'warning', outcome: 'success' }), daysBackAt(1, 11));
    record(store, 'BIL', baseInput({ severity: 'info', outcome: 'denied' }), daysBackAt(1, 12));
    const s = summarizeAuditDailyVolume('BIL', listAll(store, 'BIL'), 7, NOW);
    const target = s.by_day.find((b) => b.date === '2026-05-15')!;
    expect(target.total).toBe(3);
    const sevSum = Object.values(target.by_severity).reduce((a, b) => a + b, 0);
    const outSum = Object.values(target.by_outcome).reduce((a, b) => a + b, 0);
    expect(sevSum).toBe(target.total);
    expect(outSum).toBe(target.total);
  });
});

describe('M15.11 — peak_day formula', () => {
  test('points at highest-count day', () => {
    const store = new InMemoryAuditTrailStore();
    // Day -1: 1 event. Day -2: 3 events. Day -3: 1 event.
    record(store, 'BIL', baseInput(), daysBackAt(1, 12));
    record(store, 'BIL', baseInput(), daysBackAt(2, 10));
    record(store, 'BIL', baseInput(), daysBackAt(2, 11));
    record(store, 'BIL', baseInput(), daysBackAt(2, 12));
    record(store, 'BIL', baseInput(), daysBackAt(3, 12));
    const s = summarizeAuditDailyVolume('BIL', listAll(store, 'BIL'), 7, NOW);
    expect(s.peak_day).toBe('2026-05-14'); // 2 days back
    expect(s.peak_count).toBe(3);
  });

  test('earliest-day-wins tie-break', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput(), daysBackAt(1, 12));
    record(store, 'BIL', baseInput(), daysBackAt(5, 12));
    const s = summarizeAuditDailyVolume('BIL', listAll(store, 'BIL'), 7, NOW);
    expect(s.peak_day).toBe('2026-05-11'); // 5 days back (earlier)
  });

  test('null when no events in window', () => {
    const s = summarizeAuditDailyVolume('BIL', [], 7, NOW);
    expect(s.peak_day).toBeNull();
  });
});

describe('M15.11 — mean_per_day', () => {
  test('= round(total / days)', () => {
    const store = new InMemoryAuditTrailStore();
    // 14 events across the 7-day window → mean = 2.
    for (let d = 0; d < 7; d++) {
      record(store, 'BIL', baseInput(), daysBackAt(d, 10));
      record(store, 'BIL', baseInput(), daysBackAt(d, 11));
    }
    const s = summarizeAuditDailyVolume('BIL', listAll(store, 'BIL'), 7, NOW);
    expect(s.mean_per_day).toBe(2);
  });

  test('rounds down below 0.5', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput(), daysBackAt(3, 12));
    const s = summarizeAuditDailyVolume('BIL', listAll(store, 'BIL'), 7, NOW);
    expect(s.mean_per_day).toBe(0); // 1/7 ≈ 0.14 → 0
  });
});

describe('M15.11 — growth_rate', () => {
  test('positive when second half outweighs first half', () => {
    const store = new InMemoryAuditTrailStore();
    // 10-day window. First half (days back 9..5): 1 event total.
    // Second half (days back 4..0): 5 events total.
    record(store, 'BIL', baseInput(), daysBackAt(9, 12));
    for (let d = 0; d < 5; d++) record(store, 'BIL', baseInput(), daysBackAt(d, 12));
    const s = summarizeAuditDailyVolume('BIL', listAll(store, 'BIL'), 10, NOW);
    // first_half_mean = 1/5 = 0.2; second_half_mean = 5/5 = 1.0
    // growth_rate = (1.0 - 0.2) / 0.2 = 4
    expect(s.growth_rate).toBeCloseTo(4);
  });

  test('negative when first half outweighs second half', () => {
    const store = new InMemoryAuditTrailStore();
    // First half (days back 9..5): 5 events. Second half (4..0): 1 event.
    for (let d = 5; d < 10; d++) record(store, 'BIL', baseInput(), daysBackAt(d, 12));
    record(store, 'BIL', baseInput(), daysBackAt(0, 12));
    const s = summarizeAuditDailyVolume('BIL', listAll(store, 'BIL'), 10, NOW);
    expect(s.growth_rate).toBeLessThan(0);
  });

  test('null when first-half mean is 0', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput(), daysBackAt(0, 12));
    const s = summarizeAuditDailyVolume('BIL', listAll(store, 'BIL'), 10, NOW);
    expect(s.growth_rate).toBeNull();
  });

  test('null when days < 2', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput(), daysBackAt(0, 12));
    const s = summarizeAuditDailyVolume('BIL', listAll(store, 'BIL'), 1, NOW);
    expect(s.growth_rate).toBeNull();
  });
});

describe('M15.11 — busiest_severity', () => {
  test('points at the severity with highest total across window', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ severity: 'critical' }), daysBackAt(1, 12));
    record(store, 'BIL', baseInput({ severity: 'info' }), daysBackAt(1, 13));
    record(store, 'BIL', baseInput({ severity: 'info' }), daysBackAt(2, 12));
    record(store, 'BIL', baseInput({ severity: 'info' }), daysBackAt(2, 13));
    const s = summarizeAuditDailyVolume('BIL', listAll(store, 'BIL'), 7, NOW);
    expect(s.busiest_severity).toBe('info');
  });

  test('canonical tie-break: critical > warning at same count', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ severity: 'critical' }), daysBackAt(1, 12));
    record(store, 'BIL', baseInput({ severity: 'warning' }), daysBackAt(2, 12));
    const s = summarizeAuditDailyVolume('BIL', listAll(store, 'BIL'), 7, NOW);
    expect(s.busiest_severity).toBe('critical');
  });

  test('null when no events', () => {
    const s = summarizeAuditDailyVolume('BIL', [], 7, NOW);
    expect(s.busiest_severity).toBeNull();
  });
});

describe('M15.11 — days validation', () => {
  test('throws AuditDailyVolumeError on days=0', () => {
    expect(() => summarizeAuditDailyVolume('BIL', [], 0, NOW)).toThrow(AuditDailyVolumeError);
  });

  test('throws on days > MAX_DAILY_WINDOW', () => {
    expect(() => summarizeAuditDailyVolume('BIL', [], MAX_DAILY_WINDOW + 1, NOW)).toThrow();
  });

  test('throws on non-integer days', () => {
    expect(() => summarizeAuditDailyVolume('BIL', [], 1.5, NOW)).toThrow();
  });

  test('accepts days = MAX_DAILY_WINDOW', () => {
    const s = summarizeAuditDailyVolume('BIL', [], MAX_DAILY_WINDOW, NOW);
    expect(s.days).toBe(MAX_DAILY_WINDOW);
    expect(s.by_day.length).toBe(MAX_DAILY_WINDOW);
  });
});

// ─── GET /v1/audit/daily-volume ──────────────────────────────────────

describe('M15.11 — GET /v1/audit/daily-volume', () => {
  test('admin → 200 with default window=30 on fresh tenant', async () => {
    const { app } = makeDvApp('admin');
    const r = await request(app).get('/v1/audit/daily-volume').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(DEFAULT_DAILY_WINDOW);
    expect(r.body.body.by_day.length).toBe(DEFAULT_DAILY_WINDOW);
    expect(r.body.body.total_events_in_window).toBe(0);
  });

  test('populated rollup reflects recorded events', async () => {
    const { app, auditTrailStore } = makeDvApp('admin');
    record(auditTrailStore, 'BIL', baseInput(), daysBackAt(0, 12));
    record(auditTrailStore, 'BIL', baseInput(), daysBackAt(2, 12));
    const r = await request(app).get('/v1/audit/daily-volume?days=7').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(7);
    expect(r.body.body.total_events_in_window).toBe(2);
  });

  test('?days=invalid → 400 EWS_400_invalid_input', async () => {
    const { app } = makeDvApp('admin');
    const r = await request(app).get('/v1/audit/daily-volume?days=0').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?days too large → 400', async () => {
    const { app } = makeDvApp('admin');
    const r = await request(app).get(`/v1/audit/daily-volume?days=${MAX_DAILY_WINDOW + 1}`).set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeDvApp('case_owner');
    const r = await request(app).get('/v1/audit/daily-volume').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL events invisible to BANK_DEMO', async () => {
    const { app, auditTrailStore } = makeDvApp('admin');
    record(auditTrailStore, 'BIL', baseInput(), daysBackAt(1, 12));
    const bank = await request(app)
      .get('/v1/audit/daily-volume?days=7')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_events_in_window).toBe(0);
  });

  test('M15.10 /v1/audit/correlations still works (sibling regression)', async () => {
    const { app } = makeDvApp('admin');
    const r = await request(app).get('/v1/audit/correlations').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
