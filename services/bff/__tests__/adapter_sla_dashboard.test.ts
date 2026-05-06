// services/bff/__tests__/adapter_sla_dashboard.test.ts
//
// T6 M14.11 — Per-adapter SLA dashboard.

import request from 'supertest';
import {
  AdapterSlaError,
  DEFAULT_SLA_TARGETS,
  buildAdapterSlaDashboard,
  validateSlaTargets,
} from '../src/adapter_sla_dashboard';
import {
  InMemoryIngestionRegistry,
  SEED_CONNECTORS,
  type Connector,
  type ConnectorRun,
} from '../src/ingestion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-06T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeDashApp(role = 'admin', registry?: InMemoryIngestionRegistry) {
  const reg = registry ?? new InMemoryIngestionRegistry();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    ingestionRegistry: reg,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, registry: reg };
}

// Helpers for synthesising runs at the pure-helper layer.

function mkConnector(o: Partial<Connector> & { id: string }): Connector {
  return {
    id: o.id,
    name: o.name ?? `Connector ${o.id}`,
    source_system: o.source_system ?? 'TEST',
    type: o.type ?? 'kafka_stream',
    schedule: o.schedule ?? 'continuous',
    default_status: o.default_status ?? 'healthy',
    description: o.description ?? '',
    status: o.status ?? 'healthy',
    last_run_at: o.last_run_at ?? null,
    last_run_status: o.last_run_status ?? null,
    last_run_records: o.last_run_records ?? 0,
    average_lag_seconds: o.average_lag_seconds ?? 0,
    paused_at: o.paused_at ?? null,
  };
}

function mkRun(o: {
  run_id: string;
  connector_id: string;
  started_at: string;
  duration_ms?: number;
  status?: 'success' | 'failure' | 'partial' | 'running';
  error_message?: string | null;
}): ConnectorRun {
  const startedMs = new Date(o.started_at).getTime();
  const finishedMs =
    o.status === 'running' ? null : startedMs + (o.duration_ms ?? 1000);
  return {
    run_id: o.run_id,
    connector_id: o.connector_id,
    started_at: o.started_at,
    finished_at: finishedMs === null ? null : new Date(finishedMs).toISOString(),
    status: o.status ?? 'success',
    records_processed: o.status === 'failure' ? 0 : 100,
    records_failed: o.status === 'partial' ? 5 : 0,
    error_message: o.error_message ?? null,
    triggered_manually: false,
  };
}

// ── validateSlaTargets ──────────────────────────────────────────────

describe('validateSlaTargets (M14.11)', () => {
  test('empty input → DEFAULT_SLA_TARGETS', () => {
    expect(validateSlaTargets({})).toEqual(DEFAULT_SLA_TARGETS);
  });

  test('passthrough valid override', () => {
    expect(
      validateSlaTargets({ min_success_rate: 0.99, max_p95_latency_ms: 5000 }),
    ).toEqual({ min_success_rate: 0.99, max_p95_latency_ms: 5000 });
  });

  test('coerces numeric strings', () => {
    expect(
      validateSlaTargets({ min_success_rate: '0.9', max_p95_latency_ms: '10000' }),
    ).toEqual({ min_success_rate: 0.9, max_p95_latency_ms: 10000 });
  });

  test('rejects min_success_rate out of [0,1]', () => {
    expect(() => validateSlaTargets({ min_success_rate: 1.1 })).toThrow(
      AdapterSlaError,
    );
    expect(() => validateSlaTargets({ min_success_rate: -0.1 })).toThrow(
      AdapterSlaError,
    );
  });

  test('rejects negative or > 24h max_p95_latency_ms', () => {
    expect(() => validateSlaTargets({ max_p95_latency_ms: -1 })).toThrow(
      AdapterSlaError,
    );
    expect(() =>
      validateSlaTargets({ max_p95_latency_ms: 25 * 60 * 60 * 1000 }),
    ).toThrow(AdapterSlaError);
  });

  test('rejects non-numeric values', () => {
    expect(() => validateSlaTargets({ min_success_rate: 'abc' })).toThrow(
      AdapterSlaError,
    );
  });
});

// ── buildAdapterSlaDashboard ────────────────────────────────────────

