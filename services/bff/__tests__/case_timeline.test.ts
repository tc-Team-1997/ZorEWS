// services/bff/__tests__/case_timeline.test.ts
//
// T6 M9.6 — Case investigation timeline reconstruction.

import request from 'supertest';
import { reconstructCaseTimeline } from '../src/case_timeline';
import { InMemoryCaseEventStore, type CaseEvent } from '../src/case_events';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

let seq = 0;
function mkEvent(o: Partial<CaseEvent> & { case_id: string; action: CaseEvent['action'] }): CaseEvent {
  seq += 1;
  return {
    event_id: `evt-${seq}`,
    sequence_no: o.sequence_no ?? seq,
    tenant_id: o.tenant_id ?? 'BIL',
    case_id: o.case_id,
    action: o.action,
    actor: o.actor ?? 'alice',
    payload: o.payload ?? {},
    recorded_at: o.recorded_at ?? NOW.toISOString(),
  };
}

beforeEach(() => {
  seq = 0;
});

// ─── reconstructCaseTimeline — pure ──────────────────────────────────

describe('M9.6 — reconstructCaseTimeline — empty', () => {
  test('no events for the case → zero envelope with all action keys at 0', () => {
    const out = reconstructCaseTimeline([], 'c1', NOW);
    expect(out.case_id).toBe('c1');
    expect(out.total_events).toBe(0);
    expect(out.opened_at).toBeNull();
    expect(out.closed_at).toBeNull();
    expect(out.current_state).toBeNull();
    expect(out.time_in_current_state_hours).toBeNull();
    expect(out.total_age_hours).toBeNull();
    expect(out.transitions).toEqual([]);
    expect(out.events_by_action.opened).toBe(0);
    expect(out.events_by_action.state_change).toBe(0);
  });

  test('non-opened events without an opened event → no transitions captured', () => {
    const events = [
      mkEvent({ case_id: 'c1', action: 'note_added' }),
      mkEvent({ case_id: 'c1', action: 'state_change', payload: { to: 'review' } }),
    ];
    const out = reconstructCaseTimeline(events, 'c1', NOW);
    expect(out.total_events).toBe(2);
    expect(out.current_state).toBeNull();
    expect(out.transitions).toEqual([]);
    expect(out.events_by_action.note_added).toBe(1);
    expect(out.events_by_action.state_change).toBe(1);
  });
});

describe('M9.6 — single opened case', () => {
  test('opened event with default initial_state → first transition with null from + null duration', () => {
    const opened = new Date(NOW.getTime() - 6 * HOUR_MS).toISOString();
    const events = [mkEvent({ case_id: 'c1', action: 'opened', recorded_at: opened })];
    const out = reconstructCaseTimeline(events, 'c1', NOW);
    expect(out.opened_at).toBe(opened);
    expect(out.current_state).toBe('triage');
    expect(out.transitions.length).toBe(1);
    expect(out.transitions[0]).toMatchObject({
      from_state: null,
      to_state: 'triage',
      duration_in_previous_state_hours: null,
    });
    expect(out.time_in_current_state_hours).toBeCloseTo(6, 5);
    expect(out.total_age_hours).toBeCloseTo(6, 5);
  });

  test('opened with payload.initial_state honoured', () => {
    const events = [
      mkEvent({
        case_id: 'c1',
        action: 'opened',
        payload: { initial_state: 'gathering_evidence' },
      }),
    ];
    const out = reconstructCaseTimeline(events, 'c1', NOW);
    expect(out.current_state).toBe('gathering_evidence');
  });
});

describe('M9.6 — multi-transition cases', () => {
  test('opened → state_change → state_change records ordered transitions with durations', () => {
    const t0 = NOW.getTime() - 10 * HOUR_MS;
    const events = [
      mkEvent({ case_id: 'c1', action: 'opened', recorded_at: new Date(t0).toISOString() }),
      mkEvent({
        case_id: 'c1',
        action: 'state_change',
        recorded_at: new Date(t0 + 3 * HOUR_MS).toISOString(),
        payload: { to: 'review' },
      }),
      mkEvent({
        case_id: 'c1',
        action: 'state_change',
        recorded_at: new Date(t0 + 8 * HOUR_MS).toISOString(),
        payload: { to: 'decision' },
      }),
    ];
    const out = reconstructCaseTimeline(events, 'c1', NOW);
    expect(out.transitions.length).toBe(3);
    expect(out.transitions[0]).toMatchObject({
      from_state: null,
      to_state: 'triage',
      duration_in_previous_state_hours: null,
    });
    expect(out.transitions[1]).toMatchObject({
      from_state: 'triage',
      to_state: 'review',
    });
    expect(out.transitions[1]!.duration_in_previous_state_hours).toBeCloseTo(3, 5);
    expect(out.transitions[2]).toMatchObject({
      from_state: 'review',
      to_state: 'decision',
    });
    expect(out.transitions[2]!.duration_in_previous_state_hours).toBeCloseTo(5, 5);
    // Current state = 'decision', entered at t0+8h, now is t0+10h → 2h.
    expect(out.current_state).toBe('decision');
    expect(out.time_in_current_state_hours).toBeCloseTo(2, 5);
  });

  test('events processed in sequence_no order even when shuffled', () => {
    const t0 = NOW.getTime() - 5 * HOUR_MS;
    const events = [
      mkEvent({
        sequence_no: 3,
        case_id: 'c1',
        action: 'state_change',
        recorded_at: new Date(t0 + 2 * HOUR_MS).toISOString(),
        payload: { to: 'decision' },
      }),
      mkEvent({
        sequence_no: 1,
        case_id: 'c1',
        action: 'opened',
        recorded_at: new Date(t0).toISOString(),
      }),
      mkEvent({
        sequence_no: 2,
        case_id: 'c1',
        action: 'state_change',
        recorded_at: new Date(t0 + 1 * HOUR_MS).toISOString(),
        payload: { to: 'review' },
      }),
    ];
    const out = reconstructCaseTimeline(events, 'c1', NOW);
    expect(out.transitions.map((t) => t.to_state)).toEqual([
      'triage',
      'review',
      'decision',
    ]);
  });
});

