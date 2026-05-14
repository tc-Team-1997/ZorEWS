// services/bff/__tests__/report_job_analytics.test.ts
//
// T6 M12.5 — Report job analytics.

import request from 'supertest';
import {
  TOP_REQUESTER_CAP,
  summarizeReportJobs,
} from '../src/report_job_analytics';
import {
  InMemoryReportJobStore,
  type ReportJob,
} from '../src/reports_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

let seq = 0;
function mkJob(o: Partial<ReportJob> & { report_id: string; status: ReportJob['status'] }): ReportJob {
  seq += 1;
  return {
    job_id: o.job_id ?? `rj-${seq}`,
    tenant_id: o.tenant_id ?? 'BIL',
    report_id: o.report_id,
    format: o.format ?? 'json',
    status: o.status,
    requested_at: o.requested_at ?? NOW.toISOString(),
    completed_at: o.completed_at ?? (o.status === 'completed' ? NOW.toISOString() : null),
    requested_by: o.requested_by ?? 'alice',
    parameters: o.parameters ?? {},
    download_url: o.download_url ?? (o.status === 'completed' ? `/v1/reports/jobs/rj-${seq}/download` : null),
    error_message: o.error_message ?? (o.status === 'failed' ? 'something broke' : null),
  };
}

beforeEach(() => {
  seq = 0;
});

// ─── summarizeReportJobs ─────────────────────────────────────────────

describe('M12.5 — summarizeReportJobs — empty + shape', () => {
  test('empty input → zero envelope, null rate fields, all status keys present', () => {
    const a = summarizeReportJobs([]);
    expect(a.sample_size).toBe(0);
    expect(a.by_status).toEqual({ queued: 0, running: 0, completed: 0, failed: 0 });
    expect(a.by_format).toEqual({});
    expect(a.per_report).toEqual([]);
    expect(a.top_requesters).toEqual([]);
    expect(a.success_rate).toBeNull();
    expect(a.last_failure).toBeNull();
    expect(a.processing_ms).toEqual({
      min: null,
      mean: null,
      p50: null,
      p95: null,
      max: null,
    });
  });
});

describe('M12.5 — status + format mix', () => {
  test('by_status counts every status; by_format only present for observed formats', () => {
    const jobs: ReportJob[] = [
      mkJob({ report_id: 'r1', status: 'completed', format: 'json' }),
      mkJob({ report_id: 'r1', status: 'completed', format: 'csv' }),
      mkJob({ report_id: 'r1', status: 'failed', format: 'pdf' }),
      mkJob({ report_id: 'r2', status: 'queued', format: 'json' }),
      mkJob({ report_id: 'r2', status: 'running', format: 'json' }),
    ];
    const a = summarizeReportJobs(jobs);
    expect(a.sample_size).toBe(5);
    expect(a.by_status).toEqual({ queued: 1, running: 1, completed: 2, failed: 1 });
    expect(a.by_format).toEqual({ json: 3, csv: 1, pdf: 1 });
    // xlsx wasn't seen — key absent.
    expect((a.by_format as Record<string, number>).xlsx).toBeUndefined();
  });
});

describe('M12.5 — success_rate', () => {
  test('success_rate denominator = completed + failed (queued/running ignored)', () => {
    const jobs: ReportJob[] = [
      mkJob({ report_id: 'r1', status: 'completed' }),
      mkJob({ report_id: 'r1', status: 'completed' }),
      mkJob({ report_id: 'r1', status: 'failed' }),
      mkJob({ report_id: 'r1', status: 'queued' }),
      mkJob({ report_id: 'r1', status: 'running' }),
    ];
    const a = summarizeReportJobs(jobs);
    // 2 completed / (2 completed + 1 failed) = 0.666…
    expect(a.success_rate).toBeCloseTo(2 / 3, 5);
  });

  test('success_rate null when no terminal jobs', () => {
    const jobs: ReportJob[] = [
      mkJob({ report_id: 'r1', status: 'queued' }),
      mkJob({ report_id: 'r1', status: 'running' }),
    ];
    const a = summarizeReportJobs(jobs);
    expect(a.success_rate).toBeNull();
  });
});

