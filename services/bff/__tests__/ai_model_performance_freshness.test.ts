// T6 M7.18 — AI model performance freshness rollup tests.

import request from 'supertest';
import {
  DEFAULT_PERF_FRESH_DAYS,
  DEFAULT_PERF_STALE_DAYS,
  ModelPerformanceFreshnessError,
  summarizeModelPerformanceFreshness,
  type PerfLookup,
} from '../src/ai_model_performance_freshness';
import type {
  ModelStatus,
  ModelType,
  ModelVersion,
} from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T19:00:00.000Z');
const H_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function modelVersion(
  overrides: Partial<ModelVersion> & {
    model_id: string;
    status?: ModelStatus;
    type?: ModelType;
  },
): ModelVersion {
  return {
    name: `Model ${overrides.model_id}`,
    version: '1.0.0',
    framework: 'xgboost',
    description: 'test',
    trained_at: NOW.toISOString(),
    deployed_at: NOW.toISOString(),
    retired_at: null,
    training_data_window_days: 30,
    key_features: [],
    metrics: { training_rows: 100, evaluated_at: NOW.toISOString(), auc: null, mae: null },
    ...overrides,
    type: overrides.type ?? 'pd',
    status: overrides.status ?? 'production',
  } as ModelVersion;
}

function buildLookup(
  map: Record<string, string | null>,
): PerfLookup {
  return (_tenant, model_id) => map[model_id] ?? null;
}

describe('summarizeModelPerformanceFreshness — validation', () => {
  test('rejects negative fresh_days', () => {
    expect(() =>
      summarizeModelPerformanceFreshness('BIL', [], buildLookup({}), NOW, -1, 60),
    ).toThrow(ModelPerformanceFreshnessError);
  });

  test('rejects non-integer fresh_days', () => {
    expect(() =>
      summarizeModelPerformanceFreshness('BIL', [], buildLookup({}), NOW, 14.5, 60),
    ).toThrow(ModelPerformanceFreshnessError);
  });

  test('rejects negative stale_days', () => {
    expect(() =>
      summarizeModelPerformanceFreshness('BIL', [], buildLookup({}), NOW, 14, -1),
    ).toThrow(ModelPerformanceFreshnessError);
  });

  test('rejects stale_days < fresh_days', () => {
    expect(() =>
      summarizeModelPerformanceFreshness('BIL', [], buildLookup({}), NOW, 60, 14),
    ).toThrow(ModelPerformanceFreshnessError);
  });

  test('accepts stale_days = fresh_days', () => {
    expect(() =>
      summarizeModelPerformanceFreshness('BIL', [], buildLookup({}), NOW, 14, 14),
    ).not.toThrow();
  });

  test('threshold constants exported', () => {
    expect(DEFAULT_PERF_FRESH_DAYS).toBe(14);
    expect(DEFAULT_PERF_STALE_DAYS).toBe(60);
  });
});

describe('summarizeModelPerformanceFreshness — empty input', () => {
  test('zero counts + empty production_models_without_perf', () => {
    const r = summarizeModelPerformanceFreshness('BIL', [], buildLookup({}), NOW);
    expect(r.total_models).toBe(0);
    expect(r.recent_count).toBe(0);
    expect(r.stable_count).toBe(0);
    expect(r.stale_count).toBe(0);
    expect(r.never_recorded_count).toBe(0);
    expect(r.models).toEqual([]);
    expect(r.production_models_without_perf).toEqual([]);
  });

  test('all 5 ModelStatus + 6 ModelType keys emitted at 0', () => {
    const r = summarizeModelPerformanceFreshness('BIL', [], buildLookup({}), NOW);
    expect(Object.keys(r.by_status)).toHaveLength(5);
    expect(Object.keys(r.by_type)).toHaveLength(6);
    for (const v of Object.values(r.by_status)) expect(v).toBe(0);
    for (const v of Object.values(r.by_type)) expect(v).toBe(0);
  });

  test('echoes thresholds', () => {
    const r = summarizeModelPerformanceFreshness('BIL', [], buildLookup({}), NOW, 7, 30);
    expect(r.fresh_days).toBe(7);
    expect(r.stale_days).toBe(30);
  });
});

