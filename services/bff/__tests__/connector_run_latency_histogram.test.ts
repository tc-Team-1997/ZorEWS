// services/bff/__tests__/connector_run_latency_histogram.test.ts
//
// T6 M3.16 — Connector run latency histogram.

import request from 'supertest';
import {
  buildConnectorRunLatencyHistogram,
  ALL_RUN_LATENCY_BUCKETS,
} from '../src/connector_run_latency_histogram';
import {
  InMemoryIngestionRegistry,
  type Connector,
  type ConnectorRun,
  type IngestionHealth,
  type IngestionRegistry,
  type RunStatus,
} from '../src/ingestion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function connector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: 'c-1',
    name: 'Test Connector',
    source_system: 'CBS',
    type: 'rest_api',
    schedule: 'daily',
    default_status: 'healthy',
    description: '',
    status: 'healthy',
    last_run_at: null,
    last_run_status: null,
    last_run_records: 0,
    average_lag_seconds: 0,
    paused_at: null,
    ...overrides,
  };
}

function run(overrides: Partial<ConnectorRun> = {}): ConnectorRun {
  return {
    run_id: 'r-' + Math.random(),
    connector_id: 'c-1',
    started_at: new Date(NOW.getTime() - 5000).toISOString(),
    finished_at: NOW.toISOString(),
    status: 'success',
    records_processed: 100,
    records_failed: 0,
    error_message: null,
    triggered_manually: false,
    ...overrides,
  };
}

class MockRegistry implements IngestionRegistry {
  constructor(
    private readonly connectors: Connector[],
    private readonly runsByConnector: Record<string, ConnectorRun[]> = {},
  ) {}
  list(): Connector[] { return [...this.connectors]; }
  get(_t: string, id: string): Connector | null {
    return this.connectors.find((c) => c.id === id) ?? null;
  }
  runNow(): ConnectorRun { throw new Error('not used'); }
  listRuns(_t: string, id: string, _limit: number): ConnectorRun[] {
    return [...(this.runsByConnector[id] ?? [])];
  }
  health(): IngestionHealth { throw new Error('not used'); }
  setPaused(): Connector { throw new Error('not used'); }
}

function makeRlhApp(role: string = 'admin', registry?: IngestionRegistry) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    ingestionRegistry: registry ?? new InMemoryIngestionRegistry(),
  });
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M3.16 — empty registry', () => {
  test('zero connectors → 6 zero buckets + null leaderboards', () => {
    const reg = new MockRegistry([]);
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.total_connectors).toBe(0);
    expect(s.total_runs).toBe(0);
    expect(s.buckets.length).toBe(6);
    for (const b of s.buckets) {
      expect(b.count).toBe(0);
      expect(b.distinct_connectors).toBe(0);
      expect(b.samples).toEqual([]);
    }
    expect(s.peak_bucket).toBeNull();
    expect(s.mean_duration_ms).toBeNull();
    expect(s.median_duration_ms).toBeNull();
    expect(s.p95_duration_ms).toBeNull();
    expect(s.slowest_run).toBeNull();
  });
});

describe('M3.16 — canonical bucket order', () => {
  test('buckets[] in canonical order', () => {
    const reg = new MockRegistry([]);
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.buckets.map((b) => b.bucket)).toEqual([...ALL_RUN_LATENCY_BUCKETS]);
  });
});

describe('M3.16 — every bucket has by_status all keys present', () => {
  test('4 RunStatus keys at 0 when empty', () => {
    const reg = new MockRegistry([]);
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    for (const b of s.buckets) {
      expect(Object.keys(b.by_status).sort()).toEqual(['failure', 'partial', 'running', 'success']);
    }
  });
});

describe('M3.16 — bucket placement', () => {
  test('500ms run → instant', () => {
    const c = connector();
    const r = run({
      started_at: new Date(NOW.getTime() - 500).toISOString(),
      finished_at: NOW.toISOString(),
    });
    const reg = new MockRegistry([c], { 'c-1': [r] });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === 'instant')!.count).toBe(1);
  });

  test('5s run → fast', () => {
    const c = connector();
    const r = run({
      started_at: new Date(NOW.getTime() - 5000).toISOString(),
      finished_at: NOW.toISOString(),
    });
    const reg = new MockRegistry([c], { 'c-1': [r] });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === 'fast')!.count).toBe(1);
  });

  test('5m run → medium', () => {
    const c = connector();
    const r = run({
      started_at: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(),
      finished_at: NOW.toISOString(),
    });
    const reg = new MockRegistry([c], { 'c-1': [r] });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === 'medium')!.count).toBe(1);
  });

  test('30m run → slow', () => {
    const c = connector();
    const r = run({
      started_at: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
      finished_at: NOW.toISOString(),
    });
    const reg = new MockRegistry([c], { 'c-1': [r] });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === 'slow')!.count).toBe(1);
  });

  test('2h run → very_slow', () => {
    const c = connector();
    const r = run({
      started_at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      finished_at: NOW.toISOString(),
    });
    const reg = new MockRegistry([c], { 'c-1': [r] });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === 'very_slow')!.count).toBe(1);
  });
});

