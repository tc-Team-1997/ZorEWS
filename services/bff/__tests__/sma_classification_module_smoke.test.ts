// services/bff/__tests__/sma_classification_module_smoke.test.ts
//
// Module 2.4 — SMA Classification smoke (per the user playbook).
//
// 6 spec routes covered end-to-end:
//   GET  /v1/banking/sma/framework?framework=                  (M2.4 new — introspection)
//   GET  /v1/banking/sma/movements?date=&framework=            (pre-existing)
//   GET  /v1/banking/sma/drill?from=&to=&framework=            (pre-existing)
//   GET  /v1/banking/sma/sector-view?framework=                (pre-existing)
//   GET  /v1/banking/sma/trend?customer_id=&framework=         (pre-existing)
//   POST /v1/banking/sma/run-classification?framework=&customer_count= (M2.4 extended with optional cohort override)
//
// SPEC ACCEPTANCE — "Running classification on 10k accounts completes in
// <2 minutes; results match a hand-calculated control sample."
//
// We verify:
//   - 10k-account run wall-clock < 120_000 ms (with soft sanity < 5_000 ms)
//   - run envelope shape includes customers_evaluated=10_000 + by_category_count partition
//   - hand-calc control sample via `categoryForDpdFramework` matches expected
//     boundary semantics for each framework (RBI/RMA/CBK)

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  categoryForDpdFramework,
  FRAMEWORK_DEFINITIONS,
  ALL_FRAMEWORKS,
} from '../src/banking_sma';

const NOW = new Date('2026-05-24T12:00:00.000Z');
const HDR = {
  'x-tenant-id': 'BANK_DEMO',
  'x-channel': 'API',
  'x-apex-role': 'admin',
  'x-apex-user': 'admin',
};

function makeSmokeApp() {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
  });
}

let app: ReturnType<typeof makeSmokeApp>['app'];

beforeEach(() => {
  app = makeSmokeApp().app;
});

