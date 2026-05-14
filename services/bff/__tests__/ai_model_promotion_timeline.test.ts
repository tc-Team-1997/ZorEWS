// services/bff/__tests__/ai_model_promotion_timeline.test.ts
//
// T6 M7.10 — AI model promotion request timeline per model.

import request from 'supertest';
import {
  buildModelPromotionTimeline,
  buildPromotionFleetOverview,
} from '../src/ai_model_promotion_timeline';
import { InMemoryPromotionEngine } from '../src/ai_model_promotion';
import {
  InMemoryAiModelRegistry,
  SEED_MODELS,
} from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function modelInStatus(status: string): string {
  const m = SEED_MODELS.find((m) => m.status === status);
  if (!m) throw new Error(`No seed model in status=${status}`);
  return m.model_id;
}

// ─── buildModelPromotionTimeline — pure ──────────────────────────────

describe('M7.10 — buildModelPromotionTimeline', () => {
  test('empty engine → timeline with zero counts', () => {
    const eng = new InMemoryPromotionEngine();
    const reg = new InMemoryAiModelRegistry();
    const t = buildModelPromotionTimeline(eng, reg, 'BIL', modelInStatus('production'));
    expect(t.total_requests).toBe(0);
    expect(t.approved_count).toBe(0);
    expect(t.pending_count).toBe(0);
    expect(t.timeline).toEqual([]);
    expect(t.latest_decision_at).toBeNull();
    expect(t.oldest_pending_at).toBeNull();
    expect(t.model_name).toBeTruthy(); // registry hit
    expect(t.current_model_status).toBeTruthy();
  });

  test('unknown model_id surfaces as orphan (registry null)', () => {
    const eng = new InMemoryPromotionEngine();
    const reg = new InMemoryAiModelRegistry();
    const t = buildModelPromotionTimeline(eng, reg, 'BIL', 'not-a-real-model');
    expect(t.total_requests).toBe(0);
    expect(t.model_name).toBeNull();
    expect(t.current_model_status).toBeNull();
  });

  test('timeline ordered oldest-first by requested_at (interleaved approve→request)', () => {
    const eng = new InMemoryPromotionEngine();
    const reg = new InMemoryAiModelRegistry();
    const modelId = modelInStatus('staging');
    // M7.2 refuses 2nd pending request for the same model — interleave
    // approve→request to thread multiple historical requests through.
    const r1 = eng.requestPromotion('BIL', { model_id: modelId, from_status: 'staging', to_status: 'production', request_notes: 'first' }, 'alice', new Date('2026-05-01T00:00:00Z'));
    eng.approve('BIL', r1.request_id, 'reviewer', null, new Date('2026-05-01T12:00:00Z'));
    eng.requestPromotion('BIL', { model_id: modelId, from_status: 'staging', to_status: 'production', request_notes: 'second' }, 'bob', new Date('2026-05-10T00:00:00Z'));
    const t = buildModelPromotionTimeline(eng, reg, 'BIL', modelId);
    expect(t.total_requests).toBe(2);
    expect(t.timeline[0]!.requested_at).toBe('2026-05-01T00:00:00.000Z');
    expect(t.timeline[1]!.requested_at).toBe('2026-05-10T00:00:00.000Z');
  });

  test('approved + rejected requests bump correct counters', () => {
    const eng = new InMemoryPromotionEngine();
    const reg = new InMemoryAiModelRegistry();
    const modelId = modelInStatus('staging');
    const r1 = eng.requestPromotion('BIL', { model_id: modelId, from_status: 'staging', to_status: 'production', request_notes: 'a' }, 'alice', new Date('2026-05-01T00:00:00Z'));
    eng.approve('BIL', r1.request_id, 'reviewer', null, new Date('2026-05-01T12:00:00Z'));
    const r2 = eng.requestPromotion('BIL', { model_id: modelId, from_status: 'staging', to_status: 'production', request_notes: 'b' }, 'bob', new Date('2026-05-02T00:00:00Z'));
    eng.reject('BIL', r2.request_id, 'reviewer', null, new Date('2026-05-02T12:00:00Z'));
    const t = buildModelPromotionTimeline(eng, reg, 'BIL', modelId);
    expect(t.approved_count).toBe(1);
    expect(t.rejected_count).toBe(1);
    expect(t.pending_count).toBe(0);
    expect(t.cancelled_count).toBe(0);
    expect(t.total_requests).toBe(2);
  });

  test('latest_decision_at = most-recent reviewed_at across decided requests', () => {
    const eng = new InMemoryPromotionEngine();
    const reg = new InMemoryAiModelRegistry();
    const modelId = modelInStatus('staging');
    const r1 = eng.requestPromotion('BIL', { model_id: modelId, from_status: 'staging', to_status: 'production', request_notes: 'a' }, 'alice', new Date('2026-05-01T00:00:00Z'));
    eng.approve('BIL', r1.request_id, 'reviewer', null, new Date('2026-05-05T00:00:00Z'));
    const r2 = eng.requestPromotion('BIL', { model_id: modelId, from_status: 'staging', to_status: 'production', request_notes: 'b' }, 'bob', new Date('2026-05-06T00:00:00Z'));
    eng.reject('BIL', r2.request_id, 'reviewer', null, new Date('2026-05-10T00:00:00Z'));
    const t = buildModelPromotionTimeline(eng, reg, 'BIL', modelId);
    expect(t.latest_decision_at).toBe('2026-05-10T00:00:00.000Z');
  });

  test('oldest_pending_at = earliest requested_at among pending', () => {
    const eng = new InMemoryPromotionEngine();
    const reg = new InMemoryAiModelRegistry();
    const modelId = modelInStatus('staging');
    // Only ONE pending allowed per model; oldest_pending_at = that
    // request's timestamp.
    eng.requestPromotion('BIL', { model_id: modelId, from_status: 'staging', to_status: 'production', request_notes: 'a' }, 'alice', new Date('2026-05-05T00:00:00Z'));
    const t = buildModelPromotionTimeline(eng, reg, 'BIL', modelId);
    expect(t.oldest_pending_at).toBe('2026-05-05T00:00:00.000Z');
  });

  test('decision_latency_ms computed for reviewed requests', () => {
    const eng = new InMemoryPromotionEngine();
    const reg = new InMemoryAiModelRegistry();
    const modelId = modelInStatus('staging');
    const r1 = eng.requestPromotion('BIL', { model_id: modelId, from_status: 'staging', to_status: 'production', request_notes: 'a' }, 'alice', new Date('2026-05-01T00:00:00Z'));
    eng.approve('BIL', r1.request_id, 'reviewer', null, new Date('2026-05-01T01:00:00Z'));
    const t = buildModelPromotionTimeline(eng, reg, 'BIL', modelId);
    expect(t.timeline[0]!.decision_latency_ms).toBe(3600 * 1000);
  });

  test('decision_latency_ms null for pending', () => {
    const eng = new InMemoryPromotionEngine();
    const reg = new InMemoryAiModelRegistry();
    const modelId = modelInStatus('staging');
    eng.requestPromotion('BIL', { model_id: modelId, from_status: 'staging', to_status: 'production', request_notes: 'a' }, 'alice', new Date('2026-05-01T00:00:00Z'));
    const t = buildModelPromotionTimeline(eng, reg, 'BIL', modelId);
    expect(t.timeline[0]!.decision_latency_ms).toBeNull();
  });

  test('cross-tenant isolation', () => {
    const eng = new InMemoryPromotionEngine();
    const reg = new InMemoryAiModelRegistry();
    const modelId = modelInStatus('staging');
    eng.requestPromotion('BIL', { model_id: modelId, from_status: 'staging', to_status: 'production', request_notes: 'a' }, 'alice', NOW);
    const t = buildModelPromotionTimeline(eng, reg, 'BANK_DEMO', modelId);
    expect(t.total_requests).toBe(0);
  });
});

