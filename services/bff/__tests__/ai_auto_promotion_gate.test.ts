// services/bff/__tests__/ai_auto_promotion_gate.test.ts
//
// T5.1 — Auto-promotion gate. Three layers:
//   1. Pure resolver — pass/fail logic, default thresholds, decision
//      semantics (promote / hold / requires_approval).
//   2. Custom thresholds override the defaults.
//   3. Routes — RBAC, envelope, integration with model_performance
//      ledger + promotion engine.

import request from 'supertest';
import {
  defaultThresholds,
  evaluatePromotionGate,
  type GateResult,
} from '../src/ai_auto_promotion_gate';
import {
  InMemoryModelPerformanceStore,
  summarizePerformance,
} from '../src/model_performance';
import { defaultAiModelRegistry } from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-09T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
// One of the models in the M7.1 registry per server.ts:
const MODEL = 'fraud_lgb_v1';

// Helper — build a perf summary directly from a flat list of (metric, value)
// rather than going through the store + summarizePerformance.
function summaryWith(over: Partial<{
  auc: number;
  precision: number;
  recall: number;
  drift_score: number;
  calibration_err: number;
  sample_size: number;
}>) {
  const mk = (v: number) => ({
    latest_value: v,
    latest_at: NOW.toISOString(),
    sample_count: 1,
    mean: v,
    min: v,
    p50: v,
    p95: v,
    max: v,
  });
  return {
    tenant_id: 'BIL',
    model_id: MODEL,
    sample_size: over.sample_size ?? 1000,
    metrics: {
      auc: over.auc != null ? mk(over.auc) : null,
      precision: over.precision != null ? mk(over.precision) : null,
      recall: over.recall != null ? mk(over.recall) : null,
      drift_score: over.drift_score != null ? mk(over.drift_score) : null,
      calibration_err: over.calibration_err != null ? mk(over.calibration_err) : null,
    },
  };
}

// ── 1. Pure resolver ──────────────────────────────────────────────────

describe('evaluatePromotionGate', () => {
  test('healthy AUC + drift_score → promote on shadow target', () => {
    const r = evaluatePromotionGate(
      {
        summary: summaryWith({ auc: 0.85, drift_score: 0.1, sample_size: 1000 }),
        target_status: 'shadow',
      },
      NOW,
    );
    expect(r.decision).toBe('promote');
    expect(r.failures).toEqual([]);
    expect(r.checks.every((c) => c.passed)).toBe(true);
  });

  test('low AUC fails the gate → hold + reason on the failure list', () => {
    const r = evaluatePromotionGate(
      {
        summary: summaryWith({ auc: 0.4, drift_score: 0.1, sample_size: 1000 }),
        target_status: 'shadow',
      },
      NOW,
    );
    expect(r.decision).toBe('hold');
    expect(r.failures.length).toBeGreaterThan(0);
    expect(r.failures.join(' ')).toMatch(/auc=0.4/);
  });

  test('high drift fails the gate even with good AUC', () => {
    const r = evaluatePromotionGate(
      {
        summary: summaryWith({ auc: 0.9, drift_score: 0.5, sample_size: 1000 }),
        target_status: 'shadow',
      },
      NOW,
    );
    expect(r.decision).toBe('hold');
    expect(r.failures.join(' ')).toMatch(/drift_score/);
  });

  test('production target → requires_approval even when metrics pass', () => {
    const r = evaluatePromotionGate(
      {
        summary: summaryWith({
          auc: 0.95,
          precision: 0.9,
          recall: 0.85,
          drift_score: 0.05,
          calibration_err: 0.02,
          sample_size: 5000,
        }),
        target_status: 'production',
      },
      NOW,
    );
    expect(r.decision).toBe('requires_approval');
  });

  test('production target with bad metrics → hold (not requires_approval)', () => {
    const r = evaluatePromotionGate(
      {
        summary: summaryWith({ auc: 0.5, drift_score: 0.5, sample_size: 100 }),
        target_status: 'production',
      },
      NOW,
    );
    expect(r.decision).toBe('hold');
  });

  test('required metric missing → hold with present-check failure', () => {
    const r = evaluatePromotionGate(
      {
        summary: summaryWith({ sample_size: 1000 }), // no metrics observed
        target_status: 'shadow',
      },
      NOW,
    );
    expect(r.decision).toBe('hold');
    expect(r.checks.find((c) => c.metric === 'metric_present' && !c.passed)).toBeDefined();
  });

  test('staging target uses lighter thresholds', () => {
    const r = evaluatePromotionGate(
      {
        summary: summaryWith({ auc: 0.66, sample_size: 150 }),
        target_status: 'staging',
      },
      NOW,
    );
    expect(r.decision).toBe('promote');
  });

  test('thresholds applied are echoed back', () => {
    const r = evaluatePromotionGate(
      {
        summary: summaryWith({ auc: 0.9, drift_score: 0.05, sample_size: 1000 }),
        target_status: 'shadow',
      },
      NOW,
    );
    expect(r.thresholds_applied.min_auc).toBe(0.7);
    expect(r.thresholds_applied.max_drift_score).toBe(0.3);
  });
});

