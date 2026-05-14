// services/bff/__tests__/connector_run_failure_patterns.test.ts
//
// T6 M3.6 — Connector run failure pattern clustering.

import request from 'supertest';
import {
  TOP_CLUSTERS_CAP,
  clusterRunFailures,
  normaliseError,
} from '../src/connector_run_failure_patterns';
import { InMemoryIngestionRegistry, type ConnectorRun } from '../src/ingestion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

let runSeq = 0;
function mkRun(o: Partial<ConnectorRun> & { status: ConnectorRun['status'] }): ConnectorRun {
  runSeq += 1;
  return {
    run_id: o.run_id ?? `r${runSeq}`,
    connector_id: o.connector_id ?? 'cbs_loan_book',
    started_at: o.started_at ?? NOW.toISOString(),
    finished_at: o.finished_at ?? NOW.toISOString(),
    status: o.status,
    records_processed: o.records_processed ?? 100,
    records_failed: o.records_failed ?? 0,
    error_message: o.error_message ?? null,
    triggered_manually: o.triggered_manually ?? false,
  };
}

beforeEach(() => {
  runSeq = 0;
});

// ─── normaliseError ──────────────────────────────────────────────────

describe('M3.6 — normaliseError', () => {
  test('collapses numbers to <N>', () => {
    expect(normaliseError('connection timed out after 30 seconds')).toBe(
      'connection timed out after <N> seconds',
    );
  });

  test('collapses UUIDs to <UUID>', () => {
    expect(
      normaliseError('record 4a8b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d failed'),
    ).toBe('record <UUID> failed');
  });

  test('collapses ISO timestamps to <TS>', () => {
    expect(
      normaliseError('window ended at 2026-05-14T08:00:00.000Z'),
    ).toBe('window ended at <TS>');
  });

  test('collapses single + double quoted strings to <STR>', () => {
    expect(normaliseError(`cannot parse 'abc' / "xyz"`)).toBe(
      `cannot parse '<STR>' / "<STR>"`,
    );
  });

  test('collapses POSIX paths to <PATH>', () => {
    expect(normaliseError('write failed: /var/log/cbs.log')).toBe(
      'write failed: <PATH>',
    );
  });

  test('collapses long hex runs to <HASH>', () => {
    expect(
      normaliseError('hash 0123456789abcdef0123 mismatch'),
    ).toBe('hash <HASH> mismatch');
  });

  test('collapses runs of whitespace + trims', () => {
    expect(normaliseError('   foo    bar   ')).toBe('foo bar');
  });

  test('similar errors with different variable bits collapse to the same pattern', () => {
    const a = normaliseError('record 4a8b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d failed after 30s');
    const b = normaliseError('record 11111111-2222-3333-4444-555555555555 failed after 45s');
    expect(a).toBe(b);
  });
});

// ─── clusterRunFailures ──────────────────────────────────────────────

describe('M3.6 — clusterRunFailures — empty + edge', () => {
  test('empty window → zero envelope', () => {
    const out = clusterRunFailures([]);
    expect(out.sample_size).toBe(0);
    expect(out.failure_count).toBe(0);
    expect(out.distinct_patterns).toBe(0);
    expect(out.clusters).toEqual([]);
  });

  test('all successes → no failures detected', () => {
    const runs: ConnectorRun[] = [
      mkRun({ status: 'success' }),
      mkRun({ status: 'success' }),
    ];
    const out = clusterRunFailures(runs);
    expect(out.sample_size).toBe(2);
    expect(out.failure_count).toBe(0);
  });

  test('failure with null error_message is skipped (no message to cluster)', () => {
    const runs: ConnectorRun[] = [
      mkRun({ status: 'failure', error_message: null }),
      mkRun({ status: 'failure', error_message: '' }),
      mkRun({ status: 'failure', error_message: '   ' }),
    ];
    const out = clusterRunFailures(runs);
    expect(out.failure_count).toBe(0);
    expect(out.clusters).toEqual([]);
  });
});

