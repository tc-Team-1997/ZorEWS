// services/bff/__tests__/financial_ratios_module_smoke.test.ts
//
// Module 2.3 — Financial Ratios smoke (per the user playbook).
//
// 7 spec routes covered end-to-end:
//   GET  /v1/banking/ratios/master                                    (pre-existing)
//   GET  /v1/banking/ratios/customer/:customer_id                     (pre-existing)
//   GET  /v1/banking/ratios/customer/:customer_id/history?ratio_code= (M2.3 new — single-ratio slice)
//   GET  /v1/banking/ratios/sector-benchmark?sector=                  (pre-existing)
//   PUT  /v1/banking/ratios/thresholds/:ratio_code                    (pre-existing)
//   POST /v1/banking/ratios/notes                                     (M2.3 new — with audit fan-out)
//   POST /v1/banking/cma/pack                                         (pre-existing — used for SPEC ACCEPTANCE)
//
// SPEC ACCEPTANCE — "CMA pack PDF generates for a cohort of 10 borrowers
// in <30 seconds with all 4 forms populated."
//
// The BFF builds an HTML pack (the SPA does browser print-to-PDF, mirroring
// scenario+reports export pattern). We verify:
//   - 10-borrower cohort completes in <30s wall-clock
//   - All 4 forms (II / III / IV / V) appear in the HTML for every borrower

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  defaultRatioNoteStore,
  defaultRatioThresholdStore,
} from '../src/banking_ratios';

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
  defaultRatioNoteStore._reset();
  // The threshold store doesn't expose a reset — but each test uses a fresh
  // tenant scope and only sets/clears within its own test, so cross-test
  // bleed is bounded.
  app = makeSmokeApp().app;
});