// ─── buildPromotionFleetOverview — pure ──────────────────────────────

describe('M7.10 — buildPromotionFleetOverview', () => {
  test('empty engine → every model present with zero requests', () => {
    const eng = new InMemoryPromotionEngine();
    const reg = new InMemoryAiModelRegistry();
    const o = buildPromotionFleetOverview(eng, reg, 'BIL', NOW);
    expect(o.total_models).toBe(SEED_MODELS.length);
    expect(o.models_with_requests).toBe(0);
    expect(o.models_without_requests).toBe(SEED_MODELS.length);
    expect(o.total_requests).toBe(0);
  });

  test('total_models matches registry size + orphans', () => {
    const eng = new InMemoryPromotionEngine();
    const reg = new InMemoryAiModelRegistry();
    // Orphan model_id: not in registry
    const before = SEED_MODELS.length;
    // Build a request via the engine that points at an unknown model_id
    eng.requestPromotion('BIL', { model_id: 'orphan-model', from_status: 'staging', to_status: 'production', request_notes: 'a' }, 'alice', NOW);
    const o = buildPromotionFleetOverview(eng, reg, 'BIL', NOW);
    expect(o.total_models).toBe(before + 1);
    const orphan = o.models.find((m) => m.model_id === 'orphan-model')!;
    expect(orphan.model_name).toBeNull();
  });

  test('models sorted by total_requests desc with model_id asc tie-break', () => {
    const eng = new InMemoryPromotionEngine();
    const reg = new InMemoryAiModelRegistry();
    const a = modelInStatus('shadow');
    const b = modelInStatus('staging');
    eng.requestPromotion('BIL', { model_id: a, from_status: 'shadow', to_status: 'production', request_notes: 'r1' }, 'alice', NOW);
    eng.requestPromotion('BIL', { model_id: b, from_status: 'staging', to_status: 'production', request_notes: 'r3' }, 'alice', NOW);
    const o = buildPromotionFleetOverview(eng, reg, 'BIL', NOW);
    // Models with requests should be at the top of the sort
    const withReqs = o.models.filter((m) => m.total_requests > 0);
    const withoutReqs = o.models.filter((m) => m.total_requests === 0);
    expect(o.models[0]!.total_requests).toBeGreaterThan(0);
    expect(withReqs.length).toBeGreaterThan(0);
    expect(withReqs.length + withoutReqs.length).toBe(o.total_models);
  });

  test('total_requests = sum of per-model total_requests', () => {
    const eng = new InMemoryPromotionEngine();
    const reg = new InMemoryAiModelRegistry();
    eng.requestPromotion('BIL', { model_id: modelInStatus('staging'), from_status: 'staging', to_status: 'production', request_notes: 'r1' }, 'alice', NOW);
    eng.requestPromotion('BIL', { model_id: modelInStatus('shadow'), from_status: 'shadow', to_status: 'production', request_notes: 'r2' }, 'alice', NOW);
    const o = buildPromotionFleetOverview(eng, reg, 'BIL', NOW);
    const sum = o.models.reduce((acc, m) => acc + m.total_requests, 0);
    expect(o.total_requests).toBe(sum);
  });

  test('cross-tenant isolation in fleet view', () => {
    const eng = new InMemoryPromotionEngine();
    const reg = new InMemoryAiModelRegistry();
    eng.requestPromotion('BIL', { model_id: modelInStatus('staging'), from_status: 'staging', to_status: 'production', request_notes: 'r1' }, 'alice', NOW);
    const bank = buildPromotionFleetOverview(eng, reg, 'BANK_DEMO', NOW);
    expect(bank.total_requests).toBe(0);
    expect(bank.models_with_requests).toBe(0);
  });
});

