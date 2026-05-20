// services/bff/__tests__/scenario_regulator_severity_matrix.test.ts
//
// T6 M16.21 — Scenario library regulator × severity cross-tab matrix.

import request from 'supertest';
import { buildScenarioRegulatorSeverityMatrix } from '../src/scenario_regulator_severity_matrix';
import { listScenarioPresets } from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeAppFor(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Pure resolver shape ──────────────────────────────────────────────

describe('buildScenarioRegulatorSeverityMatrix pure', () => {
  test('envelope shape — 3 rows × 3 cols × 9 cells max', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(r.total_regulators).toBe(3);
    expect(r.total_severities).toBe(3);
    expect(r.rows).toHaveLength(3);
    expect(r.columns).toHaveLength(3);
  });

  test('rows in canonical regulator order', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    expect(r.rows.map((row) => row.regulator)).toEqual([
      'RBI',
      'IRDAI',
      'INTERNAL',
    ]);
  });

  test('columns in canonical severity order', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    expect(r.columns.map((c) => c.severity)).toEqual([
      'mild',
      'moderate',
      'severe',
    ]);
  });

  test('total_presets matches library size', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    expect(r.total_presets).toBe(listScenarioPresets().length);
  });

  test('Σ rows.total = total_presets partition', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    const sum = r.rows.reduce((acc, row) => acc + row.total, 0);
    expect(sum).toBe(r.total_presets);
  });

  test('Σ columns.total = total_presets partition', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    const sum = r.columns.reduce((acc, col) => acc + col.total, 0);
    expect(sum).toBe(r.total_presets);
  });

  test('every by_severity carries 3 keys per row', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    for (const row of r.rows) {
      expect(Object.keys(row.by_severity).sort()).toEqual([
        'mild',
        'moderate',
        'severe',
      ]);
    }
  });

  test('every by_regulator carries 3 keys per col', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    for (const col of r.columns) {
      expect(Object.keys(col.by_regulator).sort()).toEqual([
        'INTERNAL',
        'IRDAI',
        'RBI',
      ]);
    }
  });

  test('Σ row.by_severity per row = row.total partition', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    for (const row of r.rows) {
      const sum =
        row.by_severity.mild + row.by_severity.moderate + row.by_severity.severe;
      expect(sum).toBe(row.total);
    }
  });

  test('Σ col.by_regulator per col = col.total partition', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    for (const col of r.columns) {
      const sum =
        col.by_regulator.RBI +
        col.by_regulator.IRDAI +
        col.by_regulator.INTERNAL;
      expect(sum).toBe(col.total);
    }
  });

  test('cell cross-check invariant: row.by_severity[s] === col.by_regulator[r]', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    for (const row of r.rows) {
      for (const col of r.columns) {
        expect(row.by_severity[col.severity]).toBe(
          col.by_regulator[row.regulator],
        );
      }
    }
  });

  test('preset_ids per row/col sorted asc', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    for (const row of r.rows) {
      expect(row.preset_ids).toEqual([...row.preset_ids].sort());
    }
    for (const col of r.columns) {
      expect(col.preset_ids).toEqual([...col.preset_ids].sort());
    }
  });

  test('Σ preset_ids per row = row.total', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    for (const row of r.rows) {
      expect(row.preset_ids).toHaveLength(row.total);
    }
  });

  test('severities_without canonical order + zero invariant', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    for (const row of r.rows) {
      for (const s of row.severities_without) {
        expect(row.by_severity[s]).toBe(0);
      }
      const canonicalSorted = [...row.severities_without].sort((a, b) => {
        const order = ['mild', 'moderate', 'severe'];
        return order.indexOf(a) - order.indexOf(b);
      });
      expect(row.severities_without).toEqual(canonicalSorted);
    }
  });

  test('regulators_without canonical order + zero invariant', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    for (const col of r.columns) {
      for (const reg of col.regulators_without) {
        expect(col.by_regulator[reg]).toBe(0);
      }
      const canonicalSorted = [...col.regulators_without].sort((a, b) => {
        const order = ['RBI', 'IRDAI', 'INTERNAL'];
        return order.indexOf(a) - order.indexOf(b);
      });
      expect(col.regulators_without).toEqual(canonicalSorted);
    }
  });

  test('peak_cell — matches highest count across all cells; non-null for non-empty library', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    expect(r.peak_cell).not.toBeNull();
    // Verify no cell strictly higher.
    for (const row of r.rows) {
      for (const col of r.columns) {
        expect(row.by_severity[col.severity]).toBeLessThanOrEqual(r.peak_cell!.count);
      }
    }
    // peak_cell preset_ids are sorted + length matches cell count
    expect(r.peak_cell!.preset_ids).toEqual([...r.peak_cell!.preset_ids].sort());
    expect(r.peak_cell!.preset_ids).toHaveLength(r.peak_cell!.count);
  });

  test('peak_cell canonical iteration tie-break: earlier (regulator × severity) wins at tied', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    // Find all cells with peak_cell.count
    const tied: Array<{ regulator: string; severity: string }> = [];
    for (const row of r.rows) {
      for (const col of r.columns) {
        if (row.by_severity[col.severity] === r.peak_cell!.count) {
          tied.push({ regulator: row.regulator, severity: col.severity });
        }
      }
    }
    // peak_cell should be the FIRST tied cell in canonical iteration order.
    const regOrder = ['RBI', 'IRDAI', 'INTERNAL'];
    const sevOrder = ['mild', 'moderate', 'severe'];
    tied.sort((a, b) => {
      const dr = regOrder.indexOf(a.regulator) - regOrder.indexOf(b.regulator);
      if (dr !== 0) return dr;
      return sevOrder.indexOf(a.severity) - sevOrder.indexOf(b.severity);
    });
    expect(r.peak_cell!.regulator).toBe(tied[0].regulator);
    expect(r.peak_cell!.severity).toBe(tied[0].severity);
  });

  test('empty_cells canonical row-major order strictly enforced', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    const regOrder = ['RBI', 'IRDAI', 'INTERNAL'];
    const sevOrder = ['mild', 'moderate', 'severe'];
    const indices = r.empty_cells.map(
      (c) => regOrder.indexOf(c.regulator) * 3 + sevOrder.indexOf(c.severity),
    );
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  test('empty_cells matches manual zero-count scan', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    const manual: Array<{ regulator: string; severity: string }> = [];
    for (const row of r.rows) {
      for (const col of r.columns) {
        if (row.by_severity[col.severity] === 0) {
          manual.push({ regulator: row.regulator, severity: col.severity });
        }
      }
    }
    expect(r.empty_cells.length).toBe(manual.length);
  });

  test('empty + non_empty cells = 9 (total cells)', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    let nonEmpty = 0;
    for (const row of r.rows) {
      for (const col of r.columns) {
        if (row.by_severity[col.severity] > 0) nonEmpty++;
      }
    }
    expect(r.empty_cells.length + nonEmpty).toBe(9);
  });

  test('most_severe_regulator — highest severe-bucket count + canonical tie-break', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    const severeCol = r.columns.find((c) => c.severity === 'severe')!;
    if (severeCol.total === 0) {
      expect(r.most_severe_regulator).toBeNull();
    } else {
      expect(r.most_severe_regulator).not.toBeNull();
      const severeRow = r.rows.find(
        (row) => row.regulator === r.most_severe_regulator,
      )!;
      // No other row has strictly higher severe count.
      for (const row of r.rows) {
        expect(row.by_severity.severe).toBeLessThanOrEqual(
          severeRow.by_severity.severe,
        );
      }
    }
  });

  test('most_diverse_regulator — most distinct non-zero by_severity entries', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    if (r.total_presets === 0) {
      expect(r.most_diverse_regulator).toBeNull();
    } else {
      expect(r.most_diverse_regulator).not.toBeNull();
      const diverseRow = r.rows.find(
        (row) => row.regulator === r.most_diverse_regulator,
      )!;
      const sevOrder = ['mild', 'moderate', 'severe'] as const;
      const diverseSpan = sevOrder.filter(
        (s) => diverseRow.by_severity[s] > 0,
      ).length;
      // No other row has strictly higher span.
      for (const row of r.rows) {
        const span = sevOrder.filter((s) => row.by_severity[s] > 0).length;
        expect(span).toBeLessThanOrEqual(diverseSpan);
      }
    }
  });

  test('most_universal_severity — most distinct non-zero by_regulator entries', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    if (r.total_presets === 0) {
      expect(r.most_universal_severity).toBeNull();
    } else {
      expect(r.most_universal_severity).not.toBeNull();
      const universalCol = r.columns.find(
        (c) => c.severity === r.most_universal_severity,
      )!;
      const regOrder = ['RBI', 'IRDAI', 'INTERNAL'] as const;
      const universalSpan = regOrder.filter(
        (reg) => universalCol.by_regulator[reg] > 0,
      ).length;
      // No other col strictly higher.
      for (const col of r.columns) {
        const span = regOrder.filter((reg) => col.by_regulator[reg] > 0).length;
        expect(span).toBeLessThanOrEqual(universalSpan);
      }
    }
  });

  test('library cross-check: total_presets matches listScenarioPresets()', () => {
    const r = buildScenarioRegulatorSeverityMatrix(NOW);
    expect(r.total_presets).toBe(listScenarioPresets().length);
  });

  test('platform-static — different now yields same matrix data', () => {
    const r1 = buildScenarioRegulatorSeverityMatrix(NOW);
    const r2 = buildScenarioRegulatorSeverityMatrix(
      new Date('2027-01-01T00:00:00.000Z'),
    );
    expect(r2.total_presets).toBe(r1.total_presets);
    expect(r2.peak_cell?.count).toBe(r1.peak_cell?.count);
    expect(r2.empty_cells.length).toBe(r1.empty_cells.length);
    expect(r2.most_severe_regulator).toBe(r1.most_severe_regulator);
    expect(r2.most_diverse_regulator).toBe(r1.most_diverse_regulator);
    expect(r2.most_universal_severity).toBe(r1.most_universal_severity);
  });
});

