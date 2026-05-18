// services/bff/__tests__/case_event_action_distribution.test.ts
//
// T6 M9.15 — Case event journal action distribution.

import request from 'supertest';
import { summarizeCaseEventActionDistribution } from '../src/case_event_action_distribution';
import {
  CASE_EVENT_ACTIONS,
  InMemoryCaseEventStore,
  type CaseEventAction,
  type CaseEventStore,
} from '../src/case_events';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeCadApp(role: string = 'admin', caseEventStore?: CaseEventStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    caseEventStore: caseEventStore ?? new InMemoryCaseEventStore(),
  });
}

function record(
  store: CaseEventStore,
  tenant: string,
  case_id: string,
  action: CaseEventAction,
  actor: string,
  at: Date = NOW,
) {
  return store.record(tenant, { case_id, action, actor }, at);
}

function drain(store: CaseEventStore, tenant: string) {
  return store.fetchSince(tenant, 0, 1000).items;
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M9.15 — empty input', () => {
  test('zero events → 9 rows at 0, leaderboards null', () => {
    const s = summarizeCaseEventActionDistribution('BIL', [], NOW);
    expect(s.total_events).toBe(0);
    expect(s.actions.length).toBe(9);
    for (const a of s.actions) {
      expect(a.count).toBe(0);
      expect(a.distinct_cases).toBe(0);
      expect(a.distinct_actors).toBe(0);
      expect(a.most_recent_at).toBeNull();
      expect(a.sample_actors).toEqual([]);
    }
    expect(s.most_common_action).toBeNull();
    expect(s.unused_actions).toEqual([...CASE_EVENT_ACTIONS]);
    expect(s.most_active_actor).toBeNull();
  });
});

describe('M9.15 — canonical action order', () => {
  test('actions[] in canonical CASE_EVENT_ACTIONS order', () => {
    const s = summarizeCaseEventActionDistribution('BIL', [], NOW);
    expect(s.actions.map((a) => a.action)).toEqual([...CASE_EVENT_ACTIONS]);
  });
});

describe('M9.15 — single event placement', () => {
  test('1 opened event → opened row count=1, others 0', () => {
    const store = new InMemoryCaseEventStore();
    record(store, 'BIL', 'c1', 'opened', 'alice');
    const s = summarizeCaseEventActionDistribution('BIL', drain(store, 'BIL'), NOW);
    const opened = s.actions.find((a) => a.action === 'opened')!;
    expect(opened.count).toBe(1);
    expect(opened.distinct_cases).toBe(1);
    expect(opened.distinct_actors).toBe(1);
    expect(opened.most_recent_at).toBe(NOW.toISOString());
    const noteAdded = s.actions.find((a) => a.action === 'note_added')!;
    expect(noteAdded.count).toBe(0);
    expect(s.total_events).toBe(1);
  });
});

describe('M9.15 — distinct_cases dedup', () => {
  test('3 events on 2 distinct cases → distinct_cases=2', () => {
    const store = new InMemoryCaseEventStore();
    record(store, 'BIL', 'c1', 'note_added', 'a');
    record(store, 'BIL', 'c1', 'note_added', 'a');
    record(store, 'BIL', 'c2', 'note_added', 'b');
    const s = summarizeCaseEventActionDistribution('BIL', drain(store, 'BIL'), NOW);
    const noteAdded = s.actions.find((a) => a.action === 'note_added')!;
    expect(noteAdded.count).toBe(3);
    expect(noteAdded.distinct_cases).toBe(2);
  });
});

describe('M9.15 — distinct_actors dedup', () => {
  test('alice twice + bob once on note_added → distinct_actors=2', () => {
    const store = new InMemoryCaseEventStore();
    record(store, 'BIL', 'c1', 'note_added', 'alice');
    record(store, 'BIL', 'c2', 'note_added', 'alice');
    record(store, 'BIL', 'c3', 'note_added', 'bob');
    const s = summarizeCaseEventActionDistribution('BIL', drain(store, 'BIL'), NOW);
    const noteAdded = s.actions.find((a) => a.action === 'note_added')!;
    expect(noteAdded.distinct_actors).toBe(2);
  });
});

