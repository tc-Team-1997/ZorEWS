// T6 M15.18 — Audit per-resource hot-spot rollup tests.

import request from 'supertest';
import {
  AuditResourceHotspotsError,
  DEFAULT_HOTSPOT_LIMIT,
  MAX_HOTSPOT_LIMIT,
  MIN_HOTSPOT_LIMIT,
  summarizeAuditResourceHotspots,
} from '../src/audit_resource_hotspots';
import {
  InMemoryAuditTrailStore,
  type AuditEvent,
  type AuditResourceType,
} from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T19:00:00.000Z');
const H_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeEvent(
  overrides: Partial<AuditEvent> & {
    resource_type: AuditResourceType;
    resource_id: string;
    actor_username?: string;
    action?: string;
    ts?: string;
  },
): AuditEvent {
  return {
    event_id: `ev-${Math.random().toString(36).slice(2, 10)}`,
    ts: NOW.toISOString(),
    tenant_id: 'BIL',
    actor_username: overrides.actor_username ?? 'alice',
    actor_role: 'admin',
    action: overrides.action ?? 'config.update',
    outcome: 'success',
    severity: 'info',
    correlation_id: null,
    ip_address: null,
    metadata: {},
    hash: '',
    prev_hash: '',
    ...overrides,
  } as AuditEvent;
}

describe('summarizeAuditResourceHotspots — validation', () => {
  test('rejects limit < MIN', () => {
    expect(() =>
      summarizeAuditResourceHotspots('BIL', [], NOW, 0),
    ).toThrow(AuditResourceHotspotsError);
  });

  test('rejects limit > MAX', () => {
    expect(() =>
      summarizeAuditResourceHotspots('BIL', [], NOW, MAX_HOTSPOT_LIMIT + 1),
    ).toThrow(AuditResourceHotspotsError);
  });

  test('rejects non-integer limit', () => {
    expect(() =>
      summarizeAuditResourceHotspots('BIL', [], NOW, 20.5),
    ).toThrow(AuditResourceHotspotsError);
  });

  test('accepts MIN + MAX boundaries', () => {
    expect(() =>
      summarizeAuditResourceHotspots('BIL', [], NOW, MIN_HOTSPOT_LIMIT),
    ).not.toThrow();
    expect(() =>
      summarizeAuditResourceHotspots('BIL', [], NOW, MAX_HOTSPOT_LIMIT),
    ).not.toThrow();
  });

  test('threshold constants exported', () => {
    expect(MIN_HOTSPOT_LIMIT).toBe(1);
    expect(MAX_HOTSPOT_LIMIT).toBe(200);
    expect(DEFAULT_HOTSPOT_LIMIT).toBe(20);
  });
});

describe('summarizeAuditResourceHotspots — empty input', () => {
  test('zero counts + null hottest + 10 RT keys at 0', () => {
    const r = summarizeAuditResourceHotspots('BIL', [], NOW);
    expect(r.total_events).toBe(0);
    expect(r.total_resources).toBe(0);
    expect(r.top_hotspots).toEqual([]);
    expect(r.hottest_resource).toBeNull();
    // 10 AuditResourceType keys all at 0.
    expect(Object.keys(r.by_resource_type)).toHaveLength(10);
    for (const v of Object.values(r.by_resource_type)) {
      expect(v).toBe(0);
    }
  });

  test('echoes limit', () => {
    const r = summarizeAuditResourceHotspots('BIL', [], NOW, 50);
    expect(r.limit).toBe(50);
  });
});

