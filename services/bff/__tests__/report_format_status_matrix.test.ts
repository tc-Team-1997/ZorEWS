// services/bff/__tests__/report_format_status_matrix.test.ts
//
// T6 M12.14 — Report job format × status cross-tab matrix.

import request from 'supertest';
import {
  buildReportFormatStatusMatrix,
  ALL_JOB_STATUSES,
} from '../src/report_format_status_matrix';
import { ALL_REPORT_FORMATS } from '../src/report_format_distribution';
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

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeFsApp(role: string = 'admin', reportJobStore?: ReportJobStore) {
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

/** Mock store that returns pre-built jobs verbatim — lets tests
 *  control format + status explicitly. */
class MockJobStore implements ReportJobStore {
  constructor(private readonly byTenant: Record<string, ReportJob[]>) {}
  submit(): ReportJob {
    throw new Error('not used');
  }
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
  markFailed(): ReportJob {
    throw new Error('not used');
  }
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

// ─── buildReportFormatStatusMatrix — pure ────────────────────────────

describe('M12.14 — empty store', () => {
  test('zero jobs → every row × col at 0, peak null, leaderboards null', () => {
    const store = new InMemoryReportJobStore();
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.generated_at).toBe(NOW.toISOString());
    expect(m.total_jobs).toBe(0);
    expect(m.rows.length).toBe(ALL_REPORT_FORMATS.length);
    expect(m.columns.length).toBe(ALL_JOB_STATUSES.length);
    for (const row of m.rows) {
      expect(row.total).toBe(0);
      for (const s of ALL_JOB_STATUSES) expect(row.by_status[s]).toBe(0);
    }
    expect(m.peak_cell).toBeNull();
    expect(m.most_active_format).toBeNull();
    expect(m.most_distributed_status).toBeNull();
    expect(m.empty_cells.length).toBe(ALL_REPORT_FORMATS.length * ALL_JOB_STATUSES.length);
  });
});

describe('M12.14 — rows in canonical format order', () => {
  test('rows[] follows ALL_REPORT_FORMATS', () => {
    const store = new InMemoryReportJobStore();
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    expect(m.rows.map((r) => r.format)).toEqual([...ALL_REPORT_FORMATS]);
  });
});

describe('M12.14 — columns in canonical status order', () => {
  test('columns[] follows ALL_JOB_STATUSES', () => {
    const store = new InMemoryReportJobStore();
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    expect(m.columns.map((c) => c.status)).toEqual([...ALL_JOB_STATUSES]);
  });
});

describe('M12.14 — single job placement', () => {
  test('one csv/completed job → that cell populated; total_jobs=1', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [makeJob({ format: 'csv', status: 'completed' })],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    expect(m.total_jobs).toBe(1);
    const csv = m.rows.find((r) => r.format === 'csv')!;
    expect(csv.by_status.completed).toBe(1);
    expect(csv.total).toBe(1);
    const completed = m.columns.find((c) => c.status === 'completed')!;
    expect(completed.by_format.csv).toBe(1);
    expect(completed.total).toBe(1);
    expect(m.peak_cell).toEqual({ format: 'csv', status: 'completed', count: 1 });
  });
});

describe('M12.14 — multiple jobs in same cell', () => {
  test('3 pdf/failed jobs → cell count=3', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [
        makeJob({ format: 'pdf', status: 'failed' }),
        makeJob({ format: 'pdf', status: 'failed' }),
        makeJob({ format: 'pdf', status: 'failed' }),
      ],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    expect(m.peak_cell!.count).toBe(3);
    expect(m.peak_cell!.format).toBe('pdf');
    expect(m.peak_cell!.status).toBe('failed');
  });
});

describe('M12.14 — per-row partition invariant', () => {
  test('Σ by_status = row.total per row', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [
        makeJob({ format: 'json', status: 'completed' }),
        makeJob({ format: 'json', status: 'failed' }),
        makeJob({ format: 'csv', status: 'queued' }),
      ],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    for (const row of m.rows) {
      const sum = Object.values(row.by_status).reduce((a, b) => a + b, 0);
      expect(row.total).toBe(sum);
    }
  });
});

describe('M12.14 — per-column partition invariant', () => {
  test('Σ by_format = col.total per col', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [
        makeJob({ format: 'json', status: 'completed' }),
        makeJob({ format: 'csv', status: 'completed' }),
        makeJob({ format: 'pdf', status: 'failed' }),
      ],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    for (const col of m.columns) {
      const sum = Object.values(col.by_format).reduce((a, b) => a + b, 0);
      expect(col.total).toBe(sum);
    }
  });
});