describe('M9.15 — most_recent_at per row', () => {
  test('newest recorded_at across this row\'s events', () => {
    const store = new InMemoryCaseEventStore();
    record(store, 'BIL', 'c1', 'opened', 'a', new Date('2026-05-15T10:00:00.000Z'));
    record(store, 'BIL', 'c2', 'opened', 'b', new Date('2026-05-17T10:00:00.000Z'));
    record(store, 'BIL', 'c3', 'opened', 'c', new Date('2026-05-16T10:00:00.000Z'));
    const s = summarizeCaseEventActionDistribution('BIL', drain(store, 'BIL'), NOW);
    const opened = s.actions.find((a) => a.action === 'opened')!;
    expect(opened.most_recent_at).toBe('2026-05-17T10:00:00.000Z');
  });
});

describe('M9.15 — sample_actors top-3 sorted by most-recent', () => {
  test('top 3 most-recent actors per row', () => {
    const store = new InMemoryCaseEventStore();
    record(store, 'BIL', 'c1', 'note_added', 'alice', new Date('2026-05-15T10:00:00.000Z'));
    record(store, 'BIL', 'c2', 'note_added', 'bob', new Date('2026-05-17T10:00:00.000Z'));
    record(store, 'BIL', 'c3', 'note_added', 'carol', new Date('2026-05-16T10:00:00.000Z'));
    record(store, 'BIL', 'c4', 'note_added', 'dave', new Date('2026-05-14T10:00:00.000Z'));
    const s = summarizeCaseEventActionDistribution('BIL', drain(store, 'BIL'), NOW);
    const noteAdded = s.actions.find((a) => a.action === 'note_added')!;
    expect(noteAdded.sample_actors.length).toBe(3);
    expect(noteAdded.sample_actors).toEqual(['bob', 'carol', 'alice']);
  });

  test('sample_actors deduped (alice twice → 1 entry)', () => {
    const store = new InMemoryCaseEventStore();
    record(store, 'BIL', 'c1', 'note_added', 'alice');
    record(store, 'BIL', 'c2', 'note_added', 'alice');
    const s = summarizeCaseEventActionDistribution('BIL', drain(store, 'BIL'), NOW);
    const noteAdded = s.actions.find((a) => a.action === 'note_added')!;
    expect(noteAdded.sample_actors).toEqual(['alice']);
  });
});

describe('M9.15 — most_common_action formula', () => {
  test('highest-count action wins', () => {
    const store = new InMemoryCaseEventStore();
    record(store, 'BIL', 'c1', 'note_added', 'a');
    record(store, 'BIL', 'c1', 'note_added', 'a');
    record(store, 'BIL', 'c1', 'note_added', 'a');
    record(store, 'BIL', 'c1', 'opened', 'a');
    const s = summarizeCaseEventActionDistribution('BIL', drain(store, 'BIL'), NOW);
    expect(s.most_common_action).toBe('note_added');
  });

  test('canonical tie-break: opened wins over state_change at tied 1', () => {
    const store = new InMemoryCaseEventStore();
    // CASE_EVENT_ACTIONS = ['opened', 'state_change', ...]
    record(store, 'BIL', 'c1', 'opened', 'a');
    record(store, 'BIL', 'c2', 'state_change', 'a');
    const s = summarizeCaseEventActionDistribution('BIL', drain(store, 'BIL'), NOW);
    expect(s.most_common_action).toBe('opened');
  });

  test('null when no events', () => {
    const s = summarizeCaseEventActionDistribution('BIL', [], NOW);
    expect(s.most_common_action).toBeNull();
  });
});

describe('M9.15 — unused_actions', () => {
  test('canonical order zero-count subset', () => {
    const store = new InMemoryCaseEventStore();
    record(store, 'BIL', 'c1', 'opened', 'a');
    record(store, 'BIL', 'c1', 'closed', 'a');
    const s = summarizeCaseEventActionDistribution('BIL', drain(store, 'BIL'), NOW);
    // Used: opened, closed. Unused: everything else (7 actions)
    expect(s.unused_actions.length).toBe(7);
    expect(s.unused_actions).not.toContain('opened');
    expect(s.unused_actions).not.toContain('closed');
    // Order matches canonical
    expect(s.unused_actions[0]).toBe('state_change');
    expect(s.unused_actions[1]).toBe('escalated');
  });

  test('empty when every action used', () => {
    const store = new InMemoryCaseEventStore();
    for (const a of CASE_EVENT_ACTIONS) {
      record(store, 'BIL', 'c1', a, 'u');
    }
    const s = summarizeCaseEventActionDistribution('BIL', drain(store, 'BIL'), NOW);
    expect(s.unused_actions).toEqual([]);
  });
});

