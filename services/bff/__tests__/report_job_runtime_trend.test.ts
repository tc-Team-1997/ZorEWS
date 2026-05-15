// services/bff/__tests__/report_job_runtime_trend.test.ts
//
// T6 M12.10 — Report job runtime trend per report_id.

import request from 'supertest';
import { buildReportRuntimeTrend } from '../src/report_job_runtime_trend';
import {
  InMemoryReportJobStore,
  type ReportJob,
  type ReportJobStore,
  type ReportJobPage,
  type ReportJobFilters,
} from '../src/reports_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// Fake store lets us inject deterministic job sequences without
// constructing them through the real submit() pipeline.
class FakeJobStore implements ReportJobStore {
  constructor(private readonly jobs: ReportJob[]) {}
  list(tenant_id: string, filters: ReportJobFilters): ReportJobPage {
    let filtered = this.jobs.filter((j) => j.tenant_id === tenant_id);
    if (filters.status) filtered = filtered.filter((j) => j.status === filters.status);
    if (filters.report_id) filtered = filtered.filter((j) => j.report_id === filters.report_id);
    const total = filtered.length;
    const page = filters.page ?? 1;
    const page_size = filters.page_size ?? 50;
    const items = filtered.slice((page - 1) * page_size, page * page_size);
    return { items, page, page_size, total };
  }
  submit(): ReportJob {
    throw new Error('not implemented in FakeJobStore');
  }
  get(): ReportJob | null {
    return null;
  }
  markFailed(): ReportJob {
    throw new Error('not implemented in FakeJobStore');
  }
}

function job(overrides: Partial<ReportJob>): ReportJob {
  return {
    job_id: 'j-1',
    tenant_id: 'BIL',
    report_id: 'portfolio_snapshot_daily',
    format: 'pdf',
    status: 'completed',
    requested_at: NOW.toISOString(),
    completed_at: NOW.toISOString(),
    requested_by: 'alice',
    parameters: {},
    download_url: '/v1/reports/portfolio_snapshot_daily?format=pdf',
    error_message: null,
    ...overrides,
  };
}

function jobAt(report_id: string, completed_at: Date, processing_ms: number): ReportJob {
  return job({
    job_id: `j-${completed_at.getTime()}-${report_id}`,
    report_id,
    status: 'completed',
    requested_at: new Date(completed_at.getTime() - processing_ms).toISOString(),
    completed_at: completed_at.toISOString(),
  });
}

// ─── buildReportRuntimeTrend — pure ──────────────────────────────────

describe('M12.10 — empty store', () => {
  test('zero jobs → empty rollup', () => {
    const s = buildReportRuntimeTrend(new FakeJobStore([]), 'BIL', NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_completed_jobs).toBe(0);
    expect(s.total_report_types).toBe(0);
    expect(s.report_trends).toEqual([]);
    expect(s.biggest_regression_report_id).toBeNull();
    expect(s.biggest_improvement_report_id).toBeNull();
  });
});

describe('M12.10 — single report, single job', () => {
  test('sample_size=1, slope=null, abs_change_ms=null', () => {
    const jobs = [jobAt('rep_a', new Date('2026-05-01T00:00:00Z'), 1000)];
    const s = buildReportRuntimeTrend(new FakeJobStore(jobs), 'BIL', NOW);
    expect(s.total_completed_jobs).toBe(1);
    expect(s.total_report_types).toBe(1);
    const row = s.report_trends[0]!;
    expect(row.report_id).toBe('rep_a');
    expect(row.sample_size).toBe(1);
    expect(row.mean_processing_ms).toBe(1000);
    expect(row.first_processing_ms).toBe(1000);
    expect(row.last_processing_ms).toBe(1000);
    expect(row.abs_change_ms).toBeNull();
    expect(row.slope_ms_per_day).toBeNull();
  });
});

