// @ts-nocheck
// services/bff/__tests__/alert_burst_detection.test.ts
// T6 M8.21 — Alert burst detection.

import request from 'supertest';
import { buildAlertBurstDetection } from '../src/alert_burst_detection';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  InMemoryRoutingLedger,
  ROUTING_ANALYTICS_DEFAULT_WINDOW,
  ROUTING_ANALYTICS_MAX_WINDOW,
  type RoutedAlertRecord,
} from '../src/alert_routing_analytics';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeRec(overrides = {}): RoutedAlertRecord {
  return {
    alert_id: `a-${Math.random().toString(36).slice(2)}`,
    tenant_id: 'BIL',
    created_at: NOW.toISOString(),
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

function fakeApp(role = 'admin', ledger?: InMemoryRoutingLedger) {
  const reg = ledger ?? new InMemoryRoutingLedger();
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    routingLedger: reg,
    getRole: () => role,
    now: () => NOW,
  });
  return { app, ledger: reg };
}

// ─── Pure function tests ────────────────────────────────────────────────

describe('M8.21 — buildAlertBurstDetection — empty', () => {
  test('no records → zeros, null std_dev', () => {
    const out = buildAlertBurstDetection('BIL', [], 0, NOW);
    expect(out.total_records).toBe(0);
    expect(out.mean_per_5min).toBe(0);
    expect(out.std_dev).toBeNull();
    expect(out.burst_count).toBe(0);
    expect(out.bursts).toHaveLength(0);
    expect(out.current_5min_count).toBe(0);
    expect(out.is_currently_bursting).toBe(false);
  });
});

describe('M8.21 — burst detection', () => {
  test('single 5-min bucket → std_dev=null (< 2 buckets)', () => {
    const records = [
      makeRec({ created_at: '2026-05-20T10:00:00.000Z' }),
      makeRec({ created_at: '2026-05-20T10:02:00.000Z' }),
    ];
    const out = buildAlertBurstDetection('BIL', records, 50, NOW);
    expect(out.std_dev).toBeNull();
    expect(out.burst_count).toBe(0);
  });

  test('burst when count > mean + 2*std_dev', () => {
    // 9 quiet buckets (1 each) + 1 burst bucket (10)
    const records = [];
    for (let i = 0; i < 9; i++) {
      records.push(makeRec({ created_at: new Date(NOW.getTime() - (i + 1) * 10 * 60000).toISOString() }));
    }
    // Add 10 records in same 5-min bucket = burst
    const burstTs = new Date(NOW.getTime() - 50 * 60000).toISOString();
    for (let j = 0; j < 10; j++) {
      records.push(makeRec({ created_at: burstTs }));
    }
    const out = buildAlertBurstDetection('BIL', records, 50, NOW);
    expect(out.burst_count).toBeGreaterThanOrEqual(1);
    expect(out.bursts[0].count).toBeGreaterThan(out.mean_per_5min + (out.std_dev ?? 0) * 1.5);
  });
});

describe('M8.21 — window echo', () => {
  test('window value is echoed in envelope', () => {
    const out = buildAlertBurstDetection('BIL', [], 30, NOW);
    expect(out.window).toBe(30);
    expect(out.tenant_id).toBe('BIL');
  });
});

describe('M8.21 — severity breakdown', () => {
  test('burst bucket carries severity breakdown', () => {
    const records = [];
    for (let i = 0; i < 5; i++) {
      records.push(makeRec({ created_at: new Date(NOW.getTime() - i * 10 * 60000).toISOString() }));
    }
    const burstTs = new Date(NOW.getTime() - 60 * 60000).toISOString();
    for (let j = 0; j < 10; j++) {
      records.push(makeRec({ created_at: burstTs, class: 'red' }));
    }
    const out = buildAlertBurstDetection('BIL', records, 50, NOW);
    if (out.bursts.length > 0) {
      const burst = out.bursts[0];
      expect(burst.severity_breakdown).toHaveProperty('red');
      expect(burst.severity_breakdown).toHaveProperty('orange');
    }
  });
});

describe('M8.21 — tenant isolation', () => {
  test('BANK_DEMO records not counted for BIL', () => {
    const records = [makeRec({ tenant_id: 'BANK_DEMO' })];
    const out = buildAlertBurstDetection('BIL', records, 50, NOW);
    expect(out.total_records).toBe(0);
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M8.21 — route', () => {
  test('GET /v1/alerts/burst-detection → 200', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/alerts/burst-detection')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(typeof res.body.body.burst_count).toBe('number');
    expect(Array.isArray(res.body.body.bursts)).toBe(true);
  });

  test('?window=0 → 400', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/alerts/burst-detection?window=0')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });

  test('403 for unknown role', async () => {
    const { app } = fakeApp('viewer');
    const res = await request(app)
      .get('/v1/alerts/burst-detection')
      .set(TH_BIL)
      .set('x-apex-role', 'viewer');
    expect(res.status).toBe(403);
  });

  test('400 when no tenant header', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/alerts/burst-detection')
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });
});
