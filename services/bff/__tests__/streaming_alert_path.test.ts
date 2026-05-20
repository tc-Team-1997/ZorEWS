// services/bff/__tests__/streaming_alert_path.test.ts
//
// T2.12.1 — Streaming indicator-event ledger + latency telemetry.

import request from 'supertest';
import {
  STREAMING_SLO_BUDGET_MS,
  StreamingLedgerError,
  InMemoryStreamingLedger,
  processStreamingEvent,
  summarizeStreamingLatency,
  _resetDefaultStreamingLedger,
  type StreamingProcessingRecord,
} from '../src/streaming_alert_path';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const TENANT = 'BIL';
const HEADERS = { 'X-Tenant-ID': TENANT, 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };

function isoDelta(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

function makeStreamingApp(role: string = 'admin') {
  _resetDefaultStreamingLedger();
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Pure processing ─────────────────────────────────────────────────

describe('processStreamingEvent', () => {
  test('happy path computes latencies vs observed_at', () => {
    const rec = processStreamingEvent(
      {
        indicator_id: 'FIN-001',
        customer_id: 'CUST-1',
        value: 0.42,
        observed_at: isoDelta(15_000), // 15s old
      },
      { tenant_id: TENANT, now: NOW, seq: 1 },
    );
    expect(rec.tenant_id).toBe(TENANT);
    expect(rec.indicator_id).toBe('FIN-001');
    expect(rec.customer_id).toBe('CUST-1');
    expect(rec.total_latency_ms).toBe(15_000);
    expect(rec.ingest_latency_ms).toBe(15_000);
    expect(rec.processing_latency_ms).toBe(0);
    expect(rec.event_id).toMatch(/^sie-BIL-/);
    expect(rec.processed_at).toBe(NOW.toISOString());
  });

  test('explicit received_at splits ingest vs processing', () => {
    const rec = processStreamingEvent(
      {
        indicator_id: 'FIN-001',
        customer_id: 'CUST-1',
        value: 1,
        observed_at: isoDelta(20_000),
        received_at: isoDelta(5_000),
      },
      { tenant_id: TENANT, now: NOW, seq: 1 },
    );
    expect(rec.ingest_latency_ms).toBe(15_000); // 20s - 5s
    expect(rec.processing_latency_ms).toBe(5_000); // 5s - 0s
    expect(rec.total_latency_ms).toBe(20_000);
  });

  test('caller-supplied event_id preserved', () => {
    const rec = processStreamingEvent(
      {
        event_id: 'partner-evt-9999',
        indicator_id: 'FIN-001',
        customer_id: 'C',
        value: 0,
        observed_at: isoDelta(1_000),
      },
      { tenant_id: TENANT, now: NOW, seq: 7 },
    );
    expect(rec.event_id).toBe('partner-evt-9999');
  });

  test('fired_alert_ids + fired_rule_ids round-trip', () => {
    const rec = processStreamingEvent(
      {
        indicator_id: 'FIN-001',
        customer_id: 'C',
        value: 0,
        observed_at: isoDelta(100),
        fired_alert_ids: ['a-1', 'a-2'],
        fired_rule_ids: ['RULE-001'],
      },
      { tenant_id: TENANT, now: NOW, seq: 1 },
    );
    expect(rec.fired_alert_ids).toEqual(['a-1', 'a-2']);
    expect(rec.fired_rule_ids).toEqual(['RULE-001']);
  });

  test('missing required fields throw invalid_input', () => {
    expect(() =>
      processStreamingEvent({} as never, { tenant_id: TENANT, now: NOW, seq: 1 }),
    ).toThrow(StreamingLedgerError);
    expect(() =>
      processStreamingEvent(
        { indicator_id: 'FIN-001' } as never,
        { tenant_id: TENANT, now: NOW, seq: 1 },
      ),
    ).toThrow(/customer_id/);
  });

  test('non-finite value rejected', () => {
    expect(() =>
      processStreamingEvent(
        { indicator_id: 'X', customer_id: 'C', value: Number.NaN, observed_at: isoDelta(0) },
        { tenant_id: TENANT, now: NOW, seq: 1 },
      ),
    ).toThrow(/invalid_value|finite/);
  });

  test('malformed observed_at rejected', () => {
    expect(() =>
      processStreamingEvent(
        { indicator_id: 'X', customer_id: 'C', value: 0, observed_at: 'not-a-date' },
        { tenant_id: TENANT, now: NOW, seq: 1 },
      ),
    ).toThrow(/invalid_observed_at|ISO/);
  });

  test('future observed_at rejected as observed_in_future', () => {
    expect(() =>
      processStreamingEvent(
        { indicator_id: 'X', customer_id: 'C', value: 0, observed_at: isoDelta(-5_000) },
        { tenant_id: TENANT, now: NOW, seq: 1 },
      ),
    ).toThrow(/observed_in_future|future/);
  });

  test('missing tenant_id rejected', () => {
    expect(() =>
      processStreamingEvent(
        { indicator_id: 'X', customer_id: 'C', value: 0, observed_at: isoDelta(0) },
        { tenant_id: '', now: NOW, seq: 1 },
      ),
    ).toThrow(/tenant_id/);
  });
});

// ─── Analytics ───────────────────────────────────────────────────────

function fakeRecord(
  indicator_id: string,
  total_latency_ms: number,
  seq: number,
): StreamingProcessingRecord {
  return {
    event_id: `sie-${TENANT}-${NOW_MS}-${seq}`,
    tenant_id: TENANT,
    indicator_id,
    customer_id: `C-${seq}`,
    observed_at: isoDelta(total_latency_ms),
    received_at: isoDelta(0),
    processed_at: NOW.toISOString(),
    ingest_latency_ms: total_latency_ms,
    processing_latency_ms: 0,
    total_latency_ms,
    fired_alert_ids: [],
    fired_rule_ids: [],
  };
}

describe('summarizeStreamingLatency', () => {
  test('empty input → zero envelope, p95 target vacuously met', () => {
    const s = summarizeStreamingLatency(TENANT, [], NOW);
    expect(s.sample_size).toBe(0);
    expect(s.p95_total_ms).toBeNull();
    expect(s.target_p95_60s_met).toBe(true);
    expect(s.by_indicator).toHaveLength(0);
    expect(s.most_recent_at).toBeNull();
  });

  test('all-fast events → p95 < 60s, target_p95_60s_met=true', () => {
    const records = Array.from({ length: 100 }, (_, i) =>
      fakeRecord('FIN-001', 5_000 + i * 100, i + 1),
    );
    const s = summarizeStreamingLatency(TENANT, records, NOW);
    expect(s.sample_size).toBe(100);
    expect(s.p95_total_ms).toBeLessThan(STREAMING_SLO_BUDGET_MS);
    expect(s.target_p95_60s_met).toBe(true);
    expect(s.count_under_60s).toBe(100);
    expect(s.percentage_under_60s).toBe(1);
  });

  test('slow tail breaches the SLO budget', () => {
    const fast = Array.from({ length: 80 }, (_, i) => fakeRecord('FIN-001', 1_000, i + 1));
    const slow = Array.from({ length: 20 }, (_, i) => fakeRecord('FIN-001', 90_000, i + 81));
    const s = summarizeStreamingLatency(TENANT, [...fast, ...slow], NOW);
    expect(s.p95_total_ms).toBeGreaterThanOrEqual(STREAMING_SLO_BUDGET_MS);
    expect(s.target_p95_60s_met).toBe(false);
    expect(s.count_over_60s).toBe(20);
    expect(s.count_under_60s).toBe(80);
    expect(s.percentage_under_60s).toBeCloseTo(0.8, 2);
  });

  test('by_indicator rollup sorts count desc + indicator_id asc tie-break', () => {
    const records = [
      ...Array.from({ length: 5 }, (_, i) => fakeRecord('FIN-001', 1_000, i + 1)),
      ...Array.from({ length: 3 }, (_, i) => fakeRecord('FIN-002', 2_000, i + 100)),
      ...Array.from({ length: 3 }, (_, i) => fakeRecord('BEH-001', 3_000, i + 200)),
    ];
    const s = summarizeStreamingLatency(TENANT, records, NOW);
    expect(s.by_indicator.map((r) => r.indicator_id)).toEqual(['FIN-001', 'BEH-001', 'FIN-002']);
    expect(s.total_indicators).toBe(3);
  });

  test('per-indicator percentage_under_60s independent', () => {
    const records = [
      ...Array.from({ length: 10 }, (_, i) => fakeRecord('FIN-001', 500, i + 1)),
      ...Array.from({ length: 10 }, (_, i) => fakeRecord('SLOW-001', 90_000, i + 100)),
    ];
    const s = summarizeStreamingLatency(TENANT, records, NOW);
    const fin = s.by_indicator.find((r) => r.indicator_id === 'FIN-001')!;
    const slow = s.by_indicator.find((r) => r.indicator_id === 'SLOW-001')!;
    expect(fin.percentage_under_60s).toBe(1);
    expect(slow.percentage_under_60s).toBe(0);
  });

  test('count_under_60s + count_over_60s = sample_size partition', () => {
    const records = Array.from({ length: 50 }, (_, i) =>
      fakeRecord('X', i % 2 === 0 ? 1_000 : 65_000, i + 1),
    );
    const s = summarizeStreamingLatency(TENANT, records, NOW);
    expect(s.count_under_60s + s.count_over_60s).toBe(s.sample_size);
  });

  test('mean / median / p95 / max / min consistent ordering', () => {
    const records = Array.from({ length: 20 }, (_, i) => fakeRecord('X', i * 1_000, i + 1));
    const s = summarizeStreamingLatency(TENANT, records, NOW);
    expect(s.min_total_ms).toBeLessThanOrEqual(s.median_total_ms!);
    expect(s.median_total_ms).toBeLessThanOrEqual(s.p95_total_ms!);
    expect(s.p95_total_ms).toBeLessThanOrEqual(s.max_total_ms!);
    expect(s.min_total_ms).toBeLessThanOrEqual(s.mean_total_ms!);
    expect(s.mean_total_ms).toBeLessThanOrEqual(s.max_total_ms!);
  });
});

// ─── Ledger ──────────────────────────────────────────────────────────

describe('InMemoryStreamingLedger', () => {
  test('record + list newest-first', () => {
    const l = new InMemoryStreamingLedger();
    const a = fakeRecord('X', 1_000, 1);
    const b = fakeRecord('X', 2_000, 2);
    l.record(a);
    l.record(b);
    const out = l.list(TENANT);
    expect(out[0].event_id).toBe(b.event_id);
    expect(out[1].event_id).toBe(a.event_id);
  });

  test('limit respected', () => {
    const l = new InMemoryStreamingLedger();
    for (let i = 0; i < 10; i++) l.record(fakeRecord('X', 1_000, i + 1));
    expect(l.list(TENANT, 3)).toHaveLength(3);
  });

  test('cap evicts oldest', () => {
    const l = new InMemoryStreamingLedger();
    for (let i = 0; i < 1_005; i++) l.record(fakeRecord('X', 1_000, i + 1));
    const out = l.list(TENANT);
    expect(out).toHaveLength(1_000);
    // Oldest 5 should be evicted.
    const ids = new Set(out.map((r) => r.event_id));
    expect(ids.has(`sie-${TENANT}-${NOW_MS}-1`)).toBe(false);
    expect(ids.has(`sie-${TENANT}-${NOW_MS}-1005`)).toBe(true);
  });

  test('tenant scoping — BANK_DEMO does not see BIL records', () => {
    const l = new InMemoryStreamingLedger();
    l.record(fakeRecord('X', 1_000, 1));
    expect(l.list('BANK_DEMO')).toEqual([]);
    expect(l.list(TENANT)).toHaveLength(1);
  });

  test('clear() empties one tenant', () => {
    const l = new InMemoryStreamingLedger();
    l.record(fakeRecord('X', 1_000, 1));
    l.clear(TENANT);
    expect(l.list(TENANT)).toEqual([]);
  });
});

// ─── Routes ──────────────────────────────────────────────────────────

describe('POST /v1/streaming/indicator-events', () => {
  test('admin happy path records 1 event with latency', async () => {
    const { app } = makeStreamingApp('admin');
    const r = await request(app)
      .post('/v1/streaming/indicator-events')
      .set(HEADERS)
      .send({
        indicator_id: 'FIN-001',
        customer_id: 'C-1',
        value: 0.7,
        observed_at: isoDelta(8_000),
      });
    expect(r.status).toBe(201);
    expect(r.body.body.recorded_count).toBe(1);
    expect(r.body.body.events[0].total_latency_ms).toBe(8_000);
    expect(r.body.body.events[0].tenant_id).toBe(TENANT);
  });

  test('bulk envelope `{events: [...]}` recorded', async () => {
    const { app } = makeStreamingApp('admin');
    const events = [
      { indicator_id: 'FIN-001', customer_id: 'C-1', value: 0.1, observed_at: isoDelta(1_000) },
      { indicator_id: 'BEH-001', customer_id: 'C-2', value: 0.2, observed_at: isoDelta(2_000) },
      { indicator_id: 'TXN-001', customer_id: 'C-3', value: 0.3, observed_at: isoDelta(3_000) },
    ];
    const r = await request(app)
      .post('/v1/streaming/indicator-events')
      .set(HEADERS)
      .send({ events });
    expect(r.status).toBe(201);
    expect(r.body.body.recorded_count).toBe(3);
  });

  test('analyst+ accepted', async () => {
    const { app } = makeStreamingApp('risk_analyst');
    const r = await request(app)
      .post('/v1/streaming/indicator-events')
      .set(HEADERS)
      .send({ indicator_id: 'FIN-001', customer_id: 'C', value: 0, observed_at: isoDelta(0) });
    expect(r.status).toBe(201);
  });

  test('unknown role 403', async () => {
    const { app } = makeStreamingApp('viewer'); // not in matrix
    const r = await request(app)
      .post('/v1/streaming/indicator-events')
      .set(HEADERS)
      .send({ indicator_id: 'X', customer_id: 'C', value: 0, observed_at: isoDelta(0) });
    expect(r.status).toBe(403);
  });

  test('empty events array → 400', async () => {
    const { app } = makeStreamingApp('admin');
    const r = await request(app)
      .post('/v1/streaming/indicator-events')
      .set(HEADERS)
      .send({ events: [] });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('EWS_400_invalid_input');
  });

  test('malformed observed_at → 400 with code-routed error', async () => {
    const { app } = makeStreamingApp('admin');
    const r = await request(app)
      .post('/v1/streaming/indicator-events')
      .set(HEADERS)
      .send({ indicator_id: 'X', customer_id: 'C', value: 0, observed_at: 'NOT-A-DATE' });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('EWS_400_invalid_observed_at');
  });

  test('future observed_at → 400 observed_in_future', async () => {
    const { app } = makeStreamingApp('admin');
    const r = await request(app)
      .post('/v1/streaming/indicator-events')
      .set(HEADERS)
      .send({ indicator_id: 'X', customer_id: 'C', value: 0, observed_at: isoDelta(-5_000) });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('EWS_400_observed_in_future');
  });
});

describe('GET /v1/streaming/latency', () => {
  test('admin gets envelope with p95 + target_p95_60s_met after fast events', async () => {
    const { app } = makeStreamingApp('admin');
    // Seed 10 fast events.
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post('/v1/streaming/indicator-events')
        .set(HEADERS)
        .send({
          indicator_id: 'FIN-001',
          customer_id: `C-${i}`,
          value: 0,
          observed_at: isoDelta(2_000),
        });
    }
    const r = await request(app).get('/v1/streaming/latency').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.sample_size).toBe(10);
    expect(r.body.body.p95_total_ms).toBeLessThan(STREAMING_SLO_BUDGET_MS);
    expect(r.body.body.target_p95_60s_met).toBe(true);
    expect(r.body.body.by_indicator).toHaveLength(1);
    expect(r.body.body.by_indicator[0].indicator_id).toBe('FIN-001');
  });

  test('mixed fast + slow events → p95 reflects tail', async () => {
    const { app } = makeStreamingApp('admin');
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post('/v1/streaming/indicator-events')
        .set(HEADERS)
        .send({
          indicator_id: 'SLOW-001',
          customer_id: `C-${i}`,
          value: 0,
          observed_at: isoDelta(90_000),
        });
    }
    const r = await request(app).get('/v1/streaming/latency').set(HEADERS);
    expect(r.body.body.target_p95_60s_met).toBe(false);
    expect(r.body.body.count_over_60s).toBe(10);
  });

  test('field_officer 403', async () => {
    const { app } = makeStreamingApp('field_officer');
    const r = await request(app).get('/v1/streaming/latency').set(HEADERS);
    expect(r.status).toBe(403);
  });

  test('tenant scoping — BIL events invisible to BANK_DEMO', async () => {
    const { app } = makeStreamingApp('admin');
    await request(app)
      .post('/v1/streaming/indicator-events')
      .set(HEADERS)
      .send({ indicator_id: 'X', customer_id: 'C', value: 0, observed_at: isoDelta(1_000) });
    const r = await request(app)
      .get('/v1/streaming/latency')
      .set({ ...HEADERS, 'X-Tenant-ID': 'BANK_DEMO' });
    expect(r.status).toBe(200);
    expect(r.body.body.sample_size).toBe(0);
  });
});

describe('GET /v1/streaming/events', () => {
  test('returns newest-first records with limit', async () => {
    const { app } = makeStreamingApp('admin');
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/v1/streaming/indicator-events')
        .set(HEADERS)
        .send({
          indicator_id: 'FIN-001',
          customer_id: `C-${i}`,
          value: 0,
          observed_at: isoDelta(i * 1_000),
        });
    }
    const r = await request(app).get('/v1/streaming/events?limit=3').set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(3);
    expect(r.body.body.events).toHaveLength(3);
  });

  test('field_officer 403', async () => {
    const { app } = makeStreamingApp('field_officer');
    const r = await request(app).get('/v1/streaming/events').set(HEADERS);
    expect(r.status).toBe(403);
  });
});
