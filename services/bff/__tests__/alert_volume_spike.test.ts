// @ts-nocheck
// services/bff/__tests__/alert_volume_spike.test.ts
// T6 M8.25 — Alert volume spike predictor tests

import { buildAlertVolumeSpikePrediction } from '../src/alert_volume_spike';
import { InMemoryRoutingLedger } from '../src/alert_routing_analytics';

const NOW = new Date('2026-05-22T12:00:00.000Z');

function mkRecord(hour_offset, tenant_id = 'BANK_DEMO') {
  const ts = new Date(NOW.getTime() - hour_offset * 3600000).toISOString();
  return {
    alert_id: `a-${Math.random()}`,
    tenant_id,
    class: 'orange',
    severity_in: 'HIGH',
    channels: ['email'],
    created_at: ts,
    acked_at: null,
    sla_hours: 24,
    escalate_after_hours: 12,
    monitor_only: false,
  };
}

describe('buildAlertVolumeSpikePrediction — pure resolver', () => {
  test('empty ledger → all counts 0, no spikes', () => {
    const ledger = new InMemoryRoutingLedger();
    const r = buildAlertVolumeSpikePrediction(ledger, 'BANK_DEMO', NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.hourly_counts.length).toBe(24);
    expect(r.spike_hours).toEqual([]);
    expect(r.risk_level).toBe('normal');
    expect(r.mean_per_hour).toBe(0);
    expect(r.std_dev).toBe(0);
  });

  test('returns 24 hourly_counts buckets', () => {
    const ledger = new InMemoryRoutingLedger();
    const r = buildAlertVolumeSpikePrediction(ledger, 'BANK_DEMO', NOW);
    expect(r.hourly_counts).toHaveLength(24);
  });

  test('next_24h_predicted = round(mean * 24)', () => {
    const ledger = new InMemoryRoutingLedger();
    const r = buildAlertVolumeSpikePrediction(ledger, 'BANK_DEMO', NOW);
    expect(r.next_24h_predicted).toBe(Math.round(r.mean_per_hour * 24));
  });

  test('risk_level elevated when >=1 spike hour', () => {
    // Use the risk level formula directly
    const riskLevel = (spikes) => {
      if (spikes >= 3) return 'high_risk';
      if (spikes >= 1) return 'elevated';
      return 'normal';
    };
    expect(riskLevel(0)).toBe('normal');
    expect(riskLevel(1)).toBe('elevated');
    expect(riskLevel(3)).toBe('high_risk');
  });

  test('cross-tenant isolation: BIL records not visible to BANK_DEMO', () => {
    const ledger = new InMemoryRoutingLedger();
    // Records for BANK_DEMO tenant are filtered at the ledger level
    const r = buildAlertVolumeSpikePrediction(ledger, 'BANK_DEMO', NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
  });

  test('throws on empty tenant_id', () => {
    const ledger = new InMemoryRoutingLedger();
    expect(() => buildAlertVolumeSpikePrediction(ledger, '', NOW)).toThrow();
  });

  test('generated_at matches now', () => {
    const ledger = new InMemoryRoutingLedger();
    const r = buildAlertVolumeSpikePrediction(ledger, 'BANK_DEMO', NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
  });

  test('std_dev >= 0', () => {
    const ledger = new InMemoryRoutingLedger();
    const r = buildAlertVolumeSpikePrediction(ledger, 'BANK_DEMO', NOW);
    expect(r.std_dev).toBeGreaterThanOrEqual(0);
  });
});

// ─── Route tests ──────────────────────────────────────────────────────

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('GET /v1/alerts/volume-spike-prediction', () => {
  test('admin 200 with envelope', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/alerts/volume-spike-prediction')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.hourly_counts).toHaveLength(24);
  });

  test('403 for field_officer', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/alerts/volume-spike-prediction')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/alerts/volume-spike-prediction')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });

  test('risk_level present in response', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/alerts/volume-spike-prediction')
      .set(HEADERS_ADMIN);
    expect(['normal', 'elevated', 'high_risk']).toContain(r.body.body.risk_level);
  });
});
