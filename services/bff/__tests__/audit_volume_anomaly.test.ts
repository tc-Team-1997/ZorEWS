// @ts-nocheck
// services/bff/__tests__/audit_volume_anomaly.test.ts
//
// T6 M15.22 — Audit event volume anomaly detection.

import request from 'supertest';
import {
  detectAuditVolumeAnomalies,
  detectAuditVolumeAnomaliesFromStore,
  AuditVolumeAnomalyError,
  DEFAULT_ANOMALY_WINDOW_DAYS,
  MAX_ANOMALY_WINDOW_DAYS,
} from '../src/audit_volume_anomaly';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkEvent(date, tenant = 'BIL') {
  return {
    event_id: `ev-${Math.random().toString(36).slice(2)}`,
    ts: `${date}T12:00:00.000Z`,
    tenant_id: tenant,
    actor_username: 'admin',
    actor_role: 'admin',
    action: 'config.update',
    resource_type: 'config',
    resource_id: 'alerts.red_sla_hours',
    outcome: 'success',
    severity: 'info',
    correlation_id: null,
    ip_address: null,
    metadata: {},
    hash: 'abc123',
    prev_hash: 'GENESIS',
  };
}

function makeAnomalyApp(role) {
  const auditTrailStore = new InMemoryAuditTrailStore();
  const source = new StaticSource([]);
  const evaluator = new StubEvaluator();
  const riskProfile = new StubRiskProfileSource();
  const caseAction = new UnavailableCaseActionSink();
  const getRole = () => role;
  const { app } = makeApp({ source, evaluator, riskProfile, caseAction, getRole, auditTrailStore });
  return { app, auditTrailStore };
}

// ─── Pure function tests ────────────────────────────────────────────

describe('detectAuditVolumeAnomalies — pure', () => {
  test('empty events → no anomalies, std_dev is 0 (all window days are 0)', () => {
    const result = detectAuditVolumeAnomalies('BIL', [], 14, NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.anomaly_count).toBe(0);
    expect(result.anomalies).toHaveLength(0);
    // With 14 days all zero: variance=0, std_dev=0 (computed but no anomalies)
    expect(result.std_dev).toBe(0);
    expect(result.most_anomalous_day).toBeNull();
    expect(result.is_currently_anomalous).toBe(false);
    expect(result.mean_daily_volume).toBe(0);
  });

  test('constant volume across window → no anomalies (std_dev=0)', () => {
    const events = [];
    // 1 event per day for 14 days
    for (let i = 0; i < 14; i++) {
      const d = new Date(NOW);
      d.setUTCDate(d.getUTCDate() - i);
      events.push(mkEvent(d.toISOString().slice(0, 10)));
    }
    const result = detectAuditVolumeAnomalies('BIL', events, 14, NOW);
    expect(result.anomaly_count).toBe(0);
    // std_dev may be very small but not enough to flag anomalies
  });

  test('spike detection: very high volume on one day', () => {
    const events = [];
    // Base: 1 event per day for 12 days
    for (let i = 1; i <= 12; i++) {
      const d = new Date(NOW);
      d.setUTCDate(d.getUTCDate() - i);
      events.push(mkEvent(d.toISOString().slice(0, 10)));
    }
    // Spike: 50 events on a specific day
    const spikeDay = new Date(NOW);
    spikeDay.setUTCDate(spikeDay.getUTCDate() - 2);
    const spikeDayStr = spikeDay.toISOString().slice(0, 10);
    for (let k = 0; k < 50; k++) {
      events.push(mkEvent(spikeDayStr));
    }
    const result = detectAuditVolumeAnomalies('BIL', events, 14, NOW);
    // Should detect the spike
    const spikeAnomaly = result.anomalies.find(a => a.type === 'spike');
    expect(spikeAnomaly).toBeDefined();
    expect(result.anomaly_count).toBeGreaterThan(0);
  });

  test('anomalies sorted date desc', () => {
    // Create events to generate multiple anomalies
    const events = [];
    // Normal baseline: 2 events per day for 12 days
    for (let i = 3; i <= 12; i++) {
      const d = new Date(NOW);
      d.setUTCDate(d.getUTCDate() - i);
      const ds = d.toISOString().slice(0, 10);
      events.push(mkEvent(ds), mkEvent(ds));
    }
    // Two spikes
    const d1 = new Date(NOW);
    d1.setUTCDate(d1.getUTCDate() - 1);
    const d2 = new Date(NOW);
    d2.setUTCDate(d2.getUTCDate() - 2);
    for (let k = 0; k < 50; k++) events.push(mkEvent(d1.toISOString().slice(0, 10)));
    for (let k = 0; k < 50; k++) events.push(mkEvent(d2.toISOString().slice(0, 10)));

    const result = detectAuditVolumeAnomalies('BIL', events, 14, NOW);
    for (let i = 1; i < result.anomalies.length; i++) {
      expect(result.anomalies[i].date <= result.anomalies[i - 1].date).toBe(true);
    }
  });

  test('most_anomalous_day has highest |z_score|', () => {
    const events = [];
    // Baseline
    for (let i = 3; i <= 14; i++) {
      const d = new Date(NOW);
      d.setUTCDate(d.getUTCDate() - i);
      events.push(mkEvent(d.toISOString().slice(0, 10)));
    }
    // Big spike
    const spike = new Date(NOW);
    spike.setUTCDate(spike.getUTCDate() - 1);
    for (let k = 0; k < 100; k++) events.push(mkEvent(spike.toISOString().slice(0, 10)));

    const result = detectAuditVolumeAnomalies('BIL', events, 14, NOW);
    if (result.most_anomalous_day && result.anomalies.length > 0) {
      for (const a of result.anomalies) {
        expect(Math.abs(a.z_score)).toBeLessThanOrEqual(Math.abs(result.most_anomalous_day.z_score) + 0.001);
      }
    }
  });

  test('severity: |z|>3 → high, else medium', () => {
    const events = [];
    // Baseline: 1 per day for 12 days
    for (let i = 3; i <= 14; i++) {
      const d = new Date(NOW);
      d.setUTCDate(d.getUTCDate() - i);
      events.push(mkEvent(d.toISOString().slice(0, 10)));
    }
    // Extreme spike
    const spike = new Date(NOW);
    spike.setUTCDate(spike.getUTCDate() - 1);
    for (let k = 0; k < 200; k++) events.push(mkEvent(spike.toISOString().slice(0, 10)));

    const result = detectAuditVolumeAnomalies('BIL', events, 14, NOW);
    for (const a of result.anomalies) {
      if (Math.abs(a.z_score) > 3) expect(a.severity).toBe('high');
      else expect(a.severity).toBe('medium');
    }
  });

  test('cross-tenant: BANK_DEMO events not counted for BIL', () => {
    const events = [mkEvent('2026-06-01', 'BANK_DEMO')];
    const result = detectAuditVolumeAnomalies('BIL', events, 7, NOW);
    expect(result.mean_daily_volume).toBe(0);
  });

  test('invalid window_days → throws AuditVolumeAnomalyError', () => {
    expect(() => detectAuditVolumeAnomalies('BIL', [], 0, NOW)).toThrow(AuditVolumeAnomalyError);
    expect(() => detectAuditVolumeAnomalies('BIL', [], 91, NOW)).toThrow(AuditVolumeAnomalyError);
    expect(() => detectAuditVolumeAnomalies('BIL', [], 1.5, NOW)).toThrow(AuditVolumeAnomalyError);
  });

  test('exported constants have valid values', () => {
    expect(DEFAULT_ANOMALY_WINDOW_DAYS).toBe(14);
    expect(MAX_ANOMALY_WINDOW_DAYS).toBe(90);
  });
});

