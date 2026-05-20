// services/bff/__tests__/reports_builder_execute.test.ts
//
// T4.6.4 — Self-service reporting: execution engine + CSV export.

import request from 'supertest';
import {
  ReportExecutionError,
  executeReport,
  reportResultToCsv,
} from '../src/reports/builder_execute';
import type { ReportDefinition } from '../src/reports/builder_filter';
import { _resetDefaultSavedReportStore } from '../src/reports/builder_store';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeExecApp(role: string = 'admin') {
  _resetDefaultSavedReportStore();
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Pure execution ──────────────────────────────────────────────────

describe('executeReport — raw row-list', () => {
  test('returns envelope with rows + projection + sql + duration', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      limit: 25,
    };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    expect(r.tenant_id).toBe('BIL');
    expect(r.source_id).toBe('mart.customer_360');
    expect(r.is_aggregate).toBe(false);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.length).toBeLessThanOrEqual(25);
    expect(r.projection.length).toBeGreaterThan(0);
    expect(r.sql).toContain('SELECT');
    expect(r.params.tenant_id).toBe('BIL');
    expect(typeof r.duration_ms).toBe('number');
  });

  test('every row carries every projection field', () => {
    const def: ReportDefinition = { source_id: 'mart.customer_360', limit: 10 };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    for (const row of r.rows) {
      for (const col of r.projection) {
        expect(Object.prototype.hasOwnProperty.call(row, col)).toBe(true);
      }
    }
  });

  test('deterministic per (tenant, source, day, def-hash)', () => {
    const def: ReportDefinition = { source_id: 'mart.customer_360', limit: 50 };
    const r1 = executeReport(def, { tenant_id: 'BIL', now: NOW });
    const r2 = executeReport(def, { tenant_id: 'BIL', now: NOW });
    expect(r2.rows).toEqual(r1.rows);
    expect(r2.total_rows).toBe(r1.total_rows);
  });

  test('different tenant yields different rows', () => {
    const def: ReportDefinition = { source_id: 'mart.customer_360', limit: 30 };
    const bil = executeReport(def, { tenant_id: 'BIL', now: NOW });
    const bank = executeReport(def, { tenant_id: 'BANK_DEMO', now: NOW });
    // Same projection but different content (synthesis-key includes tenant).
    expect(bil.projection).toEqual(bank.projection);
    expect(bil.rows[0]).not.toEqual(bank.rows[0]);
  });

  test('different day yields different rows', () => {
    const def: ReportDefinition = { source_id: 'mart.customer_360', limit: 30 };
    const day1 = executeReport(def, { tenant_id: 'BIL', now: new Date('2026-05-20T12:00:00.000Z') });
    const day2 = executeReport(def, { tenant_id: 'BIL', now: new Date('2026-05-21T12:00:00.000Z') });
    expect(day2.rows[0]).not.toEqual(day1.rows[0]);
  });

  test('different definition (different filters) yields different rows even for same (tenant, day)', () => {
    const a: ReportDefinition = {
      source_id: 'mart.customer_360',
      filters: { op: 'eq', field: 'risk_level', value: 'High' },
      limit: 50,
    };
    const b: ReportDefinition = {
      source_id: 'mart.customer_360',
      filters: { op: 'eq', field: 'risk_level', value: 'Low' },
      limit: 50,
    };
    const rA = executeReport(a, { tenant_id: 'BIL', now: NOW });
    const rB = executeReport(b, { tenant_id: 'BIL', now: NOW });
    // Both filtered, but seeds differ via def-hash → different rows.
    expect(rA.rows).not.toEqual(rB.rows);
  });

  test('candidate_rows reflects pre-filter pool size', () => {
    const def: ReportDefinition = { source_id: 'mart.customer_360', limit: 100 };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    expect(r.candidate_rows).toBeGreaterThan(0);
    expect(r.candidate_rows).toBeLessThanOrEqual(10_000);
  });

  test('candidate_target option overrides default', () => {
    const def: ReportDefinition = { source_id: 'mart.customer_360', limit: 100 };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW, candidate_target: 50 });
    expect(r.candidate_rows).toBe(50);
  });
});