describe('buildAdapterSlaDashboard (M14.11 pure helper)', () => {
  test('empty connector list → empty dashboard, all counts 0', () => {
    const r = buildAdapterSlaDashboard(
      [],
      new Map(),
      DEFAULT_SLA_TARGETS,
      { window: 20, now: NOW },
    );
    expect(r.fleet_summary.total_connectors).toBe(0);
    expect(r.fleet_summary.sla_met_count).toBe(0);
    expect(r.fleet_summary.sla_breached_count).toBe(0);
    expect(r.fleet_summary.sla_unknown_count).toBe(0);
    expect(r.fleet_summary.fleet_mean_success_rate).toBeNull();
    expect(r.fleet_summary.fleet_worst_p95_latency_ms).toBeNull();
    expect(r.per_adapter).toEqual([]);
    expect(r.targets).toEqual(DEFAULT_SLA_TARGETS);
    expect(r.default_targets).toEqual(DEFAULT_SLA_TARGETS);
    expect(r.window).toBe(20);
  });

  test('connector with no runs → unknown', () => {
    const c = mkConnector({ id: 'cbs_loan_book' });
    const r = buildAdapterSlaDashboard([c], new Map(), DEFAULT_SLA_TARGETS, {
      window: 20,
      now: NOW,
    });
    expect(r.per_adapter[0]!.sla_status).toBe('unknown');
    expect(r.per_adapter[0]!.sla_breaches).toEqual(['no_finished_runs']);
    expect(r.fleet_summary.sla_unknown_count).toBe(1);
    expect(r.fleet_summary.sla_met_count).toBe(0);
    expect(r.fleet_summary.fleet_mean_success_rate).toBeNull();
  });

  test('connector with all-success runs under SLA → met', () => {
    const c = mkConnector({ id: 'cbs_loan_book' });
    const runs = Array.from({ length: 10 }, (_, i) =>
      mkRun({
        run_id: `r-${i}`,
        connector_id: 'cbs_loan_book',
        started_at: new Date(NOW.getTime() - i * 60_000).toISOString(),
        duration_ms: 5000,
        status: 'success',
      }),
    );
    const r = buildAdapterSlaDashboard(
      [c],
      new Map([['cbs_loan_book', runs]]),
      DEFAULT_SLA_TARGETS,
      { window: 20, now: NOW },
    );
    expect(r.per_adapter[0]!.sla_status).toBe('met');
    expect(r.per_adapter[0]!.sla_breaches).toEqual([]);
    expect(r.per_adapter[0]!.success_rate).toBe(1);
    expect(r.per_adapter[0]!.p95_latency_ms).toBe(5000);
    expect(r.fleet_summary.sla_met_count).toBe(1);
    expect(r.fleet_summary.fleet_mean_success_rate).toBe(1);
    expect(r.fleet_summary.fleet_worst_p95_latency_ms).toBe(5000);
  });

  test('breach: success rate below target', () => {
    const c = mkConnector({ id: 'cbs_loan_book' });
    // 5 successes + 5 failures → 0.5 success rate < 0.95 default
    const runs: ConnectorRun[] = [];
    for (let i = 0; i < 5; i++) {
      runs.push(
        mkRun({
          run_id: `s-${i}`,
          connector_id: 'cbs_loan_book',
          started_at: new Date(NOW.getTime() - i * 60_000).toISOString(),
          duration_ms: 1000,
          status: 'success',
        }),
      );
    }
    for (let i = 0; i < 5; i++) {
      runs.push(
        mkRun({
          run_id: `f-${i}`,
          connector_id: 'cbs_loan_book',
          started_at: new Date(NOW.getTime() - (i + 5) * 60_000).toISOString(),
          duration_ms: 1000,
          status: 'failure',
          error_message: 'boom',
        }),
      );
    }
    const r = buildAdapterSlaDashboard(
      [c],
      new Map([['cbs_loan_book', runs]]),
      DEFAULT_SLA_TARGETS,
      { window: 20, now: NOW },
    );
    expect(r.per_adapter[0]!.sla_status).toBe('breached');
    expect(r.per_adapter[0]!.sla_breaches).toContain('success_rate_below_target');
    expect(r.per_adapter[0]!.success_rate).toBe(0.5);
    expect(r.fleet_summary.sla_breached_count).toBe(1);
  });

  test('breach: p95 latency above target', () => {
    const c = mkConnector({ id: 'cbs_loan_book' });
    // 10 success runs, latency 100s each → p95 = 100_000ms > 30_000 default
    const runs = Array.from({ length: 10 }, (_, i) =>
      mkRun({
        run_id: `slow-${i}`,
        connector_id: 'cbs_loan_book',
        started_at: new Date(NOW.getTime() - i * 60_000).toISOString(),
        duration_ms: 100_000,
        status: 'success',
      }),
    );
    const r = buildAdapterSlaDashboard(
      [c],
      new Map([['cbs_loan_book', runs]]),
      DEFAULT_SLA_TARGETS,
      { window: 20, now: NOW },
    );
    expect(r.per_adapter[0]!.sla_status).toBe('breached');
    expect(r.per_adapter[0]!.sla_breaches).toContain('p95_latency_above_target');
    expect(r.per_adapter[0]!.sla_breaches).not.toContain('success_rate_below_target');
    expect(r.per_adapter[0]!.p95_latency_ms).toBe(100_000);
  });

  test('breach: BOTH success rate and p95 latency', () => {
    const c = mkConnector({ id: 'cbs_loan_book' });
    const runs: ConnectorRun[] = [
      mkRun({ run_id: 's', connector_id: 'cbs_loan_book', started_at: NOW.toISOString(), duration_ms: 60_000, status: 'success' }),
      mkRun({ run_id: 'f1', connector_id: 'cbs_loan_book', started_at: NOW.toISOString(), duration_ms: 60_000, status: 'failure', error_message: 'x' }),
      mkRun({ run_id: 'f2', connector_id: 'cbs_loan_book', started_at: NOW.toISOString(), duration_ms: 60_000, status: 'failure', error_message: 'x' }),
    ];
    const r = buildAdapterSlaDashboard(
      [c],
      new Map([['cbs_loan_book', runs]]),
      DEFAULT_SLA_TARGETS,
      { window: 20, now: NOW },
    );
    expect(r.per_adapter[0]!.sla_breaches.sort()).toEqual([
      'p95_latency_above_target',
      'success_rate_below_target',
    ]);
  });

  test('mixed fleet: 1 met + 1 breached + 1 unknown', () => {
    const cMet = mkConnector({ id: 'a' });
    const cBreached = mkConnector({ id: 'b' });
    const cUnknown = mkConnector({ id: 'c' });
    const runs = new Map<string, readonly ConnectorRun[]>();
    runs.set('a', [
      mkRun({ run_id: 'a1', connector_id: 'a', started_at: NOW.toISOString(), duration_ms: 1000 }),
    ]);
    runs.set('b', [
      mkRun({ run_id: 'b1', connector_id: 'b', started_at: NOW.toISOString(), duration_ms: 100_000 }),
    ]);
    // c → no runs
    const r = buildAdapterSlaDashboard(
      [cMet, cBreached, cUnknown],
      runs,
      DEFAULT_SLA_TARGETS,
      { window: 20, now: NOW },
    );
    expect(r.fleet_summary.sla_met_count).toBe(1);
    expect(r.fleet_summary.sla_breached_count).toBe(1);
    expect(r.fleet_summary.sla_unknown_count).toBe(1);
    expect(r.fleet_summary.total_connectors).toBe(3);
    // Mean success rate ignores unknowns (a=1.0, b=1.0 → mean 1.0)
    expect(r.fleet_summary.fleet_mean_success_rate).toBe(1);
    // Worst p95 across known = max(1000, 100000) = 100000
    expect(r.fleet_summary.fleet_worst_p95_latency_ms).toBe(100_000);
  });

  test('custom targets override default', () => {
    const c = mkConnector({ id: 'cbs_loan_book' });
    const runs = Array.from({ length: 5 }, (_, i) =>
      mkRun({
        run_id: `r-${i}`,
        connector_id: 'cbs_loan_book',
        started_at: NOW.toISOString(),
        duration_ms: 50_000,
      }),
    );
    // Default would breach (50000 > 30000), but raise the cap to 100000
    const r = buildAdapterSlaDashboard(
      [c],
      new Map([['cbs_loan_book', runs]]),
      { min_success_rate: 0.9, max_p95_latency_ms: 100_000 },
      { window: 20, now: NOW },
    );
    expect(r.per_adapter[0]!.sla_status).toBe('met');
    expect(r.per_adapter[0]!.sla_targets).toEqual({
      min_success_rate: 0.9,
      max_p95_latency_ms: 100_000,
    });
  });

  test('in-flight runs surface but do not block SLA evaluation', () => {
    const c = mkConnector({ id: 'cbs_loan_book' });
    const runs: ConnectorRun[] = [
      mkRun({ run_id: 'done', connector_id: 'cbs_loan_book', started_at: NOW.toISOString(), duration_ms: 1000 }),
      mkRun({ run_id: 'inflight', connector_id: 'cbs_loan_book', started_at: NOW.toISOString(), status: 'running' }),
    ];
    const r = buildAdapterSlaDashboard(
      [c],
      new Map([['cbs_loan_book', runs]]),
      DEFAULT_SLA_TARGETS,
      { window: 20, now: NOW },
    );
    expect(r.per_adapter[0]!.in_flight_count).toBe(1);
    expect(r.per_adapter[0]!.finished_count).toBe(1);
    expect(r.per_adapter[0]!.sla_status).toBe('met');
  });

  test('echoes connector metadata in row', () => {
    const c = mkConnector({
      id: 'cbs_loan_book',
      name: 'CBS Loan Book',
      source_system: 'CBS',
    });
    const runs = [
      mkRun({ run_id: 'r1', connector_id: 'cbs_loan_book', started_at: NOW.toISOString(), duration_ms: 1000 }),
    ];
    const r = buildAdapterSlaDashboard(
      [c],
      new Map([['cbs_loan_book', runs]]),
      DEFAULT_SLA_TARGETS,
      { window: 20, now: NOW },
    );
    expect(r.per_adapter[0]!.connector_id).toBe('cbs_loan_book');
    expect(r.per_adapter[0]!.name).toBe('CBS Loan Book');
    expect(r.per_adapter[0]!.source_system).toBe('CBS');
  });
});

