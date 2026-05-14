// services/bff/__tests__/model_performance_outliers.test.ts
//
// T6 M7.7 — Model performance outlier detection.

import request from 'supertest';
import {
  DEFAULT_Z_THRESHOLD,
  MAX_Z_THRESHOLD,
  MIN_Z_THRESHOLD,
  detectPerformanceOutliers,
} from '../src/model_performance_outliers';
import {
  InMemoryModelPerformanceStore,
  type ModelPerformanceEntry,
  type PerformanceMetric,
} from '../src/model_performance';
import { defaultAiModelRegistry } from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

let seq = 0;
function mkEntry(o: {
  metric: PerformanceMetric;
  value: number;
  recorded_at?: string;
}): ModelPerformanceEntry {
  seq += 1;
  return {
    entry_id: `mpe-${seq}`,
    tenant_id: 'BIL',
    model_id: 'pd_xgb_v3',
    metric: o.metric,
    value: o.value,
    sample_size: 1000,
    notes: '',
    recorded_at: o.recorded_at ?? NOW.toISOString(),
  };
}

beforeEach(() => {
  seq = 0;
});

// ─── detectPerformanceOutliers — pure ────────────────────────────────

describe('M7.7 — detectPerformanceOutliers — empty + edge cases', () => {
  test('empty entries → zero envelope', () => {
    const out = detectPerformanceOutliers([]);
    expect(out.total_entries).toBe(0);
    expect(out.per_metric).toEqual([]);
    expect(out.total_outlier_count).toBe(0);
    expect(out.z_threshold).toBe(DEFAULT_Z_THRESHOLD);
  });

  test('single entry → mean set, std_dev null, no outliers', () => {
    const out = detectPerformanceOutliers([mkEntry({ metric: 'precision', value: 0.85 })]);
    expect(out.per_metric.length).toBe(1);
    expect(out.per_metric[0]!.sample_count).toBe(1);
    expect(out.per_metric[0]!.mean).toBe(0.85);
    expect(out.per_metric[0]!.std_dev).toBeNull();
    expect(out.per_metric[0]!.outliers).toEqual([]);
  });

  test('all-same values → std_dev=0, no outliers', () => {
    const entries = [
      mkEntry({ metric: 'precision', value: 0.85 }),
      mkEntry({ metric: 'precision', value: 0.85 }),
      mkEntry({ metric: 'precision', value: 0.85 }),
    ];
    const out = detectPerformanceOutliers(entries);
    expect(out.per_metric[0]!.std_dev).toBe(0);
    expect(out.per_metric[0]!.outliers).toEqual([]);
  });
});

describe('M7.7 — z-score detection', () => {
  test('value far above mean flagged as direction=high', () => {
    // 12 tight baseline values + 1 extreme outlier → outlier z > 2 even
    // after the outlier inflates std_dev.
    const entries = [
      ...Array.from({ length: 12 }, (_, i) =>
        mkEntry({
          metric: 'precision',
          value: 0.70 + (i % 3) * 0.005,
          recorded_at: `2026-05-14T${String(8 + i).padStart(2, '0')}:00:00.000Z`,
        }),
      ),
      mkEntry({ metric: 'precision', value: 1.5, recorded_at: '2026-05-14T22:00:00.000Z' }),
    ];
    const out = detectPerformanceOutliers(entries, 2);
    expect(out.total_outlier_count).toBe(1);
    expect(out.per_metric[0]!.outliers[0]!.value).toBe(1.5);
    expect(out.per_metric[0]!.outliers[0]!.direction).toBe('high');
    expect(out.per_metric[0]!.outliers[0]!.z_score).toBeGreaterThan(2);
  });

  test('value far below mean flagged as direction=low', () => {
    const entries = [
      ...Array.from({ length: 12 }, (_, i) =>
        mkEntry({
          metric: 'auc',
          value: 0.85 + (i % 3) * 0.005,
          recorded_at: `2026-05-14T${String(8 + i).padStart(2, '0')}:00:00.000Z`,
        }),
      ),
      mkEntry({ metric: 'auc', value: 0.30, recorded_at: '2026-05-14T22:00:00.000Z' }),
    ];
    const out = detectPerformanceOutliers(entries, 2);
    expect(out.per_metric[0]!.outliers[0]!.direction).toBe('low');
    expect(out.per_metric[0]!.outliers[0]!.z_score).toBeLessThan(-2);
  });

  test('value within threshold is NOT flagged', () => {
    const entries = [
      mkEntry({ metric: 'precision', value: 0.80 }),
      mkEntry({ metric: 'precision', value: 0.82 }),
      mkEntry({ metric: 'precision', value: 0.84 }),
      mkEntry({ metric: 'precision', value: 0.86 }),
      mkEntry({ metric: 'precision', value: 0.88 }),
      mkEntry({ metric: 'precision', value: 0.90 }),
    ];
    const out = detectPerformanceOutliers(entries, 2);
    expect(out.total_outlier_count).toBe(0);
  });

  test('outliers sorted newest-first by recorded_at', () => {
    const entries = [
      // 15 tight baseline values around 0.85 (mostly identical for low std)
      ...Array.from({ length: 15 }, (_, i) =>
        mkEntry({
          metric: 'recall',
          value: 0.85,
          recorded_at: `2026-05-14T${String(8 + i).padStart(2, '0')}:00:00.000Z`,
        }),
      ),
      // 2 outliers at different times — same value, both should be flagged
      mkEntry({ metric: 'recall', value: 0.30, recorded_at: '2026-05-14T03:00:00.000Z' }),
      mkEntry({ metric: 'recall', value: 0.30, recorded_at: '2026-05-14T23:00:00.000Z' }),
    ];
    const out = detectPerformanceOutliers(entries, 2);
    expect(out.per_metric[0]!.outliers.length).toBe(2);
    expect(out.per_metric[0]!.outliers[0]!.recorded_at).toBe('2026-05-14T23:00:00.000Z');
    expect(out.per_metric[0]!.outliers[1]!.recorded_at).toBe('2026-05-14T03:00:00.000Z');
  });
});

