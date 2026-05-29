// services/bff/__tests__/ai_hybrid_rules.test.ts
//
// T7 AI Rule + ML Hybrid Support — definition store + dry-run preview + routes.

import request from 'supertest';
import {
  InMemoryAiHybridRuleStore,
  HybridRuleError,
  evaluateHybridRule,
  ruleExpression,
  canTransitionHybrid,
  ALL_HYBRID_OPS,
  ALL_HYBRID_STATUSES,
  type CreateHybridRuleInput,
  type HybridCondition,
} from '../src/ai_hybrid_rules';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-29T09:00:00.000Z');

// IF DPD > 90 AND ai_score(pd_xgb_v3) > 0.82 THEN CREATE CRITICAL ALERT
const CONDS: HybridCondition[] = [
  { kind: 'metric', field: 'DPD', op: 'gt', value: 90 },
  { kind: 'ai_score', model_ref: 'pd_xgb_v3', op: 'gt', threshold: 0.82 },
];
function baseRule(over: Partial<CreateHybridRuleInput> = {}): CreateHybridRuleInput {
  return { name: 'High-DPD + high-PD → critical', domain: 'banking', logic: 'AND', conditions: CONDS, action: 'create_alert', severity: 'critical', ...over };
}

function makeHybridApp(role = 'risk_analyst', store = new InMemoryAiHybridRuleStore()) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    aiHybridRuleStore: store,
  });
}

