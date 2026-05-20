// services/bff/__tests__/reports_builder_filter.test.ts
//
// T4.6.2 — Self-service reporting: filter compiler.

import request from 'supertest';
import {
  DEFAULT_LIMIT,
  FilterCompilerError,
  MAX_LIMIT,
  compileReportDefinition,
  type FilterNode,
  type ReportDefinition,
} from '../src/reports/builder_filter';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeFilterApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Basic compile ────────────────────────────────────────────────────

describe('compileReportDefinition basic', () => {
  test('raw row-list (no group_by, no metrics) projects all source fields', () => {
    const def: ReportDefinition = { source_id: 'mart.customer_360' };
    const c = compileReportDefinition(def, { tenant_id: 'BIL' });
    expect(c.is_aggregate).toBe(false);
    expect(c.sql).toMatch(/^SELECT customer_id/);
    expect(c.sql).toMatch(/FROM mart\.customer_360/);
    expect(c.sql).toMatch(/WHERE tenant_id = :tenant_id/);
    expect(c.sql).toMatch(/LIMIT :limit/);
    expect(c.params.tenant_id).toBe('BIL');
    expect(c.params.limit).toBe(DEFAULT_LIMIT);
  });

  test('tenant_scoped source auto-injects WHERE tenant_id', () => {
    const c = compileReportDefinition(
      { source_id: 'app_alerts.alerts' },
      { tenant_id: 'BANK_DEMO' },
    );
    expect(c.sql).toContain('tenant_id = :tenant_id');
    expect(c.params.tenant_id).toBe('BANK_DEMO');
  });

  test('limit clamped to MAX_LIMIT', () => {
    const c = compileReportDefinition(
      { source_id: 'mart.customer_360', limit: 99999 },
      { tenant_id: 'BIL' },
    );
    expect(c.params.limit).toBe(MAX_LIMIT);
  });

  test('limit clamped to min 1', () => {
    const c = compileReportDefinition(
      { source_id: 'mart.customer_360', limit: 0 },
      { tenant_id: 'BIL' },
    );
    expect(c.params.limit).toBe(1);
  });

  test('missing source_id throws', () => {
    expect(() =>
      compileReportDefinition({ source_id: '' }, { tenant_id: 'BIL' }),
    ).toThrow(FilterCompilerError);
  });

  test('unknown source_id throws', () => {
    expect(() =>
      compileReportDefinition({ source_id: 'mart.nope' }, { tenant_id: 'BIL' }),
    ).toThrow();
  });

  test('missing tenant_id throws', () => {
    expect(() =>
      compileReportDefinition({ source_id: 'mart.customer_360' }, { tenant_id: '' }),
    ).toThrow(FilterCompilerError);
  });
});

// ─── Leaf comparison ops ──────────────────────────────────────────────

