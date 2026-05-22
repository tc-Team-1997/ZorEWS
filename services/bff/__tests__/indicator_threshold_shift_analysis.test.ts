// services/bff/__tests__/indicator_threshold_shift_analysis.test.ts
//
// T6 M4.19 — Indicator threshold override band shift analysis.

import request from 'supertest';
import {
  ALL_BAND_SHIFT_DIRECTIONS,
  ALL_OVERALL_SHIFT_DIRECTIONS,
  SHIFT_EPSILON,
  summarizeIndicatorThresholdShifts,
} from '../src/indicator_threshold_shift_analysis';
import {
  InMemoryThresholdOverrideStore,
  getThreshold,
} from '../src/indicator_thresholds';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-23T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── enum invariants ────────────────────────────────────────────────

describe('M4.19 — enum invariants', () => {
  test('ALL_BAND_SHIFT_DIRECTIONS has exactly 3 canonical values', () => {
    expect([...ALL_BAND_SHIFT_DIRECTIONS]).toEqual(['raised', 'lowered', 'unchanged']);
  });

  test('ALL_OVERALL_SHIFT_DIRECTIONS has exactly 4 canonical values', () => {
    expect([...ALL_OVERALL_SHIFT_DIRECTIONS]).toEqual([
      'all_raised',
      'all_lowered',
      'mixed',
      'unchanged',
    ]);
  });

  test('SHIFT_EPSILON is small but non-trivial', () => {
    expect(SHIFT_EPSILON).toBeGreaterThan(0);
    expect(SHIFT_EPSILON).toBeLessThanOrEqual(0.01);
  });
});

// ─── empty store ────────────────────────────────────────────────────

describe('M4.19 — empty store', () => {
  test('no overrides → empty envelope with zero counts + null leaderboards', () => {
    const store = new InMemoryThresholdOverrideStore();
    const s = summarizeIndicatorThresholdShifts(store, 'BIL', NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_overrides).toBe(0);
    expect(s.total_orphan_overrides).toBe(0);
    expect(s.shifts).toEqual([]);
    expect(s.most_aggressive_tightening).toBeNull();
    expect(s.most_aggressive_loosening).toBeNull();
    expect(s.most_recalibrated_indicator).toBeNull();
    // every key present at 0
    for (const band of ['yellow', 'orange', 'red'] as const) {
      for (const dir of ALL_BAND_SHIFT_DIRECTIONS) {
        expect(s.by_band_direction[band][dir]).toBe(0);
      }
    }
    for (const dir of ALL_OVERALL_SHIFT_DIRECTIONS) {
      expect(s.by_overall_direction[dir]).toBe(0);
    }
  });

  test('throws on empty tenant_id', () => {
    const store = new InMemoryThresholdOverrideStore();
    expect(() => summarizeIndicatorThresholdShifts(store, '', NOW)).toThrow();
    expect(() => summarizeIndicatorThresholdShifts(store, '   ', NOW)).toThrow();
  });
});

// ─── all_raised classification ──────────────────────────────────────

describe('M4.19 — all_raised override (ops looser than platform)', () => {
  test('raised every band → overall_direction=all_raised', () => {
    const store = new InMemoryThresholdOverrideStore();
    const lib = getThreshold('FIN-001')!;
    // Library: yellow 0.30, orange 0.55, red 0.80
    // Override: yellow 0.40 (+0.10), orange 0.65 (+0.10), red 0.90 (+0.10)
    store.setOverride('BIL', 'FIN-001', {
      ...lib,
      yellow_at: lib.yellow_at + 0.10,
      orange_at: lib.orange_at + 0.10,
      red_at: lib.red_at + 0.10,
    });
    const s = summarizeIndicatorThresholdShifts(store, 'BIL', NOW);
    expect(s.total_overrides).toBe(1);
    const row = s.shifts[0]!;
    expect(row.indicator_id).toBe('FIN-001');
    expect(row.overall_direction).toBe('all_raised');
    expect(row.yellow_shift.direction).toBe('raised');
    expect(row.orange_shift.direction).toBe('raised');
    expect(row.red_shift.direction).toBe('raised');
    // delta = effective − default; all positive
    expect(row.yellow_shift.delta).toBeCloseTo(0.10, 5);
    expect(row.orange_shift.delta).toBeCloseTo(0.10, 5);
    expect(row.red_shift.delta).toBeCloseTo(0.10, 5);
    expect(row.net_signed_delta).toBeCloseTo(0.30, 5);
    expect(row.total_magnitude).toBeCloseTo(0.30, 5);
    expect(s.by_overall_direction.all_raised).toBe(1);
    expect(s.most_aggressive_loosening?.indicator_id).toBe('FIN-001');
    expect(s.most_aggressive_tightening).toBeNull();
  });
});

// ─── all_lowered classification ─────────────────────────────────────