describe('summarizeAuditResourceHotspots — aggregation', () => {
  test('single event creates 1 hotspot', () => {
    const r = summarizeAuditResourceHotspots(
      'BIL',
      [makeEvent({ resource_type: 'case', resource_id: 'CASE-1' })],
      NOW,
    );
    expect(r.total_events).toBe(1);
    expect(r.total_resources).toBe(1);
    expect(r.top_hotspots[0].resource_type).toBe('case');
    expect(r.top_hotspots[0].resource_id).toBe('CASE-1');
    expect(r.top_hotspots[0].total_events).toBe(1);
    expect(r.hottest_resource).toEqual({
      resource_type: 'case',
      resource_id: 'CASE-1',
      total_events: 1,
    });
  });

  test('multiple events on same resource accumulate', () => {
    const r = summarizeAuditResourceHotspots(
      'BIL',
      [
        makeEvent({ resource_type: 'case', resource_id: 'CASE-1', actor_username: 'alice', action: 'case.assign' }),
        makeEvent({ resource_type: 'case', resource_id: 'CASE-1', actor_username: 'bob', action: 'case.close' }),
        makeEvent({ resource_type: 'case', resource_id: 'CASE-1', actor_username: 'alice', action: 'case.note' }),
      ],
      NOW,
    );
    expect(r.total_resources).toBe(1);
    expect(r.top_hotspots[0].total_events).toBe(3);
    expect(r.top_hotspots[0].distinct_actors).toBe(2);
    expect(r.top_hotspots[0].actors).toEqual(['alice', 'bob']);
    expect(r.top_hotspots[0].distinct_actions).toBe(3);
    expect(r.top_hotspots[0].actions).toEqual(['case.assign', 'case.close', 'case.note']);
  });

  test('different resource_ids create separate hotspots', () => {
    const r = summarizeAuditResourceHotspots(
      'BIL',
      [
        makeEvent({ resource_type: 'case', resource_id: 'CASE-1' }),
        makeEvent({ resource_type: 'case', resource_id: 'CASE-2' }),
      ],
      NOW,
    );
    expect(r.total_resources).toBe(2);
  });

  test('same resource_id with different resource_types stays separate', () => {
    const r = summarizeAuditResourceHotspots(
      'BIL',
      [
        makeEvent({ resource_type: 'case', resource_id: 'X-1' }),
        makeEvent({ resource_type: 'alert', resource_id: 'X-1' }),
      ],
      NOW,
    );
    expect(r.total_resources).toBe(2);
  });

  test('sorted by total_events desc', () => {
    const r = summarizeAuditResourceHotspots(
      'BIL',
      [
        makeEvent({ resource_type: 'case', resource_id: 'CASE-A' }),
        makeEvent({ resource_type: 'case', resource_id: 'CASE-B' }),
        makeEvent({ resource_type: 'case', resource_id: 'CASE-B' }),
        makeEvent({ resource_type: 'case', resource_id: 'CASE-B' }),
        makeEvent({ resource_type: 'case', resource_id: 'CASE-C' }),
        makeEvent({ resource_type: 'case', resource_id: 'CASE-C' }),
      ],
      NOW,
    );
    expect(r.top_hotspots[0].resource_id).toBe('CASE-B');
    expect(r.top_hotspots[0].total_events).toBe(3);
    expect(r.top_hotspots[1].resource_id).toBe('CASE-C');
    expect(r.top_hotspots[2].resource_id).toBe('CASE-A');
  });

  test('canonical resource_type asc + resource_id asc tie-break at tied count', () => {
    const r = summarizeAuditResourceHotspots(
      'BIL',
      [
        makeEvent({ resource_type: 'case', resource_id: 'zebra' }),
        makeEvent({ resource_type: 'case', resource_id: 'alpha' }),
        makeEvent({ resource_type: 'alert', resource_id: 'mango' }),
      ],
      NOW,
    );
    // All 3 hotspots tied at count=1. Sort by resource_type asc:
    // 'alert' < 'case'. Within 'case', resource_id asc.
    expect(r.top_hotspots[0].resource_type).toBe('alert');
    expect(r.top_hotspots[1].resource_id).toBe('alpha');
    expect(r.top_hotspots[2].resource_id).toBe('zebra');
  });

  test('by_resource_type marginal totals match Σ events', () => {
    const r = summarizeAuditResourceHotspots(
      'BIL',
      [
        makeEvent({ resource_type: 'case', resource_id: 'C-1' }),
        makeEvent({ resource_type: 'case', resource_id: 'C-2' }),
        makeEvent({ resource_type: 'alert', resource_id: 'A-1' }),
      ],
      NOW,
    );
    expect(r.by_resource_type.case).toBe(2);
    expect(r.by_resource_type.alert).toBe(1);
    expect(r.by_resource_type.user).toBe(0);
    const sum = Object.values(r.by_resource_type).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.total_events);
  });

  test('first_event_at + last_event_at min/max across events', () => {
    const r = summarizeAuditResourceHotspots(
      'BIL',
      [
        makeEvent({ resource_type: 'case', resource_id: 'CASE-1', ts: '2026-05-21T10:00:00Z' }),
        makeEvent({ resource_type: 'case', resource_id: 'CASE-1', ts: '2026-05-21T08:00:00Z' }),
        makeEvent({ resource_type: 'case', resource_id: 'CASE-1', ts: '2026-05-21T15:00:00Z' }),
      ],
      NOW,
    );
    expect(r.top_hotspots[0].first_event_at).toBe('2026-05-21T08:00:00Z');
    expect(r.top_hotspots[0].last_event_at).toBe('2026-05-21T15:00:00Z');
  });

  test('limit caps top_hotspots[] size', () => {
    const events: AuditEvent[] = [];
    for (let i = 0; i < 50; i += 1) {
      events.push(
        makeEvent({
          resource_type: 'case',
          resource_id: `CASE-${String(i).padStart(3, '0')}`,
        }),
      );
    }
    const r = summarizeAuditResourceHotspots('BIL', events, NOW, 10);
    expect(r.total_resources).toBe(50);
    expect(r.top_hotspots).toHaveLength(10);
  });

  test('actors[] + actions[] capped at 50 + sorted asc', () => {
    const events: AuditEvent[] = [];
    for (let i = 0; i < 60; i += 1) {
      events.push(
        makeEvent({
          resource_type: 'case',
          resource_id: 'CASE-X',
          actor_username: `user-${String(i).padStart(3, '0')}`,
          action: `action.${String(i).padStart(3, '0')}`,
        }),
      );
    }
    const r = summarizeAuditResourceHotspots('BIL', events, NOW);
    expect(r.top_hotspots[0].actors).toHaveLength(50);
    expect(r.top_hotspots[0].actions).toHaveLength(50);
    // Sorted asc.
    for (let i = 1; i < r.top_hotspots[0].actors.length; i += 1) {
      expect(r.top_hotspots[0].actors[i - 1] <= r.top_hotspots[0].actors[i]).toBe(true);
    }
  });

  test('empty resource_id defensively skipped', () => {
    const r = summarizeAuditResourceHotspots(
      'BIL',
      [
        makeEvent({ resource_type: 'case', resource_id: '' }),
        makeEvent({ resource_type: 'case', resource_id: 'CASE-1' }),
      ],
      NOW,
    );
    expect(r.total_events).toBe(1);
    expect(r.total_resources).toBe(1);
  });

  test('empty actor_username does not pollute distinct_actors', () => {
    const r = summarizeAuditResourceHotspots(
      'BIL',
      [
        makeEvent({ resource_type: 'case', resource_id: 'CASE-1', actor_username: '' }),
        makeEvent({ resource_type: 'case', resource_id: 'CASE-1', actor_username: 'alice' }),
      ],
      NOW,
    );
    expect(r.top_hotspots[0].distinct_actors).toBe(1);
    expect(r.top_hotspots[0].actors).toEqual(['alice']);
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

function makeRouteApp(role: string = 'admin', store?: InMemoryAuditTrailStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    auditTrailStore: store,
  });
}

describe('GET /v1/audit/resource-hotspots', () => {
  test('admin happy path with empty store', async () => {
    const store = new InMemoryAuditTrailStore();
    const { app } = makeRouteApp('admin', store);
    const r = await request(app).get('/v1/audit/resource-hotspots').set(H_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
    expect(r.body.body.top_hotspots).toEqual([]);
    expect(r.body.body.hottest_resource).toBeNull();
  });

  test('?limit=5 narrows top_hotspots', async () => {
    const store = new InMemoryAuditTrailStore();
    for (let i = 0; i < 10; i += 1) {
      store.record('BIL', {
        actor_username: 'alice',
        actor_role: 'admin',
        action: 'config.update',
        resource_type: 'case',
        resource_id: `CASE-${i}`,
        outcome: 'success',
      }, NOW);
    }
    const { app } = makeRouteApp('admin', store);
    const r = await request(app).get('/v1/audit/resource-hotspots?limit=5').set(H_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.limit).toBe(5);
    expect(r.body.body.top_hotspots).toHaveLength(5);
    expect(r.body.body.total_resources).toBe(10);
  });

  test('?limit=0 → 400 EWS_400_invalid_input', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app).get('/v1/audit/resource-hotspots?limit=0').set(H_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('EWS_400_invalid_input');
  });

  test('?limit=300 → 400 (over MAX)', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app).get('/v1/audit/resource-hotspots?limit=300').set(H_BIL);
    expect(r.status).toBe(400);
  });

  test('populated reflects hottest_resource', async () => {
    const store = new InMemoryAuditTrailStore();
    // CASE-HOT gets 3 events; CASE-COLD gets 1.
    for (let i = 0; i < 3; i += 1) {
      store.record('BIL', {
        actor_username: 'alice',
        actor_role: 'admin',
        action: 'case.update',
        resource_type: 'case',
        resource_id: 'CASE-HOT',
        outcome: 'success',
      }, NOW);
    }
    store.record('BIL', {
      actor_username: 'bob',
      actor_role: 'admin',
      action: 'case.update',
      resource_type: 'case',
      resource_id: 'CASE-COLD',
      outcome: 'success',
    }, NOW);
    const { app } = makeRouteApp('admin', store);
    const r = await request(app).get('/v1/audit/resource-hotspots').set(H_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.hottest_resource.resource_id).toBe('CASE-HOT');
    expect(r.body.body.hottest_resource.total_events).toBe(3);
    expect(r.body.body.total_resources).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRouteApp('field_officer');
    const r = await request(app).get('/v1/audit/resource-hotspots').set(H_BIL);
    expect(r.status).toBe(403);
  });

  test('tenant-scoped — BIL store invisible to BANK_DEMO request', async () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', {
      actor_username: 'alice',
      actor_role: 'admin',
      action: 'config.update',
      resource_type: 'case',
      resource_id: 'CASE-1',
      outcome: 'success',
    }, NOW);
    const { app } = makeRouteApp('admin', store);
    const r = await request(app)
      .get('/v1/audit/resource-hotspots')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
  });

  test('missing tenant header → 400', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app).get('/v1/audit/resource-hotspots');
    expect(r.status).toBe(400);
  });
});
