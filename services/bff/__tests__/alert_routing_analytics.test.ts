// services/bff/__tests__/alert_routing_analytics.test.ts
//
// T6 M8.6 — Alert auto-routing analytics.

import request from 'supertest';
import {
  InMemoryRoutingLedger,
  ROUTING_ANALYTICS_DEFAULT_WINDOW,
  ROUTING_ANALYTICS_MAX_WINDOW,
  aggregateRoutingAnalytics,
  type RoutedAlertRecord,
} from '../src/alert_routing_analytics';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeAnalyticsApp(role = 'admin', ledger?: InMemoryRoutingLedger) {
  const reg = ledger ?? new InMemoryRoutingLedger();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    routingLedger: reg,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, ledger: reg };
}

const NOW = new Date('2026-05-14T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function makeRec(o: Partial<RoutedAlertRecord> & { alert_id: string }): RoutedAlertRecord {
  return {
    alert_id: o.alert_id,
    tenant_id: o.tenant_id ?? 'BIL',
    created_at: o.created_at ?? NOW.toISOString(),
    severity_in: o.severity_in ?? 'HIGH',
    class: o.class ?? 'orange',
    channels: o.channels ?? ['email', 'in_app'],
    sla_hours: o.sla_hours ?? 24,
    escalate_after_hours: o.escalate_after_hours ?? 12,
    monitor_only: o.monitor_only ?? false,
    acked_at: o.acked_at ?? null,
  };
}

// ─── aggregateRoutingAnalytics ────────────────────────────────────────

describe('M8.6 — aggregateRoutingAnalytics — empty + shape', () => {
  test('empty input → all-zero envelope, null rate fields, every class/channel key present', () => {
    const a = aggregateRoutingAnalytics([], NOW);
    expect(a.sample_size).toBe(0);
    expect(a.monitor_only_count).toBe(0);
    expect(a.ack_rate).toBeNull();
    expect(a.sla_breach_count).toBe(0);
    expect(a.sla_eligible_count).toBe(0);
    expect(a.sla_breach_rate).toBeNull();
    expect(a.escalation_due_count).toBe(0);
    expect(a.by_class).toEqual({ red: 0, orange: 0, yellow: 0, green: 0 });
    expect(a.by_channel).toEqual({ email: 0, sms: 0, in_app: 0, push: 0 });
    expect(a.time_to_ack_ms).toEqual({
      min: null,
      mean: null,
      p50: null,
      p95: null,
      max: null,
    });
  });
});

describe('M8.6 — class + channel mix', () => {
  test('by_class counts every routed record; by_channel counts once per channel per alert', () => {
    const recs: RoutedAlertRecord[] = [
      makeRec({ alert_id: 'a1', class: 'red', channels: ['email', 'sms'] }),
      makeRec({ alert_id: 'a2', class: 'orange', channels: ['email', 'in_app'] }),
      makeRec({ alert_id: 'a3', class: 'yellow', channels: ['email', 'in_app'] }),
      makeRec({
        alert_id: 'a4',
        class: 'green',
        channels: ['in_app'],
        monitor_only: true,
        sla_hours: null,
        escalate_after_hours: null,
      }),
    ];
    const a = aggregateRoutingAnalytics(recs, NOW);
    expect(a.sample_size).toBe(4);
    expect(a.by_class).toEqual({ red: 1, orange: 1, yellow: 1, green: 1 });
    // email appears in a1+a2+a3, sms in a1, in_app in a2+a3+a4, push nowhere
    expect(a.by_channel).toEqual({ email: 3, sms: 1, in_app: 3, push: 0 });
  });
});

