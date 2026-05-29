// services/bff/__tests__/ai_experiments.test.ts
//
// T7 Module 10 — Experiment Tracking. Store + state machine + summary +
// route smoke (via makeApp), mirroring the M7.x + Phase-6 test shape.

import request from 'supertest';
import {
  InMemoryAiExperimentStore,
  AiExperimentError,
  canTransitionExperiment,
  ALL_EXPERIMENT_STATUSES,
  ALL_EXPERIMENT_OUTCOMES,
  type CreateExperimentInput,
} from '../src/ai_experiments';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-29T09:00:00.000Z');

function makeExpApp(role = 'risk_analyst', store = new InMemoryAiExperimentStore()) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    aiExperimentStore: store,
  });
}

function baseInput(over: Partial<CreateExperimentInput> = {}): CreateExperimentInput {
  return {
    name: 'XGBoost PD v4 sweep',
    domain: 'banking',
    model_type: 'pd',
    dataset_ref: 'mart.customer_360@2026-Q1',
    dataset_rows: 12000,
    params: { max_depth: 6, n_estimators: 400, learning_rate: 0.05 },
    metrics: { auc: 0.842, precision: 0.71 },
    owner: 'dsci.alice',
    ...over,
  };
}

describe('experiment state machine', () => {
  it('4 statuses + legal/illegal transitions', () => {
    expect(ALL_EXPERIMENT_STATUSES).toEqual(['running', 'completed', 'failed', 'archived']);
    expect(canTransitionExperiment('running', 'completed')).toBe(true);
    expect(canTransitionExperiment('running', 'failed')).toBe(true);
    expect(canTransitionExperiment('completed', 'archived')).toBe(true);
    expect(canTransitionExperiment('failed', 'archived')).toBe(true);
    expect(canTransitionExperiment('running', 'archived')).toBe(false);
    expect(canTransitionExperiment('completed', 'running')).toBe(false);
    expect(canTransitionExperiment('archived', 'completed')).toBe(false);
  });
});

describe('create + list + get', () => {
  it('creates a running experiment with params + metrics preserved', () => {
    const s = new InMemoryAiExperimentStore();
    const e = s.create('BANK_DEMO', baseInput(), NOW);
    expect(e.status).toBe('running');
    expect(e.outcome).toBeNull();
    expect(e.completed_at).toBeNull();
    expect(e.params.max_depth).toBe(6);
    expect(e.metrics.auc).toBe(0.842);
    expect(e.experiment_id).toMatch(/^exp-BANK_DEMO-/);
    expect(e.started_at).toBe(NOW.toISOString());
  });

  it('returns a deep copy — caller mutation does not leak into the store', () => {
    const s = new InMemoryAiExperimentStore();
    const e = s.create('BANK_DEMO', baseInput(), NOW);
    e.params.max_depth = 99;
    expect(s.get('BANK_DEMO', e.experiment_id)!.params.max_depth).toBe(6);
  });

  it('list filters by domain/status/model_type/owner + paginates newest-first', () => {
    const s = new InMemoryAiExperimentStore();
    s.create('BANK_DEMO', baseInput({ name: 'a', model_type: 'pd', owner: 'alice' }), NOW);
    s.create('BANK_DEMO', baseInput({ name: 'b', domain: 'insurance', model_type: 'lapse', owner: 'bob' }), NOW);
    s.create('BANK_DEMO', baseInput({ name: 'c', model_type: 'fraud', owner: 'alice' }), NOW);
    expect(s.list('BANK_DEMO').total).toBe(3);
    expect(s.list('BANK_DEMO').items[0].name).toBe('c'); // newest-first
    expect(s.list('BANK_DEMO', { domain: 'insurance' }).total).toBe(1);
    expect(s.list('BANK_DEMO', { model_type: 'fraud' }).items).toHaveLength(1);
    expect(s.list('BANK_DEMO', { owner: 'alice' }).total).toBe(2);
    expect(s.list('BANK_DEMO', { page: 1, page_size: 2 }).items).toHaveLength(2);
  });

  it('tenant isolation — BIL never sees BANK_DEMO experiments', () => {
    const s = new InMemoryAiExperimentStore();
    const e = s.create('BANK_DEMO', baseInput(), NOW);
    expect(s.get('BIL', e.experiment_id)).toBeNull();
    expect(s.list('BIL').total).toBe(0);
  });

  it('rejects bad input', () => {
    const s = new InMemoryAiExperimentStore();
    expect(() => s.create('', baseInput(), NOW)).toThrow(AiExperimentError);
    expect(() => s.create('BANK_DEMO', baseInput({ name: '' }), NOW)).toThrow(AiExperimentError);
    expect(() => s.create('BANK_DEMO', baseInput({ domain: 'bogus' as never }), NOW)).toThrow(AiExperimentError);
    expect(() => s.create('BANK_DEMO', baseInput({ model_type: 'bogus' as never }), NOW)).toThrow(AiExperimentError);
    expect(() => s.create('BANK_DEMO', baseInput({ dataset_rows: -1 }), NOW)).toThrow(AiExperimentError);
    expect(() => s.create('BANK_DEMO', baseInput({ owner: '' }), NOW)).toThrow(AiExperimentError);
    expect(() => s.create('BANK_DEMO', baseInput({ metrics: { auc: Infinity } }), NOW)).toThrow(AiExperimentError);
    expect(() => s.create('BANK_DEMO', baseInput({ params: { x: {} as never } }), NOW)).toThrow(AiExperimentError);
  });
});

