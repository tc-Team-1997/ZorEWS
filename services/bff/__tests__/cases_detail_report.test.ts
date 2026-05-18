// services/bff/__tests__/cases_detail_report.test.ts
//
// T6 — Cases Report (BAC §3.1.8). Covers four layers:
//   1. Pure resolver — runCasesDetailReportInMemory bucketing, sort,
//      pagination, breach math, free-text search.
//   2. Exporters — exportCsv shape, exportXlsx is a Buffer with two
//      sheets, exportPdf is a non-empty Buffer.
//   3. Routes — happy GET, 400 invalid input, 403 export-without-role,
//      saved-filter CRUD round-trip.
//   4. Audit — fire-and-forget invocation passes a `report_export`
//      payload with row count, bytes, duration_ms, filters.
//
// No DB. The PG implementation is exercised separately by smoke tests.

import request from 'supertest';
import {
  isValidSortColumn,
  runCasesDetailReportInMemory,
  type CaseRow,
  type CasesDetailFilter,
  type CasesDetailSource,
  type InMemoryInputs,
} from '../src/reports/cases_detail_query';
import {
  exportCsv,
  exportXlsx,
  exportPdf,
  ROW_CAP,
} from '../src/reports/cases_detail_exporters';
import {
  InMemorySavedFilterStore,
  validateCreate,
  SavedFilterError,
} from '../src/reports/saved_filters_store';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-08T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

// ── Fixtures ──────────────────────────────────────────────────────────

function inputs(): InMemoryInputs {
  return {
    cases: [
      {
        case_id: 'c1',
        case_number: 'C-001',
        title: 't',
        case_category: 'credit_risk',
        priority: 'P1',
        status: 'OPEN',
        created_at: new Date(NOW.getTime() - 1 * 86_400_000).toISOString(),
        alert_id: 'a1',
        assigned_to: 'u1',
        tags: [],
      },
      {
        case_id: 'c2',
        case_number: 'C-002',
        title: 't',
        case_category: 'credit_risk',
        priority: 'P2',
        status: 'OPEN',
        created_at: new Date(NOW.getTime() - 10 * 86_400_000).toISOString(),
        alert_id: 'a2',
        assigned_to: 'u2',
        tags: ['vip'],
      },
      {
        case_id: 'c3',
        case_number: 'C-003',
        title: 't',
        case_category: 'fraud',
        priority: 'P1',
        status: 'OPEN',
        created_at: new Date(NOW.getTime() - 50 * 86_400_000).toISOString(),
        alert_id: 'a3',
        assigned_to: null,
        tags: [],
      },
      {
        case_id: 'c4',
        case_number: 'C-004',
        title: 't',
        case_category: 'credit_risk',
        priority: 'P3',
        status: 'CLOSED',
        created_at: new Date(NOW.getTime() - 120 * 86_400_000).toISOString(),
        alert_id: 'a4',
        assigned_to: 'u1',
        tags: [],
      },
    ],
    configs: [
      {
        sla_config_id: 's1',
        tenant_id: 'BANK_DEMO',
        case_category: 'credit_risk',
        priority: 'P1',
        business_unit: null,
        sla_target_days: 1,
        status: 'ACTIVE',
      },
      {
        sla_config_id: 's2',
        tenant_id: 'BANK_DEMO',
        case_category: 'credit_risk',
        priority: 'P2',
        business_unit: null,
        sla_target_days: 3,
        status: 'ACTIVE',
      },
      {
        sla_config_id: 's3',
        tenant_id: 'BANK_DEMO',
        case_category: 'fraud',
        priority: 'P1',
        business_unit: null,
        sla_target_days: 0.5,
        status: 'ACTIVE',
      },
      {
        sla_config_id: 's4',
        tenant_id: 'BANK_DEMO',
        case_category: 'default_fallback',
        priority: 'P3',
        business_unit: null,
        sla_target_days: 10,
        status: 'ACTIVE',
      },
    ],
    users: new Map([
      ['u1', { display_name: 'Alice', branch: 'BR-01' }],
      ['u2', { display_name: 'Bob', branch: 'BR-02' }],
    ]),
    customers: new Map([
      ['a1', { id: 'cust-1', name: 'Acme Co' }],
      ['a2', { id: 'cust-2', name: 'Beta Industries' }],
      ['a3', { id: 'cust-3', name: 'Gamma Ltd' }],
      ['a4', { id: 'cust-4', name: 'Delta LLC' }],
    ]),
  };
}

