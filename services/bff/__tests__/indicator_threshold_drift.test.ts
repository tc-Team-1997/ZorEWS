// services/bff/__tests__/indicator_threshold_drift.test.ts
//
// T6 M4.12 — Indicator threshold drift analytics.

import request from 'supertest';
import { buildIndicatorThresholdDrift } from '../src/indicator_threshold_drift';
import {
  InMemoryThresholdOverrideStore,
  getThreshold,
} from '../src/indicator_thresholds';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── buildIndicatorThresholdDrift — pure ─────────────────────────────

describe('M4.12 — empty store', () => {
  test('no overrides → empty summary', () => {
    const store = new InMemoryThresholdOverrideStore();
    const s = buildIndicatorThresholdDrift(store, 'BIL', NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.total_overrides).toBe(0);
    expect(s.total_with_drift).toBe(0);
    expect(s.total_zero_drift).toBe(0);
    expect(s.mean_drift_score).toBeNull();
    expect(s.most_drifted_indicator).toBeNull();
    expect(s.indicators).toEqual([]);
  });
});

describe('M4.12 — single override with non-zero drift', () => {
  test('drift_score = mean of |delta_rel| across bands', () => {
    const store = new InMemoryThresholdOverrideStore();
    const lib = getThreshold('FIN-001')!;
    // Library: yellow 0.30, orange 0.55, red 0.80
    // Override: yellow 0.15 (50% lower), orange 0.55 (no change), red 0.80 (no change)
    store.setOverride('BIL', 'FIN-001', {
      ...lib,
      yellow_at: 0.15,
    });
    const s = buildIndicatorThresholdDrift(store, 'BIL', NOW);
    expect(s.total_overrides).toBe(1);
    const row = s.indicators[0]!;
    expect(row.indicator_id).toBe('FIN-001');
    // yellow: |(0.15 - 0.30)| / 0.30 = 0.5
    expect(row.yellow.delta_rel).toBeCloseTo(0.5);
    // orange + red: 0
    expect(row.orange.delta_rel).toBeCloseTo(0);
    expect(row.red.delta_rel).toBeCloseTo(0);
    // drift_score = mean(0.5, 0, 0) = ~0.1667
    expect(row.drift_score).toBeCloseTo(0.5 / 3);
  });
});

describe('M4.12 — peak_band tracking', () => {
  test('peak_band = band with highest |delta_rel|', () => {
    const store = new InMemoryThresholdOverrideStore();
    const lib = getThreshold('FIN-001')!;
    // yellow 0.30 → 0.21 (30% drop = 0.3 rel)
    // orange 0.55 → 0.55 (no change)
    // red 0.80 → 0.64 (20% drop = 0.2 rel)
    store.setOverride('BIL', 'FIN-001', {
      ...lib,
      yellow_at: 0.21,
      red_at: 0.64,
    });
    const s = buildIndicatorThresholdDrift(store, 'BIL', NOW);
    const row = s.indicators[0]!;
    expect(row.peak_band).toBe('yellow');
    expect(row.peak_band_drift).toBeCloseTo(0.3, 3);
  });
});

describe('M4.12 — multiple overrides sorted by drift_score desc', () => {
  test('high-drift overrides float to the top', () => {
    const store = new InMemoryThresholdOverrideStore();
    const fin1 = getThreshold('FIN-001')!;
    const fin2 = getThreshold('FIN-002')!;
    // FIN-001: small change (5%)
    store.setOverride('BIL', 'FIN-001', { ...fin1, yellow_at: fin1.yellow_at * 0.95 });
    // FIN-002: big change (40%)
    store.setOverride('BIL', 'FIN-002', { ...fin2, yellow_at: fin2.yellow_at * 0.6 });
    const s = buildIndicatorThresholdDrift(store, 'BIL', NOW);
    expect(s.total_overrides).toBe(2);
    expect(s.indicators[0]!.indicator_id).toBe('FIN-002');
    expect(s.indicators[1]!.indicator_id).toBe('FIN-001');
  });
});

describe('M4.12 — total_with_drift / total_zero_drift split', () => {
  test('zero-drift override counts separately', () => {
    const store = new InMemoryThresholdOverrideStore();
    const fin1 = getThreshold('FIN-001')!;
    const fin2 = getThreshold('FIN-002')!;
    // FIN-001: changed
    store.setOverride('BIL', 'FIN-001', { ...fin1, yellow_at: fin1.yellow_at * 0.5 });
    // FIN-002: override matches default exactly → zero drift
    store.setOverride('BIL', 'FIN-002', { ...fin2 });
    const s = buildIndicatorThresholdDrift(store, 'BIL', NOW);
    expect(s.total_overrides).toBe(2);
    expect(s.total_with_drift).toBe(1);
    expect(s.total_zero_drift).toBe(1);
  });
});

