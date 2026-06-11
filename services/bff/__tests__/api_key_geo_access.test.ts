// @ts-nocheck
// T6 M1.28 — API key geographic access analysis.

import request from 'supertest';
import { buildApiKeyGeoAccess } from '../src/api_key_geo_access';
import { InMemoryApiKeyStore } from '../src/api_keys';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeStore() { return new InMemoryApiKeyStore(); }

function makeGeoApp(role = 'admin', store = makeStore()) {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => role, apiKeyStore: store });
  return app;
}

describe('M1.28 — empty store', () => {
  test('zero active keys returns empty', () => {
    const store = makeStore();
    const out = buildApiKeyGeoAccess(store, 'BIL', NOW);
    expect(out.total_active_keys).toBe(0);
    expect(out.by_country).toEqual([]);
    expect(out.anomalous_keys).toEqual([]);
    expect(out.anomaly_rate).toBe(0);
  });
});

describe('M1.28 — with keys', () => {
  test('active key gets a country assigned', () => {
    const store = makeStore();
    store.create('BIL', { name: 'Key A', scopes: ['alerts:read'] }, 'alice', NOW);
    const out = buildApiKeyGeoAccess(store, 'BIL', NOW);
    expect(out.total_active_keys).toBe(1);
    expect(out.keys.length).toBe(1);
    expect(['KE', 'NG', 'ZA', 'GH', 'TZ', 'UG', 'RW', 'ET']).toContain(out.keys[0].country_code);
    expect(out.keys[0].access_count).toBeGreaterThanOrEqual(5);
    expect(out.keys[0].access_count).toBeLessThanOrEqual(100);
  });

  test('by_country sorted by access_count desc', () => {
    const store = makeStore();
    for (let i = 0; i < 5; i++) store.create('BIL', { name: `Key ${i}`, scopes: ['alerts:read'] }, 'alice', NOW);
    const out = buildApiKeyGeoAccess(store, 'BIL', NOW);
    for (let i = 0; i < out.by_country.length - 1; i++) {
      expect(out.by_country[i].access_count).toBeGreaterThanOrEqual(out.by_country[i + 1].access_count);
    }
  });

  test('anomaly_rate in [0,1]', () => {
    const store = makeStore();
    for (let i = 0; i < 3; i++) store.create('BIL', { name: `Key ${i}`, scopes: ['alerts:read'] }, 'alice', NOW);
    const out = buildApiKeyGeoAccess(store, 'BIL', NOW);
    expect(out.anomaly_rate).toBeGreaterThanOrEqual(0);
    expect(out.anomaly_rate).toBeLessThanOrEqual(1);
  });

  test('revoked keys not included', () => {
    const store = makeStore();
    const created = store.create('BIL', { name: 'Key A', scopes: ['alerts:read'] }, 'alice', NOW);
    store.revoke('BIL', created.key_id, 'alice', NOW);
    const out = buildApiKeyGeoAccess(store, 'BIL', NOW);
    expect(out.total_active_keys).toBe(0);
  });

  test('cross-tenant isolation', () => {
    const store = makeStore();
    store.create('BIL', { name: 'BIL Key', scopes: ['alerts:read'] }, 'alice', NOW);
    const out = buildApiKeyGeoAccess(store, 'BANK_DEMO', NOW);
    expect(out.total_active_keys).toBe(0);
  });
});

describe('M1.28 — route', () => {
  test('admin GET /v1/admin/api-keys/geo-access returns 200', async () => {
    const store = makeStore();
    store.create('BIL', { name: 'Key A', scopes: ['alerts:read'] }, 'alice', NOW);
    const app = makeGeoApp('admin', store);
    const res = await request(app).get('/v1/admin/api-keys/geo-access').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body.total_active_keys).toBe(1);
    expect(Array.isArray(res.body.body.by_country)).toBe(true);
  });

  test('non-admin gets 403', async () => {
    const app = makeGeoApp('field_officer');
    const res = await request(app).get('/v1/admin/api-keys/geo-access').set(TH);
    expect(res.status).toBe(403);
  });

  test('cross-tenant: BANK_DEMO sees 0 keys', async () => {
    const store = makeStore();
    store.create('BIL', { name: 'BIL Key', scopes: ['alerts:read'] }, 'alice', NOW);
    const app = makeGeoApp('admin', store);
    const res = await request(app).get('/v1/admin/api-keys/geo-access').set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(res.status).toBe(200);
    expect(res.body.body.total_active_keys).toBe(0);
  });
});