describe('leaf comparison ops', () => {
  test('eq on enum field', () => {
    const f: FilterNode = { op: 'eq', field: 'risk_level', value: 'High' };
    const c = compileReportDefinition(
      { source_id: 'mart.customer_360', filters: f },
      { tenant_id: 'BIL' },
    );
    expect(c.sql).toContain('risk_level = :p0');
    expect(c.params.p0).toBe('High');
  });

  test('lt on integer field', () => {
    const f: FilterNode = { op: 'lt', field: 'bureau_score', value: 600 };
    const c = compileReportDefinition(
      { source_id: 'mart.customer_360', filters: f },
      { tenant_id: 'BIL' },
    );
    expect(c.sql).toContain('bureau_score < :p0');
    expect(c.params.p0).toBe(600);
  });

  test('ge on number field', () => {
    const f: FilterNode = { op: 'ge', field: 'utilization', value: 0.8 };
    const c = compileReportDefinition(
      { source_id: 'mart.customer_360', filters: f },
      { tenant_id: 'BIL' },
    );
    expect(c.sql).toContain('utilization >= :p0');
  });

  test('eq on boolean field', () => {
    const f: FilterNode = { op: 'eq', field: 'has_npa', value: true };
    const c = compileReportDefinition(
      { source_id: 'mart.customer_360', filters: f },
      { tenant_id: 'BIL' },
    );
    expect(c.sql).toContain('has_npa = :p0');
    expect(c.params.p0).toBe(true);
  });

  test('lt on date field accepts ISO YYYY-MM-DD', () => {
    const f: FilterNode = { op: 'lt', field: 'onboarded_at', value: '2026-01-01' };
    const c = compileReportDefinition(
      { source_id: 'mart.customer_360', filters: f },
      { tenant_id: 'BIL' },
    );
    expect(c.sql).toContain('onboarded_at < :p0');
  });

  test('is_null / is_not_null take no value', () => {
    const c1 = compileReportDefinition(
      {
        source_id: 'app_cases.cases',
        filters: { op: 'is_null', field: 'closed_at' },
      },
      { tenant_id: 'BIL' },
    );
    expect(c1.sql).toContain('closed_at IS NULL');
    expect(c1.params).not.toHaveProperty('p0');

    const c2 = compileReportDefinition(
      {
        source_id: 'app_cases.cases',
        filters: { op: 'is_not_null', field: 'closed_at' },
      },
      { tenant_id: 'BIL' },
    );
    expect(c2.sql).toContain('closed_at IS NOT NULL');
  });

  test('in on array of values', () => {
    const f: FilterNode = { op: 'in', field: 'risk_level', value: ['Low', 'Medium'] };
    const c = compileReportDefinition(
      { source_id: 'mart.customer_360', filters: f },
      { tenant_id: 'BIL' },
    );
    expect(c.sql).toContain('risk_level IN (:p0, :p1)');
    expect(c.params.p0).toBe('Low');
    expect(c.params.p1).toBe('Medium');
  });

  test('not_in works like in', () => {
    const f: FilterNode = { op: 'not_in', field: 'status', value: ['closed'] };
    const c = compileReportDefinition(
      { source_id: 'app_alerts.alerts', filters: f },
      { tenant_id: 'BIL' },
    );
    expect(c.sql).toContain('status NOT IN (:p0)');
  });

  test('between on integer field', () => {
    const f: FilterNode = { op: 'between', field: 'bureau_score', value: [500, 700] };
    const c = compileReportDefinition(
      { source_id: 'mart.customer_360', filters: f },
      { tenant_id: 'BIL' },
    );
    expect(c.sql).toContain('bureau_score BETWEEN :p0 AND :p1');
    expect(c.params.p0).toBe(500);
    expect(c.params.p1).toBe(700);
  });
});

// ─── Composite AND/OR/NOT ────────────────────────────────────────────

describe('composite filter trees', () => {
  test('AND of two leaves', () => {
    const f: FilterNode = {
      op: 'AND',
      children: [
        { op: 'eq', field: 'risk_level', value: 'High' },
        { op: 'gt', field: 'utilization', value: 0.7 },
      ],
    };
    const c = compileReportDefinition(
      { source_id: 'mart.customer_360', filters: f },
      { tenant_id: 'BIL' },
    );
    expect(c.sql).toContain('(risk_level = :p0 AND utilization > :p1)');
  });

  test('OR of two leaves', () => {
    const f: FilterNode = {
      op: 'OR',
      children: [
        { op: 'eq', field: 'risk_level', value: 'High' },
        { op: 'eq', field: 'has_npa', value: true },
      ],
    };
    const c = compileReportDefinition(
      { source_id: 'mart.customer_360', filters: f },
      { tenant_id: 'BIL' },
    );
    expect(c.sql).toContain('(risk_level = :p0 OR has_npa = :p1)');
  });

  test('nested AND of OR + leaf', () => {
    const f: FilterNode = {
      op: 'AND',
      children: [
        {
          op: 'OR',
          children: [
            { op: 'eq', field: 'risk_level', value: 'High' },
            { op: 'eq', field: 'risk_level', value: 'Medium' },
          ],
        },
        { op: 'ge', field: 'utilization', value: 0.5 },
      ],
    };
    const c = compileReportDefinition(
      { source_id: 'mart.customer_360', filters: f },
      { tenant_id: 'BIL' },
    );
    // Outer AND wraps inner OR + leaf.
    expect(c.sql).toMatch(/\(\(risk_level = :p0 OR risk_level = :p1\) AND utilization >= :p2\)/);
  });

  test('NOT wraps inner expression', () => {
    const f: FilterNode = {
      op: 'NOT',
      child: { op: 'eq', field: 'risk_level', value: 'Low' },
    };
    const c = compileReportDefinition(
      { source_id: 'mart.customer_360', filters: f },
      { tenant_id: 'BIL' },
    );
    expect(c.sql).toContain('(NOT risk_level = :p0)');
  });

  test('empty AND children throws', () => {
    const f: FilterNode = { op: 'AND', children: [] };
    expect(() =>
      compileReportDefinition({ source_id: 'mart.customer_360', filters: f }, { tenant_id: 'BIL' }),
    ).toThrow();
  });

  test('> 20 AND children throws', () => {
    const f: FilterNode = {
      op: 'AND',
      children: Array.from({ length: 21 }, (_, i) => ({
        op: 'eq' as const,
        field: 'risk_level',
        value: 'High',
      })),
    };
    expect(() =>
      compileReportDefinition({ source_id: 'mart.customer_360', filters: f }, { tenant_id: 'BIL' }),
    ).toThrow();
  });
});