describe('lifecycle + outcome', () => {
  function one() {
    const s = new InMemoryAiExperimentStore();
    const e = s.create('BANK_DEMO', baseInput(), NOW);
    return { s, id: e.experiment_id };
  }

  it('running → completed stamps completed_at', () => {
    const { s, id } = one();
    const done = s.updateStatus('BANK_DEMO', id, 'completed', NOW);
    expect(done.status).toBe('completed');
    expect(done.completed_at).toBe(NOW.toISOString());
  });

  it('illegal transition throws invalid_transition (409 family)', () => {
    const { s, id } = one();
    expect(() => s.updateStatus('BANK_DEMO', id, 'archived', NOW)).toThrow(AiExperimentError);
  });

  it('outcome requires the run to have resolved', () => {
    const { s, id } = one();
    expect(() => s.setOutcome('BANK_DEMO', id, 'promoted', NOW)).toThrow(AiExperimentError);
    s.updateStatus('BANK_DEMO', id, 'completed', NOW);
    expect(s.setOutcome('BANK_DEMO', id, 'promoted', NOW).outcome).toBe('promoted');
  });

  it('all 3 outcomes accepted after completion', () => {
    for (const o of ALL_EXPERIMENT_OUTCOMES) {
      const { s, id } = one();
      s.updateStatus('BANK_DEMO', id, 'completed', NOW);
      expect(s.setOutcome('BANK_DEMO', id, o, NOW).outcome).toBe(o);
    }
  });

  it('unknown experiment + invalid status/outcome throw', () => {
    const { s } = one();
    expect(() => s.updateStatus('BANK_DEMO', 'exp-x', 'completed', NOW)).toThrow(AiExperimentError);
    expect(() => s.updateStatus('BANK_DEMO', 'exp-x', 'bogus' as never, NOW)).toThrow(AiExperimentError);
    expect(() => s.setOutcome('BANK_DEMO', 'exp-x', 'bogus' as never, NOW)).toThrow(AiExperimentError);
  });
});

describe('summary rollup', () => {
  it('aggregates by status/domain/model_type/outcome + best_auc + pending', () => {
    const s = new InMemoryAiExperimentStore();
    const a = s.create('BANK_DEMO', baseInput({ name: 'a', metrics: { auc: 0.80 } }), NOW);
    const b = s.create('BANK_DEMO', baseInput({ name: 'b', domain: 'insurance', model_type: 'lapse', metrics: { auc: 0.91 } }), NOW);
    s.create('BANK_DEMO', baseInput({ name: 'c' }), NOW); // stays running
    s.updateStatus('BANK_DEMO', a.experiment_id, 'completed', NOW);
    s.updateStatus('BANK_DEMO', b.experiment_id, 'completed', NOW);
    s.setOutcome('BANK_DEMO', a.experiment_id, 'promoted', NOW);
    const sum = s.summarize('BANK_DEMO', NOW);
    expect(sum.total).toBe(3);
    expect(sum.by_status.running).toBe(1);
    expect(sum.by_status.completed).toBe(2);
    expect(sum.by_domain.banking).toBe(2);
    expect(sum.by_domain.insurance).toBe(1);
    expect(sum.by_outcome.promoted).toBe(1);
    expect(sum.best_auc).not.toBeNull();
    expect(sum.best_auc!.auc).toBe(0.91); // b is the best completed AUC
    expect(sum.pending_outcome_count).toBe(1); // b completed, no outcome
  });

  it('empty tenant → zeroed summary with all enum keys present', () => {
    const s = new InMemoryAiExperimentStore();
    const sum = s.summarize('BANK_DEMO', NOW);
    expect(sum.total).toBe(0);
    expect(sum.best_auc).toBeNull();
    expect(sum.most_recent_at).toBeNull();
    expect(Object.keys(sum.by_status).sort()).toEqual([...ALL_EXPERIMENT_STATUSES].sort());
  });
});