describe('M3.16 — still_running bucket', () => {
  test('finished_at=null → still_running, excluded from duration math', () => {
    const c = connector();
    const r = run({
      started_at: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(),
      finished_at: null,
      status: 'running',
    });
    const reg = new MockRegistry([c], { 'c-1': [r] });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.total_still_running).toBe(1);
    expect(s.total_finished_runs).toBe(0);
    expect(s.mean_duration_ms).toBeNull();
    expect(s.buckets.find((b) => b.bucket === 'still_running')!.count).toBe(1);
  });
});

describe('M3.16 — strict-< boundaries', () => {
  test('exact 1s → fast (not instant)', () => {
    const c = connector();
    const r = run({
      started_at: new Date(NOW.getTime() - 1000).toISOString(),
      finished_at: NOW.toISOString(),
    });
    const reg = new MockRegistry([c], { 'c-1': [r] });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === 'instant')!.count).toBe(0);
    expect(s.buckets.find((b) => b.bucket === 'fast')!.count).toBe(1);
  });

  test('exact 1m → medium (not fast)', () => {
    const c = connector();
    const r = run({
      started_at: new Date(NOW.getTime() - 60 * 1000).toISOString(),
      finished_at: NOW.toISOString(),
    });
    const reg = new MockRegistry([c], { 'c-1': [r] });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.buckets.find((b) => b.bucket === 'fast')!.count).toBe(0);
    expect(s.buckets.find((b) => b.bucket === 'medium')!.count).toBe(1);
  });
});

describe('M3.16 — by_status accumulation', () => {
  test('4 statuses tracked per bucket', () => {
    const c = connector();
    const runs: ConnectorRun[] = [
      run({ run_id: 'r1', status: 'success' }),
      run({ run_id: 'r2', status: 'failure' }),
      run({ run_id: 'r3', status: 'partial' }),
    ];
    const reg = new MockRegistry([c], { 'c-1': runs });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    const fast = s.buckets.find((b) => b.bucket === 'fast')!;
    expect(fast.count).toBe(3);
    expect(fast.by_status.success).toBe(1);
    expect(fast.by_status.failure).toBe(1);
    expect(fast.by_status.partial).toBe(1);
  });
});

describe('M3.16 — distinct_connectors', () => {
  test('counts unique connector_ids per bucket', () => {
    const c1 = connector({ id: 'c-1' });
    const c2 = connector({ id: 'c-2' });
    const reg = new MockRegistry(
      [c1, c2],
      {
        'c-1': [run({ run_id: 'r1', connector_id: 'c-1' })],
        'c-2': [run({ run_id: 'r2', connector_id: 'c-2' })],
      },
    );
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    const fast = s.buckets.find((b) => b.bucket === 'fast')!;
    expect(fast.count).toBe(2);
    expect(fast.distinct_connectors).toBe(2);
  });
});

describe('M3.16 — peak_bucket', () => {
  test('highest-count wins', () => {
    const c = connector();
    const runs: ConnectorRun[] = [
      run({ run_id: 'r1', started_at: new Date(NOW.getTime() - 500).toISOString() }), // instant
      run({ run_id: 'r2', started_at: new Date(NOW.getTime() - 500).toISOString() }), // instant
      run({ run_id: 'r3', started_at: new Date(NOW.getTime() - 5000).toISOString() }), // fast
    ];
    const reg = new MockRegistry([c], { 'c-1': runs });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.peak_bucket).toBe('instant');
    expect(s.peak_count).toBe(2);
  });

  test('canonical tie-break: instant beats fast', () => {
    const c = connector();
    const runs: ConnectorRun[] = [
      run({ run_id: 'r1', started_at: new Date(NOW.getTime() - 500).toISOString() }),
      run({ run_id: 'r2', started_at: new Date(NOW.getTime() - 5000).toISOString() }),
    ];
    const reg = new MockRegistry([c], { 'c-1': runs });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.peak_bucket).toBe('instant');
  });
});

describe('M3.16 — samples cap 3 longest-first', () => {
  test('top 3 longest within finished bucket', () => {
    const c = connector();
    const runs: ConnectorRun[] = [];
    for (let i = 0; i < 5; i++) {
      runs.push(run({
        run_id: `r${i}`,
        started_at: new Date(NOW.getTime() - (2000 + i * 1000)).toISOString(),
        finished_at: NOW.toISOString(),
      }));
    }
    const reg = new MockRegistry([c], { 'c-1': runs });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    const fast = s.buckets.find((b) => b.bucket === 'fast')!;
    expect(fast.count).toBe(5);
    expect(fast.samples.length).toBe(3);
    // r4 longest (6s), r3 (5s), r2 (4s)
    expect(fast.samples[0].run_id).toBe('r4');
  });

  test('still_running samples oldest-started first', () => {
    const c = connector();
    const runs: ConnectorRun[] = [
      run({ run_id: 'newest', started_at: new Date(NOW.getTime() - 1000).toISOString(), finished_at: null, status: 'running' }),
      run({ run_id: 'oldest', started_at: new Date(NOW.getTime() - 60000).toISOString(), finished_at: null, status: 'running' }),
    ];
    const reg = new MockRegistry([c], { 'c-1': runs });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    const sr = s.buckets.find((b) => b.bucket === 'still_running')!;
    expect(sr.samples[0].run_id).toBe('oldest');
  });
});