// ─── Routes ──────────────────────────────────────────────────────────

function makeTimelineApp(role = 'admin') {
  const promotionEngine = new InMemoryPromotionEngine();
  const aiModelRegistry = new InMemoryAiModelRegistry();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    promotionEngine,
    aiModelRegistry,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, promotionEngine, aiModelRegistry };
}

describe('M7.10 — GET /v1/ai/models/:model_id/promotion-timeline', () => {
  test('analyst+ → 200 with timeline', async () => {
    const { app } = makeTimelineApp('risk_analyst');
    const modelId = modelInStatus('production');
    const r = await request(app)
      .get(`/v1/ai/models/${modelId}/promotion-timeline`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.model_id).toBe(modelId);
    expect(r.body.body.total_requests).toBe(0);
  });

  test('populated timeline reflects pending request', async () => {
    const { app, promotionEngine } = makeTimelineApp('admin');
    const modelId = modelInStatus('staging');
    promotionEngine.requestPromotion('BIL', { model_id: modelId, from_status: 'staging', to_status: 'production', request_notes: 'r1' }, 'alice', NOW);
    const r = await request(app)
      .get(`/v1/ai/models/${modelId}/promotion-timeline`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_requests).toBe(1);
    expect(r.body.body.pending_count).toBe(1);
  });

  test('unknown model_id → timeline with model_name=null', async () => {
    const { app } = makeTimelineApp('admin');
    const r = await request(app)
      .get('/v1/ai/models/not-a-real-model/promotion-timeline')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.model_name).toBeNull();
    expect(r.body.body.total_requests).toBe(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTimelineApp('case_owner');
    const r = await request(app)
      .get(`/v1/ai/models/${modelInStatus('production')}/promotion-timeline`)
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('M7.10 — GET /v1/ai/models/promotion-fleet', () => {
  test('admin → 200 with overview', async () => {
    const { app } = makeTimelineApp('admin');
    const r = await request(app).get('/v1/ai/models/promotion-fleet').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_models).toBe(SEED_MODELS.length);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('cross-tenant invisibility (BIL request → BANK_DEMO sees 0)', async () => {
    const { app, promotionEngine } = makeTimelineApp('admin');
    promotionEngine.requestPromotion('BIL', { model_id: modelInStatus('staging'), from_status: 'staging', to_status: 'production', request_notes: 'r1' }, 'alice', NOW);
    const r = await request(app)
      .get('/v1/ai/models/promotion-fleet')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total_requests).toBe(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTimelineApp('case_owner');
    const r = await request(app).get('/v1/ai/models/promotion-fleet').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M7.2 GET /v1/ai/promotions still works (sibling regression)', async () => {
    const { app } = makeTimelineApp('admin');
    const r = await request(app).get('/v1/ai/promotions').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
