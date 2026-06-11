// @ts-nocheck
// T6 M1.27 — API key usage pattern clustering tests.

import request from 'supertest';
import { buildApiKeyUsagePatterns } from '../src/api_key_usage_patterns';
import { InMemoryApiKeyStore } from '../src/api_keys';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin', apiKeyStore) {
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

function makeKey(overrides = {}) {
  return {
    name: 'Test',
    scopes: ['alerts:read'],
    ...overrides,
  };
}

describe('M1.27 — buildApiKeyUsagePatterns pure', () => {
  test('empty store returns zero patterns', () => {
    const store = new InMemoryApiKeyStore();
    const result = buildApiKeyUsagePatterns(store, 'BIL', NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.total_active_keys).toBe(0);
    expect(result.patterns).toHaveLength(0);
    expect(result.most_common_pattern).toBeNull();
    expect(result.single_scope_keys).toBe(0);
    expect(result.full_access_keys).toBe(0);
  });

  test('single scope key creates one pattern', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', makeKey({ scopes: ['alerts:read'] }), 'alice', NOW);
    const result = buildApiKeyUsagePatterns(store, 'BIL', NOW);
    expect(result.total_active_keys).toBe(1);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].pattern).toBe('alerts:read');
    expect(result.patterns[0].key_count).toBe(1);
    expect(result.single_scope_keys).toBe(1);
  });

  test('two keys with same scopes group into one pattern', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', makeKey({ scopes: ['alerts:read', 'audit:read'] }), 'alice', NOW);
    store.create('BIL', makeKey({ scopes: ['audit:read', 'alerts:read'] }), 'alice', NOW); // same sorted
    const result = buildApiKeyUsagePatterns(store, 'BIL', NOW);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].key_count).toBe(2);
  });

  test('patterns sorted by key_count desc', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', makeKey({ scopes: ['alerts:read'] }), 'alice', NOW);
    store.create('BIL', makeKey({ scopes: ['alerts:read'] }), 'alice', NOW);
    store.create('BIL', makeKey({ scopes: ['audit:read'] }), 'alice', NOW);
    const result = buildApiKeyUsagePatterns(store, 'BIL', NOW);
    expect(result.patterns[0].key_count).toBeGreaterThanOrEqual(result.patterns[1].key_count);
  });

  test('usage_rate 0 when no keys used', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', makeKey(), 'alice', NOW);
    const result = buildApiKeyUsagePatterns(store, 'BIL', NOW);
    expect(result.patterns[0].usage_rate).toBe(0);
  });
});

describe('M1.27 — GET /v1/admin/api-keys/usage-patterns route', () => {
  test('admin 200 with envelope', async () => {
    const { app } = makeTestApp();
    const res = await request(app).get('/v1/admin/api-keys/usage-patterns').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toBeDefined();
    expect(res.body.body.patterns).toBeInstanceOf(Array);
  });

  test('field_officer 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app).get('/v1/admin/api-keys/usage-patterns').set(TH);
    expect(res.status).toBe(403);
  });

  test('cross-tenant isolation', async () => {
    const store = new InMemoryApiKeyStore();
    store.create('BANK_DEMO', makeKey(), 'alice', NOW);
    const { app } = makeTestApp('admin', store);
    const res = await request(app).get('/v1/admin/api-keys/usage-patterns').set(TH); // BIL
    expect(res.body.body.total_active_keys).toBe(0);
  });

  test('no tenant header → 400', async () => {
    const { app } = makeTestApp();
    const res = await request(app).get('/v1/admin/api-keys/usage-patterns');
    expect(res.status).toBe(400);
  });
});
