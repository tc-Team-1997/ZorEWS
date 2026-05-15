// services/bff/__tests__/scenario_magnitude.test.ts
//
// T6 M16.18 — Scenario library shock magnitude rollup.

import request from 'supertest';
import { buildScenarioMagnitudeSummary } from '../src/scenario_magnitude';
import { SCENARIO_PRESETS, type ScenarioPreset } from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function preset(overrides: Partial<ScenarioPreset>): ScenarioPreset {
  return {
    id: 'test',
    name: 'Test',
    description: '',
    category: 'business',
    regulator: 'INTERNAL',
    severity: 'mild',
    shocks: { gdp: 0, rate: 0, fx: 0 },
    source_doc: '',
    ...overrides,
  };
}

// ─── buildScenarioMagnitudeSummary — pure ────────────────────────────

describe('M16.18 — default library covers every preset', () => {
  test('total_presets matches library size', () => {
    const s = buildScenarioMagnitudeSummary(NOW);
    expect(s.total_presets).toBe(SCENARIO_PRESETS.length);
    expect(s.presets.length).toBe(SCENARIO_PRESETS.length);
  });

  test('every preset id present', () => {
    const s = buildScenarioMagnitudeSummary(NOW);
    const ids = new Set(s.presets.map((p) => p.preset_id));
    for (const p of SCENARIO_PRESETS) expect(ids.has(p.id)).toBe(true);
  });
});

describe('M16.18 — library_max_abs', () => {
  test('per-axis max-abs across input presets', () => {
    const presets = [
      preset({ id: 'a', shocks: { gdp: -4, rate: 100, fx: 5 } }),
      preset({ id: 'b', shocks: { gdp: 1, rate: -200, fx: 3 } }),
    ];
    const s = buildScenarioMagnitudeSummary(NOW, presets);
    expect(s.library_max_abs.gdp).toBe(4);
    expect(s.library_max_abs.rate).toBe(200);
    expect(s.library_max_abs.fx).toBe(5);
  });
});

describe('M16.18 — magnitude_normalised', () => {
  test('all-zero shocks → magnitude=0', () => {
    const presets = [preset({ id: 'zero', shocks: { gdp: 0, rate: 0, fx: 0 } })];
    const s = buildScenarioMagnitudeSummary(NOW, presets);
    expect(s.presets[0]!.magnitude_normalised).toBe(0);
  });

  test('preset matching library max-abs on every axis → magnitude=1', () => {
    const presets = [
      preset({ id: 'max', shocks: { gdp: -4, rate: 200, fx: 5 } }),
      preset({ id: 'half', shocks: { gdp: -2, rate: 100, fx: 2.5 } }),
    ];
    const s = buildScenarioMagnitudeSummary(NOW, presets);
    expect(s.presets.find((p) => p.preset_id === 'max')!.magnitude_normalised).toBeCloseTo(1);
    expect(s.presets.find((p) => p.preset_id === 'half')!.magnitude_normalised).toBeCloseTo(0.5);
  });

  test('magnitude is mean of normalised axis values', () => {
    const presets = [
      preset({ id: 'a', shocks: { gdp: -4, rate: 0, fx: 5 } }), // |gdp|/4 + 0 + |fx|/5 → (1 + 0 + 1)/3 = 0.667
      preset({ id: 'b', shocks: { gdp: 0, rate: 200, fx: 0 } }), // 0 + 1 + 0 = 0.333
    ];
    const s = buildScenarioMagnitudeSummary(NOW, presets);
    const a = s.presets.find((p) => p.preset_id === 'a')!;
    expect(a.magnitude_normalised).toBeCloseTo(2 / 3);
  });

  test('sign is ignored — abs only', () => {
    const presets = [
      preset({ id: 'neg', shocks: { gdp: -4, rate: -200, fx: -5 } }),
      preset({ id: 'pos', shocks: { gdp: 4, rate: 200, fx: 5 } }),
    ];
    const s = buildScenarioMagnitudeSummary(NOW, presets);
    const neg = s.presets.find((p) => p.preset_id === 'neg')!;
    const pos = s.presets.find((p) => p.preset_id === 'pos')!;
    expect(neg.magnitude_normalised).toBeCloseTo(pos.magnitude_normalised);
  });
});

describe('M16.18 — constant axis edge case', () => {
  test('all-zero gdp across library → safeNorm returns 0 (no NaN)', () => {
    const presets = [
      preset({ id: 'a', shocks: { gdp: 0, rate: 100, fx: 2 } }),
      preset({ id: 'b', shocks: { gdp: 0, rate: 200, fx: 4 } }),
    ];
    const s = buildScenarioMagnitudeSummary(NOW, presets);
    expect(s.library_max_abs.gdp).toBe(0);
    for (const r of s.presets) {
      expect(r.gdp_norm).toBe(0);
      expect(Number.isFinite(r.magnitude_normalised)).toBe(true);
    }
  });
});

describe('M16.18 — sort order', () => {
  test('presets sorted by magnitude_normalised desc with preset_id asc tie-break', () => {
    const presets = [
      preset({ id: 'm-low', shocks: { gdp: -1, rate: 50, fx: 1 } }),
      preset({ id: 'm-high', shocks: { gdp: -4, rate: 200, fx: 5 } }),
      preset({ id: 'm-med-a', shocks: { gdp: -2, rate: 100, fx: 2.5 } }),
      preset({ id: 'm-med-b', shocks: { gdp: -2, rate: 100, fx: 2.5 } }),
    ];
    const s = buildScenarioMagnitudeSummary(NOW, presets);
    expect(s.presets.map((p) => p.preset_id)).toEqual([
      'm-high',
      'm-med-a',
      'm-med-b',
      'm-low',
    ]);
  });
});

