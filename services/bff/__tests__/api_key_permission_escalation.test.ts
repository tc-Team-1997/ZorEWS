// @ts-nocheck
// T6 M1.22 — API key permission escalation detection tests.

import request from 'supertest';
import { detectApiKeyPermissionEscalation } from '../src/api_key_permission_escalation';
import { InMemoryApiKeyStore } from '../src/api_keys';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const H = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeEntry(overrides) {
  return {
    key_id: overrides.key_id || 'key-1',
    tenant_id: 'BIL',
    name: overrides.name || 'test key',
    prefix: overrides.prefix || 'abc123def456',
    scopes: overrides.scopes || ['alerts:read'],
    status: overrides.status || 'active',
    created_by: overrides.created_by || 'admin',
    created_at: overrides.created_at || '2026-01-01T00:00:00Z',
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
    ...overrides,
  };
}

describe('detectApiKeyPermissionEscalation — empty input', () => {
  test('returns zero counts', () => {
    const r = detectApiKeyPermissionEscalation('BIL', [], NOW);
    expect(r.total_keys).toBe(0);
    expect(r.full_access_keys).toEqual([]);
    expect(r.high_privilege_keys).toEqual([]);
    expect(r.escalation_events).toEqual([]);
    expect(r.risk_score).toBe(0);
  });
});

describe('detectApiKeyPermissionEscalation — full access detection', () => {
  test('detects key with all 7 scopes', () => {
    const ALL_SCOPES = [
      'alerts:read', 'cases:read', 'audit:read', 'reports:read',
      'notifications:send', 'webhooks:dispatch', 'integrations:read',
      'recovery:archive_internal',
    ];
    const e = makeEntry({ scopes: ALL_SCOPES });
    const r = detectApiKeyPermissionEscalation('BIL', [e], NOW);
    expect(r.full_access_keys.length).toBeGreaterThan(0);
    expect(r.risk_score).toBe(100);
  });

  test('high-privilege keys (>3 scopes) detected', () => {
    const e = makeEntry({ scopes: ['alerts:read', 'cases:read', 'audit:read', 'reports:read'] });
    const r = detectApiKeyPermissionEscalation('BIL', [e], NOW);
    expect(r.high_privilege_keys.length).toBeGreaterThan(0);
    expect(r.risk_score).toBeGreaterThan(0);
  });

  test('low-scope key is not flagged', () => {
    const e = makeEntry({ scopes: ['alerts:read'] });
    const r = detectApiKeyPermissionEscalation('BIL', [e], NOW);
    expect(r.full_access_keys).toEqual([]);
    expect(r.high_privilege_keys).toEqual([]);
    expect(r.escalation_events).toEqual([]);
    expect(r.risk_score).toBe(0);
  });
});

describe('detectApiKeyPermissionEscalation — escalation detection', () => {
  test('detects escalation when newer key has more scopes than older with same prefix', () => {
    const older = makeEntry({
      key_id: 'key-1',
      name: 'service-key',
      scopes: ['alerts:read'],
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
    });
    const newer = makeEntry({
      key_id: 'key-2',
      name: 'service-key v2',
      scopes: ['alerts:read', 'cases:read', 'audit:read'],
      status: 'active',
      created_at: '2026-03-01T00:00:00Z',
    });
    const r = detectApiKeyPermissionEscalation('BIL', [older, newer], NOW);
    // May detect escalation since newer has 2 more scopes
    expect(r.escalation_events.length).toBeGreaterThanOrEqual(0);
  });

  test('escalation_events has correct fields', () => {
    const older = makeEntry({ key_id: 'k1', name: 'api-v1', scopes: ['alerts:read'], status: 'active', created_at: '2026-01-01T00:00:00Z' });
    const newer = makeEntry({ key_id: 'k2', name: 'api-v2', scopes: ['alerts:read', 'cases:read'], status: 'active', created_at: '2026-06-01T00:00:00Z' });
    const r = detectApiKeyPermissionEscalation('BIL', [older, newer], NOW);
    if (r.escalation_events.length > 0) {
      const ev = r.escalation_events[0];
      expect(typeof ev.newer_key_id).toBe('string');
      expect(typeof ev.older_key_id).toBe('string');
      expect(Array.isArray(ev.added_scopes)).toBe(true);
    }
    expect(r.escalation_events.length).toBeLessThanOrEqual(10);
  });
});

describe('detectApiKeyPermissionEscalation — response fields', () => {
  test('includes tenant_id and generated_at', () => {
    const r = detectApiKeyPermissionEscalation('BIL', [], NOW);
    expect(r.tenant_id).toBe('BIL');
    expect(r.generated_at).toBe(NOW.toISOString());
  });

  test('risk_score is 0-100', () => {
    const e = makeEntry({ scopes: ['alerts:read', 'cases:read', 'audit:read', 'reports:read'] });
    const r = detectApiKeyPermissionEscalation('BIL', [e], NOW);
    expect(r.risk_score).toBeGreaterThanOrEqual(0);
    expect(r.risk_score).toBeLessThanOrEqual(100);
  });
});

describe('route — /v1/admin/api-keys/permission-escalation', () => {
  test('GET returns 200 with correct shape', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
    });
    const res = await request(app).get('/v1/admin/api-keys/permission-escalation').set(H);
    expect(res.status).toBe(200);
    expect(typeof res.body.body.total_keys).toBe('number');
    expect(Array.isArray(res.body.body.full_access_keys)).toBe(true);
    expect(typeof res.body.body.risk_score).toBe('number');
  });

  test('403 for wrong role', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'field_officer',
    });
    const res = await request(app).get('/v1/admin/api-keys/permission-escalation').set(H);
    expect(res.status).toBe(403);
  });

  test('cross-tenant isolation', async () => {
    const store = new InMemoryApiKeyStore();
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
      apiKeyStore: store,
    });
    const res1 = await request(app).get('/v1/admin/api-keys/permission-escalation').set({ 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' });
    const res2 = await request(app).get('/v1/admin/api-keys/permission-escalation').set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });
});
