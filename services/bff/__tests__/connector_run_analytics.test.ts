// services/bff/__tests__/connector_run_analytics.test.ts
//
// T6 M3.5 — Connector run analytics.

import request from 'supertest';
import {
  RUN_ANALYTICS_DEFAULT_WINDOW,
  RUN_ANALYTICS_MAX_WINDOW,
  aggregateRunAnalytics,
  linearPercentile,
} from '../src/connector_run_analytics';
import { InMemoryIngestionRegistry, type ConnectorRun } from '../src/ingestion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T20:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeAnalyticsApp(role = 'admin', registry?: InMemoryIngestionRegistry) {
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

// ─── linearPercentile ─────────────────────────────────────────────────

describe('M3.5 — linearPercentile', () => {
  test('empty array → null', () => {
    expect(linearPercentile([], 0.5)).toBeNull();
  });

  test('single sample → that value at any p', () => {
    expect(linearPercentile([42], 0.0)).toBe(42);
    expect(linearPercentile([42], 0.5)).toBe(42);
    expect(linearPercentile([42], 1.0)).toBe(42);
  });

  test('p=0 returns min, p=1 returns max', () => {
    const xs = [10, 20, 30, 40, 50];
    expect(linearPercentile(xs, 0)).toBe(10);
    expect(linearPercentile(xs, 1)).toBe(50);
  });

  test('p=0.5 over 5 samples = 30 (median, type 7)', () => {
    expect(linearPercentile([10, 20, 30, 40, 50], 0.5)).toBe(30);
  });

  test('p=0.95 over 20 evenly spaced samples interpolates', () => {
    const xs = Array.from({ length: 20 }, (_, i) => (i + 1) * 100); // 100..2000
    // rank = 0.95 * 19 = 18.05 → between xs[18]=1900 and xs[19]=2000 → 1905
    expect(linearPercentile(xs, 0.95)).toBeCloseTo(1905, 5);
  });

  test('p clamps below 0 / above 1', () => {
    const xs = [1, 2, 3];
    expect(linearPercentile(xs, -0.5)).toBe(1);
    expect(linearPercentile(xs, 1.5)).toBe(3);
  });
});

// ─── aggregateRunAnalytics ────────────────────────────────────────────

function mkRun(o: Partial<ConnectorRun> & { run_id: string; started_at: string }): ConnectorRun {
  return {
    run_id: o.run_id,
    connector_id: 'cbs_loan_book',
    started_at: o.started_at,
    finished_at: o.finished_at ?? null,
    status: o.status ?? 'success',
    records_processed: o.records_processed ?? 0,
    records_failed: o.records_failed ?? 0,
    error_message: o.error_message ?? null,
    triggered_manually: o.triggered_manually ?? false,
  };
}