describe('M12.5 — processing_ms percentiles', () => {
  test('p50 across 5 evenly-spaced completed durations equals the middle', () => {
    const t0 = NOW.getTime();
    const jobs: ReportJob[] = [1, 2, 3, 4, 5].map((s, i) =>
      mkJob({
        job_id: `j${i}`,
        report_id: 'r1',
        status: 'completed',
        requested_at: new Date(t0).toISOString(),
        completed_at: new Date(t0 + s * 1000).toISOString(),
      }),
    );
    const a = summarizeReportJobs(jobs);
    expect(a.processing_ms.min).toBe(1000);
    expect(a.processing_ms.p50).toBe(3000);
    expect(a.processing_ms.max).toBe(5000);
    expect(a.processing_ms.mean).toBe(3000);
  });

  test('processing_ms ignores non-completed jobs', () => {
    const t0 = NOW.getTime();
    const jobs: ReportJob[] = [
      mkJob({
        report_id: 'r1',
        status: 'completed',
        requested_at: new Date(t0).toISOString(),
        completed_at: new Date(t0 + 2000).toISOString(),
      }),
      mkJob({
        report_id: 'r1',
        status: 'failed',
        requested_at: new Date(t0).toISOString(),
        completed_at: null,
      }),
      mkJob({
        report_id: 'r1',
        status: 'running',
        requested_at: new Date(t0).toISOString(),
        completed_at: null,
      }),
    ];
    const a = summarizeReportJobs(jobs);
    expect(a.processing_ms.min).toBe(2000);
    expect(a.processing_ms.max).toBe(2000);
    expect(a.processing_ms.mean).toBe(2000);
  });
});

describe('M12.5 — per_report rollup', () => {
  test('per_report tracks counts, success rate, and mean processing per report_id, sorted by job_count desc', () => {
    const t0 = NOW.getTime();
    const jobs: ReportJob[] = [
      // r1: 3 jobs (2 completed at 2s/4s, 1 failed)
      mkJob({
        report_id: 'r1',
        status: 'completed',
        requested_at: new Date(t0).toISOString(),
        completed_at: new Date(t0 + 2000).toISOString(),
      }),
      mkJob({
        report_id: 'r1',
        status: 'completed',
        requested_at: new Date(t0).toISOString(),
        completed_at: new Date(t0 + 4000).toISOString(),
      }),
      mkJob({ report_id: 'r1', status: 'failed' }),
      // r2: 1 job (completed)
      mkJob({
        report_id: 'r2',
        status: 'completed',
        requested_at: new Date(t0).toISOString(),
        completed_at: new Date(t0 + 1000).toISOString(),
      }),
    ];
    const a = summarizeReportJobs(jobs);
    expect(a.per_report.map((p) => p.report_id)).toEqual(['r1', 'r2']);
    const r1 = a.per_report.find((p) => p.report_id === 'r1')!;
    expect(r1.job_count).toBe(3);
    expect(r1.completed_count).toBe(2);
    expect(r1.failed_count).toBe(1);
    expect(r1.success_rate).toBeCloseTo(2 / 3, 5);
    expect(r1.mean_processing_ms).toBe(3000); // (2000+4000)/2
  });

  test('per_report ties broken by report_id asc', () => {
    const jobs: ReportJob[] = [
      mkJob({ report_id: 'zeta', status: 'completed' }),
      mkJob({ report_id: 'alpha', status: 'completed' }),
      mkJob({ report_id: 'mike', status: 'completed' }),
    ];
    const a = summarizeReportJobs(jobs);
    expect(a.per_report.map((p) => p.report_id)).toEqual(['alpha', 'mike', 'zeta']);
  });
});

