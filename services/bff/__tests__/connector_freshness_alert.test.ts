// services/bff/__tests__/connector_freshness_alert.test.ts
//
// T6 M3.19 — pure resolver + HTTP route tests for the connector
// data-freshness alert detector.

import {
  buildConnectorFreshnessReport,
  parseScheduleMinutes,
  ALL_FRESHNESS_STATUSES,
} from '../src/connector_freshness_alert';
import type {
  Connector,
  IngestionHealth,
  IngestionRegistry,
} from '../src/ingestion';

const NOW = new Date('2026-05-22T12:00:00.000Z');

// Mock registry — gives us full control over connector state for
// freshness testing (real registry's last_run_at is bound to the
// synthesised stub clock + runNow which is too noisy for these tests).
class MockRegistry implements IngestionRegistry {
  constructor(private readonly connectors: Connector[]) {}
  list(): Connector[] {
    return [...this.connectors];
  }
  get(_t: string, id: string): Connector | null {
    return this.connectors.find((c) => c.id === id) ?? null;
  }
  runNow(): never {
    throw new Error('not implemented for freshness tests');
  }
  listRuns(): never[] {
    return [];
  }
  health(): IngestionHealth {
    return {
      total_connectors: this.connectors.length,
      by_status: { healthy: 0, degraded: 0, failing: 0, paused: 0 },
      attention_required: [],
      fleet_records_last_run: 0,
    };
  }
  setPaused(): never {
    throw new Error('not implemented');
  }
}

function mkConnector(opts: Partial<Connector> & { id: string }): Connector {
  return {
    id: opts.id,
    name: opts.name ?? `Connector ${opts.id}`,
    source_system: opts.source_system ?? 'CBS',
    type: opts.type ?? 'kafka_stream',
    schedule: opts.schedule ?? 'every 5 min',
    default_status: opts.default_status ?? 'healthy',
    description: opts.description ?? 'test',
    status: opts.status ?? 'healthy',
    last_run_at: opts.last_run_at ?? null,
    last_run_status: opts.last_run_status ?? null,
    last_run_records: opts.last_run_records ?? 0,
    average_lag_seconds: opts.average_lag_seconds ?? 0,
    paused_at: opts.paused_at ?? null,
  };
}

// ---------------------------------------------------------------------
// parseScheduleMinutes pure helper
// ---------------------------------------------------------------------

describe('parseScheduleMinutes', () => {
  test("'continuous' → 1 min", () => {
    expect(parseScheduleMinutes('continuous')).toBe(1);
    expect(parseScheduleMinutes('realtime')).toBe(1);
    expect(parseScheduleMinutes('streaming')).toBe(1);
  });
  test("'every N min' variants", () => {
    expect(parseScheduleMinutes('every 5 min')).toBe(5);
    expect(parseScheduleMinutes('every 30 minutes')).toBe(30);
    expect(parseScheduleMinutes('every 1 minute')).toBe(1);
    expect(parseScheduleMinutes('every 15 mins')).toBe(15);
  });
  test("'every N hour' variants → × 60", () => {
    expect(parseScheduleMinutes('every 2 hours')).toBe(120);
    expect(parseScheduleMinutes('every 1 hour')).toBe(60);
    expect(parseScheduleMinutes('every 6 hrs')).toBe(360);
  });
  test("'hourly' → 60", () => {
    expect(parseScheduleMinutes('hourly')).toBe(60);
  });
  test("'daily' + 'daily HH:MM' → 1440", () => {
    expect(parseScheduleMinutes('daily')).toBe(1440);
    expect(parseScheduleMinutes('daily 02:00')).toBe(1440);
    expect(parseScheduleMinutes('daily 23:59')).toBe(1440);
  });
  test("'weekly' variants → 10080", () => {
    expect(parseScheduleMinutes('weekly')).toBe(10_080);
    expect(parseScheduleMinutes('weekly on monday')).toBe(10_080);
  });
  test("'monthly' → 43200", () => {
    expect(parseScheduleMinutes('monthly')).toBe(43_200);
  });
  test('case-insensitive', () => {
    expect(parseScheduleMinutes('DAILY 02:00')).toBe(1440);
    expect(parseScheduleMinutes('EVERY 5 MIN')).toBe(5);
    expect(parseScheduleMinutes('Continuous')).toBe(1);
  });
  test('whitespace trimmed', () => {
    expect(parseScheduleMinutes('  daily 02:00  ')).toBe(1440);
  });
  test('empty + unrecognised → null', () => {
    expect(parseScheduleMinutes('')).toBeNull();
    expect(parseScheduleMinutes('   ')).toBeNull();
    expect(parseScheduleMinutes('whenever')).toBeNull();
    expect(parseScheduleMinutes('cron(0 */2 * * *)')).toBeNull();
    expect(parseScheduleMinutes('on demand')).toBeNull();
  });
});

