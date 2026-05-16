// services/bff/__tests__/report_format_distribution.test.ts
//
// T6 M12.11 — Report job format distribution.

import request from 'supertest';
import {
  buildReportFormatDistribution,
  ALL_REPORT_FORMATS,
} from '../src/report_format_distribution';
import {
  InMemoryReportJobStore,
  type JobStatus,
  type ReportFormat,
  type ReportJob,
  type ReportJobFilters,
  type ReportJobPage,
  type ReportJobStore,
} from '../src/reports_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeFmtApp(role: string = 'admin', reportJobStore?: ReportJobStore) {
  const store = reportJobStore ?? new InMemoryReportJobStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    reportJobStore: store,
  });
  return { ...built, store };
}

/**
 * Inline mock store that returns pre-built jobs verbatim — used when the
 * test needs to control processing_ms (the real InMemoryReportJobStore
 * sets completed_at = requested_at on submit so every job has ms=0).
 */
class MockJobStore implements ReportJobStore {
  constructor(private readonly byTenant: Record<string, ReportJob[]>) {}
  submit(): ReportJob { throw new Error('not used'); }
  list(tenant_id: string, filters?: ReportJobFilters): ReportJobPage {
    const all = this.byTenant[tenant_id] ?? [];
    const page = filters?.page ?? 1;
    const page_size = filters?.page_size ?? 20;
    const start = (page - 1) * page_size;
    return {
      items: all.slice(start, start + page_size),
      total: all.length,
      page,
      page_size,
    };
  }
  get(tenant_id: string, job_id: string): ReportJob | null {
    return (this.byTenant[tenant_id] ?? []).find((j) => j.job_id === job_id) ?? null;
  }
  markFailed(): ReportJob { throw new Error('not used'); }
}

function makeJob(overrides: Partial<ReportJob> = {}): ReportJob {
  return {
    job_id: `rj-${Math.random().toString(36).slice(2, 10)}`,
    tenant_id: 'BIL',
    report_id: 'portfolio_snapshot_daily',
    format: 'json',
    status: 'completed',
    requested_at: '2026-05-16T11:00:00.000Z',
    completed_at: '2026-05-16T11:00:00.000Z',
    requested_by: 'alice',
    parameters: {},
    download_url: '/v1/reports/jobs/rj-x/download',
    error_message: null,
    ...overrides,
  };
}

// ─── buildReportFormatDistribution — pure ────────────────────────────

describe('M12.11 — empty store', () => {
  test('zero jobs → every format key emitted at 0', () => {
    const store = new InMemoryReportJobStore();
    const s = buildReportFormatDistribution(store, 'BIL', NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_jobs).toBe(0);
    expect(s.formats.map((f) => f.format)).toEqual([...ALL_REPORT_FORMATS]);
    for (const row of s.formats) {
      expect(row.total_count).toBe(0);
      expect(row.success_rate).toBeNull();
      expect(row.mean_processing_ms).toBeNull();
      expect(row.most_recent_at).toBeNull();
      expect(row.by_report_id_top).toEqual([]);
      expect(row.distinct_reports).toBe(0);
      // Every JobStatus key present at 0.
      expect(row.by_status.queued).toBe(0);
      expect(row.by_status.running).toBe(0);
      expect(row.by_status.completed).toBe(0);
      expect(row.by_status.failed).toBe(0);
    }
    expect(s.most_common_format).toBeNull();
    expect(s.unused_formats).toEqual([...ALL_REPORT_FORMATS]);
  });
});

describe('M12.11 — canonical format order', () => {
  test('formats[] order is json → csv → pdf → xlsx even when zero-count', () => {
    const s = buildReportFormatDistribution(new InMemoryReportJobStore(), 'BIL', NOW);
    expect(s.formats.map((f) => f.format)).toEqual(['json', 'csv', 'pdf', 'xlsx']);
  });
});

