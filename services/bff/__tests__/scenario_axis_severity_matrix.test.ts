// services/bff/__tests__/scenario_axis_severity_matrix.test.ts
//
// T6 M16.23 — Scenario shock-axis × severity cross-tab matrix.

import request from 'supertest';
import {
  buildScenarioAxisSeverityMatrix,
  ALL_SCENARIO_SEVERITIES,
} from '../src/scenario_axis_severity_matrix';
import { ALL_SHOCK_AXES } from '../src/scenario_shock_axis_histogram';
import {
  listScenarioPresets,
  type ScenarioPreset,
  type ScenarioSeverity,
  type ScenarioShocks,
} from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-28T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

let nextSeq = 1;
function preset(severity: ScenarioSeverity, shocks: ScenarioShocks): ScenarioPreset {
  return {
    id: `scn-${nextSeq++}`,
    name: 'Synthetic',
    description: 'test',
    category: 'business',
    regulator: 'INTERNAL',
    severity,
    shocks,
    source_doc: 'test',
  };
}

// ─── Pure resolver (synthetic injection) ─────────────────────────────────

describe('M16.23 — buildScenarioAxisSeverityMatrix (synthetic)', () => {
  test('ALL_SCENARIO_SEVERITIES canonical order', () => {
    expect(ALL_SCENARIO_SEVERITIES).toEqual(['mild', 'moderate', 'severe']);
  });

  test('empty input → 9 zero cells + null leaderboards', () => {
    const m = buildScenarioAxisSeverityMatrix(NOW, []);
    expect(m.total_presets).toBe(0);
    expect(m.total_axis_exercises).toBe(0);
    expect(m.total_axes).toBe(3);
    expect(m.total_severities).toBe(3);
    expect(m.rows.length).toBe(3);
    expect(m.columns.length).toBe(3);
    for (const row of m.rows) {
      expect(row.total).toBe(0);
      expect(row.distinct_severities).toBe(0);
      expect(row.severities_without).toEqual([...ALL_SCENARIO_SEVERITIES]);
    }
    for (const col of m.columns) {
      expect(col.total).toBe(0);
      expect(col.preset_count).toBe(0);
      expect(col.distinct_axes).toBe(0);
      expect(col.axes_without).toEqual([...ALL_SHOCK_AXES]);
    }
    expect(m.peak_cell).toBeNull();
    expect(m.most_exercised_axis).toBeNull();
    expect(m.severity_with_widest_axis_coverage).toBeNull();
    // every cell empty → 9 empty_cells
    expect(m.empty_cells.length).toBe(9);
  });

  test('rows in canonical ALL_SHOCK_AXES order, columns in canonical severity order', () => {
    const m = buildScenarioAxisSeverityMatrix(NOW, []);
    expect(m.rows.map((r) => r.axis)).toEqual([...ALL_SHOCK_AXES]);
    expect(m.columns.map((c) => c.severity)).toEqual([...ALL_SCENARIO_SEVERITIES]);
  });

  test('single multi-axis preset counts in multiple rows, one column', () => {
    // severe preset exercising gdp + fx (rate = 0)
    const m = buildScenarioAxisSeverityMatrix(NOW, [
      preset('severe', { gdp: -4, rate: 0, fx: 12 }),
    ]);
    expect(m.total_presets).toBe(1);
    // 2 axis-exercises (gdp + fx), rate is zero
    expect(m.total_axis_exercises).toBe(2);

    const gdpRow = m.rows.find((r) => r.axis === 'gdp')!;
    const fxRow = m.rows.find((r) => r.axis === 'fx')!;
    const rateRow = m.rows.find((r) => r.axis === 'rate')!;
    expect(gdpRow.by_severity.severe).toBe(1);
    expect(fxRow.by_severity.severe).toBe(1);
    expect(rateRow.total).toBe(0); // rate=0 → not exercised

    const severeCol = m.columns.find((c) => c.severity === 'severe')!;
    expect(severeCol.total).toBe(2); // 2 axis-exercises
    expect(severeCol.preset_count).toBe(1); // 1 distinct preset
    expect(severeCol.distinct_axes).toBe(2); // gdp + fx
    expect(severeCol.by_axis.rate).toBe(0);
  });

  test('all-zero baseline preset exercises no axis (contributes nothing)', () => {
    const m = buildScenarioAxisSeverityMatrix(NOW, [
      preset('mild', { gdp: 0, rate: 0, fx: 0 }),
    ]);
    expect(m.total_presets).toBe(1);
    expect(m.total_axis_exercises).toBe(0);
    const mildCol = m.columns.find((c) => c.severity === 'mild')!;
    expect(mildCol.preset_count).toBe(1); // counted as a preset at this tier
    expect(mildCol.total).toBe(0); // but exercises no axis
    expect(mildCol.distinct_axes).toBe(0);
  });

  test('Σ row totals = Σ col totals = total_axis_exercises partition invariant', () => {
    const presets = [
      preset('mild', { gdp: -1, rate: 0, fx: 0 }),
      preset('moderate', { gdp: -3, rate: 150, fx: 0 }),
      preset('severe', { gdp: -6, rate: 300, fx: 14 }),
    ];
    const m = buildScenarioAxisSeverityMatrix(NOW, presets);
    const rowSum = m.rows.reduce((a, r) => a + r.total, 0);
    const colSum = m.columns.reduce((a, c) => a + c.total, 0);
    expect(rowSum).toBe(m.total_axis_exercises);
    expect(colSum).toBe(m.total_axis_exercises);
    // gdp×3 + rate×2 + fx×1 = 6 axis-exercises
    expect(m.total_axis_exercises).toBe(6);
  });

  test('Σ row.by_severity = row.total + Σ col.by_axis = col.total', () => {
    const m = buildScenarioAxisSeverityMatrix(NOW, [
      preset('severe', { gdp: -4, rate: 300, fx: 12 }),
      preset('mild', { gdp: -1, rate: 0, fx: 0 }),
    ]);
    for (const row of m.rows) {
      const sum = ALL_SCENARIO_SEVERITIES.reduce((a, s) => a + row.by_severity[s], 0);
      expect(sum).toBe(row.total);
    }
    for (const col of m.columns) {
      const sum = ALL_SHOCK_AXES.reduce((a, ax) => a + col.by_axis[ax], 0);
      expect(sum).toBe(col.total);
    }
  });

  test('cell cross-check: row.by_severity[s] === col[s].by_axis[axis]', () => {
    const m = buildScenarioAxisSeverityMatrix(NOW, [
      preset('severe', { gdp: -4, rate: 300, fx: 0 }),
      preset('moderate', { gdp: -3, rate: 0, fx: 8 }),
    ]);
    for (const row of m.rows) {
      for (const s of ALL_SCENARIO_SEVERITIES) {
        const fromRow = row.by_severity[s];
        const col = m.columns.find((c) => c.severity === s)!;
        const fromCol = col.by_axis[row.axis];
        expect(fromRow).toBe(fromCol);
      }
    }
  });

  test('severities_without per row + axes_without per col canonical order', () => {
    // gdp exercised only at severe
    const m = buildScenarioAxisSeverityMatrix(NOW, [
      preset('severe', { gdp: -5, rate: 0, fx: 0 }),
    ]);
    const gdpRow = m.rows.find((r) => r.axis === 'gdp')!;
    expect(gdpRow.severities_without).toEqual(['mild', 'moderate']);
    const severeCol = m.columns.find((c) => c.severity === 'severe')!;
    // severe exercises only gdp → rate + fx absent
    expect(severeCol.axes_without).toEqual(['rate', 'fx']);
  });

  test('peak_cell = highest cell count', () => {
    const presets = [
      preset('severe', { gdp: -4, rate: 0, fx: 0 }),
      preset('severe', { gdp: -5, rate: 0, fx: 0 }),
      preset('severe', { gdp: -6, rate: 0, fx: 0 }),
      preset('mild', { gdp: 0, rate: 50, fx: 0 }),
    ];
    const m = buildScenarioAxisSeverityMatrix(NOW, presets);
    expect(m.peak_cell).toEqual({ axis: 'gdp', severity: 'severe', count: 3 });
  });

  test('peak_cell canonical iteration tie-break (axes × severities)', () => {
    // gdp@mild and rate@severe both 1 → gdp iterates first → wins
    const m = buildScenarioAxisSeverityMatrix(NOW, [
      preset('mild', { gdp: -1, rate: 0, fx: 0 }),
      preset('severe', { gdp: 0, rate: 300, fx: 0 }),
    ]);
    expect(m.peak_cell?.axis).toBe('gdp');
    expect(m.peak_cell?.severity).toBe('mild');
  });

  test('peak_cell null on empty', () => {
    expect(buildScenarioAxisSeverityMatrix(NOW, []).peak_cell).toBeNull();
    // also null when only the all-zero baseline (no axis exercised)
    expect(
      buildScenarioAxisSeverityMatrix(NOW, [preset('mild', { gdp: 0, rate: 0, fx: 0 })])
        .peak_cell,
    ).toBeNull();
  });

  test('most_exercised_axis = highest row total', () => {
    // gdp in 3 presets, rate in 1, fx in 0
    const presets = [
      preset('mild', { gdp: -1, rate: 0, fx: 0 }),
      preset('moderate', { gdp: -3, rate: 150, fx: 0 }),
      preset('severe', { gdp: -6, rate: 0, fx: 0 }),
    ];
    const m = buildScenarioAxisSeverityMatrix(NOW, presets);
    expect(m.most_exercised_axis).toBe('gdp');
  });

  test('most_exercised_axis canonical tie-break', () => {
    // gdp and rate both exercised once → gdp wins (canonical first)
    const m = buildScenarioAxisSeverityMatrix(NOW, [
      preset('mild', { gdp: -1, rate: 50, fx: 0 }),
    ]);
    expect(m.most_exercised_axis).toBe('gdp');
  });

  test('most_exercised_axis null on empty / baseline-only', () => {
    expect(buildScenarioAxisSeverityMatrix(NOW, []).most_exercised_axis).toBeNull();
    expect(
      buildScenarioAxisSeverityMatrix(NOW, [preset('mild', { gdp: 0, rate: 0, fx: 0 })])
        .most_exercised_axis,
    ).toBeNull();
  });

  test('severity_with_widest_axis_coverage = most distinct axes', () => {
    // severe exercises 3 axes; mild exercises 1
    const presets = [
      preset('severe', { gdp: -4, rate: 300, fx: 12 }),
      preset('mild', { gdp: -1, rate: 0, fx: 0 }),
    ];
    const m = buildScenarioAxisSeverityMatrix(NOW, presets);
    expect(m.severity_with_widest_axis_coverage).toBe('severe');
  });

  test('severity_with_widest_axis_coverage canonical tie-break', () => {
    // mild and moderate each exercise 1 axis (gdp) → mild wins (canonical first)
    const m = buildScenarioAxisSeverityMatrix(NOW, [
      preset('mild', { gdp: -1, rate: 0, fx: 0 }),
      preset('moderate', { gdp: -3, rate: 0, fx: 0 }),
    ]);
    expect(m.severity_with_widest_axis_coverage).toBe('mild');
  });

  test('severity_with_widest_axis_coverage null on empty / baseline-only', () => {
    expect(
      buildScenarioAxisSeverityMatrix(NOW, []).severity_with_widest_axis_coverage,
    ).toBeNull();
    expect(
      buildScenarioAxisSeverityMatrix(NOW, [preset('mild', { gdp: 0, rate: 0, fx: 0 })])
        .severity_with_widest_axis_coverage,
    ).toBeNull();
  });

  test('empty_cells in canonical axis × severity row-major order', () => {
    // gdp@severe only → 8 empty cells, gdp's mild+moderate first
    const m = buildScenarioAxisSeverityMatrix(NOW, [
      preset('severe', { gdp: -5, rate: 0, fx: 0 }),
    ]);
    expect(m.empty_cells.length).toBe(8);
    expect(m.empty_cells[0]).toEqual({ axis: 'gdp', severity: 'mild' });
    expect(m.empty_cells[1]).toEqual({ axis: 'gdp', severity: 'moderate' });
    expect(m.empty_cells[2]).toEqual({ axis: 'rate', severity: 'mild' });
  });

  test('out-of-enum severity skipped', () => {
    const m = buildScenarioAxisSeverityMatrix(NOW, [
      preset('apocalyptic' as never, { gdp: -9, rate: 0, fx: 0 }),
      preset('severe', { gdp: -4, rate: 0, fx: 0 }),
    ]);
    // only the valid severe preset counts
    expect(m.total_axis_exercises).toBe(1);
    expect(m.columns.find((c) => c.severity === 'severe')!.preset_count).toBe(1);
  });

  test('generated_at echo', () => {
    expect(buildScenarioAxisSeverityMatrix(NOW, []).generated_at).toBe(NOW.toISOString());
  });
});

