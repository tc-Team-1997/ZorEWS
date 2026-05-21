// T6 M8.18 — Alert ack actor activity rollup tests.

import request from 'supertest';
import {
  EXCESSIVE_UNACKER_MIN_TOTAL,
  EXCESSIVE_UNACKER_RATE_THRESHOLD,
  summarizeAlertAckActorActivity,
} from '../src/alert_ack_actor_activity';
import { InMemoryAlertAckStore, type AlertAckState } from '../src/alert_ack';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T16:00:00.000Z');
const H_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function state(
  alert_id: string,
  history: Array<{
    ts: string;
    action: 'acknowledged' | 'unacknowledged';
    actor_username: string;
    notes: string | null;
  }>,
): AlertAckState {
  const last = history[history.length - 1];
  return {
    tenant_id: 'BIL',
    alert_id,
    status: last?.action === 'acknowledged' ? 'acknowledged' : 'open',
    acked_by: last?.action === 'acknowledged' ? last.actor_username : null,
    acked_at: last?.action === 'acknowledged' ? last.ts : null,
    ack_notes:
      last?.action === 'acknowledged' && typeof last.notes === 'string' ? last.notes : null,
    history,
  };
}

describe('summarizeAlertAckActorActivity', () => {
  test('empty input → empty actors + null leaderboards', () => {
    const r = summarizeAlertAckActorActivity('BIL', [], NOW);
    expect(r.tenant_id).toBe('BIL');
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(r.total_actions).toBe(0);
    expect(r.total_actors).toBe(0);
    expect(r.actors).toEqual([]);
    expect(r.most_active_actor).toBeNull();
    expect(r.excessive_unackers).toEqual([]);
    expect(r.by_action_totals).toEqual({ acknowledged: 0, unacknowledged: 0 });
  });

  test('single ack → 1 actor, ack_rate=1', () => {
    const r = summarizeAlertAckActorActivity(
      'BIL',
      [
        state('a-1', [
          { ts: '2026-05-21T10:00:00Z', action: 'acknowledged', actor_username: 'alice', notes: 'seen' },
        ]),
      ],
      NOW,
    );
    expect(r.total_actions).toBe(1);
    expect(r.total_actors).toBe(1);
    expect(r.actors[0].actor_username).toBe('alice');
    expect(r.actors[0].acknowledged_count).toBe(1);
    expect(r.actors[0].unacknowledged_count).toBe(0);
    expect(r.actors[0].ack_rate).toBe(1);
    expect(r.actors[0].distinct_alerts).toBe(1);
    expect(r.actors[0].alert_ids).toEqual(['a-1']);
    expect(r.most_active_actor).toBe('alice');
  });

  test('multi-actor sorted by total_actions desc', () => {
    const r = summarizeAlertAckActorActivity(
      'BIL',
      [
        state('a-1', [
          { ts: '2026-05-21T10:00:00Z', action: 'acknowledged', actor_username: 'alice', notes: null },
        ]),
        state('a-2', [
          { ts: '2026-05-21T11:00:00Z', action: 'acknowledged', actor_username: 'alice', notes: null },
        ]),
        state('a-3', [
          { ts: '2026-05-21T12:00:00Z', action: 'acknowledged', actor_username: 'alice', notes: null },
        ]),
        state('a-4', [
          { ts: '2026-05-21T13:00:00Z', action: 'acknowledged', actor_username: 'bob', notes: null },
        ]),
      ],
      NOW,
    );
    expect(r.actors[0].actor_username).toBe('alice');
    expect(r.actors[0].total_actions).toBe(3);
    expect(r.actors[1].actor_username).toBe('bob');
    expect(r.actors[1].total_actions).toBe(1);
  });

  test('actor_username asc tie-break at tied counts', () => {
    const r = summarizeAlertAckActorActivity(
      'BIL',
      [
        state('a-1', [
          { ts: '2026-05-21T10:00:00Z', action: 'acknowledged', actor_username: 'zebra', notes: null },
        ]),
        state('a-2', [
          { ts: '2026-05-21T11:00:00Z', action: 'acknowledged', actor_username: 'alpha', notes: null },
        ]),
      ],
      NOW,
    );
    expect(r.actors[0].actor_username).toBe('alpha');
    expect(r.actors[1].actor_username).toBe('zebra');
  });

  test('unack counted separately + ack_rate < 1', () => {
    const r = summarizeAlertAckActorActivity(
      'BIL',
      [
        state('a-1', [
          { ts: '2026-05-21T10:00:00Z', action: 'acknowledged', actor_username: 'alice', notes: null },
          { ts: '2026-05-21T11:00:00Z', action: 'unacknowledged', actor_username: 'alice', notes: 'wrong button' },
        ]),
      ],
      NOW,
    );
    expect(r.actors[0].acknowledged_count).toBe(1);
    expect(r.actors[0].unacknowledged_count).toBe(1);
    expect(r.actors[0].ack_rate).toBe(0.5);
    expect(r.actors[0].total_actions).toBe(2);
    expect(r.actors[0].distinct_alerts).toBe(1);
  });

  test('distinct_alerts dedupes across multiple actions on the same alert', () => {
    const r = summarizeAlertAckActorActivity(
      'BIL',
      [
        state('a-1', [
          { ts: '2026-05-21T10:00:00Z', action: 'acknowledged', actor_username: 'alice', notes: null },
          { ts: '2026-05-21T11:00:00Z', action: 'unacknowledged', actor_username: 'alice', notes: 'oops' },
          { ts: '2026-05-21T12:00:00Z', action: 'acknowledged', actor_username: 'alice', notes: null },
        ]),
      ],
      NOW,
    );
    expect(r.actors[0].total_actions).toBe(3);
    expect(r.actors[0].distinct_alerts).toBe(1);
  });

  test('most_recent_at + first_action_at track min/max ts', () => {
    const r = summarizeAlertAckActorActivity(
      'BIL',
      [
        state('a-1', [
          { ts: '2026-05-21T10:00:00Z', action: 'acknowledged', actor_username: 'alice', notes: null },
        ]),
        state('a-2', [
          { ts: '2026-05-21T08:00:00Z', action: 'acknowledged', actor_username: 'alice', notes: null },
        ]),
        state('a-3', [
          { ts: '2026-05-21T15:00:00Z', action: 'acknowledged', actor_username: 'alice', notes: null },
        ]),
      ],
      NOW,
    );
    expect(r.actors[0].first_action_at).toBe('2026-05-21T08:00:00Z');
    expect(r.actors[0].most_recent_at).toBe('2026-05-21T15:00:00Z');
  });

  test('Σ actors.total_actions = envelope.total_actions partition', () => {
    const r = summarizeAlertAckActorActivity(
      'BIL',
      [
        state('a-1', [
          { ts: '2026-05-21T10:00:00Z', action: 'acknowledged', actor_username: 'alice', notes: null },
        ]),
        state('a-2', [
          { ts: '2026-05-21T11:00:00Z', action: 'acknowledged', actor_username: 'bob', notes: null },
          { ts: '2026-05-21T12:00:00Z', action: 'unacknowledged', actor_username: 'bob', notes: 'mis' },
        ]),
      ],
      NOW,
    );
    const sum = r.actors.reduce((a, b) => a + b.total_actions, 0);
    expect(sum).toBe(r.total_actions);
    expect(r.total_actions).toBe(3);
  });

  test('by_action_totals matches Σ across actors', () => {
    const r = summarizeAlertAckActorActivity(
      'BIL',
      [
        state('a-1', [
          { ts: '2026-05-21T10:00:00Z', action: 'acknowledged', actor_username: 'alice', notes: null },
          { ts: '2026-05-21T11:00:00Z', action: 'unacknowledged', actor_username: 'alice', notes: 'oops' },
        ]),
      ],
      NOW,
    );
    expect(r.by_action_totals).toEqual({ acknowledged: 1, unacknowledged: 1 });
    const sumAck = r.actors.reduce((a, b) => a + b.acknowledged_count, 0);
    const sumUnack = r.actors.reduce((a, b) => a + b.unacknowledged_count, 0);
    expect(sumAck).toBe(r.by_action_totals.acknowledged);
    expect(sumUnack).toBe(r.by_action_totals.unacknowledged);
  });

  test('excessive_unackers flags actors with unack_rate >= 0.5 AND total >= 3', () => {
    // alice: 1 ack + 2 unacks → unack_rate=2/3, total=3 → FLAGGED
    // bob: 2 acks + 0 unacks → unack_rate=0, total=2 → not flagged
    // carol: 0 acks + 2 unacks → unack_rate=1, total=2 → not flagged (total<3)
    const r = summarizeAlertAckActorActivity(
      'BIL',
      [
        state('a-1', [
          { ts: '2026-05-21T10:00:00Z', action: 'acknowledged', actor_username: 'alice', notes: null },
          { ts: '2026-05-21T11:00:00Z', action: 'unacknowledged', actor_username: 'alice', notes: 'oops' },
        ]),
        state('a-2', [
          { ts: '2026-05-21T12:00:00Z', action: 'unacknowledged', actor_username: 'alice', notes: 'oops' },
        ]),
        state('a-3', [
          { ts: '2026-05-21T13:00:00Z', action: 'acknowledged', actor_username: 'bob', notes: null },
        ]),
        state('a-4', [
          { ts: '2026-05-21T14:00:00Z', action: 'acknowledged', actor_username: 'bob', notes: null },
        ]),
        state('a-5', [
          { ts: '2026-05-21T15:00:00Z', action: 'unacknowledged', actor_username: 'carol', notes: 'oops' },
        ]),
        state('a-6', [
          { ts: '2026-05-21T16:00:00Z', action: 'unacknowledged', actor_username: 'carol', notes: 'oops' },
        ]),
      ],
      NOW,
    );
    expect(r.excessive_unackers).toEqual(['alice']);
  });

  test('threshold constants exported', () => {
    expect(EXCESSIVE_UNACKER_MIN_TOTAL).toBe(3);
    expect(EXCESSIVE_UNACKER_RATE_THRESHOLD).toBe(0.5);
  });

  test('empty actor_username defensively skipped', () => {
    const r = summarizeAlertAckActorActivity(
      'BIL',
      [
        state('a-1', [
          { ts: '2026-05-21T10:00:00Z', action: 'acknowledged', actor_username: '', notes: null },
          { ts: '2026-05-21T11:00:00Z', action: 'acknowledged', actor_username: 'alice', notes: null },
        ]),
      ],
      NOW,
    );
    expect(r.total_actions).toBe(1);
    expect(r.actors).toHaveLength(1);
    expect(r.actors[0].actor_username).toBe('alice');
  });

  test('alert_ids sorted asc + capped at 50', () => {
    const states: AlertAckState[] = [];
    for (let i = 0; i < 60; i += 1) {
      states.push(
        state(`a-${String(i).padStart(3, '0')}`, [
          {
            ts: `2026-05-21T10:${String(i % 60).padStart(2, '0')}:00Z`,
            action: 'acknowledged',
            actor_username: 'alice',
            notes: null,
          },
        ]),
      );
    }
    const r = summarizeAlertAckActorActivity('BIL', states, NOW);
    expect(r.actors[0].alert_ids).toHaveLength(50);
    // Sorted asc.
    const ids = r.actors[0].alert_ids;
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i - 1] <= ids[i]).toBe(true);
    }
  });
});