// ─── Validation rejections ───────────────────────────────────────────

describe('validation rejections', () => {
  test('unknown field throws', () => {
    const f: FilterNode = { op: 'eq', field: 'does_not_exist', value: 'x' };
    expect(() =>
      compileReportDefinition({ source_id: 'mart.customer_360', filters: f }, { tenant_id: 'BIL' }),
    ).toThrow(FilterCompilerError);
  });

  test('enum-violation throws', () => {
    const f: FilterNode = { op: 'eq', field: 'risk_level', value: 'Unknown' };
    let caught: FilterCompilerError | null = null;
    try {
      compileReportDefinition({ source_id: 'mart.customer_360', filters: f }, { tenant_id: 'BIL' });
    } catch (e) {
      caught = e as FilterCompilerError;
    }
    expect(caught?.code).toBe('enum_violation');
  });

  test('type-mismatch (string into integer field)', () => {
    const f: FilterNode = { op: 'eq', field: 'bureau_score', value: 'high' };
    let caught: FilterCompilerError | null = null;
    try {
      compileReportDefinition({ source_id: 'mart.customer_360', filters: f }, { tenant_id: 'BIL' });
    } catch (e) {
      caught = e as FilterCompilerError;
    }
    expect(caught?.code).toBe('invalid_value');
  });

  test('non-integer into integer field', () => {
    const f: FilterNode = { op: 'eq', field: 'bureau_score', value: 3.14 };
    expect(() =>
      compileReportDefinition({ source_id: 'mart.customer_360', filters: f }, { tenant_id: 'BIL' }),
    ).toThrow();
  });

  test('null value in comparison throws (use is_null instead)', () => {
    const f: FilterNode = { op: 'eq', field: 'risk_level', value: null };
    expect(() =>
      compileReportDefinition({ source_id: 'mart.customer_360', filters: f }, { tenant_id: 'BIL' }),
    ).toThrow();
  });

  test('in with empty array throws', () => {
    const f: FilterNode = { op: 'in', field: 'risk_level', value: [] };
    expect(() =>
      compileReportDefinition({ source_id: 'mart.customer_360', filters: f }, { tenant_id: 'BIL' }),
    ).toThrow();
  });

  test('between with non-array throws', () => {
    const f: FilterNode = { op: 'between', field: 'bureau_score', value: 500 };
    expect(() =>
      compileReportDefinition({ source_id: 'mart.customer_360', filters: f }, { tenant_id: 'BIL' }),
    ).toThrow();
  });

  test('between on enum field throws', () => {
    const f: FilterNode = {
      op: 'between',
      field: 'risk_level',
      value: ['Low', 'High'],
    };
    expect(() =>
      compileReportDefinition({ source_id: 'mart.customer_360', filters: f }, { tenant_id: 'BIL' }),
    ).toThrow();
  });

  test('lt on string field throws', () => {
    const f: FilterNode = { op: 'lt', field: 'customer_id', value: 'CUST-001' };
    expect(() =>
      compileReportDefinition({ source_id: 'mart.customer_360', filters: f }, { tenant_id: 'BIL' }),
    ).toThrow();
  });
});