describe('M12.14 — grand-total cross-check', () => {
  test('Σ rows.total = Σ cols.total = total_jobs', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [
        makeJob({ format: 'json', status: 'completed' }),
        makeJob({ format: 'csv', status: 'failed' }),
        makeJob({ format: 'pdf', status: 'queued' }),
        makeJob({ format: 'xlsx', status: 'running' }),
      ],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    const rowSum = m.rows.reduce((acc, r) => acc + r.total, 0);
    const colSum = m.columns.reduce((acc, c) => acc + c.total, 0);
    expect(rowSum).toBe(m.total_jobs);
    expect(colSum).toBe(m.total_jobs);
    expect(m.total_jobs).toBe(4);
  });
});

describe('M12.14 — every-key-present invariants', () => {
  test('row.by_status has every JobStatus key', () => {
    const store = new InMemoryReportJobStore();
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    for (const row of m.rows) {
      for (const s of ALL_JOB_STATUSES) {
        expect(row.by_status).toHaveProperty(s);
        expect(typeof row.by_status[s]).toBe('number');
      }
    }
  });

  test('col.by_format has every ReportFormat key', () => {
    const store = new InMemoryReportJobStore();
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    for (const col of m.columns) {
      for (const f of ALL_REPORT_FORMATS) {
        expect(col.by_format).toHaveProperty(f);
        expect(typeof col.by_format[f]).toBe('number');
      }
    }
  });
});

describe('M12.14 — cell cross-check invariant', () => {
  test('row[format].by_status[status] === col[status].by_format[format] for every pair', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [
        makeJob({ format: 'json', status: 'completed' }),
        makeJob({ format: 'csv', status: 'failed' }),
        makeJob({ format: 'pdf', status: 'queued' }),
      ],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    for (const row of m.rows) {
      for (const col of m.columns) {
        expect(row.by_status[col.status]).toBe(col.by_format[row.format]);
      }
    }
  });
});

describe('M12.14 — statuses_without per row', () => {
  test('canonical status order; entries have by_status=0', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [makeJob({ format: 'json', status: 'completed' })],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    const json = m.rows.find((r) => r.format === 'json')!;
    expect(json.statuses_without).toEqual(['queued', 'running', 'failed']);
  });
});

describe('M12.14 — formats_without per column', () => {
  test('canonical format order; entries have by_format=0', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [makeJob({ format: 'json', status: 'completed' })],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    const completed = m.columns.find((c) => c.status === 'completed')!;
    expect(completed.formats_without).toEqual(['csv', 'pdf', 'xlsx']);
  });
});

describe('M12.14 — peak_cell formula', () => {
  test('points at highest-count cell', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [
        // (csv, completed) = 3
        makeJob({ format: 'csv', status: 'completed' }),
        makeJob({ format: 'csv', status: 'completed' }),
        makeJob({ format: 'csv', status: 'completed' }),
        // (pdf, failed) = 1
        makeJob({ format: 'pdf', status: 'failed' }),
      ],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    expect(m.peak_cell).toEqual({ format: 'csv', status: 'completed', count: 3 });
  });

  test('canonical iteration tie-break: json/completed wins over json/failed at tied count', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [
        makeJob({ format: 'json', status: 'completed' }),
        makeJob({ format: 'json', status: 'failed' }),
      ],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    expect(m.peak_cell!.format).toBe('json');
    expect(m.peak_cell!.status).toBe('completed');
  });

  test('null on empty', () => {
    const store = new InMemoryReportJobStore();
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    expect(m.peak_cell).toBeNull();
  });
});

describe('M12.14 — empty_cells', () => {
  test('every empty_cell has count=0 on both axes', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [makeJob({ format: 'csv', status: 'completed' })],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    for (const ec of m.empty_cells) {
      const row = m.rows.find((r) => r.format === ec.format)!;
      expect(row.by_status[ec.status]).toBe(0);
    }
  });

  test('canonical row-major order (format asc index, then status asc index)', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [makeJob({ format: 'csv', status: 'completed' })],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    for (let i = 1; i < m.empty_cells.length; i++) {
      const prev = m.empty_cells[i - 1]!;
      const curr = m.empty_cells[i]!;
      const prevFIdx = ALL_REPORT_FORMATS.indexOf(prev.format);
      const currFIdx = ALL_REPORT_FORMATS.indexOf(curr.format);
      if (prevFIdx !== currFIdx) {
        expect(currFIdx).toBeGreaterThan(prevFIdx);
      } else {
        const prevSIdx = ALL_JOB_STATUSES.indexOf(prev.status);
        const currSIdx = ALL_JOB_STATUSES.indexOf(curr.status);
        expect(currSIdx).toBeGreaterThan(prevSIdx);
      }
    }
  });

  test('partition: empty + non_empty = 16 (4 formats × 4 statuses)', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [makeJob({ format: 'csv', status: 'completed' })],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    const total_cells = ALL_REPORT_FORMATS.length * ALL_JOB_STATUSES.length;
    let non_empty = 0;
    for (const row of m.rows) {
      for (const s of ALL_JOB_STATUSES) {
        if (row.by_status[s] > 0) non_empty++;
      }
    }
    expect(m.empty_cells.length + non_empty).toBe(total_cells);
  });
});

