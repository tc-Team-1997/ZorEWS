// services/bff/__tests__/report_job_processing_time_histogram.test.ts
//
// T6 M12.19 — Report job processing-time histogram.

import request from 'supertest';
import {
  ALL_REPORT_JOB_PROCESSING_TIME_BUCKETS,
  SAMPLE_JOBS_CAP,
  bucketForProcessingMs,
  buildReportJobProcessingTimeHistogram,
  buildReportJobProcessingTimeHistogramFromStore,
} from '../src/report_job_processing_time_histogram';
import {
  type ReportJob,
  type ReportFormat,
  type JobStatus,
  InMemoryReportJobStore,
} from '../src/reports_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-23T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;

// ─── helpers ────────────────────────────────────────────────────────

function mkJob(opts: {
  job_id: string;
  status?: JobStatus;
  requested_at_offset_ms?: number; // ms before NOW
  duration_ms?: number; // for completed: completed_at = requested + duration
  format?: ReportFormat;
  report_id?: string;
  requested_by?: string;
  error_message?: string | null;
}): ReportJob {
  const requested_at = new Date(
    NOW.getTime() - (opts.requested_at_offset_ms ?? 60 * 60 * 1000),
  ).toISOString();
  const status = opts.status ?? 'completed';
  const completed_at =
    status === 'completed' && opts.duration_ms !== undefined
      ? new Date(
          NOW.getTime() - (opts.requested_at_offset_ms ?? 60 * 60 * 1000) + opts.duration_ms,
        ).toISOString()
      : null;
  return {
    job_id: opts.job_id,
    tenant_id: 'BIL',
    report_id: opts.report_id ?? 'portfolio_snapshot_daily',
    format: opts.format ?? 'json',
    status,
    requested_at,
    completed_at,
    requested_by: opts.requested_by ?? 'admin',
    parameters: {},
    download_url: status === 'completed' ? `/v1/reports/jobs/${opts.job_id}/download` : null,
    error_message: opts.error_message ?? null,
  };
}

// ─── enum + helper invariants ───────────────────────────────────────

describe('M12.19 — canonical enum + helper', () => {
  test('ALL_REPORT_JOB_PROCESSING_TIME_BUCKETS has 7 values in canonical order', () => {
    expect([...ALL_REPORT_JOB_PROCESSING_TIME_BUCKETS]).toEqual([
      'under_1s',
      '1_to_5s',
      '5_to_30s',
      '30s_to_5m',
      '5m_plus',
      'failed',
      'in_flight',
    ]);
  });

  test('SAMPLE_JOBS_CAP is 3', () => {
    expect(SAMPLE_JOBS_CAP).toBe(3);
  });

  test('bucketForProcessingMs canonical mapping', () => {
    expect(bucketForProcessingMs(0)).toBe('under_1s');
    expect(bucketForProcessingMs(500)).toBe('under_1s');
    expect(bucketForProcessingMs(SECOND_MS)).toBe('1_to_5s');
    expect(bucketForProcessingMs(3 * SECOND_MS)).toBe('1_to_5s');
    expect(bucketForProcessingMs(5 * SECOND_MS)).toBe('5_to_30s');
    expect(bucketForProcessingMs(15 * SECOND_MS)).toBe('5_to_30s');
    expect(bucketForProcessingMs(30 * SECOND_MS)).toBe('30s_to_5m');
    expect(bucketForProcessingMs(2 * MINUTE_MS)).toBe('30s_to_5m');
    expect(bucketForProcessingMs(5 * MINUTE_MS)).toBe('5m_plus');
    expect(bucketForProcessingMs(30 * MINUTE_MS)).toBe('5m_plus');
  });

  test('bucketForProcessingMs defensive rejects', () => {
    expect(bucketForProcessingMs(-1)).toBeNull();
    expect(bucketForProcessingMs(NaN)).toBeNull();
    expect(bucketForProcessingMs(Infinity)).toBeNull();
  });

  test('boundary semantics — strict-< upper bound', () => {
    expect(bucketForProcessingMs(SECOND_MS - 1)).toBe('under_1s');
    expect(bucketForProcessingMs(SECOND_MS)).toBe('1_to_5s');
    expect(bucketForProcessingMs(5 * SECOND_MS - 1)).toBe('1_to_5s');
    expect(bucketForProcessingMs(5 * SECOND_MS)).toBe('5_to_30s');
    expect(bucketForProcessingMs(30 * SECOND_MS - 1)).toBe('5_to_30s');
    expect(bucketForProcessingMs(30 * SECOND_MS)).toBe('30s_to_5m');
    expect(bucketForProcessingMs(5 * MINUTE_MS - 1)).toBe('30s_to_5m');
    expect(bucketForProcessingMs(5 * MINUTE_MS)).toBe('5m_plus');
  });
});

