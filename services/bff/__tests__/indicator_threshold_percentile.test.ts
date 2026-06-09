// @ts-nocheck
// services/bff/__tests__/indicator_threshold_percentile.test.ts
//
// T6 M4.22 — Indicator threshold percentile comparison.

import request from 'supertest';
import { buildIndicatorThresholdPercentiles } from '../src/indicator_threshold_percentile';
import { listThresholds } from '../src/indicator_thresholds';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── pure function ───────────────────────────────────────────────────

describe('M4.22 — envelope shape', () => {
  test('total_indicators matches listThresholds() length', () => {
    const result = buildIndicatorThresholdPercentiles(NOW);
    expect(result.total_indicators).toBe(listThresholds().length);
    expect(result.indicators.length).toBe(listThresholds().length);
  });

  test('generated_at is ISO string', () => {
    const result = buildIndicatorThresholdPercentiles(NOW);
    expect(result.generated_at).toBe(NOW.toISOString());
  });

  test('fleet_percentiles has all three bands', () => {
    const result = buildIndicatorThresholdPercentiles(NOW);
    expect(result.fleet_percentiles.yellow_at).toHaveProperty('p25');
    expect(result.fleet_percentiles.yellow_at).toHaveProperty('p50');
    expect(result.fleet_percentiles.yellow_at).toHaveProperty('p75');
    expect(result.fleet_percentiles.orange_at).toHaveProperty('p25');
    expect(result.fleet_percentiles.red_at).toHaveProperty('p75');
  });
});

describe('M4.22 — percentile ordering invariants', () => {
  test('p25 <= p50 <= p75 for all bands', () => {
    const result = buildIndicatorThresholdPercentiles(NOW);
    const { yellow_at, orange_at, red_at } = result.fleet_percentiles;
    expect(yellow_at.p25).toBeLessThanOrEqual(yellow_at.p50);
    expect(yellow_at.p50).toBeLessThanOrEqual(yellow_at.p75);
    expect(orange_at.p25).toBeLessThanOrEqual(orange_at.p50);
    expect(orange_at.p50).toBeLessThanOrEqual(orange_at.p75);
    expect(red_at.p25).toBeLessThanOrEqual(red_at.p50);
    expect(red_at.p50).toBeLessThanOrEqual(red_at.p75);
  });
});

describe('M4.22 — per-indicator fields', () => {
  test('every indicator has required fields', () => {
    const result = buildIndicatorThresholdPercentiles(NOW);
    for (const ind of result.indicators) {
      expect(typeof ind.indicator_id).toBe('string');
      expect(typeof ind.name).toBe('string');
      expect(typeof ind.yellow_percentile_rank).toBe('number');
      expect(typeof ind.orange_percentile_rank).toBe('number');
      expect(typeof ind.red_percentile_rank).toBe('number');
      expect(typeof ind.is_tightest_yellow).toBe('boolean');
      expect(typeof ind.is_most_lenient_red).toBe('boolean');
    }
  });

  test('indicators sorted by indicator_id asc', () => {
    const result = buildIndicatorThresholdPercentiles(NOW);
    for (let i = 0; i < result.indicators.length - 1; i++) {
      expect(result.indicators[i].indicator_id <= result.indicators[i + 1].indicator_id).toBe(true);
    }
  });

  test('percentile_rank in [0, 100]', () => {
    const result = buildIndicatorThresholdPercentiles(NOW);
    for (const ind of result.indicators) {
      expect(ind.yellow_percentile_rank).toBeGreaterThanOrEqual(0);
      expect(ind.yellow_percentile_rank).toBeLessThanOrEqual(100);
      expect(ind.red_percentile_rank).toBeGreaterThanOrEqual(0);
      expect(ind.red_percentile_rank).toBeLessThanOrEqual(100);
    }
  });
});

describe('M4.22 — outlier lists', () => {
  test('tightest_yellow_indicators are a subset of indicators', () => {
    const result = buildIndicatorThresholdPercentiles(NOW);
    const allIds = new Set(result.indicators.map((i) => i.indicator_id));
    for (const id of result.tightest_yellow_indicators) {
      expect(allIds.has(id)).toBe(true);
    }
  });

  test('most_lenient_red_indicators are a subset of indicators', () => {
    const result = buildIndicatorThresholdPercentiles(NOW);
    const allIds = new Set(result.indicators.map((i) => i.indicator_id));
    for (const id of result.most_lenient_red_indicators) {
      expect(allIds.has(id)).toBe(true);
    }
  });

  test('is_tightest_yellow consistent with tightest_yellow_indicators list', () => {
    const result = buildIndicatorThresholdPercentiles(NOW);
    const listSet = new Set(result.tightest_yellow_indicators);
    for (const ind of result.indicators) {
      if (ind.is_tightest_yellow) {
        expect(listSet.has(ind.indicator_id)).toBe(true);
      }
    }
  });
});

describe('M4.22 — platform-static', () => {
  test('same result for different now values', () => {
    const r1 = buildIndicatorThresholdPercentiles(new Date('2026-01-01T00:00:00Z'));
    const r2 = buildIndicatorThresholdPercentiles(new Date('2026-12-31T23:59:59Z'));
    expect(r1.total_indicators).toBe(r2.total_indicators);
    expect(r1.fleet_percentiles.red_at.p50).toBe(r2.fleet_percentiles.red_at.p50);
  });
});

// ─── route ───────────────────────────────────────────────────────────

function makeApp2(role) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M4.22 — GET /v1/indicators/thresholds/percentile-comparison', () => {
  test('admin → 200 with full summary', async () => {
    const { app } = makeApp2('admin');
    const r = await request(app).get('/v1/indicators/thresholds/percentile-comparison').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_indicators).toBe(listThresholds().length);
  });

  test('non-admin (risk_analyst) → 403', async () => {
    const { app } = makeApp2('risk_analyst');
    const r = await request(app).get('/v1/indicators/thresholds/percentile-comparison').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL and BANK_DEMO same', async () => {
    const { app } = makeApp2('admin');
    const bil = await request(app).get('/v1/indicators/thresholds/percentile-comparison').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/indicators/thresholds/percentile-comparison')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(bil.body.body.total_indicators).toBe(bank.body.body.total_indicators);
  });

  test('M4.21 weight-threshold-correlation sibling still works', async () => {
    const { app } = makeApp2('admin');
    const r = await request(app).get('/v1/indicators/weight-threshold-correlation').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
