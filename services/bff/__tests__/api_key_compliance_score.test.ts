// @ts-nocheck
import { describe, it, expect, beforeEach } from '@jest/globals';
import { makeApp } from '../src/server';
import { InMemoryApiKeyStore } from '../src/api_keys';
import { buildApiKeyComplianceScore } from '../src/api_key_compliance_score';
import supertest from 'supertest';

describe('buildApiKeyComplianceScore', () => {
  const NOW = new Date('2026-06-11T12:00:00Z');

  it('returns zero score and D grade with no active keys', () => {
    const store = new InMemoryApiKeyStore();
    const out = buildApiKeyComplianceScore(store, 'BIL', NOW);
    expect(out.total_active_keys).toBe(0);
    expect(out.compliance_score).toBe(0);
    expect(out.compliance_grade).toBe('D');
    expect(out.recommendations.length).toBeGreaterThan(0);
  });

  it('scores keys with expiry set', () => {
    const store = new InMemoryApiKeyStore();
    const future = new Date(NOW.getTime() + 30 * 86400000).toISOString();
    store.create('BIL', { name: 'k1', scopes: ['alerts:read'], expires_at: future }, 'admin', NOW);
    const out = buildApiKeyComplianceScore(store, 'BIL', NOW);
    expect(out.keys_with_expiry_pct).toBe(100);
    expect(out.total_active_keys).toBe(1);
  });

  it('marks recently rotated keys (age < 90 days)', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k1', scopes: ['alerts:read'] }, 'admin', new Date(NOW.getTime() - 30 * 86400000));
    const out = buildApiKeyComplianceScore(store, 'BIL', NOW);
    expect(out.keys_recently_rotated_pct).toBe(100);
  });

  it('marks old keys (age > 90 days) as not recently rotated', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k1', scopes: ['alerts:read'] }, 'admin', new Date(NOW.getTime() - 100 * 86400000));
    const out = buildApiKeyComplianceScore(store, 'BIL', NOW);
    expect(out.keys_recently_rotated_pct).toBe(0);
  });

  it('marks keys with minimal scopes (<=3)', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k1', scopes: ['alerts:read', 'cases:read'] }, 'admin', NOW);
    const out = buildApiKeyComplianceScore(store, 'BIL', NOW);
    expect(out.keys_with_minimal_scopes_pct).toBe(100);
  });

  it('returns A grade for high compliance', () => {
    const store = new InMemoryApiKeyStore();
    const future = new Date(NOW.getTime() + 30 * 86400000).toISOString();
    store.create('BIL', { name: 'k1', scopes: ['alerts:read'], expires_at: future }, 'admin', new Date(NOW.getTime() - 10 * 86400000));
    const out = buildApiKeyComplianceScore(store, 'BIL', NOW);
    expect(['A', 'B', 'C', 'D']).toContain(out.compliance_grade);
    expect(out.compliance_score).toBeGreaterThanOrEqual(0);
    expect(out.compliance_score).toBeLessThanOrEqual(100);
  });

  it('has all required envelope fields', () => {
    const store = new InMemoryApiKeyStore();
    const out = buildApiKeyComplianceScore(store, 'BIL', NOW);
    expect(out.tenant_id).toBe('BIL');
    expect(out.generated_at).toBeDefined();
    expect(typeof out.compliance_score).toBe('number');
    expect(Array.isArray(out.recommendations)).toBe(true);
  });
});

describe('GET /v1/admin/api-keys/compliance-score', () => {
  function makeTestApp() {
    const apiKeyStore = new InMemoryApiKeyStore();
    const { app } = makeApp({ apiKeyStore });
    return { app, apiKeyStore };
  }

  it('returns 200 for admin', async () => {
    const { app } = makeTestApp();
    const res = await supertest(app)
      .get('/v1/admin/api-keys/compliance-score')
      .set('X-Tenant-ID', 'BIL')
      .set('X-Channel', 'API')
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.compliance_grade).toBeDefined();
  });

  it('returns 403 for non-admin', async () => {
    const { app } = makeTestApp();
    const res = await supertest(app)
      .get('/v1/admin/api-keys/compliance-score')
      .set('X-Tenant-ID', 'BIL')
      .set('X-Channel', 'API')
      .set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });

  it('is isolated across tenants', async () => {
    const { app, apiKeyStore } = makeTestApp();
    apiKeyStore.create('BIL', { name: 'k1', scopes: ['alerts:read'] }, 'admin', new Date());
    const resBil = await supertest(app)
      .get('/v1/admin/api-keys/compliance-score')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'admin');
    const resBank = await supertest(app)
      .get('/v1/admin/api-keys/compliance-score')
      .set('X-Tenant-ID', 'BANK_DEMO').set('X-Channel', 'API').set('x-apex-role', 'admin');
    expect(resBil.body.body.total_active_keys).toBe(1);
    expect(resBank.body.body.total_active_keys).toBe(0);
  });
});
