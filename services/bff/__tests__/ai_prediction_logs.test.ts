// services/bff/__tests__/ai_prediction_logs.test.ts
//
// T7 Module 8 — Prediction Audit Logs. Store + compliance summary + route smoke.

import request from 'supertest';
import {
  InMemoryAiPredictionLogStore,
  AiPredictionLogError,
  isPredictionLogAction,
  ALL_PREDICTION_LOG_ACTIONS,
  USER_PREDICTION_LOG_ACTIONS,
  type RecordPredictionLogInput,
} from '../src/ai_prediction_logs';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-29T09:00:00.000Z');
const PID = '11111111-2222-4333-8444-555555555555';

function makeLogApp(role = 'risk_analyst', store = new InMemoryAiPredictionLogStore()) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    aiPredictionLogStore: store,
  });
}

function rec(over: Partial<RecordPredictionLogInput> = {}): RecordPredictionLogInput {
  return { prediction_id: PID, action: 'acknowledged', actor: 'alice.analyst', ...over };
}

describe('enum', () => {
  it('8 actions + user-action subset + guard', () => {
    expect(ALL_PREDICTION_LOG_ACTIONS).toHaveLength(8);
    expect(ALL_PREDICTION_LOG_ACTIONS).toContain('alert_triggered');
    expect(USER_PREDICTION_LOG_ACTIONS).toContain('overridden');
    expect(USER_PREDICTION_LOG_ACTIONS).not.toContain('alert_triggered');
    expect(isPredictionLogAction('escalated')).toBe(true);
    expect(isPredictionLogAction('bogus')).toBe(false);
  });
});

describe('record + forPrediction', () => {
  it('appends entries chronologically per prediction', () => {
    const s = new InMemoryAiPredictionLogStore();
    s.record('BANK_DEMO', rec({ action: 'created', actor: 'system' }), NOW);
    s.record('BANK_DEMO', rec({ action: 'viewed', actor: 'alice' }), new Date('2026-05-29T09:01:00Z'));
    s.record('BANK_DEMO', rec({ action: 'escalated', actor: 'bob', triggered_alert_id: 'a-700001' }), new Date('2026-05-29T09:02:00Z'));
    const trail = s.forPrediction('BANK_DEMO', PID);
    expect(trail).toHaveLength(3);
    expect(trail.map((e) => e.action)).toEqual(['created', 'viewed', 'escalated']);
    expect(trail[2].triggered_alert_id).toBe('a-700001');
    expect(trail[0].log_id).toMatch(/^[0-9a-f]{8}-/);
  });

  it('returns deep copies — caller mutation does not leak', () => {
    const s = new InMemoryAiPredictionLogStore();
    s.record('BANK_DEMO', rec({ metadata: { reviewed: true } }), NOW);
    const t = s.forPrediction('BANK_DEMO', PID);
    (t[0].metadata as Record<string, unknown>).reviewed = false;
    expect(s.forPrediction('BANK_DEMO', PID)[0].metadata).toEqual({ reviewed: true });
  });

  it('tenant isolation', () => {
    const s = new InMemoryAiPredictionLogStore();
    s.record('BANK_DEMO', rec(), NOW);
    expect(s.forPrediction('BIL', PID)).toHaveLength(0);
  });

  it('rejects bad input', () => {
    const s = new InMemoryAiPredictionLogStore();
    expect(() => s.record('', rec(), NOW)).toThrow(AiPredictionLogError);
    expect(() => s.record('BANK_DEMO', rec({ prediction_id: '' }), NOW)).toThrow(AiPredictionLogError);
    expect(() => s.record('BANK_DEMO', rec({ action: 'bogus' as never }), NOW)).toThrow(AiPredictionLogError);
    expect(() => s.record('BANK_DEMO', rec({ actor: '' }), NOW)).toThrow(AiPredictionLogError);
    expect(() => s.record('BANK_DEMO', rec({ note: 'x'.repeat(4001) }), NOW)).toThrow(AiPredictionLogError);
    expect(() => s.record('BANK_DEMO', rec({ confidence: Infinity }), NOW)).toThrow(AiPredictionLogError);
  });
});