describe('InMemoryAlertAckStore.listForTenant', () => {
  test('returns empty when tenant has never touched an alert', () => {
    const store = new InMemoryAlertAckStore();
    expect(store.listForTenant('BIL')).toEqual([]);
  });

  test('returns states after acks + unacks', () => {
    const store = new InMemoryAlertAckStore();
    store.acknowledge('BIL', 'a-1', 'alice', 'seen', NOW);
    store.acknowledge('BIL', 'a-2', 'bob', null, NOW);
    const out = store.listForTenant('BIL');
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.alert_id === 'a-1')?.acked_by).toBe('alice');
  });

  test('tenant-scoped — BIL data not visible to BANK_DEMO', () => {
    const store = new InMemoryAlertAckStore();
    store.acknowledge('BIL', 'a-1', 'alice', null, NOW);
    expect(store.listForTenant('BANK_DEMO')).toEqual([]);
  });

  test('returned states are defensive copies', () => {
    const store = new InMemoryAlertAckStore();
    store.acknowledge('BIL', 'a-1', 'alice', null, NOW);
    const out = store.listForTenant('BIL');
    out[0].history.push({
      ts: 'pwned',
      action: 'acknowledged',
      actor_username: 'attacker',
      notes: null,
    });
    // Re-fetch — the mutation didn't pollute the store.
    const fresh = store.listForTenant('BIL');
    expect(fresh[0].history).toHaveLength(1);
    expect(fresh[0].history[0].actor_username).toBe('alice');
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

function makeRouteApp(role: string = 'admin', store?: InMemoryAlertAckStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    alertAckStore: store,
  });
}

