// services/bff/__tests__/scoring_preset_multiplier_histogram.test.ts
//
// T6 M6.16 — Library preset multiplier histogram.

import request from 'supertest';
import {
  buildPresetMultiplierHistogram,
  ALL_MULTIPLIER_BUCKETS,
  STRONG_DAMPEN_THRESHOLD,
  STRONG_BOOST_THRESHOLD,
} from '../src/scoring_preset_multiplier_histogram';
import { WEIGHT_PRESETS } from '../src/scoring_presets';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeMhApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── buildPresetMultiplierHistogram — pure ───────────────────────────

describe('M6.16 — basic shape', () => {
  test('envelope contains expected fields', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    expect(h.generated_at).toBe(NOW.toISOString());
    expect(h.total_presets).toBe(WEIGHT_PRESETS.length);
    expect(h.rows.length).toBe(WEIGHT_PRESETS.length);
    expect(h).toHaveProperty('total_multipliers');
    expect(h).toHaveProperty('by_bucket_totals');
    expect(h).toHaveProperty('most_active_preset');
    expect(h).toHaveProperty('highest_multiplier');
    expect(h).toHaveProperty('lowest_multiplier');
  });
});

describe('M6.16 — rows sorted by preset_id asc', () => {
  test('rows[] ordered alphabetically by preset_id', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    for (let i = 1; i < h.rows.length; i++) {
      expect(h.rows[i - 1]!.preset_id.localeCompare(h.rows[i]!.preset_id)).toBeLessThan(0);
    }
  });
});

describe('M6.16 — per-row total matches catalog', () => {
  test('total_multipliers === Object.keys(weight_multipliers).length', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    for (const row of h.rows) {
      const preset = WEIGHT_PRESETS.find((p) => p.id === row.preset_id)!;
      expect(row.total_multipliers).toBe(Object.keys(preset.weight_multipliers).length);
    }
  });
});

describe('M6.16 — every-bucket-key-present per row', () => {
  test('row.by_bucket has every MultiplierBucket key', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    for (const row of h.rows) {
      for (const b of ALL_MULTIPLIER_BUCKETS) {
        expect(row.by_bucket).toHaveProperty(b);
        expect(typeof row.by_bucket[b]).toBe('number');
      }
    }
  });
});

describe('M6.16 — bucket boundary semantics', () => {
  test('multipliers strictly < 0.5 land in strong_dampen', () => {
    // The library doesn't have such low multipliers; verify via row math.
    const h = buildPresetMultiplierHistogram(NOW);
    for (const row of h.rows) {
      const preset = WEIGHT_PRESETS.find((p) => p.id === row.preset_id)!;
      for (const [, multiplier] of Object.entries(preset.weight_multipliers)) {
        if (multiplier < STRONG_DAMPEN_THRESHOLD) {
          expect(row.by_bucket.strong_dampen).toBeGreaterThan(0);
        }
      }
    }
  });

  test('multipliers > 1.5 land in strong_boost', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    for (const row of h.rows) {
      const preset = WEIGHT_PRESETS.find((p) => p.id === row.preset_id)!;
      for (const [, multiplier] of Object.entries(preset.weight_multipliers)) {
        if (multiplier > STRONG_BOOST_THRESHOLD) {
          expect(row.by_bucket.strong_boost).toBeGreaterThan(0);
        }
      }
    }
  });

  test('multipliers in [0.5, 1.0) land in mild_dampen', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    for (const row of h.rows) {
      const preset = WEIGHT_PRESETS.find((p) => p.id === row.preset_id)!;
      let mildDampenManual = 0;
      for (const [, m] of Object.entries(preset.weight_multipliers)) {
        if (m >= STRONG_DAMPEN_THRESHOLD && m < 1.0) mildDampenManual++;
      }
      expect(row.by_bucket.mild_dampen).toBe(mildDampenManual);
    }
  });

  test('multipliers in (1.0, 1.5] land in mild_boost', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    for (const row of h.rows) {
      const preset = WEIGHT_PRESETS.find((p) => p.id === row.preset_id)!;
      let mildBoostManual = 0;
      for (const [, m] of Object.entries(preset.weight_multipliers)) {
        if (m > 1.0 && m <= STRONG_BOOST_THRESHOLD) mildBoostManual++;
      }
      expect(row.by_bucket.mild_boost).toBe(mildBoostManual);
    }
  });
});