describe('operators + expression', () => {
  it('6 ops + status transitions', () => {
    expect(ALL_HYBRID_OPS).toEqual(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']);
    expect(ALL_HYBRID_STATUSES).toEqual(['draft', 'active', 'disabled']);
    expect(canTransitionHybrid('draft', 'active')).toBe(true);
    expect(canTransitionHybrid('active', 'disabled')).toBe(true);
    expect(canTransitionHybrid('disabled', 'active')).toBe(true);
    expect(canTransitionHybrid('active', 'draft')).toBe(false);
    expect(canTransitionHybrid('draft', 'draft')).toBe(true); // no-op
  });

  it('renders the canonical IF…THEN expression', () => {
    const expr = ruleExpression('AND', CONDS, 'create_alert', 'critical');
    expect(expr).toBe('IF DPD > 90 AND ai_score(pd_xgb_v3) > 0.82 THEN CREATE_ALERT (critical)');
  });
});

describe('evaluateHybridRule (pure dry-run — no side effects)', () => {
  const rule = { rule_id: null, name: 'r', logic: 'AND' as const, conditions: CONDS, action: 'create_alert' as const, severity: 'critical' as const };

  it('AND: fires when both conditions match', () => {
    const out = evaluateHybridRule(rule, { metrics: { DPD: 95 }, ai_scores: { pd_xgb_v3: 0.85 } });
    expect(out.matched).toBe(true);
    expect(out.would_fire).toEqual({ action: 'create_alert', severity: 'critical' });
    expect(out.condition_results.every((r) => r.matched)).toBe(true);
  });

  it('AND: does NOT fire when one condition fails', () => {
    const out = evaluateHybridRule(rule, { metrics: { DPD: 95 }, ai_scores: { pd_xgb_v3: 0.5 } });
    expect(out.matched).toBe(false);
    expect(out.would_fire).toBeNull();
  });

  it('OR: fires when any condition matches', () => {
    const out = evaluateHybridRule({ ...rule, logic: 'OR' }, { metrics: { DPD: 10 }, ai_scores: { pd_xgb_v3: 0.9 } });
    expect(out.matched).toBe(true);
  });

  it('missing input → condition not matched + observed null', () => {
    const out = evaluateHybridRule(rule, { metrics: { DPD: 95 } }); // no ai_score
    expect(out.matched).toBe(false);
    const aiRes = out.condition_results.find((r) => r.condition.kind === 'ai_score')!;
    expect(aiRes.observed).toBeNull();
    expect(aiRes.matched).toBe(false);
    expect(aiRes.detail).toMatch(/not supplied/);
  });

  it('every operator behaves correctly', () => {
    const mk = (op: HybridCondition['op'], value: number) => ({ rule_id: null, name: 'r', logic: 'AND' as const, conditions: [{ kind: 'metric' as const, field: 'x', op, value }], action: 'notify' as const, severity: 'low' as const });
    expect(evaluateHybridRule(mk('gt', 5), { metrics: { x: 6 } }).matched).toBe(true);
    expect(evaluateHybridRule(mk('gte', 5), { metrics: { x: 5 } }).matched).toBe(true);
    expect(evaluateHybridRule(mk('lt', 5), { metrics: { x: 4 } }).matched).toBe(true);
    expect(evaluateHybridRule(mk('lte', 5), { metrics: { x: 5 } }).matched).toBe(true);
    expect(evaluateHybridRule(mk('eq', 5), { metrics: { x: 5 } }).matched).toBe(true);
    expect(evaluateHybridRule(mk('neq', 5), { metrics: { x: 4 } }).matched).toBe(true);
    expect(evaluateHybridRule(mk('gt', 5), { metrics: { x: 5 } }).matched).toBe(false);
  });
});

describe('store CRUD', () => {
  it('create lands in draft + preserves conditions', () => {
    const s = new InMemoryAiHybridRuleStore();
    const r = s.create('BANK_DEMO', baseRule(), NOW);
    expect(r.status).toBe('draft');
    expect(r.conditions).toHaveLength(2);
    expect(r.rule_id).toMatch(/^hyb-BANK_DEMO-/);
  });

  it('list filters by domain + status, get + tenant isolation', () => {
    const s = new InMemoryAiHybridRuleStore();
    s.create('BANK_DEMO', baseRule({ name: 'a' }), NOW);
    s.create('BANK_DEMO', baseRule({ name: 'b', domain: 'insurance', conditions: [{ kind: 'ai_score', model_ref: 'lapse_xgb_v1', op: 'gt', threshold: 0.7 }] }), NOW);
    expect(s.list('BANK_DEMO')).toHaveLength(2);
    expect(s.list('BANK_DEMO', { domain: 'insurance' })).toHaveLength(1);
    expect(s.list('BANK_DEMO', { status: 'draft' })).toHaveLength(2);
    expect(s.list('BANK_DEMO', { status: 'active' })).toHaveLength(0);
    const id = s.list('BANK_DEMO')[0].rule_id;
    expect(s.get('BIL', id)).toBeNull();
  });

  it('update edits fields + status transition; illegal transition throws', () => {
    const s = new InMemoryAiHybridRuleStore();
    const r = s.create('BANK_DEMO', baseRule(), NOW);
    const activated = s.update('BANK_DEMO', r.rule_id, { status: 'active' }, NOW);
    expect(activated.status).toBe('active');
    expect(() => s.update('BANK_DEMO', r.rule_id, { status: 'draft' }, NOW)).toThrow(HybridRuleError);
    const renamed = s.update('BANK_DEMO', r.rule_id, { name: 'renamed', severity: 'high' }, NOW);
    expect(renamed.name).toBe('renamed');
    expect(renamed.severity).toBe('high');
  });

  it('remove + unknown handling', () => {
    const s = new InMemoryAiHybridRuleStore();
    const r = s.create('BANK_DEMO', baseRule(), NOW);
    expect(s.remove('BANK_DEMO', r.rule_id)).toBe(true);
    expect(s.remove('BANK_DEMO', r.rule_id)).toBe(false);
    expect(() => s.update('BANK_DEMO', 'nope', { name: 'x' }, NOW)).toThrow(HybridRuleError);
  });

  it('rejects bad input', () => {
    const s = new InMemoryAiHybridRuleStore();
    expect(() => s.create('', baseRule(), NOW)).toThrow(HybridRuleError);
    expect(() => s.create('BANK_DEMO', baseRule({ name: '' }), NOW)).toThrow(HybridRuleError);
    expect(() => s.create('BANK_DEMO', baseRule({ domain: 'bogus' as never }), NOW)).toThrow(HybridRuleError);
    expect(() => s.create('BANK_DEMO', baseRule({ conditions: [] }), NOW)).toThrow(HybridRuleError);
    expect(() => s.create('BANK_DEMO', baseRule({ conditions: [{ kind: 'metric', field: '', op: 'gt', value: 1 }] }), NOW)).toThrow(HybridRuleError);
    expect(() => s.create('BANK_DEMO', baseRule({ conditions: [{ kind: 'ai_score', model_ref: 'm', op: 'gt', threshold: Infinity }] }), NOW)).toThrow(HybridRuleError);
  });
});

describe('routes', () => {
  const HDRS = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'x-apex-user': 'alice.analyst' };

  it('full CRUD + preview lifecycle', async () => {
    const { app } = makeHybridApp('risk_analyst');
    const created = await request(app).post('/v1/ai/hybrid-rules').set(HDRS).send(baseRule());
    expect(created.status).toBe(201);
    const id = created.body.body.rule_id;
    expect(created.body.body.status).toBe('draft');

    const list = await request(app).get('/v1/ai/hybrid-rules').set(HDRS);
    expect(list.status).toBe(200);
    expect(list.body.body.total).toBe(1);

    const single = await request(app).get(`/v1/ai/hybrid-rules/${id}`).set(HDRS);
    expect(single.status).toBe(200);

    const activated = await request(app).patch(`/v1/ai/hybrid-rules/${id}`).set(HDRS).send({ status: 'active' });
    expect(activated.status).toBe(200);
    expect(activated.body.body.status).toBe('active');

    // dry-run the saved rule — fires for high DPD + high PD
    const fired = await request(app).post(`/v1/ai/hybrid-rules/${id}/preview`).set(HDRS).send({ input: { metrics: { DPD: 95 }, ai_scores: { pd_xgb_v3: 0.85 } } });
    expect(fired.status).toBe(200);
    expect(fired.body.body.matched).toBe(true);
    expect(fired.body.body.would_fire).toEqual({ action: 'create_alert', severity: 'critical' });

    const notFired = await request(app).post(`/v1/ai/hybrid-rules/${id}/preview`).set(HDRS).send({ input: { metrics: { DPD: 10 }, ai_scores: { pd_xgb_v3: 0.85 } } });
    expect(notFired.body.body.matched).toBe(false);

    const del = await request(app).delete(`/v1/ai/hybrid-rules/${id}`).set(HDRS);
    expect(del.status).toBe(204);
    expect((await request(app).get(`/v1/ai/hybrid-rules/${id}`).set(HDRS)).status).toBe(404);
  });

  it('preview an UNSAVED definition (builder)', async () => {
    const { app } = makeHybridApp('risk_analyst');
    const out = await request(app).post('/v1/ai/hybrid-rules/preview').set(HDRS).send({ rule: baseRule(), input: { metrics: { DPD: 120 }, ai_scores: { pd_xgb_v3: 0.9 } } });
    expect(out.status).toBe(200);
    expect(out.body.body.matched).toBe(true);
    expect(out.body.body.expression).toMatch(/^IF DPD > 90 AND/);
  });

  it('the literal /preview is not captured by :rule_id', async () => {
    const { app } = makeHybridApp('risk_analyst');
    const out = await request(app).post('/v1/ai/hybrid-rules/preview').set(HDRS).send({ rule: baseRule(), input: {} });
    expect(out.status).toBe(200);
    expect(out.body.body).toHaveProperty('condition_results');
  });

  it('400 invalid create, 404 unknown, 409 illegal transition', async () => {
    const { app } = makeHybridApp('risk_analyst');
    expect((await request(app).post('/v1/ai/hybrid-rules').set(HDRS).send(baseRule({ conditions: [] }))).status).toBe(400);
    expect((await request(app).get('/v1/ai/hybrid-rules/nope').set(HDRS)).status).toBe(404);
    const created = await request(app).post('/v1/ai/hybrid-rules').set(HDRS).send(baseRule());
    const id = created.body.body.rule_id;
    await request(app).patch(`/v1/ai/hybrid-rules/${id}`).set(HDRS).send({ status: 'active' });
    const illegal = await request(app).patch(`/v1/ai/hybrid-rules/${id}`).set(HDRS).send({ status: 'draft' });
    expect(illegal.status).toBe(409);
  });

  it('403 for a role lacking rules perms (write + read)', async () => {
    const { app } = makeHybridApp('auditor');
    expect((await request(app).get('/v1/ai/hybrid-rules').set(HDRS)).status).toBe(403);
    expect((await request(app).post('/v1/ai/hybrid-rules').set(HDRS).send(baseRule())).status).toBe(403);
  });
});
