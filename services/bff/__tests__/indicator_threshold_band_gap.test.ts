// services/bff/__tests__/indicator_threshold_band_gap.test.ts
//
// T6 M4.14 — Indicator threshold band-gap quality scorecard.

import request from 'supertest';
import {
  buildIndicatorThresholdBandGap,
  TIGHT_GAP_THRESHOLD,
  HIGH_YELLOW_THRESHOLD,
  LOW_RED_THRESHOLD,
} from '../src/indicator_threshold_band_gap';
import { listThresholds } from '../src/indicator_thresholds';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeBgApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── buildIndicatorThresholdBandGap — pure ───────────────────────────

describe('M4.14 — basic shape', () => {
  test('envelope carries every expected field', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_indicators).toBe(listThresholds().length);
    expect(s.rows.length).toBe(s.total_indicators);
    expect(s).toHaveProperty('mean_yellow_orange_gap');
    expect(s).toHaveProperty('mean_orange_red_gap');
    expect(s).toHaveProperty('mean_total_spread');
    expect(s).toHaveProperty('tightest_yellow_orange');
    expect(s).toHaveProperty('widest_total_spread');
    expect(s).toHaveProperty('by_vertical');
    expect(s).toHaveProperty('flagged_indicators');
  });
});

describe('M4.14 — rows sorted by indicator_id asc', () => {
  test('rows[] ordered alphabetically by indicator_id', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    for (let i = 1; i < s.rows.length; i++) {
      expect(s.rows[i - 1]!.indicator_id.localeCompare(s.rows[i]!.indicator_id)).toBeLessThan(0);
    }
  });
});

describe('M4.14 — gap arithmetic', () => {
  test('yellow_orange_gap === orange_at − yellow_at; orange_red_gap === red_at − orange_at', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    for (const row of s.rows) {
      expect(row.yellow_orange_gap).toBeCloseTo(row.orange_at - row.yellow_at, 4);
      expect(row.orange_red_gap).toBeCloseTo(row.red_at - row.orange_at, 4);
      expect(row.total_spread).toBeCloseTo(row.red_at - row.yellow_at, 4);
    }
  });

  test('total_spread === yellow_orange_gap + orange_red_gap for monotonic rows', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    for (const row of s.rows) {
      if (row.monotonic) {
        expect(row.total_spread).toBeCloseTo(row.yellow_orange_gap + row.orange_red_gap, 4);
      }
    }
  });
});

describe('M4.14 — monotonic flag', () => {
  test('every default catalog row is monotonic (assertion-aligned with M4.3)', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    for (const row of s.rows) {
      expect(row.monotonic).toBe(true);
      expect(row.has_inverted_bands).toBe(false);
    }
  });
});

describe('M4.14 — quality flags', () => {
  test('has_tight_yellow_orange_gap iff yellow_orange_gap < TIGHT_GAP_THRESHOLD', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    for (const row of s.rows) {
      expect(row.has_tight_yellow_orange_gap).toBe(row.yellow_orange_gap < TIGHT_GAP_THRESHOLD);
    }
  });

  test('has_tight_orange_red_gap iff orange_red_gap < TIGHT_GAP_THRESHOLD', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    for (const row of s.rows) {
      expect(row.has_tight_orange_red_gap).toBe(row.orange_red_gap < TIGHT_GAP_THRESHOLD);
    }
  });

  test('has_high_yellow_floor iff yellow_at > HIGH_YELLOW_THRESHOLD', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    for (const row of s.rows) {
      expect(row.has_high_yellow_floor).toBe(row.yellow_at > HIGH_YELLOW_THRESHOLD);
    }
  });

  test('has_low_red_ceiling iff red_at < LOW_RED_THRESHOLD', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    for (const row of s.rows) {
      expect(row.has_low_red_ceiling).toBe(row.red_at < LOW_RED_THRESHOLD);
    }
  });
});

