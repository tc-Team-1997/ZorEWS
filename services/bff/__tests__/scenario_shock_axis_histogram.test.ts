// services/bff/__tests__/scenario_shock_axis_histogram.test.ts
//
// T6 M16.20 — Scenario shock-axis magnitude histogram.

import request from 'supertest';
import {
  buildScenarioShockAxisHistogram,
  ALL_SHOCK_AXES,
  ALL_SHOCK_MAGNITUDE_BUCKETS,
  bucketForShock,
} from '../src/scenario_shock_axis_histogram';
import { SCENARIO_PRESETS } from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeSaApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── buildScenarioShockAxisHistogram — pure ──────────────────────────

describe('M16.20 — basic shape', () => {
  test('envelope contains expected fields', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    expect(h.generated_at).toBe(NOW.toISOString());
    expect(h.total_presets).toBe(SCENARIO_PRESETS.length);
    expect(h.rows.length).toBe(ALL_SHOCK_AXES.length);
    expect(h).toHaveProperty('most_severe_axis');
    expect(h).toHaveProperty('highest_mean_axis');
    expect(h).toHaveProperty('lowest_mean_axis');
    expect(h).toHaveProperty('by_bucket_totals');
  });
});

describe('M16.20 — rows in canonical axis order', () => {
  test('rows[] follows ALL_SHOCK_AXES (gdp → rate → fx)', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    expect(h.rows.map((r) => r.axis)).toEqual([...ALL_SHOCK_AXES]);
  });
});

describe('M16.20 — bucketForShock helper', () => {
  test('zero shock → zero bucket', () => {
    expect(bucketForShock('gdp', 0)).toBe('zero');
    expect(bucketForShock('rate', 0)).toBe('zero');
    expect(bucketForShock('fx', 0)).toBe('zero');
  });

  test('sign-agnostic — only magnitude matters', () => {
    expect(bucketForShock('gdp', 1.5)).toBe(bucketForShock('gdp', -1.5));
    expect(bucketForShock('rate', 200)).toBe(bucketForShock('rate', -200));
    expect(bucketForShock('fx', 8)).toBe(bucketForShock('fx', -8));
  });

  test('GDP buckets: < 2 mild, < 5 moderate, ≥ 5 severe', () => {
    expect(bucketForShock('gdp', 1)).toBe('mild');
    expect(bucketForShock('gdp', 1.9)).toBe('mild');
    expect(bucketForShock('gdp', 2)).toBe('moderate'); // boundary
    expect(bucketForShock('gdp', 4.9)).toBe('moderate');
    expect(bucketForShock('gdp', 5)).toBe('severe');
    expect(bucketForShock('gdp', 7)).toBe('severe');
  });

  test('rate buckets: < 100 mild, < 250 moderate, ≥ 250 severe', () => {
    expect(bucketForShock('rate', 50)).toBe('mild');
    expect(bucketForShock('rate', 100)).toBe('moderate');
    expect(bucketForShock('rate', 200)).toBe('moderate');
    expect(bucketForShock('rate', 250)).toBe('severe');
    expect(bucketForShock('rate', 400)).toBe('severe');
  });

  test('fx buckets: < 5 mild, < 12 moderate, ≥ 12 severe', () => {
    expect(bucketForShock('fx', 3)).toBe('mild');
    expect(bucketForShock('fx', 5)).toBe('moderate');
    expect(bucketForShock('fx', 10)).toBe('moderate');
    expect(bucketForShock('fx', 12)).toBe('severe');
    expect(bucketForShock('fx', 15)).toBe('severe');
  });
});

describe('M16.20 — per-row total matches catalog', () => {
  test('total_presets = SCENARIO_PRESETS.length per axis', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    for (const row of h.rows) {
      expect(row.total_presets).toBe(SCENARIO_PRESETS.length);
    }
  });
});

describe('M16.20 — per-row partition invariant', () => {
  test('Σ by_bucket = total_presets per row', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    for (const row of h.rows) {
      const sum = Object.values(row.by_bucket).reduce((a, b) => a + b, 0);
      expect(sum).toBe(row.total_presets);
    }
  });

  test('positive_count + negative_count + zero_count = total_presets per row', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    for (const row of h.rows) {
      expect(row.positive_count + row.negative_count + row.zero_count).toBe(row.total_presets);
    }
  });
});