// ─── Route tests ────────────────────────────────────────────────────

describe('M15.22 — GET /v1/audit/volume-anomalies', () => {
  test('admin → 200 with anomaly report (empty store)', async () => {
    const { app } = makeAnomalyApp('admin');
    const r = await request(app).get('/v1/audit/volume-anomalies').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.window_days).toBe(14);
    expect(r.body.body.anomaly_count).toBe(0);
    expect(r.body.body.anomalies).toHaveLength(0);
  });

  test('?window=7 respected', async () => {
    const { app } = makeAnomalyApp('admin');
    const r = await request(app).get('/v1/audit/volume-anomalies?window=7').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.window_days).toBe(7);
  });

  test('?window=0 → 400 EWS_400_invalid_input', async () => {
    const { app } = makeAnomalyApp('admin');
    const r = await request(app).get('/v1/audit/volume-anomalies?window=0').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toMatch(/EWS_400/);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAnomalyApp('field_officer');
    const r = await request(app).get('/v1/audit/volume-anomalies').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('400 when no tenant header', async () => {
    const { app } = makeAnomalyApp('admin');
    const r = await request(app).get('/v1/audit/volume-anomalies');
    expect(r.status).toBe(400);
  });

  test('cross-tenant: BIL events invisible to BANK_DEMO', async () => {
    const { app, auditTrailStore } = makeAnomalyApp('admin');
    // Record a BIL event via the store directly
    auditTrailStore.record('BIL', {
      actor_username: 'admin',
      actor_role: 'admin',
      action: 'config.update',
      resource_type: 'config',
      resource_id: 'k1',
      outcome: 'success',
    }, NOW);
    const r = await request(app).get('/v1/audit/volume-anomalies')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r.status).toBe(200);
    expect(r.body.body.mean_daily_volume).toBe(0);
  });
});
