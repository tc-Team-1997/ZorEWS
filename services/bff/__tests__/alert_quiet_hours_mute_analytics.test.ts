// services/bff/__tests__/alert_quiet_hours_mute_analytics.test.ts
//
// T6 M10.9 — Quiet-hours mute analytics.

import request from 'supertest';
import {
  TOP_USERS_CAP,
  summarizeQuietHoursMutes,
} from '../src/alert_quiet_hours_mute_analytics';
import {
  InMemoryQuietHoursMuteEventStore,
  type QuietHoursMuteEvent,
} from '../src/alert_quiet_hours_mute';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkEvent(o: Partial<QuietHoursMuteEvent> = {}): QuietHoursMuteEvent {
  return {
    tenant_id: o.tenant_id ?? 'BIL',
    username: o.username ?? 'alice',
    alert_id: o.alert_id ?? `alert-${Math.random().toString(36).slice(2, 8)}`,
    bil_class: o.bil_class ?? 'orange',
    muted_at: o.muted_at ?? NOW.toISOString(),
    reason: o.reason ?? 'quiet hours',
  };
}

// ─── summarizeQuietHoursMutes — pure ─────────────────────────────────

describe('M10.9 — summarizeQuietHoursMutes — empty + shape', () => {
  test('empty events → zero envelope, all class keys present at 0', () => {
    const a = summarizeQuietHoursMutes([]);
    expect(a.sample_size).toBe(0);
    expect(a.distinct_users).toBe(0);
    expect(a.by_class).toEqual({ red: 0, orange: 0, yellow: 0, green: 0 });
    expect(a.by_day).toEqual([]);
    expect(a.top_users).toEqual([]);
  });
});

describe('M10.9 — class mix', () => {
  test('counts every observed class; unmentioned classes stay at 0', () => {
    const events: QuietHoursMuteEvent[] = [
      mkEvent({ bil_class: 'orange' }),
      mkEvent({ bil_class: 'orange' }),
      mkEvent({ bil_class: 'yellow' }),
      mkEvent({ bil_class: 'green' }),
    ];
    const a = summarizeQuietHoursMutes(events);
    expect(a.by_class).toEqual({ red: 0, orange: 2, yellow: 1, green: 1 });
  });
});

describe('M10.9 — distinct users + top_users', () => {
  test('distinct_users counts unique usernames', () => {
    const events: QuietHoursMuteEvent[] = [
      mkEvent({ username: 'alice' }),
      mkEvent({ username: 'bob' }),
      mkEvent({ username: 'alice' }),
    ];
    const a = summarizeQuietHoursMutes(events);
    expect(a.distinct_users).toBe(2);
  });

  test('top_users sorted by mute_count desc, ties broken by username asc', () => {
    const events: QuietHoursMuteEvent[] = [
      mkEvent({ username: 'alice' }),
      mkEvent({ username: 'alice' }),
      mkEvent({ username: 'alice' }),
      mkEvent({ username: 'bob' }),
      mkEvent({ username: 'bob' }),
      mkEvent({ username: 'carol' }),
      mkEvent({ username: 'dave' }),
      mkEvent({ username: 'dave' }),
    ];
    const a = summarizeQuietHoursMutes(events);
    // alice=3, dave=2, bob=2, carol=1
    expect(a.top_users.map((u) => u.username)).toEqual(['alice', 'bob', 'dave', 'carol']);
  });

  test('top_users capped at TOP_USERS_CAP', () => {
    const events: QuietHoursMuteEvent[] = [];
    for (let i = 0; i < 15; i++) {
      // user N has i+1 mutes so ordering is deterministic by count.
      const username = `user${String(i).padStart(2, '0')}`;
      for (let k = 0; k <= i; k++) events.push(mkEvent({ username }));
    }
    const a = summarizeQuietHoursMutes(events);
    expect(a.top_users.length).toBe(TOP_USERS_CAP);
    // user14 has 15 mutes (max).
    expect(a.top_users[0]!.username).toBe('user14');
  });
});

describe('M10.9 — by_day', () => {
  test('by_day buckets UTC days, oldest-first', () => {
    const events: QuietHoursMuteEvent[] = [
      mkEvent({ muted_at: '2026-05-14T02:00:00.000Z' }),
      mkEvent({ muted_at: '2026-05-14T23:00:00.000Z' }),
      mkEvent({ muted_at: '2026-05-12T05:00:00.000Z' }),
      mkEvent({ muted_at: '2026-05-13T10:00:00.000Z' }),
    ];
    const a = summarizeQuietHoursMutes(events);
    expect(a.by_day).toEqual([
      { day: '2026-05-12', count: 1 },
      { day: '2026-05-13', count: 1 },
      { day: '2026-05-14', count: 2 },
    ]);
  });
});

// ─── listAllForTenant — store-level ──────────────────────────────────

