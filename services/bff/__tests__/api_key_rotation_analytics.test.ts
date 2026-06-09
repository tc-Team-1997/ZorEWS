// __tests__/api_key_rotation_analytics.test.ts
// T6 M1.19 — API key rotation analytics

import request from 'supertest';
import {
  buildApiKeyRotationAnalytics,
} from '../src/api_key_rotation_analytics';
import type { ApiKeyEntry } from '../src/api_keys';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-08T12:00:00Z');
const NOW_MS = NOW.getTime();
const DAY_MS = 24 * 60 * 60 * 1000;
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeRotationApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

function makeEntry(overrides: Partial<ApiKeyEntry> = {}): ApiKeyEntry {
  return {
    key_id: `k-${Math.random().toString(36).slice(2)}`,
    tenant_id: 'BIL',
    name: 'Test Key',
    prefix: 'testprefix',
    scopes: ['audit:read'],
    status: 'active',
    created_by: 'alice.admin',
    created_at: new Date(NOW_MS - 10 * DAY_MS).toISOString(),
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
    ...overrides,
  };
}

describe('buildApiKeyRotationAnalytics — M1.19', () => {
  it('empty store → zero counts and null averages', () => {
    const result = buildApiKeyRotationAnalytics('BIL', [], NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.total_active).toBe(0);
    expect(result.rotation_due_30d).toBe(0);
    expect(result.rotation_overdue).toBe(0);
    expect(result.never_rotated_count).toBe(0);
    expect(result.avg_key_age_days).toBeNull();
    expect(result.oldest_active_key_age_days).toBeNull();
    expect(result.rotation_velocity_30d).toBe(0);
    expect(result.recommended_rotations).toHaveLength(0);
  });

  it('only active keys are counted (revoked filtered)', () => {
    const entries = [
      makeEntry({ status: 'active' }),
      makeEntry({ status: 'revoked', revoked_at: new Date(NOW_MS - 50 * DAY_MS).toISOString() }),
    ];
    const result = buildApiKeyRotationAnalytics('BIL', entries, NOW);
    expect(result.total_active).toBe(1);
  });

  it('rotation_due_30d: active key expiring within 30 days', () => {
    const exp = new Date(NOW_MS + 10 * DAY_MS).toISOString();
    const entries = [makeEntry({ expires_at: exp })];
    const result = buildApiKeyRotationAnalytics('BIL', entries, NOW);
    expect(result.rotation_due_30d).toBe(1);
    expect(result.rotation_overdue).toBe(0);
  });

  it('rotation_overdue: active key with expires_at in the past', () => {
    const exp = new Date(NOW_MS - 5 * DAY_MS).toISOString();
    const entries = [makeEntry({ expires_at: exp })];
    const result = buildApiKeyRotationAnalytics('BIL', entries, NOW);
    expect(result.rotation_overdue).toBe(1);
    expect(result.rotation_due_30d).toBe(0);
  });

  it('never_rotated_count: active + never used + > 90 days old', () => {
    const old = makeEntry({
      last_used_at: null,
      created_at: new Date(NOW_MS - 100 * DAY_MS).toISOString(),
    });
    const fresh = makeEntry({
      last_used_at: null,
      created_at: new Date(NOW_MS - 30 * DAY_MS).toISOString(),
    });
    const result = buildApiKeyRotationAnalytics('BIL', [old, fresh], NOW);
    expect(result.never_rotated_count).toBe(1);
  });

  it('avg_key_age_days formula', () => {
    const entries = [
      makeEntry({ created_at: new Date(NOW_MS - 10 * DAY_MS).toISOString() }),
      makeEntry({ created_at: new Date(NOW_MS - 20 * DAY_MS).toISOString() }),
    ];
    const result = buildApiKeyRotationAnalytics('BIL', entries, NOW);
    expect(result.avg_key_age_days).toBeCloseTo(15, 1);
  });

  it('oldest_active_key_age_days is max among active', () => {
    const entries = [
      makeEntry({ created_at: new Date(NOW_MS - 50 * DAY_MS).toISOString() }),
      makeEntry({ created_at: new Date(NOW_MS - 200 * DAY_MS).toISOString() }),
    ];
    const result = buildApiKeyRotationAnalytics('BIL', entries, NOW);
    expect(result.oldest_active_key_age_days).toBeCloseTo(200, 0);
  });

  it('rotation_velocity_30d: revoked keys with revoked_at in last 30 days', () => {
    const entries = [
      makeEntry({
        status: 'revoked',
        revoked_at: new Date(NOW_MS - 5 * DAY_MS).toISOString(),
      }),
      makeEntry({
        status: 'revoked',
        revoked_at: new Date(NOW_MS - 40 * DAY_MS).toISOString(),
      }),
    ];
    const result = buildApiKeyRotationAnalytics('BIL', entries, NOW);
    expect(result.rotation_velocity_30d).toBe(1);
  });

  it('recommended_rotations capped at 10', () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      makeEntry({
        key_id: `k-${i}`,
        last_used_at: null,
        created_at: new Date(NOW_MS - (100 + i) * DAY_MS).toISOString(),
      }),
    );
    const result = buildApiKeyRotationAnalytics('BIL', entries, NOW);
    expect(result.recommended_rotations.length).toBeLessThanOrEqual(10);
  });

  it('recommended_rotations sorted by age desc', () => {
    const entries = [
      makeEntry({
        key_id: 'k-1',
        last_used_at: null,
        created_at: new Date(NOW_MS - 150 * DAY_MS).toISOString(),
      }),
      makeEntry({
        key_id: 'k-2',
        last_used_at: null,
        created_at: new Date(NOW_MS - 200 * DAY_MS).toISOString(),
      }),
    ];
    const result = buildApiKeyRotationAnalytics('BIL', entries, NOW);
    const recs = result.recommended_rotations;
    expect(recs.length).toBeGreaterThan(0);
    for (let i = 1; i < recs.length; i++) {
      expect(recs[i - 1]!.age_days).toBeGreaterThanOrEqual(recs[i]!.age_days);
    }
  });

  it('admin route GET /v1/admin/api-keys/rotation-analytics → 200', async () => {
    const { app } = makeRotationApp('admin');
    const res = await request(app)
      .get('/v1/admin/api-keys/rotation-analytics')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.tenant_id).toBe('BIL');
    expect(typeof res.body.body.total_active).toBe('number');
    expect(Array.isArray(res.body.body.recommended_rotations)).toBe(true);
  });

  it('non-admin role → 403', async () => {
    const { app } = makeRotationApp('field_officer');
    const res = await request(app)
      .get('/v1/admin/api-keys/rotation-analytics')
      .set(TH_BIL)
      .set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });

  it('M1.9 sibling regression: /v1/admin/api-keys/daily-volume still 200', async () => {
    const { app } = makeRotationApp('admin');
    const res = await request(app)
      .get('/v1/admin/api-keys/daily-volume')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
  });
});