// ─── empty input ────────────────────────────────────────────────────

describe('M12.19 — empty input', () => {
  test('no jobs → 7 zero buckets + null leaderboards', () => {
    const h = buildReportJobProcessingTimeHistogram('BIL', [], NOW);
    expect(h.tenant_id).toBe('BIL');
    expect(h.generated_at).toBe(NOW.toISOString());
    expect(h.total_jobs).toBe(0);
    expect(h.total_completed).toBe(0);
    expect(h.total_failed).toBe(0);
    expect(h.total_in_flight).toBe(0);
    expect(h.peak_bucket).toBeNull();
    expect(h.peak_count).toBe(0);
    expect(h.mean_duration_ms).toBeNull();
    expect(h.median_duration_ms).toBeNull();
    expect(h.p95_duration_ms).toBeNull();
    expect(h.slowest_job).toBeNull();
    expect(h.newest_failed).toBeNull();
    expect(h.oldest_in_flight).toBeNull();
    expect(h.empty_buckets).toEqual([...ALL_REPORT_JOB_PROCESSING_TIME_BUCKETS]);
    for (const row of h.buckets) {
      expect(row.count).toBe(0);
      expect(row.samples).toEqual([]);
    }
  });

  test('throws on empty tenant_id', () => {
    expect(() => buildReportJobProcessingTimeHistogram('', [], NOW)).toThrow();
    expect(() => buildReportJobProcessingTimeHistogram('   ', [], NOW)).toThrow();
  });
});

// ─── bucket placement ──────────────────────────────────────────────

describe('M12.19 — bucket placement', () => {
  test('one job per bucket lands correctly', () => {
    const jobs: ReportJob[] = [
      mkJob({ job_id: 'j-fast', duration_ms: 500 }), // under_1s
      mkJob({ job_id: 'j-1to5', duration_ms: 3 * SECOND_MS }), // 1_to_5s
      mkJob({ job_id: 'j-5to30', duration_ms: 15 * SECOND_MS }), // 5_to_30s
      mkJob({ job_id: 'j-30sto5m', duration_ms: 2 * MINUTE_MS }), // 30s_to_5m
      mkJob({ job_id: 'j-slow', duration_ms: 10 * MINUTE_MS }), // 5m_plus
      mkJob({ job_id: 'j-failed', status: 'failed', error_message: 'boom' }),
      mkJob({ job_id: 'j-queued', status: 'queued' }),
    ];
    const h = buildReportJobProcessingTimeHistogram('BIL', jobs, NOW);
    const findCount = (b: string) => h.buckets.find((r) => r.bucket === b)!.count;
    expect(findCount('under_1s')).toBe(1);
    expect(findCount('1_to_5s')).toBe(1);
    expect(findCount('5_to_30s')).toBe(1);
    expect(findCount('30s_to_5m')).toBe(1);
    expect(findCount('5m_plus')).toBe(1);
    expect(findCount('failed')).toBe(1);
    expect(findCount('in_flight')).toBe(1);
    expect(h.total_jobs).toBe(7);
    expect(h.total_completed).toBe(5);
    expect(h.total_failed).toBe(1);
    expect(h.total_in_flight).toBe(1);
    expect(h.empty_buckets).toEqual([]);
  });

  test('running status counts as in_flight', () => {
    const h = buildReportJobProcessingTimeHistogram(
      'BIL',
      [mkJob({ job_id: 'j-run', status: 'running' })],
      NOW,
    );
    expect(h.total_in_flight).toBe(1);
    expect(h.buckets.find((r) => r.bucket === 'in_flight')!.count).toBe(1);
  });

  test('buckets emitted in canonical order regardless of input', () => {
    const h = buildReportJobProcessingTimeHistogram(
      'BIL',
      [mkJob({ job_id: 'j', duration_ms: 10 * MINUTE_MS })],
      NOW,
    );
    expect(h.buckets.map((r) => r.bucket)).toEqual([
      ...ALL_REPORT_JOB_PROCESSING_TIME_BUCKETS,
    ]);
  });

  test('bucket metadata correct per bucket', () => {
    const h = buildReportJobProcessingTimeHistogram('BIL', [], NOW);
    const under = h.buckets.find((r) => r.bucket === 'under_1s')!;
    expect(under).toMatchObject({ min_ms: 0, max_ms: SECOND_MS, label: '< 1 second' });
    const five = h.buckets.find((r) => r.bucket === '5m_plus')!;
    expect(five).toMatchObject({ min_ms: 5 * MINUTE_MS, max_ms: null });
    const failed = h.buckets.find((r) => r.bucket === 'failed')!;
    expect(failed).toMatchObject({ min_ms: null, max_ms: null });
    const inflight = h.buckets.find((r) => r.bucket === 'in_flight')!;
    expect(inflight).toMatchObject({ min_ms: null, max_ms: null });
  });
});

