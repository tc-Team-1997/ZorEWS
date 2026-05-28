// services/bff/__tests__/audit_actor_outcome_matrix.test.ts
//
// T6 M15.20 — Audit actor × outcome cross-tab matrix.

import request from 'supertest';
import {
  buildAuditActorOutcomeMatrix,
  ALL_AUDIT_OUTCOMES,
} from '../src/audit_actor_outcome_matrix';
import {
  InMemoryAuditTrailStore,
  type AuditEvent,
  type AuditOutcome,
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
  outcome: AuditOutcome,
  overrides: Partial<AuditEvent> = {},
): AuditEvent {
  return {
    event_id: `evt-${nextEvtSeq++}`,
    ts: NOW.toISOString(),
    tenant_id: 'BIL',
    actor_username,
    actor_role: 'admin',
    action: 'config.update',
    resource_type: 'config',
    resource_id: 'res-1',
    outcome,
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

describe('M15.20 — buildAuditActorOutcomeMatrix', () => {
  test('ALL_AUDIT_OUTCOMES canonical order', () => {
    expect(ALL_AUDIT_OUTCOMES).toEqual(['success', 'failure', 'denied']);
  });

  test('empty input → empty matrix', () => {
    const m = buildAuditActorOutcomeMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.total_events).toBe(0);
    expect(m.total_events_observed).toBe(0);
    expect(m.actors).toEqual([]);
    expect(m.rows).toEqual([]);
    expect(m.columns.length).toBe(3);
    for (const col of m.columns) {
      expect(col.total).toBe(0);
      expect(col.by_actor).toEqual({});
      expect(col.actors_without).toEqual([]);
      expect(col.distinct_actors).toBe(0);
    }
    expect(m.peak_cell).toBeNull();
    expect(m.most_failing_actor).toBeNull();
    expect(m.actors_with_denials).toEqual([]);
    expect(m.most_common_outcome).toBeNull();
    expect(m.most_versatile_actor).toBeNull();
    expect(m.empty_cells).toEqual([]);
    expect(m.total_outcomes).toBe(3);
  });

  test('single event lands in correct cell', () => {
    const m = buildAuditActorOutcomeMatrix('BIL', [makeEvent('alice', 'success')], NOW);
    expect(m.total_events).toBe(1);
    expect(m.actors).toEqual(['alice']);
    expect(m.rows.length).toBe(1);
    expect(m.rows[0].actor_username).toBe('alice');
    expect(m.rows[0].total).toBe(1);
    expect(m.rows[0].by_outcome.success).toBe(1);
    expect(m.rows[0].by_outcome.failure).toBe(0);
    expect(m.rows[0].by_outcome.denied).toBe(0);
    expect(m.rows[0].distinct_outcomes).toBe(1);
    expect(m.rows[0].failure_count).toBe(0);

    const successCol = m.columns.find((c) => c.outcome === 'success')!;
    expect(successCol.total).toBe(1);
    expect(successCol.by_actor['alice']).toBe(1);
    expect(successCol.distinct_actors).toBe(1);
  });

  test('columns in canonical ALL_AUDIT_OUTCOMES order', () => {
    const m = buildAuditActorOutcomeMatrix('BIL', [], NOW);
    expect(m.columns.map((c) => c.outcome)).toEqual([...ALL_AUDIT_OUTCOMES]);
  });

  test('rows sorted asc by actor_username', () => {
    const events = [
      makeEvent('zoe', 'success'),
      makeEvent('alice', 'failure'),
      makeEvent('mike', 'denied'),
    ];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    expect(m.actors).toEqual(['alice', 'mike', 'zoe']);
    expect(m.rows.map((r) => r.actor_username)).toEqual(['alice', 'mike', 'zoe']);
  });

  test('every by_outcome key present per row (3 keys)', () => {
    const m = buildAuditActorOutcomeMatrix('BIL', [makeEvent('alice', 'success')], NOW);
    const row = m.rows[0];
    for (const oc of ALL_AUDIT_OUTCOMES) {
      expect(row.by_outcome[oc]).toBeGreaterThanOrEqual(0);
    }
    expect(Object.keys(row.by_outcome).length).toBe(3);
  });

  test('failure_count = failure + denied', () => {
    const events = [
      makeEvent('alice', 'success'),
      makeEvent('alice', 'failure'),
      makeEvent('alice', 'failure'),
      makeEvent('alice', 'denied'),
    ];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    const row = m.rows[0];
    expect(row.by_outcome.success).toBe(1);
    expect(row.by_outcome.failure).toBe(2);
    expect(row.by_outcome.denied).toBe(1);
    expect(row.failure_count).toBe(3);
    expect(row.total).toBe(4);
  });

  test('Σ row.by_outcome = row.total partition invariant', () => {
    const events = [
      makeEvent('alice', 'success'),
      makeEvent('alice', 'failure'),
      makeEvent('alice', 'denied'),
    ];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    const row = m.rows[0];
    const sum = ALL_AUDIT_OUTCOMES.reduce((a, oc) => a + row.by_outcome[oc], 0);
    expect(sum).toBe(row.total);
    expect(sum).toBe(3);
  });

  test('Σ col.by_actor = col.total partition invariant', () => {
    const events = [makeEvent('alice', 'failure'), makeEvent('bob', 'failure')];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    const col = m.columns.find((c) => c.outcome === 'failure')!;
    const sum = Object.values(col.by_actor).reduce((a, n) => a + n, 0);
    expect(sum).toBe(col.total);
    expect(sum).toBe(2);
  });

  test('grand-total cross-check Σ rows = Σ cols = total_events', () => {
    const events = [
      makeEvent('alice', 'success'),
      makeEvent('bob', 'failure'),
      makeEvent('carol', 'denied'),
    ];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    const rowSum = m.rows.reduce((a, r) => a + r.total, 0);
    const colSum = m.columns.reduce((a, c) => a + c.total, 0);
    expect(rowSum).toBe(m.total_events);
    expect(colSum).toBe(m.total_events);
    expect(rowSum).toBe(3);
  });

  test('cell cross-check: row.by_outcome[X] === col[X].by_actor[actor]', () => {
    const events = [
      makeEvent('alice', 'success'),
      makeEvent('alice', 'success'),
      makeEvent('alice', 'denied'),
      makeEvent('bob', 'denied'),
    ];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    for (const row of m.rows) {
      for (const oc of ALL_AUDIT_OUTCOMES) {
        const fromRow = row.by_outcome[oc];
        const col = m.columns.find((c) => c.outcome === oc)!;
        const fromCol = col.by_actor[row.actor_username] ?? 0;
        expect(fromRow).toBe(fromCol);
      }
    }
  });

  test('outcomes_without per row in canonical order', () => {
    const events = [makeEvent('alice', 'failure')];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    const row = m.rows[0];
    expect(row.outcomes_without).toEqual(['success', 'denied']);
    expect(row.outcomes_without).not.toContain('failure');
  });

  test('actors_without per col includes other observed actors', () => {
    const events = [makeEvent('alice', 'success'), makeEvent('bob', 'failure')];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    const successCol = m.columns.find((c) => c.outcome === 'success')!;
    expect(successCol.actors_without).toEqual(['bob']);
    const failureCol = m.columns.find((c) => c.outcome === 'failure')!;
    expect(failureCol.actors_without).toEqual(['alice']);
  });

  test('peak_cell formula = highest cell count', () => {
    const events = [
      makeEvent('alice', 'success'),
      makeEvent('alice', 'success'),
      makeEvent('alice', 'success'),
      makeEvent('bob', 'failure'),
    ];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    expect(m.peak_cell).toEqual({ actor_username: 'alice', outcome: 'success', count: 3 });
  });

  test('peak_cell canonical iteration tie-break (actors asc × outcomes canonical)', () => {
    const events = [makeEvent('zoe', 'failure'), makeEvent('alice', 'success')];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    // Both tied at 1. Canonical iteration: actors asc → alice wins.
    expect(m.peak_cell?.actor_username).toBe('alice');
    expect(m.peak_cell?.outcome).toBe('success');
  });

  test('peak_cell null on empty', () => {
    const m = buildAuditActorOutcomeMatrix('BIL', [], NOW);
    expect(m.peak_cell).toBeNull();
  });

  test('most_failing_actor = highest failure_count', () => {
    const events = [
      // alice: 3 failures + 1 denied = failure_count 4
      makeEvent('alice', 'failure'),
      makeEvent('alice', 'failure'),
      makeEvent('alice', 'failure'),
      makeEvent('alice', 'denied'),
      // bob: 10 successes, 1 failure = failure_count 1
      ...Array.from({ length: 10 }, () => makeEvent('bob', 'success')),
      makeEvent('bob', 'failure'),
    ];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    // alice has the highest failure_count despite bob having more total events
    expect(m.most_failing_actor).toBe('alice');
  });

  test('most_failing_actor canonical asc tie-break', () => {
    const events = [
      makeEvent('zoe', 'failure'),
      makeEvent('alice', 'denied'),
    ];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    // both failure_count 1 → alice wins (asc)
    expect(m.most_failing_actor).toBe('alice');
  });

  test('most_failing_actor null when no failures/denials', () => {
    const events = [makeEvent('alice', 'success'), makeEvent('bob', 'success')];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    expect(m.most_failing_actor).toBeNull();
  });

  test('actors_with_denials lists denied-event actors sorted asc', () => {
    const events = [
      makeEvent('zoe', 'denied'),
      makeEvent('alice', 'denied'),
      makeEvent('bob', 'failure'), // failure only, no denial
      makeEvent('carol', 'success'),
    ];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    expect(m.actors_with_denials).toEqual(['alice', 'zoe']);
  });

  test('actors_with_denials empty when no denials', () => {
    const events = [makeEvent('alice', 'success'), makeEvent('bob', 'failure')];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    expect(m.actors_with_denials).toEqual([]);
  });

  test('most_common_outcome = highest column total', () => {
    const events = [
      makeEvent('alice', 'failure'),
      makeEvent('bob', 'failure'),
      makeEvent('carol', 'failure'),
      makeEvent('alice', 'success'),
    ];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    expect(m.most_common_outcome).toBe('failure');
  });

  test('most_common_outcome canonical tie-break (success > failure > denied)', () => {
    const events = [
      makeEvent('alice', 'success'),
      makeEvent('bob', 'failure'),
    ];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    // both columns total 1 → success wins (canonical order)
    expect(m.most_common_outcome).toBe('success');
  });

  test('most_common_outcome null on empty', () => {
    const m = buildAuditActorOutcomeMatrix('BIL', [], NOW);
    expect(m.most_common_outcome).toBeNull();
  });

  test('most_versatile_actor = highest distinct_outcomes', () => {
    const events = [
      // alice spans all 3 outcomes
      makeEvent('alice', 'success'),
      makeEvent('alice', 'failure'),
      makeEvent('alice', 'denied'),
      // bob only success (many)
      makeEvent('bob', 'success'),
      makeEvent('bob', 'success'),
    ];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    expect(m.most_versatile_actor).toBe('alice');
  });

  test('most_versatile_actor canonical asc tie-break', () => {
    const events = [
      makeEvent('zoe', 'success'),
      makeEvent('zoe', 'failure'),
      makeEvent('alice', 'success'),
      makeEvent('alice', 'failure'),
    ];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    // both span 2 outcomes → alice wins (asc)
    expect(m.most_versatile_actor).toBe('alice');
  });

  test('most_versatile_actor null on empty', () => {
    const m = buildAuditActorOutcomeMatrix('BIL', [], NOW);
    expect(m.most_versatile_actor).toBeNull();
  });

  test('empty_cells in canonical actor × outcome row-major order', () => {
    const events = [makeEvent('alice', 'success'), makeEvent('bob', 'failure')];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    // 2 actors × 3 outcomes = 6 cells; 2 populated, 4 empty
    expect(m.empty_cells.length).toBe(4);
    // alice's empty cells first (failure, denied), then bob's (success, denied)
    expect(m.empty_cells[0]).toEqual({ actor_username: 'alice', outcome: 'failure' });
    expect(m.empty_cells[1]).toEqual({ actor_username: 'alice', outcome: 'denied' });
    expect(m.empty_cells[2]).toEqual({ actor_username: 'bob', outcome: 'success' });
    expect(m.empty_cells[3]).toEqual({ actor_username: 'bob', outcome: 'denied' });
  });

  test('events with empty actor_username skipped', () => {
    const events = [makeEvent('', 'success'), makeEvent('alice', 'failure')];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    expect(m.total_events).toBe(1);
    expect(m.actors).toEqual(['alice']);
  });

  test('events with out-of-enum outcome skipped', () => {
    const events = [makeEvent('alice', 'bogus' as never), makeEvent('bob', 'success')];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    expect(m.total_events).toBe(1);
  });

  test('total_events_observed includes skipped events', () => {
    const events = [makeEvent('', 'success'), makeEvent('alice', 'failure')];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    expect(m.total_events).toBe(1);
    expect(m.total_events_observed).toBe(2);
  });

  test('total_actors = actors.length', () => {
    const events = [
      makeEvent('alice', 'success'),
      makeEvent('bob', 'success'),
      makeEvent('carol', 'denied'),
    ];
    const m = buildAuditActorOutcomeMatrix('BIL', events, NOW);
    expect(m.total_actors).toBe(3);
    expect(m.actors.length).toBe(3);
  });

  test('tenant_id + generated_at echo', () => {
    const m = buildAuditActorOutcomeMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M15.20 — GET /v1/audit/actor-outcome-matrix', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app).get('/v1/audit/actor-outcome-matrix').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
    expect(r.body.body.actors).toEqual([]);
    expect(r.body.body.total_outcomes).toBe(3);
  });

  test('populated reflects recorded events incl. failing-actor leaderboard', async () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', {
      actor_username: 'alice',
      actor_role: 'admin',
      action: 'config.update',
      resource_type: 'config',
      resource_id: 'k1',
      outcome: 'denied',
      severity: 'warning',
    }, NOW);
    store.record('BIL', {
      actor_username: 'alice',
      actor_role: 'admin',
      action: 'config.update',
      resource_type: 'config',
      resource_id: 'k1',
      outcome: 'failure',
      severity: 'warning',
    }, NOW);
    const { app } = makeTestApp('admin', store);
    const r = await request(app).get('/v1/audit/actor-outcome-matrix').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(2);
    expect(r.body.body.most_failing_actor).toBe('alice');
    expect(r.body.body.actors_with_denials).toEqual(['alice']);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTestApp('case_owner');
    const r = await request(app).get('/v1/audit/actor-outcome-matrix').set(TH);
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
      outcome: 'failure',
      severity: 'warning',
    }, NOW);
    const { app } = makeTestApp('admin', store);
    const r = await request(app).get('/v1/audit/actor-outcome-matrix').set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
  });

  test('M15.19 /actor-resource-matrix sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app).get('/v1/audit/actor-resource-matrix').set(TH);
    expect(r.status).toBe(200);
  });

  test('M15.15 /severity-outcome-matrix sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app).get('/v1/audit/severity-outcome-matrix').set(TH);
    expect(r.status).toBe(200);
  });
});
