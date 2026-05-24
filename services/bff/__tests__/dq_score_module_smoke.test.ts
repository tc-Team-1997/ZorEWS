// services/bff/__tests__/dq_score_module_smoke.test.ts
//
// Module 1.7 — Data Quality Score smoke test.
//
// Walks the complete user journey end-to-end:
//
//   GET  /v1/dq/dashboard          → score_overlay overlay (new in M1.7)
//   GET  /v1/dq/by-source/:id      → composite + 30d trend (new in M1.7)
//   GET  /v1/dq/by-attribute       → per-attribute drill (new in M1.7)
//   GET  /v1/dq/executions         → rule execution log (pre-existing)
//   GET  /v1/dq/executions/:id     → single execution (pre-existing)
//
// Plus the spec acceptance:
//   - composite score is reproducible (deterministic per (tenant, source, day))
//   - weight of each dimension is configurable in Thresholds & Limits
//     (the M13.1 admin config under `scoring.dq.dimension_weights`)
//
// Verified by:
//   1. Calling /v1/dq/by-source twice → identical composite_score
//   2. Reading the source detail dimension scores
//   3. PUT /v1/admin/config/scoring.dq.dimension_weights → set timeliness=1, others=0
//   4. Refetch /v1/dq/by-source → composite_score now equals the timeliness raw score

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryConfigStore } from '../src/admin_config';

const NOW = new Date('2026-05-24T16:00:00.000Z');
const TENANT = 'BANK_DEMO';
const HEADERS = {
  'X-Tenant-ID': TENANT,
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
};

function makeSmokeApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    configStore: new InMemoryConfigStore(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('Module 1.7 — Data Quality Score smoke', () => {
  it('walks the full dashboard → by-source → by-attribute flow', async () => {
    const { app } = makeSmokeApp('admin');

    // 1. Dashboard — must carry the new `score_overlay` field per spec.
    const dash = await request(app).get('/v1/dq/dashboard').set(HEADERS);
    expect(dash.status).toBe(200);
    const overlay = dash.body.body.score_overlay;
    expect(overlay).toBeDefined();
    expect(typeof overlay.fleet_composite_score).toBe('number');
    expect(overlay.fleet_composite_score).toBeGreaterThanOrEqual(60);
    expect(overlay.fleet_composite_score).toBeLessThanOrEqual(99);
    expect(overlay.by_source).toHaveLength(6); // 6 monitored sources
    expect(overlay.weights).toEqual({
      completeness: 0.30, validity: 0.30, consistency: 0.15, uniqueness: 0.15, timeliness: 0.10,
    });
    expect(overlay.worst_source).toBeDefined();
    expect(overlay.best_source).toBeDefined();
    expect(overlay.worst_source.composite_score).toBeLessThanOrEqual(overlay.best_source.composite_score);

    // 2. by-source — composite + dimensions + 30d trend.
    const source = await request(app).get('/v1/dq/by-source/cbs_loans?window=7').set(HEADERS);
    expect(source.status).toBe(200);
    expect(source.body.body.score.source_id).toBe('cbs_loans');
    expect(source.body.body.score.dimensions).toHaveLength(5);
    expect(source.body.body.trend.window_days).toBe(7);
    expect(source.body.body.trend.trend).toHaveLength(7);
    const firstTrend = source.body.body.trend.trend[0];
    expect(firstTrend.dimensions.completeness).toBeGreaterThan(0);

    // Bad window → 400
    const badWin = await request(app).get('/v1/dq/by-source/cbs_loans?window=999').set(HEADERS);
    expect(badWin.status).toBe(400);
    expect(badWin.body.error.code).toBe('EWS_400_invalid_window');

    // Unknown source → 404
    const unkSrc = await request(app).get('/v1/dq/by-source/no_such').set(HEADERS);
    expect(unkSrc.status).toBe(404);
    expect(unkSrc.body.error.code).toBe('EWS_404_unknown_source');

    // 3. by-attribute — all attributes for a source.
    const attrs = await request(app)
      .get('/v1/dq/by-attribute?source_id=cbs_loans')
      .set(HEADERS);
    expect(attrs.status).toBe(200);
    expect(attrs.body.body.total).toBeGreaterThan(0);
    expect(attrs.body.body.items[0].composite_score).toBeGreaterThanOrEqual(60);
    expect(attrs.body.body.items[0].dimensions).toHaveLength(5);

    // by-attribute with specific attribute filter
    const oneAttr = await request(app)
      .get('/v1/dq/by-attribute?source_id=cbs_loans&attribute=loan_id')
      .set(HEADERS);
    expect(oneAttr.status).toBe(200);
    expect(oneAttr.body.body.total).toBe(1);
    expect(oneAttr.body.body.items[0].attribute).toBe('loan_id');

    // Missing source_id → 400
    const noSrc = await request(app).get('/v1/dq/by-attribute').set(HEADERS);
    expect(noSrc.status).toBe(400);
    expect(noSrc.body.error.code).toBe('EWS_400_invalid_input');

    // Unknown attribute → 404
    const unkAttr = await request(app)
      .get('/v1/dq/by-attribute?source_id=cbs_loans&attribute=no_such')
      .set(HEADERS);
    expect(unkAttr.status).toBe(404);
    expect(unkAttr.body.error.code).toBe('EWS_404_unknown_attribute');
  });

  it('SPEC ACCEPTANCE: composite score is reproducible (deterministic per (tenant, source, day))', async () => {
    const { app } = makeSmokeApp('admin');

    const a = await request(app).get('/v1/dq/by-source/cbs_loans?window=1').set(HEADERS);
    const b = await request(app).get('/v1/dq/by-source/cbs_loans?window=1').set(HEADERS);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    // The composite must be byte-identical between calls on the same (tenant, day).
    expect(a.body.body.score.composite_score).toBe(b.body.body.score.composite_score);

    // Every dimension score is identical too.
    for (let i = 0; i < 5; i++) {
      expect(a.body.body.score.dimensions[i].score).toBe(b.body.body.score.dimensions[i].score);
      expect(a.body.body.score.dimensions[i].dimension).toBe(b.body.body.score.dimensions[i].dimension);
    }

    // Reproducibility extends to attribute scores.
    const attrA = await request(app).get('/v1/dq/by-attribute?source_id=mart_customer_360').set(HEADERS);
    const attrB = await request(app).get('/v1/dq/by-attribute?source_id=mart_customer_360').set(HEADERS);
    expect(attrA.body.body.items.map((a: { composite_score: number }) => a.composite_score))
      .toEqual(attrB.body.body.items.map((a: { composite_score: number }) => a.composite_score));
  });

  it('SPEC ACCEPTANCE: dimension weights are configurable via Thresholds & Limits (M13.1)', async () => {
    const { app } = makeSmokeApp('admin');

    // Baseline composite with default weights.
    const before = await request(app).get('/v1/dq/by-source/cbs_loans?window=1').set(HEADERS);
    expect(before.status).toBe(200);
    const beforeComposite = before.body.body.score.composite_score;
    const timelinessScore = before.body.body.score.dimensions.find(
      (d: { dimension: string }) => d.dimension === 'timeliness',
    ).score;

    // Override weights via M13.1 admin config — set timeliness=1.0, others=0.
    const put = await request(app)
      .put('/v1/admin/config/scoring.dq.dimension_weights')
      .set(HEADERS)
      .send({
        value: {
          completeness: 0,
          validity: 0,
          consistency: 0,
          uniqueness: 0,
          timeliness: 1.0,
        },
      });
    expect(put.status).toBe(200);

    // After override the composite should equal the timeliness raw score.
    const after = await request(app).get('/v1/dq/by-source/cbs_loans?window=1').set(HEADERS);
    expect(after.status).toBe(200);
    const afterComposite = after.body.body.score.composite_score;
    expect(afterComposite).toBe(timelinessScore);
    expect(after.body.body.weights).toEqual({
      completeness: 0, validity: 0, consistency: 0, uniqueness: 0, timeliness: 1.0,
    });
    // Composite changed (unless the default-weight composite equals the
    // timeliness raw score by coincidence, which is extremely unlikely).
    expect(afterComposite).not.toBe(beforeComposite);

    // Dashboard reflects the new weights too.
    const dashAfter = await request(app).get('/v1/dq/dashboard').set(HEADERS);
    expect(dashAfter.status).toBe(200);
    expect(dashAfter.body.body.score_overlay.weights.timeliness).toBe(1.0);
    expect(dashAfter.body.body.score_overlay.weights.completeness).toBe(0);
  });

  it('GET /v1/dq/executions — pre-existing route still works (backward-compat)', async () => {
    const { app } = makeSmokeApp('admin');
    const r = await request(app).get('/v1/dq/executions').set(HEADERS);
    expect(r.status).toBe(200);
    // Empty store → no executions, but the envelope shape is present.
    expect(r.body.body).toHaveProperty('items');
    expect(Array.isArray(r.body.body.items)).toBe(true);
  });

  it('RBAC: field_officer blocked on every dq route', async () => {
    const { app } = makeSmokeApp('field_officer');
    const block = (s: number) => expect([401, 403]).toContain(s);
    block((await request(app).get('/v1/dq/dashboard').set(HEADERS)).status);
    block((await request(app).get('/v1/dq/by-source/cbs_loans').set(HEADERS)).status);
    block((await request(app).get('/v1/dq/by-attribute?source_id=cbs_loans').set(HEADERS)).status);
    block((await request(app).get('/v1/dq/executions').set(HEADERS)).status);
  });

  it('Tenant gate: every route refuses without X-Tenant-ID + X-Channel', async () => {
    const { app } = makeSmokeApp('admin');
    const block = (s: number) => expect([400, 401, 403]).toContain(s);
    block((await request(app).get('/v1/dq/dashboard')).status);
    block((await request(app).get('/v1/dq/by-source/cbs_loans')).status);
    block((await request(app).get('/v1/dq/by-attribute?source_id=cbs_loans')).status);
  });
});
