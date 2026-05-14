// services/bff/__tests__/audit_per_actor_activity.test.ts
//
// T6 M15.8 — Audit log per-actor activity rollup.

import request from 'supertest';
import { summarizePerActorActivity } from '../src/audit_per_actor_activity';
import {
  InMemoryAuditTrailStore,
  type AuditEvent,
  type AuditEventInput,
} from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function record(
  store: InMemoryAuditTrailStore,
  tenant: string,
  input: AuditEventInput,
  at: Date,
): AuditEvent {
  return store.record(tenant, input, at);
}

function listAll(store: InMemoryAuditTrailStore, tenant: string): AuditEvent[] {
  const page = store.list(tenant, { page_size: 1000 });
  return page.items;
}

const baseInput = (overrides: Partial<AuditEventInput> = {}): AuditEventInput => ({
  actor_username: 'alice',
  actor_role: 'admin',
  action: 'config.update',
  resource_type: 'config',
  resource_id: 'k1',
  outcome: 'success',
  ...overrides,
});

// ─── summarizePerActorActivity — pure ────────────────────────────────

describe('M15.8 — empty input', () => {
  test('zero events → empty rollup', () => {
    const s = summarizePerActorActivity('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_actors).toBe(0);
    expect(s.total_events).toBe(0);
    expect(s.actors).toEqual([]);
    expect(s.most_active_actor).toBeNull();
    expect(s.failure_only_actors).toEqual([]);
  });
});

describe('M15.8 — single actor / single event', () => {
  test('row populated with first/last/counts', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput(), NOW);
    const s = summarizePerActorActivity('BIL', listAll(store, 'BIL'), NOW);
    expect(s.total_actors).toBe(1);
    expect(s.total_events).toBe(1);
    const a = s.actors[0]!;
    expect(a.actor_username).toBe('alice');
    expect(a.total_events).toBe(1);
    expect(a.by_action['config.update']).toBe(1);
    expect(a.by_outcome.success).toBe(1);
    expect(a.by_resource_type.config).toBe(1);
    expect(a.first_event_at).toBeTruthy();
    expect(a.last_event_at).toBeTruthy();
    expect(a.primary_role).toBe('admin');
  });
});

describe('M15.8 — first/last timestamps', () => {
  test('first = oldest event ts, last = newest event ts', () => {
    const store = new InMemoryAuditTrailStore();
    const t1 = new Date('2026-05-01T00:00:00.000Z');
    const t2 = new Date('2026-05-10T00:00:00.000Z');
    const t3 = new Date('2026-05-05T00:00:00.000Z');
    record(store, 'BIL', baseInput(), t1);
    record(store, 'BIL', baseInput({ action: 'config.reset' }), t2);
    record(store, 'BIL', baseInput({ action: 'config.update', resource_id: 'k2' }), t3);
    const s = summarizePerActorActivity('BIL', listAll(store, 'BIL'), NOW);
    const a = s.actors[0]!;
    expect(a.first_event_at).toBe(t1.toISOString());
    expect(a.last_event_at).toBe(t2.toISOString());
  });
});

describe('M15.8 — multiple actors', () => {
  test('per-actor counts isolated', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ actor_username: 'alice' }), NOW);
    record(store, 'BIL', baseInput({ actor_username: 'bob' }), NOW);
    record(store, 'BIL', baseInput({ actor_username: 'alice' }), NOW);
    const s = summarizePerActorActivity('BIL', listAll(store, 'BIL'), NOW);
    expect(s.total_actors).toBe(2);
    expect(s.total_events).toBe(3);
    const alice = s.actors.find((a) => a.actor_username === 'alice')!;
    const bob = s.actors.find((a) => a.actor_username === 'bob')!;
    expect(alice.total_events).toBe(2);
    expect(bob.total_events).toBe(1);
  });
});