describe('M12.5 — top_requesters', () => {
  test('top_requesters sorted by job_count desc, ties broken alphabetically, capped at TOP_REQUESTER_CAP', () => {
    const jobs: ReportJob[] = [];
    // 12 distinct requesters, each with i+1 jobs (1..12).
    for (let i = 0; i < 12; i++) {
      for (let k = 0; k <= i; k++) {
        jobs.push(
          mkJob({ report_id: 'r1', status: 'completed', requested_by: `user${String(i).padStart(2, '0')}` }),
        );
      }
    }
    const a = summarizeReportJobs(jobs);
    // 12 requesters > cap 10 → only the top 10 remain.
    expect(a.top_requesters.length).toBe(TOP_REQUESTER_CAP);
    // Top is user11 (12 jobs), then user10 (11 jobs), etc.
    expect(a.top_requesters[0]!).toEqual({ requested_by: 'user11', job_count: 12 });
    expect(a.top_requesters[1]!.requested_by).toBe('user10');
  });
});

describe('M12.5 — last_failure', () => {
  test('last_failure is the newest failed job by requested_at', () => {
    const jobs: ReportJob[] = [
      mkJob({
        job_id: 'old',
        report_id: 'r1',
        status: 'failed',
        requested_at: '2026-05-14T08:00:00.000Z',
        error_message: 'old',
      }),
      mkJob({
        job_id: 'new',
        report_id: 'r1',
        status: 'failed',
        requested_at: '2026-05-14T11:00:00.000Z',
        error_message: 'newer',
      }),
      mkJob({
        job_id: 'completed',
        report_id: 'r1',
        status: 'completed',
        requested_at: '2026-05-14T11:30:00.000Z',
      }),
    ];
    const a = summarizeReportJobs(jobs);
    expect(a.last_failure?.job_id).toBe('new');
    expect(a.last_failure?.error_message).toBe('newer');
  });

  test('last_failure null when no failed jobs', () => {
    const jobs: ReportJob[] = [
      mkJob({ report_id: 'r1', status: 'completed' }),
      mkJob({ report_id: 'r1', status: 'queued' }),
    ];
    const a = summarizeReportJobs(jobs);
    expect(a.last_failure).toBeNull();
  });
});

// ─── GET /v1/reports/jobs/analytics ──────────────────────────────────

function makeAnalyticsApp(role = 'admin', store?: InMemoryReportJobStore) {
  const reportJobStore = store ?? new InMemoryReportJobStore();
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

describe('M12.5 — GET /v1/reports/jobs/analytics', () => {
  test('empty store → 200 with zero envelope', async () => {
    const { app } = makeAnalyticsApp('admin');
    const r = await request(app).get('/v1/reports/jobs/analytics').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.analytics.sample_size).toBe(0);
    expect(r.body.body.analytics.success_rate).toBeNull();
  });

  test('submitted jobs surface in the rollup', async () => {
    const store = new InMemoryReportJobStore();
    store.submit(
      'BIL',
      { report_id: 'portfolio_snapshot_daily', format: 'json' },
      'alice',
      NOW,
    );
    const { app } = makeAnalyticsApp('admin', store);
    const r = await request(app).get('/v1/reports/jobs/analytics').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.analytics.sample_size).toBe(1);
    expect(r.body.body.analytics.by_status.completed).toBe(1);
    expect(r.body.body.analytics.top_requesters[0].requested_by).toBe('alice');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAnalyticsApp('case_owner');
    const r = await request(app).get('/v1/reports/jobs/analytics').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant isolation: BANK_DEMO does not see BIL jobs', async () => {
    const store = new InMemoryReportJobStore();
    store.submit(
      'BIL',
      { report_id: 'portfolio_snapshot_daily', format: 'json' },
      'alice',
      NOW,
    );
    const { app } = makeAnalyticsApp('admin', store);
    const r = await request(app)
      .get('/v1/reports/jobs/analytics')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.analytics.sample_size).toBe(0);
  });
});