describe('M4.19 — all_lowered override (ops stricter than platform)', () => {
  test('lowered every band → overall_direction=all_lowered', () => {
    const store = new InMemoryThresholdOverrideStore();
    const lib = getThreshold('FIN-001')!;
    store.setOverride('BIL', 'FIN-001', {
      ...lib,
      yellow_at: lib.yellow_at - 0.05,
      orange_at: lib.orange_at - 0.05,
      red_at: lib.red_at - 0.05,
    });
    const s = summarizeIndicatorThresholdShifts(store, 'BIL', NOW);
    const row = s.shifts[0]!;
    expect(row.overall_direction).toBe('all_lowered');
    expect(row.yellow_shift.direction).toBe('lowered');
    expect(row.orange_shift.direction).toBe('lowered');
    expect(row.red_shift.direction).toBe('lowered');
    expect(row.net_signed_delta).toBeCloseTo(-0.15, 5);
    expect(s.by_overall_direction.all_lowered).toBe(1);
    expect(s.most_aggressive_tightening?.indicator_id).toBe('FIN-001');
    expect(s.most_aggressive_loosening).toBeNull();
  });
});

// ─── mixed classification ───────────────────────────────────────────

describe('M4.19 — mixed override (surgical per-band tuning)', () => {
  test('yellow raised + red lowered + orange unchanged → mixed', () => {
    const store = new InMemoryThresholdOverrideStore();
    const lib = getThreshold('FIN-001')!;
    store.setOverride('BIL', 'FIN-001', {
      ...lib,
      yellow_at: lib.yellow_at + 0.05, // raised
      orange_at: lib.orange_at, // unchanged
      red_at: lib.red_at - 0.10, // lowered
    });
    const s = summarizeIndicatorThresholdShifts(store, 'BIL', NOW);
    const row = s.shifts[0]!;
    expect(row.overall_direction).toBe('mixed');
    expect(row.yellow_shift.direction).toBe('raised');
    expect(row.orange_shift.direction).toBe('unchanged');
    expect(row.red_shift.direction).toBe('lowered');
    expect(row.net_signed_delta).toBeCloseTo(-0.05, 5);
    expect(s.by_overall_direction.mixed).toBe(1);
  });
});

// ─── unchanged classification ───────────────────────────────────────

describe('M4.19 — unchanged override (override equals default — redundant)', () => {
  test('every band equals default → overall_direction=unchanged', () => {
    const store = new InMemoryThresholdOverrideStore();
    const lib = getThreshold('FIN-001')!;
    store.setOverride('BIL', 'FIN-001', { ...lib }); // copy of default
    const s = summarizeIndicatorThresholdShifts(store, 'BIL', NOW);
    const row = s.shifts[0]!;
    expect(row.overall_direction).toBe('unchanged');
    expect(row.yellow_shift.direction).toBe('unchanged');
    expect(row.orange_shift.direction).toBe('unchanged');
    expect(row.red_shift.direction).toBe('unchanged');
    expect(row.net_signed_delta).toBe(0);
    expect(row.total_magnitude).toBe(0);
    expect(s.by_overall_direction.unchanged).toBe(1);
  });

  test('within-epsilon noise still classified as unchanged', () => {
    const store = new InMemoryThresholdOverrideStore();
    const lib = getThreshold('FIN-001')!;
    store.setOverride('BIL', 'FIN-001', {
      ...lib,
      yellow_at: lib.yellow_at + SHIFT_EPSILON / 2,
      orange_at: lib.orange_at,
      red_at: lib.red_at,
    });
    const s = summarizeIndicatorThresholdShifts(store, 'BIL', NOW);
    const row = s.shifts[0]!;
    expect(row.yellow_shift.direction).toBe('unchanged');
    expect(row.overall_direction).toBe('unchanged');
  });
});

// ─── multi-override + leaderboards ──────────────────────────────────

