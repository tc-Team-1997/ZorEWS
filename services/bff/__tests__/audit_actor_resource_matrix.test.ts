// services/bff/__tests__/audit_actor_resource_matrix.test.ts
//
// T6 M15.19 — Audit actor × resource_type cross-tab matrix.

import request from 'supertest';
import { buildAuditActorResourceMatrix } from '../src/audit_actor_resource_matrix';
import { ALL_AUDIT_RESOURCE_TYPES } from '../src/audit_resource_severity_matrix';
import {
  InMemoryAuditTrailStore,
  type AuditEvent,
  type AuditResourceType,
  type AuditTrailStore,
} from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-28T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeTestApp(role: string = 'admin', auditTrailStore?: AuditTrailStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    auditTrailStore,
  });
}

let nextEvtSeq = 1;
function makeEvent(
  actor_username: string,
  resource_type: AuditResourceType,
  overrides: Partial<AuditEvent> = {},
): AuditEvent {
  return {
    event_id: `evt-${nextEvtSeq++}`,
    ts: NOW.toISOString(),
    tenant_id: 'BIL',
    actor_username,
    actor_role: 'admin',
    action: 'config.update',
    resource_type,
    resource_id: 'res-1',
    outcome: 'success',
    severity: 'info',
    correlation_id: null,
    ip_address: null,
    metadata: {},
    hash: 'hash',
    prev_hash: 'GENESIS',
    ...overrides,
  };
}

// ─── Pure resolver ─────────────────────────────────────────────────────