describe('M7.7 — multi-metric independence', () => {
  test('each metric computed independently', () => {
    const entries = [
      // Precision: identical values → std_dev=0 → no outliers possible.
      ...Array.from({ length: 12 }, () => mkEntry({ metric: 'precision', value: 0.85 })),
      // Drift score: 12 baseline at 0.01 + 1 large outlier.
      ...Array.from({ length: 12 }, () => mkEntry({ metric: 'drift_score', value: 0.01 })),
      mkEntry({ metric: 'drift_score', value: 0.50 }),
    ];
    const out = detectPerformanceOutliers(entries, 2);
    const precision = out.per_metric.find((p) => p.metric === 'precision')!;
    const drift = out.per_metric.find((p) => p.metric === 'drift_score')!;
    // Precision is all-identical → std_dev ≈ 0 (floating-point noise
    // produces a tiny non-zero result, but well below any threshold).
    expect(precision.std_dev!).toBeLessThan(1e-10);
    expect(precision.outliers).toEqual([]);
    // Drift score: one entry at 0.50 is the only outlier.
    expect(drift.outliers.length).toBe(1);
    expect(drift.outliers[0]!.value).toBe(0.50);
  });

  test('metric absent from entries does NOT appear in per_metric', () => {
    const entries = [mkEntry({ metric: 'precision', value: 0.85 })];
    const out = detectPerformanceOutliers(entries);
    expect(out.per_metric.map((p) => p.metric)).toEqual(['precision']);
  });
});

describe('M7.7 — z_threshold tuning', () => {
  test('tighter z=1 flags more values than default z=2', () => {
    const entries = [
      mkEntry({ metric: 'precision', value: 0.80 }),
      mkEntry({ metric: 'precision', value: 0.82 }),
      mkEntry({ metric: 'precision', value: 0.84 }),
      mkEntry({ metric: 'precision', value: 0.86 }),
      mkEntry({ metric: 'precision', value: 0.88 }),
      mkEntry({ metric: 'precision', value: 0.90 }), // ±1σ at the tail
    ];
    const z2 = detectPerformanceOutliers(entries, 2).total_outlier_count;
    const z1 = detectPerformanceOutliers(entries, 1).total_outlier_count;
    expect(z1).toBeGreaterThanOrEqual(z2);
  });

  test('non-positive z falls back to default', () => {
    const entries = [
      mkEntry({ metric: 'precision', value: 0.85 }),
      mkEntry({ metric: 'precision', value: 0.86 }),
    ];
    expect(detectPerformanceOutliers(entries, 0).z_threshold).toBe(DEFAULT_Z_THRESHOLD);
    expect(detectPerformanceOutliers(entries, -1).z_threshold).toBe(DEFAULT_Z_THRESHOLD);
  });

  test('z below MIN clamps up', () => {
    const entries = [mkEntry({ metric: 'precision', value: 0.85 })];
    expect(detectPerformanceOutliers(entries, 0.1).z_threshold).toBe(MIN_Z_THRESHOLD);
  });

  test('z above MAX clamps down', () => {
    const entries = [mkEntry({ metric: 'precision', value: 0.85 })];
    expect(detectPerformanceOutliers(entries, 99).z_threshold).toBe(MAX_Z_THRESHOLD);
  });
});

// ─── GET /v1/ai/models/:model_id/performance/outliers ────────────────

function makeOutliersApp(role = 'admin') {
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

describe('M7.7 — GET /v1/ai/models/:model_id/performance/outliers', () => {
  test('empty ledger → 200 zero envelope', async () => {
    const { app } = makeOutliersApp('admin');
    const r = await request(app)
      .get('/v1/ai/models/pd_xgb_v3/performance/outliers')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_entries).toBe(0);
    expect(r.body.body.z_threshold).toBe(DEFAULT_Z_THRESHOLD);
  });

  test('after recording outlier-shaped data, route detects it', async () => {
    const { app, modelPerformanceStore } = makeOutliersApp('admin');
    for (let i = 0; i < 5; i++) {
      modelPerformanceStore.record(
        'BIL',
        'pd_xgb_v3',
        { metric: 'precision', value: 0.85 + i * 0.005, sample_size: 100 },
        new Date(NOW.getTime() + i * 60000),
      );
    }
    // Outlier
    modelPerformanceStore.record(
      'BIL',
      'pd_xgb_v3',
      { metric: 'precision', value: 0.30, sample_size: 100 },
      new Date(NOW.getTime() + 6 * 60000),
    );
    const r = await request(app)
      .get('/v1/ai/models/pd_xgb_v3/performance/outliers?z=2')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_outlier_count).toBe(1);
    expect(r.body.body.per_metric[0].outliers[0].direction).toBe('low');
  });

  test('?z=invalid → 400', async () => {
    const { app } = makeOutliersApp('admin');
    const r = await request(app)
      .get('/v1/ai/models/pd_xgb_v3/performance/outliers?z=abc')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('unknown model → 404', async () => {
    const { app } = makeOutliersApp('admin');
    const r = await request(app)
      .get('/v1/ai/models/no_such_model/performance/outliers')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_model');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeOutliersApp('case_owner');
    const r = await request(app)
      .get('/v1/ai/models/pd_xgb_v3/performance/outliers')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M7.5 /summary still works (outliers route is additive)', async () => {
    const { app } = makeOutliersApp('admin');
    const r = await request(app)
      .get('/v1/ai/models/pd_xgb_v3/performance/summary')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
