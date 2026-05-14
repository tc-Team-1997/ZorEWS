// services/bff/__tests__/adapter_sla_breach_analytics.test.ts
//
// T6 M14.20 — Adapter SLA breach event analytics.

import request from 'supertest';
import {
  TOP_BREACHERS_CAP,
  summarizeBreachEvents,
} from '../src/adapter_sla_breach_analytics';
import {
  InMemoryAdapterSlaBreachEventStore,
  type AdapterSlaBreachEvent,
  type SlaBreachReason,
} from '../src/adapter_sla_dashboard';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

let evId = 0;
function mkBreach(o: Partial<AdapterSlaBreachEvent> = {}): AdapterSlaBreachEvent {
  evId += 1;
  return {
    event_id: o.event_id ?? `evt-${evId}`,
    tenant_id: o.tenant_id ?? 'BIL',
    connector_id: o.connector_id ?? 'cbs_loan_book',
    connector_name: o.connector_name ?? 'CBS Loan Book',
    source_system: o.source_system ?? 'cbs',
    observed_at: o.observed_at ?? NOW.toISOString(),
    sla_breaches: o.sla_breaches ?? (['success_rate_below_target'] as SlaBreachReason[]),
    success_rate: o.success_rate ?? 0.8,
    p95_latency_ms: o.p95_latency_ms ?? 1200,
    sla_targets: o.sla_targets ?? { min_success_rate: 0.95, max_p95_latency_ms: 30000 },
    ...(o.acknowledged_by ? { acknowledged_by: o.acknowledged_by } : {}),
    ...(o.acknowledged_at ? { acknowledged_at: o.acknowledged_at } : {}),
  };
}

beforeEach(() => {
  evId = 0;
});

// ─── summarizeBreachEvents — pure ────────────────────────────────────

describe('M14.20 — summarizeBreachEvents — empty + shape', () => {
  test('empty input → zero envelope, every reason key at 0', () => {
    const a = summarizeBreachEvents([]);
    expect(a.sample_size).toBe(0);
    expect(a.distinct_connectors).toBe(0);
    expect(a.acknowledged_count).toBe(0);
    expect(a.unacknowledged_count).toBe(0);
    expect(a.ack_rate).toBeNull();
    expect(a.by_reason).toEqual({
      success_rate_below_target: 0,
      p95_latency_above_target: 0,
      no_finished_runs: 0,
    });
    expect(a.by_day).toEqual([]);
    expect(a.top_breachers).toEqual([]);
  });
});

describe('M14.20 — reason + connector + ack mix', () => {
  test('by_reason counts each reason within sla_breaches[]', () => {
    const events: AdapterSlaBreachEvent[] = [
      mkBreach({ sla_breaches: ['success_rate_below_target'] }),
      mkBreach({ sla_breaches: ['success_rate_below_target', 'p95_latency_above_target'] }),
      mkBreach({ sla_breaches: ['no_finished_runs'] }),
    ];
    const a = summarizeBreachEvents(events);
    expect(a.by_reason).toEqual({
      success_rate_below_target: 2,
      p95_latency_above_target: 1,
      no_finished_runs: 1,
    });
  });

  test('distinct_connectors counts unique connector_id', () => {
    const events: AdapterSlaBreachEvent[] = [
      mkBreach({ connector_id: 'a' }),
      mkBreach({ connector_id: 'a' }),
      mkBreach({ connector_id: 'b' }),
    ];
    const a = summarizeBreachEvents(events);
    expect(a.distinct_connectors).toBe(2);
  });

  test('acknowledged_count + unacknowledged_count + ack_rate', () => {
    const events: AdapterSlaBreachEvent[] = [
      mkBreach({ acknowledged_at: NOW.toISOString(), acknowledged_by: 'alice' }),
      mkBreach({ acknowledged_at: NOW.toISOString(), acknowledged_by: 'alice' }),
      mkBreach(), // unacked
    ];
    const a = summarizeBreachEvents(events);
    expect(a.acknowledged_count).toBe(2);
    expect(a.unacknowledged_count).toBe(1);
    expect(a.ack_rate).toBeCloseTo(2 / 3, 5);
  });
});