describe('M15.19 — buildAuditActorResourceMatrix', () => {
  test('empty input → empty matrix', () => {
    const m = buildAuditActorResourceMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.total_events).toBe(0);
    expect(m.total_events_observed).toBe(0);
    expect(m.actors).toEqual([]);
    expect(m.rows).toEqual([]);
    expect(m.columns.length).toBe(10); // every resource_type emitted
    for (const col of m.columns) {
      expect(col.total).toBe(0);
      expect(col.by_actor).toEqual({});
      expect(col.actors_without).toEqual([]);
      expect(col.distinct_actors).toBe(0);
    }
    expect(m.peak_cell).toBeNull();
    expect(m.most_versatile_actor).toBeNull();
    expect(m.most_touched_resource_type).toBeNull();
    expect(m.empty_cells).toEqual([]);
    expect(m.total_resource_types).toBe(10);
  });

  test('single event lands in correct cell', () => {
    const m = buildAuditActorResourceMatrix(
      'BIL',
      [makeEvent('alice', 'config')],
      NOW,
    );
    expect(m.total_events).toBe(1);
    expect(m.actors).toEqual(['alice']);
    expect(m.rows.length).toBe(1);
    expect(m.rows[0].actor_username).toBe('alice');
    expect(m.rows[0].total).toBe(1);
    expect(m.rows[0].by_resource_type.config).toBe(1);
    expect(m.rows[0].by_resource_type.alert).toBe(0);
    expect(m.rows[0].distinct_resource_types).toBe(1);

    const configCol = m.columns.find((c) => c.resource_type === 'config')!;
    expect(configCol.total).toBe(1);
    expect(configCol.by_actor['alice']).toBe(1);
    expect(configCol.distinct_actors).toBe(1);
  });

  test('columns in canonical ALL_AUDIT_RESOURCE_TYPES order', () => {
    const m = buildAuditActorResourceMatrix('BIL', [], NOW);
    expect(m.columns.map((c) => c.resource_type)).toEqual([
      ...ALL_AUDIT_RESOURCE_TYPES,
    ]);
  });

  test('rows sorted asc by actor_username', () => {
    const events = [
      makeEvent('zoe', 'config'),
      makeEvent('alice', 'user'),
      makeEvent('mike', 'alert'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    expect(m.actors).toEqual(['alice', 'mike', 'zoe']);
    expect(m.rows.map((r) => r.actor_username)).toEqual(['alice', 'mike', 'zoe']);
  });

  test('every by_resource_type key present per row (10 keys)', () => {
    const m = buildAuditActorResourceMatrix(
      'BIL',
      [makeEvent('alice', 'config')],
      NOW,
    );
    const row = m.rows[0];
    for (const rt of ALL_AUDIT_RESOURCE_TYPES) {
      expect(row.by_resource_type[rt]).toBeGreaterThanOrEqual(0);
    }
    expect(Object.keys(row.by_resource_type).length).toBe(10);
  });

  test('Σ row.by_resource_type = row.total partition invariant', () => {
    const events = [
      makeEvent('alice', 'user'),
      makeEvent('alice', 'user'),
      makeEvent('alice', 'session'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    const row = m.rows[0];
    const sum = ALL_AUDIT_RESOURCE_TYPES.reduce(
      (a, rt) => a + row.by_resource_type[rt],
      0,
    );
    expect(sum).toBe(row.total);
    expect(sum).toBe(3);
  });

  test('Σ col.by_actor = col.total partition invariant', () => {
    const events = [
      makeEvent('alice', 'config'),
      makeEvent('bob', 'config'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    const col = m.columns.find((c) => c.resource_type === 'config')!;
    const sum = Object.values(col.by_actor).reduce((a, n) => a + n, 0);
    expect(sum).toBe(col.total);
    expect(sum).toBe(2);
  });

  test('grand-total cross-check Σ rows = Σ cols = total_events', () => {
    const events = [
      makeEvent('alice', 'user'),
      makeEvent('bob', 'config'),
      makeEvent('carol', 'alert'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    const rowSum = m.rows.reduce((a, r) => a + r.total, 0);
    const colSum = m.columns.reduce((a, c) => a + c.total, 0);
    expect(rowSum).toBe(m.total_events);
    expect(colSum).toBe(m.total_events);
    expect(rowSum).toBe(3);
  });

  test('cell cross-check: row.by_resource_type[X] === col[X].by_actor[actor]', () => {
    const events = [
      makeEvent('alice', 'user'),
      makeEvent('alice', 'user'),
      makeEvent('alice', 'config'),
      makeEvent('bob', 'config'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    for (const row of m.rows) {
      for (const rt of ALL_AUDIT_RESOURCE_TYPES) {
        const fromRow = row.by_resource_type[rt];
        const col = m.columns.find((c) => c.resource_type === rt)!;
        const fromCol = col.by_actor[row.actor_username] ?? 0;
        expect(fromRow).toBe(fromCol);
      }
    }
  });

  test('resource_types_without per row in canonical order', () => {
    const events = [makeEvent('alice', 'config')];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    const row = m.rows[0];
    expect(row.resource_types_without.length).toBe(9);
    expect(row.resource_types_without).not.toContain('config');
    const idx = row.resource_types_without.map((rt) =>
      ALL_AUDIT_RESOURCE_TYPES.indexOf(rt),
    );
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  test('actors_without per col includes other observed actors', () => {
    const events = [
      makeEvent('alice', 'config'),
      makeEvent('bob', 'user'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    const configCol = m.columns.find((c) => c.resource_type === 'config')!;
    // 'bob' was observed (against user) but not against config
    expect(configCol.actors_without).toEqual(['bob']);
    const userCol = m.columns.find((c) => c.resource_type === 'user')!;
    expect(userCol.actors_without).toEqual(['alice']);
  });

  test('peak_cell formula = highest cell count', () => {
    const events = [
      makeEvent('alice', 'user'),
      makeEvent('alice', 'user'),
      makeEvent('alice', 'user'),
      makeEvent('bob', 'session'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    expect(m.peak_cell).toEqual({
      actor_username: 'alice',
      resource_type: 'user',
      count: 3,
    });
  });

  test('peak_cell canonical iteration tie-break (actors asc × types canonical)', () => {
    const events = [
      makeEvent('zoe', 'session'),
      makeEvent('alice', 'user'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    // Both tied at 1. Canonical iteration: actors asc → 'alice' wins.
    expect(m.peak_cell?.actor_username).toBe('alice');
    expect(m.peak_cell?.resource_type).toBe('user');
  });

  test('peak_cell null on empty', () => {
    const m = buildAuditActorResourceMatrix('BIL', [], NOW);
    expect(m.peak_cell).toBeNull();
  });

  test('most_versatile_actor = highest distinct_resource_types', () => {
    const events = [
      // 'alice' touches 3 types
      makeEvent('alice', 'user'),
      makeEvent('alice', 'config'),
      makeEvent('alice', 'alert'),
      // 'bob' touches 1 type (4 times)
      makeEvent('bob', 'user'),
      makeEvent('bob', 'user'),
      makeEvent('bob', 'user'),
      makeEvent('bob', 'user'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    expect(m.most_versatile_actor).toBe('alice');
  });

  test('most_versatile_actor canonical asc tie-break', () => {
    const events = [
      makeEvent('zoe', 'user'),
      makeEvent('zoe', 'config'),
      makeEvent('alice', 'user'),
      makeEvent('alice', 'config'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    // Both touch 2 types → alice wins (asc)
    expect(m.most_versatile_actor).toBe('alice');
  });

  test('most_versatile_actor null on empty', () => {
    const m = buildAuditActorResourceMatrix('BIL', [], NOW);
    expect(m.most_versatile_actor).toBeNull();
  });

  test('most_touched_resource_type = highest distinct_actors', () => {
    const events = [
      // 'config' touched by 3 actors
      makeEvent('alice', 'config'),
      makeEvent('bob', 'config'),
      makeEvent('carol', 'config'),
      // 'user' touched by 1 actor
      makeEvent('alice', 'user'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    expect(m.most_touched_resource_type).toBe('config');
  });

  test('most_touched_resource_type canonical order tie-break', () => {
    const events = [
      // both 'user' and 'session' touched by 2 actors
      makeEvent('alice', 'user'),
      makeEvent('bob', 'user'),
      makeEvent('alice', 'session'),
      makeEvent('bob', 'session'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    // user iterates first in canonical order → wins
    expect(m.most_touched_resource_type).toBe('user');
  });

  test('most_touched_resource_type null on empty', () => {
    const m = buildAuditActorResourceMatrix('BIL', [], NOW);
    expect(m.most_touched_resource_type).toBeNull();
  });

  test('empty_cells in canonical actor × resource_type row-major order', () => {
    const events = [
      makeEvent('alice', 'user'),
      makeEvent('bob', 'config'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    // 2 actors × 10 resource_types = 20 cells; 2 populated, 18 empty
    expect(m.empty_cells.length).toBe(18);
    // alice × <every resource_type except user> first
    expect(m.empty_cells[0]).toEqual({ actor_username: 'alice', resource_type: 'session' });
    expect(m.empty_cells[8]).toEqual({ actor_username: 'alice', resource_type: 'system' });
    expect(m.empty_cells[9]).toEqual({ actor_username: 'bob', resource_type: 'user' });
  });

  test('events with empty actor_username skipped', () => {
    const events = [
      makeEvent('', 'config'),
      makeEvent('alice', 'user'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    expect(m.total_events).toBe(1);
    expect(m.actors).toEqual(['alice']);
  });

  test('events with out-of-enum resource_type skipped', () => {
    const events = [
      makeEvent('alice', 'bogus' as never),
      makeEvent('bob', 'user'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    expect(m.total_events).toBe(1);
  });

  test('total_events_observed includes skipped events', () => {
    const events = [
      makeEvent('', 'config'),
      makeEvent('alice', 'user'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    expect(m.total_events).toBe(1);
    expect(m.total_events_observed).toBe(2);
  });

  test('total_actors = actors.length', () => {
    const events = [
      makeEvent('alice', 'user'),
      makeEvent('bob', 'user'),
      makeEvent('carol', 'config'),
    ];
    const m = buildAuditActorResourceMatrix('BIL', events, NOW);
    expect(m.total_actors).toBe(3);
    expect(m.actors.length).toBe(3);
  });

  test('tenant_id + generated_at echo', () => {
    const m = buildAuditActorResourceMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M15.19 — GET /v1/audit/actor-resource-matrix', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/audit/actor-resource-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
    expect(r.body.body.actors).toEqual([]);
    expect(r.body.body.total_resource_types).toBe(10);
  });

  test('populated reflects recorded events', async () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', {
      actor_username: 'alice',
      actor_role: 'admin',
      action: 'config.update',
      resource_type: 'config',
      resource_id: 'alerts.red_sla_hours',
      outcome: 'success',
      severity: 'info',
    }, NOW);
    store.record('BIL', {
      actor_username: 'alice',
      actor_role: 'admin',
      action: 'config.update',
      resource_type: 'config',
      resource_id: 'alerts.red_sla_hours',
      outcome: 'success',
      severity: 'info',
    }, NOW);
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/audit/actor-resource-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(2);
    expect(r.body.body.peak_cell.count).toBe(2);
    expect(r.body.body.peak_cell.actor_username).toBe('alice');
    expect(r.body.body.most_versatile_actor).toBe('alice');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTestApp('case_owner');
    const r = await request(app)
      .get('/v1/audit/actor-resource-matrix')
      .set(TH);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', {
      actor_username: 'alice',
      actor_role: 'admin',
      action: 'config.update',
      resource_type: 'config',
      resource_id: 'k1',
      outcome: 'success',
      severity: 'info',
    }, NOW);
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/audit/actor-resource-matrix')
      .set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
  });

  test('M15.17 /action-resource-matrix sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/audit/action-resource-matrix')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('M15.18 /resource-hotspots sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/audit/resource-hotspots')
      .set(TH);
    expect(r.status).toBe(200);
  });
});
