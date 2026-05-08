// services/bff/__tests__/analytics_pd_distribution.test.ts
//
// T4.1 4c — PD Distribution sub-dashboard. Three layers:
//   1. Pure resolver — bin counts, prior delta, risk-band split,
//      mean/high-share totals, segment filter.
//   2. Edge cases — exactly-on-edge values, all-zero input, all-high.
//   3. Route — 200 happy path, 400 bad input, 403 RBAC.

import request from 'supertest';
import {
  computePdDistribution,
  InMemoryPdDistributionSource,
  type PdSnapshotRow,
} from '../src/analytics/pd_distribution';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-08T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

// ── 1. Pure resolver ──────────────────────────────────────────────────

describe('computePdDistribution', () => {
  test('empty input → all bins zero, totals null', () => {
    const out = computePdDistribution({ tenant_id: 'BANK_DEMO', current: [], asOf: NOW });
    expect(out.bins).toHaveLength(10);
    expect(out.bins.every((b) => b.count === 0)).toBe(true);
    expect(out.totals.customer_count).toBe(0);
    expect(out.totals.mean_pd_proxy).toBeNull();
    expect(out.totals.high_band_share).toBe(0);
  });

  test('10-bin histogram covers [0, 10] with 1.0 width', () => {
    const out = computePdDistribution({ tenant_id: 'BANK_DEMO', current: [], asOf: NOW });
    expect(out.range).toEqual({ lower: 0, upper: 10, bin_count: 10 });
    expect(out.bins[0].lower).toBe(0);
    expect(out.bins[0].upper).toBe(1);
    expect(out.bins[9].lower).toBe(9);
    expect(out.bins[9].upper).toBe(10);
  });

  test('values are placed in the right bins', () => {
    const rows: PdSnapshotRow[] = [
      { customer_id: 'a', pd_proxy: 0.5 },   // bin 0 [0, 1)
      { customer_id: 'b', pd_proxy: 1.0 },   // bin 1 [1, 2)
      { customer_id: 'c', pd_proxy: 4.5 },   // bin 4 [4, 5)
      { customer_id: 'd', pd_proxy: 9.5 },   // bin 9 [9, 10]
      { customer_id: 'e', pd_proxy: 10.0 },  // bin 9 — upper-edge inclusive
    ];
    const out = computePdDistribution({ tenant_id: 'BANK_DEMO', current: rows, asOf: NOW });
    const counts = out.bins.map((b) => b.count);
    expect(counts).toEqual([1, 1, 0, 0, 1, 0, 0, 0, 0, 2]);
  });

  test('risk-band split — low/medium/high', () => {
    const rows: PdSnapshotRow[] = [
      { customer_id: 'a', pd_proxy: 1.0 },   // low [0,3)
      { customer_id: 'b', pd_proxy: 2.99 },  // low
      { customer_id: 'c', pd_proxy: 3.0 },   // medium [3,5)
      { customer_id: 'd', pd_proxy: 4.99 },  // medium
      { customer_id: 'e', pd_proxy: 5.0 },   // high [5,10]
      { customer_id: 'f', pd_proxy: 9.5 },   // high
      { customer_id: 'g', pd_proxy: 10.0 },  // high (upper-inclusive)
    ];
    const out = computePdDistribution({ tenant_id: 'BANK_DEMO', current: rows, asOf: NOW });
    const byBand = Object.fromEntries(out.bands.map((b) => [b.band, b.count]));
    expect(byBand).toEqual({ low: 2, medium: 2, high: 3 });
    expect(out.totals.high_band_share).toBeCloseTo(3 / 7, 3);
  });

  test('totals.mean_pd_proxy is the simple average', () => {
    const rows = [1, 3, 5, 7, 9].map((v, i) => ({ customer_id: `c-${i}`, pd_proxy: v }));
    const out = computePdDistribution({ tenant_id: 'BANK_DEMO', current: rows, asOf: NOW });
    expect(out.totals.mean_pd_proxy).toBe(5);
  });

  test('prior snapshot drives delta line; missing prior → nulls', () => {
    const cur: PdSnapshotRow[] = [
      { customer_id: 'a', pd_proxy: 4.5 },
      { customer_id: 'b', pd_proxy: 4.5 },
      { customer_id: 'c', pd_proxy: 7.0 },
    ];
    const prior: PdSnapshotRow[] = [
      { customer_id: 'a', pd_proxy: 4.5 },
      { customer_id: 'b', pd_proxy: 7.0 },
    ];
    const withPrior = computePdDistribution({
      tenant_id: 'BANK_DEMO', current: cur, prior, asOf: NOW,
    });
    expect(withPrior.bins[4].count).toBe(2);     // bin [4,5) — current
    expect(withPrior.bins[4].prior_count).toBe(1); // prior
    expect(withPrior.bins[4].delta).toBe(1);
    expect(withPrior.bins[7].count).toBe(1);
    expect(withPrior.bins[7].prior_count).toBe(1);
    expect(withPrior.bins[7].delta).toBe(0);
    expect(withPrior.totals.prior_customer_count).toBe(2);

    const withoutPrior = computePdDistribution({ tenant_id: 'BANK_DEMO', current: cur, asOf: NOW });
    expect(withoutPrior.bins[4].prior_count).toBeNull();
    expect(withoutPrior.bins[4].delta).toBeNull();
    expect(withoutPrior.totals.prior_customer_count).toBeNull();
  });

  test('segment filter via lookup', () => {
    const rows = [
      { customer_id: 'a', pd_proxy: 5 },
      { customer_id: 'b', pd_proxy: 7 },
      { customer_id: 'c', pd_proxy: 8 },
    ];
    const segOf = (id: string) => (id === 'b' ? 'sme' : 'retail');
    const out = computePdDistribution({
      tenant_id: 'BANK_DEMO',
      current: rows,
      filter: { segment: 'sme' },
      segmentOf: segOf,
      asOf: NOW,
    });
    expect(out.totals.customer_count).toBe(1);
  });
});

// ── 2. Route ──────────────────────────────────────────────────────────

function makeAppFor(role = 'admin', rows: PdSnapshotRow[] = []) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    pdDistributionSource: new InMemoryPdDistributionSource(() => rows),
  }).app;
}

describe('GET /v1/analytics/pd-distribution', () => {
  test('happy path returns histogram in EWS envelope', async () => {
    const rows = [1, 4, 8].map((v, i) => ({ customer_id: `c-${i}`, pd_proxy: v }));
    const r = await request(makeAppFor('admin', rows))
      .get('/v1/analytics/pd-distribution')
      .set(TH)
      .set('x-apex-role', 'admin');
    expect(r.status).toBe(200);
    expect(r.body.body.bins).toHaveLength(10);
    expect(r.body.body.totals.customer_count).toBe(3);
  });

  test('400 on invalid as_of date', async () => {
    const r = await request(makeAppFor('admin', []))
      .get('/v1/analytics/pd-distribution?as_of=not-a-date')
      .set(TH)
      .set('x-apex-role', 'admin');
    expect(r.status).toBe(400);
  });

  test('403 for collection_officer', async () => {
    const r = await request(makeAppFor('collection_officer', []))
      .get('/v1/analytics/pd-distribution')
      .set(TH)
      .set('x-apex-role', 'collection_officer');
    expect(r.status).toBe(403);
  });
});
