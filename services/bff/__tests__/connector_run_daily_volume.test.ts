// services/bff/__tests__/connector_run_daily_volume.test.ts
//
// T6 M3.17 — Connector run daily volume timeline.

import request from 'supertest';
import {
  buildConnectorRunDailyVolume,
  ConnectorRunDailyVolumeError,
  DEFAULT_RUN_DAILY_WINDOW,
  MAX_RUN_DAILY_WINDOW,
} from '../src/connector_run_daily_volume';
import {
  InMemoryIngestionRegistry,
  type Connector,
  type ConnectorRun,
  type IngestionRegistry,
} from '../src/ingestion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

const MS_PER_DAY = 86_400_000;

function makeTestApp(role: string = 'admin', ingestionRegistry?: IngestionRegistry) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    ingestionRegistry,
  });
}

// Mock registry for controlled tests.
class MockIngestionRegistry implements IngestionRegistry {
  private connectorsByTenant = new Map<string, Connector[]>();
  private runsByConnector = new Map<string, ConnectorRun[]>(); // key = `${tenant}|${conn}`

  setConnectors(tenant: string, connectors: Connector[]): void {
    this.connectorsByTenant.set(tenant, connectors);
  }

  setRuns(tenant: string, connector_id: string, runs: ConnectorRun[]): void {
    this.runsByConnector.set(`${tenant}|${connector_id}`, runs);
  }

  list(tenant_id: string): Connector[] {
    return this.connectorsByTenant.get(tenant_id) ?? [];
  }

  get(_t: string, _c: string): Connector | null {
    return null;
  }

  runNow(_t: string, _c: string, _a: string, _now: Date): ConnectorRun {
    throw new Error('not implemented in mock');
  }

  listRuns(tenant_id: string, connector_id: string, _limit: number): ConnectorRun[] {
    return this.runsByConnector.get(`${tenant_id}|${connector_id}`) ?? [];
  }

  health(_t: string) {
    return {
      total_connectors: 0,
      by_status: { healthy: 0, degraded: 0, failing: 0, paused: 0 },
      attention_required: [],
      fleet_records_last_run: 0,
    };
  }

  setPaused(_t: string, _c: string, _p: boolean, _now: Date): Connector {
    throw new Error('not implemented in mock');
  }
}

function makeConnector(id: string): Connector {
  return {
    id,
    name: id,
    type: 'kafka_stream',
    source_system: 'test-system',
    schedule: 'daily',
    default_status: 'healthy',
    description: 'test connector',
    status: 'healthy',
    last_run_at: null,
    last_run_status: null,
    last_run_records: 0,
    average_lag_seconds: 0,
    paused_at: null,
  };
}

function makeRun(connector_id: string, startedAt: Date, status: ConnectorRun['status'] = 'success'): ConnectorRun {
  return {
    run_id: `run-${connector_id}-${startedAt.toISOString()}`,
    connector_id,
    started_at: startedAt.toISOString(),
    finished_at: new Date(startedAt.getTime() + 60_000).toISOString(),
    status,
    records_processed: 100,
    records_failed: 0,
    error_message: null,
    triggered_manually: false,
  };
}

// ─── Pure resolver ─────────────────────────────────────────────────────