describe('M6.16 — boost/dampen counts', () => {
  test('boost_count + dampen_count ≤ total_multipliers (1.0 excluded from both)', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    for (const row of h.rows) {
      expect(row.boost_count + row.dampen_count).toBeLessThanOrEqual(row.total_multipliers);
    }
  });

  test('boost_count matches manual filter (multiplier > 1.0)', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    for (const row of h.rows) {
      const preset = WEIGHT_PRESETS.find((p) => p.id === row.preset_id)!;
      const manual = Object.values(preset.weight_multipliers).filter((m) => m > 1.0).length;
      expect(row.boost_count).toBe(manual);
    }
  });

  test('dampen_count matches manual filter (multiplier < 1.0)', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    for (const row of h.rows) {
      const preset = WEIGHT_PRESETS.find((p) => p.id === row.preset_id)!;
      const manual = Object.values(preset.weight_multipliers).filter((m) => m < 1.0).length;
      expect(row.dampen_count).toBe(manual);
    }
  });
});

describe('M6.16 — min/mean/max', () => {
  test('null on empty multiplier maps (balanced presets)', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    for (const row of h.rows) {
      if (row.total_multipliers === 0) {
        expect(row.min_multiplier).toBeNull();
        expect(row.mean_multiplier).toBeNull();
        expect(row.max_multiplier).toBeNull();
      }
    }
  });

  test('min ≤ mean ≤ max when total_multipliers > 0', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    for (const row of h.rows) {
      if (row.total_multipliers > 0) {
        expect(row.min_multiplier!).toBeLessThanOrEqual(row.mean_multiplier!);
        expect(row.mean_multiplier!).toBeLessThanOrEqual(row.max_multiplier!);
      }
    }
  });

  test('min + max + mean match manual catalog scan', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    for (const row of h.rows) {
      if (row.total_multipliers === 0) continue;
      const preset = WEIGHT_PRESETS.find((p) => p.id === row.preset_id)!;
      const values = Object.values(preset.weight_multipliers);
      const manualMin = Math.min(...values);
      const manualMax = Math.max(...values);
      const manualMean = +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(4);
      expect(row.min_multiplier).toBe(manualMin);
      expect(row.max_multiplier).toBe(manualMax);
      expect(row.mean_multiplier).toBe(manualMean);
    }
  });
});

describe('M6.16 — most_active_preset', () => {
  test('points at preset with most total_multipliers', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    if (h.most_active_preset === null) return;
    const targetRow = h.rows.find((r) => r.preset_id === h.most_active_preset!.preset_id)!;
    expect(h.most_active_preset.total_multipliers).toBe(targetRow.total_multipliers);
    for (const row of h.rows) {
      expect(row.total_multipliers).toBeLessThanOrEqual(targetRow.total_multipliers);
    }
  });
});

describe('M6.16 — most_boosted_preset', () => {
  test('points at preset with most boost_count, never balanced (empty map)', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    if (h.most_boosted_preset === null) return;
    const targetRow = h.rows.find((r) => r.preset_id === h.most_boosted_preset!.preset_id)!;
    expect(targetRow.boost_count).toBeGreaterThan(0);
    for (const row of h.rows) {
      expect(row.boost_count).toBeLessThanOrEqual(targetRow.boost_count);
    }
  });
});

describe('M6.16 — most_dampened_preset', () => {
  test('points at preset with most dampen_count', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    if (h.most_dampened_preset === null) return;
    const targetRow = h.rows.find((r) => r.preset_id === h.most_dampened_preset!.preset_id)!;
    expect(targetRow.dampen_count).toBeGreaterThan(0);
    for (const row of h.rows) {
      expect(row.dampen_count).toBeLessThanOrEqual(targetRow.dampen_count);
    }
  });
});

describe('M6.16 — highest_multiplier', () => {
  test('points at globally maximum (preset, indicator) multiplier', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    if (h.highest_multiplier === null) return;
    let globalMax = -Infinity;
    for (const preset of WEIGHT_PRESETS) {
      for (const [, m] of Object.entries(preset.weight_multipliers)) {
        if (m > globalMax) globalMax = m;
      }
    }
    expect(h.highest_multiplier.multiplier).toBe(globalMax);
  });
});