describe('M12.11 — single-format placement', () => {
  test('one csv completed job → only csv row populated', () => {
    const store = new InMemoryReportJobStore();
    store.submit(
      'BIL',
      { report_id: 'portfolio_snapshot_daily', format: 'csv' },
      'alice',
      NOW,
    );
    const s = buildReportFormatDistribution(store, 'BIL', NOW);
    expect(s.total_jobs).toBe(1);
    const csv = s.formats.find((f) => f.format === 'csv')!;
    expect(csv.total_count).toBe(1);
    expect(csv.by_status.completed).toBe(1);
    expect(csv.distinct_reports).toBe(1);
    const json = s.formats.find((f) => f.format === 'json')!;
    expect(json.total_count).toBe(0);
  });
});

describe('M12.11 — by_status accumulation', () => {
  test('mixed-status jobs in same format', () => {
    const jobs: ReportJob[] = [
      makeJob({ format: 'pdf', status: 'completed' }),
      makeJob({ format: 'pdf', status: 'completed' }),
      makeJob({ format: 'pdf', status: 'failed' }),
      makeJob({ format: 'pdf', status: 'queued' }),
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = buildReportFormatDistribution(store, 'BIL', NOW);
    const pdf = s.formats.find((f) => f.format === 'pdf')!;
    expect(pdf.total_count).toBe(4);
    expect(pdf.by_status.completed).toBe(2);
    expect(pdf.by_status.failed).toBe(1);
    expect(pdf.by_status.queued).toBe(1);
    expect(pdf.by_status.running).toBe(0);
  });
});

describe('M12.11 — success_rate', () => {
  test('= completed / (completed + failed); queued + running excluded', () => {
    const jobs: ReportJob[] = [
      makeJob({ format: 'json', status: 'completed' }),
      makeJob({ format: 'json', status: 'completed' }),
      makeJob({ format: 'json', status: 'completed' }),
      makeJob({ format: 'json', status: 'failed' }),
      makeJob({ format: 'json', status: 'queued' }), // excluded from denominator
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = buildReportFormatDistribution(store, 'BIL', NOW);
    const json = s.formats.find((f) => f.format === 'json')!;
    expect(json.success_rate).toBeCloseTo(3 / 4); // 3 completed / (3 completed + 1 failed)
  });

  test('null when no completed and no failed (only queued/running)', () => {
    const jobs: ReportJob[] = [
      makeJob({ format: 'json', status: 'queued' }),
      makeJob({ format: 'json', status: 'running' }),
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = buildReportFormatDistribution(store, 'BIL', NOW);
    const json = s.formats.find((f) => f.format === 'json')!;
    expect(json.success_rate).toBeNull();
  });

  test('null when row has zero jobs', () => {
    const s = buildReportFormatDistribution(new InMemoryReportJobStore(), 'BIL', NOW);
    expect(s.formats.every((f) => f.success_rate === null)).toBe(true);
  });
});

describe('M12.11 — mean_processing_ms over completed jobs only', () => {
  test('averages completed-job durations; failed jobs excluded', () => {
    const jobs: ReportJob[] = [
      // 100ms
      makeJob({
        format: 'pdf', status: 'completed',
        requested_at: '2026-05-16T10:00:00.000Z',
        completed_at: '2026-05-16T10:00:00.100Z',
      }),
      // 300ms
      makeJob({
        format: 'pdf', status: 'completed',
        requested_at: '2026-05-16T10:01:00.000Z',
        completed_at: '2026-05-16T10:01:00.300Z',
      }),
      // failed → not counted
      makeJob({
        format: 'pdf', status: 'failed',
        requested_at: '2026-05-16T10:02:00.000Z',
        completed_at: null,
      }),
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = buildReportFormatDistribution(store, 'BIL', NOW);
    const pdf = s.formats.find((f) => f.format === 'pdf')!;
    expect(pdf.mean_processing_ms).toBe(200); // (100 + 300) / 2
  });

  test('null when no completed jobs', () => {
    const jobs: ReportJob[] = [
      makeJob({ format: 'pdf', status: 'failed', completed_at: null }),
      makeJob({ format: 'pdf', status: 'queued', completed_at: null }),
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = buildReportFormatDistribution(store, 'BIL', NOW);
    const pdf = s.formats.find((f) => f.format === 'pdf')!;
    expect(pdf.mean_processing_ms).toBeNull();
  });
});

describe('M12.11 — most_recent_at across all statuses', () => {
  test('takes the newest requested_at regardless of status', () => {
    const jobs: ReportJob[] = [
      makeJob({ format: 'csv', status: 'completed', requested_at: '2026-05-10T00:00:00.000Z' }),
      makeJob({ format: 'csv', status: 'failed', requested_at: '2026-05-15T00:00:00.000Z' }),
      makeJob({ format: 'csv', status: 'queued', requested_at: '2026-05-12T00:00:00.000Z' }),
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = buildReportFormatDistribution(store, 'BIL', NOW);
    const csv = s.formats.find((f) => f.format === 'csv')!;
    expect(csv.most_recent_at).toBe('2026-05-15T00:00:00.000Z');
  });
});

describe('M12.11 — by_report_id_top', () => {
  test('top 5 by count desc with report_id asc tie-break', () => {
    const jobs: ReportJob[] = [
      ...Array(5).fill(0).map(() => makeJob({ format: 'json', report_id: 'r-most' })),
      ...Array(4).fill(0).map(() => makeJob({ format: 'json', report_id: 'r-second' })),
      ...Array(1).fill(0).map(() => makeJob({ format: 'json', report_id: 'r-a' })),
      ...Array(1).fill(0).map(() => makeJob({ format: 'json', report_id: 'r-b' })),
      ...Array(1).fill(0).map(() => makeJob({ format: 'json', report_id: 'r-c' })),
      ...Array(1).fill(0).map(() => makeJob({ format: 'json', report_id: 'r-d' })),
      ...Array(1).fill(0).map(() => makeJob({ format: 'json', report_id: 'r-e' })),
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = buildReportFormatDistribution(store, 'BIL', NOW);
    const json = s.formats.find((f) => f.format === 'json')!;
    expect(json.by_report_id_top.length).toBe(5);
    expect(json.by_report_id_top[0]).toEqual({ report_id: 'r-most', count: 5 });
    expect(json.by_report_id_top[1]).toEqual({ report_id: 'r-second', count: 4 });
    // r-a..r-e all tied at 1; alphabetical → r-a wins, r-e cut at top-5.
    expect(json.by_report_id_top[2]!.report_id).toBe('r-a');
    expect(json.by_report_id_top[4]!.report_id).toBe('r-c');
  });
});

describe('M12.11 — distinct_reports', () => {
  test('counts distinct report_ids per format', () => {
    const jobs: ReportJob[] = [
      makeJob({ format: 'csv', report_id: 'r1' }),
      makeJob({ format: 'csv', report_id: 'r1' }), // dup
      makeJob({ format: 'csv', report_id: 'r2' }),
      makeJob({ format: 'csv', report_id: 'r3' }),
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = buildReportFormatDistribution(store, 'BIL', NOW);
    const csv = s.formats.find((f) => f.format === 'csv')!;
    expect(csv.distinct_reports).toBe(3);
  });
});

describe('M12.11 — most_common_format', () => {
  test('points at the format with highest total_count', () => {
    const jobs: ReportJob[] = [
      ...Array(3).fill(0).map(() => makeJob({ format: 'pdf' })),
      ...Array(5).fill(0).map(() => makeJob({ format: 'csv' })),
      ...Array(1).fill(0).map(() => makeJob({ format: 'json' })),
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = buildReportFormatDistribution(store, 'BIL', NOW);
    expect(s.most_common_format).toBe('csv');
  });

  test('canonical-order tie-break: json wins over csv at same count', () => {
    const jobs: ReportJob[] = [
      makeJob({ format: 'csv' }),
      makeJob({ format: 'json' }),
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = buildReportFormatDistribution(store, 'BIL', NOW);
    expect(s.most_common_format).toBe('json');
  });

  test('null when no jobs', () => {
    const s = buildReportFormatDistribution(new InMemoryReportJobStore(), 'BIL', NOW);
    expect(s.most_common_format).toBeNull();
  });
});

describe('M12.11 — unused_formats in canonical order', () => {
  test('lists every zero-count format in declared order', () => {
    const jobs: ReportJob[] = [makeJob({ format: 'csv' })];
    const store = new MockJobStore({ BIL: jobs });
    const s = buildReportFormatDistribution(store, 'BIL', NOW);
    expect(s.unused_formats).toEqual(['json', 'pdf', 'xlsx']);
  });

  test('empty when every format has at least one job', () => {
    const jobs: ReportJob[] = ALL_REPORT_FORMATS.map((f: ReportFormat) => makeJob({ format: f }));
    const store = new MockJobStore({ BIL: jobs });
    const s = buildReportFormatDistribution(store, 'BIL', NOW);
    expect(s.unused_formats).toEqual([]);
  });
});

describe('M12.11 — partition invariants', () => {
  test('Σ per-format total_count = total_jobs; Σ by_status per-format = total_count', () => {
    const jobs: ReportJob[] = [
      makeJob({ format: 'json', status: 'completed' }),
      makeJob({ format: 'json', status: 'failed' }),
      makeJob({ format: 'csv', status: 'queued' }),
      makeJob({ format: 'pdf', status: 'completed' }),
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = buildReportFormatDistribution(store, 'BIL', NOW);
    const formatSum = s.formats.reduce((acc, f) => acc + f.total_count, 0);
    expect(formatSum).toBe(s.total_jobs);
    expect(s.total_jobs).toBe(4);
    for (const f of s.formats) {
      const statusSum = Object.values(f.by_status).reduce((a: number, b: number) => a + b, 0);
      expect(statusSum).toBe(f.total_count);
    }
  });
});

describe('M12.11 — tenant scoping', () => {
  test('jobs from other tenants invisible', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [makeJob({ format: 'json' })],
      BANK_DEMO: [
        makeJob({ format: 'csv' }),
        makeJob({ format: 'csv' }),
      ],
    };
    const store = new MockJobStore(jobs);
    const bil = buildReportFormatDistribution(store, 'BIL', NOW);
    const bank = buildReportFormatDistribution(store, 'BANK_DEMO', NOW);
    expect(bil.total_jobs).toBe(1);
    expect(bank.total_jobs).toBe(2);
    expect(bil.most_common_format).toBe('json');
    expect(bank.most_common_format).toBe('csv');
  });
});

// ─── GET /v1/reports/jobs/format-distribution ────────────────────────

describe('M12.11 — GET /v1/reports/jobs/format-distribution', () => {
  test('admin → 200 with empty rollup on fresh tenant', async () => {
    const { app } = makeFmtApp('admin');
    const r = await request(app).get('/v1/reports/jobs/format-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_jobs).toBe(0);
    expect(r.body.body.formats.length).toBe(4);
    expect(r.body.body.most_common_format).toBeNull();
  });

  test('populated rollup reflects submitted jobs', async () => {
    const { app, store } = makeFmtApp('admin');
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'csv' }, 'alice', NOW);
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'csv' }, 'alice', NOW);
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'pdf' }, 'alice', NOW);
    const r = await request(app).get('/v1/reports/jobs/format-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_jobs).toBe(3);
    expect(r.body.body.most_common_format).toBe('csv');
    const csv = r.body.body.formats.find((f: { format: string }) => f.format === 'csv');
    expect(csv.total_count).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeFmtApp('case_owner');
    const r = await request(app).get('/v1/reports/jobs/format-distribution').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL jobs invisible to BANK_DEMO', async () => {
    const { app, store } = makeFmtApp('admin');
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'json' }, 'alice', NOW);
    const bank = await request(app)
      .get('/v1/reports/jobs/format-distribution')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_jobs).toBe(0);
  });

  test('literal `/format-distribution` not captured as :job_id param', async () => {
    const { app } = makeFmtApp('admin');
    // If routing shadowed this, we'd hit /v1/reports/jobs/:job_id which 404s on unknown.
    const r = await request(app).get('/v1/reports/jobs/format-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('M12.10 /v1/reports/jobs/runtime-trend still works (sibling regression)', async () => {
    const { app } = makeFmtApp('admin');
    const r = await request(app).get('/v1/reports/jobs/runtime-trend').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