// ─── sample sort + cap ─────────────────────────────────────────────

describe('M12.19 — sample sort + cap', () => {
  test('completion bucket: samples sorted by duration desc + job_id asc tie-break, cap 3', () => {
    // 5 jobs in 1_to_5s bucket
    const jobs = [
      mkJob({ job_id: 'j-a', duration_ms: 2 * SECOND_MS }),
      mkJob({ job_id: 'j-b', duration_ms: 4 * SECOND_MS }),
      mkJob({ job_id: 'j-c', duration_ms: 3 * SECOND_MS }),
      mkJob({ job_id: 'j-d', duration_ms: 4 * SECOND_MS }), // tied with j-b
      mkJob({ job_id: 'j-e', duration_ms: SECOND_MS }),
    ];
    const h = buildReportJobProcessingTimeHistogram('BIL', jobs, NOW);
    const one5 = h.buckets.find((r) => r.bucket === '1_to_5s')!;
    expect(one5.count).toBe(5);
    expect(one5.samples).toHaveLength(3);
    // Top 3 by duration desc, tie-break job_id asc: 4s/j-b, 4s/j-d, 3s/j-c
    expect(one5.samples[0]!.duration_ms).toBe(4 * SECOND_MS);
    expect(one5.samples[0]!.job_id).toBe('j-b');
    expect(one5.samples[1]!.duration_ms).toBe(4 * SECOND_MS);
    expect(one5.samples[1]!.job_id).toBe('j-d');
    expect(one5.samples[2]!.duration_ms).toBe(3 * SECOND_MS);
    expect(one5.samples[2]!.job_id).toBe('j-c');
  });

  test('failed bucket: samples sorted by requested_at desc (newest first), cap 3', () => {
    const jobs = [
      mkJob({ job_id: 'f-old', status: 'failed', requested_at_offset_ms: 100 * 60 * 1000 }),
      mkJob({ job_id: 'f-new', status: 'failed', requested_at_offset_ms: 10 * 60 * 1000 }),
      mkJob({ job_id: 'f-mid', status: 'failed', requested_at_offset_ms: 50 * 60 * 1000 }),
      mkJob({ job_id: 'f-vold', status: 'failed', requested_at_offset_ms: 200 * 60 * 1000 }),
    ];
    const h = buildReportJobProcessingTimeHistogram('BIL', jobs, NOW);
    const failed = h.buckets.find((r) => r.bucket === 'failed')!;
    expect(failed.count).toBe(4);
    expect(failed.samples).toHaveLength(3);
    // Newest-first: 10min ago > 50min ago > 100min ago > 200min ago (truncated)
    expect(failed.samples[0]!.job_id).toBe('f-new');
    expect(failed.samples[1]!.job_id).toBe('f-mid');
    expect(failed.samples[2]!.job_id).toBe('f-old');
    // duration_ms null for failed samples
    expect(failed.samples[0]!.duration_ms).toBeNull();
  });

  test('in_flight bucket: samples sorted by requested_at asc (oldest first), cap 3', () => {
    const jobs = [
      mkJob({ job_id: 'q-new', status: 'queued', requested_at_offset_ms: 5 * 60 * 1000 }),
      mkJob({ job_id: 'q-old', status: 'queued', requested_at_offset_ms: 100 * 60 * 1000 }),
      mkJob({ job_id: 'q-mid', status: 'queued', requested_at_offset_ms: 30 * 60 * 1000 }),
      mkJob({ job_id: 'q-newest', status: 'queued', requested_at_offset_ms: 60 * 1000 }),
    ];
    const h = buildReportJobProcessingTimeHistogram('BIL', jobs, NOW);
    const inflight = h.buckets.find((r) => r.bucket === 'in_flight')!;
    expect(inflight.count).toBe(4);
    expect(inflight.samples).toHaveLength(3);
    // Oldest-first: 100min > 30min > 5min > 1min (truncated)
    expect(inflight.samples[0]!.job_id).toBe('q-old');
    expect(inflight.samples[1]!.job_id).toBe('q-mid');
    expect(inflight.samples[2]!.job_id).toBe('q-new');
  });

  test('sample carries job_id + report_id + format + status + timestamps + duration', () => {
    const jobs = [
      mkJob({
        job_id: 'j-1',
        report_id: 'rbi_quarterly_summary',
        format: 'pdf',
        duration_ms: 2 * SECOND_MS,
        requested_by: 'alice',
      }),
    ];
    const h = buildReportJobProcessingTimeHistogram('BIL', jobs, NOW);
    const one5 = h.buckets.find((r) => r.bucket === '1_to_5s')!;
    expect(one5.samples[0]).toMatchObject({
      job_id: 'j-1',
      report_id: 'rbi_quarterly_summary',
      format: 'pdf',
      status: 'completed',
      requested_by: 'alice',
      duration_ms: 2 * SECOND_MS,
    });
    expect(one5.samples[0]!.completed_at).toBeDefined();
  });
});

