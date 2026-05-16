// services/bff/__tests__/audit_resource_type_distribution.test.ts
//
// T6 M15.12 — Audit event resource_type distribution.

import request from 'supertest';
import { summarizeAuditByResourceType } from '../src/audit_resource_type_distribution';
import {
  InMemoryAuditTrailStore,
  type AuditEvent,
  type AuditEventInput,
  type AuditResourceType,
} from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const ALL_RT: readonly AuditResourceType[] = [
  'user',
  'session',
  'config',
  'case',
  'alert',
  'report',
  'scenario',
  'rule',
  'integration',
  'system',
] as const;

function record(
  store: InMemoryAuditTrailStore,
  tenant: string,
  input: AuditEventInput,
  at: Date,
): AuditEvent {
  return store.record(tenant, input, at);
}

function listAll(store: InMemoryAuditTrailStore, tenant: string): AuditEvent[] {
  return store.list(tenant, { page_size: 1000 }).items;
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

function makeRtApp(role = 'admin') {
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

// ─── summarizeAuditByResourceType — pure ─────────────────────────────

describe('M15.12 — empty input', () => {
  test('zero events → every type row at 0 with every severity/outcome key present', () => {
    const s = summarizeAuditByResourceType('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.total_events).toBe(0);
    expect(s.types.length).toBe(ALL_RT.length);
    for (const row of s.types) {
      expect(row.total_count).toBe(0);
      expect(row.distinct_actors).toBe(0);
      expect(row.by_action_top).toEqual([]);
      expect(row.most_recent_at).toBeNull();
      expect(Object.keys(row.by_severity).length).toBe(3);
      expect(Object.keys(row.by_outcome).length).toBe(3);
    }
    expect(s.most_active_type).toBeNull();
    expect(s.unused_types).toEqual([...ALL_RT]);
    expect(s.last_event_at).toBeNull();
  });
});

describe('M15.12 — canonical type order', () => {
  test('types[] in canonical order even when zero-count', () => {
    const s = summarizeAuditByResourceType('BIL', [], NOW);
    expect(s.types.map((r) => r.resource_type)).toEqual([...ALL_RT]);
  });
});

describe('M15.12 — single event placement', () => {
  test('one config event lands in config row only', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ resource_type: 'config' }), NOW);
    const s = summarizeAuditByResourceType('BIL', listAll(store, 'BIL'), NOW);
    const cfg = s.types.find((r) => r.resource_type === 'config')!;
    expect(cfg.total_count).toBe(1);
    expect(cfg.by_outcome.success).toBe(1);
    const user = s.types.find((r) => r.resource_type === 'user')!;
    expect(user.total_count).toBe(0);
  });
});

describe('M15.12 — Σ row total_count = envelope total_events', () => {
  test('partition invariant', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ resource_type: 'config' }), NOW);
    record(store, 'BIL', baseInput({ resource_type: 'case' }), NOW);
    record(store, 'BIL', baseInput({ resource_type: 'config' }), NOW);
    const s = summarizeAuditByResourceType('BIL', listAll(store, 'BIL'), NOW);
    const sum = s.types.reduce((acc, r) => acc + r.total_count, 0);
    expect(sum).toBe(s.total_events);
    expect(s.total_events).toBe(3);
  });
});

describe('M15.12 — by_severity partition', () => {
  test('Σ by_severity per row = row.total_count', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ resource_type: 'config', severity: 'critical' }), NOW);
    record(store, 'BIL', baseInput({ resource_type: 'config', severity: 'warning' }), NOW);
    record(store, 'BIL', baseInput({ resource_type: 'config', severity: 'info' }), NOW);
    const s = summarizeAuditByResourceType('BIL', listAll(store, 'BIL'), NOW);
    const cfg = s.types.find((r) => r.resource_type === 'config')!;
    const sum = Object.values(cfg.by_severity).reduce((a, b) => a + b, 0);
    expect(sum).toBe(cfg.total_count);
  });
});

describe('M15.12 — by_outcome partition', () => {
  test('Σ by_outcome per row = row.total_count', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ resource_type: 'config', outcome: 'success' }), NOW);
    record(store, 'BIL', baseInput({ resource_type: 'config', outcome: 'failure' }), NOW);
    record(store, 'BIL', baseInput({ resource_type: 'config', outcome: 'denied' }), NOW);
    const s = summarizeAuditByResourceType('BIL', listAll(store, 'BIL'), NOW);
    const cfg = s.types.find((r) => r.resource_type === 'config')!;
    const sum = Object.values(cfg.by_outcome).reduce((a, b) => a + b, 0);
    expect(sum).toBe(cfg.total_count);
  });
});

describe('M15.12 — by_action_top', () => {
  test('top 5 sorted by count desc with action asc tie-break', () => {
    const store = new InMemoryAuditTrailStore();
    for (let i = 0; i < 5; i++) record(store, 'BIL', baseInput({ resource_type: 'case', action: 'most' }), NOW);
    for (let i = 0; i < 4; i++) record(store, 'BIL', baseInput({ resource_type: 'case', action: 'second' }), NOW);
    for (let i = 0; i < 1; i++) record(store, 'BIL', baseInput({ resource_type: 'case', action: 'a' }), NOW);
    for (let i = 0; i < 1; i++) record(store, 'BIL', baseInput({ resource_type: 'case', action: 'b' }), NOW);
    for (let i = 0; i < 1; i++) record(store, 'BIL', baseInput({ resource_type: 'case', action: 'c' }), NOW);
    for (let i = 0; i < 1; i++) record(store, 'BIL', baseInput({ resource_type: 'case', action: 'd' }), NOW);
    const s = summarizeAuditByResourceType('BIL', listAll(store, 'BIL'), NOW);
    const caseRow = s.types.find((r) => r.resource_type === 'case')!;
    expect(caseRow.by_action_top.length).toBe(5);
    expect(caseRow.by_action_top[0]).toEqual({ action: 'most', count: 5 });
    expect(caseRow.by_action_top[1]).toEqual({ action: 'second', count: 4 });
    expect(caseRow.by_action_top[2]!.action).toBe('a');
    expect(caseRow.by_action_top[4]!.action).toBe('c');
  });
});