// ── HTTP route ──────────────────────────────────────────────────────

describe('GET /v1/ingestion/adapters/sla-dashboard (M14.11)', () => {
  test('analyst+ 200 with one row per seed connector + all unknown when no runs', async () => {
    const { app } = makeDashApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/adapters/sla-dashboard')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.fleet_summary.total_connectors).toBe(SEED_CONNECTORS.length);
    expect(r.body.body.per_adapter.length).toBe(SEED_CONNECTORS.length);
    // No runs yet → everything unknown
    expect(r.body.body.fleet_summary.sla_unknown_count).toBe(
      SEED_CONNECTORS.length,
    );
    expect(r.body.body.targets).toEqual(DEFAULT_SLA_TARGETS);
  });

  test('after runs land, SLA evaluates met for healthy connectors', async () => {
    const reg = new InMemoryIngestionRegistry();
    // Trigger 3 runs against the first seed connector (default healthy)
    for (let i = 0; i < 3; i++) {
      reg.runNow('BIL', SEED_CONNECTORS[0]!.id, 'scheduler', NOW);
    }
    const { app } = makeDashApp('admin', reg);
    const r = await request(app)
      .get('/v1/ingestion/adapters/sla-dashboard')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    const row = r.body.body.per_adapter.find(
      (x: { connector_id: string }) => x.connector_id === SEED_CONNECTORS[0]!.id,
    );
    expect(row.sample_size).toBe(3);
    expect(row.success_rate).toBe(1);
    expect(row.sla_status).toBe('met');
  });

  test('custom thresholds via query params honoured', async () => {
    const { app } = makeDashApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/adapters/sla-dashboard?min_success_rate=0.5&max_p95_latency_ms=5000')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.targets).toEqual({
      min_success_rate: 0.5,
      max_p95_latency_ms: 5000,
    });
  });

  test('window=N forwarded to per-connector listRuns', async () => {
    const { app } = makeDashApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/adapters/sla-dashboard?window=5')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.window).toBe(5);
  });

  test('window out of range → 400', async () => {
    const { app } = makeDashApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/adapters/sla-dashboard?window=999')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('invalid min_success_rate → 400', async () => {
    const { app } = makeDashApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/adapters/sla-dashboard?min_success_rate=2')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeDashApp('case_owner');
    const r = await request(app)
      .get('/v1/ingestion/adapters/sla-dashboard')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M3.5 single-connector route still works alongside M14.11', async () => {
    const reg = new InMemoryIngestionRegistry();
    reg.runNow('BIL', SEED_CONNECTORS[0]!.id, 'scheduler', NOW);
    const { app } = makeDashApp('admin', reg);
    const r = await request(app)
      .get(`/v1/ingestion/connectors/${SEED_CONNECTORS[0]!.id}/runs/analytics`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.connector_id).toBe(SEED_CONNECTORS[0]!.id);
  });

  test('isolates tenants — runs in BIL not visible to BANK_DEMO', async () => {
    const reg = new InMemoryIngestionRegistry();
    reg.runNow('BIL', SEED_CONNECTORS[0]!.id, 'scheduler', NOW);
    const { app } = makeDashApp('admin', reg);
    const r = await request(app)
      .get('/v1/ingestion/adapters/sla-dashboard')
      .set({ ...TH_BIL, 'X-Tenant-ID': 'BANK_DEMO' });
    expect(r.status).toBe(200);
    // BANK_DEMO has zero runs across all seed connectors → all unknown
    expect(r.body.body.fleet_summary.sla_unknown_count).toBe(
      SEED_CONNECTORS.length,
    );
    expect(r.body.body.fleet_summary.sla_met_count).toBe(0);
  });
});