describe('M3.6 — clusterRunFailures — grouping', () => {
  test('similar errors cluster together; distinct ones stay separate', () => {
    const runs: ConnectorRun[] = [
      mkRun({ status: 'failure', error_message: 'connection timed out after 30 seconds' }),
      mkRun({ status: 'failure', error_message: 'connection timed out after 45 seconds' }),
      mkRun({ status: 'failure', error_message: 'connection timed out after 60 seconds' }),
      mkRun({ status: 'failure', error_message: 'parse error at offset 12: unexpected token' }),
    ];
    const out = clusterRunFailures(runs);
    expect(out.failure_count).toBe(4);
    expect(out.distinct_patterns).toBe(2);
    expect(out.clusters[0]!.count).toBe(3);
    expect(out.clusters[0]!.pattern).toBe('connection timed out after <N> seconds');
    expect(out.clusters[1]!.count).toBe(1);
  });

  test('partial-status runs ALSO cluster (partial = failure-flavored)', () => {
    const runs: ConnectorRun[] = [
      mkRun({ status: 'partial', error_message: 'X failed' }),
      mkRun({ status: 'partial', error_message: 'X failed' }),
    ];
    const out = clusterRunFailures(runs);
    expect(out.failure_count).toBe(2);
    expect(out.clusters[0]!.count).toBe(2);
  });

  test('clusters sorted by count desc, ties broken by last_failed_at desc', () => {
    const runs: ConnectorRun[] = [
      mkRun({
        status: 'failure',
        error_message: 'X',
        finished_at: '2026-05-14T08:00:00.000Z',
      }),
      mkRun({
        status: 'failure',
        error_message: 'Y',
        finished_at: '2026-05-14T10:00:00.000Z',
      }),
      // X tied with Y on count (1 each), but Y's last_failed_at is newer → Y first.
    ];
    const out = clusterRunFailures(runs);
    expect(out.clusters.map((c) => c.pattern)).toEqual(['Y', 'X']);
  });

  test('recent_messages cap at 3, newest-first', () => {
    const runs: ConnectorRun[] = [];
    for (let i = 0; i < 5; i++) {
      runs.push(
        mkRun({
          status: 'failure',
          error_message: 'same pattern',
          // i=0 oldest, i=4 newest
          finished_at: `2026-05-1${4 + Math.floor(i / 3)}T0${i}:00:00.000Z`,
        }),
      );
    }
    const out = clusterRunFailures(runs);
    expect(out.clusters[0]!.count).toBe(5);
    expect(out.clusters[0]!.recent_messages.length).toBe(3);
  });

  test('top_clusters capped at TOP_CLUSTERS_CAP', () => {
    const runs: ConnectorRun[] = [];
    // 15 unique patterns, each with 1 failure.
    for (let i = 0; i < 15; i++) {
      runs.push(mkRun({ status: 'failure', error_message: `unique error ${String.fromCharCode(65 + i)}` }));
    }
    const out = clusterRunFailures(runs);
    expect(out.distinct_patterns).toBe(15);
    expect(out.clusters.length).toBe(TOP_CLUSTERS_CAP);
  });

  test('last_failed_at + sample_run_id reflect the newest matching run', () => {
    const runs: ConnectorRun[] = [
      mkRun({
        run_id: 'old',
        status: 'failure',
        error_message: 'P',
        finished_at: '2026-05-14T08:00:00.000Z',
      }),
      mkRun({
        run_id: 'new',
        status: 'failure',
        error_message: 'P',
        finished_at: '2026-05-14T10:00:00.000Z',
      }),
    ];
    const out = clusterRunFailures(runs);
    expect(out.clusters[0]!.last_failed_at).toBe('2026-05-14T10:00:00.000Z');
    expect(out.clusters[0]!.sample_run_id).toBe('new');
  });
});

// ─── GET /v1/ingestion/connectors/:id/runs/failure-patterns ──────────

function makeFailureApp(role = 'admin', registry?: InMemoryIngestionRegistry) {
  const ingestionRegistry = registry ?? new InMemoryIngestionRegistry();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    ingestionRegistry,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, ingestionRegistry };
}

describe('M3.6 — GET /v1/ingestion/connectors/:id/runs/failure-patterns', () => {
  test('empty registry → 200 zero envelope', async () => {
    const { app } = makeFailureApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/runs/failure-patterns')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.connector_id).toBe('cbs_loan_book');
    expect(r.body.body.patterns.failure_count).toBe(0);
  });

  test('?window=0 → 400', async () => {
    const { app } = makeFailureApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/runs/failure-patterns?window=0')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('unknown connector → 404', async () => {
    const { app } = makeFailureApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/connectors/no.such.connector/runs/failure-patterns')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_connector');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeFailureApp('case_owner');
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/runs/failure-patterns')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BANK_DEMO does not see BIL failures', async () => {
    const reg = new InMemoryIngestionRegistry();
    reg.runNow('BIL', 'cbs_loan_book', 'alice', NOW);
    const { app } = makeFailureApp('admin', reg);
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/runs/failure-patterns')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.patterns.failure_count).toBe(0);
  });
});