describe('M4.14 — mean computations', () => {
  test('means computed across monotonic rows', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    expect(s.mean_yellow_orange_gap).not.toBeNull();
    expect(s.mean_orange_red_gap).not.toBeNull();
    expect(s.mean_total_spread).not.toBeNull();
    // Manual check
    const manual = s.rows.filter((r) => r.monotonic);
    const manualMean = (values: number[]) =>
      +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(4);
    expect(s.mean_yellow_orange_gap).toBeCloseTo(
      manualMean(manual.map((r) => r.yellow_orange_gap)),
      4,
    );
  });

  test('means in [0, 1] for the default catalog', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    expect(s.mean_yellow_orange_gap!).toBeGreaterThanOrEqual(0);
    expect(s.mean_yellow_orange_gap!).toBeLessThanOrEqual(1);
    expect(s.mean_total_spread!).toBeGreaterThanOrEqual(0);
    expect(s.mean_total_spread!).toBeLessThanOrEqual(1);
  });
});

describe('M4.14 — tightest_yellow_orange', () => {
  test('points at the row with the minimum yellow_orange_gap', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    expect(s.tightest_yellow_orange).not.toBeNull();
    const target = s.rows.find((r) => r.indicator_id === s.tightest_yellow_orange!.indicator_id)!;
    expect(s.tightest_yellow_orange!.gap).toBe(target.yellow_orange_gap);
    for (const row of s.rows) {
      expect(row.yellow_orange_gap).toBeGreaterThanOrEqual(target.yellow_orange_gap);
    }
  });
});

describe('M4.14 — widest_total_spread', () => {
  test('points at the row with the maximum total_spread', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    expect(s.widest_total_spread).not.toBeNull();
    const target = s.rows.find((r) => r.indicator_id === s.widest_total_spread!.indicator_id)!;
    expect(s.widest_total_spread!.spread).toBe(target.total_spread);
    for (const row of s.rows) {
      expect(row.total_spread).toBeLessThanOrEqual(target.total_spread);
    }
  });
});

describe('M4.14 — by_vertical rollup', () => {
  test('every ScoringVertical key present with count + flagged_count', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    expect(s.by_vertical).toHaveProperty('banking');
    expect(s.by_vertical).toHaveProperty('insurance');
    expect(s.by_vertical.banking.count).toBeGreaterThan(0);
    expect(s.by_vertical.insurance.count).toBeGreaterThan(0);
  });

  test('Σ vertical.count = total_indicators', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    expect(s.by_vertical.banking.count + s.by_vertical.insurance.count).toBe(s.total_indicators);
  });

  test('flagged_count ≤ count per vertical', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    expect(s.by_vertical.banking.flagged_count).toBeLessThanOrEqual(s.by_vertical.banking.count);
    expect(s.by_vertical.insurance.flagged_count).toBeLessThanOrEqual(s.by_vertical.insurance.count);
  });

  test('per-row vertical counts match manual filter', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    const bankingRows = s.rows.filter((r) => r.vertical === 'banking');
    const insuranceRows = s.rows.filter((r) => r.vertical === 'insurance');
    expect(s.by_vertical.banking.count).toBe(bankingRows.length);
    expect(s.by_vertical.insurance.count).toBe(insuranceRows.length);
  });
});

describe('M4.14 — flagged_indicators', () => {
  test('every entry has at least one quality flag set', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    for (const row of s.flagged_indicators) {
      const any =
        row.has_tight_yellow_orange_gap ||
        row.has_tight_orange_red_gap ||
        row.has_high_yellow_floor ||
        row.has_low_red_ceiling ||
        row.has_inverted_bands;
      expect(any).toBe(true);
    }
  });

  test('sorted by indicator_id asc', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    for (let i = 1; i < s.flagged_indicators.length; i++) {
      expect(
        s.flagged_indicators[i - 1]!.indicator_id.localeCompare(
          s.flagged_indicators[i]!.indicator_id,
        ),
      ).toBeLessThan(0);
    }
  });

  test('Σ vertical.flagged_count = flagged_indicators.length', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    expect(s.by_vertical.banking.flagged_count + s.by_vertical.insurance.flagged_count).toBe(
      s.flagged_indicators.length,
    );
  });
});