describe('executeReport — filter evaluation', () => {
  test('eq filter applied client-side', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      filters: { op: 'eq', field: 'risk_level', value: 'High' },
      limit: 100,
    };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    for (const row of r.rows) {
      expect(row.risk_level).toBe('High');
    }
  });

  test('gt filter on numeric field', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      filters: { op: 'gt', field: 'pd_score', value: 0.5 },
      limit: 100,
    };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    for (const row of r.rows) {
      expect(row.pd_score).toBeGreaterThan(0.5);
    }
  });

  test('between filter on integer field', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      filters: { op: 'between', field: 'bureau_score', value: [600, 700] },
      limit: 200,
    };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    for (const row of r.rows) {
      const s = row.bureau_score as number;
      expect(s).toBeGreaterThanOrEqual(600);
      expect(s).toBeLessThanOrEqual(700);
    }
  });

  test('AND of two leaves', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      filters: {
        op: 'AND',
        children: [
          { op: 'eq', field: 'risk_level', value: 'High' },
          { op: 'eq', field: 'has_npa', value: true },
        ],
      },
      limit: 100,
    };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    for (const row of r.rows) {
      expect(row.risk_level).toBe('High');
      expect(row.has_npa).toBe(true);
    }
  });

  test('OR of two leaves', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      filters: {
        op: 'OR',
        children: [
          { op: 'eq', field: 'risk_level', value: 'High' },
          { op: 'eq', field: 'risk_level', value: 'Medium' },
        ],
      },
      limit: 200,
    };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    for (const row of r.rows) {
      expect(['High', 'Medium']).toContain(row.risk_level);
    }
  });

  test('NOT inverts', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      filters: { op: 'NOT', child: { op: 'eq', field: 'risk_level', value: 'High' } },
      limit: 200,
    };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    for (const row of r.rows) {
      expect(row.risk_level).not.toBe('High');
    }
  });

  test('in filter accepts any of the values', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      filters: { op: 'in', field: 'risk_level', value: ['High', 'Medium'] },
      limit: 100,
    };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    for (const row of r.rows) {
      expect(['High', 'Medium']).toContain(row.risk_level);
    }
  });
});

describe('executeReport — aggregate', () => {
  test('GROUP BY risk_level COUNT(customer_id)', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      group_by: ['risk_level'],
      metrics: [{ field: 'customer_id', agg: 'COUNT' }],
    };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    expect(r.is_aggregate).toBe(true);
    // One row per distinct risk_level (3 enum values).
    expect(r.rows.length).toBeGreaterThanOrEqual(1);
    expect(r.rows.length).toBeLessThanOrEqual(3);
    for (const row of r.rows) {
      expect(['Low', 'Medium', 'High']).toContain(row.risk_level);
      expect(typeof row.count_customer_id).toBe('number');
    }
  });

  test('SUM with alias', () => {
    const def: ReportDefinition = {
      source_id: 'mart.loan_360',
      group_by: ['product_code'],
      metrics: [{ field: 'outstanding_balance', agg: 'SUM', alias: 'total_out' }],
    };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    expect(r.is_aggregate).toBe(true);
    for (const row of r.rows) {
      expect(typeof row.total_out).toBe('number');
      expect(row.total_out).toBeGreaterThanOrEqual(0);
    }
  });

  test('grand totals computed across groups', () => {
    const def: ReportDefinition = {
      source_id: 'mart.loan_360',
      group_by: ['product_code'],
      metrics: [{ field: 'outstanding_balance', agg: 'SUM', alias: 'total_out' }],
    };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    expect(r.aggregates.total_out).toBeGreaterThan(0);
    // Grand-total ≈ sum of per-group totals (within rounding).
    const sumOfGroups = r.rows.reduce((acc, row) => acc + (row.total_out as number), 0);
    expect(Math.abs(r.aggregates.total_out - sumOfGroups)).toBeLessThan(1);
  });

  test('DISTINCT_COUNT', () => {
    const def: ReportDefinition = {
      source_id: 'app_alerts.alerts',
      group_by: ['severity'],
      metrics: [{ field: 'customer_id', agg: 'DISTINCT_COUNT' }],
    };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    for (const row of r.rows) {
      expect(typeof row.distinct_count_customer_id).toBe('number');
    }
  });

  test('AVG returns mean per group', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      group_by: ['risk_level'],
      metrics: [{ field: 'pd_score', agg: 'AVG' }],
    };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    for (const row of r.rows) {
      const v = row.avg_pd_score as number;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test('MIN + MAX on integer field', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      group_by: ['risk_level'],
      metrics: [
        { field: 'bureau_score', agg: 'MIN' },
        { field: 'bureau_score', agg: 'MAX' },
      ],
    };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    for (const row of r.rows) {
      expect(row.min_bureau_score).toBeLessThanOrEqual(row.max_bureau_score as number);
    }
  });
});