describe('custom thresholds override defaults', () => {
  test('strict custom min_auc rejects a model the default would accept', () => {
    const r = evaluatePromotionGate(
      {
        summary: summaryWith({ auc: 0.72, drift_score: 0.1, sample_size: 1000 }),
        target_status: 'shadow',
        thresholds: { min_auc: 0.95, required_metrics: ['auc'] },
      },
      NOW,
    );
    expect(r.decision).toBe('hold');
    expect(r.thresholds_applied.min_auc).toBe(0.95);
  });

  test('relaxed custom thresholds accept a model the default would reject', () => {
    const r = evaluatePromotionGate(
      {
        summary: summaryWith({ auc: 0.55, drift_score: 0.5, sample_size: 1000 }),
        target_status: 'shadow',
        thresholds: { min_auc: 0.5, required_metrics: ['auc'] },
      },
      NOW,
    );
    expect(r.decision).toBe('promote');
  });
});

describe('defaultThresholds', () => {
  test('production is strictest', () => {
    const t = defaultThresholds('production');
    expect(t.min_auc).toBeGreaterThan(defaultThresholds('shadow').min_auc!);
    expect(t.max_drift_score).toBeLessThan(defaultThresholds('shadow').max_drift_score!);
  });

  test('retired returns no thresholds', () => {
    expect(defaultThresholds('retired')).toEqual({});
  });
});

// ── 2. Routes ─────────────────────────────────────────────────────────

