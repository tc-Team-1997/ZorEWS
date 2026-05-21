// services/bff/__tests__/indicator_vertical_weight_matrix.test.ts
//
// T6 M4.18 — Indicator vertical × weight-bucket cross-tab matrix.

import request from 'supertest';
import { buildIndicatorVerticalWeightMatrix } from '../src/indicator_vertical_weight_matrix';
import { ALL_INDICATOR_WEIGHT_BUCKETS } from '../src/indicator_weight_histogram';
import { STUB_CATALOG } from '../src/bil_scoring_v2';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeVwApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Pure resolver — envelope shape ──────────────────────────────────

describe('M4.18 — envelope shape', () => {
  test('rows + columns dimensions', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    expect(s.rows.length).toBe(2);
    expect(s.columns.length).toBe(5);
    expect(s.total_verticals).toBe(2);
    expect(s.total_buckets).toBe(5);
  });

  test('rows in canonical vertical order', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    expect(s.rows.map((r) => r.vertical)).toEqual(['banking', 'insurance']);
  });

  test('columns in canonical bucket order', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    expect(s.columns.map((c) => c.bucket)).toEqual([...ALL_INDICATOR_WEIGHT_BUCKETS]);
  });

  test('generated_at echoed', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── total_indicators + partition invariants ─────────────────────────

describe('M4.18 — partition invariants', () => {
  test('total_indicators matches catalog row count', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    expect(s.total_indicators).toBe(Object.keys(STUB_CATALOG).length);
  });

  test('Σ row.total = total_indicators', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    const sum = s.rows.reduce((acc, r) => acc + r.total, 0);
    expect(sum).toBe(s.total_indicators);
  });

  test('Σ col.total = total_indicators', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    const sum = s.columns.reduce((acc, c) => acc + c.total, 0);
    expect(sum).toBe(s.total_indicators);
  });

  test('per-row Σ by_bucket = row.total', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    for (const r of s.rows) {
      const sum = ALL_INDICATOR_WEIGHT_BUCKETS.reduce(
        (acc, b) => acc + r.by_bucket[b],
        0,
      );
      expect(sum).toBe(r.total);
    }
  });

  test('per-col Σ by_vertical = col.total', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    for (const c of s.columns) {
      const sum = c.by_vertical.banking + c.by_vertical.insurance;
      expect(sum).toBe(c.total);
    }
  });

  test('cell cross-check: row.by_bucket[b] === col[b].by_vertical[v]', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    for (const r of s.rows) {
      for (const c of s.columns) {
        expect(r.by_bucket[c.bucket]).toBe(c.by_vertical[r.vertical]);
      }
    }
  });
});

// ─── Every-key-present invariants ─────────────────────────────────────

describe('M4.18 — every-key-present', () => {
  test('every row by_bucket has all 5 buckets', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    for (const r of s.rows) {
      const keys = Object.keys(r.by_bucket).sort();
      expect(keys).toEqual([...ALL_INDICATOR_WEIGHT_BUCKETS].sort());
    }
  });

  test('every col by_vertical has both verticals', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    for (const c of s.columns) {
      expect(Object.keys(c.by_vertical).sort()).toEqual(['banking', 'insurance']);
    }
  });
});

// ─── Known catalog spot-checks ───────────────────────────────────────

describe('M4.18 — known catalog values', () => {
  // Banking (8 indicators): FIN-001 0.9, FIN-002 0.7, FIN-003 0.6,
  //   BEH-001 0.5, BEH-002 0.4, TXN-001 0.6, TXN-002 0.55, CRD-001 0.65
  // Banking bucket distribution:
  //   critical: 1 (FIN-001 @ 0.9)
  //   high:     4 (FIN-002, FIN-003, TXN-001, CRD-001)
  //   medium:   3 (BEH-001, BEH-002, TXN-002)
  //   low_medium: 0
  //   low:        0
  test('banking row distribution', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    const banking = s.rows.find((r) => r.vertical === 'banking')!;
    expect(banking.total).toBe(8);
    expect(banking.by_bucket.critical).toBe(1);
    expect(banking.by_bucket.high).toBe(4);
    expect(banking.by_bucket.medium).toBe(3);
    expect(banking.by_bucket.low_medium).toBe(0);
    expect(banking.by_bucket.low).toBe(0);
  });

  // Insurance (9 indicators): POL-001 0.7, POL-002 0.6, CUS-INS-001 0.8,
  //   CUS-INS-002 0.5, AGT-001 0.6, CLM-001 0.85, CLM-002 0.75,
  //   CLM-003 0.7, OPS-001 0.5
  // Insurance bucket distribution:
  //   critical: 2 (CUS-INS-001 @ 0.8, CLM-001 @ 0.85)
  //   high:     5 (POL-001, POL-002, AGT-001, CLM-002, CLM-003)
  //   medium:   2 (CUS-INS-002, OPS-001)
  test('insurance row distribution', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    const insurance = s.rows.find((r) => r.vertical === 'insurance')!;
    expect(insurance.total).toBe(9);
    expect(insurance.by_bucket.critical).toBe(2);
    expect(insurance.by_bucket.high).toBe(5);
    expect(insurance.by_bucket.medium).toBe(2);
    expect(insurance.by_bucket.low_medium).toBe(0);
    expect(insurance.by_bucket.low).toBe(0);
  });

  test('critical column has 1 banking + 2 insurance', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    const crit = s.columns.find((c) => c.bucket === 'critical')!;
    expect(crit.total).toBe(3);
    expect(crit.by_vertical.banking).toBe(1);
    expect(crit.by_vertical.insurance).toBe(2);
  });

  test('high column has 4 banking + 5 insurance', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    const high = s.columns.find((c) => c.bucket === 'high')!;
    expect(high.total).toBe(9);
    expect(high.by_vertical.banking).toBe(4);
    expect(high.by_vertical.insurance).toBe(5);
  });

  test('low + low_medium columns both empty', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    const low = s.columns.find((c) => c.bucket === 'low')!;
    const lm = s.columns.find((c) => c.bucket === 'low_medium')!;
    expect(low.total).toBe(0);
    expect(lm.total).toBe(0);
    expect(low.verticals_without).toEqual(['banking', 'insurance']);
    expect(lm.verticals_without).toEqual(['banking', 'insurance']);
  });
});

