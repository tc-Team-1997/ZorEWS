// @ts-nocheck
// T6 M15.29 — Audit volume forecast tests.

import request from 'supertest';
import { buildAuditVolumeForecast } from '../src/audit_volume_forecast';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin', auditTrailStore?) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    auditTrailStore,
  });
  return { app };
}

describe('M15.29 — buildAuditVolumeForecast pure', () => {
  test('empty store returns zero forecast', () => {
    const store = new InMemoryAuditTrailStore();
    const result = buildAuditVolumeForecast('BIL', NOW, store);
    expect(result.tenant_id).toBe('BIL');
    expect(result.current_total_events).toBe(0);
    expect(result.events_last_7_days).toHaveLength(7);
    expect(result.next_7_days_forecast).toHaveLength(7);
    expect(result.capacity_warning).toBe(false);
    expect(result.days_until_capacity).toBeNull();
  });

  test('events in last 7 days are counted', () => {
    const store = new InMemoryAuditTrailStore();
    // Add event today
    store.record('BIL', {
      actor_username: 'alice',
      actor_role: 'admin',
      action: 'config.update',
      resource_type: 'config',
      resource_id: 'k1',
      outcome: 'success',
      severity: 'info',
    }, NOW);
    const result = buildAuditVolumeForecast('BIL', NOW, store);
    expect(result.current_total_events).toBe(1);
    const last7Total = result.events_last_7_days.reduce((s, v) => s + v, 0);
    expect(last7Total).toBe(1);
  });

  test('next_7_days_forecast all non-negative', () => {
    const store = new InMemoryAuditTrailStore();
    const result = buildAuditVolumeForecast('BIL', NOW, store);
    for (const v of result.next_7_days_forecast) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  test('cross-tenant isolation', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', {
      actor_username: 'alice',
      actor_role: 'admin',
      action: 'config.update',
      resource_type: 'config',
      resource_id: 'k1',
      outcome: 'success',
      severity: 'info',
    }, NOW);
    const result = buildAuditVolumeForecast('BANK_DEMO', NOW, store);
    expect(result.current_total_events).toBe(0);
  });

  test('throws on empty tenant_id', () => {
    const store = new InMemoryAuditTrailStore();
    expect(() => buildAuditVolumeForecast('', NOW, store)).toThrow();
  });
});

describe('M15.29 — GET /v1/audit/volume-forecast route', () => {
  test('admin returns 200', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/audit/volume-forecast')
      .set(TH);
    expect(res.status).toBe(200);
    expect(typeof res.body.body.current_total_events).toBe('number');
    expect(res.body.body.next_7_days_forecast).toHaveLength(7);
    expect(typeof res.body.body.capacity_warning).toBe('boolean');
  });

  test('field_officer returns 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/audit/volume-forecast')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('cross-tenant isolation via HTTP', async () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', {
      actor_username: 'alice',
      actor_role: 'admin',
      action: 'config.update',
      resource_type: 'config',
      resource_id: 'k1',
      outcome: 'success',
      severity: 'info',
    }, NOW);
    const { app } = makeTestApp('admin', store);
    const res = await request(app)
      .get('/v1/audit/volume-forecast')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(res.status).toBe(200);
    expect(res.body.body.current_total_events).toBe(0);
  });
});