describe('executeReport — sort', () => {
  test('ORDER BY pd_score DESC ranks rows', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      sort: [{ field: 'pd_score', direction: 'DESC' }],
      limit: 50,
    };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    for (let i = 1; i < r.rows.length; i++) {
      expect(r.rows[i - 1].pd_score as number).toBeGreaterThanOrEqual(r.rows[i].pd_score as number);
    }
  });

  test('ORDER BY field ASC ranks ascending', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      sort: [{ field: 'bureau_score', direction: 'ASC' }],
      limit: 30,
    };
    const r = executeReport(def, { tenant_id: 'BIL', now: NOW });
    for (let i = 1; i < r.rows.length; i++) {
      expect(r.rows[i - 1].bureau_score as number).toBeLessThanOrEqual(r.rows[i].bureau_score as number);
    }
  });
});

describe('executeReport — validation', () => {
  test('empty tenant_id throws', () => {
    expect(() =>
      executeReport({ source_id: 'mart.customer_360' }, { tenant_id: '' }),
    ).toThrow(ReportExecutionError);
  });

  test('unknown source throws', () => {
    expect(() =>
      executeReport({ source_id: 'mart.nope' }, { tenant_id: 'BIL' }),
    ).toThrow();
  });

  test('invalid filter (enum violation) throws', () => {
    expect(() =>
      executeReport(
        {
          source_id: 'mart.customer_360',
          filters: { op: 'eq', field: 'risk_level', value: 'Bogus' },
        },
        { tenant_id: 'BIL' },
      ),
    ).toThrow();
  });
});

// ─── CSV export ──────────────────────────────────────────────────────

describe('reportResultToCsv', () => {
  test('emits header row + body rows', () => {
    const def: ReportDefinition = { source_id: 'mart.customer_360', limit: 3 };
    const result = executeReport(def, { tenant_id: 'BIL', now: NOW });
    const csv = reportResultToCsv(result);
    const lines = csv.split('\r\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1 + result.rows.length);
    expect(lines[0]).toBe(result.projection.join(','));
  });

  test('escapes cells containing commas + quotes', () => {
    // Synthesise then mutate a cell to contain comma/quote/newline.
    const def: ReportDefinition = { source_id: 'mart.customer_360', limit: 1 };
    const result = executeReport(def, { tenant_id: 'BIL', now: NOW });
    result.rows[0].name = 'Smith, John "Big J"';
    const csv = reportResultToCsv(result);
    expect(csv).toContain('"Smith, John ""Big J"""');
  });

  test('null cells render as empty', () => {
    const def: ReportDefinition = { source_id: 'mart.customer_360', limit: 1 };
    const result = executeReport(def, { tenant_id: 'BIL', now: NOW });
    result.rows[0].closed_at = null;
    result.projection = ['closed_at'];
    const csv = reportResultToCsv(result);
    expect(csv.split('\r\n')[1]).toBe('');
  });

  test('non-string values JSON-stringified', () => {
    const def: ReportDefinition = { source_id: 'mart.customer_360', limit: 1 };
    const result = executeReport(def, { tenant_id: 'BIL', now: NOW });
    expect(typeof result.rows[0].bureau_score).toBe('number');
    const csv = reportResultToCsv(result);
    // Numeric cell renders without quotes.
    expect(csv).not.toContain('"' + result.rows[0].bureau_score);
  });

  test('empty rows still emit header + trailing newline', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      filters: { op: 'eq', field: 'risk_level', value: 'High' },
      limit: 0,
    };
    const result = executeReport(def, { tenant_id: 'BIL', now: NOW });
    // limit clamped to 1 so a row will exist; force empty for the test.
    result.rows = [];
    const csv = reportResultToCsv(result);
    expect(csv).toMatch(/\r\n$/);
  });
});

// ─── Route — POST /v1/reports/builder/run ─────────────────────────────

