// services/bff/__tests__/alert_ack_time_histogram.test.ts
//
// T6 M8.12 — Alert ack-time histogram.

import request from 'supertest';
import {
  summarizeAlertAckTime,
  ACK_TIME_BUCKETS,
  type AckTimeBucketKey,
} from '../src/alert_ack_time_histogram';
import {
  InMemoryRoutingLedger,
  type RoutedAlertRecord,
} from '../src/alert_routing_analytics';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const MS_PER_HOUR = 60 * 60 * 1000;

function hoursBack(h: number): string {
  return new Date(NOW.getTime() - h * MS_PER_HOUR).toISOString();
}

function record(overrides: Partial<RoutedAlertRecord> = {}): RoutedAlertRecord {
  return {
    alert_id: 'a-1',
    tenant_id: 'BIL',
    created_at: hoursBack(1),
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

function makeHistApp(role: string = 'admin') {
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

function bucketCount(buckets: { bucket: string; count: number }[], key: string): number {
  return buckets.find((b) => b.bucket === key)!.count;
}

// ─── summarizeAlertAckTime — pure ────────────────────────────────────

describe('M8.12 — empty input', () => {
  test('zero records → all buckets emitted at 0', () => {
    const s = summarizeAlertAckTime('BIL', [], 50, NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.window).toBe(50);
    expect(s.total_records).toBe(0);
    expect(s.total_acked).toBe(0);
    expect(s.total_still_open).toBe(0);
    expect(s.total_monitor_only).toBe(0);
    expect(s.mean_ack_ms).toBeNull();
    expect(s.median_ack_ms).toBeNull();
    expect(s.p95_ack_ms).toBeNull();
    expect(s.peak_bucket).toBeNull();
    expect(s.buckets.length).toBe(6);
    for (const b of s.buckets) expect(b.count).toBe(0);
  });
});

describe('M8.12 — canonical bucket order', () => {
  test('buckets[] in canonical order', () => {
    const s = summarizeAlertAckTime('BIL', [], 50, NOW);
    expect(s.buckets.map((b) => b.bucket)).toEqual([...ACK_TIME_BUCKETS]);
  });
});

describe('M8.12 — bucket placement', () => {
  test('under_1h: created 30min ago, acked now → under_1h', () => {
    const rec = record({
      alert_id: 'fast',
      created_at: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
      acked_at: NOW.toISOString(),
    });
    const s = summarizeAlertAckTime('BIL', [rec], 50, NOW);
    expect(bucketCount(s.buckets, 'under_1h')).toBe(1);
    expect(bucketCount(s.buckets, '1_to_4h')).toBe(0);
  });

  test('1_to_4h: 2h ack-time → 1_to_4h', () => {
    const rec = record({
      created_at: hoursBack(3),
      acked_at: hoursBack(1), // 2h ack-time
    });
    const s = summarizeAlertAckTime('BIL', [rec], 50, NOW);
    expect(bucketCount(s.buckets, '1_to_4h')).toBe(1);
  });

  test('4_to_24h: 12h ack-time → 4_to_24h', () => {
    const rec = record({
      created_at: hoursBack(15),
      acked_at: hoursBack(3), // 12h ack-time
    });
    const s = summarizeAlertAckTime('BIL', [rec], 50, NOW);
    expect(bucketCount(s.buckets, '4_to_24h')).toBe(1);
  });

  test('24h_plus: 36h ack-time → 24h_plus', () => {
    const rec = record({
      created_at: hoursBack(48),
      acked_at: hoursBack(12), // 36h ack-time
    });
    const s = summarizeAlertAckTime('BIL', [rec], 50, NOW);
    expect(bucketCount(s.buckets, '24h_plus')).toBe(1);
  });

  test('still_open: not yet acked → still_open', () => {
    const rec = record({ created_at: hoursBack(2), acked_at: null });
    const s = summarizeAlertAckTime('BIL', [rec], 50, NOW);
    expect(bucketCount(s.buckets, 'still_open')).toBe(1);
  });

  test('monitor_only: green-class alert → monitor_only regardless of ack', () => {
    const rec = record({
      class: 'green',
      monitor_only: true,
      sla_hours: null,
      escalate_after_hours: null,
      created_at: hoursBack(50),
      acked_at: null,
    });
    const s = summarizeAlertAckTime('BIL', [rec], 50, NOW);
    expect(bucketCount(s.buckets, 'monitor_only')).toBe(1);
    expect(bucketCount(s.buckets, 'still_open')).toBe(0);
  });
});

describe('M8.12 — boundary semantics', () => {
  test('exactly 1h ack-time → falls into 1_to_4h (strict-< upper)', () => {
    const rec = record({
      created_at: hoursBack(1),
      acked_at: NOW.toISOString(), // exactly 1h
    });
    const s = summarizeAlertAckTime('BIL', [rec], 50, NOW);
    expect(bucketCount(s.buckets, 'under_1h')).toBe(0);
    expect(bucketCount(s.buckets, '1_to_4h')).toBe(1);
  });

  test('exactly 4h ack-time → falls into 4_to_24h', () => {
    const rec = record({
      created_at: hoursBack(4),
      acked_at: NOW.toISOString(),
    });
    const s = summarizeAlertAckTime('BIL', [rec], 50, NOW);
    expect(bucketCount(s.buckets, '1_to_4h')).toBe(0);
    expect(bucketCount(s.buckets, '4_to_24h')).toBe(1);
  });

  test('exactly 24h ack-time → falls into 24h_plus', () => {
    const rec = record({
      created_at: hoursBack(24),
      acked_at: NOW.toISOString(),
    });
    const s = summarizeAlertAckTime('BIL', [rec], 50, NOW);
    expect(bucketCount(s.buckets, '4_to_24h')).toBe(0);
    expect(bucketCount(s.buckets, '24h_plus')).toBe(1);
  });
});

describe('M8.12 — totals', () => {
  test('total_acked + total_still_open + total_monitor_only = total_records', () => {
    const recs: RoutedAlertRecord[] = [
      record({ alert_id: 'a1', created_at: hoursBack(2), acked_at: hoursBack(1) }), // acked
      record({ alert_id: 'a2', created_at: hoursBack(5), acked_at: hoursBack(3) }), // acked
      record({ alert_id: 'a3', created_at: hoursBack(1), acked_at: null }), // open
      record({
        alert_id: 'a4',
        class: 'green',
        monitor_only: true,
        sla_hours: null,
        escalate_after_hours: null,
        created_at: hoursBack(10),
      }), // monitor
    ];
    const s = summarizeAlertAckTime('BIL', recs, 50, NOW);
    expect(s.total_records).toBe(4);
    expect(s.total_acked).toBe(2);
    expect(s.total_still_open).toBe(1);
    expect(s.total_monitor_only).toBe(1);
    expect(s.total_acked + s.total_still_open + s.total_monitor_only).toBe(s.total_records);
  });
});

describe('M8.12 — Σ buckets.count = total_records', () => {
  test('partition invariant across all 6 buckets', () => {
    const recs: RoutedAlertRecord[] = [
      record({ created_at: hoursBack(0.5), acked_at: NOW.toISOString() }), // under_1h
      record({ created_at: hoursBack(2), acked_at: hoursBack(0) }), // 1_to_4h (~2h ack)
      record({ created_at: hoursBack(15), acked_at: hoursBack(3) }), // 4_to_24h (~12h ack)
      record({ created_at: hoursBack(48), acked_at: hoursBack(12) }), // 24h_plus
      record({ created_at: hoursBack(1), acked_at: null }), // still_open
      record({
        class: 'green',
        monitor_only: true,
        sla_hours: null,
        escalate_after_hours: null,
        created_at: hoursBack(2),
      }), // monitor_only
    ];
    const s = summarizeAlertAckTime('BIL', recs, 50, NOW);
    const sum = s.buckets.reduce((a, b) => a + b.count, 0);
    expect(sum).toBe(s.total_records);
    expect(s.total_records).toBe(6);
    for (const key of ACK_TIME_BUCKETS) {
      expect(bucketCount(s.buckets, key)).toBe(1);
    }
  });
});

describe('M8.12 — mean / median / p95 over acked only', () => {
  test('5 acks at 1h/2h/3h/4h/5h → mean=3h, median=3h', () => {
    const recs: RoutedAlertRecord[] = [
      record({ created_at: hoursBack(1), acked_at: NOW.toISOString() }), // 1h
      record({ created_at: hoursBack(2), acked_at: NOW.toISOString() }), // 2h
      record({ created_at: hoursBack(3), acked_at: NOW.toISOString() }), // 3h
      record({ created_at: hoursBack(4), acked_at: NOW.toISOString() }), // 4h
      record({ created_at: hoursBack(5), acked_at: NOW.toISOString() }), // 5h
    ];
    const s = summarizeAlertAckTime('BIL', recs, 50, NOW);
    expect(s.mean_ack_ms).toBe(3 * MS_PER_HOUR);
    expect(s.median_ack_ms).toBe(3 * MS_PER_HOUR);
  });

  test('still_open + monitor_only excluded from mean', () => {
    const recs: RoutedAlertRecord[] = [
      record({ created_at: hoursBack(2), acked_at: hoursBack(0) }), // 2h ack — counted
      record({ created_at: hoursBack(1), acked_at: null }), // still_open — excluded
      record({
        class: 'green',
        monitor_only: true,
        sla_hours: null,
        escalate_after_hours: null,
        created_at: hoursBack(50),
      }), // monitor — excluded
    ];
    const s = summarizeAlertAckTime('BIL', recs, 50, NOW);
    expect(s.mean_ack_ms).toBe(2 * MS_PER_HOUR);
  });

  test('all null when no acked rows', () => {
    const recs: RoutedAlertRecord[] = [
      record({ created_at: hoursBack(1), acked_at: null }),
    ];
    const s = summarizeAlertAckTime('BIL', recs, 50, NOW);
    expect(s.mean_ack_ms).toBeNull();
    expect(s.median_ack_ms).toBeNull();
    expect(s.p95_ack_ms).toBeNull();
  });
});

describe('M8.12 — peak_bucket', () => {
  test('points at highest-count bucket', () => {
    const recs: RoutedAlertRecord[] = [
      record({ created_at: hoursBack(0.5), acked_at: NOW.toISOString() }), // under_1h
      record({ created_at: hoursBack(0.5), acked_at: NOW.toISOString() }), // under_1h
      record({ created_at: hoursBack(0.5), acked_at: NOW.toISOString() }), // under_1h
      record({ created_at: hoursBack(2), acked_at: hoursBack(0) }), // 1_to_4h
    ];
    const s = summarizeAlertAckTime('BIL', recs, 50, NOW);
    expect(s.peak_bucket).toBe('under_1h');
  });

  test('canonical tie-break: under_1h wins over 1_to_4h at same count', () => {
    const recs: RoutedAlertRecord[] = [
      record({ created_at: hoursBack(0.5), acked_at: NOW.toISOString() }), // under_1h
      record({ created_at: hoursBack(2), acked_at: hoursBack(0) }), // 1_to_4h
    ];
    const s = summarizeAlertAckTime('BIL', recs, 50, NOW);
    expect(s.peak_bucket).toBe('under_1h');
  });

  test('null when no records', () => {
    const s = summarizeAlertAckTime('BIL', [], 50, NOW);
    expect(s.peak_bucket).toBeNull();
  });
});

describe('M8.12 — samples', () => {
  test('acked bucket samples sorted fastest-first, capped at 3', () => {
    const recs: RoutedAlertRecord[] = [
      record({ alert_id: 'fast', created_at: hoursBack(0.2), acked_at: NOW.toISOString() }),
      record({ alert_id: 'mid', created_at: hoursBack(0.5), acked_at: NOW.toISOString() }),
      record({ alert_id: 'slow', created_at: hoursBack(0.9), acked_at: NOW.toISOString() }),
      record({ alert_id: 'extra', created_at: hoursBack(0.95), acked_at: NOW.toISOString() }),
    ];
    const s = summarizeAlertAckTime('BIL', recs, 50, NOW);
    const bucket = s.buckets.find((b) => b.bucket === 'under_1h')!;
    expect(bucket.count).toBe(4);
    expect(bucket.samples.length).toBe(3);
    expect(bucket.samples[0]!.alert_id).toBe('fast');
    expect(bucket.samples[2]!.alert_id).toBe('slow');
  });

  test('still_open samples sorted oldest-waiting first', () => {
    const recs: RoutedAlertRecord[] = [
      record({ alert_id: 'newer', created_at: hoursBack(1), acked_at: null }),
      record({ alert_id: 'older', created_at: hoursBack(10), acked_at: null }),
      record({ alert_id: 'oldest', created_at: hoursBack(20), acked_at: null }),
    ];
    const s = summarizeAlertAckTime('BIL', recs, 50, NOW);
    const bucket = s.buckets.find((b) => b.bucket === 'still_open')!;
    expect(bucket.samples[0]!.alert_id).toBe('oldest');
    expect(bucket.samples[2]!.alert_id).toBe('newer');
  });
});

describe('M8.12 — bucket min/max metadata', () => {
  test('acked buckets carry numeric bounds; non-acked buckets get null max_ms', () => {
    const s = summarizeAlertAckTime('BIL', [], 50, NOW);
    const under1h = s.buckets.find((b) => b.bucket === 'under_1h')!;
    expect(under1h.min_ms).toBe(0);
    expect(under1h.max_ms).toBe(MS_PER_HOUR);
    const stillOpen = s.buckets.find((b) => b.bucket === 'still_open')!;
    expect(stillOpen.max_ms).toBeNull();
    const monitorOnly = s.buckets.find((b) => b.bucket === 'monitor_only')!;
    expect(monitorOnly.max_ms).toBeNull();
  });
});

// ─── GET /v1/alerts/ack-time/histogram ───────────────────────────────

describe('M8.12 — GET /v1/alerts/ack-time/histogram', () => {
  test('admin → 200 with empty rollup on fresh tenant', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app).get('/v1/alerts/ack-time/histogram').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_records).toBe(0);
    expect(r.body.body.buckets.length).toBe(6);
    expect(r.body.body.mean_ack_ms).toBeNull();
    expect(r.body.body.peak_bucket).toBeNull();
  });

  test('populated ledger reflects in buckets', async () => {
    const { app, ledger } = makeHistApp('admin');
    ledger.record(record({ alert_id: 'fast', created_at: hoursBack(0.5), acked_at: NOW.toISOString() }));
    ledger.record(record({ alert_id: 'mid', created_at: hoursBack(3), acked_at: hoursBack(1) }));
    ledger.record(record({ alert_id: 'open', created_at: hoursBack(1), acked_at: null }));
    const r = await request(app).get('/v1/alerts/ack-time/histogram').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_records).toBe(3);
    expect(r.body.body.total_acked).toBe(2);
    expect(r.body.body.total_still_open).toBe(1);
    expect(r.body.body.mean_ack_ms).toBeGreaterThan(0);
  });

  test('?window=invalid → 400 EWS_400_invalid_input', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app).get('/v1/alerts/ack-time/histogram?window=0').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?window narrows sample', async () => {
    const { app, ledger } = makeHistApp('admin');
    ledger.record(record({ alert_id: 'old', created_at: hoursBack(0.5), acked_at: NOW.toISOString() }));
    ledger.record(record({ alert_id: 'new', created_at: hoursBack(0.5), acked_at: NOW.toISOString() }));
    const r = await request(app).get('/v1/alerts/ack-time/histogram?window=1').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_records).toBe(1);
    expect(r.body.body.window).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeHistApp('case_owner');
    const r = await request(app).get('/v1/alerts/ack-time/histogram').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL ledger invisible to BANK_DEMO', async () => {
    const { app, ledger } = makeHistApp('admin');
    ledger.record(record({ alert_id: 'bil-only', created_at: hoursBack(0.5), acked_at: NOW.toISOString() }));
    const bank = await request(app)
      .get('/v1/alerts/ack-time/histogram')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_records).toBe(0);
  });

  test('M8.11 /v1/alerts/sla-breaches/detail still works (sibling regression)', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app).get('/v1/alerts/sla-breaches/detail').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M8.6 /v1/alerts/routing/analytics still works (sibling regression)', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app).get('/v1/alerts/routing/analytics').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});

// ─── ACK_TIME_BUCKETS invariant ──────────────────────────────────────

describe('M8.12 — ACK_TIME_BUCKETS', () => {
  test('exactly 6 buckets', () => {
    expect(ACK_TIME_BUCKETS.length).toBe(6);
    const expected: AckTimeBucketKey[] = [
      'under_1h', '1_to_4h', '4_to_24h', '24h_plus', 'still_open', 'monitor_only',
    ];
    expect([...ACK_TIME_BUCKETS]).toEqual(expected);
  });
});