describe('M16.20 — every-bucket-key-present per row', () => {
  test('row.by_bucket has every MagnitudeBucket key', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    for (const row of h.rows) {
      for (const b of ALL_SHOCK_MAGNITUDE_BUCKETS) {
        expect(row.by_bucket).toHaveProperty(b);
        expect(typeof row.by_bucket[b]).toBe('number');
      }
    }
  });
});

describe('M16.20 — min/max/mean abs', () => {
  test('min_abs ≤ mean_abs ≤ max_abs per row', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    for (const row of h.rows) {
      expect(row.min_abs).toBeLessThanOrEqual(row.mean_abs);
      expect(row.mean_abs).toBeLessThanOrEqual(row.max_abs);
    }
  });

  test('mean_abs matches manual scan per axis', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    for (const row of h.rows) {
      const sum = SCENARIO_PRESETS.reduce(
        (acc, p) => acc + Math.abs(p.shocks[row.axis]),
        0,
      );
      const manual = +(sum / SCENARIO_PRESETS.length).toFixed(4);
      expect(row.mean_abs).toBe(manual);
    }
  });

  test('max_abs matches manual scan per axis', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    for (const row of h.rows) {
      const manual = SCENARIO_PRESETS.reduce(
        (acc, p) => Math.max(acc, Math.abs(p.shocks[row.axis])),
        0,
      );
      expect(row.max_abs).toBe(manual);
    }
  });
});

describe('M16.20 — severe_examples', () => {
  test('cap 3 sorted asc; only severe-bucket preset_ids', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    for (const row of h.rows) {
      expect(row.severe_examples.length).toBeLessThanOrEqual(3);
      // Sorted asc
      for (let i = 1; i < row.severe_examples.length; i++) {
        expect(row.severe_examples[i - 1]!.localeCompare(row.severe_examples[i]!)).toBeLessThan(0);
      }
      // Each is a real severe-bucket preset
      for (const id of row.severe_examples) {
        const preset = SCENARIO_PRESETS.find((p) => p.id === id);
        expect(preset).toBeDefined();
        expect(bucketForShock(row.axis, preset!.shocks[row.axis])).toBe('severe');
      }
    }
  });
});

describe('M16.20 — most_severe_axis', () => {
  test('points at axis with highest severe count', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    if (h.most_severe_axis === null) return;
    const target = h.rows.find((r) => r.axis === h.most_severe_axis!.axis)!;
    expect(h.most_severe_axis.severe_count).toBe(target.by_bucket.severe);
    for (const row of h.rows) {
      expect(row.by_bucket.severe).toBeLessThanOrEqual(target.by_bucket.severe);
    }
  });
});

describe('M16.20 — highest_mean_axis + lowest_mean_axis', () => {
  test('highest_mean_axis matches global argmax of mean_abs', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    if (h.highest_mean_axis === null) return;
    const target = h.rows.find((r) => r.axis === h.highest_mean_axis!.axis)!;
    expect(h.highest_mean_axis.mean_abs).toBe(target.mean_abs);
    for (const row of h.rows) {
      expect(row.mean_abs).toBeLessThanOrEqual(target.mean_abs);
    }
  });

  test('lowest_mean_axis matches global argmin of mean_abs', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    if (h.lowest_mean_axis === null) return;
    const target = h.rows.find((r) => r.axis === h.lowest_mean_axis!.axis)!;
    expect(h.lowest_mean_axis.mean_abs).toBe(target.mean_abs);
    for (const row of h.rows) {
      expect(row.mean_abs).toBeGreaterThanOrEqual(target.mean_abs);
    }
  });
});

describe('M16.20 — by_bucket_totals', () => {
  test('= Σ across rows for each bucket', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    for (const b of ALL_SHOCK_MAGNITUDE_BUCKETS) {
      const sum = h.rows.reduce((acc, r) => acc + r.by_bucket[b], 0);
      expect(h.by_bucket_totals[b]).toBe(sum);
    }
  });

  test('Σ by_bucket_totals = 3 axes × total_presets', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    const sum = Object.values(h.by_bucket_totals).reduce((a, b) => a + b, 0);
    expect(sum).toBe(ALL_SHOCK_AXES.length * SCENARIO_PRESETS.length);
  });
});

