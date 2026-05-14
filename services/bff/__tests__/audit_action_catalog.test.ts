// services/bff/__tests__/audit_action_catalog.test.ts
//
// T6 M15.6 — Audit action catalog introspection.

import request from 'supertest';
import { introspectAuditCatalog } from '../src/audit_action_catalog';
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

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

let seq = 0;
function mkEvent(o: Partial<AuditEvent> & { action: string }): AuditEvent {
  seq += 1;
  return {
    event_id: o.event_id ?? `evt-${seq}`,
    ts: o.ts ?? NOW.toISOString(),
    tenant_id: o.tenant_id ?? 'BIL',
    actor_username: o.actor_username ?? 'alice',
    actor_role: o.actor_role ?? 'admin',
    action: o.action,
    resource_type: o.resource_type ?? 'system',
    resource_id: o.resource_id ?? 'r1',
    outcome: o.outcome ?? 'success',
    severity: o.severity ?? 'info',
    correlation_id: o.correlation_id ?? '',
    ip_address: o.ip_address ?? '',
    metadata: o.metadata ?? {},
    prev_hash: o.prev_hash ?? 'GENESIS',
    hash: o.hash ?? 'h' + seq,
  };
}

beforeEach(() => {
  seq = 0;
});

// ─── introspectAuditCatalog — pure ───────────────────────────────────

describe('M15.6 — introspectAuditCatalog — empty', () => {
  test('empty events → zero envelope', () => {
    const out = introspectAuditCatalog([]);
    expect(out.total_events).toBe(0);
    expect(out.distinct_actions).toBe(0);
    expect(out.actions).toEqual([]);
  });
});

describe('M15.6 — grouping by action', () => {
  test('multiple events with the same action collapse into one catalog entry', () => {
    const events: AuditEvent[] = [
      mkEvent({ action: 'login' }),
      mkEvent({ action: 'login' }),
      mkEvent({ action: 'login' }),
      mkEvent({ action: 'logout' }),
    ];
    const out = introspectAuditCatalog(events);
    expect(out.distinct_actions).toBe(2);
    const login = out.actions.find((a) => a.action === 'login')!;
    const logout = out.actions.find((a) => a.action === 'logout')!;
    expect(login.observed_count).toBe(3);
    expect(logout.observed_count).toBe(1);
  });

  test('actions sorted by observed_count desc, ties broken alphabetically', () => {
    const events: AuditEvent[] = [
      mkEvent({ action: 'config.update' }),
      mkEvent({ action: 'config.update' }),
      mkEvent({ action: 'config.update' }),
      mkEvent({ action: 'scenario.create' }),
      mkEvent({ action: 'scenario.create' }),
      mkEvent({ action: 'alert.update' }),
      mkEvent({ action: 'alert.update' }),
    ];
    const out = introspectAuditCatalog(events);
    // config.update (3), then alert.update + scenario.create tied at 2 → alpha order alert.update first
    expect(out.actions.map((a) => a.action)).toEqual([
      'config.update',
      'alert.update',
      'scenario.create',
    ]);
  });
});

describe('M15.6 — metadata_keys union', () => {
  test('union across events surfaces every observed metadata key', () => {
    const events: AuditEvent[] = [
      mkEvent({ action: 'config.update', metadata: { previous_value: 4, key: 'x' } }),
      mkEvent({ action: 'config.update', metadata: { new_value: 8, key: 'y' } }),
    ];
    const out = introspectAuditCatalog(events);
    expect(out.actions[0]!.metadata_keys).toEqual(['key', 'new_value', 'previous_value']);
  });

  test('events with no metadata → metadata_keys stays empty', () => {
    const events: AuditEvent[] = [mkEvent({ action: 'noop', metadata: {} })];
    const out = introspectAuditCatalog(events);
    expect(out.actions[0]!.metadata_keys).toEqual([]);
  });
});

describe('M15.6 — distinct_resource_types', () => {
  test('captures every distinct resource_type seen, sorted asc', () => {
    const events: AuditEvent[] = [
      mkEvent({ action: 'delete', resource_type: 'scenario' }),
      mkEvent({ action: 'delete', resource_type: 'case' }),
      mkEvent({ action: 'delete', resource_type: 'scenario' }),
    ];
    const out = introspectAuditCatalog(events);
    expect(out.actions[0]!.distinct_resource_types).toEqual(['case', 'scenario']);
  });
});

describe('M15.6 — recency', () => {
  test('latest_event_at + last_actor track newest event with that action', () => {
    const events: AuditEvent[] = [
      mkEvent({ action: 'login', ts: '2026-05-14T08:00:00.000Z', actor_username: 'alice' }),
      mkEvent({ action: 'login', ts: '2026-05-14T12:00:00.000Z', actor_username: 'bob' }),
      mkEvent({ action: 'login', ts: '2026-05-14T10:00:00.000Z', actor_username: 'carol' }),
    ];
    const out = introspectAuditCatalog(events);
    expect(out.actions[0]!.latest_event_at).toBe('2026-05-14T12:00:00.000Z');
    expect(out.actions[0]!.last_actor).toBe('bob');
  });
});

// ─── GET /v1/audit/catalog ───────────────────────────────────────────

function makeCatalogApp(role = 'admin') {
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

function recordEvent(
  store: InMemoryAuditTrailStore,
  tenant: string,
  input: Partial<AuditEventInput> & { action: string },
) {
  return store.record(
    tenant,
    {
      actor_username: input.actor_username ?? 'alice',
      actor_role: input.actor_role ?? 'admin',
      action: input.action,
      resource_type: input.resource_type ?? 'system',
      resource_id: input.resource_id ?? 'r1',
      outcome: input.outcome ?? 'success',
      severity: input.severity ?? 'info',
      metadata: input.metadata ?? {},
    },
    NOW,
  );
}

describe('M15.6 — GET /v1/audit/catalog', () => {
  test('empty tenant → 200 zero envelope', async () => {
    const { app } = makeCatalogApp('admin');
    const r = await request(app).get('/v1/audit/catalog').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
    expect(r.body.body.distinct_actions).toBe(0);
  });

  test('records surface in the catalog', async () => {
    const { app, auditTrailStore } = makeCatalogApp('admin');
    recordEvent(auditTrailStore, 'BIL', { action: 'config.update', metadata: { key: 'x' } });
    recordEvent(auditTrailStore, 'BIL', { action: 'config.update', metadata: { previous_value: 4 } });
    recordEvent(auditTrailStore, 'BIL', { action: 'scenario.create' });
    const r = await request(app).get('/v1/audit/catalog').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.distinct_actions).toBe(2);
    const cfg = r.body.body.actions.find(
      (a: { action: string }) => a.action === 'config.update',
    );
    expect(cfg.observed_count).toBe(2);
    expect(cfg.metadata_keys).toEqual(['key', 'previous_value']);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCatalogApp('case_owner');
    const r = await request(app).get('/v1/audit/catalog').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL events invisible to BANK_DEMO', async () => {
    const { app, auditTrailStore } = makeCatalogApp('admin');
    recordEvent(auditTrailStore, 'BIL', { action: 'config.update' });
    const r = await request(app)
      .get('/v1/audit/catalog')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
  });

  test('M15.1 /v1/audit/events still works (catalog route is additive)', async () => {
    const { app } = makeCatalogApp('admin');
    const r = await request(app).get('/v1/audit/events').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
