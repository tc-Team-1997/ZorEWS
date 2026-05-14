// services/bff/__tests__/model_performance_trend.test.ts
//
// T6 M7.8 — Model performance metric trend.

import request from 'supertest';
import { computeMetricTrend } from '../src/model_performance_trend';
import {
  InMemoryModelPerformanceStore,
  type ModelPerformanceEntry,
} from '../src/model_performance';
import { defaultAiModelRegistry, SEED_MODELS } from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

let seq = 0;
function mkEntry(o: Partial<ModelPerformanceEntry> & {
  value: number;
  recorded_at: string;
}): ModelPerformanceEntry {
  seq += 1;
  return {
    entry_id: o.entry_id ?? `pe-${seq}`,
    tenant_id: o.tenant_id ?? 'BIL',
    model_id: o.model_id ?? 'm1',
    metric: o.metric ?? 'auc',
    value: o.value,
    sample_size: o.sample_size ?? 1000,
    notes: o.notes ?? '',
    recorded_at: o.recorded_at,
  };
}

beforeEach(() => {
  seq = 0;
});

// ─── computeMetricTrend — pure ───────────────────────────────────────

describe('M7.8 — computeMetricTrend — insufficient data', () => {
  test('zero entries → null', () => {
    expect(computeMetricTrend([], 'auc')).toBeNull();
  });

  test('single entry → trend with slope=null + sample_size=1', () => {
    const entries = [mkEntry({ value: 0.85, recorded_at: '2026-05-01T10:00:00Z' })];
    const t = computeMetricTrend(entries, 'auc')!;
    expect(t).not.toBeNull();
    expect(t.sample_size).toBe(1);
    expect(t.first_value).toBe(0.85);
    expect(t.last_value).toBe(0.85);
    expect(t.abs_change).toBe(0);
    expect(t.slope_per_day).toBeNull();
  });
});

describe('M7.8 — monotonic series', () => {
  test('strictly increasing → positive slope', () => {
    const entries = [
      mkEntry({ value: 0.70, recorded_at: '2026-05-01T10:00:00Z' }),
      mkEntry({ value: 0.75, recorded_at: '2026-05-02T10:00:00Z' }),
      mkEntry({ value: 0.80, recorded_at: '2026-05-03T10:00:00Z' }),
      mkEntry({ value: 0.85, recorded_at: '2026-05-04T10:00:00Z' }),
    ];
    const t = computeMetricTrend(entries, 'auc')!;
    expect(t.sample_size).toBe(4);
    expect(t.first_value).toBe(0.70);
    expect(t.last_value).toBe(0.85);
    expect(t.abs_change).toBeCloseTo(0.15, 5);
    expect(t.slope_per_day).toBeGreaterThan(0.04);
    expect(t.slope_per_day).toBeLessThan(0.06);
    expect(t.abs_change_pct).toBeCloseTo((0.15 / 0.70) * 100, 3);
  });

  test('strictly decreasing → negative slope', () => {
    const entries = [
      mkEntry({ value: 0.85, recorded_at: '2026-05-01T10:00:00Z' }),
      mkEntry({ value: 0.80, recorded_at: '2026-05-02T10:00:00Z' }),
      mkEntry({ value: 0.75, recorded_at: '2026-05-03T10:00:00Z' }),
      mkEntry({ value: 0.70, recorded_at: '2026-05-04T10:00:00Z' }),
    ];
    const t = computeMetricTrend(entries, 'auc')!;
    expect(t.slope_per_day).toBeLessThan(-0.04);
    expect(t.abs_change).toBeCloseTo(-0.15, 5);
  });
});

describe('M7.8 — flat series', () => {
  test('all-identical values → slope ≈ 0', () => {
    const entries = [
      mkEntry({ value: 0.80, recorded_at: '2026-05-01T10:00:00Z' }),
      mkEntry({ value: 0.80, recorded_at: '2026-05-02T10:00:00Z' }),
      mkEntry({ value: 0.80, recorded_at: '2026-05-03T10:00:00Z' }),
    ];
    const t = computeMetricTrend(entries, 'auc')!;
    expect(Math.abs(t.slope_per_day!)).toBeLessThan(1e-10);
    expect(t.abs_change).toBe(0);
    expect(t.abs_change_pct).toBe(0);
  });
});

describe('M7.8 — same-timestamp edge case', () => {
  test('all entries at the same timestamp → slope=null (no time progression)', () => {
    const sameTs = '2026-05-14T12:00:00Z';
    const entries = [
      mkEntry({ value: 0.80, recorded_at: sameTs }),
      mkEntry({ value: 0.85, recorded_at: sameTs }),
      mkEntry({ value: 0.90, recorded_at: sameTs }),
    ];
    const t = computeMetricTrend(entries, 'auc')!;
    expect(t.slope_per_day).toBeNull();
  });
});