function makeGateApp(role: string) {
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

describe('POST /v1/ai/models/:id/promotion-gate/evaluate', () => {
  test('happy path — shadow target with healthy metrics returns promote', async () => {
    const { app, store } = makeGateApp('admin');
    store.record('BIL', MODEL, { metric: 'auc',         value: 0.85, sample_size: 1000 }, NOW);
    store.record('BIL', MODEL, { metric: 'drift_score', value: 0.1,  sample_size: 1000 }, NOW);
    const r = await request(app)
      .post(`/v1/ai/models/${MODEL}/promotion-gate/evaluate`)
      .set(TH_BIL).set('x-apex-role', 'admin')
      .send({ target_status: 'shadow' });
    expect(r.status).toBe(200);
    const body = r.body.body as GateResult;
    expect(body.decision).toBe('promote');
    expect(body.model_id).toBe(MODEL);
  });

  test('400 on missing/invalid target_status', async () => {
    const { app } = makeGateApp('admin');
    const r = await request(app)
      .post(`/v1/ai/models/${MODEL}/promotion-gate/evaluate`)
      .set(TH_BIL).set('x-apex-role', 'admin')
      .send({ target_status: 'foo' });
    expect(r.status).toBe(400);
  });

  test('404 on unknown model_id', async () => {
    const { app } = makeGateApp('admin');
    const r = await request(app)
      .post('/v1/ai/models/no-such-model/promotion-gate/evaluate')
      .set(TH_BIL).set('x-apex-role', 'admin')
      .send({ target_status: 'shadow' });
    expect(r.status).toBe(404);
  });

  test('403 for collection_officer', async () => {
    const { app } = makeGateApp('collection_officer');
    const r = await request(app)
      .post(`/v1/ai/models/${MODEL}/promotion-gate/evaluate`)
      .set(TH_BIL).set('x-apex-role', 'collection_officer')
      .send({ target_status: 'shadow' });
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/ai/models/:id/promotion-gate/auto-promote', () => {
  test('passing gate creates + auto-approves a promotion request', async () => {
    const { app, store } = makeGateApp('admin');
    store.record('BIL', MODEL, { metric: 'auc',         value: 0.85, sample_size: 1000 }, NOW);
    store.record('BIL', MODEL, { metric: 'drift_score', value: 0.1,  sample_size: 1000 }, NOW);
    const r = await request(app)
      .post(`/v1/ai/models/${MODEL}/promotion-gate/auto-promote`)
      .set(TH_BIL).set('x-apex-role', 'admin')
      .send({ from_status: 'staging', target_status: 'shadow' });
    expect(r.status).toBe(201);
    expect(r.body.body.gate.decision).toBe('promote');
    expect(r.body.body.promotion_request.status).toBe('approved');
    expect(r.body.body.promotion_request.reviewed_by).toBe('system:auto-promotion-gate');
  });

  test('failing gate returns 200 with hold + null promotion_request', async () => {
    const { app, store } = makeGateApp('admin');
    store.record('BIL', MODEL, { metric: 'auc', value: 0.4, sample_size: 1000 }, NOW);
    store.record('BIL', MODEL, { metric: 'drift_score', value: 0.1, sample_size: 1000 }, NOW);
    const r = await request(app)
      .post(`/v1/ai/models/${MODEL}/promotion-gate/auto-promote`)
      .set(TH_BIL).set('x-apex-role', 'admin')
      .send({ from_status: 'staging', target_status: 'shadow' });
    expect(r.status).toBe(200);
    expect(r.body.body.gate.decision).toBe('hold');
    expect(r.body.body.promotion_request).toBeNull();
    expect(r.body.body.message).toMatch(/gate held/);
  });

  test('production target with healthy metrics returns requires_approval (no auto-promote)', async () => {
    const { app, store } = makeGateApp('admin');
    for (const m of ['auc', 'precision', 'recall', 'drift_score', 'calibration_err'] as const) {
      const v = m === 'drift_score' ? 0.05 : m === 'calibration_err' ? 0.02 : 0.92;
      store.record('BIL', MODEL, { metric: m, value: v, sample_size: 5000 }, NOW);
    }
    const r = await request(app)
      .post(`/v1/ai/models/${MODEL}/promotion-gate/auto-promote`)
      .set(TH_BIL).set('x-apex-role', 'admin')
      .send({ from_status: 'shadow', target_status: 'production' });
    expect(r.status).toBe(200);
    expect(r.body.body.gate.decision).toBe('requires_approval');
    expect(r.body.body.promotion_request).toBeNull();
  });

  test('403 for collection_officer (auto-promote needs audit:read)', async () => {
    const { app } = makeGateApp('collection_officer');
    const r = await request(app)
      .post(`/v1/ai/models/${MODEL}/promotion-gate/auto-promote`)
      .set(TH_BIL).set('x-apex-role', 'collection_officer')
      .send({ from_status: 'staging', target_status: 'shadow' });
    expect(r.status).toBe(403);
  });
});

// ── 3. Resolver-vs-route consistency ──────────────────────────────────

describe('resolver matches the route output', () => {
  test('summarizePerformance + evaluatePromotionGate gives the same decision the route returns', async () => {
    const { app, store } = makeGateApp('admin');
    store.record('BIL', MODEL, { metric: 'auc',         value: 0.85, sample_size: 1000 }, NOW);
    store.record('BIL', MODEL, { metric: 'drift_score', value: 0.1,  sample_size: 1000 }, NOW);
    const expected = evaluatePromotionGate(
      {
        summary: summarizePerformance('BIL', MODEL, store.list('BIL', MODEL, {})),
        target_status: 'shadow',
      },
      NOW,
    );
    const r = await request(app)
      .post(`/v1/ai/models/${MODEL}/promotion-gate/evaluate`)
      .set(TH_BIL).set('x-apex-role', 'admin')
      .send({ target_status: 'shadow' });
    expect(r.body.body.decision).toBe(expected.decision);
    expect(r.body.body.checks.length).toBe(expected.checks.length);
  });
});