// ─── partition invariants ──────────────────────────────────────────

describe('M12.19 — partition invariants', () => {
  test('Σ buckets.count = total_jobs', () => {
    const jobs = [
      mkJob({ job_id: 'a', duration_ms: 500 }),
      mkJob({ job_id: 'b', duration_ms: 2 * SECOND_MS }),
      mkJob({ job_id: 'c', status: 'failed' }),
      mkJob({ job_id: 'd', status: 'queued' }),
    ];
    const h = buildReportJobProcessingTimeHistogram('BIL', jobs, NOW);
    const sum = h.buckets.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(h.total_jobs);
  });

  test('total_completed + total_failed + total_in_flight = total_jobs', () => {
    const jobs = [
      mkJob({ job_id: 'a', duration_ms: 500 }),
      mkJob({ job_id: 'b', duration_ms: 2 * SECOND_MS }),
      mkJob({ job_id: 'c', status: 'failed' }),
      mkJob({ job_id: 'd', status: 'queued' }),
      mkJob({ job_id: 'e', status: 'running' }),
    ];
    const h = buildReportJobProcessingTimeHistogram('BIL', jobs, NOW);
    expect(h.total_completed).toBe(2);
    expect(h.total_failed).toBe(1);
    expect(h.total_in_flight).toBe(2);
    expect(h.total_completed + h.total_failed + h.total_in_flight).toBe(h.total_jobs);
  });

  test('aggregate stats over completed only (failed + in_flight excluded)', () => {
    const jobs = [
      mkJob({ job_id: 'c1', duration_ms: SECOND_MS }), // 1s
      mkJob({ job_id: 'c2', duration_ms: 3 * SECOND_MS }), // 3s
      mkJob({ job_id: 'c3', duration_ms: 5 * SECOND_MS }), // 5s
      mkJob({ job_id: 'f1', status: 'failed' }),
      mkJob({ job_id: 'q1', status: 'queued' }),
    ];
    const h = buildReportJobProcessingTimeHistogram('BIL', jobs, NOW);
    expect(h.mean_duration_ms).toBe(3 * SECOND_MS);
    expect(h.median_duration_ms).toBe(3 * SECOND_MS);
    expect(h.p95_duration_ms).toBeGreaterThan(3 * SECOND_MS);
    expect(h.p95_duration_ms).toBeLessThanOrEqual(5 * SECOND_MS);
  });

  test('aggregate stats null when no completed', () => {
    const jobs = [
      mkJob({ job_id: 'f1', status: 'failed' }),
      mkJob({ job_id: 'q1', status: 'queued' }),
    ];
    const h = buildReportJobProcessingTimeHistogram('BIL', jobs, NOW);
    expect(h.mean_duration_ms).toBeNull();
    expect(h.median_duration_ms).toBeNull();
    expect(h.p95_duration_ms).toBeNull();
  });
});

