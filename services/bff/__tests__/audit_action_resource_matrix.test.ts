// services/bff/__tests__/audit_action_resource_matrix.test.ts
//
// T6 M15.17 — Audit action × resource_type cross-tab matrix.

import request from 'supertest';
import { buildAuditActionResourceMatrix } from '../src/audit_action_resource_matrix';
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

const NOW = new Date('2026-05-19T12:00:00.000Z');
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
  action: string,
  resource_type: AuditResourceType,
  overrides: Partial<AuditEvent> = {},
): AuditEvent {
  return {
    event_id: `evt-${nextEvtSeq++}`,
    ts: NOW.toISOString(),
    tenant_id: 'BIL',
    actor_username: 'alice',
    actor_role: 'admin',
    action,
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

describe('M15.17 — buildAuditActionResourceMatrix', () => {
  test('empty input → empty matrix', () => {
    const m = buildAuditActionResourceMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.total_events).toBe(0);
    expect(m.total_events_observed).toBe(0);
    expect(m.actions).toEqual([]);
    expect(m.rows).toEqual([]);
    expect(m.columns.length).toBe(10); // every resource_type emitted
    for (const col of m.columns) {
      expect(col.total).toBe(0);
      expect(col.by_action).toEqual({});
      expect(col.actions_without).toEqual([]);
      expect(col.distinct_actions).toBe(0);
    }
    expect(m.peak_cell).toBeNull();
    expect(m.most_versatile_action).toBeNull();
    expect(m.most_diverse_resource_type).toBeNull();
    expect(m.empty_cells).toEqual([]);
    expect(m.total_resource_types).toBe(10);
  });

  test('single event lands in correct cell', () => {
    const m = buildAuditActionResourceMatrix(
      'BIL',
      [makeEvent('config.update', 'config')],
      NOW,
    );
    expect(m.total_events).toBe(1);
    expect(m.actions).toEqual(['config.update']);
    expect(m.rows.length).toBe(1);
    expect(m.rows[0].action).toBe('config.update');
    expect(m.rows[0].total).toBe(1);
    expect(m.rows[0].by_resource_type.config).toBe(1);
    expect(m.rows[0].by_resource_type.alert).toBe(0);
    expect(m.rows[0].distinct_resource_types).toBe(1);

    const configCol = m.columns.find((c) => c.resource_type === 'config')!;
    expect(configCol.total).toBe(1);
    expect(configCol.by_action['config.update']).toBe(1);
    expect(configCol.distinct_actions).toBe(1);
  });

  test('columns in canonical ALL_AUDIT_RESOURCE_TYPES order', () => {
    const m = buildAuditActionResourceMatrix('BIL', [], NOW);
    expect(m.columns.map((c) => c.resource_type)).toEqual([
      ...ALL_AUDIT_RESOURCE_TYPES,
    ]);
  });

  test('rows sorted asc by action', () => {
    const events = [
      makeEvent('zebra.update', 'config'),
      makeEvent('alpha.update', 'user'),
      makeEvent('mike.update', 'alert'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    expect(m.actions).toEqual(['alpha.update', 'mike.update', 'zebra.update']);
    expect(m.rows.map((r) => r.action)).toEqual([
      'alpha.update',
      'mike.update',
      'zebra.update',
    ]);
  });

  test('every by_resource_type key present per row (10 keys)', () => {
    const m = buildAuditActionResourceMatrix(
      'BIL',
      [makeEvent('config.update', 'config')],
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
      makeEvent('user.create', 'user'),
      makeEvent('user.create', 'user'),
      makeEvent('user.create', 'session'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    const row = m.rows[0];
    const sum = ALL_AUDIT_RESOURCE_TYPES.reduce(
      (a, rt) => a + row.by_resource_type[rt],
      0,
    );
    expect(sum).toBe(row.total);
    expect(sum).toBe(3);
  });

  test('Σ col.by_action = col.total partition invariant', () => {
    const events = [
      makeEvent('config.update', 'config'),
      makeEvent('config.reset', 'config'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    const col = m.columns.find((c) => c.resource_type === 'config')!;
    const sum = Object.values(col.by_action).reduce((a, n) => a + n, 0);
    expect(sum).toBe(col.total);
    expect(sum).toBe(2);
  });

  test('grand-total cross-check Σ rows = Σ cols = total_events', () => {
    const events = [
      makeEvent('a', 'user'),
      makeEvent('b', 'config'),
      makeEvent('c', 'alert'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    const rowSum = m.rows.reduce((a, r) => a + r.total, 0);
    const colSum = m.columns.reduce((a, c) => a + c.total, 0);
    expect(rowSum).toBe(m.total_events);
    expect(colSum).toBe(m.total_events);
    expect(rowSum).toBe(3);
  });

  test('cell cross-check: row.by_resource_type[X] === col[X].by_action[action]', () => {
    const events = [
      makeEvent('a.update', 'user'),
      makeEvent('a.update', 'user'),
      makeEvent('a.update', 'config'),
      makeEvent('b.update', 'config'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    for (const row of m.rows) {
      for (const rt of ALL_AUDIT_RESOURCE_TYPES) {
        const fromRow = row.by_resource_type[rt];
        const col = m.columns.find((c) => c.resource_type === rt)!;
        const fromCol = col.by_action[row.action] ?? 0;
        expect(fromRow).toBe(fromCol);
      }
    }
  });

  test('resource_types_without per row in canonical order', () => {
    const events = [makeEvent('a.update', 'config')];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    const row = m.rows[0];
    expect(row.resource_types_without.length).toBe(9);
    // Should NOT include 'config'
    expect(row.resource_types_without).not.toContain('config');
    // Should be in canonical order
    const idx = row.resource_types_without.map((rt) =>
      ALL_AUDIT_RESOURCE_TYPES.indexOf(rt),
    );
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  test('actions_without per col includes other observed actions', () => {
    const events = [
      makeEvent('a.update', 'config'),
      makeEvent('b.update', 'user'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    const configCol = m.columns.find((c) => c.resource_type === 'config')!;
    // 'b.update' was observed (against user) but not against config
    expect(configCol.actions_without).toEqual(['b.update']);
    const userCol = m.columns.find((c) => c.resource_type === 'user')!;
    expect(userCol.actions_without).toEqual(['a.update']);
  });

  test('peak_cell formula = highest cell count', () => {
    const events = [
      makeEvent('user.create', 'user'),
      makeEvent('user.create', 'user'),
      makeEvent('user.create', 'user'),
      makeEvent('user.delete', 'session'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    expect(m.peak_cell).toEqual({
      action: 'user.create',
      resource_type: 'user',
      count: 3,
    });
  });

  test('peak_cell canonical iteration tie-break (actions asc × types canonical)', () => {
    const events = [
      makeEvent('zebra.create', 'session'),
      makeEvent('alpha.create', 'user'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    // Both tied at 1. Canonical iteration: actions asc → 'alpha.create' wins.
    expect(m.peak_cell?.action).toBe('alpha.create');
    expect(m.peak_cell?.resource_type).toBe('user');
  });

  test('peak_cell null on empty', () => {
    const m = buildAuditActionResourceMatrix('BIL', [], NOW);
    expect(m.peak_cell).toBeNull();
  });

  test('most_versatile_action = highest distinct_resource_types', () => {
    const events = [
      // 'multi.action' touches 3 types
      makeEvent('multi.action', 'user'),
      makeEvent('multi.action', 'config'),
      makeEvent('multi.action', 'alert'),
      // 'narrow' touches 1 type (4 times)
      makeEvent('narrow', 'user'),
      makeEvent('narrow', 'user'),
      makeEvent('narrow', 'user'),
      makeEvent('narrow', 'user'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    expect(m.most_versatile_action).toBe('multi.action');
  });

  test('most_versatile_action canonical asc tie-break', () => {
    const events = [
      makeEvent('zebra', 'user'),
      makeEvent('zebra', 'config'),
      makeEvent('alpha', 'user'),
      makeEvent('alpha', 'config'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    // Both touch 2 types → alpha wins (asc)
    expect(m.most_versatile_action).toBe('alpha');
  });

  test('most_versatile_action null on empty', () => {
    const m = buildAuditActionResourceMatrix('BIL', [], NOW);
    expect(m.most_versatile_action).toBeNull();
  });

  test('most_diverse_resource_type = highest distinct_actions', () => {
    const events = [
      // 'config' touched by 3 actions
      makeEvent('config.update', 'config'),
      makeEvent('config.reset', 'config'),
      makeEvent('config.rollback', 'config'),
      // 'user' touched by 1 action
      makeEvent('user.create', 'user'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    expect(m.most_diverse_resource_type).toBe('config');
  });

  test('most_diverse_resource_type canonical order tie-break', () => {
    const events = [
      // both 'user' and 'session' have 2 actions
      makeEvent('a', 'user'),
      makeEvent('b', 'user'),
      makeEvent('a', 'session'),
      makeEvent('b', 'session'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    // user iterates first in canonical order → wins
    expect(m.most_diverse_resource_type).toBe('user');
  });

  test('most_diverse_resource_type null on empty', () => {
    const m = buildAuditActionResourceMatrix('BIL', [], NOW);
    expect(m.most_diverse_resource_type).toBeNull();
  });

  test('empty_cells in canonical action × resource_type row-major order', () => {
    const events = [
      makeEvent('alpha', 'user'),
      makeEvent('bravo', 'config'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    // 2 actions × 10 resource_types = 20 cells; 2 are populated, 18 empty
    expect(m.empty_cells.length).toBe(18);
    // First few should be alpha × <every resource_type except user>
    expect(m.empty_cells[0]).toEqual({ action: 'alpha', resource_type: 'session' });
    expect(m.empty_cells[8]).toEqual({ action: 'alpha', resource_type: 'system' });
    expect(m.empty_cells[9]).toEqual({ action: 'bravo', resource_type: 'user' });
  });

  test('events with empty action string skipped', () => {
    const events = [
      makeEvent('', 'config'),
      makeEvent('valid.action', 'user'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    expect(m.total_events).toBe(1);
    expect(m.actions).toEqual(['valid.action']);
  });

  test('events with out-of-enum resource_type skipped', () => {
    const events = [
      makeEvent('a', 'bogus' as never),
      makeEvent('b', 'user'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    expect(m.total_events).toBe(1);
  });

  test('total_events_observed includes skipped events', () => {
    const events = [
      makeEvent('', 'config'),
      makeEvent('valid.action', 'user'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    expect(m.total_events).toBe(1);
    expect(m.total_events_observed).toBe(2);
  });

  test('total_actions = actions.length', () => {
    const events = [
      makeEvent('a', 'user'),
      makeEvent('b', 'user'),
      makeEvent('c', 'config'),
    ];
    const m = buildAuditActionResourceMatrix('BIL', events, NOW);
    expect(m.total_actions).toBe(3);
    expect(m.actions.length).toBe(3);
  });

  test('tenant_id + generated_at echo', () => {
    const m = buildAuditActionResourceMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M15.17 — GET /v1/audit/action-resource-matrix', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/audit/action-resource-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
    expect(r.body.body.actions).toEqual([]);
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
      .get('/v1/audit/action-resource-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(2);
    expect(r.body.body.peak_cell.count).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTestApp('case_owner');
    const r = await request(app)
      .get('/v1/audit/action-resource-matrix')
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
      .get('/v1/audit/action-resource-matrix')
      .set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
  });

  test('M15.14 /resource-severity-matrix sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/audit/resource-severity-matrix')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('M15.15 /severity-outcome-matrix sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/audit/severity-outcome-matrix')
      .set(TH);
    expect(r.status).toBe(200);
  });
});
