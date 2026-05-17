// services/bff/__tests__/alert_channel_distribution.test.ts
//
// T6 M8.13 — Alert channel dispatch distribution.

import request from 'supertest';
import {
  summarizeAlertChannelDispatch,
  ALL_NOTIFICATION_CHANNELS,
} from '../src/alert_channel_distribution';
import {
  InMemoryRoutingLedger,
  type RoutedAlertRecord,
} from '../src/alert_routing_analytics';
import type { NotificationChannel } from '../src/alert_routing';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function record(overrides: Partial<RoutedAlertRecord> = {}): RoutedAlertRecord {
  return {
    alert_id: 'a-1',
    tenant_id: 'BIL',
    created_at: new Date(NOW.getTime() - 60_000).toISOString(),
    severity_in: 'HIGH',
    class: 'orange',
    channels: ['email'],
    sla_hours: 24,
    escalate_after_hours: 12,
    monitor_only: false,
    acked_at: null,
    ...overrides,
  };
}

function makeChApp(role: string = 'admin') {
  const ledger = new InMemoryRoutingLedger();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    routingLedger: ledger,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, ledger };
}

function rowFor(s: ReturnType<typeof summarizeAlertChannelDispatch>, ch: NotificationChannel) {
  return s.channels.find((r) => r.channel === ch)!;
}

// ─── summarizeAlertChannelDispatch — pure ────────────────────────────

describe('M8.13 — empty input', () => {
  test('zero records → every channel at 0 + every by_class key emitted', () => {
    const s = summarizeAlertChannelDispatch('BIL', [], 50, NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.total_records).toBe(0);
    expect(s.total_channel_dispatches).toBe(0);
    expect(s.channels.length).toBe(4);
    for (const row of s.channels) {
      expect(row.dispatch_count).toBe(0);
      expect(row.distinct_alerts).toBe(0);
      expect(row.acked_count).toBe(0);
      expect(row.open_count).toBe(0);
      expect(row.monitor_only_count).toBe(0);
      expect(Object.keys(row.by_class).length).toBe(4);
    }
    expect(s.most_used_channel).toBeNull();
    expect(s.unused_channels).toEqual([...ALL_NOTIFICATION_CHANNELS]);
  });
});

describe('M8.13 — canonical channel order', () => {
  test('channels[] in canonical email → sms → in_app → push order', () => {
    const s = summarizeAlertChannelDispatch('BIL', [], 50, NOW);
    expect(s.channels.map((r) => r.channel)).toEqual([...ALL_NOTIFICATION_CHANNELS]);
  });
});

describe('M8.13 — single record single channel', () => {
  test('one email-only record → email row gets dispatch_count=1', () => {
    const rec = record({ alert_id: 'a-1', channels: ['email'] });
    const s = summarizeAlertChannelDispatch('BIL', [rec], 50, NOW);
    expect(rowFor(s, 'email').dispatch_count).toBe(1);
    expect(rowFor(s, 'email').distinct_alerts).toBe(1);
    expect(rowFor(s, 'sms').dispatch_count).toBe(0);
    expect(s.total_channel_dispatches).toBe(1);
  });
});

describe('M8.13 — multi-channel record contributes to each row', () => {
  test('one record with [email,sms,in_app] contributes 1 to each of 3 rows', () => {
    const rec = record({ alert_id: 'a-1', channels: ['email', 'sms', 'in_app'] });
    const s = summarizeAlertChannelDispatch('BIL', [rec], 50, NOW);
    expect(rowFor(s, 'email').dispatch_count).toBe(1);
    expect(rowFor(s, 'sms').dispatch_count).toBe(1);
    expect(rowFor(s, 'in_app').dispatch_count).toBe(1);
    expect(rowFor(s, 'push').dispatch_count).toBe(0);
    expect(s.total_channel_dispatches).toBe(3);
    expect(s.total_records).toBe(1);
  });
});

describe('M8.13 — by_class partition', () => {
  test('Σ by_class per row = row.dispatch_count', () => {
    const recs: RoutedAlertRecord[] = [
      record({ alert_id: 'a1', class: 'red', channels: ['email'] }),
      record({ alert_id: 'a2', class: 'orange', channels: ['email'] }),
      record({ alert_id: 'a3', class: 'yellow', channels: ['email'] }),
    ];
    const s = summarizeAlertChannelDispatch('BIL', recs, 50, NOW);
    const email = rowFor(s, 'email');
    const sum = Object.values(email.by_class).reduce((a, b) => a + b, 0);
    expect(sum).toBe(email.dispatch_count);
  });
});

describe('M8.13 — acked + open + monitor_only partition', () => {
  test('per-row acked + open + monitor (where applicable) accounts for every dispatch', () => {
    const recs: RoutedAlertRecord[] = [
      record({ alert_id: 'a1', channels: ['email'], acked_at: NOW.toISOString() }),
      record({ alert_id: 'a2', channels: ['email'], acked_at: null }),
      record({ alert_id: 'a3', channels: ['email'], monitor_only: true, sla_hours: null, escalate_after_hours: null, acked_at: null }),
    ];
    const s = summarizeAlertChannelDispatch('BIL', recs, 50, NOW);
    const email = rowFor(s, 'email');
    expect(email.acked_count).toBe(1);
    // open includes the monitor_only record since acked_at=null.
    expect(email.open_count).toBe(2);
    expect(email.monitor_only_count).toBe(1);
    // acked + open = dispatch_count (monitor_only is a flag, not a bucket).
    expect(email.acked_count + email.open_count).toBe(email.dispatch_count);
  });
});