describe('M3.5 — aggregateRunAnalytics', () => {
  test('empty → null fields, sample_size 0', () => {
    const a = aggregateRunAnalytics([]);
    expect(a.sample_size).toBe(0);
    expect(a.in_flight_count).toBe(0);
    expect(a.success_rate).toBeNull();
    expect(a.duration_ms.mean).toBeNull();
    expect(a.duration_ms.p50).toBeNull();
    expect(a.duration_ms.p95).toBeNull();
    expect(a.records_processed_total).toBe(0);
    expect(a.last_failure).toBeNull();
  });

  test('all-success: success_rate=1', () => {
    const runs: ConnectorRun[] = [
      mkRun({
        run_id: 'r1',
        started_at: '2026-05-05T19:00:00.000Z',
        finished_at: '2026-05-05T19:00:10.000Z',
        records_processed: 100,
      }),
      mkRun({
        run_id: 'r2',
        started_at: '2026-05-05T19:01:00.000Z',
        finished_at: '2026-05-05T19:01:20.000Z',
        records_processed: 200,
      }),
    ];
    const a = aggregateRunAnalytics(runs);
    expect(a.sample_size).toBe(2);
    expect(a.success_rate).toBe(1);
    expect(a.by_status.success).toBe(2);
    expect(a.duration_ms.min).toBe(10_000);
    expect(a.duration_ms.max).toBe(20_000);
    expect(a.duration_ms.mean).toBe(15_000);
    expect(a.records_processed_total).toBe(300);
  });

  test('mixed status: success_rate excludes partial+failure', () => {
    const runs: ConnectorRun[] = [
      mkRun({
        run_id: 'r1',
        started_at: '2026-05-05T19:00:00.000Z',
        finished_at: '2026-05-05T19:00:10.000Z',
        status: 'success',
      }),
      mkRun({
        run_id: 'r2',
        started_at: '2026-05-05T19:01:00.000Z',
        finished_at: '2026-05-05T19:01:10.000Z',
        status: 'failure',
        error_message: 'connection refused',
      }),
      mkRun({
        run_id: 'r3',
        started_at: '2026-05-05T19:02:00.000Z',
        finished_at: '2026-05-05T19:02:10.000Z',
        status: 'partial',
        error_message: '3 records failed',
      }),
      mkRun({
        run_id: 'r4',
        started_at: '2026-05-05T19:03:00.000Z',
        finished_at: '2026-05-05T19:03:10.000Z',
        status: 'success',
      }),
    ];
    const a = aggregateRunAnalytics(runs);
    expect(a.success_rate).toBe(0.5);
    expect(a.by_status.success).toBe(2);
    expect(a.by_status.failure).toBe(1);
    expect(a.by_status.partial).toBe(1);
  });

  test('in-flight runs surface separately, not folded into success_rate', () => {
    const runs: ConnectorRun[] = [
      mkRun({
        run_id: 'r1',
        started_at: '2026-05-05T19:00:00.000Z',
        finished_at: '2026-05-05T19:00:10.000Z',
        status: 'success',
      }),
      mkRun({
        run_id: 'r2',
        started_at: '2026-05-05T19:01:00.000Z',
        finished_at: null,
        status: 'running',
      }),
    ];
    const a = aggregateRunAnalytics(runs);
    expect(a.sample_size).toBe(2);
    expect(a.in_flight_count).toBe(1);
    expect(a.by_status.running).toBe(1);
    expect(a.success_rate).toBe(1); // computed only over the 1 finished run
  });

  test('last_failure picks newest failure by finished_at', () => {
    const runs: ConnectorRun[] = [
      mkRun({
        run_id: 'older-fail',
        started_at: '2026-05-05T18:00:00.000Z',
        finished_at: '2026-05-05T18:00:10.000Z',
        status: 'failure',
        error_message: 'old error',
      }),
      mkRun({
        run_id: 'newer-fail',
        started_at: '2026-05-05T19:00:00.000Z',
        finished_at: '2026-05-05T19:00:10.000Z',
        status: 'failure',
        error_message: 'newer error',
      }),
      mkRun({
        run_id: 'success',
        started_at: '2026-05-05T20:00:00.000Z',
        finished_at: '2026-05-05T20:00:10.000Z',
        status: 'success',
      }),
    ];
    const a = aggregateRunAnalytics(runs);
    expect(a.last_failure?.run_id).toBe('newer-fail');
    expect(a.last_failure?.error_message).toBe('newer error');
  });

  test('records_failed_total sums across finished runs', () => {
    const runs: ConnectorRun[] = [
      mkRun({
        run_id: 'r1',
        started_at: '2026-05-05T19:00:00.000Z',
        finished_at: '2026-05-05T19:00:10.000Z',
        records_processed: 100,
        records_failed: 5,
      }),
      mkRun({
        run_id: 'r2',
        started_at: '2026-05-05T19:01:00.000Z',
        finished_at: '2026-05-05T19:01:10.000Z',
        records_processed: 200,
        records_failed: 12,
      }),
    ];
    const a = aggregateRunAnalytics(runs);
    expect(a.records_failed_total).toBe(17);
  });

  test('p50 / p95 use linear interpolation', () => {
    // 5 samples with known durations: 1s, 2s, 3s, 4s, 5s
    const runs: ConnectorRun[] = [1, 2, 3, 4, 5].map((sec, i) =>
      mkRun({
        run_id: `r${i}`,
        started_at: '2026-05-05T19:00:00.000Z',
        finished_at: new Date(Date.parse('2026-05-05T19:00:00.000Z') + sec * 1000).toISOString(),
      }),
    );
    const a = aggregateRunAnalytics(runs);
    expect(a.duration_ms.p50).toBe(3000);
    // p95 over 5 samples: rank=0.95*4=3.8 → between xs[3]=4000 and xs[4]=5000 → 4800
    expect(a.duration_ms.p95).toBeCloseTo(4800, 5);
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('M3.5 — GET /v1/ingestion/connectors/:id/runs/analytics', () => {
  test('happy: returns analytics envelope', async () => {
    const reg = new InMemoryIngestionRegistry();
    // Trigger 3 runs to build history.
    reg.runNow('BIL', 'cbs_loan_book', 'taniya', NOW);
    reg.runNow('BIL', 'cbs_loan_book', 'taniya', new Date(NOW.getTime() + 60_000));
    reg.runNow('BIL', 'cbs_loan_book', 'taniya', new Date(NOW.getTime() + 120_000));
    const { app } = makeAnalyticsApp('admin', reg);
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/runs/analytics')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.connector_id).toBe('cbs_loan_book');
    expect(r.body.body.window).toBe(RUN_ANALYTICS_DEFAULT_WINDOW);
    expect(r.body.body.analytics.sample_size).toBeGreaterThanOrEqual(1);
    expect(r.body.body.analytics.duration_ms).toHaveProperty('p50');
    expect(r.body.body.analytics.duration_ms).toHaveProperty('p95');
    expect(r.body.body.analytics.by_status).toHaveProperty('success');
  });

  test('?window=5 honoured', async () => {
    const reg = new InMemoryIngestionRegistry();
    for (let i = 0; i < 10; i++) {
      reg.runNow('BIL', 'cbs_loan_book', 'taniya', new Date(NOW.getTime() + i * 60_000));
    }
    const { app } = makeAnalyticsApp('admin', reg);
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/runs/analytics?window=5')
      .set(TH_BIL);
    expect(r.body.body.window).toBe(5);
    expect(r.body.body.analytics.sample_size).toBeLessThanOrEqual(5);
  });

  test('?window=0 → 400', async () => {
    const { app } = makeAnalyticsApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/runs/analytics?window=0')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test(`?window > ${RUN_ANALYTICS_MAX_WINDOW} → 400`, async () => {
    const { app } = makeAnalyticsApp('admin');
    const r = await request(app)
      .get(
        `/v1/ingestion/connectors/cbs_loan_book/runs/analytics?window=${RUN_ANALYTICS_MAX_WINDOW + 1}`,
      )
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('?window=abc → 400 (NaN)', async () => {
    const { app } = makeAnalyticsApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/runs/analytics?window=abc')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('unknown connector → 404', async () => {
    const { app } = makeAnalyticsApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/connectors/no.such.connector/runs/analytics')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_connector');
  });

  test('cross-tenant: BANK_DEMO does not see BIL runs', async () => {
    const reg = new InMemoryIngestionRegistry();
    reg.runNow('BIL', 'cbs_loan_book', 'taniya', NOW);
    const { app } = makeAnalyticsApp('admin', reg);
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/runs/analytics')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.analytics.sample_size).toBe(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAnalyticsApp('case_owner');
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/runs/analytics')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M3.1 /runs (without /analytics suffix) still works (no shadow)', async () => {
    const reg = new InMemoryIngestionRegistry();
    reg.runNow('BIL', 'cbs_loan_book', 'taniya', NOW);
    const { app } = makeAnalyticsApp('admin', reg);
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/runs')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.items).toBeDefined();
  });
});