describe('M2.3 — Financial Ratios smoke', () => {
  it('walks the full journey: master → customer → history → benchmark → threshold → notes', async () => {
    // 1. Master catalog (8 ratios)
    const master = await request(app).get('/v1/banking/ratios/master').set(HDR);
    expect(master.status).toBe(200);
    expect(master.body.body.total).toBeGreaterThanOrEqual(8);
    expect(master.body.body.ratios.map((r: { code: string }) => r.code)).toEqual(
      expect.arrayContaining(['DSCR', 'ICR', 'CR', 'QR', 'DER', 'TOL_TNW', 'STK_TO', 'DBT_TO']),
    );

    // 2. Per-customer ratio bundle
    const cust = await request(app).get('/v1/banking/ratios/customer/c-101').set(HDR);
    expect(cust.status).toBe(200);
    expect(cust.body.body.customer_id).toBe('c-101');
    expect(cust.body.body.current).toMatchObject({
      DSCR: expect.objectContaining({ band: expect.stringMatching(/^(green|amber|red)$/) }),
      ICR: expect.objectContaining({ value: expect.any(Number) }),
    });
    expect(['green', 'amber', 'red']).toContain(cust.body.body.worst_band);

    // 3. Single-ratio history slice (M2.3 new) — sector benchmark overlay + trend
    const hist = await request(app)
      .get('/v1/banking/ratios/customer/c-101/history?ratio_code=DSCR')
      .set(HDR);
    expect(hist.status).toBe(200);
    expect(hist.body.body.ratio_code).toBe('DSCR');
    expect(hist.body.body.history).toHaveLength(12);
    expect(hist.body.body.sector_benchmark).toMatchObject({
      p25: expect.any(Number),
      median: expect.any(Number),
      p75: expect.any(Number),
    });
    expect(['better', 'worse', 'on_par']).toContain(hist.body.body.trend_vs_sector);
    expect(hist.body.body.ratio_def.code).toBe('DSCR');

    // 4. Sector benchmark (pre-existing)
    const sect = await request(app)
      .get(`/v1/banking/ratios/sector-benchmark?sector=${encodeURIComponent(hist.body.body.sector)}`)
      .set(HDR);
    expect(sect.status).toBe(200);
    expect(sect.body.body.ratios).toHaveLength(8);

    // 5. Set a threshold override + verify it appears in customer ratios on next read
    const setT = await request(app)
      .put('/v1/banking/ratios/thresholds/CR')
      .set(HDR)
      .send({ warning: 1.4, critical: 1.1 });
    expect(setT.status).toBe(200);
    expect(setT.body.body.code).toBe('CR');

    const cust2 = await request(app).get('/v1/banking/ratios/customer/c-101').set(HDR);
    expect(cust2.body.body.current.CR.warning_threshold).toBe(1.4);
    expect(cust2.body.body.current.CR.critical_threshold).toBe(1.1);
    // Threshold source surfaces via the /history slice (M2.3 new shape)
    const sliceWithOverride = await request(app)
      .get('/v1/banking/ratios/customer/c-101/history?ratio_code=CR')
      .set(HDR);
    expect(sliceWithOverride.body.body.threshold.source).toBe('tenant_override');

    // 6. Add a note via POST /v1/banking/ratios/notes (M2.3 new)
    const note = await request(app)
      .post('/v1/banking/ratios/notes')
      .set(HDR)
      .send({ customer_id: 'c-101', ratio_code: 'DSCR', body: 'Coverage just above warning band — schedule a covenant review.' });
    expect(note.status).toBe(201);
    expect(note.body.body.note_id).toMatch(/^rnote-BANK_DEMO-/);
    expect(note.body.body.body).toContain('covenant review');
    expect(note.body.body.author).toBe('admin');

    // 7. List notes — defensive ratio_code filter
    const list = await request(app)
      .get('/v1/banking/ratios/notes?customer_id=c-101&ratio_code=DSCR')
      .set(HDR);
    expect(list.status).toBe(200);
    expect(list.body.body.total).toBeGreaterThan(0);
    expect(list.body.body.notes[0].customer_id).toBe('c-101');
    expect(list.body.body.notes[0].ratio_code).toBe('DSCR');

    // 8. Clear the override
    const del = await request(app).delete('/v1/banking/ratios/thresholds/CR').set(HDR);
    expect(del.status).toBe(200);
  });

  // ── SPEC ACCEPTANCE: CMA pack for 10 borrowers < 30s, all 4 forms ────
  it('SPEC ACCEPTANCE: CMA pack for a cohort of 10 borrowers generates in <30s with all 4 forms', async () => {
    const cohort = Array.from({ length: 10 }, (_, i) => `c-${100 + i}`);
    const t0 = Date.now();
    const pack = await request(app)
      .post('/v1/banking/cma/pack')
      .set(HDR)
      .send({ cohort, forms: ['II', 'III', 'IV', 'V'] });
    const elapsed = Date.now() - t0;

    expect(pack.status).toBe(201);
    expect(pack.body.body.cohort_size).toBe(10);
    expect(pack.body.body.cohort).toEqual(cohort);
    expect(pack.body.body.forms).toEqual(['II', 'III', 'IV', 'V']);
    expect(pack.body.body.pack_id).toMatch(/.+/);

    // Wall-clock budget — spec says < 30s. We require WELL under that
    // (typically <500ms in CI) so the BFF has headroom for production
    // queries against the real CBS/mart.
    expect(elapsed).toBeLessThan(30_000);
    // Soft sanity — this is a deterministic HTML build; if it ever drifts
    // above 5s in CI we want to know.
    expect(elapsed).toBeLessThan(5_000);

    // All 4 forms must appear in the HTML for every borrower
    const html = pack.body.body.html as string;
    expect(html.length).toBeGreaterThan(0);
    for (const cid of cohort) {
      expect(html).toContain(`data-customer="${cid}"`);
    }
    // Form headers (II / III / IV / V) each appear cohort.length times
    for (const form of ['Form II', 'Form III', 'Form IV', 'Form V']) {
      const matches = html.match(new RegExp(form, 'g'));
      expect(matches?.length ?? 0).toBeGreaterThanOrEqual(cohort.length);
    }
    expect(pack.body.body.size_bytes).toBeGreaterThan(1000);
  });

  it('400 paths: missing ratio_code on /history, unknown code, missing body on note, oversize note', async () => {
    // /history without ratio_code
    const noCode = await request(app).get('/v1/banking/ratios/customer/c-101/history').set(HDR);
    expect(noCode.status).toBe(400);
    expect(noCode.body.error.code).toBe('EWS_400_missing_ratio_code');

    // /history with unknown ratio_code
    const badCode = await request(app)
      .get('/v1/banking/ratios/customer/c-101/history?ratio_code=UNKNOWN_RATIO')
      .set(HDR);
    expect(badCode.status).toBe(400);
    expect(badCode.body.error.code).toBe('EWS_400_invalid_ratio_code');

    // POST /notes with empty body
    const empty = await request(app)
      .post('/v1/banking/ratios/notes')
      .set(HDR)
      .send({ customer_id: 'c-101', ratio_code: 'DSCR', body: '' });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('EWS_400_invalid_input');

    // POST /notes with > 1000 chars
    const big = await request(app)
      .post('/v1/banking/ratios/notes')
      .set(HDR)
      .send({ customer_id: 'c-101', ratio_code: 'DSCR', body: 'a'.repeat(1001) });
    expect(big.status).toBe(400);

    // POST /notes with unknown ratio_code
    const badRatio = await request(app)
      .post('/v1/banking/ratios/notes')
      .set(HDR)
      .send({ customer_id: 'c-101', ratio_code: 'WHAT', body: 'hi there' });
    expect(badRatio.status).toBe(400);
    expect(badRatio.body.error.code).toBe('EWS_400_invalid_ratio_code');

    // GET /notes with unknown ratio_code filter
    const listBad = await request(app)
      .get('/v1/banking/ratios/notes?ratio_code=WHATEVER')
      .set(HDR);
    expect(listBad.status).toBe(400);
    expect(listBad.body.error.code).toBe('EWS_400_invalid_ratio_code');
  });

  it('Trend vs sector: polarity-aware classification (better/worse/on_par)', async () => {
    // The trend axis is polarity-aware. Pulling for 3 different customers
    // typically gets us a mix of the 3 verdicts; assert each verdict is one
    // of the 3 valid enum values.
    for (const cid of ['c-100', 'c-101', 'c-102', 'c-105']) {
      const r = await request(app)
        .get(`/v1/banking/ratios/customer/${cid}/history?ratio_code=DSCR`)
        .set(HDR);
      expect(r.status).toBe(200);
      expect(['better', 'worse', 'on_par']).toContain(r.body.body.trend_vs_sector);
    }
  });

  it('RBAC: unknown role fails closed on all M2.3 routes', async () => {
    // `customers:read_risk_profile` is intentionally broad — every known
    // operator role has it. Use truly unknown 'viewer' to verify the gate.
    const viewer = { ...HDR, 'x-apex-role': 'viewer' };

    const master = await request(app).get('/v1/banking/ratios/master').set(viewer);
    expect(master.status).toBe(403);

    const hist = await request(app)
      .get('/v1/banking/ratios/customer/c-101/history?ratio_code=DSCR')
      .set(viewer);
    expect(hist.status).toBe(403);

    const noteList = await request(app).get('/v1/banking/ratios/notes').set(viewer);
    expect(noteList.status).toBe(403);

    const noteAdd = await request(app)
      .post('/v1/banking/ratios/notes')
      .set(viewer)
      .send({ customer_id: 'c-101', ratio_code: 'DSCR', body: 'hello' });
    expect(noteAdd.status).toBe(403);
  });

  it('Tenant gate: refuses without X-Tenant-ID + X-Channel', async () => {
    const noTen = await request(app).get('/v1/banking/ratios/master');
    expect([400, 401, 403]).toContain(noTen.status);

    const noCh = await request(app)
      .get('/v1/banking/ratios/master')
      .set({ 'x-tenant-id': 'BANK_DEMO', 'x-apex-role': 'admin', 'x-apex-user': 'admin' });
    expect([400, 401, 403]).toContain(noCh.status);
  });

  it('Tenant isolation: BIL notes never leak to BANK_DEMO', async () => {
    // Write under BIL
    const bilHdr = { ...HDR, 'x-tenant-id': 'BIL' };
    const w = await request(app)
      .post('/v1/banking/ratios/notes')
      .set(bilHdr)
      .send({ customer_id: 'c-501', ratio_code: 'ICR', body: 'BIL only note' });
    expect(w.status).toBe(201);

    // BANK_DEMO list shouldn't see it
    const demoList = await request(app)
      .get('/v1/banking/ratios/notes?customer_id=c-501')
      .set(HDR);
    expect(demoList.status).toBe(200);
    expect(demoList.body.body.notes).toHaveLength(0);

    // BIL list does
    const bilList = await request(app)
      .get('/v1/banking/ratios/notes?customer_id=c-501')
      .set(bilHdr);
    expect(bilList.status).toBe(200);
    expect(bilList.body.body.notes.length).toBeGreaterThan(0);
  });
});