describe('routes', () => {
  const HDRS = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'x-apex-user': 'dsci.alice' };

  it('POST creates + GET list/summary/single + PATCH status/outcome happy path', async () => {
    const { app } = makeExpApp('risk_analyst');
    const created = await request(app).post('/v1/ai/experiments').set(HDRS).send(baseInput());
    expect(created.status).toBe(201);
    const id = created.body.body.experiment_id;
    expect(created.body.body.status).toBe('running');

    const listed = await request(app).get('/v1/ai/experiments').set(HDRS);
    expect(listed.status).toBe(200);
    expect(listed.body.body.total).toBeGreaterThanOrEqual(1);

    const sum = await request(app).get('/v1/ai/experiments/summary').set(HDRS);
    expect(sum.status).toBe(200);
    expect(sum.body.body.by_status.running).toBeGreaterThanOrEqual(1);

    const single = await request(app).get(`/v1/ai/experiments/${id}`).set(HDRS);
    expect(single.status).toBe(200);
    expect(single.body.body.experiment_id).toBe(id);

    const done = await request(app).patch(`/v1/ai/experiments/${id}/status`).set(HDRS).send({ status: 'completed' });
    expect(done.status).toBe(200);
    expect(done.body.body.status).toBe('completed');

    const out = await request(app).patch(`/v1/ai/experiments/${id}/outcome`).set(HDRS).send({ outcome: 'promoted' });
    expect(out.status).toBe(200);
    expect(out.body.body.outcome).toBe('promoted');
  });

  it('400 on invalid create, 404 on unknown, 409 on illegal transition + premature outcome', async () => {
    const { app } = makeExpApp('risk_analyst');
    const bad = await request(app).post('/v1/ai/experiments').set(HDRS).send(baseInput({ domain: 'bogus' as never }));
    expect(bad.status).toBe(400);

    const miss = await request(app).get('/v1/ai/experiments/exp-x').set(HDRS);
    expect(miss.status).toBe(404);

    const created = await request(app).post('/v1/ai/experiments').set(HDRS).send(baseInput());
    const id = created.body.body.experiment_id;
    const illegal = await request(app).patch(`/v1/ai/experiments/${id}/status`).set(HDRS).send({ status: 'archived' });
    expect(illegal.status).toBe(409);
    const premature = await request(app).patch(`/v1/ai/experiments/${id}/outcome`).set(HDRS).send({ outcome: 'promoted' });
    expect(premature.status).toBe(409);
  });

  it('the literal /summary segment is not captured by the :experiment_id wildcard', async () => {
    const { app } = makeExpApp('risk_analyst');
    const sum = await request(app).get('/v1/ai/experiments/summary').set(HDRS);
    expect(sum.status).toBe(200);
    expect(sum.body.body).toHaveProperty('by_status');
  });

  it('403 for a role lacking customers:read_risk_profile', async () => {
    const { app } = makeExpApp('auditor');
    const r = await request(app).get('/v1/ai/experiments').set(HDRS);
    expect(r.status).toBe(403);
  });

  it('cross-tenant isolation through HTTP — BIL sees none of BANK_DEMO runs', async () => {
    const { app } = makeExpApp('risk_analyst');
    await request(app).post('/v1/ai/experiments').set(HDRS).send(baseInput());
    const bil = await request(app)
      .get('/v1/ai/experiments')
      .set({ 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' });
    expect(bil.status).toBe(200);
    expect(bil.body.body.total).toBe(0);
  });
});
