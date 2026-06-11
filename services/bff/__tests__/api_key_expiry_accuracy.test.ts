// @ts-nocheck
// T6 M1.29 — API key expiry forecast accuracy tests.

import request from 'supertest';
import { buildApiKeyExpiryAccuracy } from '../src/api_key_expiry_accuracy';
import { InMemoryApiKeyStore } from '../src/api_keys';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin', apiKeyStore?) {
  const store = apiKeyStore ?? new InMemoryApiKeyStore();
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    apiKeyStore: store,
  });
  return { app, store };
}

describe('M1.29 — buildApiKeyExpiryAccuracy pure', () => {
  test('empty store returns accurate result', () => {
    const store = new InMemoryApiKeyStore();
    const result = buildApiKeyExpiryAccuracy(store, 'BIL', NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.total_with_expiry).toBe(0);
    expect(result.expired_count).toBe(0);
    expect(result.accuracy_score).toBe(100);
    expect(result.rotation_urgency).toBe('ok');
  });

  test('active key with future expiry in >30 days = ok urgency', () => {
    const store = new InMemoryApiKeyStore();
    const futureDate = new Date(NOW.getTime() + 60 * 86400000).toISOString();
    store.create('BIL', { name: 'Test', scopes: ['alerts:read'], expires_at: futureDate }, 'admin', NOW);
    const result = buildApiKeyExpiryAccuracy(store, 'BIL', NOW);
    expect(result.total_with_expiry).toBe(1);
    expect(result.ok_count).toBe(1);
    expect(result.rotation_urgency).toBe('planned');
  });

  test('active key expiring within 7 days = critical + immediate urgency', () => {
    const store = new InMemoryApiKeyStore();
    const soonDate = new Date(NOW.getTime() + 3 * 86400000).toISOString();
    store.create('BIL', { name: 'Soon', scopes: ['alerts:read'], expires_at: soonDate }, 'admin', NOW);
    const result = buildApiKeyExpiryAccuracy(store, 'BIL', NOW);
    expect(result.critical_count).toBe(1);
    expect(result.rotation_urgency).toBe('immediate');
  });

  test('active key expiring within 7-30 days = warning urgency', () => {
    const store = new InMemoryApiKeyStore();
    const warnDate = new Date(NOW.getTime() + 15 * 86400000).toISOString();
    store.create('BIL', { name: 'Warn', scopes: ['alerts:read'], expires_at: warnDate }, 'admin', NOW);
    const result = buildApiKeyExpiryAccuracy(store, 'BIL', NOW);
    expect(result.warning_count).toBe(1);
    expect(result.rotation_urgency).toBe('soon');
  });

  test('accuracy_score decreases with expired active keys', () => {
    const store = new InMemoryApiKeyStore();
    const pastDate = new Date(NOW.getTime() - 5 * 86400000).toISOString();
    store.create('BIL', { name: 'Past', scopes: ['alerts:read'], expires_at: pastDate }, 'admin', NOW);
    const result = buildApiKeyExpiryAccuracy(store, 'BIL', NOW);
    expect(result.expired_count).toBe(1);
    expect(result.accuracy_score).toBeLessThan(100);
    expect(result.rotation_urgency).toBe('immediate');
  });

  test('throws on empty tenant_id', () => {
    const store = new InMemoryApiKeyStore();
    expect(() => buildApiKeyExpiryAccuracy(store, '', NOW)).toThrow();
  });
});

describe('M1.29 — GET /v1/admin/api-keys/expiry-accuracy route', () => {
  test('admin returns 200 with result shape', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/admin/api-keys/expiry-accuracy')
      .set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body.tenant_id).toBe('BIL');
    expect(typeof res.body.body.accuracy_score).toBe('number');
    expect(['immediate', 'soon', 'planned', 'ok']).toContain(res.body.body.rotation_urgency);
  });

  test('field_officer returns 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/admin/api-keys/expiry-accuracy')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('missing tenant header returns 400', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app).get('/v1/admin/api-keys/expiry-accuracy');
    expect(res.status).toBe(400);
  });
});