describe('M15.8 — sort order', () => {
  test('actors sorted by total_events desc with actor_username asc tie-break', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ actor_username: 'charlie' }), NOW);
    record(store, 'BIL', baseInput({ actor_username: 'alice' }), NOW);
    record(store, 'BIL', baseInput({ actor_username: 'alice' }), NOW);
    record(store, 'BIL', baseInput({ actor_username: 'bob' }), NOW);
    record(store, 'BIL', baseInput({ actor_username: 'bob' }), NOW);
    const s = summarizePerActorActivity('BIL', listAll(store, 'BIL'), NOW);
    // alice + bob both at 2; alphabetical → alice first. charlie at 1 last.
    expect(s.actors.map((a) => a.actor_username)).toEqual(['alice', 'bob', 'charlie']);
  });
});

describe('M15.8 — by_action_top top 5', () => {
  test('top 5 actions surfaced by count desc with action asc tie-break', () => {
    const store = new InMemoryAuditTrailStore();
    const tenant = 'BIL';
    // alice does 6 distinct actions; expect top 5 in the row
    for (let i = 0; i < 5; i++) record(store, tenant, baseInput({ action: 'a1' }), NOW);
    for (let i = 0; i < 4; i++) record(store, tenant, baseInput({ action: 'a2' }), NOW);
    for (let i = 0; i < 3; i++) record(store, tenant, baseInput({ action: 'a3' }), NOW);
    for (let i = 0; i < 2; i++) record(store, tenant, baseInput({ action: 'a4' }), NOW);
    for (let i = 0; i < 1; i++) record(store, tenant, baseInput({ action: 'a5' }), NOW);
    for (let i = 0; i < 1; i++) record(store, tenant, baseInput({ action: 'a6' }), NOW);
    const s = summarizePerActorActivity(tenant, listAll(store, tenant), NOW);
    const a = s.actors[0]!;
    expect(a.distinct_actions).toBe(6);
    expect(a.by_action_top.length).toBe(5);
    expect(a.by_action_top[0]).toEqual({ action: 'a1', count: 5 });
    expect(a.by_action_top[1]).toEqual({ action: 'a2', count: 4 });
    // a5 + a6 tied at 1 — a5 wins alphabetical tie-break, a6 cut at top-5
    expect(a.by_action_top[4]!.action).toBe('a5');
  });
});

describe('M15.8 — by_outcome includes every outcome key', () => {
  test('every AuditOutcome key present even at zero', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ outcome: 'success' }), NOW);
    record(store, 'BIL', baseInput({ outcome: 'failure' }), NOW);
    const s = summarizePerActorActivity('BIL', listAll(store, 'BIL'), NOW);
    const a = s.actors[0]!;
    expect(a.by_outcome).toHaveProperty('success', 1);
    expect(a.by_outcome).toHaveProperty('failure', 1);
    expect(a.by_outcome).toHaveProperty('denied', 0);
  });
});

describe('M15.8 — by_resource_type includes every resource_type key', () => {
  test('every AuditResourceType key present even at zero', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ resource_type: 'config' }), NOW);
    record(store, 'BIL', baseInput({ resource_type: 'case' }), NOW);
    const s = summarizePerActorActivity('BIL', listAll(store, 'BIL'), NOW);
    const a = s.actors[0]!;
    // Has both config + case at 1; rest at 0
    expect(a.by_resource_type.config).toBe(1);
    expect(a.by_resource_type.case).toBe(1);
    expect(a.by_resource_type.user).toBe(0);
    expect(a.by_resource_type.alert).toBe(0);
  });
});

describe('M15.8 — most_active_actor', () => {
  test('points at top of sorted actors', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ actor_username: 'alice' }), NOW);
    record(store, 'BIL', baseInput({ actor_username: 'alice' }), NOW);
    record(store, 'BIL', baseInput({ actor_username: 'bob' }), NOW);
    const s = summarizePerActorActivity('BIL', listAll(store, 'BIL'), NOW);
    expect(s.most_active_actor).toEqual({ actor_username: 'alice', total_events: 2 });
  });

  test('null when no events', () => {
    const s = summarizePerActorActivity('BIL', [], NOW);
    expect(s.most_active_actor).toBeNull();
  });
});