describe('summarizeModelPerformanceFreshness — bucket classification', () => {
  test('recorded today → recent', () => {
    const r = summarizeModelPerformanceFreshness(
      'BIL',
      [modelVersion({ model_id: 'm-1' })],
      buildLookup({ 'm-1': NOW.toISOString() }),
      NOW,
    );
    expect(r.models[0].days_since_recorded).toBe(0);
    expect(r.models[0].freshness).toBe('recent');
    expect(r.recent_count).toBe(1);
  });

  test('recorded 30 days ago → stable (between 14 + 60)', () => {
    const thirtyDaysAgo = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
    const r = summarizeModelPerformanceFreshness(
      'BIL',
      [modelVersion({ model_id: 'm-1' })],
      buildLookup({ 'm-1': thirtyDaysAgo }),
      NOW,
    );
    expect(r.models[0].freshness).toBe('stable');
    expect(r.stable_count).toBe(1);
  });

  test('recorded 90 days ago → stale', () => {
    const ninetyDaysAgo = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    const r = summarizeModelPerformanceFreshness(
      'BIL',
      [modelVersion({ model_id: 'm-1' })],
      buildLookup({ 'm-1': ninetyDaysAgo }),
      NOW,
    );
    expect(r.models[0].freshness).toBe('stale');
    expect(r.stale_count).toBe(1);
  });

  test('never recorded → never_recorded', () => {
    const r = summarizeModelPerformanceFreshness(
      'BIL',
      [modelVersion({ model_id: 'm-1' })],
      buildLookup({ 'm-1': null }),
      NOW,
    );
    expect(r.models[0].freshness).toBe('never_recorded');
    expect(r.models[0].days_since_recorded).toBeNull();
    expect(r.models[0].last_recorded_at).toBeNull();
    expect(r.never_recorded_count).toBe(1);
  });

  test('boundary: exactly fresh_days → stable (strict-< on fresh)', () => {
    const fourteenDaysAgo = new Date(NOW.getTime() - 14 * 86_400_000).toISOString();
    const r = summarizeModelPerformanceFreshness(
      'BIL',
      [modelVersion({ model_id: 'm-1' })],
      buildLookup({ 'm-1': fourteenDaysAgo }),
      NOW,
    );
    expect(r.models[0].freshness).toBe('stable');
  });

  test('boundary: exactly stale_days → stable (strict-> on stale)', () => {
    const sixtyDaysAgo = new Date(NOW.getTime() - 60 * 86_400_000).toISOString();
    const r = summarizeModelPerformanceFreshness(
      'BIL',
      [modelVersion({ model_id: 'm-1' })],
      buildLookup({ 'm-1': sixtyDaysAgo }),
      NOW,
    );
    expect(r.models[0].freshness).toBe('stable');
  });

  test('Σ recent + stable + stale + never_recorded = total_models', () => {
    const recent = modelVersion({ model_id: 'm-recent' });
    const stable = modelVersion({ model_id: 'm-stable' });
    const stale = modelVersion({ model_id: 'm-stale' });
    const never = modelVersion({ model_id: 'm-never' });
    const r = summarizeModelPerformanceFreshness(
      'BIL',
      [recent, stable, stale, never],
      buildLookup({
        'm-recent': NOW.toISOString(),
        'm-stable': new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
        'm-stale': new Date(NOW.getTime() - 200 * 86_400_000).toISOString(),
        'm-never': null,
      }),
      NOW,
    );
    expect(r.total_models).toBe(4);
    expect(r.recent_count + r.stable_count + r.stale_count + r.never_recorded_count).toBe(4);
  });
});