// ─── Route ────────────────────────────────────────────────────────────

describe('GET /v1/scenarios/library/regulator-severity-matrix route', () => {
  test('analyst+ → 200 with envelope shape', async () => {
    const { app } = makeAppFor('risk_analyst');
    const r = await request(app)
      .get('/v1/scenarios/library/regulator-severity-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_presets).toBeGreaterThan(0);
    expect(r.body.body.rows).toHaveLength(3);
    expect(r.body.body.columns).toHaveLength(3);
  });

  test('admin → 200', async () => {
    const { app } = makeAppFor('admin');
    const r = await request(app)
      .get('/v1/scenarios/library/regulator-severity-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.peak_cell).not.toBeNull();
  });

  test('unknown role → 403', async () => {
    const { app } = makeAppFor('unknown_role');
    const r = await request(app)
      .get('/v1/scenarios/library/regulator-severity-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static across BIL ↔ BANK_DEMO same response', async () => {
    const { app } = makeAppFor('admin');
    const rBil = await request(app)
      .get('/v1/scenarios/library/regulator-severity-matrix')
      .set(TH_BIL);
    const rBank = await request(app)
      .get('/v1/scenarios/library/regulator-severity-matrix')
      .set(TH_BANK);
    expect(rBil.status).toBe(200);
    expect(rBank.status).toBe(200);
    expect(rBank.body.body.total_presets).toBe(rBil.body.body.total_presets);
    expect(rBank.body.body.peak_cell?.regulator).toBe(
      rBil.body.body.peak_cell?.regulator,
    );
  });

  test('M16.17 sibling regression: GET /v1/scenarios/library/coverage-matrix still 200', async () => {
    const { app } = makeAppFor('admin');
    const r = await request(app)
      .get('/v1/scenarios/library/coverage-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M16.1 sibling regression: GET /v1/scenarios/library still 200', async () => {
    const { app } = makeAppFor('admin');
    const r = await request(app)
      .get('/v1/scenarios/library')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('literal /regulator-severity-matrix not captured by /:preset_id wildcard', async () => {
    const { app } = makeAppFor('admin');
    const r = await request(app)
      .get('/v1/scenarios/library/regulator-severity-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.rows).toHaveLength(3);
  });
});
