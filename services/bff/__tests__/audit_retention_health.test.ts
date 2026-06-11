// @ts-nocheck
import request from 'supertest';
import { buildAuditRetentionHealth } from '../src/audit_retention_health';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-11T12:00:00Z');
const H = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function fakeApp(role = 'admin') {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), getRole: () => role, now: () => NOW });
  return app;
}

describe('buildAuditRetentionHealth', () => {
  test('empty store → healthy with 0 events', () => {
    const r = buildAuditRetentionHealth('BIL', NOW);
    expect(r.total_events).toBe(0);
    expect(r.status).toBe('healthy');
    expect(r.tenant_id).toBe('BIL');
  });
  test('utilization_pct is 0 when empty', () => {
    const r = buildAuditRetentionHealth('BIL', NOW);
    expect(r.utilization_pct).toBe(0);
  });
  test('capacity is 5000', () => {
    const r = buildAuditRetentionHealth('BIL', NOW);
    expect(r.capacity).toBe(5000);
  });
  test('utilization_pct is between 0 and 100', () => {
    const r = buildAuditRetentionHealth('BIL', NOW);
    expect(r.utilization_pct).toBeGreaterThanOrEqual(0);
    expect(r.utilization_pct).toBeLessThanOrEqual(100);
  });
  test('recommendations is an array', () => {
    const r = buildAuditRetentionHealth('BIL', NOW);
    expect(Array.isArray(r.recommendations)).toBe(true);
  });
  test('generated_at echoed', () => {
    const r = buildAuditRetentionHealth('BIL', NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
  });
});

describe('GET /v1/audit/retention-health', () => {
  test('admin → 200', async () => {
    const res = await request(fakeApp()).get('/v1/audit/retention-health').set(H);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('total_events');
    expect(res.body.body).toHaveProperty('status');
    expect(res.body.body).toHaveProperty('capacity');
  });
  test('field_officer → 403', async () => {
    const res = await request(fakeApp('field_officer')).get('/v1/audit/retention-health').set(H);
    expect(res.status).toBe(403);
  });
  test('no tenant → 400', async () => {
    const res = await request(fakeApp()).get('/v1/audit/retention-health').set('X-Channel','API');
    expect(res.status).toBe(400);
  });
});