describe('M8.6 — ack_rate', () => {
  test('ack_rate excludes monitor_only records; null when only monitor_only present', () => {
    const monitorOnly = makeRec({
      alert_id: 'g1',
      class: 'green',
      channels: ['in_app'],
      monitor_only: true,
      sla_hours: null,
      escalate_after_hours: null,
    });
    const a = aggregateRoutingAnalytics([monitorOnly], NOW);
    expect(a.monitor_only_count).toBe(1);
    expect(a.ack_rate).toBeNull();
  });

  test('ack_rate = acked-non-monitor / non-monitor', () => {
    const t0 = NOW.toISOString();
    const ackedSoon = new Date(NOW.getTime() + HOUR_MS).toISOString();
    const recs: RoutedAlertRecord[] = [
      makeRec({ alert_id: 'a1', created_at: t0, acked_at: ackedSoon }),
      makeRec({ alert_id: 'a2', created_at: t0, acked_at: ackedSoon }),
      makeRec({ alert_id: 'a3', created_at: t0, acked_at: null }), // open
      makeRec({
        alert_id: 'a4',
        class: 'green',
        monitor_only: true,
        sla_hours: null,
        escalate_after_hours: null,
      }),
    ];
    // 2 acked / 3 non-monitor = 0.666…
    const a = aggregateRoutingAnalytics(recs, new Date(NOW.getTime() + 2 * HOUR_MS));
    expect(a.monitor_only_count).toBe(1);
    expect(a.ack_rate).toBeCloseTo(2 / 3, 5);
  });
});

describe('M8.6 — time_to_ack percentiles', () => {
  test('p50 over 5 evenly-spaced ack durations equals the middle value', () => {
    const t0 = new Date('2026-05-14T00:00:00.000Z');
    // Five non-monitor alerts each acked at 1, 2, 3, 4, 5 hours.
    const recs: RoutedAlertRecord[] = [1, 2, 3, 4, 5].map((h, i) =>
      makeRec({
        alert_id: `a${i}`,
        created_at: t0.toISOString(),
        acked_at: new Date(t0.getTime() + h * HOUR_MS).toISOString(),
        sla_hours: null, // ignore SLA for this test
        escalate_after_hours: null,
      }),
    );
    const a = aggregateRoutingAnalytics(recs, new Date(t0.getTime() + 24 * HOUR_MS));
    expect(a.time_to_ack_ms.min).toBe(1 * HOUR_MS);
    expect(a.time_to_ack_ms.p50).toBe(3 * HOUR_MS); // median of 1..5
    expect(a.time_to_ack_ms.max).toBe(5 * HOUR_MS);
    expect(a.time_to_ack_ms.mean).toBe(3 * HOUR_MS);
  });

  test('time_to_ack ignores open + monitor_only records', () => {
    const t0 = NOW;
    const ackedAt = new Date(t0.getTime() + 2 * HOUR_MS).toISOString();
    const recs: RoutedAlertRecord[] = [
      makeRec({
        alert_id: 'a1',
        created_at: t0.toISOString(),
        acked_at: ackedAt,
        sla_hours: null,
        escalate_after_hours: null,
      }),
      makeRec({ alert_id: 'open1', created_at: t0.toISOString(), acked_at: null }),
      makeRec({
        alert_id: 'mon1',
        class: 'green',
        monitor_only: true,
        sla_hours: null,
        escalate_after_hours: null,
        created_at: t0.toISOString(),
        acked_at: new Date(t0.getTime() + 99 * HOUR_MS).toISOString(),
      }),
    ];
    const a = aggregateRoutingAnalytics(recs, new Date(t0.getTime() + 24 * HOUR_MS));
    // Only a1 contributes — duration is exactly 2h.
    expect(a.time_to_ack_ms.min).toBe(2 * HOUR_MS);
    expect(a.time_to_ack_ms.max).toBe(2 * HOUR_MS);
    expect(a.time_to_ack_ms.mean).toBe(2 * HOUR_MS);
  });
});

