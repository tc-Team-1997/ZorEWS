// services/bff/__tests__/case_state_transition_matrix.test.ts
//
// T6 M9.17 — Case state transition cross-tab matrix.

import request from 'supertest';
import { buildCaseTransitionMatrix } from '../src/case_state_transition_matrix';
import {
  InMemoryCaseEventStore,
  type CaseEvent,
  type CaseEventStore,
} from '../src/case_events';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeTestApp(role: string = 'admin', caseEventStore?: CaseEventStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    caseEventStore,
  });
}

function makeEvent(
  seq: number,
  case_id: string,
  action: CaseEvent['action'],
  payload: Record<string, unknown> = {},
  recorded_at: string = NOW.toISOString(),
  actor: string = 'alice',
): CaseEvent {
  return {
    event_id: `evt-${seq}`,
    sequence_no: seq,
    tenant_id: 'BIL',
    case_id,
    action,
    actor,
    payload,
    recorded_at,
  };
}

// ─── Pure resolver ─────────────────────────────────────────────────────

describe('M9.17 — buildCaseTransitionMatrix', () => {
  test('empty events → empty matrix', () => {
    const m = buildCaseTransitionMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.total_transitions).toBe(0);
    expect(m.total_state_change_events).toBe(0);
    expect(m.total_events_observed).toBe(0);
    expect(m.states).toEqual([]);
    expect(m.rows).toEqual([]);
    expect(m.columns).toEqual([]);
    expect(m.peak_cell).toBeNull();
    expect(m.most_common_destination).toBeNull();
    expect(m.most_common_source).toBeNull();
    expect(m.dead_ends).toEqual([]);
    expect(m.origins).toEqual([]);
    expect(m.self_transition_count).toBe(0);
  });

  test('non-state-change events excluded', () => {
    const events = [
      makeEvent(1, 'c1', 'opened', { initial_state: 'OPEN' }),
      makeEvent(2, 'c1', 'note_added'),
      makeEvent(3, 'c1', 'closed', { from: 'INVESTIGATING' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    expect(m.total_state_change_events).toBe(0);
    expect(m.total_transitions).toBe(0);
    expect(m.total_events_observed).toBe(3);
  });

  test('state_change without from/to skipped', () => {
    const events = [
      makeEvent(1, 'c1', 'state_change', { to: 'ASSIGNED' }), // no from
      makeEvent(2, 'c2', 'state_change', { from: 'OPEN' }), // no to
      makeEvent(3, 'c3', 'state_change', {}), // neither
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    expect(m.total_state_change_events).toBe(3);
    expect(m.total_transitions).toBe(0);
  });

  test('single transition OPEN→ASSIGNED', () => {
    const events = [
      makeEvent(1, 'c1', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    expect(m.total_transitions).toBe(1);
    expect(m.states).toEqual(['ASSIGNED', 'OPEN']);
    expect(m.rows.length).toBe(1);
    expect(m.rows[0].from_state).toBe('OPEN');
    expect(m.rows[0].total_outbound).toBe(1);
    expect(m.rows[0].by_to.ASSIGNED).toBe(1);
    expect(m.rows[0].distinct_cases).toBe(1);
    expect(m.columns.length).toBe(1);
    expect(m.columns[0].to_state).toBe('ASSIGNED');
    expect(m.columns[0].total_inbound).toBe(1);
  });

  test('multi-case same transition aggregates count + distinct_cases', () => {
    const events = [
      makeEvent(1, 'c1', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      makeEvent(2, 'c2', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      makeEvent(3, 'c3', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    expect(m.total_transitions).toBe(3);
    expect(m.rows[0].by_to.ASSIGNED).toBe(3);
    expect(m.rows[0].distinct_cases).toBe(3);
    expect(m.columns[0].distinct_cases).toBe(3);
  });

  test('same case re-traversing same transition: count=N, distinct=1', () => {
    const events = [
      makeEvent(1, 'c1', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      makeEvent(2, 'c1', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      makeEvent(3, 'c1', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    expect(m.rows[0].by_to.ASSIGNED).toBe(3);
    expect(m.rows[0].distinct_cases).toBe(1);
    expect(m.columns[0].distinct_cases).toBe(1);
  });

  test('multi-transition cohort builds proper matrix', () => {
    const events = [
      makeEvent(1, 'c1', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      makeEvent(2, 'c1', 'state_change', { from: 'ASSIGNED', to: 'INVESTIGATING' }),
      makeEvent(3, 'c1', 'state_change', { from: 'INVESTIGATING', to: 'CLOSED' }),
      makeEvent(4, 'c2', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      makeEvent(5, 'c2', 'state_change', { from: 'ASSIGNED', to: 'CLOSED' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    expect(m.total_transitions).toBe(5);
    expect(m.states.sort()).toEqual(['ASSIGNED', 'CLOSED', 'INVESTIGATING', 'OPEN']);
    // OPEN row
    const openRow = m.rows.find((r) => r.from_state === 'OPEN')!;
    expect(openRow.total_outbound).toBe(2);
    expect(openRow.by_to.ASSIGNED).toBe(2);
    // ASSIGNED row
    const assignedRow = m.rows.find((r) => r.from_state === 'ASSIGNED')!;
    expect(assignedRow.total_outbound).toBe(2);
    expect(assignedRow.by_to.INVESTIGATING).toBe(1);
    expect(assignedRow.by_to.CLOSED).toBe(1);
  });

  test('rows sorted by total_outbound desc + from_state asc tie-break', () => {
    const events = [
      // OPEN: 2 outbound
      makeEvent(1, 'c1', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      makeEvent(2, 'c2', 'state_change', { from: 'OPEN', to: 'CLOSED' }),
      // ASSIGNED: 1 outbound
      makeEvent(3, 'c3', 'state_change', { from: 'ASSIGNED', to: 'CLOSED' }),
      // ESCALATED: 1 outbound
      makeEvent(4, 'c4', 'state_change', { from: 'ESCALATED', to: 'CLOSED' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    expect(m.rows.map((r) => r.from_state)).toEqual([
      'OPEN', // 2 outbound first
      'ASSIGNED', // tie with ESCALATED at 1 → asc wins
      'ESCALATED',
    ]);
  });

  test('columns sorted by total_inbound desc + to_state asc tie-break', () => {
    const events = [
      // CLOSED: 3 inbound
      makeEvent(1, 'c1', 'state_change', { from: 'OPEN', to: 'CLOSED' }),
      makeEvent(2, 'c2', 'state_change', { from: 'ASSIGNED', to: 'CLOSED' }),
      makeEvent(3, 'c3', 'state_change', { from: 'INVESTIGATING', to: 'CLOSED' }),
      // ASSIGNED: 1 inbound
      makeEvent(4, 'c4', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      // ESCALATED: 1 inbound
      makeEvent(5, 'c5', 'state_change', { from: 'OPEN', to: 'ESCALATED' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    expect(m.columns.map((c) => c.to_state)).toEqual([
      'CLOSED',
      'ASSIGNED', // tied 1 with ESCALATED → asc wins
      'ESCALATED',
    ]);
  });

  test('peak_cell formula = highest cell count', () => {
    const events = [
      // OPEN → ASSIGNED: 3 cases
      makeEvent(1, 'c1', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      makeEvent(2, 'c2', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      makeEvent(3, 'c3', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      // ASSIGNED → CLOSED: 1 case
      makeEvent(4, 'c4', 'state_change', { from: 'ASSIGNED', to: 'CLOSED' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    expect(m.peak_cell).toEqual({
      from_state: 'OPEN',
      to_state: 'ASSIGNED',
      count: 3,
    });
  });

  test('peak_cell canonical iteration tie-break (state asc × asc)', () => {
    const events = [
      // Tied at 1: ASSIGNED→CLOSED and ZZ→CLOSED
      makeEvent(1, 'c1', 'state_change', { from: 'ZZ', to: 'CLOSED' }),
      makeEvent(2, 'c2', 'state_change', { from: 'ASSIGNED', to: 'CLOSED' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    // ASSIGNED iterates first in canonical asc order → wins tie
    expect(m.peak_cell?.from_state).toBe('ASSIGNED');
  });

  test('peak_cell null on empty', () => {
    const m = buildCaseTransitionMatrix('BIL', [], NOW);
    expect(m.peak_cell).toBeNull();
  });

  test('most_common_destination + most_common_source formulas', () => {
    const events = [
      // CLOSED: 3 inbound
      makeEvent(1, 'c1', 'state_change', { from: 'OPEN', to: 'CLOSED' }),
      makeEvent(2, 'c2', 'state_change', { from: 'ASSIGNED', to: 'CLOSED' }),
      makeEvent(3, 'c3', 'state_change', { from: 'INVESTIGATING', to: 'CLOSED' }),
      // OPEN: 2 outbound (1 above + 1 to ASSIGNED)
      makeEvent(4, 'c4', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    expect(m.most_common_destination).toBe('CLOSED');
    expect(m.most_common_source).toBe('OPEN');
  });

  test('dead_ends — observed as dest but never source', () => {
    const events = [
      makeEvent(1, 'c1', 'state_change', { from: 'OPEN', to: 'CLOSED' }),
      makeEvent(2, 'c2', 'state_change', { from: 'ASSIGNED', to: 'CLOSED' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    expect(m.dead_ends).toEqual(['CLOSED']);
  });

  test('origins — observed as source but never dest', () => {
    const events = [
      makeEvent(1, 'c1', 'state_change', { from: 'OPEN', to: 'CLOSED' }),
      makeEvent(2, 'c2', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      makeEvent(3, 'c3', 'state_change', { from: 'ASSIGNED', to: 'CLOSED' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    // OPEN is source but never dest → origin
    expect(m.origins).toEqual(['OPEN']);
    // CLOSED is dest but never source → dead end
    expect(m.dead_ends).toEqual(['CLOSED']);
  });

  test('self-transition surfaces in self_transition_count', () => {
    const events = [
      makeEvent(1, 'c1', 'state_change', { from: 'INVESTIGATING', to: 'INVESTIGATING' }),
      makeEvent(2, 'c2', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    expect(m.self_transition_count).toBe(1);
    expect(m.total_transitions).toBe(2);
  });

  test('Σ rows.total_outbound = total_transitions partition invariant', () => {
    const events = [
      makeEvent(1, 'c1', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      makeEvent(2, 'c1', 'state_change', { from: 'ASSIGNED', to: 'INVESTIGATING' }),
      makeEvent(3, 'c1', 'state_change', { from: 'INVESTIGATING', to: 'CLOSED' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    const sum = m.rows.reduce((a, r) => a + r.total_outbound, 0);
    expect(sum).toBe(m.total_transitions);
  });

  test('Σ columns.total_inbound = total_transitions partition invariant', () => {
    const events = [
      makeEvent(1, 'c1', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      makeEvent(2, 'c1', 'state_change', { from: 'ASSIGNED', to: 'INVESTIGATING' }),
      makeEvent(3, 'c1', 'state_change', { from: 'INVESTIGATING', to: 'CLOSED' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    const sum = m.columns.reduce((a, c) => a + c.total_inbound, 0);
    expect(sum).toBe(m.total_transitions);
  });

  test('cell cross-check invariant: row.by_to[X] === col[X].by_from[from]', () => {
    const events = [
      makeEvent(1, 'c1', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      makeEvent(2, 'c2', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      makeEvent(3, 'c3', 'state_change', { from: 'ASSIGNED', to: 'CLOSED' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    for (const row of m.rows) {
      for (const [to, count] of Object.entries(row.by_to)) {
        const col = m.columns.find((c) => c.to_state === to)!;
        expect(col.by_from[row.from_state]).toBe(count);
      }
    }
  });

  test('states union sorted asc', () => {
    const events = [
      makeEvent(1, 'c1', 'state_change', { from: 'ZZ', to: 'AA' }),
      makeEvent(2, 'c2', 'state_change', { from: 'MM', to: 'BB' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    expect(m.states).toEqual(['AA', 'BB', 'MM', 'ZZ']);
  });

  test('whitespace from/to trimmed', () => {
    const events = [
      makeEvent(1, 'c1', 'state_change', { from: '  OPEN  ', to: '  ASSIGNED  ' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    expect(m.states).toEqual(['ASSIGNED', 'OPEN']);
  });

  test('empty string from/to skipped', () => {
    const events = [
      makeEvent(1, 'c1', 'state_change', { from: '', to: 'ASSIGNED' }),
      makeEvent(2, 'c2', 'state_change', { from: 'OPEN', to: '   ' }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    expect(m.total_transitions).toBe(0);
  });

  test('non-string from/to skipped', () => {
    const events = [
      makeEvent(1, 'c1', 'state_change', { from: 123, to: 'ASSIGNED' }),
      makeEvent(2, 'c2', 'state_change', { from: 'OPEN', to: null }),
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    expect(m.total_transitions).toBe(0);
  });

  test('tenant_id + generated_at echo', () => {
    const m = buildCaseTransitionMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.generated_at).toBe(NOW.toISOString());
  });

  test('row distinct_cases counts (case, to-state) pairs distinctly', () => {
    const events = [
      makeEvent(1, 'c1', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }),
      makeEvent(2, 'c1', 'state_change', { from: 'OPEN', to: 'ASSIGNED' }), // re-trav same
      makeEvent(3, 'c1', 'state_change', { from: 'OPEN', to: 'ESCALATED' }), // diff dest
    ];
    const m = buildCaseTransitionMatrix('BIL', events, NOW);
    const openRow = m.rows.find((r) => r.from_state === 'OPEN')!;
    // c1→ASSIGNED + c1→ESCALATED = 2 distinct pairs
    expect(openRow.distinct_cases).toBe(2);
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M9.17 — GET /v1/cases/events/transition-matrix', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/cases/events/transition-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_transitions).toBe(0);
    expect(r.body.body.states).toEqual([]);
  });

  test('populated reflects recorded events', async () => {
    const store = new InMemoryCaseEventStore();
    store.record(
      'BIL',
      { case_id: 'c1', action: 'state_change', actor: 'alice', payload: { from: 'OPEN', to: 'ASSIGNED' } },
      NOW,
    );
    store.record(
      'BIL',
      { case_id: 'c2', action: 'state_change', actor: 'bob', payload: { from: 'OPEN', to: 'ASSIGNED' } },
      NOW,
    );
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/cases/events/transition-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_transitions).toBe(2);
    expect(r.body.body.states).toEqual(['ASSIGNED', 'OPEN']);
    expect(r.body.body.peak_cell.count).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTestApp('case_owner');
    const r = await request(app)
      .get('/v1/cases/events/transition-matrix')
      .set(TH);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryCaseEventStore();
    store.record(
      'BIL',
      { case_id: 'c1', action: 'state_change', actor: 'alice', payload: { from: 'OPEN', to: 'ASSIGNED' } },
      NOW,
    );
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/cases/events/transition-matrix')
      .set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total_transitions).toBe(0);
  });

  test('M9.15 /action-distribution sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/cases/events/action-distribution')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('literal /transition-matrix not captured by /:event_id wildcard', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/cases/events/transition-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.states).toBeDefined();
  });
});