describe('M9.6 — closed cases', () => {
  test('closed event terminates the timeline; closed_at set; current_state=closed', () => {
    const t0 = NOW.getTime() - 24 * HOUR_MS;
    const closedTs = new Date(t0 + 20 * HOUR_MS).toISOString();
    const events = [
      mkEvent({ case_id: 'c1', action: 'opened', recorded_at: new Date(t0).toISOString() }),
      mkEvent({
        case_id: 'c1',
        action: 'closed',
        recorded_at: closedTs,
      }),
    ];
    const out = reconstructCaseTimeline(events, 'c1', NOW);
    expect(out.closed_at).toBe(closedTs);
    expect(out.current_state).toBe('closed');
    expect(out.total_age_hours).toBeCloseTo(20, 5);
    // time_in_current_state_hours is measured against closed_at, not now.
    expect(out.time_in_current_state_hours).toBe(0);
  });

  test('total_age_hours of an open case uses now, not closed_at', () => {
    const opened = new Date(NOW.getTime() - 15 * HOUR_MS).toISOString();
    const events = [mkEvent({ case_id: 'c1', action: 'opened', recorded_at: opened })];
    const out = reconstructCaseTimeline(events, 'c1', NOW);
    expect(out.closed_at).toBeNull();
    expect(out.total_age_hours).toBeCloseTo(15, 5);
  });
});

describe('M9.6 — non-state events folded into events_by_action only', () => {
  test('note_added + checklist_updated + override events don\'t produce transitions', () => {
    const events = [
      mkEvent({ case_id: 'c1', action: 'opened' }),
      mkEvent({ case_id: 'c1', action: 'note_added' }),
      mkEvent({ case_id: 'c1', action: 'checklist_updated' }),
      mkEvent({ case_id: 'c1', action: 'override_requested' }),
      mkEvent({ case_id: 'c1', action: 'override_approved' }),
      mkEvent({ case_id: 'c1', action: 'escalated' }),
    ];
    const out = reconstructCaseTimeline(events, 'c1', NOW);
    expect(out.total_events).toBe(6);
    expect(out.transitions.length).toBe(1); // just the opened
    expect(out.events_by_action.note_added).toBe(1);
    expect(out.events_by_action.checklist_updated).toBe(1);
    expect(out.events_by_action.override_requested).toBe(1);
    expect(out.events_by_action.override_approved).toBe(1);
    expect(out.events_by_action.escalated).toBe(1);
    expect(out.events_by_action.override_rejected).toBe(0);
  });
});

describe('M9.6 — case_id filter', () => {
  test('events for other cases are ignored', () => {
    const events = [
      mkEvent({ case_id: 'c1', action: 'opened' }),
      mkEvent({ case_id: 'c2', action: 'opened' }),
      mkEvent({ case_id: 'c1', action: 'state_change', payload: { to: 'review' } }),
    ];
    const out = reconstructCaseTimeline(events, 'c1', NOW);
    expect(out.total_events).toBe(2);
    expect(out.transitions.map((t) => t.to_state)).toEqual(['triage', 'review']);
  });
});

// ─── GET /v1/cases/:case_id/timeline ─────────────────────────────────

function makeTimelineApp(role = 'admin', store?: InMemoryCaseEventStore) {
  const caseEventStore = store ?? new InMemoryCaseEventStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    caseEventStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, caseEventStore };
}

describe('M9.6 — GET /v1/cases/:case_id/timeline', () => {
  test('200 with full timeline shape', async () => {
    const store = new InMemoryCaseEventStore();
    store.record(
      'BIL',
      { case_id: 'case-001', action: 'opened', actor: 'alice' },
      new Date(NOW.getTime() - 5 * HOUR_MS),
    );
    store.record(
      'BIL',
      {
        case_id: 'case-001',
        action: 'state_change',
        actor: 'bob',
        payload: { from: 'triage', to: 'review' },
      },
      new Date(NOW.getTime() - 2 * HOUR_MS),
    );
    const { app } = makeTimelineApp('admin', store);
    const r = await request(app).get('/v1/cases/case-001/timeline').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.case_id).toBe('case-001');
    expect(r.body.body.total_events).toBe(2);
    expect(r.body.body.current_state).toBe('review');
    expect(r.body.body.transitions.length).toBe(2);
  });

  test('unknown case → 200 with empty timeline (not 404 — events store is total)', async () => {
    const { app } = makeTimelineApp('admin');
    const r = await request(app)
      .get('/v1/cases/case-does-not-exist/timeline')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
    expect(r.body.body.transitions).toEqual([]);
  });

  test('cross-tenant: BANK_DEMO does not see BIL events', async () => {
    const store = new InMemoryCaseEventStore();
    store.record(
      'BIL',
      { case_id: 'case-001', action: 'opened', actor: 'alice' },
      NOW,
    );
    const { app } = makeTimelineApp('admin', store);
    const r = await request(app)
      .get('/v1/cases/case-001/timeline')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTimelineApp('case_owner');
    const r = await request(app)
      .get('/v1/cases/case-001/timeline')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });
});