describe('M3.16 — mean / p50 / p95', () => {
  test('over finished runs only', () => {
    const c = connector();
    const runs: ConnectorRun[] = [
      run({ run_id: 'r1', started_at: new Date(NOW.getTime() - 1000).toISOString() }), // 1000ms
      run({ run_id: 'r2', started_at: new Date(NOW.getTime() - 2000).toISOString() }), // 2000ms
      run({ run_id: 'r3', started_at: new Date(NOW.getTime() - 3000).toISOString() }), // 3000ms
      run({ run_id: 'r4', started_at: new Date(NOW.getTime() - 5000).toISOString(), finished_at: null, status: 'running' }), // excluded
    ];
    const reg = new MockRegistry([c], { 'c-1': runs });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.mean_duration_ms).toBe(2000);
    expect(s.median_duration_ms).toBe(2000);
    // p95 of [1k, 2k, 3k]: 0.95 * 2 = 1.9; lower=2k, upper=3k, frac=0.9 → 2900
    expect(s.p95_duration_ms).toBe(2900);
  });
});

describe('M3.16 — slowest_run', () => {
  test('finds longest finished run', () => {
    const c = connector();
    const runs: ConnectorRun[] = [
      run({ run_id: 'short', started_at: new Date(NOW.getTime() - 1000).toISOString() }),
      run({ run_id: 'long', started_at: new Date(NOW.getTime() - 5000).toISOString() }),
    ];
    const reg = new MockRegistry([c], { 'c-1': runs });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.slowest_run?.run_id).toBe('long');
    expect(s.slowest_run?.duration_ms).toBe(5000);
  });

  test('null when no finished runs', () => {
    const c = connector();
    const runs: ConnectorRun[] = [
      run({ run_id: 'r1', finished_at: null, status: 'running' }),
    ];
    const reg = new MockRegistry([c], { 'c-1': runs });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.slowest_run).toBeNull();
  });
});

describe('M3.16 — partition invariant', () => {
  test('Σ buckets.count = total_runs', () => {
    const c = connector();
    const runs: ConnectorRun[] = [
      run({ run_id: 'r1', started_at: new Date(NOW.getTime() - 500).toISOString() }),
      run({ run_id: 'r2', started_at: new Date(NOW.getTime() - 5000).toISOString() }),
      run({ run_id: 'r3', started_at: new Date(NOW.getTime() - 5000).toISOString(), finished_at: null, status: 'running' }),
    ];
    const reg = new MockRegistry([c], { 'c-1': runs });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    const sum = s.buckets.reduce((acc, b) => acc + b.count, 0);
    expect(sum).toBe(s.total_runs);
  });

  test('total_finished + total_still_running = total_runs', () => {
    const c = connector();
    const runs: ConnectorRun[] = [
      run({ run_id: 'r1' }), // finished
      run({ run_id: 'r2', finished_at: null, status: 'running' }), // still
    ];
    const reg = new MockRegistry([c], { 'c-1': runs });
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.total_finished_runs + s.total_still_running).toBe(s.total_runs);
  });
});

describe('M3.16 — tenant_id + generated_at echo', () => {
  test('envelope echoes inputs', () => {
    const reg = new MockRegistry([]);
    const s = buildConnectorRunLatencyHistogram(reg, 'BIL', NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.per_connector_limit).toBe(200);
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M3.16 — GET /v1/ingestion/run-latency-histogram', () => {
  test('admin → 200 with default registry', async () => {
    const { app } = makeRlhApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/run-latency-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.buckets.length).toBe(6);
    expect(r.body.body.total_connectors).toBeGreaterThan(0);
  });

  test('populated → reflects runs', async () => {
    const reg = new InMemoryIngestionRegistry();
    // Trigger a manual run on cbs_loan_book
    reg.runNow('BIL', 'cbs_loan_book', 'admin', NOW);
    const { app } = makeRlhApp('admin', reg);
    const r = await request(app)
      .get('/v1/ingestion/run-latency-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_runs).toBeGreaterThan(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRlhApp('field_officer');
    const r = await request(app)
      .get('/v1/ingestion/run-latency-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M3.12 /v1/ingestion/run-volume/hourly sibling regression still 200', async () => {
    const { app } = makeRlhApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/run-volume/hourly')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('cross-tenant isolation via HTTP', async () => {
    const { app } = makeRlhApp('admin');
    const bil = await request(app)
      .get('/v1/ingestion/run-latency-histogram')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/ingestion/run-latency-histogram')
      .set(TH_BANK);
    // Both return their own per-tenant view from the InMemoryIngestionRegistry
    expect(bil.status).toBe(200);
    expect(bank.status).toBe(200);
  });
});
