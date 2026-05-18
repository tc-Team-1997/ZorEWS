// services/bff/__tests__/scoring_preset_family_matrix.test.ts
//
// T6 M6.18 — Library weight preset × indicator family cross-tab matrix.

import request from 'supertest';
import {
  buildScoringPresetFamilyMatrix,
  ALL_INDICATOR_FAMILIES,
} from '../src/scoring_preset_family_matrix';
import { WEIGHT_PRESETS } from '../src/scoring_presets';
import { STUB_CATALOG } from '../src/bil_scoring_v2';
import { familyOf } from '../src/indicator_catalog_stats';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
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

// ─── Pure resolver ─────────────────────────────────────────────────────

describe('M6.18 — buildScoringPresetFamilyMatrix', () => {
  test('basic envelope shape', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_presets).toBe(WEIGHT_PRESETS.length);
    expect(s.total_families).toBe(ALL_INDICATOR_FAMILIES.length);
    expect(s.total_families).toBe(9);
    expect(s.rows.length).toBe(WEIGHT_PRESETS.length);
    expect(s.columns.length).toBe(9);
  });

  test('rows in canonical preset_id asc order', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    const ids = s.rows.map((r) => r.preset_id);
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    expect(ids).toEqual(sorted);
  });

  test('columns in canonical ALL_INDICATOR_FAMILIES order', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    const families = s.columns.map((c) => c.family);
    expect(families).toEqual([...ALL_INDICATOR_FAMILIES]);
  });

  test('every by_family key present per row', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    for (const row of s.rows) {
      for (const family of ALL_INDICATOR_FAMILIES) {
        expect(row.by_family[family]).toBeGreaterThanOrEqual(0);
      }
      expect(Object.keys(row.by_family).length).toBe(
        ALL_INDICATOR_FAMILIES.length,
      );
    }
  });

  test('Σ row.by_family per row = row.total_overrides partition', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    for (const row of s.rows) {
      const sum = ALL_INDICATOR_FAMILIES.reduce(
        (acc, f) => acc + row.by_family[f]!,
        0,
      );
      expect(sum).toBe(row.total_overrides);
    }
  });

  test('Σ col.by_preset per col = col.total_overrides partition', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    for (const col of s.columns) {
      const sum = Object.values(col.by_preset).reduce((a, n) => a + n, 0);
      expect(sum).toBe(col.total_overrides);
    }
  });

  test('grand-total cross-check: Σ rows = Σ cols = total_overrides', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    const rowSum = s.rows.reduce((acc, r) => acc + r.total_overrides, 0);
    const colSum = s.columns.reduce((acc, c) => acc + c.total_overrides, 0);
    expect(rowSum).toBe(s.total_overrides);
    expect(colSum).toBe(s.total_overrides);
  });

  test('cell cross-check: row.by_family[f] === sum across presets of cells', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    for (const row of s.rows) {
      for (const family of ALL_INDICATOR_FAMILIES) {
        const cellVal = row.by_family[family]!;
        const col = s.columns.find((c) => c.family === family)!;
        const colCellVal = col.by_preset[row.preset_id] ?? 0;
        expect(cellVal).toBe(colCellVal);
      }
    }
  });

  test('total_overrides matches manual scan over WEIGHT_PRESETS', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    const manualSum = WEIGHT_PRESETS.reduce(
      (acc, p) => acc + Object.keys(p.weight_multipliers).length,
      0,
    );
    expect(s.total_overrides).toBe(manualSum);
  });

  test('balanced presets have zero overrides', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    const balancedRows = s.rows.filter((r) => r.mode === 'balanced');
    expect(balancedRows.length).toBeGreaterThan(0);
    for (const r of balancedRows) {
      expect(r.total_overrides).toBe(0);
      expect(r.distinct_families).toBe(0);
      expect(r.families_without).toEqual([...ALL_INDICATOR_FAMILIES]);
    }
  });

  test('row data carries mode + vertical from WEIGHT_PRESETS', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    for (const row of s.rows) {
      const seed = WEIGHT_PRESETS.find((p) => p.id === row.preset_id)!;
      expect(row.mode).toBe(seed.mode);
      expect(row.vertical).toBe(seed.vertical);
      expect(row.preset_name).toBe(seed.name);
    }
  });

  test('distinct_families = ALL_FAMILIES.length - families_without.length', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    for (const row of s.rows) {
      expect(row.distinct_families).toBe(
        ALL_INDICATOR_FAMILIES.length - row.families_without.length,
      );
    }
  });

  test('families_without canonical order', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    for (const row of s.rows) {
      const indices = row.families_without.map((f) =>
        ALL_INDICATOR_FAMILIES.indexOf(f),
      );
      const sortedIdx = [...indices].sort((a, b) => a - b);
      expect(indices).toEqual(sortedIdx);
    }
  });

  test('presets_without canonical preset_id asc order per column', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    for (const col of s.columns) {
      const sorted = [...col.presets_without].sort((a, b) => a.localeCompare(b));
      expect(col.presets_without).toEqual(sorted);
    }
  });

  test('peak_cell formula = highest count', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    let max = 0;
    for (const row of s.rows) {
      for (const f of ALL_INDICATOR_FAMILIES) {
        if (row.by_family[f]! > max) max = row.by_family[f]!;
      }
    }
    expect(s.peak_cell?.count).toBe(max);
    if (s.peak_cell !== null) {
      const row = s.rows.find((r) => r.preset_id === s.peak_cell!.preset_id)!;
      expect(row.by_family[s.peak_cell.family]).toBe(max);
    }
  });

  test('most_focused_preset = preset with most distinct_families', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    if (s.most_focused_preset !== null) {
      const focused = s.rows.find((r) => r.preset_id === s.most_focused_preset)!;
      for (const row of s.rows) {
        if (row.preset_id === s.most_focused_preset) continue;
        // No other row has STRICTLY more distinct_families.
        expect(row.distinct_families).toBeLessThanOrEqual(focused.distinct_families);
      }
    }
  });

  test('most_overridden_family = family with most distinct_presets', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    if (s.most_overridden_family !== null) {
      const champ = s.columns.find((c) => c.family === s.most_overridden_family)!;
      for (const col of s.columns) {
        if (col.family === s.most_overridden_family) continue;
        expect(col.distinct_presets).toBeLessThanOrEqual(champ.distinct_presets);
      }
    }
  });

  test('unused_families = families with total_overrides=0', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    const manualUnused = s.columns
      .filter((c) => c.total_overrides === 0)
      .map((c) => c.family);
    expect(s.unused_families).toEqual(manualUnused);
    // canonical order
    const indices = s.unused_families.map((f) =>
      ALL_INDICATOR_FAMILIES.indexOf(f),
    );
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  test('seed catalog has overrides spread across presets', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    // We expect > 0 overrides in a healthy seed catalog
    expect(s.total_overrides).toBeGreaterThan(0);
    // Some presets touch some indicators
    expect(s.most_focused_preset).not.toBeNull();
    expect(s.most_overridden_family).not.toBeNull();
  });

  test('platform-static — same data across now() calls', () => {
    const s1 = buildScoringPresetFamilyMatrix(NOW);
    const NOW2 = new Date('2026-06-15T08:30:00.000Z');
    const s2 = buildScoringPresetFamilyMatrix(NOW2);
    expect(s1.total_presets).toBe(s2.total_presets);
    expect(s1.total_overrides).toBe(s2.total_overrides);
    expect(s1.most_focused_preset).toBe(s2.most_focused_preset);
    expect(s1.peak_cell?.count).toBe(s2.peak_cell?.count);
  });

  test('every override indicator lives in a known family', () => {
    // Defensive — every preset_multiplier id maps cleanly via familyOf.
    for (const preset of WEIGHT_PRESETS) {
      for (const id of Object.keys(preset.weight_multipliers)) {
        const family = familyOf(id);
        // STUB_CATALOG carries these — should not contribute to drift.
        if (STUB_CATALOG[id]) {
          expect(ALL_INDICATOR_FAMILIES).toContain(family);
        }
      }
    }
  });

  test('cell counts match manual scan via familyOf', () => {
    const s = buildScoringPresetFamilyMatrix(NOW);
    for (const preset of WEIGHT_PRESETS) {
      const manualCounts: Record<string, number> = {};
      for (const f of ALL_INDICATOR_FAMILIES) manualCounts[f] = 0;
      for (const id of Object.keys(preset.weight_multipliers)) {
        if (!STUB_CATALOG[id]) continue;
        const f = familyOf(id);
        if (ALL_INDICATOR_FAMILIES.includes(f)) manualCounts[f]++;
      }
      const row = s.rows.find((r) => r.preset_id === preset.id)!;
      for (const f of ALL_INDICATOR_FAMILIES) {
        expect(row.by_family[f]).toBe(manualCounts[f]);
      }
    }
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M6.18 — GET /v1/scoring/presets/family-matrix', () => {
  test('admin → 200 with shape', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/scoring/presets/family-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_presets).toBe(WEIGHT_PRESETS.length);
    expect(r.body.body.total_families).toBe(9);
    expect(r.body.body.rows.length).toBe(WEIGHT_PRESETS.length);
    expect(r.body.body.columns.length).toBe(9);
  });

  test('risk_analyst accepted', async () => {
    const { app } = makeTestApp('risk_analyst');
    const r = await request(app)
      .get('/v1/scoring/presets/family-matrix')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('unknown role → 403', async () => {
    // customers:read_risk_profile allows all 5 known roles; only an
    // unknown role triggers 403.
    const { app } = makeTestApp('unknown_role');
    const r = await request(app)
      .get('/v1/scoring/presets/family-matrix')
      .set(TH);
    expect(r.status).toBe(403);
  });

  test('platform-static across tenants', async () => {
    const { app } = makeTestApp('admin');
    const r1 = await request(app)
      .get('/v1/scoring/presets/family-matrix')
      .set(TH);
    const r2 = await request(app)
      .get('/v1/scoring/presets/family-matrix')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r1.body.body.total_overrides).toBe(r2.body.body.total_overrides);
    expect(r1.body.body.most_focused_preset).toBe(r2.body.body.most_focused_preset);
  });

  test('M6.15 /inventory sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/scoring/presets/inventory')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('M6.16 /multiplier-histogram sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/scoring/presets/multiplier-histogram')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('literal /family-matrix not captured by /:preset_id wildcard', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/scoring/presets/family-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.rows).toBeDefined();
  });
});