describe('M8.6 — SLA breach', () => {
  test('acked-after-SLA counts as a breach; acked-within does not', () => {
    const t0 = NOW;
    const recs: RoutedAlertRecord[] = [
      // Orange SLA 24h, acked at 25h → breach.
      makeRec({
        alert_id: 'breach1',
        class: 'orange',
        created_at: t0.toISOString(),
        sla_hours: 24,
        escalate_after_hours: 12,
        acked_at: new Date(t0.getTime() + 25 * HOUR_MS).toISOString(),
      }),
      // Orange SLA 24h, acked at 1h → on time.
      makeRec({
        alert_id: 'ontime1',
        class: 'orange',
        created_at: t0.toISOString(),
        sla_hours: 24,
        escalate_after_hours: 12,
        acked_at: new Date(t0.getTime() + 1 * HOUR_MS).toISOString(),
      }),
    ];
    const a = aggregateRoutingAnalytics(recs, new Date(t0.getTime() + 30 * HOUR_MS));
    expect(a.sla_eligible_count).toBe(2);
    expect(a.sla_breach_count).toBe(1);
    expect(a.sla_breach_rate).toBe(0.5);
  });

  test('open + now past SLA counts as a breach; monitor_only never does', () => {
    const t0 = NOW;
    const recs: RoutedAlertRecord[] = [
      // Red SLA 4h, still open, now is 5h later → breach.
      makeRec({
        alert_id: 'overdue1',
        class: 'red',
        created_at: t0.toISOString(),
        sla_hours: 4,
        escalate_after_hours: 1,
        acked_at: null,
      }),
      // Green monitor_only — SLA null, never breaches.
      makeRec({
        alert_id: 'mon1',
        class: 'green',
        monitor_only: true,
        sla_hours: null,
        escalate_after_hours: null,
        created_at: t0.toISOString(),
        acked_at: null,
      }),
    ];
    const a = aggregateRoutingAnalytics(recs, new Date(t0.getTime() + 5 * HOUR_MS));
    expect(a.sla_eligible_count).toBe(1);
    expect(a.sla_breach_count).toBe(1);
    expect(a.monitor_only_count).toBe(1);
  });
});

describe('M8.6 — escalation_due', () => {
  test('open + now past escalate_after_hours counts; acked records do not', () => {
    const t0 = NOW;
    const recs: RoutedAlertRecord[] = [
      // Orange escalate_after 12h, open, now is 13h later → due.
      makeRec({
        alert_id: 'esc1',
        class: 'orange',
        created_at: t0.toISOString(),
        escalate_after_hours: 12,
        sla_hours: 24,
        acked_at: null,
      }),
      // Same as above but acked already → not due.
      makeRec({
        alert_id: 'acked1',
        class: 'orange',
        created_at: t0.toISOString(),
        escalate_after_hours: 12,
        sla_hours: 24,
        acked_at: new Date(t0.getTime() + 1 * HOUR_MS).toISOString(),
      }),
      // Open but inside escalation window → not due.
      makeRec({
        alert_id: 'fresh1',
        class: 'orange',
        created_at: new Date(t0.getTime() + 1 * HOUR_MS).toISOString(),
        escalate_after_hours: 12,
        sla_hours: 24,
        acked_at: null,
      }),
    ];
    const a = aggregateRoutingAnalytics(recs, new Date(t0.getTime() + 13 * HOUR_MS));
    expect(a.escalation_due_count).toBe(1);
  });
});

// ─── InMemoryRoutingLedger ────────────────────────────────────────────

describe('M8.6 — InMemoryRoutingLedger', () => {
  test('list returns newest-first within the window', () => {
    const ledger = new InMemoryRoutingLedger();
    for (let i = 0; i < 5; i++) {
      ledger.record(
        makeRec({
          alert_id: `a${i}`,
          created_at: new Date(NOW.getTime() + i * HOUR_MS).toISOString(),
        }),
      );
    }
    const list = ledger.list('BIL', 3);
    expect(list.map((r) => r.alert_id)).toEqual(['a4', 'a3', 'a2']);
  });

  test('FIFO evicts oldest past the per-tenant cap', () => {
    const ledger = new InMemoryRoutingLedger();
    // Cap is 200; push 210 to force eviction of the first 10.
    for (let i = 0; i < 210; i++) {
      ledger.record(makeRec({ alert_id: `a${i}` }));
    }
    const all = ledger.list('BIL', ROUTING_ANALYTICS_MAX_WINDOW);
    expect(all.length).toBe(ROUTING_ANALYTICS_MAX_WINDOW);
    // Newest first → a209; oldest survivor a10 (a0..a9 evicted).
    expect(all[0]!.alert_id).toBe('a209');
    expect(all[all.length - 1]!.alert_id).toBe('a10');
  });

  test('markAcked updates the latest snapshot for that alert; cross-tenant + unknown alert no-op', () => {
    const ledger = new InMemoryRoutingLedger();
    ledger.record(makeRec({ alert_id: 'a1', tenant_id: 'BIL', acked_at: null }));
    ledger.record(makeRec({ alert_id: 'a2', tenant_id: 'BIL', acked_at: null }));
    const ts = new Date(NOW.getTime() + 1 * HOUR_MS).toISOString();
    ledger.markAcked('BIL', 'a1', ts);
    const list = ledger.list('BIL', 10);
    expect(list.find((r) => r.alert_id === 'a1')!.acked_at).toBe(ts);
    expect(list.find((r) => r.alert_id === 'a2')!.acked_at).toBeNull();
    // Cross-tenant no-op.
    ledger.markAcked('OTHER', 'a1', ts);
    // Unknown alert no-op.
    ledger.markAcked('BIL', 'does-not-exist', ts);
    // Final shape unchanged.
    expect(list.find((r) => r.alert_id === 'a1')!.acked_at).toBe(ts);
  });

  test('tenants are isolated; one tenant cannot see another tenant records', () => {
    const ledger = new InMemoryRoutingLedger();
    ledger.record(makeRec({ alert_id: 'bil-1', tenant_id: 'BIL' }));
    ledger.record(makeRec({ alert_id: 'demo-1', tenant_id: 'BANK_DEMO' }));
    expect(ledger.list('BIL', 10).map((r) => r.alert_id)).toEqual(['bil-1']);
    expect(ledger.list('BANK_DEMO', 10).map((r) => r.alert_id)).toEqual(['demo-1']);
    expect(ledger.list('OTHER', 10)).toEqual([]);
  });

  test('default + max window constants are exposed and sane', () => {
    expect(ROUTING_ANALYTICS_DEFAULT_WINDOW).toBe(50);
    expect(ROUTING_ANALYTICS_MAX_WINDOW).toBe(200);
  });
});