describe('M4.19 — multi-override cohort + leaderboards', () => {
  test('largest tightening + largest loosening + most-recalibrated selected correctly', () => {
    const store = new InMemoryThresholdOverrideStore();
    const fin = getThreshold('FIN-001')!;
    const beh = getThreshold('BEH-001');
    const txn = getThreshold('TXN-001');
    expect(beh).not.toBeNull();
    expect(txn).not.toBeNull();
    // FIN: all_lowered net -0.15 (tightening)
    store.setOverride('BIL', 'FIN-001', {
      ...fin,
      yellow_at: fin.yellow_at - 0.05,
      orange_at: fin.orange_at - 0.05,
      red_at: fin.red_at - 0.05,
    });
    // BEH: all_raised net +0.30 (loosening, biggest abs)
    store.setOverride('BIL', 'BEH-001', {
      ...beh!,
      yellow_at: beh!.yellow_at + 0.10,
      orange_at: beh!.orange_at + 0.10,
      red_at: beh!.red_at + 0.10,
    });
    // TXN-001 default = 0.45/0.70/0.85.
    // Mixed: yellow +0.20=0.65, orange unchanged 0.70, red -0.15=0.70
    //   → monotonic 0.65 ≤ 0.70 ≤ 0.70 ✓; magnitude=0.35; net=+0.05
    store.setOverride('BIL', 'TXN-001', {
      ...txn!,
      yellow_at: txn!.yellow_at + 0.20,
      orange_at: txn!.orange_at,
      red_at: txn!.red_at - 0.15,
    });
    const s = summarizeIndicatorThresholdShifts(store, 'BIL', NOW);
    expect(s.total_overrides).toBe(3);
    // Most aggressive tightening = FIN (only net-negative)
    expect(s.most_aggressive_tightening?.indicator_id).toBe('FIN-001');
    // Most aggressive loosening = BEH (largest positive net delta = +0.30)
    //   TXN net = +0.05; BEH wins on net_signed_delta
    expect(s.most_aggressive_loosening?.indicator_id).toBe('BEH-001');
    // Most recalibrated = highest total_magnitude.
    //   TXN=0.35, BEH=0.30, FIN=0.15 → TXN wins
    expect(s.most_recalibrated_indicator?.indicator_id).toBe('TXN-001');
    expect(s.most_recalibrated_indicator?.total_magnitude).toBeCloseTo(0.35, 5);
  });

  test('shifts sorted by total_magnitude desc + indicator_id asc tie-break', () => {
    const store = new InMemoryThresholdOverrideStore();
    const fin = getThreshold('FIN-001')!;
    const beh = getThreshold('BEH-001')!;
    // Both with identical total_magnitude = 0.30
    store.setOverride('BIL', 'FIN-001', {
      ...fin,
      yellow_at: fin.yellow_at + 0.10,
      orange_at: fin.orange_at + 0.10,
      red_at: fin.red_at + 0.10,
    });
    store.setOverride('BIL', 'BEH-001', {
      ...beh,
      yellow_at: beh.yellow_at + 0.10,
      orange_at: beh.orange_at + 0.10,
      red_at: beh.red_at + 0.10,
    });
    const s = summarizeIndicatorThresholdShifts(store, 'BIL', NOW);
    // tied magnitudes → BEH-001 sorts before FIN-001
    expect(s.shifts[0]!.indicator_id).toBe('BEH-001');
    expect(s.shifts[1]!.indicator_id).toBe('FIN-001');
  });

  test('by_band_direction + by_overall_direction Σ = total_overrides partition', () => {
    const store = new InMemoryThresholdOverrideStore();
    const fin = getThreshold('FIN-001')!;
    const beh = getThreshold('BEH-001')!;
    store.setOverride('BIL', 'FIN-001', {
      ...fin,
      yellow_at: fin.yellow_at + 0.10,
      orange_at: fin.orange_at + 0.10,
      red_at: fin.red_at + 0.10,
    });
    store.setOverride('BIL', 'BEH-001', {
      ...beh,
      yellow_at: beh.yellow_at - 0.05,
      orange_at: beh.orange_at - 0.05,
      red_at: beh.red_at - 0.05,
    });
    const s = summarizeIndicatorThresholdShifts(store, 'BIL', NOW);
    expect(s.total_overrides).toBe(2);
    for (const band of ['yellow', 'orange', 'red'] as const) {
      const sum =
        s.by_band_direction[band].raised +
        s.by_band_direction[band].lowered +
        s.by_band_direction[band].unchanged;
      expect(sum).toBe(s.total_overrides);
    }
    const overallSum =
      s.by_overall_direction.all_raised +
      s.by_overall_direction.all_lowered +
      s.by_overall_direction.mixed +
      s.by_overall_direction.unchanged;
    expect(overallSum).toBe(s.total_overrides);
  });
});

// ─── orphan override defensive skip ─────────────────────────────────

describe('M4.19 — orphan override (indicator no longer in catalog)', () => {
  // setOverride() validates against the catalog so we cannot inject an
  // orphan via the public API. Use a stub store that emits an orphan
  // from listOverrides — this exercises the defensive code path that
  // protects against catalog drift between override creation + read.
  test('orphan counted separately + excluded from shifts[]', () => {
    const fin = getThreshold('FIN-001')!;
    const realStore = new InMemoryThresholdOverrideStore();
    realStore.setOverride('BIL', 'FIN-001', {
      ...fin,
      yellow_at: fin.yellow_at + 0.10,
      orange_at: fin.orange_at + 0.10,
      red_at: fin.red_at + 0.10,
    });
    const orphanOverride = {
      indicator_id: 'BOGUS-999',
      vertical: 'banking' as const,
      name: 'Bogus',
      yellow_at: 0.1,
      orange_at: 0.2,
      red_at: 0.3,
    };
    const stubStore = {
      effective: realStore.effective.bind(realStore),
      getOverride: realStore.getOverride.bind(realStore),
      setOverride: realStore.setOverride.bind(realStore),
      deleteOverride: realStore.deleteOverride.bind(realStore),
      listOverrides(tenant_id: string) {
        const real = realStore.listOverrides(tenant_id);
        return tenant_id === 'BIL' ? [...real, orphanOverride] : real;
      },
    };
    const s = summarizeIndicatorThresholdShifts(stubStore, 'BIL', NOW);
    expect(s.total_overrides).toBe(1);
    expect(s.total_orphan_overrides).toBe(1);
    expect(s.shifts.map((r) => r.indicator_id)).toEqual(['FIN-001']);
  });
});

