// @ts-nocheck
// T6 M2.29 — Tenant activity fingerprint tests.

import request from 'supertest';
import { buildTenantActivityFingerprint } from '../src/tenant_activity_fingerprint';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin', auditTrailStore?) {
  const store = auditTrailStore ?? new InMemoryAuditTrailStore();
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    auditTrailStore: store,
  });
  return { app, store };
}

describe('M2.29 — buildTenantActivityFingerprint pure', () => {
  test('empty store returns null leaderboards', () => {
    const store = new InMemoryAuditTrailStore();
    const result = buildTenantActivityFingerprint(store, 'BIL', NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.most_active_module).toBeNull();
    expect(result.most_active_actor).toBeNull();
    expect(result.most_common_action).toBeNull();
    expect(result.peak_activity_hour).toBeNull();
    expect(result.activity_diversity_score).toBe(0);
    expect(typeof result.fingerprint_hash).toBe('string');
  });

  test('events produce populated fingerprint', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', {
      actor_username: 'alice',
      actor_role: 'admin',
      action: 'config.update',
      resource_type: 'config',
      resource_id: 'key1',
      outcome: 'success',
      severity: 'info',
    }, NOW);
    store.record('BIL', {
      actor_username: 'alice',
      actor_role: 'admin',
      action: 'config.update',
      resource_type: 'config',
      resource_id: 'key2',
      outcome: 'success',
      severity: 'info',
    }, NOW);
    const result = buildTenantActivityFingerprint(store, 'BIL', NOW);
    expect(result.most_active_module).toBe('config');
    expect(result.most_active_actor).toBe('alice');
    expect(result.most_common_action).toBe('config.update');
    expect(result.peak_activity_hour).toBeGreaterThanOrEqual(0);
    expect(result.activity_diversity_score).toBeGreaterThanOrEqual(0);
  });

  test('fingerprint_hash changes with different tenant', () => {
    const store = new InMemoryAuditTrailStore();
    const r1 = buildTenantActivityFingerprint(store, 'BIL', NOW);
    const r2 = buildTenantActivityFingerprint(store, 'BANK_DEMO', NOW);
    expect(r1.fingerprint_hash).not.toBe(r2.fingerprint_hash);
  });

  test('throws on empty tenant_id', () => {
    const store = new InMemoryAuditTrailStore();
    expect(() => buildTenantActivityFingerprint(store, '', NOW)).toThrow();
  });
});

describe('M2.29 — GET /v1/tenants/activity-fingerprint route', () => {
  test('admin returns 200 with fingerprint', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/tenants/activity-fingerprint')
      .set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body.tenant_id).toBe('BIL');
    expect(typeof res.body.body.fingerprint_hash).toBe('string');
  });

  test('field_officer returns 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/tenants/activity-fingerprint')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('cross-tenant isolation', async () => {
    const bilStore = new InMemoryAuditTrailStore();
    bilStore.record('BIL', {
      actor_username: 'bil-user',
      actor_role: 'admin',
      action: 'config.update',
      resource_type: 'config',
      resource_id: 'k1',
      outcome: 'success',
      severity: 'info',
    }, NOW);
    const { app } = makeTestApp('admin', bilStore);
    const res = await request(app)
      .get('/v1/tenants/activity-fingerprint')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(res.status).toBe(200);
    // BANK_DEMO should see no BIL events
    expect(res.body.body.most_active_actor).toBeNull();
  });
});