describe('M14.20 — top_breachers leaderboard', () => {
  test('sorted by breach_count desc, ties broken by last_breached_at desc then connector_id asc', () => {
    const events: AdapterSlaBreachEvent[] = [
      mkBreach({ connector_id: 'a', observed_at: '2026-05-14T08:00:00.000Z' }),
      mkBreach({ connector_id: 'a', observed_at: '2026-05-14T09:00:00.000Z' }),
      mkBreach({ connector_id: 'a', observed_at: '2026-05-14T10:00:00.000Z' }),
      // b tied with c (2 each), but b's last is newer than c's last → b first
      mkBreach({ connector_id: 'b', observed_at: '2026-05-14T08:00:00.000Z' }),
      mkBreach({ connector_id: 'b', observed_at: '2026-05-14T11:00:00.000Z' }),
      mkBreach({ connector_id: 'c', observed_at: '2026-05-14T07:00:00.000Z' }),
      mkBreach({ connector_id: 'c', observed_at: '2026-05-14T08:00:00.000Z' }),
    ];
    const a = summarizeBreachEvents(events);
    expect(a.top_breachers.map((b) => b.connector_id)).toEqual(['a', 'b', 'c']);
    expect(a.top_breachers[0]!.breach_count).toBe(3);
    expect(a.top_breachers[1]!.last_breached_at).toBe('2026-05-14T11:00:00.000Z');
  });

  test('top_breachers capped at TOP_BREACHERS_CAP', () => {
    const events: AdapterSlaBreachEvent[] = [];
    for (let i = 0; i < 15; i++) {
      // connector i has i+1 events.
      const connector_id = `cnx_${String(i).padStart(2, '0')}`;
      for (let k = 0; k <= i; k++) events.push(mkBreach({ connector_id }));
    }
    const a = summarizeBreachEvents(events);
    expect(a.top_breachers.length).toBe(TOP_BREACHERS_CAP);
    // cnx_14 has 15 events (max).
    expect(a.top_breachers[0]!.connector_id).toBe('cnx_14');
  });

  test('recent_reasons cap at 3, newest-first', () => {
    const events: AdapterSlaBreachEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(
        mkBreach({
          connector_id: 'cbs',
          observed_at: `2026-05-14T0${i}:00:00.000Z`,
          sla_breaches: [['success_rate_below_target', 'p95_latency_above_target', 'no_finished_runs'][i]! as SlaBreachReason],
        }),
      );
    }
    const a = summarizeBreachEvents(events);
    expect(a.top_breachers[0]!.recent_reasons.length).toBe(3);
  });

  test('connector_name stays in sync with the newest event (rename-safe)', () => {
    const events: AdapterSlaBreachEvent[] = [
      mkBreach({
        connector_id: 'cbs',
        connector_name: 'CBS (old)',
        observed_at: '2026-05-14T08:00:00.000Z',
      }),
      mkBreach({
        connector_id: 'cbs',
        connector_name: 'CBS (renamed)',
        observed_at: '2026-05-14T10:00:00.000Z',
      }),
    ];
    const a = summarizeBreachEvents(events);
    expect(a.top_breachers[0]!.connector_name).toBe('CBS (renamed)');
  });
});

describe('M14.20 — by_day', () => {
  test('UTC daily buckets, oldest-first', () => {
    const events: AdapterSlaBreachEvent[] = [
      mkBreach({ observed_at: '2026-05-14T02:00:00.000Z' }),
      mkBreach({ observed_at: '2026-05-12T08:00:00.000Z' }),
      mkBreach({ observed_at: '2026-05-13T15:00:00.000Z' }),
      mkBreach({ observed_at: '2026-05-14T23:00:00.000Z' }),
    ];
    const a = summarizeBreachEvents(events);
    expect(a.by_day).toEqual([
      { day: '2026-05-12', count: 1 },
      { day: '2026-05-13', count: 1 },
      { day: '2026-05-14', count: 2 },
    ]);
  });
});

// ─── GET /v1/ingestion/adapters/sla-breaches/analytics ───────────────

function makeBreachApp(role = 'admin', store?: InMemoryAdapterSlaBreachEventStore) {
  const adapterSlaBreachEventStore = store ?? new InMemoryAdapterSlaBreachEventStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    adapterSlaBreachEventStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, adapterSlaBreachEventStore };
}

describe('M14.20 — GET /v1/ingestion/adapters/sla-breaches/analytics', () => {
  test('empty store → 200 zero envelope', async () => {
    const { app } = makeBreachApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/adapters/sla-breaches/analytics')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.analytics.sample_size).toBe(0);
  });

  test('events surface in rollup', async () => {
    const store = new InMemoryAdapterSlaBreachEventStore();
    store.record(mkBreach({ tenant_id: 'BIL', connector_id: 'a' }));
    store.record(mkBreach({ tenant_id: 'BIL', connector_id: 'a' }));
    store.record(mkBreach({ tenant_id: 'BIL', connector_id: 'b' }));
    const { app } = makeBreachApp('admin', store);
    const r = await request(app)
      .get('/v1/ingestion/adapters/sla-breaches/analytics')
      .set(TH_BIL);
    expect(r.body.body.analytics.sample_size).toBe(3);
    expect(r.body.body.analytics.distinct_connectors).toBe(2);
    expect(r.body.body.analytics.top_breachers[0].connector_id).toBe('a');
    expect(r.body.body.analytics.top_breachers[0].breach_count).toBe(2);
  });

  test('?since=ISO narrows the window', async () => {
    const store = new InMemoryAdapterSlaBreachEventStore();
    store.record(mkBreach({ tenant_id: 'BIL', observed_at: '2026-05-12T00:00:00.000Z' }));
    store.record(mkBreach({ tenant_id: 'BIL', observed_at: '2026-05-14T00:00:00.000Z' }));
    const { app } = makeBreachApp('admin', store);
    const r = await request(app)
      .get('/v1/ingestion/adapters/sla-breaches/analytics?since=2026-05-13T00:00:00Z')
      .set(TH_BIL);
    expect(r.body.body.analytics.sample_size).toBe(1);
  });

  test('?since=invalid → 400', async () => {
    const { app } = makeBreachApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/adapters/sla-breaches/analytics?since=not-a-date')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBreachApp('case_owner');
    const r = await request(app)
      .get('/v1/ingestion/adapters/sla-breaches/analytics')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant isolation', async () => {
    const store = new InMemoryAdapterSlaBreachEventStore();
    store.record(mkBreach({ tenant_id: 'BIL' }));
    const { app } = makeBreachApp('admin', store);
    const r = await request(app)
      .get('/v1/ingestion/adapters/sla-breaches/analytics')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.body.body.analytics.sample_size).toBe(0);
  });
});
