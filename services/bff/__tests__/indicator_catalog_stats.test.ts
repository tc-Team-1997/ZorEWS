// services/bff/__tests__/indicator_catalog_stats.test.ts
//
// T6 M4.13 — Indicator catalog statistics.

import request from 'supertest';
import {
  summarizeIndicatorCatalog,
  familyOf,
  ALL_INDICATOR_VERTICALS,
} from '../src/indicator_catalog_stats';
import { STUB_CATALOG } from '../src/bil_scoring_v2';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeCatApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── familyOf — pure helper ──────────────────────────────────────────

describe('M4.13 — familyOf helper', () => {
  test('FIN-001 → FIN', () => {
    expect(familyOf('FIN-001')).toBe('FIN');
  });
  test('CUS-INS-001 → CUS-INS (multi-segment prefix preserved)', () => {
    expect(familyOf('CUS-INS-001')).toBe('CUS-INS');
  });
  test('POL-002 → POL', () => {
    expect(familyOf('POL-002')).toBe('POL');
  });
  test('CLM-003 → CLM', () => {
    expect(familyOf('CLM-003')).toBe('CLM');
  });
  test('id without numeric suffix → whole id', () => {
    expect(familyOf('BAD')).toBe('BAD');
  });
});

// ─── summarizeIndicatorCatalog — pure ────────────────────────────────

describe('M4.13 — verticals[] shape', () => {
  test('exactly 2 verticals in canonical order (banking, insurance)', () => {
    const s = summarizeIndicatorCatalog(NOW);
    expect(s.verticals.length).toBe(2);
    expect(s.verticals.map((v) => v.vertical)).toEqual([...ALL_INDICATOR_VERTICALS]);
  });
});

describe('M4.13 — per-vertical count matches STUB_CATALOG', () => {
  test('counts agree with manual count of STUB_CATALOG entries', () => {
    const s = summarizeIndicatorCatalog(NOW);
    const manualBanking = Object.values(STUB_CATALOG).filter((e) => e.vertical === 'banking').length;
    const manualInsurance = Object.values(STUB_CATALOG).filter((e) => e.vertical === 'insurance').length;
    expect(s.verticals.find((v) => v.vertical === 'banking')!.count).toBe(manualBanking);
    expect(s.verticals.find((v) => v.vertical === 'insurance')!.count).toBe(manualInsurance);
  });
});

describe('M4.13 — Σ per-vertical count = total_indicators', () => {
  test('partition invariant', () => {
    const s = summarizeIndicatorCatalog(NOW);
    const sum = s.verticals.reduce((acc, v) => acc + v.count, 0);
    expect(sum).toBe(s.total_indicators);
    expect(s.total_indicators).toBe(Object.keys(STUB_CATALOG).length);
  });
});

describe('M4.13 — by_family partition', () => {
  test('Σ by_family values per row = row.count', () => {
    const s = summarizeIndicatorCatalog(NOW);
    for (const row of s.verticals) {
      const sum = Object.values(row.by_family).reduce((a, b) => a + b, 0);
      expect(sum).toBe(row.count);
    }
  });

  test('banking row carries FIN, BEH, TXN, CRD families', () => {
    const s = summarizeIndicatorCatalog(NOW);
    const banking = s.verticals.find((v) => v.vertical === 'banking')!;
    expect(banking.by_family.FIN).toBeGreaterThan(0);
    expect(banking.by_family.BEH).toBeGreaterThan(0);
    expect(banking.by_family.TXN).toBeGreaterThan(0);
    expect(banking.by_family.CRD).toBeGreaterThan(0);
  });

  test('insurance row carries POL, CUS-INS, AGT, CLM, OPS families', () => {
    const s = summarizeIndicatorCatalog(NOW);
    const insurance = s.verticals.find((v) => v.vertical === 'insurance')!;
    expect(insurance.by_family.POL).toBeGreaterThan(0);
    expect(insurance.by_family['CUS-INS']).toBeGreaterThan(0);
    expect(insurance.by_family.AGT).toBeGreaterThan(0);
    expect(insurance.by_family.CLM).toBeGreaterThan(0);
    expect(insurance.by_family.OPS).toBeGreaterThan(0);
  });
});

describe('M4.13 — distinct_families counter', () => {
  test('matches Object.keys(by_family).length per row', () => {
    const s = summarizeIndicatorCatalog(NOW);
    for (const row of s.verticals) {
      expect(row.distinct_families).toBe(Object.keys(row.by_family).length);
    }
  });
});

