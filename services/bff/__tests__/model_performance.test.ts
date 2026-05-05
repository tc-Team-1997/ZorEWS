// services/bff/__tests__/model_performance.test.ts
//
// T6 M7.5 — Model performance ledger.

import request from 'supertest';
import {
  InMemoryModelPerformanceStore,
  MODEL_PERFORMANCE_CAP,
  ModelPerformanceError,
  PERFORMANCE_METRICS,
  isPerformanceMetric,
  summarizePerformance,
} from '../src/model_performance';
import { defaultAiModelRegistry } from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T20:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// One of the models in the M7.1 registry per server.ts:
const MODEL = 'fraud_lgb_v1';

const VALID = {
  metric: 'precision' as const,
  value: 0.85,
  sample_size: 1000,
  notes: 'monthly recalibration',
};

function makePerfApp(role = 'admin') {
  const store = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    modelPerformanceStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

// ─── Type guards / catalog ────────────────────────────────────────────

describe('M7.5 — PERFORMANCE_METRICS guard', () => {
  test('every metric value is recognised', () => {
    for (const m of PERFORMANCE_METRICS) expect(isPerformanceMetric(m)).toBe(true);
  });

  test('rejects unknown metrics', () => {
    expect(isPerformanceMetric('f1')).toBe(false);
    expect(isPerformanceMetric('')).toBe(false);
    expect(isPerformanceMetric(null)).toBe(false);
  });
});

// ─── Store ────────────────────────────────────────────────────────────

describe('InMemoryModelPerformanceStore', () => {
  test('record returns entry with id + recorded_at', () => {
    const s = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
    const e = s.record('BIL', MODEL, VALID, NOW);
    expect(e.entry_id).toMatch(/^mpe-/);
    expect(e.tenant_id).toBe('BIL');
    expect(e.model_id).toBe(MODEL);
    expect(e.metric).toBe('precision');
    expect(e.value).toBe(0.85);
    expect(e.recorded_at).toBe(NOW.toISOString());
  });

  test('rejects unknown model_id', () => {
    const s = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
    try {
      s.record('BIL', 'no-such-model', VALID, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ModelPerformanceError).code).toBe('unknown_model');
    }
  });

  test('rejects bad metric', () => {
    const s = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
    expect(() => s.record('BIL', MODEL, { ...VALID, metric: 'f1' as never }, NOW)).toThrow(
      /metric/,
    );
  });

  test('rejects out-of-range value', () => {
    const s = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
    expect(() => s.record('BIL', MODEL, { ...VALID, value: 5 }, NOW)).toThrow(/value/);
    expect(() => s.record('BIL', MODEL, { ...VALID, value: -10 }, NOW)).toThrow(/value/);
  });

  test('rejects non-positive sample_size', () => {
    const s = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
    expect(() => s.record('BIL', MODEL, { ...VALID, sample_size: 0 }, NOW)).toThrow(
      /sample_size/,
    );
    expect(() => s.record('BIL', MODEL, { ...VALID, sample_size: -1 }, NOW)).toThrow(
      /sample_size/,
    );
    expect(() => s.record('BIL', MODEL, { ...VALID, sample_size: 1.5 }, NOW)).toThrow(
      /sample_size/,
    );
  });

  test('rejects notes > 500 chars', () => {
    const s = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
    expect(() =>
      s.record('BIL', MODEL, { ...VALID, notes: 'x'.repeat(501) }, NOW),
    ).toThrow(/notes/);
  });

  test('FIFO retention at cap', () => {
    const s = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
    for (let i = 0; i < MODEL_PERFORMANCE_CAP + 5; i++) {
      s.record(
        'BIL',
        MODEL,
        { ...VALID, value: i / 1000 },
        new Date(NOW.getTime() + i * 60_000),
      );
    }
    const items = s.list('BIL', MODEL, {});
    expect(items).toHaveLength(MODEL_PERFORMANCE_CAP);
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
    s.record('BIL', MODEL, VALID, NOW);
    expect(s.list('BIL', MODEL, {})).toHaveLength(1);
    expect(s.list('BANK_DEMO', MODEL, {})).toEqual([]);
  });

  test('cross-model isolation within a tenant', () => {
    const s = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
    s.record('BIL', MODEL, VALID, NOW);
    s.record('BIL', 'churn_xgb_v1', VALID, NOW);
    expect(s.list('BIL', MODEL, {})).toHaveLength(1);
    expect(s.list('BIL', 'churn_xgb_v1', {})).toHaveLength(1);
  });

  test('list filter: metric scopes results', () => {
    const s = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
    s.record('BIL', MODEL, { ...VALID, metric: 'precision' }, NOW);
    s.record('BIL', MODEL, { ...VALID, metric: 'recall' }, NOW);
    s.record('BIL', MODEL, { ...VALID, metric: 'auc' }, NOW);
    expect(s.list('BIL', MODEL, { metric: 'precision' })).toHaveLength(1);
    expect(s.list('BIL', MODEL, { metric: 'recall' })).toHaveLength(1);
  });

  test('list filter: since/until window', () => {
    const s = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
    s.record('BIL', MODEL, VALID, new Date('2026-05-01T00:00:00Z'));
    s.record('BIL', MODEL, VALID, new Date('2026-05-03T00:00:00Z'));
    s.record('BIL', MODEL, VALID, new Date('2026-05-05T00:00:00Z'));
    expect(s.list('BIL', MODEL, { since: '2026-05-02T00:00:00Z' })).toHaveLength(2);
    expect(s.list('BIL', MODEL, { until: '2026-05-04T00:00:00Z' })).toHaveLength(2);
    expect(
      s.list('BIL', MODEL, {
        since: '2026-05-02T00:00:00Z',
        until: '2026-05-04T00:00:00Z',
      }),
    ).toHaveLength(1);
  });

  test('record returns defensive copy', () => {
    const s = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
    const e = s.record('BIL', MODEL, VALID, NOW);
    e.notes = 'TAMPERED';
    expect(s.list('BIL', MODEL, {})[0]!.notes).toBe('monthly recalibration');
  });
});