describe('M7.8 — filter by metric', () => {
  test('only entries matching the requested metric contribute', () => {
    const entries = [
      mkEntry({ metric: 'auc', value: 0.85, recorded_at: '2026-05-01T10:00:00Z' }),
      mkEntry({ metric: 'auc', value: 0.86, recorded_at: '2026-05-02T10:00:00Z' }),
      mkEntry({ metric: 'precision', value: 0.50, recorded_at: '2026-05-01T10:00:00Z' }),
      mkEntry({ metric: 'precision', value: 0.55, recorded_at: '2026-05-02T10:00:00Z' }),
    ];
    const auc = computeMetricTrend(entries, 'auc')!;
    const prec = computeMetricTrend(entries, 'precision')!;
    expect(auc.sample_size).toBe(2);
    expect(prec.sample_size).toBe(2);
    expect(auc.first_value).toBe(0.85);
    expect(prec.first_value).toBe(0.50);
  });
});

describe('M7.8 — divide-by-zero on percent change', () => {
  test('first_value=0 → abs_change_pct is null', () => {
    const entries = [
      mkEntry({ value: 0.0, recorded_at: '2026-05-01T10:00:00Z' }),
      mkEntry({ value: 0.5, recorded_at: '2026-05-02T10:00:00Z' }),
    ];
    const t = computeMetricTrend(entries, 'auc')!;
    expect(t.abs_change_pct).toBeNull();
    expect(t.abs_change).toBe(0.5);
  });
});

describe('M7.8 — robust to unsorted input', () => {
  test('shuffled entries produce the same trend as sorted', () => {
    const sorted = [
      mkEntry({ value: 0.70, recorded_at: '2026-05-01T10:00:00Z' }),
      mkEntry({ value: 0.80, recorded_at: '2026-05-02T10:00:00Z' }),
      mkEntry({ value: 0.90, recorded_at: '2026-05-03T10:00:00Z' }),
    ];
    const shuffled = [sorted[2]!, sorted[0]!, sorted[1]!];
    const a = computeMetricTrend(sorted, 'auc')!;
    const b = computeMetricTrend(shuffled, 'auc')!;
    expect(a.slope_per_day).toBeCloseTo(b.slope_per_day!, 10);
    expect(a.first_value).toBe(b.first_value);
    expect(a.last_value).toBe(b.last_value);
  });
});

// ─── GET /v1/ai/models/:model_id/performance/trend ───────────────────

function makeTrendApp(role = 'admin') {
  const modelPerformanceStore = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    modelPerformanceStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, modelPerformanceStore };
}

describe('M7.8 — GET /v1/ai/models/:model_id/performance/trend', () => {
  test('unknown model → 404 unknown_model', async () => {
    const { app } = makeTrendApp('admin');
    const r = await request(app)
      .get('/v1/ai/models/not-a-real-model/performance/trend?metric=auc')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_model');
  });

  test('missing or invalid metric → 400 invalid_input', async () => {
    const { app } = makeTrendApp('admin');
    const known = SEED_MODELS[0]!;
    const r1 = await request(app)
      .get(`/v1/ai/models/${known.model_id}/performance/trend`)
      .set(TH_BIL);
    expect(r1.status).toBe(400);
    expect(r1.body.error.code).toBe('EWS_400_invalid_input');
    const r2 = await request(app)
      .get(`/v1/ai/models/${known.model_id}/performance/trend?metric=bogus`)
      .set(TH_BIL);
    expect(r2.status).toBe(400);
  });

  test('happy path: insufficient_data when no entries', async () => {
    const { app } = makeTrendApp('admin');
    const known = SEED_MODELS[0]!;
    const r = await request(app)
      .get(`/v1/ai/models/${known.model_id}/performance/trend?metric=auc`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.trend).toBeNull();
  });

  test('happy path: entries produce a trend', async () => {
    const { app, modelPerformanceStore } = makeTrendApp('admin');
    const known = SEED_MODELS[0]!;
    modelPerformanceStore.record('BIL', known.model_id, { metric: 'auc', value: 0.70, sample_size: 1000 }, new Date('2026-05-01T10:00:00Z'));
    modelPerformanceStore.record('BIL', known.model_id, { metric: 'auc', value: 0.80, sample_size: 1000 }, new Date('2026-05-02T10:00:00Z'));
    modelPerformanceStore.record('BIL', known.model_id, { metric: 'auc', value: 0.85, sample_size: 1000 }, new Date('2026-05-03T10:00:00Z'));
    const r = await request(app)
      .get(`/v1/ai/models/${known.model_id}/performance/trend?metric=auc`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.trend.sample_size).toBe(3);
    expect(r.body.body.trend.slope_per_day).toBeGreaterThan(0);
    expect(r.body.body.trend.first_value).toBeCloseTo(0.70, 5);
    expect(r.body.body.trend.last_value).toBeCloseTo(0.85, 5);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTrendApp('readonly');
    const known = SEED_MODELS[0]!;
    const r = await request(app)
      .get(`/v1/ai/models/${known.model_id}/performance/trend?metric=auc`)
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL entries invisible to BANK_DEMO', async () => {
    const { app, modelPerformanceStore } = makeTrendApp('admin');
    const known = SEED_MODELS[0]!;
    modelPerformanceStore.record('BIL', known.model_id, { metric: 'auc', value: 0.85, sample_size: 100 }, new Date('2026-05-01T10:00:00Z'));
    modelPerformanceStore.record('BIL', known.model_id, { metric: 'auc', value: 0.90, sample_size: 100 }, new Date('2026-05-02T10:00:00Z'));
    const r = await request(app)
      .get(`/v1/ai/models/${known.model_id}/performance/trend?metric=auc`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.trend).toBeNull();
  });
});