describe('M4.14 — catalog cross-check', () => {
  test('total_indicators = listThresholds().length', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    expect(s.total_indicators).toBe(listThresholds().length);
  });

  test('every threshold catalog row appears in s.rows', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    const idsInResult = new Set(s.rows.map((r) => r.indicator_id));
    for (const t of listThresholds()) {
      expect(idsInResult.has(t.indicator_id)).toBe(true);
    }
  });
});

describe('M4.14 — known catalog spot-check', () => {
  test('FIN-001 (yellow 0.30, orange 0.55, red 0.80) gaps as expected', () => {
    const s = buildIndicatorThresholdBandGap(NOW);
    const fin001 = s.rows.find((r) => r.indicator_id === 'FIN-001');
    expect(fin001).toBeDefined();
    expect(fin001!.yellow_orange_gap).toBeCloseTo(0.25, 4);
    expect(fin001!.orange_red_gap).toBeCloseTo(0.25, 4);
    expect(fin001!.total_spread).toBeCloseTo(0.50, 4);
    expect(fin001!.monotonic).toBe(true);
    expect(fin001!.has_tight_yellow_orange_gap).toBe(false);
    expect(fin001!.has_high_yellow_floor).toBe(false);
    expect(fin001!.has_low_red_ceiling).toBe(false);
  });
});

describe('M4.14 — platform-static', () => {
  test('different now → same matrix data', () => {
    const a = buildIndicatorThresholdBandGap(new Date('2026-01-01T00:00:00.000Z'));
    const b = buildIndicatorThresholdBandGap(new Date('2026-12-31T00:00:00.000Z'));
    expect(a.total_indicators).toBe(b.total_indicators);
    expect(a.mean_yellow_orange_gap).toBe(b.mean_yellow_orange_gap);
    expect(a.tightest_yellow_orange).toEqual(b.tightest_yellow_orange);
  });
});

// ─── GET /v1/indicators/thresholds/band-gap ──────────────────────────

describe('M4.14 — GET /v1/indicators/thresholds/band-gap', () => {
  test('admin → 200 with full scorecard', async () => {
    const { app } = makeBgApp('admin');
    const r = await request(app).get('/v1/indicators/thresholds/band-gap').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_indicators).toBe(listThresholds().length);
    expect(r.body.body.rows.length).toBe(r.body.body.total_indicators);
  });

  test('shape contains every expected field', async () => {
    const { app } = makeBgApp('admin');
    const r = await request(app).get('/v1/indicators/thresholds/band-gap').set(TH_BIL);
    expect(r.body.body).toHaveProperty('rows');
    expect(r.body.body).toHaveProperty('tightest_yellow_orange');
    expect(r.body.body).toHaveProperty('widest_total_spread');
    expect(r.body.body).toHaveProperty('by_vertical');
    expect(r.body.body).toHaveProperty('flagged_indicators');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBgApp('case_owner');
    const r = await request(app).get('/v1/indicators/thresholds/band-gap').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL ↔ BANK_DEMO same response', async () => {
    const { app } = makeBgApp('admin');
    const bil = await request(app).get('/v1/indicators/thresholds/band-gap').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/indicators/thresholds/band-gap')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body.total_indicators).toBe(bank.body.body.total_indicators);
    expect(bil.body.body.tightest_yellow_orange).toEqual(bank.body.body.tightest_yellow_orange);
  });

  test('literal `/band-gap` not captured by `/:indicator_id` wildcard', async () => {
    const { app } = makeBgApp('admin');
    // If shadowed, the wildcard would 404 on unknown_indicator.
    const r = await request(app).get('/v1/indicators/thresholds/band-gap').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M4.12 /v1/indicators/thresholds/drift still 200 (sibling regression)', async () => {
    const { app } = makeBgApp('admin');
    const r = await request(app).get('/v1/indicators/thresholds/drift').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M4.9 /v1/indicators/thresholds/effective still 200 (sibling regression)', async () => {
    const { app } = makeBgApp('admin');
    const r = await request(app).get('/v1/indicators/thresholds/effective').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