describe('M15.8 — failure_only_actors', () => {
  test('captures actors with zero success events, sorted asc', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ actor_username: 'alice', outcome: 'success' }), NOW);
    // bob: only failures
    record(store, 'BIL', baseInput({ actor_username: 'bob', outcome: 'failure' }), NOW);
    record(store, 'BIL', baseInput({ actor_username: 'bob', outcome: 'denied' }), NOW);
    // charlie: only denials
    record(store, 'BIL', baseInput({ actor_username: 'charlie', outcome: 'denied' }), NOW);
    const s = summarizePerActorActivity('BIL', listAll(store, 'BIL'), NOW);
    expect(s.failure_only_actors).toContain('bob');
    expect(s.failure_only_actors).toContain('charlie');
    expect(s.failure_only_actors).not.toContain('alice');
    // sorted asc
    expect([...s.failure_only_actors].sort()).toEqual(s.failure_only_actors);
  });
});

describe('M15.8 — primary_role', () => {
  test('admin > supervisor > others by RANK', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ actor_username: 'alice', actor_role: 'risk_analyst' }), NOW);
    record(store, 'BIL', baseInput({ actor_username: 'alice', actor_role: 'admin' }), NOW);
    record(store, 'BIL', baseInput({ actor_username: 'alice', actor_role: 'supervisor' }), NOW);
    const s = summarizePerActorActivity('BIL', listAll(store, 'BIL'), NOW);
    expect(s.actors[0]!.primary_role).toBe('admin');
  });
});

describe('M15.8 — Σ per-actor total_events = total_events', () => {
  test('aggregate consistency invariant', () => {
    const store = new InMemoryAuditTrailStore();
    for (let i = 0; i < 10; i++) record(store, 'BIL', baseInput({ actor_username: 'alice' }), NOW);
    for (let i = 0; i < 5; i++) record(store, 'BIL', baseInput({ actor_username: 'bob' }), NOW);
    const s = summarizePerActorActivity('BIL', listAll(store, 'BIL'), NOW);
    const sum = s.actors.reduce((acc, a) => acc + a.total_events, 0);
    expect(s.total_events).toBe(sum);
    expect(s.total_events).toBe(15);
  });
});

// ─── Routes ──────────────────────────────────────────────────────────

function makeActorActivityApp(role = 'admin') {
  const auditTrailStore = new InMemoryAuditTrailStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    auditTrailStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, auditTrailStore };
}

describe('M15.8 — GET /v1/audit/per-actor-activity', () => {
  test('admin → 200 with empty rollup', async () => {
    const { app } = makeActorActivityApp('admin');
    const r = await request(app).get('/v1/audit/per-actor-activity').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_actors).toBe(0);
    expect(r.body.body.total_events).toBe(0);
  });

  test('populated rollup reflects events', async () => {
    const { app, auditTrailStore } = makeActorActivityApp('admin');
    record(auditTrailStore, 'BIL', baseInput({ actor_username: 'alice' }), NOW);
    record(auditTrailStore, 'BIL', baseInput({ actor_username: 'bob' }), NOW);
    record(auditTrailStore, 'BIL', baseInput({ actor_username: 'alice' }), NOW);
    const r = await request(app).get('/v1/audit/per-actor-activity').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_actors).toBe(2);
    expect(r.body.body.total_events).toBe(3);
    expect(r.body.body.most_active_actor.actor_username).toBe('alice');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeActorActivityApp('case_owner');
    const r = await request(app).get('/v1/audit/per-actor-activity').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL events invisible to BANK_DEMO', async () => {
    const { app, auditTrailStore } = makeActorActivityApp('admin');
    record(auditTrailStore, 'BIL', baseInput({ actor_username: 'alice' }), NOW);
    const bank = await request(app)
      .get('/v1/audit/per-actor-activity')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_events).toBe(0);
  });

  test('M15.6 /v1/audit/catalog still works (sibling route)', async () => {
    const { app } = makeActorActivityApp('admin');
    const r = await request(app).get('/v1/audit/catalog').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