describe('GET /v1/alerts/ack/actor-activity', () => {
  test('admin happy path with empty store', async () => {
    const store = new InMemoryAlertAckStore();
    const { app } = makeRouteApp('admin', store);
    const r = await request(app).get('/v1/alerts/ack/actor-activity').set(H_BIL);
    expect(r.status).toBe(200);
    expect(r.body.header?.status).toBe('SUCCESS');
    expect(r.body.body.total_actions).toBe(0);
    expect(r.body.body.actors).toEqual([]);
    expect(r.body.body.most_active_actor).toBeNull();
  });

  test('populated store reflects in response', async () => {
    const store = new InMemoryAlertAckStore();
    store.acknowledge('BIL', 'a-1', 'alice', 'seen', NOW);
    store.acknowledge('BIL', 'a-2', 'alice', null, NOW);
    store.acknowledge('BIL', 'a-3', 'bob', null, NOW);
    const { app } = makeRouteApp('admin', store);
    const r = await request(app).get('/v1/alerts/ack/actor-activity').set(H_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_actions).toBe(3);
    expect(r.body.body.total_actors).toBe(2);
    expect(r.body.body.most_active_actor).toBe('alice');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRouteApp('field_officer');
    const r = await request(app).get('/v1/alerts/ack/actor-activity').set(H_BIL);
    expect(r.status).toBe(403);
  });

  test('tenant-scoped — BIL store invisible to BANK_DEMO request', async () => {
    const store = new InMemoryAlertAckStore();
    store.acknowledge('BIL', 'a-1', 'alice', null, NOW);
    const { app } = makeRouteApp('admin', store);
    const r = await request(app)
      .get('/v1/alerts/ack/actor-activity')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r.status).toBe(200);
    expect(r.body.body.total_actions).toBe(0);
  });

  test('missing tenant header → 400', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app).get('/v1/alerts/ack/actor-activity');
    expect(r.status).toBe(400);
  });
});
