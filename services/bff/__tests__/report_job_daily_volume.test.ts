// services/bff/__tests__/report_job_daily_volume.test.ts
//
// T6 M12.13 — Report job daily volume timeline.

import request from 'supertest';
import {
  summarizeReportJobDailyVolume,
  ReportDailyVolumeError,
} from '../src/report_job_daily_volume';
import {
  InMemoryReportJobStore,
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

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeDvApp(role: string = 'admin', reportJobStore?: ReportJobStore) {
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

/** Mock store that returns pre-built jobs verbatim (lets tests set
 *  explicit requested_at across window). */
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
    requested_at: '2026-05-17T11:00:00.000Z',
    completed_at: '2026-05-17T11:00:01.000Z',
    requested_by: 'alice',
    parameters: {},
    download_url: '/v1/reports/jobs/rj-x/download',
    error_message: null,
    ...overrides,
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

describe('M12.13 — empty store', () => {
  test('zero jobs → every day in window emitted at 0', () => {
    const store = new InMemoryReportJobStore();
    const s = summarizeReportJobDailyVolume(store, 'BIL', 7, NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.days).toBe(7);
    expect(s.by_day.length).toBe(7);
    expect(s.total_jobs_in_window).toBe(0);
    expect(s.total_jobs_observed).toBe(0);
    for (const b of s.by_day) {
      expect(b.total).toBe(0);
      expect(b.by_status.queued).toBe(0);
      expect(b.by_status.completed).toBe(0);
      expect(b.by_format.json).toBe(0);
      expect(b.by_format.csv).toBe(0);
    }
    expect(s.peak_day).toBeNull();
    expect(s.peak_count).toBe(0);
    expect(s.mean_per_day).toBe(0);
    expect(s.busiest_format).toBeNull();
  });
});

describe('M12.13 — window mechanics', () => {
  test('default 30-day window — last bucket is the day of `now`', () => {
    const s = summarizeReportJobDailyVolume(new InMemoryReportJobStore(), 'BIL', 30, NOW);
    expect(s.by_day.length).toBe(30);
    expect(s.window_end).toBe('2026-05-17');
    // 30 days inclusive → first day = May 17 - 29 = Apr 18
    expect(s.window_start).toBe('2026-04-18');
  });

  test('7-day window — buckets cover May 11..17', () => {
    const s = summarizeReportJobDailyVolume(new InMemoryReportJobStore(), 'BIL', 7, NOW);
    expect(s.by_day.map((b) => b.date)).toEqual([
      '2026-05-11',
      '2026-05-12',
      '2026-05-13',
      '2026-05-14',
      '2026-05-15',
      '2026-05-16',
      '2026-05-17',
    ]);
  });

  test('days=1 → single day', () => {
    const s = summarizeReportJobDailyVolume(new InMemoryReportJobStore(), 'BIL', 1, NOW);
    expect(s.by_day.length).toBe(1);
    expect(s.by_day[0]!.date).toBe('2026-05-17');
    expect(s.window_start).toBe('2026-05-17');
    expect(s.window_end).toBe('2026-05-17');
  });
});

describe('M12.13 — single-day placement', () => {
  test('one job lands in its UTC date bucket', () => {
    const store = new MockJobStore({
      BIL: [makeJob({ requested_at: '2026-05-15T10:30:00.000Z', format: 'csv', status: 'completed' })],
    });
    const s = summarizeReportJobDailyVolume(store, 'BIL', 7, NOW);
    const d15 = s.by_day.find((b) => b.date === '2026-05-15')!;
    expect(d15.total).toBe(1);
    expect(d15.by_status.completed).toBe(1);
    expect(d15.by_format.csv).toBe(1);
    expect(s.total_jobs_in_window).toBe(1);
    expect(s.total_jobs_observed).toBe(1);
  });
});

describe('M12.13 — jobs outside window dropped from in_window but counted as observed', () => {
  test('old jobs counted in total_jobs_observed only', () => {
    const store = new MockJobStore({
      BIL: [
        makeJob({ requested_at: '2026-05-15T10:00:00.000Z' }),
        makeJob({ requested_at: '2026-05-15T11:00:00.000Z' }),
        // 100 days before NOW — outside default 30 window
        makeJob({ requested_at: '2026-01-01T00:00:00.000Z' }),
      ],
    });
    const s = summarizeReportJobDailyVolume(store, 'BIL', 30, NOW);
    expect(s.total_jobs_in_window).toBe(2);
    expect(s.total_jobs_observed).toBe(3);
  });
});

describe('M12.13 — by_status accumulation', () => {
  test('per-day per-status counts add correctly', () => {
    const store = new MockJobStore({
      BIL: [
        makeJob({ requested_at: '2026-05-17T10:00:00.000Z', status: 'completed' }),
        makeJob({ requested_at: '2026-05-17T11:00:00.000Z', status: 'completed' }),
        makeJob({ requested_at: '2026-05-17T12:00:00.000Z', status: 'failed' }),
        makeJob({ requested_at: '2026-05-16T08:00:00.000Z', status: 'queued' }),
      ],
    });
    const s = summarizeReportJobDailyVolume(store, 'BIL', 7, NOW);
    const today = s.by_day.find((b) => b.date === '2026-05-17')!;
    const yesterday = s.by_day.find((b) => b.date === '2026-05-16')!;
    expect(today.total).toBe(3);
    expect(today.by_status.completed).toBe(2);
    expect(today.by_status.failed).toBe(1);
    expect(today.by_status.queued).toBe(0);
    expect(yesterday.total).toBe(1);
    expect(yesterday.by_status.queued).toBe(1);
  });
});

describe('M12.13 — by_format accumulation', () => {
  test('per-day per-format counts add correctly', () => {
    const store = new MockJobStore({
      BIL: [
        makeJob({ requested_at: '2026-05-17T10:00:00.000Z', format: 'json' }),
        makeJob({ requested_at: '2026-05-17T11:00:00.000Z', format: 'csv' }),
        makeJob({ requested_at: '2026-05-17T12:00:00.000Z', format: 'pdf' }),
        makeJob({ requested_at: '2026-05-17T13:00:00.000Z', format: 'csv' }),
      ],
    });
    const s = summarizeReportJobDailyVolume(store, 'BIL', 7, NOW);
    const today = s.by_day.find((b) => b.date === '2026-05-17')!;
    expect(today.by_format.json).toBe(1);
    expect(today.by_format.csv).toBe(2);
    expect(today.by_format.pdf).toBe(1);
    expect(today.by_format.xlsx).toBe(0);
  });
});

describe('M12.13 — peak_day', () => {
  test('points at highest-count day', () => {
    const store = new MockJobStore({
      BIL: [
        makeJob({ requested_at: '2026-05-15T10:00:00.000Z' }),
        makeJob({ requested_at: '2026-05-15T11:00:00.000Z' }),
        makeJob({ requested_at: '2026-05-15T12:00:00.000Z' }),
        makeJob({ requested_at: '2026-05-16T10:00:00.000Z' }),
      ],
    });
    const s = summarizeReportJobDailyVolume(store, 'BIL', 7, NOW);
    expect(s.peak_day).toBe('2026-05-15');
    expect(s.peak_count).toBe(3);
  });

  test('earliest-day-wins tie-break', () => {
    const store = new MockJobStore({
      BIL: [
        makeJob({ requested_at: '2026-05-15T10:00:00.000Z' }),
        makeJob({ requested_at: '2026-05-16T10:00:00.000Z' }),
      ],
    });
    const s = summarizeReportJobDailyVolume(store, 'BIL', 7, NOW);
    expect(s.peak_day).toBe('2026-05-15'); // earlier day wins at tie
    expect(s.peak_count).toBe(1);
  });

  test('null when zero jobs in window', () => {
    const s = summarizeReportJobDailyVolume(new InMemoryReportJobStore(), 'BIL', 7, NOW);
    expect(s.peak_day).toBeNull();
    expect(s.peak_count).toBe(0);
  });
});

describe('M12.13 — mean_per_day', () => {
  test('mean rounded to nearest integer', () => {
    const jobs: ReportJob[] = [];
    // 10 jobs spread over 5-day window → mean 2
    for (let i = 0; i < 10; i++) {
      jobs.push(makeJob({ requested_at: '2026-05-17T10:00:00.000Z' }));
    }
    const store = new MockJobStore({ BIL: jobs });
    const s = summarizeReportJobDailyVolume(store, 'BIL', 5, NOW);
    expect(s.mean_per_day).toBe(2); // 10/5 = 2
  });

  test('zero when no jobs', () => {
    const s = summarizeReportJobDailyVolume(new InMemoryReportJobStore(), 'BIL', 7, NOW);
    expect(s.mean_per_day).toBe(0);
  });
});

describe('M12.13 — growth_rate', () => {
  test('positive when second half busier than first half', () => {
    const jobs: ReportJob[] = [
      // First half (May 11-13): 1 each = mean 1
      makeJob({ requested_at: '2026-05-11T10:00:00.000Z' }),
      makeJob({ requested_at: '2026-05-12T10:00:00.000Z' }),
      makeJob({ requested_at: '2026-05-13T10:00:00.000Z' }),
      // Second half (May 14-17): 4 + 4 + 4 + 4 = mean 4
      ...Array(4).fill(0).map(() => makeJob({ requested_at: '2026-05-14T10:00:00.000Z' })),
      ...Array(4).fill(0).map(() => makeJob({ requested_at: '2026-05-15T10:00:00.000Z' })),
      ...Array(4).fill(0).map(() => makeJob({ requested_at: '2026-05-16T10:00:00.000Z' })),
      ...Array(4).fill(0).map(() => makeJob({ requested_at: '2026-05-17T10:00:00.000Z' })),
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = summarizeReportJobDailyVolume(store, 'BIL', 7, NOW);
    // 7-day window → half=3; firstHalf=May11..13 mean=1; secondHalf=May14..17 mean=4
    // growth = (4 - 1) / 1 = 3
    expect(s.growth_rate).toBe(3);
  });

  test('negative when second half quieter', () => {
    const jobs: ReportJob[] = [
      // First half: 4 each
      ...Array(4).fill(0).map(() => makeJob({ requested_at: '2026-05-11T10:00:00.000Z' })),
      ...Array(4).fill(0).map(() => makeJob({ requested_at: '2026-05-12T10:00:00.000Z' })),
      ...Array(4).fill(0).map(() => makeJob({ requested_at: '2026-05-13T10:00:00.000Z' })),
      // Second half: 2 each
      ...Array(2).fill(0).map(() => makeJob({ requested_at: '2026-05-14T10:00:00.000Z' })),
      ...Array(2).fill(0).map(() => makeJob({ requested_at: '2026-05-15T10:00:00.000Z' })),
      ...Array(2).fill(0).map(() => makeJob({ requested_at: '2026-05-16T10:00:00.000Z' })),
      ...Array(2).fill(0).map(() => makeJob({ requested_at: '2026-05-17T10:00:00.000Z' })),
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = summarizeReportJobDailyVolume(store, 'BIL', 7, NOW);
    // firstHalf mean = 4; secondHalf mean = 2
    // growth = (2 - 4) / 4 = -0.5
    expect(s.growth_rate).toBeCloseTo(-0.5);
  });

  test('null when first-half mean = 0', () => {
    const jobs: ReportJob[] = [
      // All in second half only
      makeJob({ requested_at: '2026-05-15T10:00:00.000Z' }),
      makeJob({ requested_at: '2026-05-16T10:00:00.000Z' }),
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = summarizeReportJobDailyVolume(store, 'BIL', 7, NOW);
    expect(s.growth_rate).toBeNull();
  });

  test('null when days=1', () => {
    const s = summarizeReportJobDailyVolume(new InMemoryReportJobStore(), 'BIL', 1, NOW);
    expect(s.growth_rate).toBeNull();
  });
});

describe('M12.13 — busiest_format', () => {
  test('points at highest-total format', () => {
    const jobs: ReportJob[] = [
      ...Array(3).fill(0).map(() => makeJob({ requested_at: '2026-05-15T10:00:00.000Z', format: 'csv' })),
      ...Array(5).fill(0).map(() => makeJob({ requested_at: '2026-05-15T11:00:00.000Z', format: 'pdf' })),
      ...Array(1).fill(0).map(() => makeJob({ requested_at: '2026-05-15T12:00:00.000Z', format: 'json' })),
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = summarizeReportJobDailyVolume(store, 'BIL', 7, NOW);
    expect(s.busiest_format).toBe('pdf');
  });

  test('canonical-order tie-break: json wins over csv at same count', () => {
    const jobs: ReportJob[] = [
      makeJob({ requested_at: '2026-05-15T10:00:00.000Z', format: 'csv' }),
      makeJob({ requested_at: '2026-05-15T11:00:00.000Z', format: 'json' }),
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = summarizeReportJobDailyVolume(store, 'BIL', 7, NOW);
    expect(s.busiest_format).toBe('json'); // canonical order wins
  });

  test('null when no jobs in window', () => {
    const s = summarizeReportJobDailyVolume(new InMemoryReportJobStore(), 'BIL', 7, NOW);
    expect(s.busiest_format).toBeNull();
  });
});

describe('M12.13 — partition invariant', () => {
  test('Σ per-day total = total_jobs_in_window; per-day Σ by_status = total', () => {
    const jobs: ReportJob[] = [
      makeJob({ requested_at: '2026-05-15T10:00:00.000Z', status: 'completed', format: 'csv' }),
      makeJob({ requested_at: '2026-05-15T11:00:00.000Z', status: 'failed', format: 'csv' }),
      makeJob({ requested_at: '2026-05-16T10:00:00.000Z', status: 'queued', format: 'json' }),
      makeJob({ requested_at: '2026-05-17T10:00:00.000Z', status: 'completed', format: 'pdf' }),
    ];
    const store = new MockJobStore({ BIL: jobs });
    const s = summarizeReportJobDailyVolume(store, 'BIL', 7, NOW);
    const daySum = s.by_day.reduce((acc, b) => acc + b.total, 0);
    expect(daySum).toBe(s.total_jobs_in_window);
    expect(s.total_jobs_in_window).toBe(4);
    for (const b of s.by_day) {
      const statusSum = Object.values(b.by_status).reduce((a: number, c: number) => a + c, 0);
      const formatSum = Object.values(b.by_format).reduce((a: number, c: number) => a + c, 0);
      expect(statusSum).toBe(b.total);
      expect(formatSum).toBe(b.total);
    }
  });
});

describe('M12.13 — tenant scoping', () => {
  test('jobs from other tenants invisible', () => {
    const store = new MockJobStore({
      BIL: [makeJob({ requested_at: '2026-05-15T10:00:00.000Z' })],
      BANK_DEMO: [
        makeJob({ requested_at: '2026-05-15T11:00:00.000Z' }),
        makeJob({ requested_at: '2026-05-16T10:00:00.000Z' }),
      ],
    });
    const bil = summarizeReportJobDailyVolume(store, 'BIL', 7, NOW);
    const bank = summarizeReportJobDailyVolume(store, 'BANK_DEMO', 7, NOW);
    expect(bil.total_jobs_in_window).toBe(1);
    expect(bank.total_jobs_in_window).toBe(2);
  });
});

describe('M12.13 — invalid days throws', () => {
  test('days=0 → ReportDailyVolumeError invalid_input', () => {
    expect(() => summarizeReportJobDailyVolume(new InMemoryReportJobStore(), 'BIL', 0, NOW))
      .toThrow(ReportDailyVolumeError);
  });

  test('days=366 → ReportDailyVolumeError invalid_input', () => {
    expect(() => summarizeReportJobDailyVolume(new InMemoryReportJobStore(), 'BIL', 366, NOW))
      .toThrow(ReportDailyVolumeError);
  });

  test('non-integer days throws', () => {
    expect(() => summarizeReportJobDailyVolume(new InMemoryReportJobStore(), 'BIL', 3.5, NOW))
      .toThrow(ReportDailyVolumeError);
  });
});

// ─── GET /v1/reports/jobs/daily-volume ───────────────────────────────

describe('M12.13 — GET /v1/reports/jobs/daily-volume', () => {
  test('admin → 200 with default 30-day empty window', async () => {
    const { app } = makeDvApp('admin');
    const r = await request(app).get('/v1/reports/jobs/daily-volume').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.days).toBe(30);
    expect(r.body.body.by_day.length).toBe(30);
    expect(r.body.body.total_jobs_in_window).toBe(0);
    expect(r.body.body.peak_day).toBeNull();
    expect(r.body.body.busiest_format).toBeNull();
  });

  test('populated rollup reflects submitted jobs', async () => {
    const { app, store } = makeDvApp('admin');
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'csv' }, 'alice', NOW);
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'csv' }, 'alice', NOW);
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'pdf' }, 'alice', NOW);
    const r = await request(app).get('/v1/reports/jobs/daily-volume?days=7').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(7);
    expect(r.body.body.total_jobs_in_window).toBe(3);
    expect(r.body.body.peak_day).toBe('2026-05-17');
    expect(r.body.body.peak_count).toBe(3);
    expect(r.body.body.busiest_format).toBe('csv');
  });

  test('?days=invalid → 400 envelope', async () => {
    const { app } = makeDvApp('admin');
    const r = await request(app).get('/v1/reports/jobs/daily-volume?days=0').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?days=400 → 400 envelope', async () => {
    const { app } = makeDvApp('admin');
    const r = await request(app).get('/v1/reports/jobs/daily-volume?days=400').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?days=NaN → 400 envelope', async () => {
    const { app } = makeDvApp('admin');
    const r = await request(app).get('/v1/reports/jobs/daily-volume?days=abc').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeDvApp('case_owner');
    const r = await request(app).get('/v1/reports/jobs/daily-volume').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL jobs invisible to BANK_DEMO', async () => {
    const { app, store } = makeDvApp('admin');
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'json' }, 'alice', NOW);
    const bank = await request(app)
      .get('/v1/reports/jobs/daily-volume')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_jobs_in_window).toBe(0);
  });

  test('literal `/daily-volume` not captured as :job_id param', async () => {
    const { app } = makeDvApp('admin');
    // If routing shadowed, would hit /v1/reports/jobs/:job_id → 404.
    const r = await request(app).get('/v1/reports/jobs/daily-volume').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M12.11 sibling /v1/reports/jobs/format-distribution still 200', async () => {
    const { app } = makeDvApp('admin');
    const r = await request(app).get('/v1/reports/jobs/format-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
