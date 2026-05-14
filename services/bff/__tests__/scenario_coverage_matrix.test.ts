// services/bff/__tests__/scenario_coverage_matrix.test.ts
//
// T6 M16.17 — Scenario library category × regulator coverage matrix.

import request from 'supertest';
import { buildScenarioCoverageMatrix } from '../src/scenario_coverage_matrix';
import { SCENARIO_PRESETS } from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── buildScenarioCoverageMatrix — pure ──────────────────────────────

describe('M16.17 — buildScenarioCoverageMatrix', () => {
  test('total_presets matches the library size', () => {
    const m = buildScenarioCoverageMatrix();
    expect(m.total_presets).toBe(SCENARIO_PRESETS.length);
  });

  test('always 12 cells (4 categories × 3 regulators)', () => {
    const m = buildScenarioCoverageMatrix();
    expect(m.cells).toHaveLength(12);
  });

  test('cells ordered category major then regulator minor', () => {
    const m = buildScenarioCoverageMatrix();
    const expectedOrder = [
      'baseline.RBI', 'baseline.IRDAI', 'baseline.INTERNAL',
      'business.RBI', 'business.IRDAI', 'business.INTERNAL',
      'regulatory.RBI', 'regulatory.IRDAI', 'regulatory.INTERNAL',
      'black_swan.RBI', 'black_swan.IRDAI', 'black_swan.INTERNAL',
    ];
    expect(m.cells.map((c) => `${c.category}.${c.regulator}`)).toEqual(expectedOrder);
  });

  test('cell counts sum to total_presets', () => {
    const m = buildScenarioCoverageMatrix();
    const sum = m.cells.reduce((acc, c) => acc + c.count, 0);
    expect(sum).toBe(SCENARIO_PRESETS.length);
  });

  test('every cell.preset_ids ⊂ library and sorted asc', () => {
    const m = buildScenarioCoverageMatrix();
    const knownIds = new Set(SCENARIO_PRESETS.map((p) => p.id));
    for (const c of m.cells) {
      expect(c.preset_ids.length).toBe(c.count);
      // sorted
      const sorted = [...c.preset_ids].sort();
      expect(c.preset_ids).toEqual(sorted);
      for (const id of c.preset_ids) {
        expect(knownIds.has(id)).toBe(true);
      }
    }
  });

  test('every preset appears in exactly one cell', () => {
    const m = buildScenarioCoverageMatrix();
    const allIds: string[] = [];
    for (const c of m.cells) allIds.push(...c.preset_ids);
    expect(allIds.sort()).toEqual([...SCENARIO_PRESETS.map((p) => p.id)].sort());
  });

  test('by_category counts agree with cells', () => {
    const m = buildScenarioCoverageMatrix();
    for (const category of Object.keys(m.by_category) as Array<keyof typeof m.by_category>) {
      const sumFromCells = m.cells
        .filter((c) => c.category === category)
        .reduce((acc, c) => acc + c.count, 0);
      expect(m.by_category[category]).toBe(sumFromCells);
    }
  });

  test('by_regulator counts agree with cells', () => {
    const m = buildScenarioCoverageMatrix();
    for (const regulator of Object.keys(m.by_regulator) as Array<keyof typeof m.by_regulator>) {
      const sumFromCells = m.cells
        .filter((c) => c.regulator === regulator)
        .reduce((acc, c) => acc + c.count, 0);
      expect(m.by_regulator[regulator]).toBe(sumFromCells);
    }
  });

  test('expected_min is non-negative on every cell', () => {
    const m = buildScenarioCoverageMatrix();
    for (const c of m.cells) {
      expect(c.expected_min).toBeGreaterThanOrEqual(0);
    }
  });

  test('is_gap flag is true iff count < expected_min', () => {
    const m = buildScenarioCoverageMatrix();
    for (const c of m.cells) {
      const computed = c.expected_min > 0 && c.count < c.expected_min;
      expect(c.is_gap).toBe(computed);
    }
  });

  test('gaps only contain is_gap=true cells', () => {
    const m = buildScenarioCoverageMatrix();
    for (const g of m.gaps) {
      const matched = m.cells.find((c) => c.category === g.category && c.regulator === g.regulator);
      expect(matched).toBeDefined();
      expect(matched!.is_gap).toBe(true);
      expect(g.shortfall).toBe(matched!.expected_min - matched!.count);
    }
  });

  test('gaps sorted by shortfall desc then category asc then regulator asc', () => {
    const m = buildScenarioCoverageMatrix();
    for (let i = 1; i < m.gaps.length; i++) {
      const prev = m.gaps[i - 1]!;
      const curr = m.gaps[i]!;
      if (prev.shortfall !== curr.shortfall) {
        expect(prev.shortfall).toBeGreaterThan(curr.shortfall);
      } else if (prev.category !== curr.category) {
        expect(prev.category.localeCompare(curr.category)).toBeLessThan(0);
      } else {
        expect(prev.regulator.localeCompare(curr.regulator)).toBeLessThan(0);
      }
    }
  });

  test('most_populated_cell is the cell with the highest count', () => {
    const m = buildScenarioCoverageMatrix();
    if (m.most_populated_cell) {
      const max = Math.max(...m.cells.map((c) => c.count));
      expect(m.most_populated_cell.count).toBe(max);
      const matched = m.cells.find(
        (c) =>
          c.category === m.most_populated_cell!.category
          && c.regulator === m.most_populated_cell!.regulator,
      );
      expect(matched).toBeDefined();
      expect(matched!.count).toBe(max);
    }
  });

  test('the 10-preset library is not empty → most_populated_cell is non-null', () => {
    const m = buildScenarioCoverageMatrix();
    expect(m.most_populated_cell).not.toBeNull();
  });
});

// ─── GET /v1/scenarios/library/coverage-matrix ───────────────────────

function makeMatrixApp(role = 'risk_analyst') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M16.17 — GET /v1/scenarios/library/coverage-matrix', () => {
  test('analyst+ → 200 with full matrix', async () => {
    const { app } = makeMatrixApp('risk_analyst');
    const r = await request(app).get('/v1/scenarios/library/coverage-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_presets).toBe(SCENARIO_PRESETS.length);
    expect(r.body.body.cells).toHaveLength(12);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeMatrixApp('case_owner');
    const r = await request(app).get('/v1/scenarios/library/coverage-matrix').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL and BANK_DEMO see the same matrix', async () => {
    const { app } = makeMatrixApp('admin');
    const bil = await request(app).get('/v1/scenarios/library/coverage-matrix').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/scenarios/library/coverage-matrix')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });

  test('M16.1 /v1/scenarios/library still works (additive route)', async () => {
    const { app } = makeMatrixApp('admin');
    const r = await request(app).get('/v1/scenarios/library').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M16.16 /v1/scenarios/library/narratives still works (sibling route)', async () => {
    const { app } = makeMatrixApp('admin');
    const r = await request(app).get('/v1/scenarios/library/narratives').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
