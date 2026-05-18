// services/bff/__tests__/indicator_vertical_family_matrix.test.ts
//
// T6 M4.16 — Indicator vertical × family cross-tab matrix.

import request from 'supertest';
import {
  buildIndicatorVerticalFamilyMatrix,
  ALL_INDICATOR_FAMILIES,
  type IndicatorFamily,
} from '../src/indicator_vertical_family_matrix';
import { STUB_CATALOG } from '../src/bil_scoring_v2';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeVfApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M4.16 — envelope shape', () => {
  test('rows + columns dimensions', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    expect(s.rows.length).toBe(2);
    expect(s.columns.length).toBe(9);
    expect(s.total_verticals).toBe(2);
    expect(s.total_families).toBe(9);
  });

  test('rows in canonical vertical order', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    expect(s.rows.map((r) => r.vertical)).toEqual(['banking', 'insurance']);
  });

  test('columns in canonical family order', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    expect(s.columns.map((c) => c.family)).toEqual([...ALL_INDICATOR_FAMILIES]);
  });
});

describe('M4.16 — total_indicators matches catalog', () => {
  test('Σ row.total = total_indicators', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    const sum = s.rows.reduce((acc, r) => acc + r.total, 0);
    expect(sum).toBe(s.total_indicators);
  });

  test('Σ col.total = total_indicators', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    const sum = s.columns.reduce((acc, c) => acc + c.total, 0);
    expect(sum).toBe(s.total_indicators);
  });

  test('total_indicators reflects STUB_CATALOG entries with recognised families', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    // Every catalog entry has a known family (FIN/BEH/TXN/CRD/POL/CUS-INS/AGT/CLM/OPS)
    expect(s.total_indicators).toBe(Object.keys(STUB_CATALOG).length);
    expect(s.unknown_families).toEqual([]);
  });
});

describe('M4.16 — every row by_family carries all 9 keys', () => {
  test('keys present even when 0', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    for (const r of s.rows) {
      for (const f of ALL_INDICATOR_FAMILIES) {
        expect(r.by_family[f]).toBeGreaterThanOrEqual(0);
      }
      expect(Object.keys(r.by_family).length).toBe(9);
    }
  });
});

describe('M4.16 — every column by_vertical carries both verticals', () => {
  test('banking + insurance keys present', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    for (const c of s.columns) {
      expect(Object.keys(c.by_vertical).sort()).toEqual(['banking', 'insurance']);
    }
  });
});

describe('M4.16 — cell cross-check invariant', () => {
  test('row[v].by_family[f] === col[f].by_vertical[v]', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    for (const r of s.rows) {
      for (const c of s.columns) {
        expect(r.by_family[c.family]).toBe(c.by_vertical[r.vertical]);
      }
    }
  });
});

describe('M4.16 — banking row has 4 non-zero families', () => {
  test('FIN/BEH/TXN/CRD non-zero in banking', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    const banking = s.rows.find((r) => r.vertical === 'banking')!;
    expect(banking.by_family.FIN).toBeGreaterThan(0);
    expect(banking.by_family.BEH).toBeGreaterThan(0);
    expect(banking.by_family.TXN).toBeGreaterThan(0);
    expect(banking.by_family.CRD).toBeGreaterThan(0);
    // Insurance families should be 0 in banking row
    expect(banking.by_family.POL).toBe(0);
    expect(banking.by_family['CUS-INS']).toBe(0);
  });
});

describe('M4.16 — insurance row has 5 non-zero families', () => {
  test('POL/CUS-INS/AGT/CLM/OPS non-zero in insurance', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    const insurance = s.rows.find((r) => r.vertical === 'insurance')!;
    expect(insurance.by_family.POL).toBeGreaterThan(0);
    expect(insurance.by_family['CUS-INS']).toBeGreaterThan(0);
    expect(insurance.by_family.AGT).toBeGreaterThan(0);
    expect(insurance.by_family.CLM).toBeGreaterThan(0);
    expect(insurance.by_family.OPS).toBeGreaterThan(0);
    // Banking families should be 0 in insurance row
    expect(insurance.by_family.FIN).toBe(0);
    expect(insurance.by_family.CRD).toBe(0);
  });
});

