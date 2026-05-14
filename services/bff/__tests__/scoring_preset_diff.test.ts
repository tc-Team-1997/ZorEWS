// services/bff/__tests__/scoring_preset_diff.test.ts
//
// T6 M6.9 — Weight preset definition diff.

import request from 'supertest';
import { diffWeightPresets } from '../src/scoring_preset_diff';
import {
  WEIGHT_PRESETS,
  type WeightPreset,
  type WeightPresetMode,
} from '../src/scoring_presets';
import { InMemoryCustomWeightPresetStore } from '../src/scoring_presets_custom';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkPreset(
  id: string,
  overrides: Partial<Omit<WeightPreset, 'weight_multipliers'>> & {
    multipliers?: Record<string, number>;
  } = {},
): WeightPreset {
  return {
    id,
    name: overrides.name ?? `Preset ${id}`,
    description: overrides.description ?? `desc for ${id}`,
    vertical: overrides.vertical ?? 'banking',
    mode: (overrides.mode ?? 'balanced') as WeightPresetMode,
    weight_multipliers: overrides.multipliers ?? {},
  };
}

// ─── diffWeightPresets ────────────────────────────────────────────────

describe('M6.9 — diffWeightPresets — identical', () => {
  test('identical presets → identical=true, no diffs surfaced', () => {
    const p = mkPreset('a', { multipliers: { i1: 1.5, i2: 0.8 } });
    const d = diffWeightPresets(p, p);
    expect(d.identical).toBe(true);
    expect(d.multipliers.added).toEqual([]);
    expect(d.multipliers.removed).toEqual([]);
    expect(d.multipliers.changed).toEqual([]);
    expect(d.multipliers.unchanged_count).toBe(2);
    expect(d.header.name.changed).toBe(false);
    expect(d.header.mode.changed).toBe(false);
  });

  test('same multipliers but different name → header changed, identical=false', () => {
    const a = mkPreset('a', { name: 'Cautious', multipliers: { i1: 1.5 } });
    const b = mkPreset('b', { name: 'Sober', multipliers: { i1: 1.5 } });
    const d = diffWeightPresets(a, b);
    expect(d.identical).toBe(false);
    expect(d.header.name.changed).toBe(true);
    expect(d.header.name.from).toBe('Cautious');
    expect(d.header.name.to).toBe('Sober');
    expect(d.multipliers.unchanged_count).toBe(1);
  });
});

describe('M6.9 — multiplier diffs', () => {
  test('added: keys present in `to` but not `from`', () => {
    const a = mkPreset('a', { multipliers: { i1: 1.5 } });
    const b = mkPreset('b', { multipliers: { i1: 1.5, i2: 2.0, i3: 0.5 } });
    const d = diffWeightPresets(a, b);
    expect(d.multipliers.added).toEqual([
      { indicator_id: 'i2', to: 2.0 },
      { indicator_id: 'i3', to: 0.5 },
    ]);
    expect(d.multipliers.removed).toEqual([]);
    expect(d.multipliers.changed).toEqual([]);
  });

  test('removed: keys present in `from` but not `to`', () => {
    const a = mkPreset('a', { multipliers: { i1: 1.5, i2: 2.0 } });
    const b = mkPreset('b', { multipliers: { i1: 1.5 } });
    const d = diffWeightPresets(a, b);
    expect(d.multipliers.removed).toEqual([{ indicator_id: 'i2', from: 2.0 }]);
    expect(d.multipliers.added).toEqual([]);
  });

  test('changed: same key, different value, delta is to-from', () => {
    const a = mkPreset('a', { multipliers: { i1: 1.0, i2: 2.0 } });
    const b = mkPreset('b', { multipliers: { i1: 1.5, i2: 1.5 } });
    const d = diffWeightPresets(a, b);
    expect(d.multipliers.changed.length).toBe(2);
    // Sorted by abs(delta) desc — i2 has |0.5|, i1 has |0.5| → tie → alphabetical
    expect(d.multipliers.changed[0]!).toEqual({
      indicator_id: 'i1',
      from: 1.0,
      to: 1.5,
      delta: 0.5,
    });
    expect(d.multipliers.changed[1]!).toEqual({
      indicator_id: 'i2',
      from: 2.0,
      to: 1.5,
      delta: -0.5,
    });
  });

  test('changed list sorted by abs(delta) desc', () => {
    const a = mkPreset('a', { multipliers: { i1: 1.0, i2: 1.0, i3: 1.0 } });
    const b = mkPreset('b', { multipliers: { i1: 1.1, i2: 3.0, i3: 0.5 } });
    const d = diffWeightPresets(a, b);
    // |Δ|: i1=0.1, i2=2.0, i3=0.5 → i2, i3, i1
    expect(d.multipliers.changed.map((c) => c.indicator_id)).toEqual(['i2', 'i3', 'i1']);
  });

  test('added/removed lists sorted by indicator_id asc', () => {
    const a = mkPreset('a', { multipliers: { z_old: 1.0, a_old: 1.0 } });
    const b = mkPreset('b', { multipliers: { z_new: 1.0, a_new: 1.0 } });
    const d = diffWeightPresets(a, b);
    expect(d.multipliers.added.map((x) => x.indicator_id)).toEqual(['a_new', 'z_new']);
    expect(d.multipliers.removed.map((x) => x.indicator_id)).toEqual(['a_old', 'z_old']);
  });

  test('added entries NOT inferred as changes-from-1.0', () => {
    // The diff treats absence as "not specified by operator", not
    // "implicitly 1.0". An indicator that appears only in `to` is
    // an `added` row, never a `changed` row from 1.0.
    const a = mkPreset('a', { multipliers: {} });
    const b = mkPreset('b', { multipliers: { i1: 1.0 } });
    const d = diffWeightPresets(a, b);
    expect(d.multipliers.added).toEqual([{ indicator_id: 'i1', to: 1.0 }]);
    expect(d.multipliers.changed).toEqual([]);
  });
});