// ─── summarizePerformance ─────────────────────────────────────────────

describe('M7.5 — summarizePerformance', () => {
  test('empty entries → all metrics null, sample_size 0', () => {
    const s = summarizePerformance('BIL', MODEL, []);
    expect(s.sample_size).toBe(0);
    for (const m of PERFORMANCE_METRICS) expect(s.metrics[m]).toBeNull();
  });

  test('single entry: metric block populated, latest = that entry', () => {
    const s = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
    const e = s.record('BIL', MODEL, VALID, NOW);
    const summary = summarizePerformance('BIL', MODEL, [e]);
    expect(summary.metrics.precision).not.toBeNull();
    expect(summary.metrics.precision!.latest_value).toBe(0.85);
    expect(summary.metrics.precision!.latest_at).toBe(NOW.toISOString());
    expect(summary.metrics.precision!.sample_count).toBe(1);
    expect(summary.metrics.precision!.mean).toBe(0.85);
  });

  test('multiple entries per metric: latest by recorded_at, mean correct', () => {
    const s = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
    s.record('BIL', MODEL, { ...VALID, value: 0.7 }, new Date('2026-05-01T00:00:00Z'));
    s.record('BIL', MODEL, { ...VALID, value: 0.8 }, new Date('2026-05-03T00:00:00Z'));
    s.record('BIL', MODEL, { ...VALID, value: 0.9 }, new Date('2026-05-05T00:00:00Z'));
    const entries = s.list('BIL', MODEL, {});
    const summary = summarizePerformance('BIL', MODEL, entries);
    expect(summary.metrics.precision!.latest_value).toBe(0.9);
    expect(summary.metrics.precision!.latest_at).toBe('2026-05-05T00:00:00.000Z');
    expect(summary.metrics.precision!.mean).toBeCloseTo(0.8, 5);
    expect(summary.metrics.precision!.min).toBe(0.7);
    expect(summary.metrics.precision!.max).toBe(0.9);
    expect(summary.metrics.precision!.p50).toBe(0.8);
  });

  test('different metrics are bucketed independently', () => {
    const s = new InMemoryModelPerformanceStore(defaultAiModelRegistry);
    s.record('BIL', MODEL, { ...VALID, metric: 'precision', value: 0.9 }, NOW);
    s.record('BIL', MODEL, { ...VALID, metric: 'recall', value: 0.7 }, NOW);
    const entries = s.list('BIL', MODEL, {});
    const summary = summarizePerformance('BIL', MODEL, entries);
    expect(summary.metrics.precision!.latest_value).toBe(0.9);
    expect(summary.metrics.recall!.latest_value).toBe(0.7);
    expect(summary.metrics.auc).toBeNull();
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('M7.5 — POST /v1/ai/models/:model_id/performance', () => {
  test('happy: 201 with entry', async () => {
    const { app } = makePerfApp('admin');
    const r = await request(app)
      .post(`/v1/ai/models/${MODEL}/performance`)
      .set(TH_BIL)
      .send(VALID);
    expect(r.status).toBe(201);
    expect(r.body.body.entry_id).toMatch(/^mpe-/);
    expect(r.body.body.metric).toBe('precision');
  });

  test('unknown model → 404', async () => {
    const { app } = makePerfApp('admin');
    const r = await request(app)
      .post('/v1/ai/models/no-such-model/performance')
      .set(TH_BIL)
      .send(VALID);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_model');
  });

  test('bad metric → 400', async () => {
    const { app } = makePerfApp('admin');
    const r = await request(app)
      .post(`/v1/ai/models/${MODEL}/performance`)
      .set(TH_BIL)
      .send({ ...VALID, metric: 'f1' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('out-of-range value → 400', async () => {
    const { app } = makePerfApp('admin');
    const r = await request(app)
      .post(`/v1/ai/models/${MODEL}/performance`)
      .set(TH_BIL)
      .send({ ...VALID, value: 99 });
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makePerfApp('case_owner');
    const r = await request(app)
      .post(`/v1/ai/models/${MODEL}/performance`)
      .set(TH_BIL)
      .send(VALID);
    expect(r.status).toBe(403);
  });
});

describe('M7.5 — GET /v1/ai/models/:model_id/performance', () => {
  test('lists with newest-first ordering', async () => {
    const { app, store } = makePerfApp('admin');
    store.record('BIL', MODEL, VALID, new Date('2026-05-01T00:00:00Z'));
    store.record('BIL', MODEL, VALID, new Date('2026-05-03T00:00:00Z'));
    store.record('BIL', MODEL, VALID, new Date('2026-05-05T00:00:00Z'));
    const r = await request(app)
      .get(`/v1/ai/models/${MODEL}/performance`)
      .set(TH_BIL);
    expect(r.body.body.total).toBe(3);
    expect(r.body.body.items.map((e: { recorded_at: string }) => e.recorded_at)).toEqual([
      '2026-05-05T00:00:00.000Z',
      '2026-05-03T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
    ]);
  });

  test('?metric=precision filter', async () => {
    const { app, store } = makePerfApp('admin');
    store.record('BIL', MODEL, { ...VALID, metric: 'precision' }, NOW);
    store.record('BIL', MODEL, { ...VALID, metric: 'recall' }, NOW);
    const r = await request(app)
      .get(`/v1/ai/models/${MODEL}/performance?metric=precision`)
      .set(TH_BIL);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].metric).toBe('precision');
  });

  test('?metric=garbage → 400', async () => {
    const { app } = makePerfApp('admin');
    const r = await request(app)
      .get(`/v1/ai/models/${MODEL}/performance?metric=f1`)
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('unknown model → 404', async () => {
    const { app } = makePerfApp('admin');
    const r = await request(app)
      .get('/v1/ai/models/no-such-model/performance')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('cross-tenant isolation', async () => {
    const { app, store } = makePerfApp('admin');
    store.record('BIL', MODEL, VALID, NOW);
    const r = await request(app)
      .get(`/v1/ai/models/${MODEL}/performance`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.body.body.total).toBe(0);
  });
});

describe('M7.5 — GET /v1/ai/models/:model_id/performance/summary', () => {
  test('empty store → all metrics null', async () => {
    const { app } = makePerfApp('admin');
    const r = await request(app)
      .get(`/v1/ai/models/${MODEL}/performance/summary`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.sample_size).toBe(0);
    for (const m of PERFORMANCE_METRICS) expect(r.body.body.metrics[m]).toBeNull();
  });

  test('with entries: per-metric summary block populated', async () => {
    const { app, store } = makePerfApp('admin');
    store.record('BIL', MODEL, { ...VALID, metric: 'precision', value: 0.7 }, new Date('2026-05-01T00:00:00Z'));
    store.record('BIL', MODEL, { ...VALID, metric: 'precision', value: 0.9 }, new Date('2026-05-05T00:00:00Z'));
    const r = await request(app)
      .get(`/v1/ai/models/${MODEL}/performance/summary`)
      .set(TH_BIL);
    expect(r.body.body.metrics.precision.latest_value).toBe(0.9);
    expect(r.body.body.metrics.precision.mean).toBeCloseTo(0.8, 5);
    expect(r.body.body.metrics.precision.sample_count).toBe(2);
  });

  test('?since= filter narrows the window', async () => {
    const { app, store } = makePerfApp('admin');
    store.record('BIL', MODEL, { ...VALID, value: 0.7 }, new Date('2026-05-01T00:00:00Z'));
    store.record('BIL', MODEL, { ...VALID, value: 0.9 }, new Date('2026-05-05T00:00:00Z'));
    const r = await request(app)
      .get(`/v1/ai/models/${MODEL}/performance/summary?since=2026-05-03T00:00:00.000Z`)
      .set(TH_BIL);
    expect(r.body.body.metrics.precision.sample_count).toBe(1);
    expect(r.body.body.metrics.precision.mean).toBe(0.9);
  });

  test('unknown model → 404', async () => {
    const { app } = makePerfApp('admin');
    const r = await request(app)
      .get('/v1/ai/models/no-such-model/performance/summary')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('M7.x existing routes still work (literal /performance did not shadow)', async () => {
    const { app } = makePerfApp('admin');
    const r = await request(app).get(`/v1/ai/models/${MODEL}`).set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.model_id).toBe(MODEL);
    const t = await request(app).get('/v1/ai/models/types').set(TH_BIL);
    expect(t.status).toBe(200);
  });
});
