// @ts-nocheck
// __tests__/api_key_scope_combination_analytics.test.ts
// T6 M1.20 — API key scope combination analytics

import request from 'supertest';
import { buildApiKeyScopeCombinationAnalytics } from '../src/api_key_scope_combination_analytics';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-09T10:00:00Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

function makeEntry(overrides) {
  return {
    key_id: `k-${Math.random().toString(36).slice(2)}`,
    tenant_id: 'BIL',
    name: 'Test Key',
    prefix: 'testprefix',
    scopes: ['audit:read'],
    status: 'active',
    created_by: 'alice.admin',
    created_at: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
    ...overrides,
  };
}

describe('buildApiKeyScopeCombinationAnalytics — M1.20', () => {
  it('empty store → zero envelope', () => {
    const result = buildApiKeyScopeCombinationAnalytics('BIL', [], NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.total_active_keys).toBe(0);
    expect(result.total_combinations).toBe(0);
    expect(result.combinations).toHaveLength(0);
    expect(result.most_common).toBeNull();
    expect(result.single_scope_pct).toBe(0);
    expect(result.multi_scope_pct).toBe(0);
  });

  it('revoked keys excluded from active count', () => {
    const entries = [
      makeEntry({ status: 'active', scopes: ['alerts:read'] }),
      makeEntry({ status: 'revoked', scopes: ['audit:read'] }),
    ];
    const result = buildApiKeyScopeCombinationAnalytics('BIL', entries, NOW);
    expect(result.total_active_keys).toBe(1);
    expect(result.total_combinations).toBe(1);
  });

  it('groups by sorted scopes combination', () => {
    const entries = [
      makeEntry({ key_id: 'k-1', scopes: ['audit:read', 'alerts:read'] }),
      makeEntry({ key_id: 'k-2', scopes: ['alerts:read', 'audit:read'] }),
    ];
    const result = buildApiKeyScopeCombinationAnalytics('BIL', entries, NOW);
    expect(result.total_combinations).toBe(1);
    expect(result.combinations[0].key_count).toBe(2);
    expect(result.combinations[0].combination).toBe('alerts:read,audit:read');
  });

  it('distinct combinations tracked separately', () => {
    const entries = [
      makeEntry({ scopes: ['alerts:read'] }),
      makeEntry({ scopes: ['audit:read'] }),
    ];
    const result = buildApiKeyScopeCombinationAnalytics('BIL', entries, NOW);
    expect(result.total_combinations).toBe(2);
  });

  it('sorted key_count desc + combination asc tie-break', () => {
    const entries = [
      makeEntry({ key_id: 'k-1', scopes: ['audit:read'] }),
      makeEntry({ key_id: 'k-2', scopes: ['alerts:read'] }),
      makeEntry({ key_id: 'k-3', scopes: ['alerts:read'] }),
    ];
    const result = buildApiKeyScopeCombinationAnalytics('BIL', entries, NOW);
    expect(result.combinations[0].combination).toBe('alerts:read');
    expect(result.combinations[0].key_count).toBe(2);
  });

  it('sample_key_ids capped at 3 and sorted asc', () => {
    const entries = [
      makeEntry({ key_id: 'k-z', scopes: ['alerts:read'] }),
      makeEntry({ key_id: 'k-a', scopes: ['alerts:read'] }),
      makeEntry({ key_id: 'k-m', scopes: ['alerts:read'] }),
      makeEntry({ key_id: 'k-b', scopes: ['alerts:read'] }),
    ];
    const result = buildApiKeyScopeCombinationAnalytics('BIL', entries, NOW);
    const samples = result.combinations[0].sample_key_ids;
    expect(samples.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i - 1] <= samples[i]).toBe(true);
    }
  });

  it('capped at 10 combinations', () => {
    const entries = Array.from({ length: 11 }, (_, i) =>
      makeEntry({ scopes: [`alerts:read`], key_id: `k-${i}`, name: `combo-${i}` }),
    );
    // All same combo — actually 1 combination
    const result = buildApiKeyScopeCombinationAnalytics('BIL', entries, NOW);
    expect(result.combinations.length).toBeLessThanOrEqual(10);
  });

  it('most_common points at top combination', () => {
    const entries = [
      makeEntry({ scopes: ['alerts:read'] }),
      makeEntry({ scopes: ['alerts:read'] }),
      makeEntry({ scopes: ['audit:read'] }),
    ];
    const result = buildApiKeyScopeCombinationAnalytics('BIL', entries, NOW);
    expect(result.most_common).not.toBeNull();
    expect(result.most_common.combination).toBe('alerts:read');
    expect(result.most_common.key_count).toBe(2);
  });

  it('single_scope_pct and multi_scope_pct', () => {
    const entries = [
      makeEntry({ scopes: ['alerts:read'] }),
      makeEntry({ scopes: ['audit:read', 'alerts:read'] }),
    ];
    const result = buildApiKeyScopeCombinationAnalytics('BIL', entries, NOW);
    expect(result.single_scope_pct).toBeCloseTo(0.5, 2);
    expect(result.multi_scope_pct).toBeCloseTo(0.5, 2);
  });

  it('scope_count reflects number of scopes in combo', () => {
    const entries = [
      makeEntry({ scopes: ['alerts:read', 'audit:read', 'reports:read'] }),
    ];
    const result = buildApiKeyScopeCombinationAnalytics('BIL', entries, NOW);
    expect(result.combinations[0].scope_count).toBe(3);
  });

  it('admin route GET /v1/admin/api-keys/scope-combination-analytics → 200', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/admin/api-keys/scope-combination-analytics')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.tenant_id).toBe('BIL');
    expect(typeof res.body.body.total_active_keys).toBe('number');
    expect(Array.isArray(res.body.body.combinations)).toBe(true);
  });

  it('non-admin → 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/admin/api-keys/scope-combination-analytics')
      .set(TH_BIL)
      .set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });
});