// ─── buckets_without invariants ──────────────────────────────────────

describe('M4.18 — buckets_without canonical order', () => {
  test('banking missing low + low_medium', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    const banking = s.rows.find((r) => r.vertical === 'banking')!;
    expect(banking.buckets_without).toEqual(['low', 'low_medium']);
  });

  test('insurance missing low + low_medium', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    const insurance = s.rows.find((r) => r.vertical === 'insurance')!;
    expect(insurance.buckets_without).toEqual(['low', 'low_medium']);
  });

  test('every row.buckets_without ⊂ ALL_INDICATOR_WEIGHT_BUCKETS', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    for (const r of s.rows) {
      for (const b of r.buckets_without) {
        expect(ALL_INDICATOR_WEIGHT_BUCKETS).toContain(b);
        expect(r.by_bucket[b]).toBe(0);
      }
    }
  });
});

// ─── Per-row weight stats ────────────────────────────────────────────

describe('M4.18 — per-row weight stats', () => {
  test('banking min/max/mean', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    const banking = s.rows.find((r) => r.vertical === 'banking')!;
    // Banking weights: 0.9, 0.7, 0.6, 0.5, 0.4, 0.6, 0.55, 0.65
    // sum = 4.9, count = 8, mean = 0.6125
    expect(banking.min_weight).toBe(0.4);
    expect(banking.max_weight).toBe(0.9);
    expect(banking.mean_weight).toBe(0.6125);
  });

  test('insurance min/max/mean', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    const insurance = s.rows.find((r) => r.vertical === 'insurance')!;
    // Insurance weights: 0.7, 0.6, 0.8, 0.5, 0.6, 0.85, 0.75, 0.7, 0.5
    // sum = 6.0, count = 9, mean = 0.6667 (rounded 4 decimals)
    expect(insurance.min_weight).toBe(0.5);
    expect(insurance.max_weight).toBe(0.85);
    expect(insurance.mean_weight).toBe(0.6667);
  });

  test('min ≤ mean ≤ max invariant per row', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    for (const r of s.rows) {
      if (r.total > 0) {
        expect(r.min_weight).not.toBeNull();
        expect(r.max_weight).not.toBeNull();
        expect(r.mean_weight).not.toBeNull();
        expect(r.mean_weight!).toBeGreaterThanOrEqual(r.min_weight!);
        expect(r.mean_weight!).toBeLessThanOrEqual(r.max_weight!);
      }
    }
  });
});

// ─── peak_cell ───────────────────────────────────────────────────────

describe('M4.18 — peak_cell', () => {
  test('peak_cell = insurance/high count 5', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    expect(s.peak_cell).not.toBeNull();
    expect(s.peak_cell!.vertical).toBe('insurance');
    expect(s.peak_cell!.bucket).toBe('high');
    expect(s.peak_cell!.count).toBe(5);
  });

  test('peak_cell.sample_indicator_ids capped at 5 + sorted asc', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    expect(s.peak_cell!.sample_indicator_ids.length).toBeLessThanOrEqual(5);
    const sorted = [...s.peak_cell!.sample_indicator_ids].sort();
    expect(s.peak_cell!.sample_indicator_ids).toEqual(sorted);
  });

  test('peak_cell.count strictly ≥ every other cell', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    for (const r of s.rows) {
      for (const b of ALL_INDICATOR_WEIGHT_BUCKETS) {
        expect(r.by_bucket[b]).toBeLessThanOrEqual(s.peak_cell!.count);
      }
    }
  });
});

