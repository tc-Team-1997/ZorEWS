// @ts-nocheck
// services/bff/__tests__/api_key_access_pattern.test.ts
//
// T6 M1.21 — API key access pattern analysis.

import request from 'supertest';
import { buildApiKeyAccessPatternSummary } from '../src/api_key_access_pattern';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TENANT = 'BIL';

function makeEntry(overrides) {
  return {
    key_id: 'k-001',
    tenant_id: TENANT,
    name: 'Test Key',
    prefix: 'test123456',
    scopes: ['alerts:read'],
    status: 'active',
    created_by: 'admin',
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
    ...overrides,
  };
}

// ─── pure function ───────────────────────────────────────────────────

describe('M1.21 — empty input', () => {
  test('returns zero counts for empty entries', () => {
    const s = buildApiKeyAccessPatternSummary(TENANT, [], NOW);
    expect(s.total_active).toBe(0);
    expect(s.usage_recency.today).toBe(0);
    expect(s.usage_recency.never_used).toBe(0);
    expect(s.dormancy_risk_score).toBe(0);
    expect(s.usage_coverage).toBe(0);
    expect(s.high_usage_keys).toHaveLength(0);
    expect(s.security_flags).toHaveLength(0);
  });

  test('throws on empty tenant_id', () => {
    expect(() => buildApiKeyAccessPatternSummary('', [], NOW)).toThrow();
  });
});

describe('M1.21 — recency buckets', () => {
  test('used today classified correctly', () => {
    const ts = NOW.getTime() - 60_000; // 1 minute ago
    const s = buildApiKeyAccessPatternSummary(TENANT, [
      makeEntry({ key_id: 'k1', last_used_at: new Date(ts).toISOString() }),
    ], NOW);
    expect(s.usage_recency.today).toBe(1);
    expect(s.usage_recency.never_used).toBe(0);
  });

  test('never-used key counted in never_used', () => {
    const s = buildApiKeyAccessPatternSummary(TENANT, [
      makeEntry({ key_id: 'k1', last_used_at: null }),
    ], NOW);
    expect(s.usage_recency.never_used).toBe(1);
    expect(s.total_active).toBe(1);
  });

  test('revoked key goes to expired_or_revoked', () => {
    const s = buildApiKeyAccessPatternSummary(TENANT, [
      makeEntry({ key_id: 'k1', status: 'revoked', revoked_at: NOW.toISOString(), revoked_by: 'admin' }),
    ], NOW);
    expect(s.usage_recency.expired_or_revoked).toBe(1);
    expect(s.total_active).toBe(0);
  });
});

describe('M1.21 — security flags', () => {
  test('never-used key produces security flag', () => {
    const s = buildApiKeyAccessPatternSummary(TENANT, [
      makeEntry({ key_id: 'k1', last_used_at: null }),
    ], NOW);
    expect(s.security_flags.length).toBeGreaterThan(0);
    expect(s.security_flags[0]).toMatch(/never used/i);
  });
});

describe('M1.21 — usage_coverage', () => {
  test('all-never-used → usage_coverage = 0', () => {
    const s = buildApiKeyAccessPatternSummary(TENANT, [
      makeEntry({ key_id: 'k1' }),
      makeEntry({ key_id: 'k2' }),
    ], NOW);
    expect(s.usage_coverage).toBe(0);
  });

  test('tenant scoping: cross-tenant keys excluded', () => {
    const s = buildApiKeyAccessPatternSummary(TENANT, [
      makeEntry({ key_id: 'k1', tenant_id: 'BANK_DEMO' }),
    ], NOW);
    expect(s.total_active).toBe(0);
  });
});

describe('M1.21 — high_usage_keys', () => {
  test('top-5 most-recently-used keys returned', () => {
    const entries = [];
    for (let i = 1; i <= 7; i++) {
      entries.push(makeEntry({
        key_id: `k-${i}`,
        last_used_at: new Date(NOW.getTime() - i * 3600_000).toISOString(),
      }));
    }
    const s = buildApiKeyAccessPatternSummary(TENANT, entries, NOW);
    expect(s.high_usage_keys.length).toBeLessThanOrEqual(5);
  });
});

describe('M1.21 — dormancy_risk_score', () => {
  test('0 when all keys used recently', () => {
    const ts = NOW.getTime() - 60_000;
    const s = buildApiKeyAccessPatternSummary(TENANT, [
      makeEntry({ key_id: 'k1', last_used_at: new Date(ts).toISOString() }),
    ], NOW);
    expect(s.dormancy_risk_score).toBe(0);
  });
});

// ─── route ───────────────────────────────────────────────────────────

function makeApp2(role) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M1.21 — GET /v1/admin/api-keys/access-pattern-summary', () => {
  test('admin → 200', async () => {
    const { app } = makeApp2('admin');
    const r = await request(app).get('/v1/admin/api-keys/access-pattern-summary').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('non-admin → 403', async () => {
    const { app } = makeApp2('risk_analyst');
    const r = await request(app).get('/v1/admin/api-keys/access-pattern-summary').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL response differs from BANK_DEMO', async () => {
    const { app } = makeApp2('admin');
    const bil = await request(app).get('/v1/admin/api-keys/access-pattern-summary').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/admin/api-keys/access-pattern-summary')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(bil.body.body.tenant_id).toBe('BIL');
    expect(bank.body.body.tenant_id).toBe('BANK_DEMO');
  });
});
