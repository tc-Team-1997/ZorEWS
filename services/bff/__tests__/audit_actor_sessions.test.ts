// @ts-nocheck
// T6 M15.27 — Audit actor session analysis tests.

import request from 'supertest';
import { buildAuditActorSessions } from '../src/audit_actor_sessions';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
  return app;
}

function addEvent(store, tenant, actor, ts) {
  store.record(tenant, {
    actor_username: actor,
    actor_role: 'admin',
    action: 'config.update',
    resource_type: 'config',
    resource_id: 'key1',
    outcome: 'success',
    ts,
  }, new Date(ts));
}

describe('M15.27 — buildAuditActorSessions pure', () => {
  test('empty audit returns empty result', () => {
    const store = new InMemoryAuditTrailStore();
    const result = buildAuditActorSessions(store, 'BIL', NOW);
    expect(result.total_events_analyzed).toBe(0);
    expect(result.actors).toHaveLength(0);
    expect(result.most_active_actor).toBeNull();
    expect(result.session_heavy_actor).toBeNull();
  });

  test('single actor single event = 1 session', () => {
    const store = new InMemoryAuditTrailStore();
    addEvent(store, 'BIL', 'alice', NOW.toISOString());
    const result = buildAuditActorSessions(store, 'BIL', NOW);
    expect(result.actors).toHaveLength(1);
    expect(result.actors[0].actor_username).toBe('alice');
    expect(result.actors[0].total_events).toBe(1);
    expect(result.actors[0].session_count).toBe(1);
  });

  test('events within 30 min grouped into same session', () => {
    const store = new InMemoryAuditTrailStore();
    const t1 = NOW.toISOString();
    const t2 = new Date(NOW.getTime() + 10 * 60_000).toISOString(); // 10 min later
    addEvent(store, 'BIL', 'alice', t1);
    addEvent(store, 'BIL', 'alice', t2);
    const result = buildAuditActorSessions(store, 'BIL', NOW);
    const alice = result.actors[0];
    expect(alice.session_count).toBe(1);
    expect(alice.total_events).toBe(2);
  });

  test('events more than 30 min apart create 2 sessions', () => {
    const store = new InMemoryAuditTrailStore();
    const t1 = NOW.toISOString();
    const t2 = new Date(NOW.getTime() + 31 * 60_000).toISOString(); // 31 min later
    addEvent(store, 'BIL', 'alice', t1);
    addEvent(store, 'BIL', 'alice', t2);
    const result = buildAuditActorSessions(store, 'BIL', NOW);
    const alice = result.actors[0];
    expect(alice.session_count).toBe(2);
  });

  test('sorted by total_events desc', () => {
    const store = new InMemoryAuditTrailStore();
    addEvent(store, 'BIL', 'alice', NOW.toISOString());
    addEvent(store, 'BIL', 'alice', NOW.toISOString());
    addEvent(store, 'BIL', 'bob', NOW.toISOString());
    const result = buildAuditActorSessions(store, 'BIL', NOW);
    expect(result.actors[0].actor_username).toBe('alice');
    expect(result.actors[0].total_events).toBeGreaterThan(result.actors[1].total_events);
  });

  test('cross-tenant isolation', () => {
    const store = new InMemoryAuditTrailStore();
    addEvent(store, 'BANK_DEMO', 'alice', NOW.toISOString());
    const result = buildAuditActorSessions(store, 'BIL', NOW);
    expect(result.total_events_analyzed).toBe(0);
  });

  test('most_active_actor is the actor with most events', () => {
    const store = new InMemoryAuditTrailStore();
    addEvent(store, 'BIL', 'alice', NOW.toISOString());
    addEvent(store, 'BIL', 'alice', NOW.toISOString());
    addEvent(store, 'BIL', 'bob', NOW.toISOString());
    const result = buildAuditActorSessions(store, 'BIL', NOW);
    expect(result.most_active_actor).toBe('alice');
  });

  test('tenant_id and generated_at echoed', () => {
    const store = new InMemoryAuditTrailStore();
    const result = buildAuditActorSessions(store, 'BIL', NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

describe('M15.27 — GET /v1/audit/actor-sessions route', () => {
  test('admin 200 with envelope', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/audit/actor-sessions').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body.actors).toBeInstanceOf(Array);
  });

  test('field_officer 403', async () => {
    const app = makeTestApp('field_officer');
    const res = await request(app).get('/v1/audit/actor-sessions').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant header → 400', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/audit/actor-sessions');
    expect(res.status).toBe(400);
  });
});