describe('M4.12 — mean_drift_score', () => {
  test('aggregate mean across non-null drift_scores', () => {
    const store = new InMemoryThresholdOverrideStore();
    const fin1 = getThreshold('FIN-001')!;
    const fin2 = getThreshold('FIN-002')!;
    store.setOverride('BIL', 'FIN-001', { ...fin1, yellow_at: fin1.yellow_at * 0.5 });
    store.setOverride('BIL', 'FIN-002', { ...fin2, yellow_at: fin2.yellow_at * 0.5 });
    const s = buildIndicatorThresholdDrift(store, 'BIL', NOW);
    expect(s.mean_drift_score).not.toBeNull();
    const row1 = s.indicators.find((r) => r.indicator_id === 'FIN-001')!;
    const row2 = s.indicators.find((r) => r.indicator_id === 'FIN-002')!;
    const expected = (row1.drift_score! + row2.drift_score!) / 2;
    expect(s.mean_drift_score).toBeCloseTo(expected);
  });
});

describe('M4.12 — most_drifted_indicator', () => {
  test('points at highest drift_score', () => {
    const store = new InMemoryThresholdOverrideStore();
    const fin1 = getThreshold('FIN-001')!;
    const fin2 = getThreshold('FIN-002')!;
    store.setOverride('BIL', 'FIN-001', { ...fin1, yellow_at: fin1.yellow_at * 0.95 });
    store.setOverride('BIL', 'FIN-002', { ...fin2, yellow_at: fin2.yellow_at * 0.5 });
    const s = buildIndicatorThresholdDrift(store, 'BIL', NOW);
    expect(s.most_drifted_indicator!.indicator_id).toBe('FIN-002');
  });

  test('null when no overrides', () => {
    const store = new InMemoryThresholdOverrideStore();
    const s = buildIndicatorThresholdDrift(store, 'BIL', NOW);
    expect(s.most_drifted_indicator).toBeNull();
  });
});

describe('M4.12 — band_delta arithmetic', () => {
  test('delta_abs is signed (effective - default)', () => {
    const store = new InMemoryThresholdOverrideStore();
    const lib = getThreshold('FIN-001')!;
    store.setOverride('BIL', 'FIN-001', { ...lib, yellow_at: lib.yellow_at + 0.1 });
    const s = buildIndicatorThresholdDrift(store, 'BIL', NOW);
    expect(s.indicators[0]!.yellow.delta_abs).toBeCloseTo(0.1);
    expect(s.indicators[0]!.yellow.default_value).toBe(lib.yellow_at);
    expect(s.indicators[0]!.yellow.effective_value).toBeCloseTo(lib.yellow_at + 0.1);
  });
});

describe('M4.12 — cross-tenant isolation', () => {
  test('BIL overrides invisible to BANK_DEMO', () => {
    const store = new InMemoryThresholdOverrideStore();
    const lib = getThreshold('FIN-001')!;
    store.setOverride('BIL', 'FIN-001', { ...lib, yellow_at: lib.yellow_at * 0.5 });
    const bank = buildIndicatorThresholdDrift(store, 'BANK_DEMO', NOW);
    expect(bank.total_overrides).toBe(0);
  });
});

describe('M4.12 — indicator name + vertical preserved from override', () => {
  test('row carries name + vertical fields', () => {
    const store = new InMemoryThresholdOverrideStore();
    const lib = getThreshold('FIN-001')!;
    store.setOverride('BIL', 'FIN-001', { ...lib, yellow_at: lib.yellow_at * 0.5 });
    const s = buildIndicatorThresholdDrift(store, 'BIL', NOW);
    expect(s.indicators[0]!.name).toBe(lib.name);
    expect(s.indicators[0]!.vertical).toBe(lib.vertical);
  });
});

// ─── GET /v1/indicators/thresholds/drift ─────────────────────────────

function makeDriftApp(role = 'admin') {
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

describe('M4.12 — GET /v1/indicators/thresholds/drift', () => {
  test('admin → 200 with empty summary for fresh tenant', async () => {
    const { app } = makeDriftApp('admin');
    const r = await request(app).get('/v1/indicators/thresholds/drift').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(0);
    expect(r.body.body.indicators).toEqual([]);
  });

  test('populated summary reflects override', async () => {
    const { app, thresholdOverrideStore } = makeDriftApp('admin');
    const lib = getThreshold('FIN-001')!;
    thresholdOverrideStore.setOverride('BIL', 'FIN-001', { ...lib, yellow_at: lib.yellow_at * 0.5 });
    const r = await request(app).get('/v1/indicators/thresholds/drift').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(1);
    expect(r.body.body.most_drifted_indicator.indicator_id).toBe('FIN-001');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeDriftApp('case_owner');
    const r = await request(app).get('/v1/indicators/thresholds/drift').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL overrides invisible to BANK_DEMO via route', async () => {
    const { app, thresholdOverrideStore } = makeDriftApp('admin');
    const lib = getThreshold('FIN-001')!;
    thresholdOverrideStore.setOverride('BIL', 'FIN-001', { ...lib, yellow_at: lib.yellow_at * 0.5 });
    const bank = await request(app)
      .get('/v1/indicators/thresholds/drift')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_overrides).toBe(0);
  });

  test('M4.9 /v1/indicators/thresholds/effective still works (sibling)', async () => {
    const { app } = makeDriftApp('admin');
    const r = await request(app).get('/v1/indicators/thresholds/effective').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
