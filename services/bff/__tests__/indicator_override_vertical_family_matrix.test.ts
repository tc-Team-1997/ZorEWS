// T6 M4.17 — Indicator threshold override vertical × family cross-tab.

import request from 'supertest';
import { buildIndicatorOverrideVerticalFamilyMatrix } from '../src/indicator_override_vertical_family_matrix';
import {
  InMemoryThresholdOverrideStore,
  type IndicatorThreshold,
  type ThresholdOverrideStore,
} from '../src/indicator_thresholds';
import { ALL_INDICATOR_VERTICALS } from '../src/indicator_catalog_stats';
import { ALL_INDICATOR_FAMILIES } from '../src/scoring_preset_family_matrix';
import type { ScoringVertical } from '../src/bil_scoring_v2';
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
  thresholdOverrideStore?: ThresholdOverrideStore,
) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    thresholdOverrideStore,
  });
}

function makeOverride(
  indicator_id: string,
  vertical: ScoringVertical = 'banking',
): IndicatorThreshold {
  return {
    indicator_id,
    vertical,
    name: indicator_id,
    yellow_at: 0.3,
    orange_at: 0.55,
    red_at: 0.8,
  };
}

describe('M4.17 — buildIndicatorOverrideVerticalFamilyMatrix', () => {
  test('empty input → 18 empty cells + null leaderboards', () => {
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.total_overrides).toBe(0);
    expect(m.total_verticals).toBe(2);
    expect(m.total_families).toBe(9);
    expect(m.rows.length).toBe(2);
    expect(m.columns.length).toBe(9);
    expect(m.peak_cell).toBeNull();
    expect(m.most_overridden_family).toBeNull();
    expect(m.most_active_vertical).toBeNull();
    expect(m.empty_cells.length).toBe(18);
    expect(m.unknown_families).toEqual([]);
  });

  test('rows in canonical vertical order', () => {
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', [], NOW);
    expect(m.rows.map((r) => r.vertical)).toEqual([...ALL_INDICATOR_VERTICALS]);
  });

  test('columns in canonical family order', () => {
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', [], NOW);
    expect(m.columns.map((c) => c.family)).toEqual([...ALL_INDICATOR_FAMILIES]);
  });

  test('single override lands in correct cell', () => {
    const m = buildIndicatorOverrideVerticalFamilyMatrix(
      'BIL',
      [makeOverride('FIN-001', 'banking')],
      NOW,
    );
    expect(m.total_overrides).toBe(1);
    const bankingRow = m.rows.find((r) => r.vertical === 'banking')!;
    expect(bankingRow.total_overrides).toBe(1);
    expect(bankingRow.by_family.FIN).toBe(1);
    expect(bankingRow.indicator_ids).toEqual(['FIN-001']);
    expect(bankingRow.distinct_families).toBe(1);
    const finCol = m.columns.find((c) => c.family === 'FIN')!;
    expect(finCol.total_overrides).toBe(1);
    expect(finCol.by_vertical.banking).toBe(1);
    expect(finCol.distinct_verticals).toBe(1);
  });

  test('every by_family key present per row', () => {
    const m = buildIndicatorOverrideVerticalFamilyMatrix(
      'BIL',
      [makeOverride('FIN-001', 'banking')],
      NOW,
    );
    for (const row of m.rows) {
      for (const f of ALL_INDICATOR_FAMILIES) {
        expect(row.by_family[f]).toBeGreaterThanOrEqual(0);
      }
      expect(Object.keys(row.by_family).length).toBe(9);
    }
  });

  test('every by_vertical key present per column', () => {
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', [], NOW);
    for (const col of m.columns) {
      for (const v of ALL_INDICATOR_VERTICALS) {
        expect(col.by_vertical[v]).toBeGreaterThanOrEqual(0);
      }
      expect(Object.keys(col.by_vertical).length).toBe(2);
    }
  });

  test('Σ row.by_family = row.total_overrides partition', () => {
    const overrides = [
      makeOverride('FIN-001', 'banking'),
      makeOverride('FIN-002', 'banking'),
      makeOverride('BEH-001', 'banking'),
    ];
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', overrides, NOW);
    for (const row of m.rows) {
      const sum = ALL_INDICATOR_FAMILIES.reduce(
        (a, f) => a + row.by_family[f],
        0,
      );
      expect(sum).toBe(row.total_overrides);
    }
  });

  test('Σ col.by_vertical = col.total_overrides partition', () => {
    const overrides = [
      makeOverride('FIN-001', 'banking'),
      makeOverride('POL-001', 'insurance'),
    ];
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', overrides, NOW);
    for (const col of m.columns) {
      const sum = ALL_INDICATOR_VERTICALS.reduce(
        (a, v) => a + col.by_vertical[v],
        0,
      );
      expect(sum).toBe(col.total_overrides);
    }
  });

  test('grand-total Σ rows = Σ cols = total_overrides', () => {
    const overrides = [
      makeOverride('FIN-001', 'banking'),
      makeOverride('BEH-001', 'banking'),
      makeOverride('POL-001', 'insurance'),
    ];
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', overrides, NOW);
    const rowSum = m.rows.reduce((a, r) => a + r.total_overrides, 0);
    const colSum = m.columns.reduce((a, c) => a + c.total_overrides, 0);
    expect(rowSum).toBe(m.total_overrides);
    expect(colSum).toBe(m.total_overrides);
    expect(rowSum).toBe(3);
  });

  test('cell cross-check row.by_family[X] === col[X].by_vertical[v]', () => {
    const overrides = [
      makeOverride('FIN-001', 'banking'),
      makeOverride('FIN-002', 'banking'),
      makeOverride('POL-001', 'insurance'),
    ];
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', overrides, NOW);
    for (const row of m.rows) {
      for (const f of ALL_INDICATOR_FAMILIES) {
        const fromRow = row.by_family[f];
        const col = m.columns.find((c) => c.family === f)!;
        const fromCol = col.by_vertical[row.vertical];
        expect(fromRow).toBe(fromCol);
      }
    }
  });

  test('indicator_ids per row + col sorted asc', () => {
    const overrides = [
      makeOverride('FIN-002', 'banking'),
      makeOverride('FIN-001', 'banking'),
      makeOverride('BEH-001', 'banking'),
    ];
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', overrides, NOW);
    const bankingRow = m.rows.find((r) => r.vertical === 'banking')!;
    expect(bankingRow.indicator_ids).toEqual(['BEH-001', 'FIN-001', 'FIN-002']);
    const finCol = m.columns.find((c) => c.family === 'FIN')!;
    expect(finCol.indicator_ids).toEqual(['FIN-001', 'FIN-002']);
  });

  test('families_without per row canonical order', () => {
    const m = buildIndicatorOverrideVerticalFamilyMatrix(
      'BIL',
      [makeOverride('FIN-001', 'banking')],
      NOW,
    );
    const bankingRow = m.rows.find((r) => r.vertical === 'banking')!;
    expect(bankingRow.families_without.length).toBe(8);
    expect(bankingRow.families_without).toEqual(
      ALL_INDICATOR_FAMILIES.filter((f) => f !== 'FIN'),
    );
  });

  test('verticals_without per col canonical order', () => {
    const m = buildIndicatorOverrideVerticalFamilyMatrix(
      'BIL',
      [makeOverride('FIN-001', 'banking')],
      NOW,
    );
    const finCol = m.columns.find((c) => c.family === 'FIN')!;
    expect(finCol.verticals_without).toEqual(['insurance']);
  });

  test('peak_cell formula', () => {
    const overrides = [
      makeOverride('FIN-001', 'banking'),
      makeOverride('FIN-002', 'banking'),
      makeOverride('FIN-003', 'banking'),
      makeOverride('POL-001', 'insurance'),
    ];
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', overrides, NOW);
    expect(m.peak_cell).toEqual({
      vertical: 'banking',
      family: 'FIN',
      count: 3,
    });
  });

  test('peak_cell canonical iteration tie-break', () => {
    const overrides = [
      // banking/BEH and insurance/POL both at 1
      makeOverride('BEH-001', 'banking'),
      makeOverride('POL-001', 'insurance'),
    ];
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', overrides, NOW);
    // banking iterates first (verticals × families canonical) → wins
    expect(m.peak_cell?.vertical).toBe('banking');
    expect(m.peak_cell?.family).toBe('BEH');
  });

  test('peak_cell null on empty', () => {
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', [], NOW);
    expect(m.peak_cell).toBeNull();
  });

  test('most_overridden_family = most distinct verticals', () => {
    const overrides = [
      // FIN can't span both since FIN is banking-only by convention; use a different setup.
      // banking_only family (FIN) — 5 overrides
      makeOverride('FIN-001', 'banking'),
      makeOverride('FIN-002', 'banking'),
      makeOverride('FIN-003', 'banking'),
      makeOverride('FIN-004', 'banking'),
      makeOverride('FIN-005', 'banking'),
      // POL+POL-2 (both insurance) — only 2 distinct
      makeOverride('POL-001', 'insurance'),
      makeOverride('POL-002', 'insurance'),
    ];
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', overrides, NOW);
    // FIN has 1 vertical (banking only), POL also has 1 vertical (insurance only)
    // Tied at 1 — FIN wins canonical
    expect(m.most_overridden_family).toBe('FIN');
  });

  test('most_overridden_family canonical tie-break', () => {
    const overrides = [
      makeOverride('FIN-001', 'banking'),
      makeOverride('BEH-001', 'banking'),
    ];
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', overrides, NOW);
    // FIN + BEH both span 1 vertical → FIN wins (canonical first)
    expect(m.most_overridden_family).toBe('FIN');
  });

  test('most_overridden_family null on empty', () => {
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', [], NOW);
    expect(m.most_overridden_family).toBeNull();
  });

  test('most_active_vertical = most distinct families', () => {
    const overrides = [
      // banking spans 2 families (FIN + BEH)
      makeOverride('FIN-001', 'banking'),
      makeOverride('BEH-001', 'banking'),
      // insurance in 1 family but 3 entries
      makeOverride('POL-001', 'insurance'),
      makeOverride('POL-002', 'insurance'),
      makeOverride('POL-003', 'insurance'),
    ];
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', overrides, NOW);
    expect(m.most_active_vertical).toBe('banking');
  });

  test('most_active_vertical canonical tie-break', () => {
    const overrides = [
      // banking + insurance each span 1 family
      makeOverride('FIN-001', 'banking'),
      makeOverride('POL-001', 'insurance'),
    ];
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', overrides, NOW);
    // banking iterates first → wins
    expect(m.most_active_vertical).toBe('banking');
  });

  test('most_active_vertical null on empty', () => {
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', [], NOW);
    expect(m.most_active_vertical).toBeNull();
  });

  test('empty_cells in canonical vertical × family row-major order', () => {
    const overrides = [
      makeOverride('FIN-001', 'banking'),
      makeOverride('POL-001', 'insurance'),
    ];
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', overrides, NOW);
    // 18 cells; 2 populated, 16 empty
    expect(m.empty_cells.length).toBe(16);
    // First empty (banking, BEH) since (banking, FIN) populated
    expect(m.empty_cells[0]).toEqual({ vertical: 'banking', family: 'BEH' });
  });

  test('unknown_families collects out-of-enum prefix indicators', () => {
    const overrides = [
      makeOverride('FIN-001', 'banking'),
      // BOGUS- prefix not in canonical 9-family set
      makeOverride('BOGUS-001', 'banking'),
      makeOverride('BAD-002', 'banking'),
    ];
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', overrides, NOW);
    expect(m.total_overrides).toBe(1); // only FIN-001 counted
    expect(m.unknown_families).toEqual(['BAD-002', 'BOGUS-001']); // sorted asc
  });

  test('out-of-enum vertical silently skipped', () => {
    const overrides = [
      { ...makeOverride('FIN-001', 'banking'), vertical: 'unknown' as never },
      makeOverride('BEH-001', 'banking'),
    ];
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', overrides, NOW);
    expect(m.total_overrides).toBe(1);
  });

  test('tenant_id + generated_at echo', () => {
    const m = buildIndicatorOverrideVerticalFamilyMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.generated_at).toBe(NOW.toISOString());
  });
});