describe('M3.17 — buildConnectorRunDailyVolume', () => {
  test('empty registry → 30 zero buckets + null leaderboards', () => {
    const reg = new MockIngestionRegistry();
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 30, NOW);
    expect(s.days).toBe(30);
    expect(s.by_day.length).toBe(30);
    for (const b of s.by_day) {
      expect(b.total).toBe(0);
      expect(b.distinct_connectors).toBe(0);
    }
    expect(s.total_runs_in_window).toBe(0);
    expect(s.total_runs_observed).toBe(0);
    expect(s.peak_day).toBeNull();
    expect(s.peak_count).toBe(0);
    expect(s.busiest_status).toBeNull();
    expect(s.growth_rate).toBeNull();
  });

  test('default 30-day window spans Apr 20 → May 19', () => {
    const reg = new MockIngestionRegistry();
    const s = buildConnectorRunDailyVolume(reg, 'BIL', DEFAULT_RUN_DAILY_WINDOW, NOW);
    expect(s.window_end).toBe('2026-05-19');
    expect(s.window_start).toBe('2026-04-20');
  });

  test('days=1 → 1 bucket today only', () => {
    const reg = new MockIngestionRegistry();
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 1, NOW);
    expect(s.by_day.length).toBe(1);
    expect(s.by_day[0].date).toBe('2026-05-19');
  });

  test('by_day oldest-first', () => {
    const reg = new MockIngestionRegistry();
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 7, NOW);
    for (let i = 1; i < s.by_day.length; i++) {
      expect(s.by_day[i].date > s.by_day[i - 1].date).toBe(true);
    }
  });

  test('single run placed in correct UTC bucket', () => {
    const reg = new MockIngestionRegistry();
    reg.setConnectors('BIL', [makeConnector('cbs')]);
    const runDate = new Date('2026-05-15T08:30:00.000Z');
    reg.setRuns('BIL', 'cbs', [makeRun('cbs', runDate)]);
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 30, NOW);
    const bucket = s.by_day.find((b) => b.date === '2026-05-15')!;
    expect(bucket.total).toBe(1);
    expect(bucket.by_status.success).toBe(1);
    expect(bucket.distinct_connectors).toBe(1);
    expect(s.total_runs_in_window).toBe(1);
    expect(s.total_runs_observed).toBe(1);
  });

  test('runs outside window dropped from in_window but counted in observed', () => {
    const reg = new MockIngestionRegistry();
    reg.setConnectors('BIL', [makeConnector('cbs')]);
    const inWindow = new Date('2026-05-10T00:00:00.000Z');
    const outOfWindow = new Date('2025-12-01T00:00:00.000Z'); // months ago
    reg.setRuns('BIL', 'cbs', [makeRun('cbs', inWindow), makeRun('cbs', outOfWindow)]);
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 30, NOW);
    expect(s.total_runs_in_window).toBe(1);
    expect(s.total_runs_observed).toBe(2);
  });

  test('by_status accumulation across statuses', () => {
    const reg = new MockIngestionRegistry();
    reg.setConnectors('BIL', [makeConnector('cbs')]);
    reg.setRuns('BIL', 'cbs', [
      makeRun('cbs', new Date('2026-05-15T08:00:00.000Z'), 'success'),
      makeRun('cbs', new Date('2026-05-15T09:00:00.000Z'), 'failure'),
      makeRun('cbs', new Date('2026-05-15T10:00:00.000Z'), 'partial'),
    ]);
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 30, NOW);
    const bucket = s.by_day.find((b) => b.date === '2026-05-15')!;
    expect(bucket.total).toBe(3);
    expect(bucket.by_status.success).toBe(1);
    expect(bucket.by_status.failure).toBe(1);
    expect(bucket.by_status.partial).toBe(1);
  });

  test('distinct_connectors counts per day', () => {
    const reg = new MockIngestionRegistry();
    reg.setConnectors('BIL', [makeConnector('cbs'), makeConnector('aml'), makeConnector('bureau')]);
    const day = new Date('2026-05-15T08:00:00.000Z');
    reg.setRuns('BIL', 'cbs', [makeRun('cbs', day)]);
    reg.setRuns('BIL', 'aml', [makeRun('aml', day)]);
    // bureau has runs on a different day
    reg.setRuns('BIL', 'bureau', [makeRun('bureau', new Date('2026-05-10T08:00:00.000Z'))]);
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 30, NOW);
    const day15 = s.by_day.find((b) => b.date === '2026-05-15')!;
    expect(day15.distinct_connectors).toBe(2);
    const day10 = s.by_day.find((b) => b.date === '2026-05-10')!;
    expect(day10.distinct_connectors).toBe(1);
  });

  test('peak_day formula + earliest-day-wins tie-break', () => {
    const reg = new MockIngestionRegistry();
    reg.setConnectors('BIL', [makeConnector('cbs')]);
    // 1 run on day 10, 1 run on day 15 — both tied at 1
    reg.setRuns('BIL', 'cbs', [
      makeRun('cbs', new Date('2026-05-15T08:00:00.000Z')),
      makeRun('cbs', new Date('2026-05-10T08:00:00.000Z')),
    ]);
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 30, NOW);
    // earlier day wins (strict `>` comparison)
    expect(s.peak_day).toBe('2026-05-10');
    expect(s.peak_count).toBe(1);
  });

  test('mean_per_day formula', () => {
    const reg = new MockIngestionRegistry();
    reg.setConnectors('BIL', [makeConnector('cbs')]);
    // 30 runs on day 1 → mean = 30/30 = 1
    reg.setRuns('BIL', 'cbs', [
      makeRun('cbs', new Date('2026-05-15T08:00:00.000Z')),
      makeRun('cbs', new Date('2026-05-15T08:01:00.000Z')),
      makeRun('cbs', new Date('2026-05-15T08:02:00.000Z')),
    ]);
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 30, NOW);
    expect(s.mean_per_day).toBe(0); // 3/30 = 0.1, rounded → 0
  });

  test('growth_rate positive when second half busier', () => {
    const reg = new MockIngestionRegistry();
    reg.setConnectors('BIL', [makeConnector('cbs')]);
    // 1 run early, 4 runs late (days 16-19)
    reg.setRuns('BIL', 'cbs', [
      makeRun('cbs', new Date('2026-05-10T08:00:00.000Z')),
      makeRun('cbs', new Date('2026-05-16T08:00:00.000Z')),
      makeRun('cbs', new Date('2026-05-17T08:00:00.000Z')),
      makeRun('cbs', new Date('2026-05-18T08:00:00.000Z')),
      makeRun('cbs', new Date('2026-05-19T08:00:00.000Z')),
    ]);
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 14, NOW);
    expect(s.growth_rate).not.toBeNull();
    expect(s.growth_rate!).toBeGreaterThan(0);
  });

  test('growth_rate null when first half=0', () => {
    const reg = new MockIngestionRegistry();
    reg.setConnectors('BIL', [makeConnector('cbs')]);
    // All runs in second half
    reg.setRuns('BIL', 'cbs', [
      makeRun('cbs', new Date('2026-05-19T08:00:00.000Z')),
    ]);
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 14, NOW);
    expect(s.growth_rate).toBeNull();
  });

  test('growth_rate null when days=1', () => {
    const reg = new MockIngestionRegistry();
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 1, NOW);
    expect(s.growth_rate).toBeNull();
  });

  test('busiest_status formula', () => {
    const reg = new MockIngestionRegistry();
    reg.setConnectors('BIL', [makeConnector('cbs')]);
    reg.setRuns('BIL', 'cbs', [
      makeRun('cbs', new Date('2026-05-15T08:00:00.000Z'), 'failure'),
      makeRun('cbs', new Date('2026-05-15T09:00:00.000Z'), 'failure'),
      makeRun('cbs', new Date('2026-05-15T10:00:00.000Z'), 'success'),
    ]);
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 30, NOW);
    expect(s.busiest_status).toBe('failure');
  });

  test('busiest_status canonical tie-break (success > failure at tied)', () => {
    const reg = new MockIngestionRegistry();
    reg.setConnectors('BIL', [makeConnector('cbs')]);
    reg.setRuns('BIL', 'cbs', [
      makeRun('cbs', new Date('2026-05-15T08:00:00.000Z'), 'success'),
      makeRun('cbs', new Date('2026-05-15T09:00:00.000Z'), 'failure'),
    ]);
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 30, NOW);
    expect(s.busiest_status).toBe('success'); // success iterates first
  });

  test('busiest_status null on empty', () => {
    const reg = new MockIngestionRegistry();
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 30, NOW);
    expect(s.busiest_status).toBeNull();
  });

  test('Σ by_day.total = total_runs_in_window partition invariant', () => {
    const reg = new MockIngestionRegistry();
    reg.setConnectors('BIL', [makeConnector('cbs')]);
    reg.setRuns('BIL', 'cbs', [
      makeRun('cbs', new Date('2026-05-15T08:00:00.000Z')),
      makeRun('cbs', new Date('2026-05-10T08:00:00.000Z')),
      makeRun('cbs', new Date('2026-05-05T08:00:00.000Z')),
    ]);
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 30, NOW);
    const sum = s.by_day.reduce((a, b) => a + b.total, 0);
    expect(sum).toBe(s.total_runs_in_window);
    expect(sum).toBe(3);
  });

  test('Σ by_status per bucket = bucket.total partition', () => {
    const reg = new MockIngestionRegistry();
    reg.setConnectors('BIL', [makeConnector('cbs')]);
    reg.setRuns('BIL', 'cbs', [
      makeRun('cbs', new Date('2026-05-15T08:00:00.000Z'), 'success'),
      makeRun('cbs', new Date('2026-05-15T09:00:00.000Z'), 'failure'),
    ]);
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 30, NOW);
    const bucket = s.by_day.find((b) => b.date === '2026-05-15')!;
    const sum = Object.values(bucket.by_status).reduce((a, n) => a + n, 0);
    expect(sum).toBe(bucket.total);
  });

  test('invalid days=0 throws invalid_input', () => {
    const reg = new MockIngestionRegistry();
    expect(() => buildConnectorRunDailyVolume(reg, 'BIL', 0, NOW)).toThrow(
      ConnectorRunDailyVolumeError,
    );
  });

  test('invalid days=MAX+1 throws invalid_input', () => {
    const reg = new MockIngestionRegistry();
    expect(() =>
      buildConnectorRunDailyVolume(reg, 'BIL', MAX_RUN_DAILY_WINDOW + 1, NOW),
    ).toThrow(ConnectorRunDailyVolumeError);
  });

  test('invalid days=non-integer throws', () => {
    const reg = new MockIngestionRegistry();
    expect(() => buildConnectorRunDailyVolume(reg, 'BIL', 7.5, NOW)).toThrow(
      ConnectorRunDailyVolumeError,
    );
  });

  test('days=MAX boundary accepted', () => {
    const reg = new MockIngestionRegistry();
    const s = buildConnectorRunDailyVolume(reg, 'BIL', MAX_RUN_DAILY_WINDOW, NOW);
    expect(s.days).toBe(MAX_RUN_DAILY_WINDOW);
    expect(s.by_day.length).toBe(MAX_RUN_DAILY_WINDOW);
  });

  test('per_connector_limit echoed', () => {
    const reg = new MockIngestionRegistry();
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 30, NOW);
    expect(s.per_connector_limit).toBe(200);
  });

  test('tenant_id + generated_at echo', () => {
    const reg = new MockIngestionRegistry();
    const s = buildConnectorRunDailyVolume(reg, 'BIL', 30, NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M3.17 — GET /v1/ingestion/run-volume/daily', () => {
  test('admin → 200 with default 30-day window', async () => {
    const { app } = makeTestApp('admin', new InMemoryIngestionRegistry());
    const r = await request(app)
      .get('/v1/ingestion/run-volume/daily')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(30);
    expect(r.body.body.by_day.length).toBe(30);
  });

  test('?days=7 narrows window', async () => {
    const { app } = makeTestApp('admin', new InMemoryIngestionRegistry());
    const r = await request(app)
      .get('/v1/ingestion/run-volume/daily?days=7')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(7);
    expect(r.body.body.by_day.length).toBe(7);
  });

  test('populated via runNow reflects activity', async () => {
    const reg = new InMemoryIngestionRegistry();
    reg.runNow('BIL', 'cbs_loan_book', 'alice', NOW);
    const { app } = makeTestApp('admin', reg);
    const r = await request(app)
      .get('/v1/ingestion/run-volume/daily')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_runs_in_window).toBeGreaterThanOrEqual(1);
  });

  test('?days=0 → 400 EWS_400_invalid_input', async () => {
    const { app } = makeTestApp('admin', new InMemoryIngestionRegistry());
    const r = await request(app)
      .get('/v1/ingestion/run-volume/daily?days=0')
      .set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?days=400 → 400', async () => {
    const { app } = makeTestApp('admin', new InMemoryIngestionRegistry());
    const r = await request(app)
      .get('/v1/ingestion/run-volume/daily?days=400')
      .set(TH);
    expect(r.status).toBe(400);
  });

  test('?days=abc → 400', async () => {
    const { app } = makeTestApp('admin', new InMemoryIngestionRegistry());
    const r = await request(app)
      .get('/v1/ingestion/run-volume/daily?days=abc')
      .set(TH);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTestApp('case_owner', new InMemoryIngestionRegistry());
    const r = await request(app)
      .get('/v1/ingestion/run-volume/daily')
      .set(TH);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const reg = new InMemoryIngestionRegistry();
    reg.runNow('BIL', 'cbs_loan_book', 'alice', NOW);
    const { app } = makeTestApp('admin', reg);
    const r = await request(app)
      .get('/v1/ingestion/run-volume/daily')
      .set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total_runs_in_window).toBe(0);
  });

  test('M3.12 /run-volume/hourly sibling regression still 200', async () => {
    const { app } = makeTestApp('admin', new InMemoryIngestionRegistry());
    const r = await request(app)
      .get('/v1/ingestion/run-volume/hourly')
      .set(TH);
    expect(r.status).toBe(200);
  });
});