// ─── Aggregate reports ───────────────────────────────────────────────

describe('aggregate reports (group_by + metrics)', () => {
  test('group_by + COUNT metric', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      group_by: ['risk_level'],
      metrics: [{ field: 'customer_id', agg: 'COUNT' }],
    };
    const c = compileReportDefinition(def, { tenant_id: 'BIL' });
    expect(c.is_aggregate).toBe(true);
    expect(c.sql).toContain('SELECT risk_level, COUNT(customer_id)');
    expect(c.sql).toContain('GROUP BY risk_level');
    expect(c.projection).toEqual(['risk_level', 'count_customer_id']);
  });

  test('SUM on number field', () => {
    const def: ReportDefinition = {
      source_id: 'mart.loan_360',
      group_by: ['product_code'],
      metrics: [{ field: 'outstanding_balance', agg: 'SUM', alias: 'total_outstanding' }],
    };
    const c = compileReportDefinition(def, { tenant_id: 'BIL' });
    expect(c.sql).toContain('SUM(outstanding_balance) AS total_outstanding');
    expect(c.projection).toContain('total_outstanding');
  });

  test('DISTINCT_COUNT', () => {
    const def: ReportDefinition = {
      source_id: 'app_alerts.alerts',
      group_by: ['severity'],
      metrics: [{ field: 'customer_id', agg: 'DISTINCT_COUNT' }],
    };
    const c = compileReportDefinition(def, { tenant_id: 'BIL' });
    expect(c.sql).toContain('COUNT(DISTINCT customer_id)');
  });

  test('SUM on non-numeric field throws', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      group_by: ['risk_level'],
      metrics: [{ field: 'name', agg: 'SUM' }],
    };
    expect(() => compileReportDefinition(def, { tenant_id: 'BIL' })).toThrow();
  });

  test('aggregate without metrics throws', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      group_by: ['risk_level'],
    };
    expect(() => compileReportDefinition(def, { tenant_id: 'BIL' })).toThrow();
  });

  test('group_by on non-groupable field throws', () => {
    // name is groupable:false in catalog
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      group_by: ['name'],
      metrics: [{ field: 'customer_id', agg: 'COUNT' }],
    };
    expect(() => compileReportDefinition(def, { tenant_id: 'BIL' })).toThrow();
  });
});

// ─── Sort ────────────────────────────────────────────────────────────

describe('sort', () => {
  test('ORDER BY field DESC', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      sort: [{ field: 'pd_score', direction: 'DESC' }],
    };
    const c = compileReportDefinition(def, { tenant_id: 'BIL' });
    expect(c.sql).toContain('ORDER BY pd_score DESC');
  });

  test('multi-column sort', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      sort: [
        { field: 'risk_level', direction: 'ASC' },
        { field: 'pd_score', direction: 'DESC' },
      ],
    };
    const c = compileReportDefinition(def, { tenant_id: 'BIL' });
    expect(c.sql).toContain('ORDER BY risk_level ASC, pd_score DESC');
  });

  test('sort on metric alias for aggregate report', () => {
    const def: ReportDefinition = {
      source_id: 'mart.loan_360',
      group_by: ['product_code'],
      metrics: [{ field: 'outstanding_balance', agg: 'SUM', alias: 'total_out' }],
      sort: [{ field: 'total_out', direction: 'DESC' }],
    };
    const c = compileReportDefinition(def, { tenant_id: 'BIL' });
    expect(c.sql).toContain('ORDER BY total_out DESC');
  });

  test('sort on unknown field throws', () => {
    const def: ReportDefinition = {
      source_id: 'mart.customer_360',
      sort: [{ field: 'unknown_field', direction: 'ASC' }],
    };
    expect(() => compileReportDefinition(def, { tenant_id: 'BIL' })).toThrow();
  });

  test('invalid sort direction throws', () => {
    const def = {
      source_id: 'mart.customer_360',
      sort: [{ field: 'pd_score', direction: 'WRONG' as 'ASC' }],
    };
    expect(() => compileReportDefinition(def, { tenant_id: 'BIL' })).toThrow();
  });
});