describe('M4.17 — GET /v1/indicators/overrides/vertical-family-matrix', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeTestApp('admin', new InMemoryThresholdOverrideStore());
    const r = await request(app)
      .get('/v1/indicators/overrides/vertical-family-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(0);
    expect(r.body.body.rows.length).toBe(2);
    expect(r.body.body.columns.length).toBe(9);
  });

  test('populated reflects overrides', async () => {
    const store = new InMemoryThresholdOverrideStore();
    store.setOverride('BIL', 'FIN-001', {
      yellow_at: 0.3,
      orange_at: 0.55,
      red_at: 0.85,
    });
    store.setOverride('BIL', 'FIN-002', {
      yellow_at: 0.25,
      orange_at: 0.5,
      red_at: 0.75,
    });
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/indicators/overrides/vertical-family-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(2);
    expect(r.body.body.peak_cell.vertical).toBe('banking');
    expect(r.body.body.peak_cell.family).toBe('FIN');
    expect(r.body.body.peak_cell.count).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTestApp('case_owner');
    const r = await request(app)
      .get('/v1/indicators/overrides/vertical-family-matrix')
      .set(TH);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryThresholdOverrideStore();
    store.setOverride('BIL', 'FIN-001', {
      yellow_at: 0.3,
      orange_at: 0.55,
      red_at: 0.8,
    });
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/indicators/overrides/vertical-family-matrix')
      .set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(0);
  });

  test('M4.16 /vertical-family-matrix sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/indicators/vertical-family-matrix')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('M4.12 /thresholds/drift sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/indicators/thresholds/drift')
      .set(TH);
    expect(r.status).toBe(200);
  });
});