describe('M16.18 — by_category', () => {
  test('every declared category present even with zero presets', () => {
    const presets = [preset({ id: 'a', category: 'baseline', shocks: { gdp: 0, rate: 0, fx: 0 } })];
    const s = buildScenarioMagnitudeSummary(NOW, presets);
    const cats = new Set(s.by_category.map((c) => c.category));
    expect(cats.has('baseline')).toBe(true);
    expect(cats.has('business')).toBe(true);
    expect(cats.has('regulatory')).toBe(true);
    expect(cats.has('black_swan')).toBe(true);
  });

  test('per-category preset_count + total_magnitude aggregate correctly', () => {
    const presets = [
      preset({ id: 'r1', category: 'regulatory', shocks: { gdp: -4, rate: 200, fx: 5 } }),
      preset({ id: 'r2', category: 'regulatory', shocks: { gdp: -2, rate: 100, fx: 2.5 } }),
      preset({ id: 'b1', category: 'business', shocks: { gdp: -1, rate: 50, fx: 1 } }),
    ];
    const s = buildScenarioMagnitudeSummary(NOW, presets);
    const reg = s.by_category.find((c) => c.category === 'regulatory')!;
    expect(reg.preset_count).toBe(2);
    expect(reg.total_magnitude).toBeCloseTo(1.0 + 0.5);
    expect(reg.mean_magnitude).toBeCloseTo(0.75);
  });

  test('mean_magnitude null for empty categories', () => {
    const presets = [preset({ id: 'a', category: 'business', shocks: { gdp: 0, rate: 0, fx: 0 } })];
    const s = buildScenarioMagnitudeSummary(NOW, presets);
    const empty = s.by_category.find((c) => c.category === 'baseline')!;
    expect(empty.preset_count).toBe(0);
    expect(empty.mean_magnitude).toBeNull();
    expect(empty.max_magnitude_preset_id).toBeNull();
  });

  test('max_magnitude_preset_id points at highest within category', () => {
    const presets = [
      preset({ id: 'high', category: 'regulatory', shocks: { gdp: -4, rate: 200, fx: 5 } }),
      preset({ id: 'low', category: 'regulatory', shocks: { gdp: -1, rate: 50, fx: 1 } }),
    ];
    const s = buildScenarioMagnitudeSummary(NOW, presets);
    const reg = s.by_category.find((c) => c.category === 'regulatory')!;
    expect(reg.max_magnitude_preset_id).toBe('high');
  });

  test('by_category sorted by total_magnitude desc', () => {
    const presets = [
      preset({ id: 'r1', category: 'regulatory', shocks: { gdp: -4, rate: 200, fx: 5 } }),
      preset({ id: 'b1', category: 'business', shocks: { gdp: -1, rate: 50, fx: 1 } }),
    ];
    const s = buildScenarioMagnitudeSummary(NOW, presets);
    // regulatory total = 1.0, business = 0.25
    expect(s.by_category[0]!.category).toBe('regulatory');
    expect(s.by_category[1]!.category).toBe('business');
  });
});

describe('M16.18 — most_aggressive_preset + most_aggressive_category', () => {
  test('point at the highest-magnitude entries', () => {
    const presets = [
      preset({ id: 'heavy', category: 'black_swan', shocks: { gdp: -4, rate: 200, fx: 5 } }),
      preset({ id: 'light', category: 'business', shocks: { gdp: -1, rate: 50, fx: 1 } }),
    ];
    const s = buildScenarioMagnitudeSummary(NOW, presets);
    expect(s.most_aggressive_preset!.preset_id).toBe('heavy');
    expect(s.most_aggressive_category).toBe('black_swan');
  });

  test('null when empty library', () => {
    const s = buildScenarioMagnitudeSummary(NOW, []);
    expect(s.most_aggressive_preset).toBeNull();
    expect(s.most_aggressive_category).toBeNull();
  });
});

describe('M16.18 — default library baseline preset has magnitude 0', () => {
  test('preset_baseline_no_shock has magnitude 0', () => {
    const s = buildScenarioMagnitudeSummary(NOW);
    const baseline = s.presets.find((p) => p.preset_id === 'preset_baseline_no_shock');
    expect(baseline).toBeDefined();
    expect(baseline!.magnitude_normalised).toBe(0);
  });
});

// ─── GET /v1/scenarios/library/magnitude ─────────────────────────────

function makeMagApp(role = 'risk_analyst') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M16.18 — GET /v1/scenarios/library/magnitude', () => {
  test('analyst+ → 200 with full summary', async () => {
    const { app } = makeMagApp('risk_analyst');
    const r = await request(app).get('/v1/scenarios/library/magnitude').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_presets).toBe(SCENARIO_PRESETS.length);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeMagApp('case_owner');
    const r = await request(app).get('/v1/scenarios/library/magnitude').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL and BANK_DEMO see the same summary', async () => {
    const { app } = makeMagApp('admin');
    const bil = await request(app).get('/v1/scenarios/library/magnitude').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/scenarios/library/magnitude')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });

  test('M16.17 /v1/scenarios/library/coverage-matrix still works (sibling)', async () => {
    const { app } = makeMagApp('admin');
    const r = await request(app).get('/v1/scenarios/library/coverage-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
