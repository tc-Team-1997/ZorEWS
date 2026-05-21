// T6 M16.22 — Scenario library shock-direction distribution tests.

import request from 'supertest';
import {
  ALL_SHOCK_DIRECTIONS,
  buildScenarioShockDirectionReport,
  directionForShock,
  isShockDirection,
} from '../src/scenario_shock_direction';
import {
  SCENARIO_PRESETS,
  listScenarioCategories,
  type ScenarioPreset,
} from '../src/scenario_library';
import { ALL_SHOCK_AXES } from '../src/scenario_shock_axis_histogram';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T16:00:00.000Z');
const H_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function buildPreset(over: Partial<ScenarioPreset>): ScenarioPreset {
  return {
    id: 'tst-1',
    name: 'Test preset',
    category: 'business',
    regulator: 'INTERNAL',
    severity: 'mild',
    description: '',
    source_doc: '',
    shocks: { gdp: 0, rate: 0, fx: 0 },
    ...over,
  } as ScenarioPreset;
}

describe('directionForShock', () => {
  test('classifies positive / negative / zero correctly', () => {
    expect(directionForShock(2)).toBe('positive');
    expect(directionForShock(0.001)).toBe('positive');
    expect(directionForShock(-1)).toBe('negative');
    expect(directionForShock(-0.001)).toBe('negative');
    expect(directionForShock(0)).toBe('zero');
  });
  test('non-finite defensively → zero', () => {
    expect(directionForShock(NaN)).toBe('zero');
    expect(directionForShock(Infinity)).toBe('zero');
    expect(directionForShock(-Infinity)).toBe('zero');
  });
});

describe('isShockDirection', () => {
  test('accepts the 3 valid values', () => {
    expect(isShockDirection('positive')).toBe(true);
    expect(isShockDirection('negative')).toBe(true);
    expect(isShockDirection('zero')).toBe(true);
  });
  test('rejects everything else', () => {
    expect(isShockDirection('pos')).toBe(false);
    expect(isShockDirection('POSITIVE')).toBe(false);
    expect(isShockDirection('')).toBe(false);
    expect(isShockDirection(null)).toBe(false);
    expect(isShockDirection(undefined)).toBe(false);
  });
  test('ALL_SHOCK_DIRECTIONS enumerates exactly the 3', () => {
    expect(ALL_SHOCK_DIRECTIONS).toEqual(['positive', 'negative', 'zero']);
  });
});