describe('M8.13 — distinct_alerts dedup', () => {
  test('same alert_id in 2 records counts as 1 distinct (channel-level)', () => {
    const recs: RoutedAlertRecord[] = [
      record({ alert_id: 'a-dup', channels: ['email'] }),
      record({ alert_id: 'a-dup', channels: ['email'] }),
      record({ alert_id: 'a-uniq', channels: ['email'] }),
    ];
    const s = summarizeAlertChannelDispatch('BIL', recs, 50, NOW);
    const email = rowFor(s, 'email');
    expect(email.dispatch_count).toBe(3);
    expect(email.distinct_alerts).toBe(2);
  });

  test('same alert in 2 channels = 1 distinct in each channel row', () => {
    const rec = record({ alert_id: 'a-multi', channels: ['email', 'sms'] });
    const s = summarizeAlertChannelDispatch('BIL', [rec], 50, NOW);
    expect(rowFor(s, 'email').distinct_alerts).toBe(1);
    expect(rowFor(s, 'sms').distinct_alerts).toBe(1);
  });
});

describe('M8.13 — most_used_channel', () => {
  test('points at highest-dispatch channel', () => {
    const recs: RoutedAlertRecord[] = [
      record({ alert_id: 'a1', channels: ['email'] }),
      record({ alert_id: 'a2', channels: ['email'] }),
      record({ alert_id: 'a3', channels: ['email'] }),
      record({ alert_id: 'a4', channels: ['sms'] }),
    ];
    const s = summarizeAlertChannelDispatch('BIL', recs, 50, NOW);
    expect(s.most_used_channel).toBe('email');
  });

  test('canonical tie-break: email > sms at same count', () => {
    const recs: RoutedAlertRecord[] = [
      record({ alert_id: 'a1', channels: ['sms'] }),
      record({ alert_id: 'a2', channels: ['email'] }),
    ];
    const s = summarizeAlertChannelDispatch('BIL', recs, 50, NOW);
    expect(s.most_used_channel).toBe('email');
  });

  test('null when no records', () => {
    const s = summarizeAlertChannelDispatch('BIL', [], 50, NOW);
    expect(s.most_used_channel).toBeNull();
  });
});

describe('M8.13 — unused_channels', () => {
  test('zero-count channels in canonical order', () => {
    const recs: RoutedAlertRecord[] = [
      record({ channels: ['email'] }),
    ];
    const s = summarizeAlertChannelDispatch('BIL', recs, 50, NOW);
    expect(s.unused_channels).toEqual(['sms', 'in_app', 'push']);
  });
});

describe('M8.13 — total_channel_dispatches', () => {
  test('= sum of channels.length across records', () => {
    const recs: RoutedAlertRecord[] = [
      record({ alert_id: 'a1', channels: ['email', 'sms'] }),
      record({ alert_id: 'a2', channels: ['in_app'] }),
      record({ alert_id: 'a3', channels: ['email', 'push'] }),
    ];
    const s = summarizeAlertChannelDispatch('BIL', recs, 50, NOW);
    expect(s.total_channel_dispatches).toBe(5);
    expect(s.total_records).toBe(3);
  });
});

// ─── GET /v1/alerts/channel-distribution ─────────────────────────────

describe('M8.13 — GET /v1/alerts/channel-distribution', () => {
  test('admin → 200 with empty rollup on fresh tenant', async () => {
    const { app } = makeChApp('admin');
    const r = await request(app).get('/v1/alerts/channel-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_records).toBe(0);
    expect(r.body.body.channels.length).toBe(4);
    expect(r.body.body.most_used_channel).toBeNull();
  });

  test('populated ledger reflects channel rollup', async () => {
    const { app, ledger } = makeChApp('admin');
    ledger.record(record({ alert_id: 'a1', class: 'red', channels: ['email', 'sms'] }));
    ledger.record(record({ alert_id: 'a2', class: 'orange', channels: ['email', 'in_app'] }));
    const r = await request(app).get('/v1/alerts/channel-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_records).toBe(2);
    expect(r.body.body.total_channel_dispatches).toBe(4);
    expect(r.body.body.most_used_channel).toBe('email');
  });

  test('?window=invalid → 400', async () => {
    const { app } = makeChApp('admin');
    const r = await request(app).get('/v1/alerts/channel-distribution?window=0').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?window narrows the sample', async () => {
    const { app, ledger } = makeChApp('admin');
    ledger.record(record({ alert_id: 'old', channels: ['email'] }));
    ledger.record(record({ alert_id: 'new', channels: ['email'] }));
    const r = await request(app).get('/v1/alerts/channel-distribution?window=1').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_records).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeChApp('case_owner');
    const r = await request(app).get('/v1/alerts/channel-distribution').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL ledger invisible to BANK_DEMO', async () => {
    const { app, ledger } = makeChApp('admin');
    ledger.record(record({ alert_id: 'bil-only', channels: ['email'] }));
    const bank = await request(app)
      .get('/v1/alerts/channel-distribution')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_records).toBe(0);
  });

  test('M8.11 /v1/alerts/sla-breaches/detail still works (sibling regression)', async () => {
    const { app } = makeChApp('admin');
    const r = await request(app).get('/v1/alerts/sla-breaches/detail').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M8.12 /v1/alerts/ack-time/histogram still works (sibling regression)', async () => {
    const { app } = makeChApp('admin');
    const r = await request(app).get('/v1/alerts/ack-time/histogram').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
