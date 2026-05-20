// T6 M6.19 — Custom weight preset multiplier histogram.

import request from 'supertest';
import { buildCustomPresetMultiplierHistogram } from '../src/scoring_preset_custom_multiplier_histogram';
import {
  InMemoryCustomWeightPresetStore,
  type CustomWeightPresetStore,
} from '../src/scoring_presets_custom';
import {
  ALL_MULTIPLIER_BUCKETS,
} from '../src/scoring_preset_multiplier_histogram';
import type { WeightPreset } from '../src/scoring_presets';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeTestApp(
  role: string = 'admin',
  customWeightPresetStore?: CustomWeightPresetStore,
) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    customWeightPresetStore,
  });
}

function makeCustomPreset(
  id: string,
  weight_multipliers: Record<string, number>,
  overrides: Partial<WeightPreset> = {},
): WeightPreset {
  return {
    id,
    name: `Custom ${id}`,
    description: 'test',
    vertical: 'banking',
    mode: 'balanced',
    weight_multipliers,
    ...overrides,
  };
}

describe('M6.19 — buildCustomPresetMultiplierHistogram', () => {
  test('empty input → empty rows + null leaderboards', () => {
    const m = buildCustomPresetMultiplierHistogram('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.total_presets).toBe(0);
    expect(m.total_multipliers).toBe(0);
    expect(m.rows).toEqual([]);
    expect(m.most_active_preset).toBeNull();
    expect(m.most_boosted_preset).toBeNull();
    expect(m.most_dampened_preset).toBeNull();
    expect(m.highest_multiplier).toBeNull();
    expect(m.lowest_multiplier).toBeNull();
    for (const b of ALL_MULTIPLIER_BUCKETS) {
      expect(m.by_bucket_totals[b]).toBe(0);
    }
  });

  test('rows sorted by preset_id asc', () => {
    const presets = [
      makeCustomPreset('zebra', { 'FIN-001': 1.5 }),
      makeCustomPreset('alpha', { 'BEH-001': 1.2 }),
      makeCustomPreset('mike', { 'TXN-001': 0.7 }),
    ];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    expect(m.rows.map((r) => r.preset_id)).toEqual(['alpha', 'mike', 'zebra']);
  });

  test('single preset multi-bucket', () => {
    // 0.4 = strong_dampen, 0.7 = mild_dampen, 1.0 = no-op, 1.2 = mild_boost, 2.0 = strong_boost
    const presets = [
      makeCustomPreset('p1', {
        'A': 0.4,
        'B': 0.7,
        'C': 1.0,
        'D': 1.2,
        'E': 2.0,
      }),
    ];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    expect(m.total_presets).toBe(1);
    expect(m.total_multipliers).toBe(5);
    const row = m.rows[0];
    expect(row.by_bucket.strong_dampen).toBe(1);
    expect(row.by_bucket.mild_dampen).toBe(1);
    expect(row.by_bucket.mild_boost).toBe(1);
    expect(row.by_bucket.strong_boost).toBe(1);
    // The 1.0 (exact no-op) doesn't fall into any bucket
    expect(row.boost_count).toBe(2); // 1.2 + 2.0
    expect(row.dampen_count).toBe(2); // 0.4 + 0.7
    expect(row.min_multiplier).toBe(0.4);
    expect(row.max_multiplier).toBe(2.0);
  });

  test('mean_multiplier = sum / N', () => {
    const presets = [
      makeCustomPreset('p1', { 'A': 0.5, 'B': 1.5 }),
    ];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    expect(m.rows[0].mean_multiplier).toBe(1.0); // (0.5 + 1.5) / 2
  });

  test('mean_multiplier null on zero-multiplier preset', () => {
    const presets = [makeCustomPreset('p1', {})];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    expect(m.rows[0].mean_multiplier).toBeNull();
    expect(m.rows[0].total_multipliers).toBe(0);
  });

  test('bucket boundary semantics', () => {
    const presets = [
      // 0.5 = mild_dampen (>= 0.5 is mild, < 0.5 strong)
      makeCustomPreset('p1', { 'A': 0.5 }),
      // 1.5 = mild_boost (<= 1.5)
      makeCustomPreset('p2', { 'A': 1.5 }),
      // 1.51 = strong_boost
      makeCustomPreset('p3', { 'A': 1.51 }),
    ];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    expect(m.rows.find((r) => r.preset_id === 'p1')!.by_bucket.mild_dampen).toBe(1);
    expect(m.rows.find((r) => r.preset_id === 'p2')!.by_bucket.mild_boost).toBe(1);
    expect(m.rows.find((r) => r.preset_id === 'p3')!.by_bucket.strong_boost).toBe(1);
  });

  test('Σ rows.total_multipliers = total_multipliers', () => {
    const presets = [
      makeCustomPreset('p1', { 'A': 1.5, 'B': 0.5 }),
      makeCustomPreset('p2', { 'C': 1.2 }),
    ];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    const sum = m.rows.reduce((a, r) => a + r.total_multipliers, 0);
    expect(sum).toBe(m.total_multipliers);
    expect(sum).toBe(3);
  });

  test('by_bucket_totals = Σ across rows', () => {
    const presets = [
      makeCustomPreset('p1', { 'A': 0.4, 'B': 1.2 }),
      makeCustomPreset('p2', { 'C': 2.0 }),
    ];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    expect(m.by_bucket_totals.strong_dampen).toBe(1);
    expect(m.by_bucket_totals.mild_boost).toBe(1);
    expect(m.by_bucket_totals.strong_boost).toBe(1);
  });

  test('most_active_preset formula', () => {
    const presets = [
      makeCustomPreset('p1', { 'A': 1.2 }),
      makeCustomPreset('p2', { 'A': 1.2, 'B': 1.5, 'C': 1.8 }),
      makeCustomPreset('p3', { 'A': 0.7 }),
    ];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    expect(m.most_active_preset).toBe('p2');
  });

  test('most_active_preset canonical asc tie-break', () => {
    const presets = [
      makeCustomPreset('zebra', { 'A': 1.2 }),
      makeCustomPreset('alpha', { 'A': 1.2 }),
    ];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    expect(m.most_active_preset).toBe('alpha');
  });

  test('most_active_preset null on empty', () => {
    const m = buildCustomPresetMultiplierHistogram('BIL', [], NOW);
    expect(m.most_active_preset).toBeNull();
  });

  test('most_boosted_preset formula', () => {
    const presets = [
      makeCustomPreset('p1', { 'A': 1.5, 'B': 1.2, 'C': 0.5 }),
      makeCustomPreset('p2', { 'A': 1.5 }),
    ];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    expect(m.most_boosted_preset).toBe('p1'); // 2 boosts vs 1
  });

  test('most_boosted_preset null when no boosts', () => {
    const presets = [
      makeCustomPreset('p1', { 'A': 0.5, 'B': 0.7 }),
    ];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    expect(m.most_boosted_preset).toBeNull();
    expect(m.most_dampened_preset).toBe('p1');
  });

  test('most_dampened_preset formula', () => {
    const presets = [
      makeCustomPreset('p1', { 'A': 0.5, 'B': 0.7 }),
      makeCustomPreset('p2', { 'A': 0.5 }),
    ];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    expect(m.most_dampened_preset).toBe('p1');
  });

  test('most_dampened_preset null when no dampens', () => {
    const presets = [makeCustomPreset('p1', { 'A': 1.5, 'B': 1.2 })];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    expect(m.most_dampened_preset).toBeNull();
  });

  test('highest_multiplier formula', () => {
    const presets = [
      makeCustomPreset('p1', { 'A': 1.5, 'B': 2.5 }),
      makeCustomPreset('p2', { 'C': 1.2 }),
    ];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    expect(m.highest_multiplier).toEqual({
      preset_id: 'p1',
      indicator_id: 'B',
      value: 2.5,
    });
  });

  test('lowest_multiplier formula', () => {
    const presets = [
      makeCustomPreset('p1', { 'A': 1.5, 'B': 0.3 }),
      makeCustomPreset('p2', { 'C': 1.2 }),
    ];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    expect(m.lowest_multiplier).toEqual({
      preset_id: 'p1',
      indicator_id: 'B',
      value: 0.3,
    });
  });

  test('highest + lowest null on empty', () => {
    const m = buildCustomPresetMultiplierHistogram('BIL', [], NOW);
    expect(m.highest_multiplier).toBeNull();
    expect(m.lowest_multiplier).toBeNull();
  });

  test('highest + lowest null when only zero-multiplier presets', () => {
    const presets = [makeCustomPreset('p1', {})];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    expect(m.highest_multiplier).toBeNull();
    expect(m.lowest_multiplier).toBeNull();
  });

  test('row carries mode + vertical from input', () => {
    const presets = [
      makeCustomPreset(
        'p1',
        { 'A': 1.2 },
        { mode: 'aggressive', vertical: 'insurance' },
      ),
    ];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    expect(m.rows[0].mode).toBe('aggressive');
    expect(m.rows[0].vertical).toBe('insurance');
  });

  test('1.0 exact no-op does not affect buckets', () => {
    const presets = [
      makeCustomPreset('p1', { 'A': 1.0, 'B': 1.0, 'C': 1.5 }),
    ];
    const m = buildCustomPresetMultiplierHistogram('BIL', presets, NOW);
    const row = m.rows[0];
    expect(row.total_multipliers).toBe(3);
    expect(row.by_bucket.mild_boost).toBe(1); // only C contributes
    expect(row.boost_count).toBe(1);
    expect(row.dampen_count).toBe(0);
    // 1.0s still count toward min/max
    expect(row.min_multiplier).toBe(1.0);
    expect(row.max_multiplier).toBe(1.5);
  });

  test('tenant_id + generated_at echo', () => {
    const m = buildCustomPresetMultiplierHistogram('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.generated_at).toBe(NOW.toISOString());
  });
});

describe('M6.19 — GET /v1/scoring/presets/custom/multiplier-histogram', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeTestApp('admin', new InMemoryCustomWeightPresetStore());
    const r = await request(app)
      .get('/v1/scoring/presets/custom/multiplier-histogram')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_presets).toBe(0);
    expect(r.body.body.rows).toEqual([]);
    expect(r.body.body.most_active_preset).toBeNull();
  });

  test('populated reflects custom presets', async () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create(
      'BIL',
      {
        name: 'Test 1',
        description: 'test',
        vertical: 'banking',
        mode: 'aggressive',
        weight_multipliers: { 'FIN-001': 1.5, 'FIN-002': 1.8, 'BEH-001': 0.5 },
      },
      'alice',
      NOW,
    );
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/scoring/presets/custom/multiplier-histogram')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_presets).toBe(1);
    expect(r.body.body.total_multipliers).toBe(3);
    expect(r.body.body.most_active_preset).not.toBeNull();
  });

  test('analyst+ accepted', async () => {
    const { app } = makeTestApp(
      'risk_analyst',
      new InMemoryCustomWeightPresetStore(),
    );
    const r = await request(app)
      .get('/v1/scoring/presets/custom/multiplier-histogram')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('unknown role → 403', async () => {
    const { app } = makeTestApp(
      'unknown_role',
      new InMemoryCustomWeightPresetStore(),
    );
    const r = await request(app)
      .get('/v1/scoring/presets/custom/multiplier-histogram')
      .set(TH);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create(
      'BIL',
      {
        name: 'Test 1',
        description: 'test',
        vertical: 'banking',
        mode: 'aggressive',
        weight_multipliers: { 'FIN-001': 1.5 },
      },
      'alice',
      NOW,
    );
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/scoring/presets/custom/multiplier-histogram')
      .set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total_presets).toBe(0);
  });

  test('M6.16 /multiplier-histogram (library) sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/scoring/presets/multiplier-histogram')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('M6.18 /family-matrix sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/scoring/presets/family-matrix')
      .set(TH);
    expect(r.status).toBe(200);
  });
});