// ─── empty_cells in canonical row-major order ────────────────────────

describe('M4.18 — empty_cells canonical row-major order', () => {
  test('empty_cells matches every count=0 cell', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    let manualEmpty = 0;
    for (const r of s.rows) {
      for (const b of ALL_INDICATOR_WEIGHT_BUCKETS) {
        if (r.by_bucket[b] === 0) manualEmpty++;
      }
    }
    expect(s.empty_cells.length).toBe(manualEmpty);
  });

  test('canonical row-major order: vertical major × bucket minor', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    // For our catalog: banking has low + low_medium empty;
    // insurance has low + low_medium empty.
    // Canonical order: banking/low, banking/low_medium,
    //                  insurance/low, insurance/low_medium.
    expect(s.empty_cells.length).toBe(4);
    expect(s.empty_cells[0]).toEqual({ vertical: 'banking', bucket: 'low' });
    expect(s.empty_cells[1]).toEqual({ vertical: 'banking', bucket: 'low_medium' });
    expect(s.empty_cells[2]).toEqual({ vertical: 'insurance', bucket: 'low' });
    expect(s.empty_cells[3]).toEqual({ vertical: 'insurance', bucket: 'low_medium' });
  });
});

// ─── Leaderboards ────────────────────────────────────────────────────

describe('M4.18 — most_diverse_vertical', () => {
  test('banking + insurance tied at 3 non-zero buckets → banking wins (canonical)', () => {
    // Banking has non-zero in {medium, high, critical} (3 buckets).
    // Insurance has non-zero in {medium, high, critical} (3 buckets).
    // Canonical tie-break (ALL_VERTICALS = [banking, insurance] order):
    // banking wins.
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    expect(s.most_diverse_vertical).toBe('banking');
  });
});

describe('M4.18 — heaviest_vertical', () => {
  test('insurance has 2 critical vs banking 1 → insurance', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    expect(s.heaviest_vertical).toBe('insurance');
  });
});

// ─── Bucket metadata ─────────────────────────────────────────────────

describe('M4.18 — bucket metadata', () => {
  test('each column carries min/max/max_inclusive', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    const critical = s.columns.find((c) => c.bucket === 'critical')!;
    expect(critical.min).toBe(0.8);
    expect(critical.max).toBe(1.0);
    expect(critical.max_inclusive).toBe(true);

    const low = s.columns.find((c) => c.bucket === 'low')!;
    expect(low.min).toBe(0);
    expect(low.max).toBe(0.2);
    expect(low.max_inclusive).toBe(false);
  });

  test('every label non-empty', () => {
    const s = buildIndicatorVerticalWeightMatrix(NOW);
    for (const c of s.columns) {
      expect(c.label.length).toBeGreaterThan(0);
    }
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M4.18 — GET /v1/indicators/vertical-weight-matrix', () => {
  test('admin → 200 with full matrix shape', async () => {
    const { app } = makeVwApp('admin');
    const r = await request(app)
      .get('/v1/indicators/vertical-weight-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.rows.length).toBe(2);
    expect(r.body.body.columns.length).toBe(5);
    expect(r.body.body.total_indicators).toBe(Object.keys(STUB_CATALOG).length);
  });

  test('peak_cell echoed in body', async () => {
    const { app } = makeVwApp('admin');
    const r = await request(app)
      .get('/v1/indicators/vertical-weight-matrix')
      .set(TH_BIL);
    expect(r.body.body.peak_cell).not.toBeNull();
    expect(r.body.body.peak_cell.vertical).toBe('insurance');
    expect(r.body.body.peak_cell.bucket).toBe('high');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeVwApp('field_officer');
    const r = await request(app)
      .get('/v1/indicators/vertical-weight-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: same response across BIL ↔ BANK_DEMO', async () => {
    const { app } = makeVwApp('admin');
    const bil = await request(app)
      .get('/v1/indicators/vertical-weight-matrix')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/indicators/vertical-weight-matrix')
      .set(TH_BANK);
    expect(bil.body.body.total_indicators).toBe(bank.body.body.total_indicators);
    expect(bil.body.body.most_diverse_vertical).toBe(bank.body.body.most_diverse_vertical);
    expect(bil.body.body.heaviest_vertical).toBe(bank.body.body.heaviest_vertical);
  });

  test('M4.16 /v1/indicators/vertical-family-matrix sibling regression still 200', async () => {
    const { app } = makeVwApp('admin');
    const r = await request(app)
      .get('/v1/indicators/vertical-family-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M4.15 /v1/indicators/weight-histogram sibling regression still 200', async () => {
    const { app } = makeVwApp('admin');
    const r = await request(app)
      .get('/v1/indicators/weight-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M4.13 /v1/indicators/catalog-stats sibling regression still 200', async () => {
    const { app } = makeVwApp('admin');
    const r = await request(app)
      .get('/v1/indicators/catalog-stats')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