// ─── tenant scoping ─────────────────────────────────────────────────

describe('M4.19 — tenant scoping', () => {
  test('BIL overrides invisible to BANK_DEMO call', () => {
    const store = new InMemoryThresholdOverrideStore();
    const fin = getThreshold('FIN-001')!;
    store.setOverride('BIL', 'FIN-001', {
      ...fin,
      yellow_at: fin.yellow_at + 0.10,
      orange_at: fin.orange_at + 0.10,
      red_at: fin.red_at + 0.10,
    });
    const bil = summarizeIndicatorThresholdShifts(store, 'BIL', NOW);
    const bank = summarizeIndicatorThresholdShifts(store, 'BANK_DEMO', NOW);
    expect(bil.total_overrides).toBe(1);
    expect(bank.total_overrides).toBe(0);
  });
});

// ─── HTTP route ─────────────────────────────────────────────────────

function makeShiftApp(role = 'admin') {
  const thresholdOverrideStore = new InMemoryThresholdOverrideStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    thresholdOverrideStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, thresholdOverrideStore };
}

describe('M4.19 — GET /v1/indicators/thresholds/shift-analysis', () => {
  test('admin → 200 with empty envelope for fresh tenant', async () => {
    const { app } = makeShiftApp('admin');
    const r = await request(app)
      .get('/v1/indicators/thresholds/shift-analysis')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.total_overrides).toBe(0);
    expect(r.body.body.shifts).toEqual([]);
    expect(r.body.body.most_aggressive_tightening).toBeNull();
    expect(r.body.body.most_aggressive_loosening).toBeNull();
    expect(r.body.body.most_recalibrated_indicator).toBeNull();
  });

  test('populated → reflects override with correct leaderboards', async () => {
    const { app, thresholdOverrideStore } = makeShiftApp('admin');
    const fin = getThreshold('FIN-001')!;
    thresholdOverrideStore.setOverride('BIL', 'FIN-001', {
      ...fin,
      yellow_at: fin.yellow_at + 0.10,
      orange_at: fin.orange_at + 0.10,
      red_at: fin.red_at + 0.10,
    });
    const r = await request(app)
      .get('/v1/indicators/thresholds/shift-analysis')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(1);
    expect(r.body.body.shifts[0].overall_direction).toBe('all_raised');
    expect(r.body.body.most_aggressive_loosening.indicator_id).toBe('FIN-001');
    expect(r.body.body.most_aggressive_tightening).toBeNull();
    expect(r.body.body.most_recalibrated_indicator.indicator_id).toBe('FIN-001');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeShiftApp('case_owner');
    const r = await request(app)
      .get('/v1/indicators/thresholds/shift-analysis')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL overrides invisible to BANK_DEMO via HTTP', async () => {
    const { app, thresholdOverrideStore } = makeShiftApp('admin');
    const fin = getThreshold('FIN-001')!;
    thresholdOverrideStore.setOverride('BIL', 'FIN-001', {
      ...fin,
      yellow_at: fin.yellow_at + 0.10,
      orange_at: fin.orange_at + 0.10,
      red_at: fin.red_at + 0.10,
    });
    const bank = await request(app)
      .get('/v1/indicators/thresholds/shift-analysis')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_overrides).toBe(0);
  });

  test('literal /shift-analysis not captured by `:indicator_id` wildcard', async () => {
    const { app } = makeShiftApp('admin');
    const r = await request(app)
      .get('/v1/indicators/thresholds/shift-analysis')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    // Has envelope shape (body.body.shifts is array), not single threshold
    expect(Array.isArray(r.body.body.shifts)).toBe(true);
    expect(r.body.body.shifts).toBeDefined();
  });

  test('M4.12 /drift sibling route still works', async () => {
    const { app } = makeShiftApp('admin');
    const r = await request(app)
      .get('/v1/indicators/thresholds/drift')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M4.14 /band-gap sibling route still works', async () => {
    const { app } = makeShiftApp('admin');
    const r = await request(app)
      .get('/v1/indicators/thresholds/band-gap')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