// ─── peak_bucket ───────────────────────────────────────────────────

describe('M12.19 — peak_bucket', () => {
  test('peak_bucket = bucket with most jobs', () => {
    const jobs = [
      mkJob({ job_id: 'a', duration_ms: 500 }),
      mkJob({ job_id: 'b', duration_ms: 500 }),
      mkJob({ job_id: 'c', duration_ms: 500 }),
      mkJob({ job_id: 'd', duration_ms: 10 * MINUTE_MS }),
    ];
    const h = buildReportJobProcessingTimeHistogram('BIL', jobs, NOW);
    expect(h.peak_bucket).toBe('under_1s');
    expect(h.peak_count).toBe(3);
  });

  test('canonical iteration tie-break — under_1s beats 1_to_5s at tied 1', () => {
    const jobs = [
      mkJob({ job_id: 'fast', duration_ms: 500 }),
      mkJob({ job_id: 'mid', duration_ms: 2 * SECOND_MS }),
    ];
    const h = buildReportJobProcessingTimeHistogram('BIL', jobs, NOW);
    expect(h.peak_bucket).toBe('under_1s');
    expect(h.peak_count).toBe(1);
  });

  test('peak_bucket null when all 0', () => {
    const h = buildReportJobProcessingTimeHistogram('BIL', [], NOW);
    expect(h.peak_bucket).toBeNull();
    expect(h.peak_count).toBe(0);
  });
});

// ─── leaderboards ──────────────────────────────────────────────────

describe('M12.19 — leaderboards', () => {
  test('slowest_job = highest duration_ms among completed', () => {
    const jobs = [
      mkJob({ job_id: 'short', duration_ms: SECOND_MS }),
      mkJob({ job_id: 'long', duration_ms: 10 * MINUTE_MS }),
      mkJob({ job_id: 'mid', duration_ms: 30 * SECOND_MS }),
    ];
    const h = buildReportJobProcessingTimeHistogram('BIL', jobs, NOW);
    expect(h.slowest_job!.job_id).toBe('long');
    expect(h.slowest_job!.duration_ms).toBe(10 * MINUTE_MS);
  });

  test('newest_failed = most recent requested_at among failed', () => {
    const jobs = [
      mkJob({ job_id: 'f-old', status: 'failed', requested_at_offset_ms: 100 * 60 * 1000 }),
      mkJob({ job_id: 'f-new', status: 'failed', requested_at_offset_ms: 5 * 60 * 1000 }),
    ];
    const h = buildReportJobProcessingTimeHistogram('BIL', jobs, NOW);
    expect(h.newest_failed!.job_id).toBe('f-new');
  });

  test('oldest_in_flight = earliest requested_at among in-flight', () => {
    const jobs = [
      mkJob({ job_id: 'q-new', status: 'queued', requested_at_offset_ms: 5 * 60 * 1000 }),
      mkJob({ job_id: 'q-old', status: 'queued', requested_at_offset_ms: 200 * 60 * 1000 }),
    ];
    const h = buildReportJobProcessingTimeHistogram('BIL', jobs, NOW);
    expect(h.oldest_in_flight!.job_id).toBe('q-old');
  });

  test('all leaderboards null when relevant bucket empty', () => {
    const jobs = [mkJob({ job_id: 'c1', duration_ms: SECOND_MS })];
    const h = buildReportJobProcessingTimeHistogram('BIL', jobs, NOW);
    expect(h.slowest_job).not.toBeNull();
    expect(h.newest_failed).toBeNull();
    expect(h.oldest_in_flight).toBeNull();
  });
});