// ─── Real-library invariants (platform-static) ──────────────────────────

describe('M16.23 — real library invariants', () => {
  test('total_presets matches listScenarioPresets length', () => {
    const m = buildScenarioAxisSeverityMatrix(NOW);
    expect(m.total_presets).toBe(listScenarioPresets().length);
  });

  test('Σ col.preset_count = total_presets (every preset in exactly one severity column)', () => {
    const m = buildScenarioAxisSeverityMatrix(NOW);
    const sum = m.columns.reduce((a, c) => a + c.preset_count, 0);
    expect(sum).toBe(m.total_presets);
  });

  test('partition: Σ rows = Σ cols = total_axis_exercises (real library)', () => {
    const m = buildScenarioAxisSeverityMatrix(NOW);
    const rowSum = m.rows.reduce((a, r) => a + r.total, 0);
    const colSum = m.columns.reduce((a, c) => a + c.total, 0);
    expect(rowSum).toBe(m.total_axis_exercises);
    expect(colSum).toBe(m.total_axis_exercises);
  });

  test('library exercises at least one axis (peak_cell non-null)', () => {
    const m = buildScenarioAxisSeverityMatrix(NOW);
    expect(m.peak_cell).not.toBeNull();
    expect(m.most_exercised_axis).not.toBeNull();
  });
});

