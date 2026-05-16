// services/bff/__tests__/report_per_requester.test.ts
//
// T6 M12.12 — Report job per-requester rollup.

import request from 'supertest';
import { buildReportPerRequester } from '../src/report_per_requester';
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

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeReqApp(role: string = 'admin', reportJobStore?: ReportJobStore) {
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

// ─── buildReportPerRequester — pure ──────────────────────────────────

describe('M12.12 — empty store', () => {
  test('zero jobs → empty rollup', () => {
    const store = new InMemoryReportJobStore();
    const s = buildReportPerRequester(store, 'BIL', NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_jobs).toBe(0);
    expect(s.total_requesters).toBe(0);
    expect(s.requesters).toEqual([]);
    expect(s.most_active_requester).toBeNull();
    expect(s.requesters_with_failures).toEqual([]);
  });
});

describe('M12.12 — single requester single job', () => {
  test('one alice job → 1 row with every status/format key emitted', () => {
    const store = new MockJobStore({
      BIL: [makeJob({ requested_by: 'alice', format: 'csv', status: 'completed' })],
    });
    const s = buildReportPerRequester(store, 'BIL', NOW);
    expect(s.total_jobs).toBe(1);
    expect(s.total_requesters).toBe(1);
    const row = s.requesters[0]!;
    expect(row.requested_by).toBe('alice');
    expect(row.total_jobs).toBe(1);
    expect(row.by_status.completed).toBe(1);
    expect(row.by_status.failed).toBe(0);
    expect(row.by_status.queued).toBe(0);
    expect(row.by_status.running).toBe(0);
    expect(Object.keys(row.by_status).length).toBe(4);
    expect(row.by_format.csv).toBe(1);
    expect(row.by_format.json).toBe(0);
    expect(Object.keys(row.by_format).length).toBe(4);
    expect(row.has_failure).toBe(false);
  });
});

describe('M12.12 — multi-requester accumulation', () => {
  test('jobs from different requesters land in separate rows', () => {
    const store = new MockJobStore({
      BIL: [
        makeJob({ requested_by: 'alice' }),
        makeJob({ requested_by: 'alice' }),
        makeJob({ requested_by: 'bob' }),
      ],
    });
    const s = buildReportPerRequester(store, 'BIL', NOW);
    expect(s.total_requesters).toBe(2);
    const byUser = Object.fromEntries(s.requesters.map((r) => [r.requested_by, r]));
    expect(byUser['alice']!.total_jobs).toBe(2);
    expect(byUser['bob']!.total_jobs).toBe(1);
  });
});

describe('M12.12 — by_status partition per row', () => {
  test('Σ by_status = total_jobs per requester', () => {
    const store = new MockJobStore({
      BIL: [
        makeJob({ requested_by: 'alice', status: 'completed' }),
        makeJob({ requested_by: 'alice', status: 'failed' }),
        makeJob({ requested_by: 'alice', status: 'queued' }),
      ],
    });
    const s = buildReportPerRequester(store, 'BIL', NOW);
    for (const r of s.requesters) {
      const sum = Object.values(r.by_status).reduce((a, c) => a + c, 0);
      expect(sum).toBe(r.total_jobs);
    }
  });
});

describe('M12.12 — by_format partition per row', () => {
  test('Σ by_format = total_jobs per requester', () => {
    const store = new MockJobStore({
      BIL: [
        makeJob({ requested_by: 'alice', format: 'csv' }),
        makeJob({ requested_by: 'alice', format: 'pdf' }),
        makeJob({ requested_by: 'alice', format: 'json' }),
      ],
    });
    const s = buildReportPerRequester(store, 'BIL', NOW);
    for (const r of s.requesters) {
      const sum = Object.values(r.by_format).reduce((a, c) => a + c, 0);
      expect(sum).toBe(r.total_jobs);
    }
  });
});

describe('M12.12 — by_report_id_top', () => {
  test('top-5 sorted count desc + report_id asc tie-break', () => {
    const store = new MockJobStore({
      BIL: [
        ...Array(5).fill(0).map(() => makeJob({ requested_by: 'alice', report_id: 'r-most' })),
        ...Array(4).fill(0).map(() => makeJob({ requested_by: 'alice', report_id: 'r-second' })),
        ...Array(1).fill(0).map(() => makeJob({ requested_by: 'alice', report_id: 'r-a' })),
        ...Array(1).fill(0).map(() => makeJob({ requested_by: 'alice', report_id: 'r-b' })),
        ...Array(1).fill(0).map(() => makeJob({ requested_by: 'alice', report_id: 'r-c' })),
        ...Array(1).fill(0).map(() => makeJob({ requested_by: 'alice', report_id: 'r-d' })),
        ...Array(1).fill(0).map(() => makeJob({ requested_by: 'alice', report_id: 'r-e' })),
      ],
    });
    const s = buildReportPerRequester(store, 'BIL', NOW);
    const row = s.requesters[0]!;
    expect(row.by_report_id_top.length).toBe(5);
    expect(row.by_report_id_top[0]).toEqual({ report_id: 'r-most', count: 5 });
    expect(row.by_report_id_top[1]).toEqual({ report_id: 'r-second', count: 4 });
    expect(row.by_report_id_top[2]!.report_id).toBe('r-a'); // alphabetical tie-break
    expect(row.by_report_id_top[4]!.report_id).toBe('r-c');
  });
});

describe('M12.12 — distinct_reports counter', () => {
  test('counts distinct report_ids per requester', () => {
    const store = new MockJobStore({
      BIL: [
        makeJob({ requested_by: 'alice', report_id: 'r1' }),
        makeJob({ requested_by: 'alice', report_id: 'r1' }),
        makeJob({ requested_by: 'alice', report_id: 'r2' }),
        makeJob({ requested_by: 'alice', report_id: 'r3' }),
      ],
    });
    const s = buildReportPerRequester(store, 'BIL', NOW);
    expect(s.requesters[0]!.distinct_reports).toBe(3);
  });
});

describe('M12.12 — most_recent_at', () => {
  test('takes the newest requested_at across all statuses for this user', () => {
    const store = new MockJobStore({
      BIL: [
        makeJob({ requested_by: 'alice', status: 'completed', requested_at: '2026-05-10T00:00:00.000Z' }),
        makeJob({ requested_by: 'alice', status: 'failed', requested_at: '2026-05-15T00:00:00.000Z' }),
        makeJob({ requested_by: 'alice', status: 'queued', requested_at: '2026-05-12T00:00:00.000Z' }),
      ],
    });
    const s = buildReportPerRequester(store, 'BIL', NOW);
    expect(s.requesters[0]!.most_recent_at).toBe('2026-05-15T00:00:00.000Z');
  });
});

describe('M12.12 — sort order', () => {
  test('total_jobs desc with requested_by asc tie-break', () => {
    const store = new MockJobStore({
      BIL: [
        makeJob({ requested_by: 'tied-z' }),
        makeJob({ requested_by: 'tied-z' }),
        makeJob({ requested_by: 'busy' }),
        makeJob({ requested_by: 'busy' }),
        makeJob({ requested_by: 'busy' }),
        makeJob({ requested_by: 'tied-a' }),
        makeJob({ requested_by: 'tied-a' }),
        makeJob({ requested_by: 'quiet' }),
      ],
    });
    const s = buildReportPerRequester(store, 'BIL', NOW);
    expect(s.requesters.map((r) => r.requested_by)).toEqual(['busy', 'tied-a', 'tied-z', 'quiet']);
  });
});

describe('M12.12 — most_active_requester', () => {
  test('points at top row by total_jobs', () => {
    const store = new MockJobStore({
      BIL: [
        ...Array(3).fill(0).map(() => makeJob({ requested_by: 'alice' })),
        ...Array(5).fill(0).map(() => makeJob({ requested_by: 'bob' })),
      ],
    });
    const s = buildReportPerRequester(store, 'BIL', NOW);
    expect(s.most_active_requester).toEqual({ requested_by: 'bob', total_jobs: 5 });
  });

  test('null when no jobs', () => {
    const s = buildReportPerRequester(new InMemoryReportJobStore(), 'BIL', NOW);
    expect(s.most_active_requester).toBeNull();
  });
});

describe('M12.12 — requesters_with_failures', () => {
  test('subset of requesters that have ≥1 failed job, sorted failed_count desc + asc tie-break', () => {
    const store = new MockJobStore({
      BIL: [
        // alice: 1 completed
        makeJob({ requested_by: 'alice', status: 'completed' }),
        // bob: 3 failures
        ...Array(3).fill(0).map(() => makeJob({ requested_by: 'bob', status: 'failed' })),
        // charlie: 1 failure (asc tie-break with daria below)
        makeJob({ requested_by: 'charlie', status: 'failed' }),
        // daria: 1 failure
        makeJob({ requested_by: 'daria', status: 'failed' }),
      ],
    });
    const s = buildReportPerRequester(store, 'BIL', NOW);
    expect(s.requesters_with_failures.map((r) => r.requested_by)).toEqual(['bob', 'charlie', 'daria']);
    expect(s.requesters_with_failures[0]).toEqual({ requested_by: 'bob', failed_count: 3 });
  });

  test('has_failure flag matches requesters_with_failures membership', () => {
    const store = new MockJobStore({
      BIL: [
        makeJob({ requested_by: 'alice', status: 'completed' }),
        makeJob({ requested_by: 'bob', status: 'failed' }),
      ],
    });
    const s = buildReportPerRequester(store, 'BIL', NOW);
    expect(s.requesters.find((r) => r.requested_by === 'alice')!.has_failure).toBe(false);
    expect(s.requesters.find((r) => r.requested_by === 'bob')!.has_failure).toBe(true);
    expect(s.requesters_with_failures.map((r) => r.requested_by)).toEqual(['bob']);
  });
});

describe('M12.12 — partition: Σ total_jobs across rows = envelope total_jobs', () => {
  test('counts sum across rows', () => {
    const store = new MockJobStore({
      BIL: [
        makeJob({ requested_by: 'a' }),
        makeJob({ requested_by: 'a' }),
        makeJob({ requested_by: 'b' }),
        makeJob({ requested_by: 'c' }),
      ],
    });
    const s = buildReportPerRequester(store, 'BIL', NOW);
    const sum = s.requesters.reduce((acc, r) => acc + r.total_jobs, 0);
    expect(sum).toBe(s.total_jobs);
    expect(s.total_jobs).toBe(4);
  });
});

describe('M12.12 — tenant scoping', () => {
  test('jobs from other tenants invisible', () => {
    const store = new MockJobStore({
      BIL: [makeJob({ requested_by: 'alice' })],
      BANK_DEMO: [makeJob({ requested_by: 'bob' }), makeJob({ requested_by: 'carol' })],
    });
    const bil = buildReportPerRequester(store, 'BIL', NOW);
    const bank = buildReportPerRequester(store, 'BANK_DEMO', NOW);
    expect(bil.total_jobs).toBe(1);
    expect(bank.total_jobs).toBe(2);
    expect(bil.requesters.find((r) => r.requested_by === 'bob')).toBeUndefined();
  });
});

// ─── GET /v1/reports/jobs/per-requester ──────────────────────────────

describe('M12.12 — GET /v1/reports/jobs/per-requester', () => {
  test('admin → 200 with empty rollup on fresh tenant', async () => {
    const { app } = makeReqApp('admin');
    const r = await request(app).get('/v1/reports/jobs/per-requester').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_jobs).toBe(0);
    expect(r.body.body.requesters).toEqual([]);
    expect(r.body.body.most_active_requester).toBeNull();
  });

  test('populated rollup reflects submitted jobs', async () => {
    const { app, store } = makeReqApp('admin');
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'csv' }, 'alice', NOW);
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'csv' }, 'alice', NOW);
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'pdf' }, 'bob', NOW);
    const r = await request(app).get('/v1/reports/jobs/per-requester').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_jobs).toBe(3);
    expect(r.body.body.total_requesters).toBe(2);
    expect(r.body.body.most_active_requester.requested_by).toBe('alice');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeReqApp('case_owner');
    const r = await request(app).get('/v1/reports/jobs/per-requester').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL jobs invisible to BANK_DEMO', async () => {
    const { app, store } = makeReqApp('admin');
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'json' }, 'alice', NOW);
    const bank = await request(app)
      .get('/v1/reports/jobs/per-requester')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_jobs).toBe(0);
  });

  test('literal `/per-requester` not captured as :job_id', async () => {
    const { app } = makeReqApp('admin');
    const r = await request(app).get('/v1/reports/jobs/per-requester').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('M12.11 /v1/reports/jobs/format-distribution still works (sibling regression)', async () => {
    const { app } = makeReqApp('admin');
    const r = await request(app).get('/v1/reports/jobs/format-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M12.10 /v1/reports/jobs/runtime-trend still works (sibling regression)', async () => {
    const { app } = makeReqApp('admin');
    const r = await request(app).get('/v1/reports/jobs/runtime-trend').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
