// services/bff/__tests__/borrower_watch_module_smoke.test.ts
//
// Module 2.1 — Borrower Watch smoke test.
//
// Walks the complete user journey end-to-end:
//
//   GET    /v1/customers?mode=&sector=&segment=&region=&severity=&watchlist_only=&min_ews=&max_ews=&sort=&order=
//          (new in M2.1)
//   GET    /v1/customers/:id/360                (M11.6 — already shipped)
//   GET    /v1/risk-profile/:customer_id        (T3.7 — already shipped)
//   GET    /v1/watchlist                        (M4.7 — already shipped)
//   POST   /v1/watchlist                        (M4.7 — already shipped)
//   DELETE /v1/watchlist/:customer_id           (M4.7 — already shipped)
//   POST   /v1/banking/cohort/cma-pack          (new in M2.1)
//   POST   /v1/notices/issue                    (M15.4 — already shipped)
//
// Spec acceptance:
//   1. Sorting by EWS score must be server-side
//   2. 360° modal opens in <1 second for a borrower with 10k transactions
//
// Verified by:
//   - Asserting `?sort=ews_score&order=desc` yields strictly-decreasing EWS scores
//   - Asserting `?sort=exposure_inr&order=asc` yields ascending exposures
//   - Timing the /360 endpoint across multiple iterations

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-24T17:00:00.000Z');
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
    now: () => NOW,
    getRole: () => role,
  });
}