describe('M6.9 — header diffs', () => {
  test('every header field is independently surfaced', () => {
    const a = mkPreset('a', {
      name: 'A',
      description: 'old',
      vertical: 'banking',
      mode: 'balanced',
      multipliers: { i1: 1.0 },
    });
    const b = mkPreset('b', {
      name: 'B',
      description: 'new',
      vertical: 'insurance',
      mode: 'aggressive',
      multipliers: { i1: 1.0 },
    });
    const d = diffWeightPresets(a, b);
    expect(d.header.name.changed).toBe(true);
    expect(d.header.description.changed).toBe(true);
    expect(d.header.vertical.changed).toBe(true);
    expect(d.header.vertical.from).toBe('banking');
    expect(d.header.vertical.to).toBe('insurance');
    expect(d.header.mode.changed).toBe(true);
  });
});

describe('M6.9 — works against the shipped library presets', () => {
  test('conservative_banking vs aggressive_banking has multiplier diffs', () => {
    const conservative = WEIGHT_PRESETS.find((p) => p.id === 'preset_banking_conservative');
    const aggressive = WEIGHT_PRESETS.find((p) => p.id === 'preset_banking_aggressive');
    expect(conservative).toBeDefined();
    expect(aggressive).toBeDefined();
    const d = diffWeightPresets(conservative!, aggressive!);
    expect(d.identical).toBe(false);
    // At least ONE of added/removed/changed should be non-empty.
    const someDiff =
      d.multipliers.added.length +
        d.multipliers.removed.length +
        d.multipliers.changed.length >
      0;
    expect(someDiff).toBe(true);
  });
});

// ─── GET /v1/scoring/presets/diff ────────────────────────────────────

function makeDiffApp(role = 'admin', store?: InMemoryCustomWeightPresetStore) {
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

describe('M6.9 — GET /v1/scoring/presets/diff', () => {
  test('library vs library → 200 with diff envelope', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app)
      .get('/v1/scoring/presets/diff?from=preset_banking_conservative&to=preset_banking_aggressive')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.diff.from_id).toBe('preset_banking_conservative');
    expect(r.body.body.diff.to_id).toBe('preset_banking_aggressive');
    expect(r.body.body.diff.identical).toBe(false);
  });

  test('identical library preset → identical=true', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app)
      .get('/v1/scoring/presets/diff?from=preset_banking_balanced&to=preset_banking_balanced')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.diff.identical).toBe(true);
  });

  test('library vs tenant custom: resolves both, diffs work', async () => {
    const store = new InMemoryCustomWeightPresetStore();
    const custom = store.create(
      'BIL',
      {
        name: 'Custom tweak',
        description: 'My fork of conservative_banking',
        vertical: 'banking',
        mode: 'conservative',
        weight_multipliers: { fraud_history: 3.5 },
      },
      'alice',
      NOW,
    );
    const { app } = makeDiffApp('admin', store);
    const r = await request(app)
      .get(`/v1/scoring/presets/diff?from=preset_banking_conservative&to=${custom.id}`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.diff.from_id).toBe('preset_banking_conservative');
    expect(r.body.body.diff.to_id).toBe(custom.id);
  });

  test('unknown preset id → 404', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app)
      .get('/v1/scoring/presets/diff?from=preset_does_not_exist&to=preset_banking_balanced')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });

  test('missing query param → 400', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app)
      .get('/v1/scoring/presets/diff?from=preset_banking_balanced')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeDiffApp('case_owner');
    const r = await request(app)
      .get('/v1/scoring/presets/diff?from=preset_banking_balanced&to=preset_banking_aggressive')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BANK_DEMO cannot see BIL custom preset', async () => {
    const store = new InMemoryCustomWeightPresetStore();
    const custom = store.create(
      'BIL',
      {
        name: 'BIL only',
        description: 'tenant-scoped',
        vertical: 'banking',
        mode: 'conservative',
        weight_multipliers: { i1: 2.0 },
      },
      'alice',
      NOW,
    );
    const { app } = makeDiffApp('admin', store);
    const r = await request(app)
      .get(`/v1/scoring/presets/diff?from=preset_banking_balanced&to=${custom.id}`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(404);
  });
});