describe('M10.9 — InMemoryQuietHoursMuteEventStore.listAllForTenant', () => {
  test('returns events across all users for the tenant, newest-first', () => {
    const store = new InMemoryQuietHoursMuteEventStore();
    store.record(mkEvent({ tenant_id: 'BIL', username: 'alice', muted_at: '2026-05-14T08:00:00.000Z' }));
    store.record(mkEvent({ tenant_id: 'BIL', username: 'bob', muted_at: '2026-05-14T09:00:00.000Z' }));
    store.record(mkEvent({ tenant_id: 'BIL', username: 'alice', muted_at: '2026-05-14T10:00:00.000Z' }));
    const out = store.listAllForTenant('BIL');
    expect(out.length).toBe(3);
    expect(out.map((e) => e.muted_at)).toEqual([
      '2026-05-14T10:00:00.000Z',
      '2026-05-14T09:00:00.000Z',
      '2026-05-14T08:00:00.000Z',
    ]);
  });

  test('since filter excludes older events', () => {
    const store = new InMemoryQuietHoursMuteEventStore();
    store.record(mkEvent({ tenant_id: 'BIL', username: 'alice', muted_at: '2026-05-12T00:00:00.000Z' }));
    store.record(mkEvent({ tenant_id: 'BIL', username: 'alice', muted_at: '2026-05-14T00:00:00.000Z' }));
    const out = store.listAllForTenant('BIL', new Date('2026-05-13T00:00:00.000Z'));
    expect(out.length).toBe(1);
    expect(out[0]!.muted_at).toBe('2026-05-14T00:00:00.000Z');
  });

  test('tenant isolation', () => {
    const store = new InMemoryQuietHoursMuteEventStore();
    store.record(mkEvent({ tenant_id: 'BIL', username: 'alice' }));
    store.record(mkEvent({ tenant_id: 'BANK_DEMO', username: 'alice' }));
    expect(store.listAllForTenant('BIL').length).toBe(1);
    expect(store.listAllForTenant('BANK_DEMO').length).toBe(1);
    expect(store.listAllForTenant('OTHER').length).toBe(0);
  });
});

// ─── GET /v1/alerts/quiet-hours-muted/analytics ──────────────────────

function makeAnalyticsApp(role = 'admin', store?: InMemoryQuietHoursMuteEventStore) {
  const quietHoursMuteEventStore = store ?? new InMemoryQuietHoursMuteEventStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    quietHoursMuteEventStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, quietHoursMuteEventStore };
}

describe('M10.9 — GET /v1/alerts/quiet-hours-muted/analytics', () => {
  test('empty store → 200 zero envelope', async () => {
    const { app } = makeAnalyticsApp('admin');
    const r = await request(app)
      .get('/v1/alerts/quiet-hours-muted/analytics')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.analytics.sample_size).toBe(0);
    expect(r.body.body.analytics.distinct_users).toBe(0);
  });

  test('events surface in the rollup', async () => {
    const store = new InMemoryQuietHoursMuteEventStore();
    store.record(mkEvent({ tenant_id: 'BIL', username: 'alice', bil_class: 'orange' }));
    store.record(mkEvent({ tenant_id: 'BIL', username: 'alice', bil_class: 'yellow' }));
    store.record(mkEvent({ tenant_id: 'BIL', username: 'bob', bil_class: 'green' }));
    const { app } = makeAnalyticsApp('admin', store);
    const r = await request(app)
      .get('/v1/alerts/quiet-hours-muted/analytics')
      .set(TH_BIL);
    expect(r.body.body.analytics.sample_size).toBe(3);
    expect(r.body.body.analytics.distinct_users).toBe(2);
    expect(r.body.body.analytics.by_class.orange).toBe(1);
    expect(r.body.body.analytics.top_users[0].username).toBe('alice');
  });

  test('?since=ISO filter narrows the window', async () => {
    const store = new InMemoryQuietHoursMuteEventStore();
    store.record(
      mkEvent({ tenant_id: 'BIL', muted_at: '2026-05-12T00:00:00.000Z' }),
    );
    store.record(
      mkEvent({ tenant_id: 'BIL', muted_at: '2026-05-14T00:00:00.000Z' }),
    );
    const { app } = makeAnalyticsApp('admin', store);
    const r = await request(app)
      .get('/v1/alerts/quiet-hours-muted/analytics?since=2026-05-13T00:00:00.000Z')
      .set(TH_BIL);
    expect(r.body.body.analytics.sample_size).toBe(1);
  });

  test('?since=invalid → 400', async () => {
    const { app } = makeAnalyticsApp('admin');
    const r = await request(app)
      .get('/v1/alerts/quiet-hours-muted/analytics?since=not-a-date')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAnalyticsApp('case_owner');
    const r = await request(app)
      .get('/v1/alerts/quiet-hours-muted/analytics')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BANK_DEMO does not see BIL mutes', async () => {
    const store = new InMemoryQuietHoursMuteEventStore();
    store.record(mkEvent({ tenant_id: 'BIL', username: 'alice' }));
    const { app } = makeAnalyticsApp('admin', store);
    const r = await request(app)
      .get('/v1/alerts/quiet-hours-muted/analytics')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.analytics.sample_size).toBe(0);
  });
});