// ---------------------------------------------------------------------
// buildConnectorFreshnessReport pure resolver
// ---------------------------------------------------------------------

describe('buildConnectorFreshnessReport — pure resolver', () => {
  test('empty registry → zero report', () => {
    const r = buildConnectorFreshnessReport(new MockRegistry([]), 'BANK_DEMO', NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.generated_at).toBe('2026-05-22T12:00:00.000Z');
    expect(r.total_connectors).toBe(0);
    expect(r.connectors).toEqual([]);
    expect(r.worst_offender).toBeNull();
    expect(r.total_at_risk).toBe(0);
    expect(r.total_paused).toBe(0);
    // Every status key present at 0
    for (const s of ALL_FRESHNESS_STATUSES) {
      expect(r.by_status[s]).toBe(0);
    }
  });

  test('on_time connector (ran 2min ago, expects every 5 min)', () => {
    const lastRun = new Date(NOW.getTime() - 2 * 60_000);
    const reg = new MockRegistry([
      mkConnector({
        id: 'c-1',
        schedule: 'every 5 min',
        last_run_at: lastRun.toISOString(),
      }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    expect(r.total_connectors).toBe(1);
    expect(r.by_status.on_time).toBe(1);
    const row = r.connectors[0];
    expect(row.freshness_status).toBe('on_time');
    expect(row.overdue_minutes).toBeLessThanOrEqual(0);
    expect(row.expected_interval_minutes).toBe(5);
    expect(r.worst_offender).toBeNull();
  });

  test('overdue connector (ran 8min ago, expects every 5 min)', () => {
    const lastRun = new Date(NOW.getTime() - 8 * 60_000);
    const reg = new MockRegistry([
      mkConnector({
        id: 'c-1',
        schedule: 'every 5 min',
        last_run_at: lastRun.toISOString(),
      }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    expect(r.by_status.overdue).toBe(1);
    const row = r.connectors[0];
    expect(row.freshness_status).toBe('overdue');
    expect(row.overdue_minutes).toBe(3); // (8 - 5) min
    expect(r.total_at_risk).toBe(1);
  });

  test('critical_stale connector (overdue > 2× interval)', () => {
    // ran 30 min ago, expected every 5 min → overdue=25, > 5 → critical_stale
    const lastRun = new Date(NOW.getTime() - 30 * 60_000);
    const reg = new MockRegistry([
      mkConnector({
        id: 'c-1',
        schedule: 'every 5 min',
        last_run_at: lastRun.toISOString(),
      }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    expect(r.by_status.critical_stale).toBe(1);
    expect(r.connectors[0].freshness_status).toBe('critical_stale');
    expect(r.connectors[0].overdue_minutes).toBe(25);
    expect(r.total_at_risk).toBe(1);
  });

  test('never_run connector (parseable schedule, no last_run_at)', () => {
    const reg = new MockRegistry([
      mkConnector({
        id: 'c-1',
        schedule: 'daily 02:00',
        last_run_at: null,
      }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    expect(r.by_status.never_run).toBe(1);
    const row = r.connectors[0];
    expect(row.freshness_status).toBe('never_run');
    expect(row.expected_interval_minutes).toBe(1440);
    expect(row.overdue_minutes).toBeNull();
    expect(row.expected_next_run_at).toBeNull();
    expect(r.total_at_risk).toBe(0);
  });

  test('unparseable_schedule (free-form schedule string)', () => {
    const reg = new MockRegistry([
      mkConnector({
        id: 'c-1',
        schedule: 'cron(0 */2 * * *)',
        last_run_at: NOW.toISOString(),
      }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    expect(r.by_status.unparseable_schedule).toBe(1);
    const row = r.connectors[0];
    expect(row.freshness_status).toBe('unparseable_schedule');
    expect(row.expected_interval_minutes).toBeNull();
    expect(row.overdue_minutes).toBeNull();
    expect(r.total_at_risk).toBe(0);
  });

  test('paused connector → status=paused (excluded from at-risk)', () => {
    const reg = new MockRegistry([
      mkConnector({
        id: 'c-1',
        schedule: 'every 5 min',
        last_run_at: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
        paused_at: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
      }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    expect(r.by_status.paused).toBe(1);
    expect(r.connectors[0].freshness_status).toBe('paused');
    expect(r.total_paused).toBe(1);
    expect(r.total_at_risk).toBe(0);
    expect(r.connectors[0].expected_interval_minutes).toBeNull();
  });

  test('boundary: overdue exactly = expected_interval → still overdue (not critical_stale)', () => {
    // ran 10 min ago, expects every 5 min → overdue=5, which equals interval (5)
    // Strict > comparison: 5 > 5 is false → status='overdue', not critical_stale
    const lastRun = new Date(NOW.getTime() - 10 * 60_000);
    const reg = new MockRegistry([
      mkConnector({
        id: 'c-1',
        schedule: 'every 5 min',
        last_run_at: lastRun.toISOString(),
      }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    expect(r.connectors[0].freshness_status).toBe('overdue');
    expect(r.connectors[0].overdue_minutes).toBe(5);
  });

  test('boundary: overdue_minutes=0 exactly → on_time', () => {
    // ran 5 min ago, expects every 5 min → expected_next_run = now, overdue=0
    const lastRun = new Date(NOW.getTime() - 5 * 60_000);
    const reg = new MockRegistry([
      mkConnector({
        id: 'c-1',
        schedule: 'every 5 min',
        last_run_at: lastRun.toISOString(),
      }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    expect(r.connectors[0].freshness_status).toBe('on_time');
    expect(r.connectors[0].overdue_minutes).toBe(0);
  });

  test('multi-connector status spread', () => {
    const reg = new MockRegistry([
      mkConnector({
        id: 'c-ontime',
        schedule: 'every 5 min',
        last_run_at: new Date(NOW.getTime() - 2 * 60_000).toISOString(),
      }),
      mkConnector({
        id: 'c-overdue',
        schedule: 'every 5 min',
        last_run_at: new Date(NOW.getTime() - 8 * 60_000).toISOString(),
      }),
      mkConnector({
        id: 'c-stale',
        schedule: 'every 5 min',
        last_run_at: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
      }),
      mkConnector({ id: 'c-never', schedule: 'hourly', last_run_at: null }),
      mkConnector({
        id: 'c-bogus',
        schedule: 'cron(0 0 * * *)',
        last_run_at: NOW.toISOString(),
      }),
      mkConnector({
        id: 'c-paused',
        schedule: 'every 5 min',
        last_run_at: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
        paused_at: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
      }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    expect(r.total_connectors).toBe(6);
    expect(r.by_status.on_time).toBe(1);
    expect(r.by_status.overdue).toBe(1);
    expect(r.by_status.critical_stale).toBe(1);
    expect(r.by_status.never_run).toBe(1);
    expect(r.by_status.unparseable_schedule).toBe(1);
    expect(r.by_status.paused).toBe(1);
    expect(r.total_at_risk).toBe(2); // overdue + critical_stale
    expect(r.total_paused).toBe(1);
  });

  test('sort: critical_stale first (highest overdue first), then overdue, then never_run/unparseable/paused, then on_time', () => {
    const reg = new MockRegistry([
      mkConnector({ id: 'c-ontime', schedule: 'every 5 min', last_run_at: new Date(NOW.getTime() - 1 * 60_000).toISOString() }),
      mkConnector({ id: 'c-paused', schedule: 'every 5 min', paused_at: NOW.toISOString() }),
      mkConnector({ id: 'c-bogus', schedule: 'whenever', last_run_at: NOW.toISOString() }),
      mkConnector({ id: 'c-never', schedule: 'hourly', last_run_at: null }),
      mkConnector({ id: 'c-overdue', schedule: 'every 5 min', last_run_at: new Date(NOW.getTime() - 8 * 60_000).toISOString() }),
      mkConnector({ id: 'c-stale-1', schedule: 'every 5 min', last_run_at: new Date(NOW.getTime() - 30 * 60_000).toISOString() }),
      mkConnector({ id: 'c-stale-2', schedule: 'every 5 min', last_run_at: new Date(NOW.getTime() - 60 * 60_000).toISOString() }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    // c-stale-2 (55min overdue, critical) → c-stale-1 (25min overdue, critical) → c-overdue (3min) → never/unparseable/paused → on_time
    expect(r.connectors.map((c) => c.connector_id)).toEqual([
      'c-stale-2',
      'c-stale-1',
      'c-overdue',
      'c-never',
      'c-bogus',
      'c-paused',
      'c-ontime',
    ]);
  });

  test('worst_offender = highest overdue among overdue + critical_stale', () => {
    const reg = new MockRegistry([
      mkConnector({ id: 'c-1', schedule: 'every 5 min', last_run_at: new Date(NOW.getTime() - 8 * 60_000).toISOString() }),
      mkConnector({ id: 'c-2', schedule: 'every 5 min', last_run_at: new Date(NOW.getTime() - 60 * 60_000).toISOString() }),
      mkConnector({ id: 'c-3', schedule: 'every 5 min', last_run_at: new Date(NOW.getTime() - 2 * 60_000).toISOString() }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    expect(r.worst_offender).not.toBeNull();
    expect(r.worst_offender!.connector_id).toBe('c-2');
    expect(r.worst_offender!.overdue_minutes).toBe(55);
    expect(r.worst_offender!.freshness_status).toBe('critical_stale');
  });

  test('worst_offender null when no overdue/critical', () => {
    const reg = new MockRegistry([
      mkConnector({ id: 'c-1', schedule: 'every 5 min', last_run_at: new Date(NOW.getTime() - 1 * 60_000).toISOString() }),
      mkConnector({ id: 'c-2', schedule: 'hourly', last_run_at: null }),
      mkConnector({ id: 'c-3', schedule: 'every 5 min', paused_at: NOW.toISOString() }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    expect(r.worst_offender).toBeNull();
  });

  test('partition invariant: Σ by_status = total_connectors', () => {
    const reg = new MockRegistry([
      mkConnector({ id: 'c-1', schedule: 'every 5 min', last_run_at: new Date(NOW.getTime() - 8 * 60_000).toISOString() }),
      mkConnector({ id: 'c-2', schedule: 'hourly', last_run_at: null }),
      mkConnector({ id: 'c-3', schedule: 'whenever', last_run_at: NOW.toISOString() }),
      mkConnector({ id: 'c-4', schedule: 'every 5 min', paused_at: NOW.toISOString() }),
      mkConnector({ id: 'c-5', schedule: 'every 5 min', last_run_at: new Date(NOW.getTime() - 1 * 60_000).toISOString() }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    const sum = Object.values(r.by_status).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.total_connectors);
    expect(sum).toBe(5);
  });

  test('paused trumps unparseable_schedule (paused short-circuits)', () => {
    // Connector is paused AND has an unparseable schedule → status=paused
    const reg = new MockRegistry([
      mkConnector({
        id: 'c-1',
        schedule: 'whenever',
        paused_at: NOW.toISOString(),
      }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    expect(r.connectors[0].freshness_status).toBe('paused');
    expect(r.by_status.paused).toBe(1);
    expect(r.by_status.unparseable_schedule).toBe(0);
  });

  test('malformed last_run_at → unparseable_schedule (defensive)', () => {
    const reg = new MockRegistry([
      mkConnector({
        id: 'c-1',
        schedule: 'every 5 min',
        last_run_at: 'not-a-date',
      }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    expect(r.connectors[0].freshness_status).toBe('unparseable_schedule');
  });

  test('expected_next_run_at = last_run_at + expected_interval_minutes', () => {
    const lastRun = new Date(NOW.getTime() - 3 * 60_000);
    const reg = new MockRegistry([
      mkConnector({
        id: 'c-1',
        schedule: 'every 5 min',
        last_run_at: lastRun.toISOString(),
      }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    const row = r.connectors[0];
    const expectedNextMs = lastRun.getTime() + 5 * 60_000;
    expect(row.expected_next_run_at).toBe(new Date(expectedNextMs).toISOString());
  });

  test('overdue_minutes rounded to integer', () => {
    // 8.5 min ago, expects every 5 min → overdue = 3.5 → rounded
    const lastRun = new Date(NOW.getTime() - Math.floor(8.5 * 60_000));
    const reg = new MockRegistry([
      mkConnector({
        id: 'c-1',
        schedule: 'every 5 min',
        last_run_at: lastRun.toISOString(),
      }),
    ]);
    const r = buildConnectorFreshnessReport(reg, 'BANK_DEMO', NOW);
    expect(Number.isInteger(r.connectors[0].overdue_minutes)).toBe(true);
  });

  test('empty tenant_id rejected', () => {
    expect(() =>
      buildConnectorFreshnessReport(new MockRegistry([]), '', NOW),
    ).toThrow(/tenant_id/);
  });

  test('ALL_FRESHNESS_STATUSES canonical 6-element enum', () => {
    expect(ALL_FRESHNESS_STATUSES).toEqual([
      'on_time',
      'overdue',
      'critical_stale',
      'never_run',
      'unparseable_schedule',
      'paused',
    ]);
  });
});

// ---------------------------------------------------------------------
// HTTP route tests
// ---------------------------------------------------------------------

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('GET /v1/ingestion/freshness-alert', () => {
  test('admin happy path with default registry (BIL tenant for isolation)', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/ingestion/freshness-alert')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.total_connectors).toBeGreaterThanOrEqual(8); // SEED_CONNECTORS
    expect(Array.isArray(r.body.body.connectors)).toBe(true);
    // Every status key always present
    for (const s of ALL_FRESHNESS_STATUSES) {
      expect(typeof r.body.body.by_status[s]).toBe('number');
    }
  });

  test('403 when role lacks audit:read', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/ingestion/freshness-alert')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/ingestion/freshness-alert')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });

  test('default seed connectors → never_run for fresh tenant', async () => {
    const { app } = makeApp({});
    // BIL tenant has no run history yet → all connectors should be
    // never_run (parseable schedule) or unparseable_schedule
    const r = await request(app)
      .get('/v1/ingestion/freshness-alert')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.status).toBe(200);
    // For a fresh tenant, expect 0 overdue/critical_stale (no runs yet)
    expect(r.body.body.by_status.overdue).toBe(0);
    expect(r.body.body.by_status.critical_stale).toBe(0);
    expect(r.body.body.total_at_risk).toBe(0);
    expect(r.body.body.worst_offender).toBeNull();
  });
});
