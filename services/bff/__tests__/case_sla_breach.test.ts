// services/bff/__tests__/case_sla_breach.test.ts
//
// T6 M9.5 — Case SLA breach detection.

import request from 'supertest';
import {
  BREACH_LIST_CAP,
  DEFAULT_SLA_HOURS_BY_STATE,
  detectCaseSlaBreaches,
} from '../src/case_sla_breach';
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

// ─── detectCaseSlaBreaches ────────────────────────────────────────────

describe('M9.5 — detectCaseSlaBreaches — empty + shape', () => {
  test('no events → zero envelope, null rate', () => {
    const out = detectCaseSlaBreaches([], NOW);
    expect(out.total_cases_observed).toBe(0);
    expect(out.open_cases).toBe(0);
    expect(out.closed_cases).toBe(0);
    expect(out.breach_count).toBe(0);
    expect(out.breach_rate).toBeNull();
    expect(out.breaches).toEqual([]);
    expect(out.by_state).toEqual({});
  });

  test('cases without an `opened` event are skipped (state cannot be reconstructed)', () => {
    const events = [
      mkEvent({ case_id: 'c1', action: 'note_added' }),
      mkEvent({ case_id: 'c1', action: 'state_change', payload: { to: 'review' } }),
    ];
    const out = detectCaseSlaBreaches(events, NOW);
    expect(out.total_cases_observed).toBe(0);
  });
});

describe('M9.5 — state reconstruction', () => {
  test('opened with payload.initial_state seeds that state', () => {
    const opened = new Date(NOW.getTime() - 3 * HOUR_MS).toISOString();
    const events = [
      mkEvent({
        case_id: 'c1',
        action: 'opened',
        recorded_at: opened,
        payload: { initial_state: 'gathering_evidence' },
      }),
    ];
    const out = detectCaseSlaBreaches(events, NOW);
    expect(out.open_cases).toBe(1);
    expect(out.by_state.gathering_evidence?.open).toBe(1);
    // SLA for gathering_evidence is 24h; only 3h in — not breached.
    expect(out.breach_count).toBe(0);
  });

  test('opened with no initial_state defaults to "triage"', () => {
    const opened = new Date(NOW.getTime() - 1 * HOUR_MS).toISOString();
    const events = [mkEvent({ case_id: 'c1', action: 'opened', recorded_at: opened })];
    const out = detectCaseSlaBreaches(events, NOW);
    expect(out.by_state.triage?.open).toBe(1);
  });

  test('state_change updates current_state + entered_state_at', () => {
    const opened = new Date(NOW.getTime() - 10 * HOUR_MS).toISOString();
    const changed = new Date(NOW.getTime() - 5 * HOUR_MS).toISOString();
    const events = [
      mkEvent({ case_id: 'c1', action: 'opened', recorded_at: opened }),
      mkEvent({
        case_id: 'c1',
        action: 'state_change',
        recorded_at: changed,
        payload: { from: 'triage', to: 'review' },
      }),
    ];
    const out = detectCaseSlaBreaches(events, NOW);
    expect(out.by_state.review?.open).toBe(1);
    // SLA for review = 24h, 5h in → not breached.
    expect(out.breach_count).toBe(0);
    // Triage bucket should NOT appear — the case has moved on.
    expect(out.by_state.triage).toBeUndefined();
  });

  test('closed event removes the case from the open pool', () => {
    const opened = new Date(NOW.getTime() - 48 * HOUR_MS).toISOString();
    const closed = new Date(NOW.getTime() - 1 * HOUR_MS).toISOString();
    const events = [
      mkEvent({ case_id: 'c1', action: 'opened', recorded_at: opened }),
      mkEvent({ case_id: 'c1', action: 'closed', recorded_at: closed }),
    ];
    const out = detectCaseSlaBreaches(events, NOW);
    expect(out.total_cases_observed).toBe(1);
    expect(out.open_cases).toBe(0);
    expect(out.closed_cases).toBe(1);
    expect(out.breach_count).toBe(0);
  });

  test('events are processed in sequence_no order even when shuffled', () => {
    const t0 = NOW.getTime() - 10 * HOUR_MS;
    const events = [
      // Pass them shuffled — sequence_no 1, 3, 2.
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
    const out = detectCaseSlaBreaches(events, NOW);
    // Final state should be 'decision', not 'review' — sequence_no=3 wins.
    expect(out.by_state.decision?.open).toBe(1);
  });
});

describe('M9.5 — breach detection', () => {
  test('open case past per-state SLA produces a breach entry', () => {
    // triage SLA is 4h; case has been in triage 6h.
    const opened = new Date(NOW.getTime() - 6 * HOUR_MS).toISOString();
    const events = [mkEvent({ case_id: 'c1', action: 'opened', recorded_at: opened })];
    const out = detectCaseSlaBreaches(events, NOW);
    expect(out.breach_count).toBe(1);
    expect(out.breach_rate).toBe(1);
    expect(out.breaches[0]).toMatchObject({
      case_id: 'c1',
      current_state: 'triage',
      sla_hours: 4,
    });
    expect(out.breaches[0]!.hours_in_state).toBeCloseTo(6, 5);
    expect(out.breaches[0]!.overdue_hours).toBeCloseTo(2, 5);
    expect(out.by_state.triage).toEqual({ open: 1, breached: 1 });
  });

  test('breaches sorted worst-first (largest overdue_hours)', () => {
    const events = [
      // c1: triage, 5h in → 1h overdue
      mkEvent({
        case_id: 'c1',
        action: 'opened',
        recorded_at: new Date(NOW.getTime() - 5 * HOUR_MS).toISOString(),
      }),
      // c2: triage, 100h in → 96h overdue
      mkEvent({
        case_id: 'c2',
        action: 'opened',
        recorded_at: new Date(NOW.getTime() - 100 * HOUR_MS).toISOString(),
      }),
      // c3: triage, 10h in → 6h overdue
      mkEvent({
        case_id: 'c3',
        action: 'opened',
        recorded_at: new Date(NOW.getTime() - 10 * HOUR_MS).toISOString(),
      }),
    ];
    const out = detectCaseSlaBreaches(events, NOW);
    expect(out.breaches.map((b) => b.case_id)).toEqual(['c2', 'c3', 'c1']);
  });

  test('states without an SLA entry are tracked open but never breached', () => {
    const events = [
      mkEvent({
        case_id: 'c1',
        action: 'opened',
        recorded_at: new Date(NOW.getTime() - 999 * HOUR_MS).toISOString(),
        payload: { initial_state: 'limbo' }, // no SLA in default map
      }),
    ];
    const out = detectCaseSlaBreaches(events, NOW);
    expect(out.by_state.limbo).toEqual({ open: 1, breached: 0 });
    expect(out.breach_count).toBe(0);
  });

  test('custom sla_by_state overrides the default map', () => {
    const opened = new Date(NOW.getTime() - 6 * HOUR_MS).toISOString();
    const events = [mkEvent({ case_id: 'c1', action: 'opened', recorded_at: opened })];
    // Custom SLA: triage = 100h — way more than 6h in state.
    const out = detectCaseSlaBreaches(events, NOW, { triage: 100 });
    expect(out.breach_count).toBe(0);
  });

  test('null SLA in the map suppresses breaches for that state', () => {
    const opened = new Date(NOW.getTime() - 6 * HOUR_MS).toISOString();
    const events = [mkEvent({ case_id: 'c1', action: 'opened', recorded_at: opened })];
    const out = detectCaseSlaBreaches(events, NOW, { triage: null });
    expect(out.breach_count).toBe(0);
    expect(out.by_state.triage?.open).toBe(1);
  });

  test('breach list capped at BREACH_LIST_CAP entries (sorted worst-first)', () => {
    const events: CaseEvent[] = [];
    // 60 cases, all in triage past SLA. overdue increases by case index.
    for (let i = 0; i < 60; i++) {
      events.push(
        mkEvent({
          case_id: `c${i}`,
          action: 'opened',
          recorded_at: new Date(NOW.getTime() - (5 + i) * HOUR_MS).toISOString(),
        }),
      );
    }
    const out = detectCaseSlaBreaches(events, NOW);
    expect(out.breach_count).toBe(60); // total still reported
    expect(out.breaches.length).toBe(BREACH_LIST_CAP); // list capped
    // Top of the list is the most-overdue case (c59 at 60h elapsed - 4h SLA = 56h overdue).
    expect(out.breaches[0]!.case_id).toBe('c59');
  });

  test('default SLA tiers map to canonical M9.1 InvestigationStatus names', () => {
    expect(DEFAULT_SLA_HOURS_BY_STATE.triage).toBe(4);
    expect(DEFAULT_SLA_HOURS_BY_STATE.gathering_evidence).toBe(24);
    expect(DEFAULT_SLA_HOURS_BY_STATE.awaiting_response).toBe(72);
    expect(DEFAULT_SLA_HOURS_BY_STATE.review).toBe(24);
    expect(DEFAULT_SLA_HOURS_BY_STATE.decision).toBe(12);
    expect(DEFAULT_SLA_HOURS_BY_STATE.closed).toBeNull();
  });
});

// ─── GET /v1/cases/sla-breaches ────────────────────────────────────────

function makeBreachApp(role = 'admin', store?: InMemoryCaseEventStore) {
  const eventStore = store ?? new InMemoryCaseEventStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    caseEventStore: eventStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, eventStore };
}