describe('summarizeModelPerformanceFreshness — sort + leaderboards', () => {
  test('models sorted with never_recorded first, then oldest-recorded', () => {
    const recent = modelVersion({ model_id: 'recent' });
    const old = modelVersion({ model_id: 'old' });
    const middle = modelVersion({ model_id: 'middle' });
    const never = modelVersion({ model_id: 'never' });
    const r = summarizeModelPerformanceFreshness(
      'BIL',
      [recent, old, middle, never],
      buildLookup({
        recent: NOW.toISOString(),
        old: new Date(NOW.getTime() - 200 * 86_400_000).toISOString(),
        middle: new Date(NOW.getTime() - 50 * 86_400_000).toISOString(),
        never: null,
      }),
      NOW,
    );
    expect(r.models[0].model_id).toBe('never');
    expect(r.models[1].model_id).toBe('old');
    expect(r.models[2].model_id).toBe('middle');
    expect(r.models[3].model_id).toBe('recent');
  });

  test('model_id asc tie-break at tied days_since_recorded', () => {
    const ts = new Date(NOW.getTime() - 100 * 86_400_000).toISOString();
    const r = summarizeModelPerformanceFreshness(
      'BIL',
      [modelVersion({ model_id: 'zebra' }), modelVersion({ model_id: 'alpha' })],
      buildLookup({ zebra: ts, alpha: ts }),
      NOW,
    );
    expect(r.models[0].model_id).toBe('alpha');
    expect(r.models[1].model_id).toBe('zebra');
  });

  test('by_status marginals match Σ models', () => {
    const r = summarizeModelPerformanceFreshness(
      'BIL',
      [
        modelVersion({ model_id: 'm-1', status: 'production' }),
        modelVersion({ model_id: 'm-2', status: 'production' }),
        modelVersion({ model_id: 'm-3', status: 'staging' }),
      ],
      buildLookup({}),
      NOW,
    );
    expect(r.by_status.production).toBe(2);
    expect(r.by_status.staging).toBe(1);
    expect(r.by_status.shadow).toBe(0);
    const sum = Object.values(r.by_status).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.total_models);
  });

  test('by_type marginals match Σ models', () => {
    const r = summarizeModelPerformanceFreshness(
      'BIL',
      [
        modelVersion({ model_id: 'm-1', type: 'pd' }),
        modelVersion({ model_id: 'm-2', type: 'fraud' }),
        modelVersion({ model_id: 'm-3', type: 'fraud' }),
      ],
      buildLookup({}),
      NOW,
    );
    expect(r.by_type.pd).toBe(1);
    expect(r.by_type.fraud).toBe(2);
    const sum = Object.values(r.by_type).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.total_models);
  });

  test('production_models_without_perf filter (production + never_recorded)', () => {
    const r = summarizeModelPerformanceFreshness(
      'BIL',
      [
        modelVersion({ model_id: 'prod-A', status: 'production' }),
        modelVersion({ model_id: 'prod-B', status: 'production' }),
        modelVersion({ model_id: 'staging-A', status: 'staging' }),
      ],
      buildLookup({
        'prod-A': null,
        'prod-B': NOW.toISOString(), // recorded → not flagged
        'staging-A': null, // not production → not flagged
      }),
      NOW,
    );
    expect(r.production_models_without_perf).toEqual(['prod-A']);
  });

  test('production_models_without_perf sorted asc', () => {
    const r = summarizeModelPerformanceFreshness(
      'BIL',
      [
        modelVersion({ model_id: 'zebra', status: 'production' }),
        modelVersion({ model_id: 'alpha', status: 'production' }),
      ],
      buildLookup({}),
      NOW,
    );
    expect(r.production_models_without_perf).toEqual(['alpha', 'zebra']);
  });

  test('malformed ISO in lookup → treated as never_recorded', () => {
    const r = summarizeModelPerformanceFreshness(
      'BIL',
      [modelVersion({ model_id: 'm-1' })],
      buildLookup({ 'm-1': 'not-an-iso' }),
      NOW,
    );
    expect(r.models[0].freshness).toBe('never_recorded');
    expect(r.models[0].days_since_recorded).toBeNull();
  });
});

describe('summarizeModelPerformanceFreshness — custom thresholds', () => {
  test('tighter thresholds shift bucketing', () => {
    const tenDaysAgo = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
    // Default fresh=14 → 10 days → recent
    const def = summarizeModelPerformanceFreshness(
      'BIL',
      [modelVersion({ model_id: 'm-1' })],
      buildLookup({ 'm-1': tenDaysAgo }),
      NOW,
    );
    expect(def.models[0].freshness).toBe('recent');
    // Tighter fresh=7 → 10 days → stable
    const tight = summarizeModelPerformanceFreshness(
      'BIL',
      [modelVersion({ model_id: 'm-1' })],
      buildLookup({ 'm-1': tenDaysAgo }),
      NOW,
      7,
      30,
    );
    expect(tight.models[0].freshness).toBe('stable');
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

function makeRouteApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('GET /v1/ai/models/performance-freshness', () => {
  test('admin happy path with empty perf store', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app).get('/v1/ai/models/performance-freshness').set(H_BIL);
    expect(r.status).toBe(200);
    // Default registry has seed models — all should be never_recorded
    // since the perf store is empty.
    expect(r.body.body.total_models).toBeGreaterThan(0);
    expect(r.body.body.never_recorded_count).toBe(r.body.body.total_models);
    expect(r.body.body.fresh_days).toBe(14);
    expect(r.body.body.stale_days).toBe(60);
  });

  test('?fresh_days + ?stale_days reflected in envelope', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app)
      .get('/v1/ai/models/performance-freshness?fresh_days=7&stale_days=30')
      .set(H_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.fresh_days).toBe(7);
    expect(r.body.body.stale_days).toBe(30);
  });

  test('?fresh_days=-1 → 400 EWS_400_invalid_input', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app)
      .get('/v1/ai/models/performance-freshness?fresh_days=-1')
      .set(H_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('EWS_400_invalid_input');
  });

  test('?stale_days < fresh_days → 400', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app)
      .get('/v1/ai/models/performance-freshness?fresh_days=60&stale_days=30')
      .set(H_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRouteApp('field_officer');
    const r = await request(app).get('/v1/ai/models/performance-freshness').set(H_BIL);
    expect(r.status).toBe(403);
  });

  test('missing tenant header → 400', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app).get('/v1/ai/models/performance-freshness');
    expect(r.status).toBe(400);
  });

  test('production_models_without_perf surfaces seed models', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app).get('/v1/ai/models/performance-freshness').set(H_BIL);
    expect(r.status).toBe(200);
    // Seed registry has production models — all unrecorded → flagged.
    expect(Array.isArray(r.body.body.production_models_without_perf)).toBe(true);
    expect(r.body.body.production_models_without_perf.length).toBeGreaterThan(0);
  });
});