// ─── GET /v1/alerts/routing/analytics ─────────────────────────────────

describe('M8.6 — GET /v1/alerts/routing/analytics', () => {
  test('empty ledger → 200 with zero-shape analytics + default window', async () => {
    const { app } = makeAnalyticsApp('admin');
    const r = await request(app).get('/v1/alerts/routing/analytics').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.window).toBe(ROUTING_ANALYTICS_DEFAULT_WINDOW);
    expect(r.body.body.analytics.sample_size).toBe(0);
    expect(r.body.body.analytics.ack_rate).toBeNull();
    expect(r.body.body.analytics.by_class).toEqual({ red: 0, orange: 0, yellow: 0, green: 0 });
  });

  test('records pushed to the ledger surface in the analytics roll-up', async () => {
    const ledger = new InMemoryRoutingLedger();
    ledger.record(
      makeRec({
        alert_id: 'a1',
        tenant_id: 'BIL',
        class: 'red',
        channels: ['email', 'sms'],
        sla_hours: 4,
        escalate_after_hours: 1,
        acked_at: new Date(NOW.getTime() + 1 * HOUR_MS).toISOString(),
      }),
    );
    const { app } = makeAnalyticsApp('admin', ledger);
    const r = await request(app).get('/v1/alerts/routing/analytics').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.analytics.sample_size).toBe(1);
    expect(r.body.body.analytics.by_class.red).toBe(1);
    expect(r.body.body.analytics.by_channel.email).toBe(1);
    expect(r.body.body.analytics.by_channel.sms).toBe(1);
    expect(r.body.body.analytics.ack_rate).toBe(1);
  });

  test('?window=0 → 400 invalid_input', async () => {
    const { app } = makeAnalyticsApp('admin');
    const r = await request(app)
      .get('/v1/alerts/routing/analytics?window=0')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test(`?window > ${ROUTING_ANALYTICS_MAX_WINDOW} → 400`, async () => {
    const { app } = makeAnalyticsApp('admin');
    const r = await request(app)
      .get(`/v1/alerts/routing/analytics?window=${ROUTING_ANALYTICS_MAX_WINDOW + 1}`)
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAnalyticsApp('case_owner');
    const r = await request(app).get('/v1/alerts/routing/analytics').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant isolation: BANK_DEMO does not see BIL records', async () => {
    const ledger = new InMemoryRoutingLedger();
    ledger.record(makeRec({ alert_id: 'a1', tenant_id: 'BIL' }));
    const { app } = makeAnalyticsApp('admin', ledger);
    const r = await request(app)
      .get('/v1/alerts/routing/analytics')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.analytics.sample_size).toBe(0);
  });
});
