// services/bff/__tests__/reports_builder_smoke.test.ts
//
// T4.6.7 — Self-service reporting: end-to-end integration smoke.
//
// Walks the complete builder flow against the live BFF + in-memory
// SavedReportStore singleton. Mirrors the user-facing journey a partner
// would script in Postman: list sources → preview compile → run ad-hoc
// → save → list saved → run saved → patch → export CSV → delete. This
// is the contract-level proof that the 10 T4.6.1–T4.6.4 routes compose
// cleanly with no cross-route coupling drift.
//
// The individual route unit tests already cover edge cases in
// reports_builder_{catalog,filter,store,execute}.test.ts — this file
// owns the happy-path orchestration.

import request from 'supertest';
import { _resetDefaultSavedReportStore } from '../src/reports/builder_store';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T12:00:00.000Z');
const TENANT = 'BIL';
const HEADERS = {
  'X-Tenant-ID': TENANT,
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
};
const HEADERS_BANK = {
  ...HEADERS,
  'X-Tenant-ID': 'BANK_DEMO',
};

function makeSmokeApp(role: string = 'admin') {
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

// Definition shape per FilterNode discriminated union in builder_filter.ts:
// {op: 'AND'|'OR', children: []} | {op: 'NOT', child} | {op: <leaf>, field, value?}
const SIMPLE_DEF = {
  source_id: 'mart.customer_360',
  filters: {
    op: 'AND' as const,
    children: [
      { op: 'eq' as const, field: 'risk_level', value: 'High' },
    ],
  },
  limit: 50,
};

// Empty-filter definition — omit filters entirely (validator rejects
// {op:'AND',children:[]} as a malformed empty AND).
const EMPTY_DEF = {
  source_id: 'mart.customer_360',
  limit: 10,
};

describe('T4.6.7 — reports builder end-to-end smoke', () => {
  test('admin walks the full ad-hoc + saved + export flow', async () => {
    const { app } = makeSmokeApp('admin');

    // 1. List sources catalog.
    const r1 = await request(app)
      .get('/v1/reports/builder/sources')
      .set(HEADERS);
    expect(r1.status).toBe(200);
    expect(r1.body.body.total_sources).toBeGreaterThanOrEqual(2);
    expect(
      r1.body.body.sources.some((s: { source_id: string }) => s.source_id === 'mart.customer_360'),
    ).toBe(true);

    // 2. Get one source detail.
    const r2 = await request(app)
      .get('/v1/reports/builder/sources/mart.customer_360')
      .set(HEADERS);
    expect(r2.status).toBe(200);
    expect(r2.body.body.source_id).toBe('mart.customer_360');
    expect(Array.isArray(r2.body.body.fields)).toBe(true);

    // 3. Preview compile (no execution).
    const r3 = await request(app)
      .post('/v1/reports/builder/preview')
      .set(HEADERS)
      .set('Content-Type', 'application/json')
      .send(SIMPLE_DEF);
    expect(r3.status).toBe(200);
    expect(r3.body.body.sql).toContain('SELECT');
    expect(r3.body.body.params.tenant_id).toBe(TENANT);

    // 4. Run ad-hoc (no save).
    const r4 = await request(app)
      .post('/v1/reports/builder/run')
      .set(HEADERS)
      .send(SIMPLE_DEF);
    expect(r4.status).toBe(200);
    expect(r4.body.body.rows.length).toBeGreaterThanOrEqual(0);
    expect(r4.body.body.tenant_id).toBe(TENANT);

    // 5. Save the report.
    const r5 = await request(app)
      .post('/v1/reports/builder/saved')
      .set(HEADERS)
      .send({
        name: 'High-risk customers (smoke)',
        description: 'PD > 0.5 + risk_level=High',
        visibility: 'private',
        definition: SIMPLE_DEF,
        tags: ['risk', 'smoke'],
      });
    expect(r5.status).toBe(201);
    const reportId = r5.body.body.report_id;
    expect(reportId).toMatch(/^rpt-BIL-/);
    expect(r5.body.body.created_by).toBe('alice.admin');

    // 6. List saved reports — our new row is visible.
    const r6 = await request(app)
      .get('/v1/reports/builder/saved')
      .set(HEADERS);
    expect(r6.status).toBe(200);
    expect(r6.body.body.total).toBeGreaterThanOrEqual(1);
    expect(
      r6.body.body.reports.some((row: { report_id: string }) => row.report_id === reportId),
    ).toBe(true);

    // 7. Get single saved.
    const r7 = await request(app)
      .get(`/v1/reports/builder/saved/${reportId}`)
      .set(HEADERS);
    expect(r7.status).toBe(200);
    expect(r7.body.body.report_id).toBe(reportId);

    // 8. Patch saved (rename + retag).
    const r8 = await request(app)
      .patch(`/v1/reports/builder/saved/${reportId}`)
      .set(HEADERS)
      .send({ name: 'High-risk customers (renamed)', tags: ['risk', 'smoke', 'watchlist'] });
    expect(r8.status).toBe(200);
    expect(r8.body.body.name).toBe('High-risk customers (renamed)');
    expect(r8.body.body.tags).toContain('watchlist');

    // 9. Run saved.
    const r9 = await request(app)
      .post(`/v1/reports/builder/saved/${reportId}/run`)
      .set(HEADERS);
    expect(r9.status).toBe(200);
    expect(r9.body.body.source_id).toBe('mart.customer_360');

    // 10. Export ad-hoc CSV.
    const r10 = await request(app)
      .post('/v1/reports/builder/export.csv')
      .set(HEADERS)
      .send(SIMPLE_DEF);
    expect(r10.status).toBe(200);
    expect(r10.headers['content-type']).toMatch(/^text\/csv/);
    expect(r10.headers['content-disposition']).toContain('attachment');
    // CSV body always carries at least a header row.
    expect(r10.text.length).toBeGreaterThan(0);

    // 11. Delete saved.
    const r11 = await request(app)
      .delete(`/v1/reports/builder/saved/${reportId}`)
      .set(HEADERS);
    expect(r11.status).toBe(204);

    // 12. Confirm deletion via GET — 404.
    const r12 = await request(app)
      .get(`/v1/reports/builder/saved/${reportId}`)
      .set(HEADERS);
    expect(r12.status).toBe(404);
    expect(r12.body.error?.code).toBe('EWS_404_unknown_report');
  });

  test('non-admin cannot save visibility=role without reports:share', async () => {
    const { app } = makeSmokeApp('risk_analyst');
    const r = await request(app)
      .post('/v1/reports/builder/saved')
      .set(HEADERS)
      .send({
        name: 'Risk analyst role-shared report',
        visibility: 'role',
        visible_to_roles: ['risk_analyst'],
        definition: EMPTY_DEF,
      });
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe('EWS_403_missing_scope');
  });

  test('analyst CAN save private + tenant-shared reports', async () => {
    const { app } = makeSmokeApp('risk_analyst');
    const rPrivate = await request(app)
      .post('/v1/reports/builder/saved')
      .set(HEADERS)
      .send({ name: 'analyst private', visibility: 'private', definition: EMPTY_DEF });
    expect(rPrivate.status).toBe(201);

    const rTenant = await request(app)
      .post('/v1/reports/builder/saved')
      .set(HEADERS)
      .send({ name: 'analyst tenant', visibility: 'tenant', definition: EMPTY_DEF });
    expect(rTenant.status).toBe(201);
  });

  test('cross-tenant access blocked — BANK_DEMO admin cannot read BIL saved report', async () => {
    const { app } = makeSmokeApp('admin');

    const r1 = await request(app)
      .post('/v1/reports/builder/saved')
      .set(HEADERS)
      .send({
        name: 'BIL-only',
        visibility: 'tenant',
        definition: EMPTY_DEF,
      });
    expect(r1.status).toBe(201);
    const reportId = r1.body.body.report_id;

    // BANK_DEMO admin — 404 (not 403) per the existence-probe guard.
    const r2 = await request(app)
      .get(`/v1/reports/builder/saved/${reportId}`)
      .set(HEADERS_BANK);
    expect(r2.status).toBe(404);
    expect(r2.body.error?.code).toBe('EWS_404_unknown_report');
  });
});