describe('list + summary', () => {
  function seed() {
    const s = new InMemoryAiPredictionLogStore();
    s.record('BANK_DEMO', rec({ prediction_id: 'p1', action: 'created', actor: 'system' }), NOW);
    s.record('BANK_DEMO', rec({ prediction_id: 'p1', action: 'overridden', actor: 'alice' }), new Date('2026-05-29T09:05:00Z'));
    s.record('BANK_DEMO', rec({ prediction_id: 'p2', action: 'alert_triggered', actor: 'system', triggered_alert_id: 'a-1' }), new Date('2026-05-29T09:06:00Z'));
    s.record('BANK_DEMO', rec({ prediction_id: 'p2', action: 'escalated', actor: 'bob' }), new Date('2026-05-29T09:07:00Z'));
    return s;
  }

  it('list is newest-first + filterable by action/actor/prediction', () => {
    const s = seed();
    expect(s.list('BANK_DEMO').total).toBe(4);
    expect(s.list('BANK_DEMO').items[0].action).toBe('escalated'); // newest first
    expect(s.list('BANK_DEMO', { prediction_id: 'p1' }).total).toBe(2);
    expect(s.list('BANK_DEMO', { action: 'overridden' }).items).toHaveLength(1);
    expect(s.list('BANK_DEMO', { actor: 'system' }).total).toBe(2);
    expect(s.list('BANK_DEMO', { page: 1, page_size: 2 }).items).toHaveLength(2);
  });

  it('summary rolls up actions + alerts + overrides + distinct counts', () => {
    const sum = seed().summary('BANK_DEMO', NOW);
    expect(sum.total).toBe(4);
    expect(sum.by_action.created).toBe(1);
    expect(sum.by_action.escalated).toBe(1);
    expect(sum.total_alerts_triggered).toBe(1);
    expect(sum.total_overrides).toBe(1);
    expect(sum.distinct_actors).toBe(3); // system, alice, bob
    expect(sum.distinct_predictions).toBe(2);
    expect(sum.most_recent_at).toBe('2026-05-29T09:07:00.000Z');
  });

  it('empty tenant → zeroed summary with all action keys', () => {
    const sum = new InMemoryAiPredictionLogStore().summary('BANK_DEMO', NOW);
    expect(sum.total).toBe(0);
    expect(Object.keys(sum.by_action).sort()).toEqual([...ALL_PREDICTION_LOG_ACTIONS].sort());
    expect(sum.most_recent_at).toBeNull();
  });
});

describe('routes', () => {
  const HDRS = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'x-apex-user': 'alice.analyst' };

  it('POST log + GET per-prediction trail (analyst) + GET tenant query/summary (admin)', async () => {
    const store = new InMemoryAiPredictionLogStore();
    const { app: analystApp } = makeLogApp('risk_analyst', store);
    const posted = await request(analystApp).post(`/v1/ai/predictions/${PID}/log`).set(HDRS).send({ action: 'acknowledged', note: 'reviewed, looks right' });
    expect(posted.status).toBe(201);
    expect(posted.body.body.action).toBe('acknowledged');
    expect(posted.body.body.actor).toBe('alice.analyst');

    const esc = await request(analystApp).post(`/v1/ai/predictions/${PID}/log`).set(HDRS).send({ action: 'escalated', triggered_alert_id: 'a-9' });
    expect(esc.status).toBe(201);

    const trail = await request(analystApp).get(`/v1/ai/predictions/${PID}/log`).set(HDRS);
    expect(trail.status).toBe(200);
    expect(trail.body.body.total).toBe(2);

    // tenant-wide compliance query is admin-gated
    const { app: adminApp } = makeLogApp('admin', store);
    const logs = await request(adminApp).get('/v1/ai/prediction-logs').set(HDRS);
    expect(logs.status).toBe(200);
    expect(logs.body.body.total).toBe(2);

    const sum = await request(adminApp).get('/v1/ai/prediction-logs/summary').set(HDRS);
    expect(sum.status).toBe(200);
    expect(sum.body.body.by_action.escalated).toBe(1);
  });

  it('400 on invalid action', async () => {
    const { app } = makeLogApp('risk_analyst');
    const r = await request(app).post(`/v1/ai/predictions/${PID}/log`).set(HDRS).send({ action: 'nope' });
    expect(r.status).toBe(400);
  });

  it('the compliance query + summary are admin-only (analyst 403)', async () => {
    const { app } = makeLogApp('risk_analyst');
    expect((await request(app).get('/v1/ai/prediction-logs').set(HDRS)).status).toBe(403);
    expect((await request(app).get('/v1/ai/prediction-logs/summary').set(HDRS)).status).toBe(403);
  });

  it('the literal /prediction-logs/summary is not captured as a log query filter', async () => {
    const { app } = makeLogApp('admin');
    const sum = await request(app).get('/v1/ai/prediction-logs/summary').set(HDRS);
    expect(sum.body.body).toHaveProperty('by_action');
  });

  it('cross-tenant isolation — BIL admin sees none of BANK_DEMO logs', async () => {
    const store = new InMemoryAiPredictionLogStore();
    const { app } = makeLogApp('risk_analyst', store);
    await request(app).post(`/v1/ai/predictions/${PID}/log`).set(HDRS).send({ action: 'acknowledged' });
    const { app: adminApp } = makeLogApp('admin', store);
    const bil = await request(adminApp).get('/v1/ai/prediction-logs').set({ 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' });
    expect(bil.body.body.total).toBe(0);
  });
});