// ─── empty_buckets ─────────────────────────────────────────────────

describe('M12.19 — empty_buckets', () => {
  test('every empty bucket appears in canonical order', () => {
    const jobs = [mkJob({ job_id: 'j', duration_ms: 2 * SECOND_MS })];
    const h = buildReportJobProcessingTimeHistogram('BIL', jobs, NOW);
    expect(h.empty_buckets).toEqual([
      'under_1s',
      '5_to_30s',
      '30s_to_5m',
      '5m_plus',
      'failed',
      'in_flight',
    ]);
  });
});

// ─── store adapter ─────────────────────────────────────────────────

describe('M12.19 — buildReportJobProcessingTimeHistogramFromStore', () => {
  test('drains via store.list(tenant) with tenant scoping', () => {
    const store = new InMemoryReportJobStore();
    store.submit(
      'BIL',
      { report_id: 'portfolio_snapshot_daily', format: 'json' },
      'admin',
      NOW,
    );
    store.submit(
      'BIL',
      { report_id: 'alerts_activity_weekly', format: 'json' },
      'admin',
      NOW,
    );
    const bilHist = buildReportJobProcessingTimeHistogramFromStore(store, 'BIL', NOW);
    const bankHist = buildReportJobProcessingTimeHistogramFromStore(store, 'BANK_DEMO', NOW);
    expect(bilHist.total_jobs).toBe(2);
    // InMemoryReportJobStore sets completed_at = requested_at so duration=0
    expect(bilHist.total_completed).toBe(2);
    expect(bilHist.buckets.find((r) => r.bucket === 'under_1s')!.count).toBe(2);
    expect(bankHist.total_jobs).toBe(0);
  });
});

// ─── HTTP route ─────────────────────────────────────────────────────

function makeHistApp(role = 'admin') {
  const reportJobStore = new InMemoryReportJobStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    reportJobStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, reportJobStore };
}

describe('M12.19 — GET /v1/reports/jobs/processing-time-histogram', () => {
  test('admin → 200 with envelope shape (empty store)', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app)
      .get('/v1/reports/jobs/processing-time-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.total_jobs).toBe(0);
    expect(r.body.body.buckets).toHaveLength(7);
    expect(r.body.body.peak_bucket).toBeNull();
  });

  test('populated → reflects 2 completed jobs in under_1s', async () => {
    const { app, reportJobStore } = makeHistApp('admin');
    reportJobStore.submit(
      'BIL',
      { report_id: 'portfolio_snapshot_daily', format: 'json' },
      'admin',
      NOW,
    );
    reportJobStore.submit(
      'BIL',
      { report_id: 'alerts_activity_weekly', format: 'json' },
      'admin',
      NOW,
    );
    const r = await request(app)
      .get('/v1/reports/jobs/processing-time-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_jobs).toBe(2);
    expect(r.body.body.peak_bucket).toBe('under_1s');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeHistApp('case_owner');
    const r = await request(app)
      .get('/v1/reports/jobs/processing-time-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL jobs invisible to BANK_DEMO via HTTP', async () => {
    const { app, reportJobStore } = makeHistApp('admin');
    reportJobStore.submit(
      'BIL',
      { report_id: 'portfolio_snapshot_daily', format: 'json' },
      'admin',
      NOW,
    );
    const bank = await request(app)
      .get('/v1/reports/jobs/processing-time-histogram')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_jobs).toBe(0);
  });

  test('400 when no tenant header', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app).get('/v1/reports/jobs/processing-time-histogram');
    expect(r.status).toBe(400);
  });

  test('literal /processing-time-histogram not captured by /:job_id wildcard', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app)
      .get('/v1/reports/jobs/processing-time-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    // Envelope shape (body.body.buckets is 7-element array)
    expect(Array.isArray(r.body.body.buckets)).toBe(true);
    expect(r.body.body.buckets).toHaveLength(7);
  });

  test('M12.18 /hourly-volume sibling still works', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app)
      .get('/v1/reports/jobs/hourly-volume')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