describe('M9.15 — most_active_actor', () => {
  test('actor with most events across all action types', () => {
    const store = new InMemoryCaseEventStore();
    record(store, 'BIL', 'c1', 'opened', 'alice');
    record(store, 'BIL', 'c2', 'note_added', 'alice');
    record(store, 'BIL', 'c3', 'note_added', 'alice');
    record(store, 'BIL', 'c1', 'note_added', 'bob');
    const s = summarizeCaseEventActionDistribution('BIL', drain(store, 'BIL'), NOW);
    expect(s.most_active_actor).toBe('alice');
  });

  test('canonical actor asc tie-break', () => {
    const store = new InMemoryCaseEventStore();
    record(store, 'BIL', 'c1', 'opened', 'alice');
    record(store, 'BIL', 'c2', 'note_added', 'bob');
    const s = summarizeCaseEventActionDistribution('BIL', drain(store, 'BIL'), NOW);
    expect(s.most_active_actor).toBe('alice');
  });

  test('null when no events', () => {
    const s = summarizeCaseEventActionDistribution('BIL', [], NOW);
    expect(s.most_active_actor).toBeNull();
  });
});

describe('M9.15 — total_events partition invariant', () => {
  test('Σ actions.count = total_events', () => {
    const store = new InMemoryCaseEventStore();
    record(store, 'BIL', 'c1', 'opened', 'a');
    record(store, 'BIL', 'c1', 'note_added', 'a');
    record(store, 'BIL', 'c1', 'closed', 'a');
    const s = summarizeCaseEventActionDistribution('BIL', drain(store, 'BIL'), NOW);
    const sum = s.actions.reduce((acc, a) => acc + a.count, 0);
    expect(sum).toBe(s.total_events);
    expect(s.total_events).toBe(3);
  });
});

describe('M9.15 — tenant scoping', () => {
  test('BIL events invisible to BANK_DEMO', () => {
    const store = new InMemoryCaseEventStore();
    record(store, 'BIL', 'c1', 'opened', 'a');
    record(store, 'BIL', 'c2', 'opened', 'b');
    const bil = summarizeCaseEventActionDistribution('BIL', drain(store, 'BIL'), NOW);
    const bank = summarizeCaseEventActionDistribution('BANK_DEMO', drain(store, 'BANK_DEMO'), NOW);
    expect(bil.total_events).toBe(2);
    expect(bank.total_events).toBe(0);
  });
});

describe('M9.15 — tenant_id + generated_at echo', () => {
  test('envelope echoes inputs', () => {
    const s = summarizeCaseEventActionDistribution('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M9.15 — GET /v1/cases/events/action-distribution', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeCadApp('admin');
    const r = await request(app)
      .get('/v1/cases/events/action-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(0);
    expect(r.body.body.actions.length).toBe(9);
    expect(r.body.body.most_common_action).toBeNull();
  });

  test('populated → reflects recorded events', async () => {
    const store = new InMemoryCaseEventStore();
    record(store, 'BIL', 'c1', 'opened', 'alice');
    record(store, 'BIL', 'c1', 'note_added', 'alice');
    record(store, 'BIL', 'c1', 'closed', 'alice');
    const { app } = makeCadApp('admin', store);
    const r = await request(app)
      .get('/v1/cases/events/action-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_events).toBe(3);
    expect(r.body.body.most_active_actor).toBe('alice');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCadApp('case_owner');
    const r = await request(app)
      .get('/v1/cases/events/action-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryCaseEventStore();
    record(store, 'BIL', 'c1', 'opened', 'alice');
    const { app } = makeCadApp('admin', store);
    const bankR = await request(app)
      .get('/v1/cases/events/action-distribution')
      .set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.total_events).toBe(0);
    const bilR = await request(app)
      .get('/v1/cases/events/action-distribution')
      .set(TH_BIL);
    expect(bilR.body.body.total_events).toBe(1);
  });
});