describe('M9.5 — GET /v1/cases/sla-breaches', () => {
  test('empty journal → 200 with zero envelope', async () => {
    const { app } = makeBreachApp('admin');
    const r = await request(app).get('/v1/cases/sla-breaches').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.summary.total_cases_observed).toBe(0);
    expect(r.body.body.summary.breach_count).toBe(0);
    expect(r.body.body.summary.breaches).toEqual([]);
  });

  test('case past SLA shows up as a breach', async () => {
    const eventStore = new InMemoryCaseEventStore();
    // Use the store API to ensure realistic sequence_no assignment.
    eventStore.record(
      'BIL',
      { case_id: 'case-overdue', action: 'opened', actor: 'alice' },
      new Date(NOW.getTime() - 8 * HOUR_MS), // triage SLA = 4h, 8h in = 4h overdue
    );
    const { app } = makeBreachApp('admin', eventStore);
    const r = await request(app).get('/v1/cases/sla-breaches').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.summary.breach_count).toBe(1);
    expect(r.body.body.summary.breaches[0].case_id).toBe('case-overdue');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBreachApp('case_owner');
    const r = await request(app).get('/v1/cases/sla-breaches').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant isolation: BANK_DEMO does not see BIL cases', async () => {
    const eventStore = new InMemoryCaseEventStore();
    eventStore.record(
      'BIL',
      { case_id: 'c1', action: 'opened', actor: 'alice' },
      new Date(NOW.getTime() - 999 * HOUR_MS),
    );
    const { app } = makeBreachApp('admin', eventStore);
    const r = await request(app)
      .get('/v1/cases/sla-breaches')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.summary.total_cases_observed).toBe(0);
  });
});
