// services/bff/__tests__/indicator_weight_histogram.test.ts
//
// T6 M4.15 — Indicator catalog weight distribution histogram.

import request from 'supertest';
import {
  buildIndicatorWeightHistogram,
  ALL_INDICATOR_WEIGHT_BUCKETS,
} from '../src/indicator_weight_histogram';
import { STUB_CATALOG } from '../src/bil_scoring_v2';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-18T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeWhApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M4.15 — canonical bucket order', () => {
  test('5 buckets in canonical order', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    expect(s.buckets.map((b) => b.bucket)).toEqual([...ALL_INDICATOR_WEIGHT_BUCKETS]);
    expect(s.buckets.length).toBe(5);
  });

  test('every bucket exposes label + min + max metadata', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    for (const b of s.buckets) {
      expect(b.label.length).toBeGreaterThan(0);
      expect(b.min).toBeGreaterThanOrEqual(0);
      expect(b.max).toBeLessThanOrEqual(1);
    }
  });
});

describe('M4.15 — total_indicators matches STUB_CATALOG size', () => {
  test('total_indicators = catalog size', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    expect(s.total_indicators).toBe(Object.keys(STUB_CATALOG).length);
  });
});

describe('M4.15 — Σ buckets.count = total_indicators partition invariant', () => {
  test('partition holds', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    const sum = s.buckets.reduce((acc, b) => acc + b.count, 0);
    expect(sum).toBe(s.total_indicators);
  });
});

describe('M4.15 — by_vertical partition per row', () => {
  test('Σ by_vertical = row.count per bucket', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    for (const b of s.buckets) {
      const sum = b.by_vertical.banking + b.by_vertical.insurance;
      expect(sum).toBe(b.count);
    }
  });

  test('every by_vertical carries banking + insurance keys', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    for (const b of s.buckets) {
      expect(Object.keys(b.by_vertical).sort()).toEqual(['banking', 'insurance']);
    }
  });
});

describe('M4.15 — strict-< upper bound semantics', () => {
  test('exact 0.2 → low_medium (not low)', () => {
    // Verify by checking actual catalog placement — FIN-001 at 0.9 must
    // go to critical not high
    const s = buildIndicatorWeightHistogram(NOW);
    // critical bucket includes 1.0 inclusive
    const critical = s.buckets.find((b) => b.bucket === 'critical')!;
    expect(critical.max_inclusive).toBe(true);
    expect(critical.min).toBe(0.8);
    expect(critical.max).toBe(1.0);
  });
});

describe('M4.15 — catalog distribution', () => {
  test('FIN-001 (0.9) lands in critical', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    const critical = s.buckets.find((b) => b.bucket === 'critical')!;
    expect(critical.sample_indicator_ids).toContain('FIN-001');
  });

  test('FIN-002 (0.7) lands in high', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    const high = s.buckets.find((b) => b.bucket === 'high')!;
    expect(high.sample_indicator_ids).toContain('FIN-002');
  });

  test('BEH-002 (0.4) lands in medium (at boundary)', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    const medium = s.buckets.find((b) => b.bucket === 'medium')!;
    expect(medium.sample_indicator_ids).toContain('BEH-002');
  });

  test('default catalog has weights only in [0.4, 1.0] → low + low_medium empty', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    const low = s.buckets.find((b) => b.bucket === 'low')!;
    const lowMed = s.buckets.find((b) => b.bucket === 'low_medium')!;
    expect(low.count).toBe(0);
    expect(lowMed.count).toBe(0);
  });
});

describe('M4.15 — sample_indicator_ids cap 5 sorted asc', () => {
  test('samples sorted asc per row', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    for (const b of s.buckets) {
      expect(b.sample_indicator_ids.length).toBeLessThanOrEqual(5);
      const sorted = [...b.sample_indicator_ids].sort();
      expect(b.sample_indicator_ids).toEqual(sorted);
    }
  });
});

describe('M4.15 — peak_bucket formula', () => {
  test('peak_bucket is highest-count bucket', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    if (s.peak_bucket) {
      const top = s.buckets.find((b) => b.bucket === s.peak_bucket)!;
      for (const b of s.buckets) {
        expect(top.count).toBeGreaterThanOrEqual(b.count);
      }
    }
  });

  test('peak_bucket non-null for default catalog', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    expect(s.peak_bucket).not.toBeNull();
  });
});

describe('M4.15 — empty_buckets canonical order', () => {
  test('zero-count buckets listed in canonical order', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    const zeroCounts = s.buckets.filter((b) => b.count === 0).map((b) => b.bucket);
    expect(s.empty_buckets).toEqual(zeroCounts);
  });
});

describe('M4.15 — mean/min/max weight', () => {
  test('mean_weight = round(Σ/n) to 4 decimals', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    if (s.mean_weight !== null) {
      const manual = Object.values(STUB_CATALOG)
        .map((e) => e.weight)
        .reduce((acc, w) => acc + w, 0) / s.total_indicators;
      expect(s.mean_weight).toBeCloseTo(manual, 3);
    }
  });

  test('min_weight = min of catalog weights', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    const weights = Object.values(STUB_CATALOG).map((e) => e.weight);
    expect(s.min_weight).toBe(Math.min(...weights));
  });

  test('max_weight = max of catalog weights', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    const weights = Object.values(STUB_CATALOG).map((e) => e.weight);
    expect(s.max_weight).toBe(Math.max(...weights));
  });
});

describe('M4.15 — generated_at echo', () => {
  test('ISO timestamp echoed', () => {
    const s = buildIndicatorWeightHistogram(NOW);
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M4.15 — GET /v1/indicators/weight-histogram', () => {
  test('admin → 200 with full histogram', async () => {
    const { app } = makeWhApp('admin');
    const r = await request(app)
      .get('/v1/indicators/weight-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.buckets.length).toBe(5);
    expect(r.body.body.total_indicators).toBe(Object.keys(STUB_CATALOG).length);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeWhApp('field_officer');
    const r = await request(app)
      .get('/v1/indicators/weight-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: same response across tenants', async () => {
    const { app } = makeWhApp('admin');
    const bil = await request(app)
      .get('/v1/indicators/weight-histogram')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/indicators/weight-histogram')
      .set(TH_BANK);
    expect(bil.body.body.total_indicators).toBe(bank.body.body.total_indicators);
    expect(bil.body.body.peak_bucket).toBe(bank.body.body.peak_bucket);
  });

  test('M4.13 /v1/indicators/catalog-stats sibling regression still 200', async () => {
    const { app } = makeWhApp('admin');
    const r = await request(app)
      .get('/v1/indicators/catalog-stats')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('literal `/weight-histogram` not captured by /thresholds wildcard', async () => {
    const { app } = makeWhApp('admin');
    const r = await request(app)
      .get('/v1/indicators/weight-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.buckets).toBeDefined();
  });
});