describe('M4.13 — weight stats', () => {
  test('min ≤ mean ≤ max per row', () => {
    const s = summarizeIndicatorCatalog(NOW);
    for (const row of s.verticals) {
      if (row.weight === null) continue;
      expect(row.weight.min).toBeLessThanOrEqual(row.weight.mean);
      expect(row.weight.mean).toBeLessThanOrEqual(row.weight.max);
      expect(row.weight.min).toBeGreaterThan(0);
      expect(row.weight.max).toBeLessThanOrEqual(1);
    }
  });

  test('mean is finite + rounded to 4 places', () => {
    const s = summarizeIndicatorCatalog(NOW);
    for (const row of s.verticals) {
      if (row.weight === null) continue;
      expect(Number.isFinite(row.weight.mean)).toBe(true);
      const decimalPart = String(row.weight.mean).split('.')[1] ?? '';
      expect(decimalPart.length).toBeLessThanOrEqual(4);
    }
  });
});

describe('M4.13 — top_weighted sort', () => {
  test('cap at 3, sorted by weight desc with id asc tie-break', () => {
    const s = summarizeIndicatorCatalog(NOW);
    for (const row of s.verticals) {
      expect(row.top_weighted.length).toBeLessThanOrEqual(3);
      for (let i = 1; i < row.top_weighted.length; i++) {
        const prev = row.top_weighted[i - 1]!;
        const curr = row.top_weighted[i]!;
        if (prev.weight === curr.weight) {
          expect(prev.indicator_id.localeCompare(curr.indicator_id)).toBeLessThan(0);
        } else {
          expect(prev.weight).toBeGreaterThan(curr.weight);
        }
      }
    }
  });

  test('insurance top_weighted leads with CLM-001 (0.85)', () => {
    const s = summarizeIndicatorCatalog(NOW);
    const insurance = s.verticals.find((v) => v.vertical === 'insurance')!;
    expect(insurance.top_weighted[0]!.indicator_id).toBe('CLM-001');
    expect(insurance.top_weighted[0]!.weight).toBe(0.85);
  });
});

describe('M4.13 — total_distinct_families', () => {
  test('= count of all distinct families across both verticals', () => {
    const s = summarizeIndicatorCatalog(NOW);
    const allFamilies = new Set<string>();
    for (const row of s.verticals) {
      for (const fam of Object.keys(row.by_family)) allFamilies.add(fam);
    }
    expect(s.total_distinct_families).toBe(allFamilies.size);
  });
});

describe('M4.13 — most_populated_vertical', () => {
  test('points at the vertical with highest count', () => {
    const s = summarizeIndicatorCatalog(NOW);
    expect(s.most_populated_vertical).not.toBeNull();
    const top = s.verticals.reduce((a, b) => (a.count >= b.count ? a : b));
    expect(s.most_populated_vertical).toBe(top.vertical);
  });
});

describe('M4.13 — heaviest_indicator', () => {
  test('points at the highest-weight indicator across catalog', () => {
    const s = summarizeIndicatorCatalog(NOW);
    expect(s.heaviest_indicator).not.toBeNull();
    const manualMax = Math.max(...Object.values(STUB_CATALOG).map((e) => e.weight));
    expect(s.heaviest_indicator!.weight).toBe(manualMax);
  });

  test('banking FIN-001 wins at 0.9 (heaviest in seed)', () => {
    const s = summarizeIndicatorCatalog(NOW);
    expect(s.heaviest_indicator!.indicator_id).toBe('FIN-001');
    expect(s.heaviest_indicator!.weight).toBe(0.9);
  });
});

// ─── GET /v1/indicators/catalog-stats ────────────────────────────────

describe('M4.13 — GET /v1/indicators/catalog-stats', () => {
  test('admin → 200 with populated rollup', async () => {
    const { app } = makeCatApp('admin');
    const r = await request(app).get('/v1/indicators/catalog-stats').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.verticals.length).toBe(2);
    expect(r.body.body.total_indicators).toBeGreaterThan(0);
    expect(r.body.body.heaviest_indicator).not.toBeNull();
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCatApp('case_owner');
    const r = await request(app).get('/v1/indicators/catalog-stats').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: same response across BIL ↔ BANK_DEMO', async () => {
    const { app } = makeCatApp('admin');
    const bil = await request(app).get('/v1/indicators/catalog-stats').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/indicators/catalog-stats')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.status).toBe(200);
    expect(bank.status).toBe(200);
    expect(bil.body.body.total_indicators).toBe(bank.body.body.total_indicators);
    expect(bil.body.body.heaviest_indicator).toEqual(bank.body.body.heaviest_indicator);
  });

  test('M4.11 /v1/indicators/usage still works (sibling regression)', async () => {
    const { app } = makeCatApp('admin');
    const r = await request(app).get('/v1/indicators/usage').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