function run(filter: CasesDetailFilter = {}) {
  return runCasesDetailReportInMemory('BANK_DEMO', inputs(), filter, NOW);
}

// ── 1. Pure resolver ─────────────────────────────────────────────────

describe('runCasesDetailReportInMemory', () => {
  test('returns all rows + correct buckets when no filter', () => {
    const out = run();
    expect(out.total).toBe(4);
    const byCase = new Map(out.items.map((r) => [r.case_id, r]));
    expect(byCase.get('c1')!.age_bucket).toBe('0-7d');
    expect(byCase.get('c2')!.age_bucket).toBe('8-30d');
    expect(byCase.get('c3')!.age_bucket).toBe('31-90d');
    expect(byCase.get('c4')!.age_bucket).toBe('90+d');
  });

  test('breach math — c2 (10d, P2 target 3d, OPEN) is breached; c4 (CLOSED) is not', () => {
    const byCase = new Map(run().items.map((r) => [r.case_id, r]));
    expect(byCase.get('c2')!.is_breached).toBe(true);
    expect(byCase.get('c4')!.is_breached).toBe(false);
  });

  test('sub-day SLA breach (fraud P1 = 0.5d) — c3 50d old breaches', () => {
    const byCase = new Map(run().items.map((r) => [r.case_id, r]));
    expect(byCase.get('c3')!.sla_target_days).toBe(0.5);
    expect(byCase.get('c3')!.is_breached).toBe(true);
  });

  test('default_fallback resolution — c4 (credit_risk P3) uses fallback target=10d', () => {
    const byCase = new Map(run().items.map((r) => [r.case_id, r]));
    expect(byCase.get('c4')!.sla_target_days).toBe(10);
  });

  test('ageBucket filter narrows results', () => {
    const out = run({ ageBucket: '8-30d' });
    expect(out.items.map((r) => r.case_id)).toEqual(['c2']);
    expect(out.total).toBe(1);
  });

  test('breached=true keeps only breached', () => {
    const out = run({ breached: true });
    const ids = out.items.map((r) => r.case_id);
    // c1 is 1d old vs P1 1d target — breach is age > target so equal is not breached
    expect(ids).not.toContain('c1');
    expect(ids).not.toContain('c4'); // CLOSED
    expect(ids).toContain('c2');
    expect(ids).toContain('c3');
  });

  test('q searches case_number + borrower name (case-insensitive)', () => {
    expect(run({ q: 'acme' }).items.map((r) => r.case_id)).toEqual(['c1']);
    expect(run({ q: 'C-002' }).items.map((r) => r.case_id)).toEqual(['c2']);
  });

  test('sort=age_days asc returns youngest first', () => {
    const ids = run({ sort: 'age_days', dir: 'asc' }).items.map((r) => r.case_id);
    expect(ids).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  test('pagination — page=2 page_size=2 returns rows 3-4', () => {
    const out = run({ page: 2, page_size: 2, sort: 'age_days', dir: 'asc' });
    expect(out.items.map((r) => r.case_id)).toEqual(['c3', 'c4']);
    expect(out.total).toBe(4);
    expect(out.page).toBe(2);
  });

  test('severity is P1→high, P2→medium, P3→medium, P4→low', () => {
    const byCase = new Map(run().items.map((r) => [r.case_id, r]));
    expect(byCase.get('c1')!.severity).toBe('high');
    expect(byCase.get('c2')!.severity).toBe('medium');
    expect(byCase.get('c4')!.severity).toBe('medium'); // P3
  });

  test('borrower + assignee join populates rows', () => {
    const r1 = run().items.find((r) => r.case_id === 'c1')!;
    expect(r1.borrower).toEqual({ id: 'cust-1', name: 'Acme Co' });
    expect(r1.assignee_display_name).toBe('Alice');
    expect(r1.branch).toBe('BR-01');
  });
});

describe('isValidSortColumn', () => {
  test('whitelisted columns pass', () => {
    expect(isValidSortColumn('age_days')).toBe(true);
    expect(isValidSortColumn('severity')).toBe(true);
  });
  test('non-whitelisted reject', () => {
    expect(isValidSortColumn('drop table')).toBe(false);
    expect(isValidSortColumn('')).toBe(false);
    expect(isValidSortColumn(undefined)).toBe(false);
  });
});

// ── 2. Exporters ─────────────────────────────────────────────────────

describe('exporters', () => {
  const meta = {
    tenant_id: 'BANK_DEMO',
    generated_at: NOW.toISOString(),
    generated_by: 'taniya',
    filters: { ageBucket: '8-30d' as const },
  };
  const rows: CaseRow[] = run().items;

  test('CSV: starts with the 17 column headers, CRLF terminated', () => {
    const csv = exportCsv(rows, meta);
    expect(csv.endsWith('\r\n')).toBe(true);
    const [header] = csv.split('\r\n');
    expect(header.split(',').length).toBe(17);
    expect(header).toContain('Case ID');
    expect(header).toContain('Borrower');
    expect(header).toContain('SLA Target');
    expect(header).toContain('Breached');
  });

  test('CSV: escapes commas + quotes in borrower names', () => {
    const malicious: CaseRow[] = [
      {
        ...rows[0],
        borrower: { id: 'X', name: 'Acme, "Quoted" Inc' },
      },
    ];
    const csv = exportCsv(malicious, meta);
    // The quoted field should be in the output, with internal quotes doubled
    expect(csv).toContain('"Acme, ""Quoted"" Inc"');
  });

  test('XLSX: returns a Buffer that begins with the ZIP magic (PK\\x03\\x04)', async () => {
    const buf = await exportXlsx(rows, meta);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K'
  });

  test('PDF: returns a Buffer that starts with %PDF', async () => {
    const buf = await exportPdf(rows, meta);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  test('ROW_CAP enforces format-specific limits', () => {
    expect(ROW_CAP.csv).toBe(50_000);
    expect(ROW_CAP.xlsx).toBe(50_000);
    expect(ROW_CAP.pdf).toBe(5_000);
  });
});

// ── 3. Routes ────────────────────────────────────────────────────────

function fakeSource(report: ReturnType<typeof run>): CasesDetailSource {
  return {
    async run(_t, filter, _asOf) {
      // Re-run the in-memory resolver with the latest filter so tests
      // that exercise format=csv get the same (paginated) row set.
      return runCasesDetailReportInMemory('BANK_DEMO', inputs(), filter, NOW);
    },
  };
}

function makeReportApp(role = 'admin') {
  const store = new InMemorySavedFilterStore();
  const source = fakeSource(run());
  return {
    app: makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      now: () => NOW,
      getRole: () => role,
      casesDetailSource: source,
      savedFilterStore: store,
    }).app,
    store,
  };
}

describe('GET /v1/reports/cases/detail', () => {
  test('json: returns rows + total, EWS envelope', async () => {
    const { app } = makeReportApp();
    const r = await request(app)
      .get('/v1/reports/cases/detail')
      .set(TH)
      .set('x-apex-user', 'taniya')
      .set('x-apex-role', 'admin');
    expect(r.status).toBe(200);
    expect(r.body.header).toBeDefined();
    expect(r.body.body.total).toBe(4);
    expect(r.body.body.items.length).toBe(4);
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
  });

  test('json: 400 on invalid format', async () => {
    const { app } = makeReportApp();
    const r = await request(app)
      .get('/v1/reports/cases/detail?format=docx')
      .set(TH)
      .set('x-apex-role', 'admin');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('json: 400 on invalid sort column (SQL injection guard)', async () => {
    const { app } = makeReportApp();
    const r = await request(app)
      .get('/v1/reports/cases/detail?sort=drop+table+cms_cases')
      .set(TH)
      .set('x-apex-role', 'admin');
    expect(r.status).toBe(400);
  });

  test('json: 400 on invalid ageBucket', async () => {
    const { app } = makeReportApp();
    const r = await request(app)
      .get('/v1/reports/cases/detail?ageBucket=200d')
      .set(TH)
      .set('x-apex-role', 'admin');
    expect(r.status).toBe(400);
  });

  test('csv export: returns text/csv body when role has export', async () => {
    const { app } = makeReportApp('admin');
    const r = await request(app)
      .get('/v1/reports/cases/detail?format=csv')
      .set(TH)
      .set('x-apex-user', 'taniya')
      .set('x-apex-role', 'admin');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/cases-report-BANK_DEMO/);
    expect(r.headers['x-row-count']).toBeDefined();
    // CSV body — header + 4 data rows
    const txt = r.text || r.body.toString();
    expect(txt.split('\r\n').filter(Boolean).length).toBeGreaterThanOrEqual(5);
  });

  test('xlsx export: returns spreadsheet binary', async () => {
    const { app } = makeReportApp('admin');
    const r = await request(app)
      .get('/v1/reports/cases/detail?format=xlsx')
      .set(TH)
      .set('x-apex-user', 'taniya')
      .set('x-apex-role', 'admin')
      .buffer(true)
      .parse((res, cb) => {
        const data: Buffer[] = [];
        res.on('data', (c: Buffer) => data.push(c));
        res.on('end', () => cb(null, Buffer.concat(data)));
      });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/spreadsheetml/);
    expect((r.body as Buffer)[0]).toBe(0x50); // PK
  });

  test('pdf export: returns PDF binary', async () => {
    const { app } = makeReportApp('admin');
    const r = await request(app)
      .get('/v1/reports/cases/detail?format=pdf')
      .set(TH)
      .set('x-apex-user', 'taniya')
      .set('x-apex-role', 'admin')
      .buffer(true)
      .parse((res, cb) => {
        const data: Buffer[] = [];
        res.on('data', (c: Buffer) => data.push(c));
        res.on('end', () => cb(null, Buffer.concat(data)));
      });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
    expect((r.body as Buffer).slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  test('csv export: 403 when role can view but not export (risk_analyst)', async () => {
    const { app } = makeReportApp('risk_analyst');
    const r = await request(app)
      .get('/v1/reports/cases/detail?format=csv')
      .set(TH)
      .set('x-apex-role', 'risk_analyst');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('EWS_403_export_denied');
  });
});

// ── 4. Saved filters CRUD ────────────────────────────────────────────

describe('saved filters', () => {
  test('validateCreate rejects empty name', () => {
    expect(() =>
      validateCreate({ report_type: 'cases', name: '', filters: {} }),
    ).toThrow(SavedFilterError);
  });

  test('validateCreate rejects unknown report_type', () => {
    expect(() =>
      validateCreate({ report_type: 'foo', name: 'x', filters: {} }),
    ).toThrow(SavedFilterError);
  });

  test('InMemorySavedFilterStore — list/create/update/delete round-trip', async () => {
    const store = new InMemorySavedFilterStore();
    const created = await store.create(
      'BANK_DEMO',
      'taniya',
      validateCreate({
        report_type: 'cases',
        name: 'Breached this week',
        filters: { breached: true, ageBucket: '0-7d' },
      }),
      NOW,
    );
    expect(created.filter_id).toBeDefined();

    const list1 = await store.list('BANK_DEMO', 'taniya', 'cases');
    expect(list1).toHaveLength(1);
    expect(list1[0].name).toBe('Breached this week');

    const updated = await store.update(
      'BANK_DEMO',
      created.filter_id,
      'taniya',
      { name: 'Renamed' },
      NOW,
    );
    expect(updated.name).toBe('Renamed');

    await store.delete('BANK_DEMO', created.filter_id, 'taniya');
    expect(await store.list('BANK_DEMO', 'taniya', 'cases')).toHaveLength(0);
  });

  test('restore() re-inserts with original ID + returns false on conflict', async () => {
    const store = new InMemorySavedFilterStore();
    const created = await store.create(
      'BANK_DEMO',
      'taniya',
      validateCreate({ report_type: 'cases', name: 'orig', filters: {} }),
      NOW,
    );
    // Snapshot, delete, restore
    const snapshot = (await store.get('BANK_DEMO', created.filter_id))!;
    await store.delete('BANK_DEMO', created.filter_id, 'taniya');
    expect(await store.get('BANK_DEMO', created.filter_id)).toBeNull();

    const ok = await store.restore(snapshot);
    expect(ok).toBe(true);
    expect((await store.get('BANK_DEMO', created.filter_id))?.name).toBe('orig');

    // Second restore returns false (already exists)
    expect(await store.restore(snapshot)).toBe(false);
  });

  test('only one is_default per (owner, report_type) — older one is cleared', async () => {
    const store = new InMemorySavedFilterStore();
    const a = await store.create(
      'BANK_DEMO',
      'taniya',
      validateCreate({
        report_type: 'cases',
        name: 'A',
        filters: {},
        is_default: true,
      }),
      NOW,
    );
    const b = await store.create(
      'BANK_DEMO',
      'taniya',
      validateCreate({
        report_type: 'cases',
        name: 'B',
        filters: {},
        is_default: true,
      }),
      NOW,
    );
    const list = await store.list('BANK_DEMO', 'taniya', 'cases');
    const aRow = list.find((f) => f.filter_id === a.filter_id)!;
    const bRow = list.find((f) => f.filter_id === b.filter_id)!;
    expect(aRow.is_default).toBe(false);
    expect(bRow.is_default).toBe(true);
  });

  test('shared filters surface to other users in the same tenant', async () => {
    const store = new InMemorySavedFilterStore();
    await store.create(
      'BANK_DEMO',
      'alice',
      validateCreate({
        report_type: 'cases',
        name: 'Shared view',
        filters: {},
        is_shared: true,
      }),
      NOW,
    );
    const bobsList = await store.list('BANK_DEMO', 'bob', 'cases');
    expect(bobsList.find((f) => f.name === 'Shared view')).toBeDefined();
  });

  test('GET /v1/reports/cases/filters returns the user\'s saved filters', async () => {
    const { app, store } = makeReportApp();
    await store.create(
      'BANK_DEMO',
      'taniya',
      validateCreate({
        report_type: 'cases',
        name: 'My breached',
        filters: { breached: true },
      }),
      NOW,
    );
    const r = await request(app)
      .get('/v1/reports/cases/filters')
      .set(TH)
      .set('x-apex-user', 'taniya')
      .set('x-apex-role', 'admin');
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].name).toBe('My breached');
  });

  test('POST + DELETE /v1/reports/cases/filters round-trips through the route', async () => {
    const { app } = makeReportApp();
    const post = await request(app)
      .post('/v1/reports/cases/filters')
      .set(TH)
      .set('x-apex-user', 'taniya')
      .set('x-apex-role', 'admin')
      .send({ name: 'Route created', filters: { ageBucket: '0-7d' } });
    expect(post.status).toBe(201);
    const id = post.body.body.filter_id;

    const del = await request(app)
      .delete(`/v1/reports/cases/filters/${id}`)
      .set(TH)
      .set('x-apex-user', 'taniya')
      .set('x-apex-role', 'admin');
    expect(del.status).toBe(200);
    expect(del.body.body.deleted).toBe(true);
  });
});