// ─── Route ──────────────────────────────────────────────────────────────

describe('M16.23 — GET /v1/scenarios/library/axis-severity-matrix', () => {
  test('analyst+ → 200 with platform-static matrix', async () => {
    const { app } = makeTestApp('risk_analyst');
    const r = await request(app).get('/v1/scenarios/library/axis-severity-matrix').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_axes).toBe(3);
    expect(r.body.body.total_severities).toBe(3);
    expect(r.body.body.rows.length).toBe(3);
    expect(r.body.body.columns.length).toBe(3);
  });

  test('admin → 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app).get('/v1/scenarios/library/axis-severity-matrix').set(TH);
    expect(r.status).toBe(200);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTestApp('nobody');
    const r = await request(app).get('/v1/scenarios/library/axis-severity-matrix').set(TH);
    expect(r.status).toBe(403);
  });

  test('platform-static (same response across tenants)', async () => {
    const { app } = makeTestApp('admin');
    const bil = await request(app)
      .get('/v1/scenarios/library/axis-severity-matrix')
      .set(TH);
    const bank = await request(app)
      .get('/v1/scenarios/library/axis-severity-matrix')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(bil.body.body.total_axis_exercises).toBe(bank.body.body.total_axis_exercises);
    expect(bil.body.body.most_exercised_axis).toBe(bank.body.body.most_exercised_axis);
  });

  test('M16.22 /shock-directions sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app).get('/v1/scenarios/library/shock-directions').set(TH);
    expect(r.status).toBe(200);
  });

  test('M16.21 /regulator-severity-matrix sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/scenarios/library/regulator-severity-matrix')
      .set(TH);
    expect(r.status).toBe(200);
  });
});