describe('M12.14 — most_active_format', () => {
  test('points at format with most distinct non-zero statuses', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [
        // csv spans 3 statuses
        makeJob({ format: 'csv', status: 'completed' }),
        makeJob({ format: 'csv', status: 'failed' }),
        makeJob({ format: 'csv', status: 'queued' }),
        // pdf spans 1
        makeJob({ format: 'pdf', status: 'completed' }),
      ],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    expect(m.most_active_format!.format).toBe('csv');
    expect(m.most_active_format!.statuses_seen).toBe(3);
  });

  test('canonical-order tie-break: json wins over csv at same span', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [
        makeJob({ format: 'json', status: 'completed' }),
        makeJob({ format: 'csv', status: 'failed' }),
      ],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    expect(m.most_active_format!.format).toBe('json');
  });

  test('null on empty', () => {
    const store = new InMemoryReportJobStore();
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    expect(m.most_active_format).toBeNull();
  });
});

describe('M12.14 — most_distributed_status', () => {
  test('points at status with most distinct non-zero formats', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [
        // completed has 3 formats (json + csv + pdf)
        makeJob({ format: 'json', status: 'completed' }),
        makeJob({ format: 'csv', status: 'completed' }),
        makeJob({ format: 'pdf', status: 'completed' }),
        // failed has 1
        makeJob({ format: 'xlsx', status: 'failed' }),
      ],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    expect(m.most_distributed_status!.status).toBe('completed');
    expect(m.most_distributed_status!.formats_seen).toBe(3);
  });

  test('canonical-order tie-break: queued wins over running at same span', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [
        makeJob({ format: 'json', status: 'queued' }),
        makeJob({ format: 'json', status: 'running' }),
      ],
    };
    const store = new MockJobStore(jobs);
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    expect(m.most_distributed_status!.status).toBe('queued');
  });

  test('null on empty', () => {
    const store = new InMemoryReportJobStore();
    const m = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    expect(m.most_distributed_status).toBeNull();
  });
});

describe('M12.14 — tenant scoping', () => {
  test('jobs from another tenant invisible', () => {
    const jobs: Record<string, ReportJob[]> = {
      BIL: [makeJob({ format: 'csv', status: 'completed' })],
      BANK_DEMO: [
        makeJob({ format: 'pdf', status: 'failed' }),
        makeJob({ format: 'pdf', status: 'failed' }),
      ],
    };
    const store = new MockJobStore(jobs);
    const bil = buildReportFormatStatusMatrix(store, 'BIL', NOW);
    const bank = buildReportFormatStatusMatrix(store, 'BANK_DEMO', NOW);
    expect(bil.total_jobs).toBe(1);
    expect(bank.total_jobs).toBe(2);
  });
});

// ─── GET /v1/reports/jobs/format-status-matrix ───────────────────────

describe('M12.14 — GET /v1/reports/jobs/format-status-matrix', () => {
  test('admin → 200 with empty matrix on fresh tenant', async () => {
    const { app } = makeFsApp('admin');
    const r = await request(app).get('/v1/reports/jobs/format-status-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_jobs).toBe(0);
    expect(r.body.body.rows.length).toBe(ALL_REPORT_FORMATS.length);
    expect(r.body.body.columns.length).toBe(ALL_JOB_STATUSES.length);
  });

  test('populated matrix reflects submitted jobs', async () => {
    const { app, store } = makeFsApp('admin');
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'csv' }, 'alice', NOW);
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'csv' }, 'alice', NOW);
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'pdf' }, 'alice', NOW);
    const r = await request(app).get('/v1/reports/jobs/format-status-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    // InMemoryReportJobStore marks all as completed on submit, so 3 jobs → 3 in (?, completed).
    expect(r.body.body.total_jobs).toBe(3);
    expect(r.body.body.peak_cell.status).toBe('completed');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeFsApp('case_owner');
    const r = await request(app).get('/v1/reports/jobs/format-status-matrix').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL jobs invisible to BANK_DEMO', async () => {
    const { app, store } = makeFsApp('admin');
    store.submit('BIL', { report_id: 'portfolio_snapshot_daily', format: 'csv' }, 'alice', NOW);
    const bank = await request(app)
      .get('/v1/reports/jobs/format-status-matrix')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_jobs).toBe(0);
  });

  test('literal `/format-status-matrix` not captured by :job_id wildcard', async () => {
    const { app } = makeFsApp('admin');
    const r = await request(app).get('/v1/reports/jobs/format-status-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('M12.11 /v1/reports/jobs/format-distribution still 200 (sibling regression)', async () => {
    const { app } = makeFsApp('admin');
    const r = await request(app).get('/v1/reports/jobs/format-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