describe('M16.20 — known catalog spot-checks', () => {
  test('GDP axis has at least one severe-bucket preset (panic/severely_adverse)', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    const gdp = h.rows.find((r) => r.axis === 'gdp')!;
    expect(gdp.by_bucket.severe).toBeGreaterThan(0);
  });

  test('baseline preset (0 shock everywhere) → contributes to zero bucket on every axis', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    for (const row of h.rows) {
      expect(row.by_bucket.zero).toBeGreaterThan(0);
    }
  });

  test('thresholds match the axis catalog (GDP 2/5, rate 100/250, fx 5/12)', () => {
    const h = buildScenarioShockAxisHistogram(NOW);
    const gdp = h.rows.find((r) => r.axis === 'gdp')!;
    expect(gdp.thresholds.mild_max).toBe(2);
    expect(gdp.thresholds.moderate_max).toBe(5);
    const rate = h.rows.find((r) => r.axis === 'rate')!;
    expect(rate.thresholds.mild_max).toBe(100);
    expect(rate.thresholds.moderate_max).toBe(250);
    const fx = h.rows.find((r) => r.axis === 'fx')!;
    expect(fx.thresholds.mild_max).toBe(5);
    expect(fx.thresholds.moderate_max).toBe(12);
  });
});

describe('M16.20 — platform-static', () => {
  test('different now → same data', () => {
    const a = buildScenarioShockAxisHistogram(new Date('2026-01-01T00:00:00.000Z'));
    const b = buildScenarioShockAxisHistogram(new Date('2026-12-31T00:00:00.000Z'));
    expect(a.total_presets).toBe(b.total_presets);
    expect(a.rows.map((r) => r.by_bucket)).toEqual(b.rows.map((r) => r.by_bucket));
    expect(a.most_severe_axis).toEqual(b.most_severe_axis);
  });
});

// ─── GET /v1/scenarios/library/shock-axis-histogram ──────────────────

describe('M16.20 — GET /v1/scenarios/library/shock-axis-histogram', () => {
  test('analyst+ → 200 with full histogram', async () => {
    const { app } = makeSaApp('risk_analyst');
    const r = await request(app).get('/v1/scenarios/library/shock-axis-histogram').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_presets).toBe(SCENARIO_PRESETS.length);
    expect(r.body.body.rows.length).toBe(ALL_SHOCK_AXES.length);
  });

  test('admin → 200 also', async () => {
    const { app } = makeSaApp('admin');
    const r = await request(app).get('/v1/scenarios/library/shock-axis-histogram').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('shape contains every expected field', async () => {
    const { app } = makeSaApp('admin');
    const r = await request(app).get('/v1/scenarios/library/shock-axis-histogram').set(TH_BIL);
    expect(r.body.body).toHaveProperty('rows');
    expect(r.body.body).toHaveProperty('most_severe_axis');
    expect(r.body.body).toHaveProperty('highest_mean_axis');
    expect(r.body.body).toHaveProperty('lowest_mean_axis');
    expect(r.body.body).toHaveProperty('by_bucket_totals');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSaApp('case_owner');
    const r = await request(app).get('/v1/scenarios/library/shock-axis-histogram').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL ↔ BANK_DEMO same response', async () => {
    const { app } = makeSaApp('admin');
    const bil = await request(app).get('/v1/scenarios/library/shock-axis-histogram').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/scenarios/library/shock-axis-histogram')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body.total_presets).toBe(bank.body.body.total_presets);
    expect(bil.body.body.most_severe_axis).toEqual(bank.body.body.most_severe_axis);
  });

  test('M16.18 /v1/scenarios/library/magnitude still 200 (sibling regression)', async () => {
    const { app } = makeSaApp('admin');
    const r = await request(app).get('/v1/scenarios/library/magnitude').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M16.19 /v1/scenarios/library/inventory still 200 (sibling regression)', async () => {
    const { app } = makeSaApp('admin');
    const r = await request(app).get('/v1/scenarios/library/inventory').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