describe('M2.4 — SMA Classification smoke', () => {
  it('walks the full journey: framework → movements → drill → sector-view → trend', async () => {
    // 1. Framework introspection (M2.4 new) — active + 3 country definitions
    const fw = await request(app).get('/v1/banking/sma/framework').set(HDR);
    expect(fw.status).toBe(200);
    expect(fw.body.body.active_framework).toBe('RBI');
    expect(fw.body.body.active_definition).toMatchObject({
      code: 'RBI', regulator: 'Reserve Bank of India', country: 'India',
      sma1_min: 31, sma2_min: 61, npa_min: 91,
    });
    expect(fw.body.body.frameworks.map((f: { code: string }) => f.code)).toEqual(['RBI', 'RMA', 'CBK']);

    // Different framework via query
    const cbk = await request(app).get('/v1/banking/sma/framework?framework=CBK').set(HDR);
    expect(cbk.status).toBe(200);
    expect(cbk.body.body.active_framework).toBe('CBK');
    expect(cbk.body.body.active_definition).toMatchObject({
      country: 'Kenya', sma1_min: 31, sma2_min: 91, npa_min: 181,
    });

    // 2. Movements (pre-existing)
    const mov = await request(app).get('/v1/banking/sma/movements').set(HDR);
    expect(mov.status).toBe(200);
    expect(mov.body.body.framework).toBe('RBI');
    expect(['SMA-0', 'SMA-1', 'SMA-2', 'NPA'].every(
      (c) => typeof mov.body.body.by_category_count[c] === 'number',
    )).toBe(true);
    const movTotal =
      (mov.body.body.deteriorations ?? 0) +
      (mov.body.body.improvements ?? 0) +
      (mov.body.body.unchanged ?? 0);
    // direction partition matches total_movements (deteriorations + improvements + unchanged)
    expect(movTotal).toBeGreaterThanOrEqual(mov.body.body.total_movements);

    // 3. Drill (last 7 days)
    const drill = await request(app).get('/v1/banking/sma/drill').set(HDR);
    expect(drill.status).toBe(200);
    expect(typeof drill.body.body.total).toBe('number');
    if (drill.body.body.rows.length > 0) {
      expect(typeof drill.body.body.rows[0].reason).toBe('string');
    }

    // 4. Sector view
    const sec = await request(app).get('/v1/banking/sma/sector-view').set(HDR);
    expect(sec.status).toBe(200);
    expect(sec.body.body.total_sectors).toBeGreaterThan(0);
    expect(sec.body.body.sectors[0]).toMatchObject({
      sector: expect.any(String),
      by_category: expect.objectContaining({
        'SMA-0': expect.any(Number), 'SMA-1': expect.any(Number), 'SMA-2': expect.any(Number), NPA: expect.any(Number),
      }),
    });

    // 5. Trend for a known customer
    const trend = await request(app).get('/v1/banking/sma/trend?customer_id=c-100002').set(HDR);
    expect(trend.status).toBe(200);
    expect(trend.body.body.customer_id).toBe('c-100002');
    // Module uses `series` field (not `points`) — verify shape includes
    // the canonical trend envelope members.
    expect(Array.isArray(trend.body.body.series)).toBe(true);
    expect(['SMA-0', 'SMA-1', 'SMA-2', 'NPA']).toContain(trend.body.body.current_category);
    expect(['deteriorating', 'improving', 'stable']).toContain(trend.body.body.trend_direction);
  });

  // ── SPEC ACCEPTANCE: 10k accounts in <2 min, plus hand-calc control ──
  it('SPEC ACCEPTANCE: runs classification on 10k accounts in <2 minutes', async () => {
    const t0 = Date.now();
    const run = await request(app)
      .post('/v1/banking/sma/run-classification?customer_count=10000')
      .set(HDR);
    const elapsed = Date.now() - t0;

    expect(run.status).toBe(201);
    expect(run.body.body.customers_evaluated).toBe(10_000);
    expect(run.body.body.framework).toBe('RBI');
    expect(run.body.body.triggered_by).toBe('admin');
    expect(run.body.body.run_id).toMatch(/^sma-BANK_DEMO-/);

    // Bucket partition: every customer with dpd > 0 lands in one of SMA-0/1/2/NPA.
    const buckets = run.body.body.by_category_count;
    const sumBuckets = (buckets['SMA-0'] ?? 0) + (buckets['SMA-1'] ?? 0) + (buckets['SMA-2'] ?? 0) + (buckets.NPA ?? 0);
    expect(sumBuckets).toBeGreaterThan(0); // some customers have non-zero dpd
    expect(sumBuckets).toBeLessThanOrEqual(10_000);

    // Spec: <2 minutes hard ceiling. Soft sanity: <5s in CI so the BFF has
    // headroom for production queries against the real mart.
    expect(elapsed).toBeLessThan(120_000);
    expect(elapsed).toBeLessThan(5_000);
  });

  it('SPEC ACCEPTANCE: hand-calc DPD → category control sample matches per framework', () => {
    // RBI/RMA bands: SMA-0 1-30, SMA-1 31-60, SMA-2 61-90, NPA >= 91
    expect(FRAMEWORK_DEFINITIONS.RBI).toMatchObject({ sma1_min: 31, sma2_min: 61, npa_min: 91 });
    expect(FRAMEWORK_DEFINITIONS.RMA).toMatchObject({ sma1_min: 31, sma2_min: 61, npa_min: 91 });

    // Boundary semantics — at each band edge
    for (const fw of ['RBI', 'RMA'] as const) {
      expect(categoryForDpdFramework(0, fw)).toBe('SMA-0');   // current → still SMA-0 by convention
      expect(categoryForDpdFramework(30, fw)).toBe('SMA-0');  // 30 = top of SMA-0
      expect(categoryForDpdFramework(31, fw)).toBe('SMA-1');  // step into SMA-1
      expect(categoryForDpdFramework(60, fw)).toBe('SMA-1');  // top of SMA-1
      expect(categoryForDpdFramework(61, fw)).toBe('SMA-2');  // step into SMA-2
      expect(categoryForDpdFramework(90, fw)).toBe('SMA-2');  // top of SMA-2
      expect(categoryForDpdFramework(91, fw)).toBe('NPA');    // NPA
      expect(categoryForDpdFramework(365, fw)).toBe('NPA');
    }

    // CBK bands: SMA-0 1-30, SMA-1 31-90, SMA-2 91-180, NPA >= 181
    expect(FRAMEWORK_DEFINITIONS.CBK).toMatchObject({ sma1_min: 31, sma2_min: 91, npa_min: 181 });
    expect(categoryForDpdFramework(30, 'CBK')).toBe('SMA-0');
    expect(categoryForDpdFramework(31, 'CBK')).toBe('SMA-1');
    expect(categoryForDpdFramework(90, 'CBK')).toBe('SMA-1');  // CBK widens SMA-1 to 90
    expect(categoryForDpdFramework(91, 'CBK')).toBe('SMA-2');
    expect(categoryForDpdFramework(180, 'CBK')).toBe('SMA-2');
    expect(categoryForDpdFramework(181, 'CBK')).toBe('NPA');

    // Enum invariant — exactly 3 frameworks supported
    expect(ALL_FRAMEWORKS).toEqual(['RBI', 'RMA', 'CBK']);
  });

  it('Framework switching: movements honour ?framework= override', async () => {
    const rbi = await request(app).get('/v1/banking/sma/movements?framework=RBI').set(HDR);
    expect(rbi.body.body.framework).toBe('RBI');

    const cbk = await request(app).get('/v1/banking/sma/movements?framework=CBK').set(HDR);
    expect(cbk.body.body.framework).toBe('CBK');

    // Sector view + drill + trend also honour framework
    for (const path of [
      '/v1/banking/sma/sector-view?framework=CBK',
      '/v1/banking/sma/drill?framework=CBK',
      '/v1/banking/sma/trend?customer_id=c-100002&framework=CBK',
    ]) {
      const r = await request(app).get(path).set(HDR);
      expect(r.status).toBe(200);
      expect(r.body.body.framework).toBe('CBK');
    }
  });

  it('400 paths: invalid framework / invalid date / missing customer_id / invalid customer_count', async () => {
    // Invalid framework token
    const badFw = await request(app).get('/v1/banking/sma/framework?framework=ZZZ').set(HDR);
    expect(badFw.status).toBe(400);

    // Invalid date
    const badDate = await request(app).get('/v1/banking/sma/movements?date=not-a-date').set(HDR);
    expect(badDate.status).toBe(400);

    // Trend missing customer_id
    const trendMiss = await request(app).get('/v1/banking/sma/trend').set(HDR);
    expect(trendMiss.status).toBe(400);
    expect(trendMiss.body.error.code).toBe('EWS_400_missing_customer_id');

    // Run-classification with non-numeric customer_count
    const runBad = await request(app)
      .post('/v1/banking/sma/run-classification?customer_count=NaN')
      .set(HDR);
    expect(runBad.status).toBe(400);
  });

  it('RBAC: unknown role fails closed on all M2.4 routes; run-classification needs rules:retire (admin)', async () => {
    const viewer = { ...HDR, 'x-apex-role': 'viewer' };

    // Read routes — fail closed on customers:read_risk_profile
    for (const path of [
      '/v1/banking/sma/framework',
      '/v1/banking/sma/movements',
      '/v1/banking/sma/drill',
      '/v1/banking/sma/sector-view',
      '/v1/banking/sma/trend?customer_id=c-100002',
    ]) {
      const r = await request(app).get(path).set(viewer);
      expect(r.status).toBe(403);
    }

    // Run-classification — rules:retire (admin/supervisor only); risk_analyst forbidden
    const analyst = await request(app)
      .post('/v1/banking/sma/run-classification')
      .set({ ...HDR, 'x-apex-role': 'risk_analyst' });
    expect(analyst.status).toBe(403);
  });

  it('Tenant gate: refuses without X-Tenant-ID + X-Channel; audit fan-out on run-classification', async () => {
    const noTen = await request(app).get('/v1/banking/sma/framework');
    expect([400, 401, 403]).toContain(noTen.status);

    // Run-classification with cohort=200 (default) — verify audit event is recorded
    const run = await request(app)
      .post('/v1/banking/sma/run-classification?customer_count=200')
      .set(HDR);
    expect(run.status).toBe(201);
    const runId = run.body.body.run_id;

    // Audit list returns {items, page, page_size, total}. Filter by action;
    // resource_id isn't a filter axis on the M15.1 list endpoint, so we
    // pull the action group and match the run_id client-side.
    const audit = await request(app)
      .get('/v1/audit/events?action=sma.run_classification&page_size=50')
      .set(HDR);
    expect(audit.status).toBe(200);
    expect(audit.body.body.total).toBeGreaterThanOrEqual(1);
    const match = audit.body.body.items.find(
      (e: { resource_id?: string }) => e.resource_id === runId,
    );
    expect(match).toBeDefined();
    expect(match).toMatchObject({
      actor_username: 'admin',
      action: 'sma.run_classification',
      outcome: 'success',
    });
    expect(match.metadata).toMatchObject({
      framework: 'RBI',
      customers_evaluated: 200,
    });
  });
});