// ─── Safety ──────────────────────────────────────────────────────────

describe('safety invariants', () => {
  test('every compiled SQL starts with SELECT', () => {
    const c = compileReportDefinition({ source_id: 'mart.customer_360' }, { tenant_id: 'BIL' });
    expect(c.sql.trimStart().toUpperCase()).toMatch(/^SELECT/);
  });

  test('every compiled SQL contains tenant_id when tenant_scoped', () => {
    const c = compileReportDefinition({ source_id: 'mart.customer_360' }, { tenant_id: 'BIL' });
    expect(c.sql).toContain('tenant_id = :tenant_id');
  });

  test('every compiled SQL contains LIMIT', () => {
    const c = compileReportDefinition({ source_id: 'mart.customer_360' }, { tenant_id: 'BIL' });
    expect(c.sql).toMatch(/LIMIT :limit/);
  });

  test('params record contains tenant_id + limit', () => {
    const c = compileReportDefinition({ source_id: 'mart.customer_360' }, { tenant_id: 'BIL' });
    expect(c.params.tenant_id).toBe('BIL');
    expect(c.params.limit).toBe(DEFAULT_LIMIT);
  });

  test('compiled SQL has no DDL/DML keywords', () => {
    const c = compileReportDefinition(
      {
        source_id: 'mart.customer_360',
        filters: { op: 'eq', field: 'risk_level', value: 'High' },
      },
      { tenant_id: 'BIL' },
    );
    expect(c.sql).not.toMatch(/INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE/i);
  });
});

// ─── Route ────────────────────────────────────────────────────────────

describe('POST /v1/reports/builder/preview route', () => {
  test('admin happy path returns sql + params + projection', async () => {
    const { app } = makeFilterApp('admin');
    const r = await request(app)
      .post('/v1/reports/builder/preview')
      .set(TH_BIL)
      .send({
        source_id: 'mart.customer_360',
        filters: { op: 'eq', field: 'risk_level', value: 'High' },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.sql).toContain('mart.customer_360');
    expect(r.body.body.params.p0).toBe('High');
    expect(r.body.body.is_aggregate).toBe(false);
    expect(Array.isArray(r.body.body.projection)).toBe(true);
  });

  test('analyst+ accepted', async () => {
    const { app } = makeFilterApp('risk_analyst');
    const r = await request(app)
      .post('/v1/reports/builder/preview')
      .set(TH_BIL)
      .send({ source_id: 'mart.customer_360' });
    expect(r.status).toBe(200);
  });

  test('unknown role → 403', async () => {
    const { app } = makeFilterApp('unknown_role');
    const r = await request(app)
      .post('/v1/reports/builder/preview')
      .set(TH_BIL)
      .send({ source_id: 'mart.customer_360' });
    expect(r.status).toBe(403);
  });

  test('unknown source → 404', async () => {
    const { app } = makeFilterApp('admin');
    const r = await request(app)
      .post('/v1/reports/builder/preview')
      .set(TH_BIL)
      .send({ source_id: 'mart.does_not_exist' });
    expect(r.status).toBe(404);
    expect(r.body.error?.code).toMatch(/EWS_404/);
  });

  test('invalid filter (enum violation) → 400', async () => {
    const { app } = makeFilterApp('admin');
    const r = await request(app)
      .post('/v1/reports/builder/preview')
      .set(TH_BIL)
      .send({
        source_id: 'mart.customer_360',
        filters: { op: 'eq', field: 'risk_level', value: 'Wrong' },
      });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('EWS_400_enum_violation');
  });

  test('tenant header always injected into params (caller cannot override)', async () => {
    const { app } = makeFilterApp('admin');
    const r = await request(app)
      .post('/v1/reports/builder/preview')
      .set(TH_BIL)
      .send({
        source_id: 'mart.customer_360',
        // Caller attempts to pass tenant_id in body — should be ignored.
        tenant_id: 'BANK_DEMO',
      });
    expect(r.body.body.params.tenant_id).toBe('BIL');
  });
});