describe('M12.10 — two-point trend', () => {
  test('linearly-rising runtime → positive slope', () => {
    // Job at day 0: 1000ms; job at day 10: 2000ms → slope = 100 ms/day
    const jobs = [
      jobAt('rep_a', new Date('2026-05-01T00:00:00Z'), 1000),
      jobAt('rep_a', new Date('2026-05-11T00:00:00Z'), 2000),
    ];
    const s = buildReportRuntimeTrend(new FakeJobStore(jobs), 'BIL', NOW);
    const row = s.report_trends[0]!;
    expect(row.sample_size).toBe(2);
    expect(row.abs_change_ms).toBe(1000);
    expect(row.slope_ms_per_day).toBeCloseTo(100, 5);
  });

  test('linearly-falling runtime → negative slope', () => {
    const jobs = [
      jobAt('rep_a', new Date('2026-05-01T00:00:00Z'), 2000),
      jobAt('rep_a', new Date('2026-05-11T00:00:00Z'), 1000),
    ];
    const s = buildReportRuntimeTrend(new FakeJobStore(jobs), 'BIL', NOW);
    const row = s.report_trends[0]!;
    expect(row.abs_change_ms).toBe(-1000);
    expect(row.slope_ms_per_day).toBeCloseTo(-100, 5);
  });
});

describe('M12.10 — same-timestamp samples', () => {
  test('slope is null when every completed_at is identical', () => {
    const sameTs = new Date('2026-05-01T00:00:00Z');
    const jobs = [
      jobAt('rep_a', sameTs, 1000),
      jobAt('rep_a', sameTs, 2000),
    ];
    const s = buildReportRuntimeTrend(new FakeJobStore(jobs), 'BIL', NOW);
    const row = s.report_trends[0]!;
    expect(row.sample_size).toBe(2);
    expect(row.slope_ms_per_day).toBeNull();
  });
});

describe('M12.10 — first/last ordering', () => {
  test('first = oldest, last = newest by completed_at', () => {
    const jobs = [
      // Inserted in newest-first order; resolver should re-sort.
      jobAt('rep_a', new Date('2026-05-11T00:00:00Z'), 3000),
      jobAt('rep_a', new Date('2026-05-01T00:00:00Z'), 1000),
      jobAt('rep_a', new Date('2026-05-06T00:00:00Z'), 2000),
    ];
    const s = buildReportRuntimeTrend(new FakeJobStore(jobs), 'BIL', NOW);
    const row = s.report_trends[0]!;
    expect(row.first_completed_at).toBe('2026-05-01T00:00:00.000Z');
    expect(row.last_completed_at).toBe('2026-05-11T00:00:00.000Z');
    expect(row.first_processing_ms).toBe(1000);
    expect(row.last_processing_ms).toBe(3000);
    expect(row.mean_processing_ms).toBeCloseTo(2000);
  });
});

describe('M12.10 — multi-report sort', () => {
  test('rows sorted by |slope| desc with sample_size + report_id tie-breaks', () => {
    const big = [
      // rep_big: +200 ms/day slope
      jobAt('rep_big', new Date('2026-05-01T00:00:00Z'), 1000),
      jobAt('rep_big', new Date('2026-05-11T00:00:00Z'), 3000),
    ];
    const small = [
      // rep_small: +20 ms/day slope
      jobAt('rep_small', new Date('2026-05-01T00:00:00Z'), 1000),
      jobAt('rep_small', new Date('2026-05-11T00:00:00Z'), 1200),
    ];
    const s = buildReportRuntimeTrend(new FakeJobStore([...big, ...small]), 'BIL', NOW);
    expect(s.report_trends[0]!.report_id).toBe('rep_big');
    expect(s.report_trends[1]!.report_id).toBe('rep_small');
  });

  test('null-slope rows sort after slope-having rows', () => {
    const single = [jobAt('rep_single', new Date('2026-05-01T00:00:00Z'), 1000)];
    const pair = [
      jobAt('rep_pair', new Date('2026-05-01T00:00:00Z'), 1000),
      jobAt('rep_pair', new Date('2026-05-11T00:00:00Z'), 1500),
    ];
    const s = buildReportRuntimeTrend(new FakeJobStore([...single, ...pair]), 'BIL', NOW);
    expect(s.report_trends[0]!.report_id).toBe('rep_pair');
    expect(s.report_trends[1]!.report_id).toBe('rep_single');
  });
});