describe('M4.16 — families_without per row', () => {
  test('banking row missing all insurance families', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    const banking = s.rows.find((r) => r.vertical === 'banking')!;
    expect(banking.families_without).toEqual(['POL', 'CUS-INS', 'AGT', 'CLM', 'OPS']);
  });

  test('insurance row missing all banking families', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    const insurance = s.rows.find((r) => r.vertical === 'insurance')!;
    expect(insurance.families_without).toEqual(['FIN', 'BEH', 'TXN', 'CRD']);
  });
});

describe('M4.16 — verticals_without per column', () => {
  test('FIN column missing insurance', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    const fin = s.columns.find((c) => c.family === 'FIN')!;
    expect(fin.verticals_without).toEqual(['insurance']);
  });

  test('POL column missing banking', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    const pol = s.columns.find((c) => c.family === 'POL')!;
    expect(pol.verticals_without).toEqual(['banking']);
  });
});

describe('M4.16 — peak_cell', () => {
  test('finds highest-count cell + sorted indicator_ids', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    expect(s.peak_cell).not.toBeNull();
    expect(s.peak_cell!.count).toBeGreaterThan(0);
    // indicator_ids should be sorted asc
    const ids = s.peak_cell!.indicator_ids;
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  test('peak count >= every cell', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    if (s.peak_cell) {
      for (const r of s.rows) {
        for (const f of ALL_INDICATOR_FAMILIES) {
          expect(s.peak_cell!.count).toBeGreaterThanOrEqual(r.by_family[f]);
        }
      }
    }
  });
});

describe('M4.16 — empty_cells', () => {
  test('canonical row-major order (vertical major × family minor)', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    // For the default catalog: banking has POL/CUS-INS/AGT/CLM/OPS missing
    // (5 cells) and insurance has FIN/BEH/TXN/CRD missing (4 cells). Total = 9.
    expect(s.empty_cells.length).toBe(9);
    // First empty in canonical order should be (banking, POL) — banking's
    // first insurance family
    expect(s.empty_cells[0]).toEqual({ vertical: 'banking', family: 'POL' });
  });
});

describe('M4.16 — most_diverse_vertical', () => {
  test('insurance has 5 non-zero families vs banking 4', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    expect(s.most_diverse_vertical).toBe('insurance');
  });
});

describe('M4.16 — most_universal_family', () => {
  test('no family spans both verticals → first canonical family with span=1 wins', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    // Every family has span=1 (only one vertical). Canonical-order
    // tie-break: FIN wins (first in ALL_INDICATOR_FAMILIES).
    expect(s.most_universal_family).toBe('FIN');
  });
});

describe('M4.16 — generated_at echo', () => {
  test('ISO timestamp echoed', () => {
    const s = buildIndicatorVerticalFamilyMatrix(NOW);
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M4.16 — GET /v1/indicators/vertical-family-matrix', () => {
  test('admin → 200 with full matrix', async () => {
    const { app } = makeVfApp('admin');
    const r = await request(app)
      .get('/v1/indicators/vertical-family-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.rows.length).toBe(2);
    expect(r.body.body.columns.length).toBe(9);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeVfApp('field_officer');
    const r = await request(app)
      .get('/v1/indicators/vertical-family-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: same response across tenants', async () => {
    const { app } = makeVfApp('admin');
    const bil = await request(app)
      .get('/v1/indicators/vertical-family-matrix')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/indicators/vertical-family-matrix')
      .set(TH_BANK);
    expect(bil.body.body.total_indicators).toBe(bank.body.body.total_indicators);
    expect(bil.body.body.most_diverse_vertical).toBe(bank.body.body.most_diverse_vertical);
  });

  test('M4.15 /v1/indicators/weight-histogram sibling regression still 200', async () => {
    const { app } = makeVfApp('admin');
    const r = await request(app)
      .get('/v1/indicators/weight-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M4.13 /v1/indicators/catalog-stats sibling regression still 200', async () => {
    const { app } = makeVfApp('admin');
    const r = await request(app)
      .get('/v1/indicators/catalog-stats')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