describe('buildScenarioShockDirectionReport (default catalog)', () => {
  const report = buildScenarioShockDirectionReport(NOW);

  test('envelope shape', () => {
    expect(report.generated_at).toBe(NOW.toISOString());
    expect(report.total_presets).toBe(SCENARIO_PRESETS.length);
    expect(report.rows).toHaveLength(ALL_SHOCK_AXES.length);
    expect(report.by_direction_totals.positive).toBeGreaterThanOrEqual(0);
    expect(report.by_direction_totals.negative).toBeGreaterThanOrEqual(0);
    expect(report.by_direction_totals.zero).toBeGreaterThanOrEqual(0);
  });

  test('rows in canonical ALL_SHOCK_AXES order', () => {
    expect(report.rows.map((r) => r.axis)).toEqual(['gdp', 'rate', 'fx']);
  });

  test('per-row total = positive + negative + zero = total_presets', () => {
    for (const row of report.rows) {
      expect(row.total).toBe(
        row.positive_count + row.negative_count + row.zero_count,
      );
      expect(row.total).toBe(report.total_presets);
    }
  });

  test('Σ by_direction_totals = 3 × total_presets (3 axes per preset)', () => {
    const sum =
      report.by_direction_totals.positive +
      report.by_direction_totals.negative +
      report.by_direction_totals.zero;
    expect(sum).toBe(3 * report.total_presets);
  });

  test('every by_category row has all 4 categories present', () => {
    const cats = listScenarioCategories();
    for (const row of report.rows) {
      for (const cat of cats) {
        expect(row.by_category[cat]).toBeDefined();
        expect(row.by_category[cat].positive).toBeGreaterThanOrEqual(0);
        expect(row.by_category[cat].negative).toBeGreaterThanOrEqual(0);
        expect(row.by_category[cat].zero).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('per-row Σ by_category direction totals match row totals', () => {
    for (const row of report.rows) {
      const sumPos = Object.values(row.by_category).reduce(
        (a, b) => a + b.positive,
        0,
      );
      const sumNeg = Object.values(row.by_category).reduce(
        (a, b) => a + b.negative,
        0,
      );
      const sumZero = Object.values(row.by_category).reduce(
        (a, b) => a + b.zero,
        0,
      );
      expect(sumPos).toBe(row.positive_count);
      expect(sumNeg).toBe(row.negative_count);
      expect(sumZero).toBe(row.zero_count);
    }
  });

  test('positive_examples + negative_examples capped at 3 + non-empty when count > 0', () => {
    for (const row of report.rows) {
      expect(row.positive_examples.length).toBeLessThanOrEqual(3);
      expect(row.negative_examples.length).toBeLessThanOrEqual(3);
      if (row.positive_count > 0) {
        expect(row.positive_examples.length).toBeGreaterThan(0);
        for (const ex of row.positive_examples) {
          expect(ex.raw).toBeGreaterThan(0);
        }
      }
      if (row.negative_count > 0) {
        expect(row.negative_examples.length).toBeGreaterThan(0);
        for (const ex of row.negative_examples) {
          expect(ex.raw).toBeLessThan(0);
        }
      }
    }
  });

  test('positive_examples sorted by raw desc + preset_id asc tie-break', () => {
    for (const row of report.rows) {
      const arr = row.positive_examples;
      for (let i = 1; i < arr.length; i += 1) {
        const prev = arr[i - 1];
        const cur = arr[i];
        expect(prev.raw).toBeGreaterThanOrEqual(cur.raw);
        if (prev.raw === cur.raw) {
          expect(prev.preset_id <= cur.preset_id).toBe(true);
        }
      }
    }
  });

  test('negative_examples sorted by raw asc (most-negative first)', () => {
    for (const row of report.rows) {
      const arr = row.negative_examples;
      for (let i = 1; i < arr.length; i += 1) {
        const prev = arr[i - 1];
        const cur = arr[i];
        expect(prev.raw).toBeLessThanOrEqual(cur.raw);
      }
    }
  });

  test('GDP row has at least one negative example (RBI Adverse / Pandemic / Stagflation)', () => {
    const gdpRow = report.rows.find((r) => r.axis === 'gdp')!;
    expect(gdpRow.negative_count).toBeGreaterThan(0);
  });

  test('rate row has at least one positive example (rate hike scenarios)', () => {
    const rateRow = report.rows.find((r) => r.axis === 'rate')!;
    expect(rateRow.positive_count).toBeGreaterThan(0);
  });

  test('most_positive / most_negative / most_neutral non-null for non-empty catalog', () => {
    expect(report.most_positive_axis).not.toBeNull();
    expect(report.most_negative_axis).not.toBeNull();
    expect(report.most_neutral_axis).not.toBeNull();
    expect(ALL_SHOCK_AXES).toContain(report.most_positive_axis as never);
  });
});

describe('buildScenarioShockDirectionReport (curated inputs)', () => {
  test('empty catalog → all zeros + null leaderboards', () => {
    const r = buildScenarioShockDirectionReport(NOW, []);
    expect(r.total_presets).toBe(0);
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) {
      expect(row.total).toBe(0);
      expect(row.positive_count).toBe(0);
      expect(row.negative_count).toBe(0);
      expect(row.zero_count).toBe(0);
      expect(row.positive_examples).toEqual([]);
      expect(row.negative_examples).toEqual([]);
    }
    expect(r.most_positive_axis).toBeNull();
    expect(r.most_negative_axis).toBeNull();
    expect(r.most_neutral_axis).toBeNull();
    expect(r.by_direction_totals).toEqual({ positive: 0, negative: 0, zero: 0 });
  });

  test('single all-zero preset → only zero buckets populated', () => {
    const r = buildScenarioShockDirectionReport(NOW, [
      buildPreset({ shocks: { gdp: 0, rate: 0, fx: 0 } }),
    ]);
    expect(r.total_presets).toBe(1);
    for (const row of r.rows) {
      expect(row.positive_count).toBe(0);
      expect(row.negative_count).toBe(0);
      expect(row.zero_count).toBe(1);
    }
    expect(r.by_direction_totals).toEqual({ positive: 0, negative: 0, zero: 3 });
    expect(r.most_neutral_axis).toBe('gdp'); // canonical tie-break: first axis wins at tied
  });

  test('positive-only preset on rate → rate row pos=1, others zero=1', () => {
    const r = buildScenarioShockDirectionReport(NOW, [
      buildPreset({ shocks: { gdp: 0, rate: 200, fx: 0 } }),
    ]);
    const rateRow = r.rows.find((row) => row.axis === 'rate')!;
    const gdpRow = r.rows.find((row) => row.axis === 'gdp')!;
    expect(rateRow.positive_count).toBe(1);
    expect(rateRow.positive_examples[0].raw).toBe(200);
    expect(gdpRow.zero_count).toBe(1);
    expect(r.most_positive_axis).toBe('rate');
  });

  test('multi-preset categorical breakdown', () => {
    const r = buildScenarioShockDirectionReport(NOW, [
      buildPreset({
        id: 'p1',
        category: 'regulatory',
        shocks: { gdp: -5, rate: 300, fx: 10 },
      }),
      buildPreset({
        id: 'p2',
        category: 'business',
        shocks: { gdp: 2, rate: -100, fx: 0 },
      }),
      buildPreset({
        id: 'p3',
        category: 'baseline',
        shocks: { gdp: 0, rate: 0, fx: 0 },
      }),
    ]);
    const gdpRow = r.rows.find((row) => row.axis === 'gdp')!;
    expect(gdpRow.positive_count).toBe(1); // p2
    expect(gdpRow.negative_count).toBe(1); // p1
    expect(gdpRow.zero_count).toBe(1); // p3
    expect(gdpRow.by_category.regulatory.negative).toBe(1);
    expect(gdpRow.by_category.business.positive).toBe(1);
    expect(gdpRow.by_category.baseline.zero).toBe(1);
  });

  test('canonical axis tie-break: gdp wins when all axes tied', () => {
    const r = buildScenarioShockDirectionReport(NOW, [
      buildPreset({ shocks: { gdp: 5, rate: 100, fx: 3 } }),
    ]);
    // Every axis has positive=1 → tie → gdp wins via canonical iteration.
    expect(r.most_positive_axis).toBe('gdp');
    expect(r.most_negative_axis).toBe('gdp'); // all tied at 0 → first wins
  });

  test('positive examples cap at 3 across many candidates', () => {
    const many: ScenarioPreset[] = [];
    for (let i = 1; i <= 7; i += 1) {
      many.push(
        buildPreset({
          id: `p${i}`,
          shocks: { gdp: i, rate: 0, fx: 0 },
        }),
      );
    }
    const r = buildScenarioShockDirectionReport(NOW, many);
    const gdpRow = r.rows.find((row) => row.axis === 'gdp')!;
    expect(gdpRow.positive_count).toBe(7);
    expect(gdpRow.positive_examples).toHaveLength(3);
    // Sorted desc — top 3 raws should be 7, 6, 5.
    expect(gdpRow.positive_examples.map((e) => e.raw)).toEqual([7, 6, 5]);
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

function makeRouteApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('GET /v1/scenarios/library/shock-directions', () => {
  test('analyst+ happy path returns envelope', async () => {
    const { app } = makeRouteApp('risk_analyst');
    const r = await request(app)
      .get('/v1/scenarios/library/shock-directions')
      .set(H_BIL);
    expect(r.status).toBe(200);
    expect(r.body.header?.status).toBe('SUCCESS');
    expect(r.body.body.total_presets).toBe(SCENARIO_PRESETS.length);
    expect(r.body.body.rows).toHaveLength(3);
    expect(['gdp', 'rate', 'fx']).toContain(r.body.body.most_positive_axis);
  });

  test('admin happy path', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app)
      .get('/v1/scenarios/library/shock-directions')
      .set(H_BIL);
    expect(r.status).toBe(200);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRouteApp('unknown_role');
    const r = await request(app)
      .get('/v1/scenarios/library/shock-directions')
      .set(H_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static across BIL ↔ BANK_DEMO', async () => {
    const { app } = makeRouteApp('admin');
    const r1 = await request(app)
      .get('/v1/scenarios/library/shock-directions')
      .set(H_BIL);
    const r2 = await request(app)
      .get('/v1/scenarios/library/shock-directions')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r1.body.body.total_presets).toBe(r2.body.body.total_presets);
    expect(r1.body.body.by_direction_totals).toEqual(
      r2.body.body.by_direction_totals,
    );
  });

  test('rows have axis + counts + examples', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app)
      .get('/v1/scenarios/library/shock-directions')
      .set(H_BIL);
    expect(r.status).toBe(200);
    for (const row of r.body.body.rows) {
      expect(['gdp', 'rate', 'fx']).toContain(row.axis);
      expect(typeof row.positive_count).toBe('number');
      expect(typeof row.negative_count).toBe('number');
      expect(typeof row.zero_count).toBe('number');
      expect(Array.isArray(row.positive_examples)).toBe(true);
      expect(Array.isArray(row.negative_examples)).toBe(true);
    }
  });
});
