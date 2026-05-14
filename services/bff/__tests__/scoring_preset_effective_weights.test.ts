// services/bff/__tests__/scoring_preset_effective_weights.test.ts
//
// T6 M6.10 — Weight preset effective weights view.

import request from 'supertest';
import { resolveEffectivePresetWeights } from '../src/scoring_preset_effective_weights';
import { WEIGHT_PRESETS, type WeightPreset } from '../src/scoring_presets';
import { InMemoryCustomWeightPresetStore } from '../src/scoring_presets_custom';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkPreset(
  overrides: Partial<Omit<WeightPreset, 'weight_multipliers'>> & {
    multipliers?: Record<string, number>;
  } = {},
): WeightPreset {
  return {
    id: overrides.id ?? 'test_preset',
    name: overrides.name ?? 'Test',
    description: overrides.description ?? '',
    vertical: overrides.vertical ?? 'banking',
    mode: overrides.mode ?? 'balanced',
    weight_multipliers: overrides.multipliers ?? {},
  };
}

// ─── resolveEffectivePresetWeights — pure ────────────────────────────

describe('M6.10 — empty preset (no multipliers)', () => {
  test('every indicator resolves to catalog_default with multiplier=1.0', () => {
    const out = resolveEffectivePresetWeights(mkPreset());
    expect(out.preset_id).toBe('test_preset');
    expect(out.multiplier_count).toBe(0);
    expect(out.default_count).toBe(out.total);
    expect(out.entries.every((e) => e.multiplier === 1.0)).toBe(true);
    expect(out.entries.every((e) => e.source === 'catalog_default')).toBe(true);
    // Effective weight = catalog weight when multiplier=1.0.
    expect(out.entries.every((e) => e.effective_weight === e.catalog_weight)).toBe(true);
  });

  test('entries sorted by indicator_id asc', () => {
    const out = resolveEffectivePresetWeights(mkPreset());
    const ids = out.entries.map((e) => e.indicator_id);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('M6.10 — preset with sparse multipliers', () => {
  test('listed indicators flip source to preset_multiplier; unlisted stay catalog_default', () => {
    const out = resolveEffectivePresetWeights(
      mkPreset({ multipliers: { 'FIN-001': 1.5, 'CLM-001': 0.5 } }),
    );
    const fin001 = out.entries.find((e) => e.indicator_id === 'FIN-001')!;
    expect(fin001.source).toBe('preset_multiplier');
    expect(fin001.multiplier).toBe(1.5);
    // FIN-001 catalog weight is 0.9 → effective = 0.9 × 1.5 = 1.35 → clamped to 1.0.
    expect(fin001.effective_weight).toBe(1.0);
    const clm001 = out.entries.find((e) => e.indicator_id === 'CLM-001')!;
    expect(clm001.source).toBe('preset_multiplier');
    expect(clm001.multiplier).toBe(0.5);
    // CLM-001 weight 0.85 → 0.85 × 0.5 = 0.425.
    expect(clm001.effective_weight).toBeCloseTo(0.425, 5);
    // Unlisted still on default
    const other = out.entries.find((e) => e.indicator_id === 'FIN-002')!;
    expect(other.source).toBe('catalog_default');
  });

  test('multiplier_count + default_count split correctly', () => {
    const out = resolveEffectivePresetWeights(
      mkPreset({ multipliers: { 'FIN-001': 1.5, 'CLM-001': 0.5 } }),
    );
    expect(out.multiplier_count).toBe(2);
    expect(out.default_count).toBe(out.total - 2);
  });

  test('effective_weight clamps to [0, 1]', () => {
    const out = resolveEffectivePresetWeights(
      mkPreset({ multipliers: { 'FIN-001': 100, 'CLM-001': -5 } }),
    );
    const high = out.entries.find((e) => e.indicator_id === 'FIN-001')!;
    expect(high.effective_weight).toBe(1.0);
    const low = out.entries.find((e) => e.indicator_id === 'CLM-001')!;
    expect(low.effective_weight).toBe(0);
  });
});

describe('M6.10 — vertical filter', () => {
  test('vertical=banking narrows to banking indicators only', () => {
    const out = resolveEffectivePresetWeights(mkPreset(), 'banking');
    expect(out.vertical).toBe('banking');
    expect(out.entries.every((e) => e.vertical === 'banking')).toBe(true);
  });

  test('vertical=insurance narrows to insurance indicators only', () => {
    const out = resolveEffectivePresetWeights(mkPreset(), 'insurance');
    expect(out.entries.every((e) => e.vertical === 'insurance')).toBe(true);
  });

  test('invalid vertical throws', () => {
    expect(() =>
      // @ts-expect-error — testing runtime guard
      resolveEffectivePresetWeights(mkPreset(), 'banana'),
    ).toThrow(/banking|insurance/);
  });
});

describe('M6.10 — works against shipped library presets', () => {
  test('conservative_banking preset surfaces its actual multipliers', () => {
    const conservative = WEIGHT_PRESETS.find((p) => p.id === 'preset_banking_conservative')!;
    const out = resolveEffectivePresetWeights(conservative);
    // Conservative banking preset multiplies FIN-001 by 1.15.
    const fin001 = out.entries.find((e) => e.indicator_id === 'FIN-001')!;
    expect(fin001.source).toBe('preset_multiplier');
    expect(fin001.multiplier).toBe(1.15);
    // Catalog 0.9 × 1.15 = 1.035 → clamped to 1.0.
    expect(fin001.effective_weight).toBe(1.0);
  });

  test('balanced preset (empty multipliers) → all catalog_default', () => {
    const balanced = WEIGHT_PRESETS.find((p) => p.id === 'preset_banking_balanced')!;
    const out = resolveEffectivePresetWeights(balanced);
    expect(out.multiplier_count).toBe(0);
    expect(out.entries.every((e) => e.multiplier === 1.0)).toBe(true);
  });
});

// ─── Route ────────────────────────────────────────────────────────────

function makeWeightsApp(role = 'admin', store?: InMemoryCustomWeightPresetStore) {
  const customWeightPresetStore = store ?? new InMemoryCustomWeightPresetStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    customWeightPresetStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, customWeightPresetStore };
}

describe('M6.10 — GET /v1/scoring/presets/:preset_id/effective-weights', () => {
  test('library preset → 200 with full entry list', async () => {
    const { app } = makeWeightsApp('admin');
    const r = await request(app)
      .get('/v1/scoring/presets/preset_banking_conservative/effective-weights')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.preset_id).toBe('preset_banking_conservative');
    expect(r.body.body.entries.length).toBeGreaterThan(0);
    const fin001 = r.body.body.entries.find(
      (e: { indicator_id: string }) => e.indicator_id === 'FIN-001',
    );
    expect(fin001.source).toBe('preset_multiplier');
  });

  test('custom preset resolved through store', async () => {
    const store = new InMemoryCustomWeightPresetStore();
    const custom = store.create(
      'BIL',
      {
        name: 'Custom A',
        description: 'd',
        vertical: 'banking',
        mode: 'aggressive',
        weight_multipliers: { 'FIN-001': 0.5 },
      },
      'alice',
      NOW,
    );
    const { app } = makeWeightsApp('admin', store);
    const r = await request(app)
      .get(`/v1/scoring/presets/${custom.id}/effective-weights`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.preset_id).toBe(custom.id);
    const fin001 = r.body.body.entries.find(
      (e: { indicator_id: string }) => e.indicator_id === 'FIN-001',
    );
    expect(fin001.multiplier).toBe(0.5);
  });

  test('?vertical=banking narrows', async () => {
    const { app } = makeWeightsApp('admin');
    const r = await request(app)
      .get('/v1/scoring/presets/preset_banking_balanced/effective-weights?vertical=banking')
      .set(TH_BIL);
    expect(r.body.body.entries.every(
      (e: { vertical: string }) => e.vertical === 'banking',
    )).toBe(true);
  });

  test('?vertical=invalid → 400', async () => {
    const { app } = makeWeightsApp('admin');
    const r = await request(app)
      .get('/v1/scoring/presets/preset_banking_balanced/effective-weights?vertical=banana')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('unknown preset_id → 404', async () => {
    const { app } = makeWeightsApp('admin');
    const r = await request(app)
      .get('/v1/scoring/presets/does_not_exist/effective-weights')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeWeightsApp('case_owner');
    const r = await request(app)
      .get('/v1/scoring/presets/preset_banking_balanced/effective-weights')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M6.3 GET /v1/scoring/presets/:id still works (effective-weights route is additive)', async () => {
    const { app } = makeWeightsApp('admin');
    const r = await request(app)
      .get('/v1/scoring/presets/preset_banking_balanced')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.id).toBe('preset_banking_balanced');
  });
});