describe('M6.16 — lowest_multiplier', () => {
  test('points at globally minimum (preset, indicator) multiplier', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    if (h.lowest_multiplier === null) return;
    let globalMin = Infinity;
    for (const preset of WEIGHT_PRESETS) {
      for (const [, m] of Object.entries(preset.weight_multipliers)) {
        if (m < globalMin) globalMin = m;
      }
    }
    expect(h.lowest_multiplier.multiplier).toBe(globalMin);
  });
});

describe('M6.16 — by_bucket_totals', () => {
  test('= Σ across rows for each bucket', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    for (const b of ALL_MULTIPLIER_BUCKETS) {
      const sum = h.rows.reduce((acc, r) => acc + r.by_bucket[b], 0);
      expect(h.by_bucket_totals[b]).toBe(sum);
    }
  });
});

describe('M6.16 — total_multipliers cross-check', () => {
  test('= Σ across rows', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    const sum = h.rows.reduce((acc, r) => acc + r.total_multipliers, 0);
    expect(h.total_multipliers).toBe(sum);
  });

  test('= Σ across catalog presets', () => {
    const h = buildPresetMultiplierHistogram(NOW);
    let manual = 0;
    for (const preset of WEIGHT_PRESETS) {
      manual += Object.keys(preset.weight_multipliers).length;
    }
    expect(h.total_multipliers).toBe(manual);
  });
});

describe('M6.16 — platform-static', () => {
  test('different now → same data', () => {
    const a = buildPresetMultiplierHistogram(new Date('2026-01-01T00:00:00.000Z'));
    const b = buildPresetMultiplierHistogram(new Date('2026-12-31T00:00:00.000Z'));
    expect(a.total_presets).toBe(b.total_presets);
    expect(a.total_multipliers).toBe(b.total_multipliers);
    expect(a.highest_multiplier).toEqual(b.highest_multiplier);
    expect(a.lowest_multiplier).toEqual(b.lowest_multiplier);
  });
});

// ─── GET /v1/scoring/presets/multiplier-histogram ────────────────────

describe('M6.16 — GET /v1/scoring/presets/multiplier-histogram', () => {
  test('analyst+ → 200 with full histogram', async () => {
    const { app } = makeMhApp('risk_analyst');
    const r = await request(app).get('/v1/scoring/presets/multiplier-histogram').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_presets).toBe(WEIGHT_PRESETS.length);
    expect(r.body.body.rows.length).toBe(WEIGHT_PRESETS.length);
  });

  test('admin → 200 also', async () => {
    const { app } = makeMhApp('admin');
    const r = await request(app).get('/v1/scoring/presets/multiplier-histogram').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('shape contains every expected field', async () => {
    const { app } = makeMhApp('admin');
    const r = await request(app).get('/v1/scoring/presets/multiplier-histogram').set(TH_BIL);
    expect(r.body.body).toHaveProperty('rows');
    expect(r.body.body).toHaveProperty('most_active_preset');
    expect(r.body.body).toHaveProperty('most_boosted_preset');
    expect(r.body.body).toHaveProperty('most_dampened_preset');
    expect(r.body.body).toHaveProperty('highest_multiplier');
    expect(r.body.body).toHaveProperty('lowest_multiplier');
    expect(r.body.body).toHaveProperty('by_bucket_totals');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeMhApp('case_owner');
    const r = await request(app).get('/v1/scoring/presets/multiplier-histogram').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL ↔ BANK_DEMO same response', async () => {
    const { app } = makeMhApp('admin');
    const bil = await request(app).get('/v1/scoring/presets/multiplier-histogram').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/scoring/presets/multiplier-histogram')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body.total_presets).toBe(bank.body.body.total_presets);
    expect(bil.body.body.highest_multiplier).toEqual(bank.body.body.highest_multiplier);
  });

  test('literal `/multiplier-histogram` not captured by `:preset_id`', async () => {
    const { app } = makeMhApp('admin');
    const r = await request(app).get('/v1/scoring/presets/multiplier-histogram').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M6.15 /v1/scoring/presets/inventory still 200 (sibling regression)', async () => {
    const { app } = makeMhApp('admin');
    const r = await request(app).get('/v1/scoring/presets/inventory').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M6.3 /v1/scoring/presets still 200 (sibling regression)', async () => {
    const { app } = makeMhApp('admin');
    const r = await request(app).get('/v1/scoring/presets').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
