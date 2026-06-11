// @ts-nocheck
// services/bff/__tests__/audit_actor_heatmap.test.ts
// T6 M15.24 — Audit event actor frequency heatmap.

import request from 'supertest';
import { buildAuditActorHeatmap } from '../src/audit_actor_heatmap';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-11T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function fakeApp(role = 'admin', store = undefined) {
  const auditStore = store ?? new InMemoryAuditTrailStore();
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    auditTrailStore: auditStore,
    getRole: () => role,
    now: () => NOW,
  });
  return { app, auditStore };
}

function makeEvent(overrides = {}) {
  return {
    tenant_id: 'BIL',
    actor_username: 'alice',
    actor_role: 'admin',
    action: 'config.update',
    resource_type: 'config',
    resource_id: 'alerts.red_sla_hours',
    outcome: 'success',
    severity: 'info',
    ...overrides,
  };
}

// ─── Pure function tests ────────────────────────────────────────────────

describe('M15.24 — buildAuditActorHeatmap — empty', () => {
  test('empty store → no top_actors', () => {
    const store = new InMemoryAuditTrailStore();
    const out = buildAuditActorHeatmap(store, 'BIL', NOW);
    expect(out.top_actors).toHaveLength(0);
    expect(out.total_events_analyzed).toBe(0);
  });
});

describe('M15.24 — buildAuditActorHeatmap — with events', () => {
  test('single actor → appears in top_actors', () => {
    const store = new InMemoryAuditTrailStore();
    store.record("BIL", makeEvent({ actor_username: 'alice' }), NOW);
    store.record("BIL", makeEvent({ actor_username: 'alice' }), NOW);
    const out = buildAuditActorHeatmap(store, 'BIL', NOW);
    expect(out.top_actors).toHaveLength(1);
    expect(out.top_actors[0].actor_username).toBe('alice');
    expect(out.top_actors[0].total_events).toBe(2);
  });

  test('heatmap is 7x24', () => {
    const store = new InMemoryAuditTrailStore();
    store.record("BIL", makeEvent(), NOW);
    const out = buildAuditActorHeatmap(store, 'BIL', NOW);
    const heatmap = out.top_actors[0].heatmap;
    expect(heatmap).toHaveLength(7);
    for (const row of heatmap) {
      expect(row).toHaveLength(24);
    }
  });

  test('max 5 actors returned', () => {
    const store = new InMemoryAuditTrailStore();
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 3; j++) {
        store.record("BIL", makeEvent({ actor_username: `user-${i}` }), NOW);
      }
    }
    const out = buildAuditActorHeatmap(store, 'BIL', NOW);
    expect(out.top_actors.length).toBeLessThanOrEqual(5);
  });

  test('sorted by total_events desc', () => {
    const store = new InMemoryAuditTrailStore();
    store.record("BIL", makeEvent({ actor_username: 'bob' }), NOW);
    for (let i = 0; i < 3; i++) {
      store.record("BIL", makeEvent({ actor_username: 'alice' }), NOW);
    }
    const out = buildAuditActorHeatmap(store, 'BIL', NOW);
    expect(out.top_actors[0].actor_username).toBe('alice');
    expect(out.top_actors[0].total_events).toBeGreaterThan(out.top_actors[1].total_events);
  });

  test('tenant isolation', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BANK_DEMO', makeEvent({ tenant_id: 'BANK_DEMO' }), NOW);
    const out = buildAuditActorHeatmap(store, 'BIL', NOW);
    expect(out.total_events_analyzed).toBe(0);
  });

  test('total_events_analyzed matches recorded count', () => {
    const store = new InMemoryAuditTrailStore();
    store.record("BIL", makeEvent(), NOW);
    store.record("BIL", makeEvent(), NOW);
    const out = buildAuditActorHeatmap(store, 'BIL', NOW);
    expect(out.total_events_analyzed).toBe(2);
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M15.24 — route GET /v1/audit/actor-heatmap', () => {
  test('admin → 200 with top_actors', async () => {
    const { app } = fakeApp('admin');
    const res = await request(app).get('/v1/audit/actor-heatmap').set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.top_actors)).toBe(true);
    expect(res.body.body).toHaveProperty('total_events_analyzed');
  });

  test('case_owner → 403', async () => {
    const { app } = fakeApp('case_owner');
    const res = await request(app).get('/v1/audit/actor-heatmap').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant → 400', async () => {
    const { app } = fakeApp('admin');
    const res = await request(app).get('/v1/audit/actor-heatmap');
    expect(res.status).toBe(400);
  });
});