describe('M15.12 — distinct_actors counter', () => {
  test('counts distinct actor_username per row', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ resource_type: 'config', actor_username: 'alice' }), NOW);
    record(store, 'BIL', baseInput({ resource_type: 'config', actor_username: 'alice' }), NOW);
    record(store, 'BIL', baseInput({ resource_type: 'config', actor_username: 'bob' }), NOW);
    const s = summarizeAuditByResourceType('BIL', listAll(store, 'BIL'), NOW);
    const cfg = s.types.find((r) => r.resource_type === 'config')!;
    expect(cfg.distinct_actors).toBe(2);
  });
});

describe('M15.12 — most_recent_at = newest in bucket', () => {
  test('takes newest event ts for that resource_type', () => {
    const store = new InMemoryAuditTrailStore();
    const t1 = new Date('2026-05-01T00:00:00Z');
    const t2 = new Date('2026-05-10T00:00:00Z');
    const t3 = new Date('2026-05-05T00:00:00Z');
    record(store, 'BIL', baseInput({ resource_type: 'case' }), t1);
    record(store, 'BIL', baseInput({ resource_type: 'case' }), t2);
    record(store, 'BIL', baseInput({ resource_type: 'case' }), t3);
    const s = summarizeAuditByResourceType('BIL', listAll(store, 'BIL'), NOW);
    const caseRow = s.types.find((r) => r.resource_type === 'case')!;
    expect(caseRow.most_recent_at).toBe(t2.toISOString());
  });
});

describe('M15.12 — most_active_type', () => {
  test('points at row with highest total_count', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ resource_type: 'config' }), NOW);
    record(store, 'BIL', baseInput({ resource_type: 'case' }), NOW);
    record(store, 'BIL', baseInput({ resource_type: 'case' }), NOW);
    const s = summarizeAuditByResourceType('BIL', listAll(store, 'BIL'), NOW);
    expect(s.most_active_type).toBe('case');
  });

  test('canonical tie-break: user wins over session at same count', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ resource_type: 'session' }), NOW);
    record(store, 'BIL', baseInput({ resource_type: 'user' }), NOW);
    const s = summarizeAuditByResourceType('BIL', listAll(store, 'BIL'), NOW);
    expect(s.most_active_type).toBe('user');
  });

  test('null when no events', () => {
    const s = summarizeAuditByResourceType('BIL', [], NOW);
    expect(s.most_active_type).toBeNull();
  });
});

describe('M15.12 — unused_types', () => {
  test('zero-count types in canonical order', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ resource_type: 'config' }), NOW);
    const s = summarizeAuditByResourceType('BIL', listAll(store, 'BIL'), NOW);
    expect(s.unused_types).toEqual(
      ALL_RT.filter((rt) => rt !== 'config'),
    );
  });
});

describe('M15.12 — last_event_at across all events', () => {
  test('takes max ts across the whole chain regardless of type', () => {
    const store = new InMemoryAuditTrailStore();
    record(store, 'BIL', baseInput({ resource_type: 'config' }), new Date('2026-05-01T00:00:00Z'));
    record(store, 'BIL', baseInput({ resource_type: 'case' }), new Date('2026-05-15T00:00:00Z'));
    record(store, 'BIL', baseInput({ resource_type: 'user' }), new Date('2026-05-10T00:00:00Z'));
    const s = summarizeAuditByResourceType('BIL', listAll(store, 'BIL'), NOW);
    expect(s.last_event_at).toBe('2026-05-15T00:00:00.000Z');
  });

  test('null when no events', () => {
    const s = summarizeAuditByResourceType('BIL', [], NOW);
    expect(s.last_event_at).toBeNull();
  });
});

// ─── GET /v1/audit/resource-type-distribution ────────────────────────

describe('M15.12 — GET /v1/audit/resource-type-distribution', () => {
  test('admin → 200 with empty rollup on fresh tenant', async () => {
    const { app } = makeRtApp('admin');
    const r = await request(app).get('/v1/audit/resource-type-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
    expect(r.body.body.types.length).toBe(10);
    expect(r.body.body.most_active_type).toBeNull();
  });

  test('populated rollup reflects recorded events', async () => {
    const { app, auditTrailStore } = makeRtApp('admin');
    record(auditTrailStore, 'BIL', baseInput({ resource_type: 'config' }), NOW);
    record(auditTrailStore, 'BIL', baseInput({ resource_type: 'case' }), NOW);
    const r = await request(app).get('/v1/audit/resource-type-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(2);
    const cfgRow = r.body.body.types.find((t: { resource_type: string }) => t.resource_type === 'config');
    expect(cfgRow.total_count).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRtApp('case_owner');
    const r = await request(app).get('/v1/audit/resource-type-distribution').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL events invisible to BANK_DEMO', async () => {
    const { app, auditTrailStore } = makeRtApp('admin');
    record(auditTrailStore, 'BIL', baseInput({ resource_type: 'config' }), NOW);
    const bank = await request(app)
      .get('/v1/audit/resource-type-distribution')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_events).toBe(0);
  });

  test('M15.9 /v1/audit/severity-distribution still works (sibling regression)', async () => {
    const { app } = makeRtApp('admin');
    const r = await request(app).get('/v1/audit/severity-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