describe('POST /v1/reports/builder/run', () => {
  test('admin happy path returns rows + projection + sql', async () => {
    const { app } = makeExecApp('admin');
    const r = await request(app)
      .post('/v1/reports/builder/run')
      .set(TH_BIL)
      .send({
        source_id: 'mart.customer_360',
        filters: { op: 'eq', field: 'risk_level', value: 'High' },
        limit: 25,
      });
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.source_id).toBe('mart.customer_360');
    expect(Array.isArray(r.body.body.rows)).toBe(true);
    expect(Array.isArray(r.body.body.projection)).toBe(true);
    // Admin sees compiled SQL.
    expect(r.body.body.sql).toContain('SELECT');
  });

  test('analyst+ accepted', async () => {
    const { app } = makeExecApp('risk_analyst');
    const r = await request(app)
      .post('/v1/reports/builder/run')
      .set(TH_BIL)
      .send({ source_id: 'mart.customer_360' });
    expect(r.status).toBe(200);
    // Non-admin does NOT receive sql / params (info leak guard).
    expect(r.body.body.sql).toBeUndefined();
    expect(r.body.body.params).toBeUndefined();
  });

  test('unknown role → 403', async () => {
    const { app } = makeExecApp('unknown_role');
    const r = await request(app)
      .post('/v1/reports/builder/run')
      .set(TH_BIL)
      .send({ source_id: 'mart.customer_360' });
    expect(r.status).toBe(403);
  });

  test('unknown source → 400 EWS_400', async () => {
    const { app } = makeExecApp('admin');
    const r = await request(app)
      .post('/v1/reports/builder/run')
      .set(TH_BIL)
      .send({ source_id: 'mart.does_not_exist' });
    expect(r.status).toBe(400);
  });

  test('invalid filter → 400', async () => {
    const { app } = makeExecApp('admin');
    const r = await request(app)
      .post('/v1/reports/builder/run')
      .set(TH_BIL)
      .send({
        source_id: 'mart.customer_360',
        filters: { op: 'eq', field: 'risk_level', value: 'WRONG' },
      });
    expect(r.status).toBe(400);
  });

  test('no tenant header → 400', async () => {
    const { app } = makeExecApp('admin');
    const r = await request(app)
      .post('/v1/reports/builder/run')
      .send({ source_id: 'mart.customer_360' });
    expect(r.status).toBe(400);
  });

  test('cross-tenant header injection ignored (JWT/header wins)', async () => {
    const { app } = makeExecApp('admin');
    const r = await request(app)
      .post('/v1/reports/builder/run')
      .set(TH_BIL)
      .send({ source_id: 'mart.customer_360', tenant_id: 'BANK_DEMO' });
    expect(r.body.body.tenant_id).toBe('BIL');
  });
});

// ─── Route — POST /v1/reports/builder/saved/:id/run ───────────────────

describe('POST /v1/reports/builder/saved/:id/run', () => {
  test('runs the saved definition', async () => {
    const { app } = makeExecApp('admin');
    const saved = await request(app)
      .post('/v1/reports/builder/saved')
      .set({ ...TH_BIL, 'X-APEX-USER': 'alice' })
      .send({
        name: 'high-risk',
        definition: {
          source_id: 'mart.customer_360',
          filters: { op: 'eq', field: 'risk_level', value: 'High' },
        },
      });
    const id = saved.body.body.report_id;
    const r = await request(app)
      .post(`/v1/reports/builder/saved/${id}/run`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.source_id).toBe('mart.customer_360');
    for (const row of r.body.body.rows) {
      expect(row.risk_level).toBe('High');
    }
  });

  test('unknown saved report → 404', async () => {
    const { app } = makeExecApp('admin');
    const r = await request(app)
      .post('/v1/reports/builder/saved/does-not-exist/run')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('cross-tenant 404 — caller cannot run another tenant saved report', async () => {
    const { app } = makeExecApp('admin');
    const saved = await request(app)
      .post('/v1/reports/builder/saved')
      .set({ ...TH_BIL, 'X-APEX-USER': 'alice' })
      .send({ name: 'r', definition: { source_id: 'mart.customer_360' } });
    const id = saved.body.body.report_id;
    const r = await request(app)
      .post(`/v1/reports/builder/saved/${id}/run`)
      .set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

// ─── Route — POST /v1/reports/builder/export.csv ──────────────────────

describe('POST /v1/reports/builder/export.csv', () => {
  test('returns text/csv + Content-Disposition', async () => {
    const { app } = makeExecApp('admin');
    const r = await request(app)
      .post('/v1/reports/builder/export.csv')
      .set(TH_BIL)
      .send({
        source_id: 'mart.customer_360',
        filters: { op: 'eq', field: 'risk_level', value: 'High' },
        limit: 10,
      });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/attachment; filename=/);
    expect(r.text.split('\r\n')[0]).toBeTruthy();
  });

  test('csv body has projection header row + rows', async () => {
    const { app } = makeExecApp('admin');
    const r = await request(app)
      .post('/v1/reports/builder/export.csv')
      .set(TH_BIL)
      .send({ source_id: 'mart.customer_360', limit: 5 });
    const lines = r.text.split('\r\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(1);
  });

  test('unknown source → 400', async () => {
    const { app } = makeExecApp('admin');
    const r = await request(app)
      .post('/v1/reports/builder/export.csv')
      .set(TH_BIL)
      .send({ source_id: 'mart.does_not_exist' });
    expect(r.status).toBe(400);
  });

  test('unknown_role → 403', async () => {
    const { app } = makeExecApp('unknown_role');
    const r = await request(app)
      .post('/v1/reports/builder/export.csv')
      .set(TH_BIL)
      .send({ source_id: 'mart.customer_360' });
    expect(r.status).toBe(403);
  });
});