describe('M12.10 — biggest_regression / biggest_improvement', () => {
  test('regression points at most-positive slope', () => {
    const jobs = [
      // rep_up: +200 ms/day
      jobAt('rep_up', new Date('2026-05-01T00:00:00Z'), 1000),
      jobAt('rep_up', new Date('2026-05-11T00:00:00Z'), 3000),
      // rep_down: -100 ms/day
      jobAt('rep_down', new Date('2026-05-01T00:00:00Z'), 2000),
      jobAt('rep_down', new Date('2026-05-11T00:00:00Z'), 1000),
    ];
    const s = buildReportRuntimeTrend(new FakeJobStore(jobs), 'BIL', NOW);
    expect(s.biggest_regression_report_id).toBe('rep_up');
    expect(s.biggest_improvement_report_id).toBe('rep_down');
  });

  test('null when no slopes exceed 0', () => {
    // Same-timestamp samples → slope null
    const sameTs = new Date('2026-05-01T00:00:00Z');
    const jobs = [jobAt('rep_a', sameTs, 1000), jobAt('rep_a', sameTs, 2000)];
    const s = buildReportRuntimeTrend(new FakeJobStore(jobs), 'BIL', NOW);
    expect(s.biggest_regression_report_id).toBeNull();
    expect(s.biggest_improvement_report_id).toBeNull();
  });
});

describe('M12.10 — cross-tenant isolation', () => {
  test('BIL jobs invisible to BANK_DEMO', () => {
    const jobs = [
      jobAt('rep_a', new Date('2026-05-01T00:00:00Z'), 1000),
      jobAt('rep_a', new Date('2026-05-11T00:00:00Z'), 2000),
    ];
    const bank = buildReportRuntimeTrend(new FakeJobStore(jobs), 'BANK_DEMO', NOW);
    expect(bank.total_completed_jobs).toBe(0);
    expect(bank.total_report_types).toBe(0);
  });
});

describe('M12.10 — completed-only filter', () => {
  test('non-completed jobs excluded', () => {
    const completed = jobAt('rep_a', new Date('2026-05-01T00:00:00Z'), 1000);
    const queued = job({
      job_id: 'q-1',
      report_id: 'rep_a',
      status: 'queued',
      completed_at: null,
    });
    const failed = job({
      job_id: 'f-1',
      report_id: 'rep_a',
      status: 'failed',
      completed_at: NOW.toISOString(),
    });
    const s = buildReportRuntimeTrend(
      new FakeJobStore([completed, queued, failed]),
      'BIL',
      NOW,
    );
    expect(s.total_completed_jobs).toBe(1);
    expect(s.report_trends[0]!.sample_size).toBe(1);
  });
});

describe('M12.10 — mean_processing_ms', () => {
  test('aggregate arithmetic correct', () => {
    const jobs = [
      jobAt('rep_a', new Date('2026-05-01T00:00:00Z'), 1000),
      jobAt('rep_a', new Date('2026-05-05T00:00:00Z'), 2000),
      jobAt('rep_a', new Date('2026-05-10T00:00:00Z'), 3000),
    ];
    const s = buildReportRuntimeTrend(new FakeJobStore(jobs), 'BIL', NOW);
    expect(s.report_trends[0]!.mean_processing_ms).toBeCloseTo(2000);
  });
});

// ─── GET /v1/reports/jobs/runtime-trend ──────────────────────────────

function makeTrendApp(role = 'admin') {
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

describe('M12.10 — GET /v1/reports/jobs/runtime-trend', () => {
  test('admin → 200 with empty rollup', async () => {
    const { app } = makeTrendApp('admin');
    const r = await request(app).get('/v1/reports/jobs/runtime-trend').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_completed_jobs).toBe(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTrendApp('case_owner');
    const r = await request(app).get('/v1/reports/jobs/runtime-trend').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M12.5 /v1/reports/jobs/analytics still works (sibling)', async () => {
    const { app } = makeTrendApp('admin');
    const r = await request(app).get('/v1/reports/jobs/analytics').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