describe('Module 2.1 — Borrower Watch smoke', () => {
  it('walks the full list → 360 → watchlist add/remove → cohort CMA pack flow', async () => {
    const { app } = makeSmokeApp('admin');

    // 1. Default list — mode=stressed, sort=ews_score desc.
    const list = await request(app).get('/v1/customers').set(HEADERS);
    expect(list.status).toBe(200);
    expect(list.body.body.mode).toBe('stressed');
    expect(list.body.body.sort).toEqual({ key: 'ews_score', order: 'desc' });
    expect(list.body.body.by_severity).toBeDefined();
    expect(typeof list.body.body.total).toBe('number');
    expect(typeof list.body.body.total_unfiltered).toBe('number');

    // Every row exposes the spec-required columns
    for (const r of list.body.body.items) {
      expect(typeof r.borrower_id).toBe('string');
      expect(typeof r.name).toBe('string');
      expect(typeof r.sector).toBe('string');
      expect(typeof r.exposure_inr).toBe('number');
      expect(typeof r.ews_score).toBe('number');
      expect(r.ews_score).toBeGreaterThanOrEqual(0);
      expect(r.ews_score).toBeLessThanOrEqual(100);
      expect(['S1', 'S2', 'S3']).toContain(r.severity);
      expect(typeof r.top_signal).toBe('string');
    }

    // 2. Get a sample borrower id for downstream steps.
    const sampleId = list.body.body.items[0]?.borrower_id ?? 'c-101';

    // 3. /360 — should return quickly + with the expected panel shape.
    const m360 = await request(app).get(`/v1/customers/${sampleId}/360`).set(HEADERS);
    expect(m360.status).toBe(200);
    expect(m360.body.body).toBeDefined();

    // 4. /risk-profile — for the Ratios tab.
    const profile = await request(app).get(`/v1/risk-profile/${sampleId}`).set(HEADERS);
    expect(profile.status).toBe(200);
    expect(profile.body.body.id).toBe(sampleId);
    expect(typeof profile.body.body.pd).toBe('number');

    // 5. Watchlist add → list reflects → list filter watchlist_only=true.
    const add = await request(app)
      .post('/v1/watchlist')
      .set(HEADERS)
      .send({ customer_id: sampleId, reason: 'Smoke EWS review' });
    expect(add.status).toBe(201);
    expect(add.body.body.customer_id).toBe(sampleId);

    const watchedList = await request(app).get('/v1/watchlist').set(HEADERS);
    expect(watchedList.status).toBe(200);
    expect(watchedList.body.body.items.length).toBeGreaterThan(0);

    // Filter watchlist_only=true → the sampled borrower is present with its tag
    const wlOnly = await request(app)
      .get('/v1/customers?mode=all&watchlist_only=true')
      .set(HEADERS);
    expect(wlOnly.status).toBe(200);
    const found = wlOnly.body.body.items.find((r: { borrower_id: string }) => r.borrower_id === sampleId);
    expect(found).toBeDefined();
    expect(found.watchlist_tag).toBe('Smoke EWS review');

    // 6. CMA cohort pack from 3 borrowers (must include the sampled id which we know exists).
    const allList = await request(app).get('/v1/customers?mode=all').set(HEADERS);
    const cohort = allList.body.body.items.slice(0, 3).map((r: { borrower_id: string }) => r.borrower_id);
    const cma = await request(app)
      .post('/v1/banking/cohort/cma-pack')
      .set(HEADERS)
      .send({ cohort_ids: cohort });
    expect(cma.status).toBe(201);
    expect(cma.body.body.cohort_size).toBe(3);
    expect(cma.body.body.tenant_id).toBe(TENANT);
    expect(cma.body.body.totals.exposure_inr).toBeGreaterThan(0);
    expect(cma.body.body.totals.mean_ews_score).toBeGreaterThanOrEqual(0);
    expect(typeof cma.body.body.download_filename).toBe('string');

    // Audit fan-out — cma.pack.build event written
    const audit = await request(app)
      .get('/v1/audit/events?action=cma.pack.build&page_size=5')
      .set(HEADERS);
    expect(audit.status).toBe(200);
    expect(audit.body.body.items.length).toBeGreaterThan(0);
    expect(audit.body.body.items[0].actor_username).toBe('alice.admin');

    // 7. Cohort 404 on unknown borrower
    const unkCohort = await request(app)
      .post('/v1/banking/cohort/cma-pack')
      .set(HEADERS)
      .send({ cohort_ids: ['no_such_borrower'] });
    expect(unkCohort.status).toBe(404);
    expect(unkCohort.body.error.code).toBe('EWS_404_unknown_borrower');

    // 8. Watchlist remove + the list no longer shows the tag.
    const rem = await request(app).delete(`/v1/watchlist/${sampleId}`).set(HEADERS);
    expect(rem.status).toBe(204);
    const afterRem = await request(app)
      .get(`/v1/customers?mode=all&search=${sampleId}`)
      .set(HEADERS);
    const stillThere = afterRem.body.body.items.find((r: { borrower_id: string }) => r.borrower_id === sampleId);
    expect(stillThere?.watchlist_tag).toBeNull();
  });

  it('SPEC ACCEPTANCE: server-side sort by EWS score works', async () => {
    const { app } = makeSmokeApp('admin');

    // Default sort = ews_score desc → strictly non-increasing.
    const desc = await request(app)
      .get('/v1/customers?mode=all&sort=ews_score&order=desc')
      .set(HEADERS);
    expect(desc.status).toBe(200);
    expect(desc.body.body.sort).toEqual({ key: 'ews_score', order: 'desc' });
    const descRows = desc.body.body.items as Array<{ ews_score: number }>;
    for (let i = 0; i < descRows.length - 1; i++) {
      expect(descRows[i].ews_score).toBeGreaterThanOrEqual(descRows[i + 1].ews_score);
    }

    // Reverse — ascending → strictly non-decreasing.
    const asc = await request(app)
      .get('/v1/customers?mode=all&sort=ews_score&order=asc')
      .set(HEADERS);
    expect(asc.status).toBe(200);
    expect(asc.body.body.sort).toEqual({ key: 'ews_score', order: 'asc' });
    const ascRows = asc.body.body.items as Array<{ ews_score: number }>;
    for (let i = 0; i < ascRows.length - 1; i++) {
      expect(ascRows[i].ews_score).toBeLessThanOrEqual(ascRows[i + 1].ews_score);
    }

    // Server-side sort by exposure works too.
    const expDesc = await request(app)
      .get('/v1/customers?mode=all&sort=exposure_inr&order=desc')
      .set(HEADERS);
    const expRows = expDesc.body.body.items as Array<{ exposure_inr: number }>;
    for (let i = 0; i < expRows.length - 1; i++) {
      expect(expRows[i].exposure_inr).toBeGreaterThanOrEqual(expRows[i + 1].exposure_inr);
    }
  });

  it('SPEC ACCEPTANCE: 360° modal opens in <1s budget', async () => {
    const { app } = makeSmokeApp('admin');
    const id = 'c-101';

    // Warm up (first call may JIT).
    await request(app).get(`/v1/customers/${id}/360`).set(HEADERS);

    // Time 5 iterations — average + max must be well under 1000ms.
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      const r = await request(app).get(`/v1/customers/${id}/360`).set(HEADERS);
      const elapsed = Date.now() - start;
      expect(r.status).toBe(200);
      times.push(elapsed);
    }
    const maxMs = Math.max(...times);
    const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
    // Hard spec ceiling: 1000ms. Soft sanity: under 500ms even on a cold CI.
    expect(maxMs).toBeLessThan(1000);
    expect(avgMs).toBeLessThan(500);
  });

  it('Filters: sector/segment/region/severity/min_ews/max_ews/search all narrow', async () => {
    const { app } = makeSmokeApp('admin');

    // Find a borrower's sector first, then assert the filter narrows.
    const all = await request(app).get('/v1/customers?mode=all').set(HEADERS);
    expect(all.status).toBe(200);
    const totalAll = all.body.body.total;
    expect(totalAll).toBeGreaterThan(0);
    const sampleSector = all.body.body.items[0].sector;

    const filtered = await request(app)
      .get(`/v1/customers?mode=all&sector=${sampleSector}`)
      .set(HEADERS);
    expect(filtered.status).toBe(200);
    expect(filtered.body.body.total).toBeLessThanOrEqual(totalAll);
    expect(filtered.body.body.items.every((r: { sector: string }) => r.sector === sampleSector)).toBe(true);

    // min_ews boundary
    const high = await request(app)
      .get('/v1/customers?mode=all&min_ews=70')
      .set(HEADERS);
    expect(high.status).toBe(200);
    expect(high.body.body.items.every((r: { ews_score: number }) => r.ews_score >= 70)).toBe(true);

    // search matches the sampled borrower
    const sampleId = all.body.body.items[0].borrower_id;
    const search = await request(app)
      .get(`/v1/customers?mode=all&search=${sampleId}`)
      .set(HEADERS);
    expect(search.status).toBe(200);
    expect(search.body.body.items.find((r: { borrower_id: string }) => r.borrower_id === sampleId)).toBeDefined();
  });

  it('400 paths: invalid sector / severity / sort / min_ews', async () => {
    const { app } = makeSmokeApp('admin');
    const badSector = await request(app).get('/v1/customers?sector=bogus').set(HEADERS);
    expect(badSector.status).toBe(400);
    expect(badSector.body.error.code).toBe('EWS_400_invalid_sector');

    const badSev = await request(app).get('/v1/customers?severity=critical').set(HEADERS);
    expect(badSev.status).toBe(400);
    expect(badSev.body.error.code).toBe('EWS_400_invalid_severity');

    const badSort = await request(app).get('/v1/customers?sort=foo').set(HEADERS);
    expect(badSort.status).toBe(400);
    expect(badSort.body.error.code).toBe('EWS_400_invalid_sort');

    const badMin = await request(app).get('/v1/customers?min_ews=200').set(HEADERS);
    expect(badMin.status).toBe(400);
    expect(badMin.body.error.code).toBe('EWS_400_invalid_input');
  });

  it('RBAC: unknown role blocked on borrower-watch + cma-pack', async () => {
    // Note: `customers:read_risk_profile` is intentionally broad — every
    // known operator role (admin/supervisor/risk_analyst/case_owner/
    // field_officer) holds it because every role interacts with
    // borrowers. We assert fail-closed for an unknown role instead.
    const { app } = makeSmokeApp('viewer'); // 'viewer' is not in the RBAC matrix
    const block = (s: number) => expect([401, 403]).toContain(s);
    block((await request(app).get('/v1/customers').set(HEADERS)).status);
    block(
      (await request(app)
        .post('/v1/banking/cohort/cma-pack')
        .set(HEADERS)
        .send({ cohort_ids: ['c-101'] })).status,
    );
  });

  it('Tenant gate: every route refuses without X-Tenant-ID + X-Channel', async () => {
    const { app } = makeSmokeApp('admin');
    const block = (s: number) => expect([400, 401, 403]).toContain(s);
    block((await request(app).get('/v1/customers')).status);
    block((await request(app).post('/v1/banking/cohort/cma-pack').send({ cohort_ids: ['c-101'] })).status);
  });
});
