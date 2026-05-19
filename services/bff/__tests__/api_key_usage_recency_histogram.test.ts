// services/bff/__tests__/api_key_usage_recency_histogram.test.ts
//
// T6 M1.13 — API key usage recency histogram.

import request from 'supertest';
import {
  buildApiKeyUsageRecencyHistogram,
  bucketForUsageRecency,
  ALL_USAGE_RECENCY_BUCKETS,
} from '../src/api_key_usage_recency_histogram';
import {
  InMemoryApiKeyStore,
  VALID_SCOPES,
  type ApiKeyEntry,
  type ApiKeyStore,
} from '../src/api_keys';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeTestApp(role: string = 'admin', apiKeyStore?: ApiKeyStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    apiKeyStore: apiKeyStore ?? new InMemoryApiKeyStore(),
  });
}

function key(overrides: Partial<ApiKeyEntry> = {}): ApiKeyEntry {
  return {
    key_id: 'k-' + Math.random().toString(36).slice(2, 10),
    tenant_id: 'BIL',
    name: 'Test Key',
    prefix: 'abcdef',
    scopes: ['alerts:read'],
    status: 'active',
    created_by: 'alice',
    created_at: NOW.toISOString(),
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
    ...overrides,
  };
}

const NOW_MS = NOW.getTime();
const daysAgo = (n: number): string => new Date(NOW_MS - n * 86_400_000).toISOString();

// ─── bucketForUsageRecency pure helper ────────────────────────────────

describe('M1.13 — bucketForUsageRecency', () => {
  test('revoked → revoked regardless of usage', () => {
    const k = key({ status: 'revoked', last_used_at: daysAgo(1) });
    expect(bucketForUsageRecency(k, NOW)).toBe('revoked');
  });

  test('active + null last_used_at → never_used', () => {
    const k = key({ status: 'active', last_used_at: null });
    expect(bucketForUsageRecency(k, NOW)).toBe('never_used');
  });

  test('active + used 1 day ago → used_within_7d', () => {
    const k = key({ last_used_at: daysAgo(1) });
    expect(bucketForUsageRecency(k, NOW)).toBe('used_within_7d');
  });

  test('boundary 7d → used_within_30d (strict-<)', () => {
    const k = key({ last_used_at: daysAgo(7) });
    expect(bucketForUsageRecency(k, NOW)).toBe('used_within_30d');
  });

  test('active + used 10d ago → used_within_30d', () => {
    const k = key({ last_used_at: daysAgo(10) });
    expect(bucketForUsageRecency(k, NOW)).toBe('used_within_30d');
  });

  test('boundary 30d → used_within_90d', () => {
    const k = key({ last_used_at: daysAgo(30) });
    expect(bucketForUsageRecency(k, NOW)).toBe('used_within_90d');
  });

  test('active + used 60d ago → used_within_90d', () => {
    const k = key({ last_used_at: daysAgo(60) });
    expect(bucketForUsageRecency(k, NOW)).toBe('used_within_90d');
  });

  test('boundary 90d → stale', () => {
    const k = key({ last_used_at: daysAgo(90) });
    expect(bucketForUsageRecency(k, NOW)).toBe('stale');
  });

  test('active + used 200d ago → stale', () => {
    const k = key({ last_used_at: daysAgo(200) });
    expect(bucketForUsageRecency(k, NOW)).toBe('stale');
  });
});

// ─── Pure resolver ─────────────────────────────────────────────────────

describe('M1.13 — buildApiKeyUsageRecencyHistogram', () => {
  test('empty input → 6 zero buckets + null peak', () => {
    const s = buildApiKeyUsageRecencyHistogram('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.total_keys).toBe(0);
    expect(s.total_active_keys).toBe(0);
    expect(s.total_revoked_keys).toBe(0);
    expect(s.buckets.length).toBe(6);
    for (const b of s.buckets) expect(b.count).toBe(0);
    expect(s.peak_bucket).toBeNull();
    expect(s.peak_count).toBe(0);
    expect(s.unused_buckets).toEqual([...ALL_USAGE_RECENCY_BUCKETS]);
    expect(s.total_active_used_recently_count).toBe(0);
    expect(s.total_active_stale_or_never_count).toBe(0);
  });

  test('buckets in canonical order', () => {
    const s = buildApiKeyUsageRecencyHistogram('BIL', [], NOW);
    expect(s.buckets.map((b) => b.bucket)).toEqual([...ALL_USAGE_RECENCY_BUCKETS]);
  });

  test('every by_scope key present per bucket', () => {
    const s = buildApiKeyUsageRecencyHistogram('BIL', [], NOW);
    for (const b of s.buckets) {
      for (const scope of VALID_SCOPES) {
        expect(b.by_scope[scope]).toBe(0);
      }
      expect(Object.keys(b.by_scope).length).toBe(VALID_SCOPES.length);
    }
  });

  test('single revoked key lands in revoked bucket', () => {
    const k = key({ status: 'revoked', last_used_at: daysAgo(2) });
    const s = buildApiKeyUsageRecencyHistogram('BIL', [k], NOW);
    expect(s.total_keys).toBe(1);
    expect(s.total_revoked_keys).toBe(1);
    expect(s.total_active_keys).toBe(0);
    const revoked = s.buckets.find((b) => b.bucket === 'revoked')!;
    expect(revoked.count).toBe(1);
  });

  test('multi-scope key contributes to each scope', () => {
    const k = key({ scopes: ['alerts:read', 'cases:read', 'audit:read'] });
    const s = buildApiKeyUsageRecencyHistogram('BIL', [k], NOW);
    const never_used = s.buckets.find((b) => b.bucket === 'never_used')!;
    expect(never_used.count).toBe(1);
    expect(never_used.by_scope['alerts:read']).toBe(1);
    expect(never_used.by_scope['cases:read']).toBe(1);
    expect(never_used.by_scope['audit:read']).toBe(1);
    expect(never_used.by_scope['reports:read']).toBe(0);
  });

  test('intra-key scope dedup defensive', () => {
    const k = key({ scopes: ['alerts:read', 'alerts:read'] as never });
    const s = buildApiKeyUsageRecencyHistogram('BIL', [k], NOW);
    const never_used = s.buckets.find((b) => b.bucket === 'never_used')!;
    expect(never_used.by_scope['alerts:read']).toBe(1);
  });

  test('distinct_creators deduped per bucket', () => {
    const keys = [
      key({ key_id: 'k1', created_by: 'alice', last_used_at: daysAgo(1) }),
      key({ key_id: 'k2', created_by: 'alice', last_used_at: daysAgo(2) }),
      key({ key_id: 'k3', created_by: 'bob', last_used_at: daysAgo(3) }),
    ];
    const s = buildApiKeyUsageRecencyHistogram('BIL', keys, NOW);
    const used_within_7d = s.buckets.find((b) => b.bucket === 'used_within_7d')!;
    expect(used_within_7d.count).toBe(3);
    expect(used_within_7d.distinct_creators).toBe(2);
  });

  test('sample_key_ids cap 5 sorted asc', () => {
    const keys: ApiKeyEntry[] = [];
    for (let i = 0; i < 8; i++) {
      keys.push(key({ key_id: `k${i}`, last_used_at: daysAgo(1) }));
    }
    const s = buildApiKeyUsageRecencyHistogram('BIL', keys, NOW);
    const bucket = s.buckets.find((b) => b.bucket === 'used_within_7d')!;
    expect(bucket.count).toBe(8);
    expect(bucket.sample_key_ids.length).toBe(5);
    const sorted = [...bucket.sample_key_ids].sort((a, b) => a.localeCompare(b));
    expect(bucket.sample_key_ids).toEqual(sorted);
  });

  test('mixed cohort distribution', () => {
    const keys = [
      key({ key_id: 'k1', status: 'revoked' }),
      key({ key_id: 'k2', last_used_at: null }),
      key({ key_id: 'k3', last_used_at: daysAgo(1) }),
      key({ key_id: 'k4', last_used_at: daysAgo(20) }),
      key({ key_id: 'k5', last_used_at: daysAgo(60) }),
      key({ key_id: 'k6', last_used_at: daysAgo(200) }),
    ];
    const s = buildApiKeyUsageRecencyHistogram('BIL', keys, NOW);
    expect(s.total_keys).toBe(6);
    expect(s.total_revoked_keys).toBe(1);
    expect(s.total_active_keys).toBe(5);
    for (const expected of [
      'revoked',
      'never_used',
      'used_within_7d',
      'used_within_30d',
      'used_within_90d',
      'stale',
    ] as const) {
      expect(s.buckets.find((b) => b.bucket === expected)!.count).toBe(1);
    }
  });

  test('Σ buckets.count = total_keys partition invariant', () => {
    const keys = [
      key({ status: 'revoked' }),
      key({ last_used_at: null }),
      key({ last_used_at: daysAgo(5) }),
      key({ last_used_at: daysAgo(45) }),
    ];
    const s = buildApiKeyUsageRecencyHistogram('BIL', keys, NOW);
    const sum = s.buckets.reduce((a, b) => a + b.count, 0);
    expect(sum).toBe(s.total_keys);
  });

  test('active + revoked partition equals total', () => {
    const keys = [
      key({ status: 'revoked' }),
      key({ status: 'revoked', last_used_at: daysAgo(1) }),
      key({ last_used_at: daysAgo(5) }),
    ];
    const s = buildApiKeyUsageRecencyHistogram('BIL', keys, NOW);
    expect(s.total_active_keys + s.total_revoked_keys).toBe(s.total_keys);
  });

  test('peak_bucket = highest count', () => {
    const keys = [
      key({ key_id: 'k1', last_used_at: daysAgo(1) }),
      key({ key_id: 'k2', last_used_at: daysAgo(2) }),
      key({ key_id: 'k3', last_used_at: daysAgo(3) }),
      key({ key_id: 'k4', status: 'revoked' }),
    ];
    const s = buildApiKeyUsageRecencyHistogram('BIL', keys, NOW);
    expect(s.peak_bucket).toBe('used_within_7d');
    expect(s.peak_count).toBe(3);
  });

  test('peak_bucket canonical iteration tie-break (revoked wins at tied)', () => {
    const keys = [
      key({ key_id: 'k1', status: 'revoked' }),
      key({ key_id: 'k2', last_used_at: daysAgo(1) }),
    ];
    const s = buildApiKeyUsageRecencyHistogram('BIL', keys, NOW);
    expect(s.peak_bucket).toBe('revoked'); // revoked iterates first
    expect(s.peak_count).toBe(1);
  });

  test('unused_buckets canonical order', () => {
    const k = key({ last_used_at: daysAgo(1) });
    const s = buildApiKeyUsageRecencyHistogram('BIL', [k], NOW);
    expect(s.unused_buckets).toEqual([
      'revoked',
      'never_used',
      'used_within_30d',
      'used_within_90d',
      'stale',
    ]);
  });

  test('total_active_used_recently_count covers used_within_* buckets', () => {
    const keys = [
      key({ key_id: 'k1', last_used_at: daysAgo(1) }),
      key({ key_id: 'k2', last_used_at: daysAgo(15) }),
      key({ key_id: 'k3', last_used_at: daysAgo(60) }),
      key({ key_id: 'k4', last_used_at: daysAgo(200) }), // stale — excluded
      key({ key_id: 'k5', last_used_at: null }), // never_used — excluded
    ];
    const s = buildApiKeyUsageRecencyHistogram('BIL', keys, NOW);
    expect(s.total_active_used_recently_count).toBe(3);
  });

  test('total_active_stale_or_never_count covers never_used + stale', () => {
    const keys = [
      key({ key_id: 'k1', last_used_at: null }),
      key({ key_id: 'k2', last_used_at: null }),
      key({ key_id: 'k3', last_used_at: daysAgo(200) }),
      key({ key_id: 'k4', last_used_at: daysAgo(5) }), // recent — excluded
    ];
    const s = buildApiKeyUsageRecencyHistogram('BIL', keys, NOW);
    expect(s.total_active_stale_or_never_count).toBe(3);
  });

  test('tenant_id + generated_at echo', () => {
    const s = buildApiKeyUsageRecencyHistogram('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });

  test('Σ by_scope per bucket ≤ count × |scopes per key| (no overflow)', () => {
    // Each key contributes 1 to N scope counters where N=key.scopes.length.
    // Σ scope counters should equal Σ scopes lengths across bucket's keys.
    const keys = [
      key({ key_id: 'k1', scopes: ['alerts:read', 'cases:read'], last_used_at: daysAgo(1) }),
      key({ key_id: 'k2', scopes: ['audit:read'], last_used_at: daysAgo(2) }),
    ];
    const s = buildApiKeyUsageRecencyHistogram('BIL', keys, NOW);
    const bucket = s.buckets.find((b) => b.bucket === 'used_within_7d')!;
    const totalScopeBindings = Object.values(bucket.by_scope).reduce(
      (a, n) => a + n,
      0,
    );
    expect(totalScopeBindings).toBe(3); // 2 + 1
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M1.13 — GET /v1/admin/api-keys/usage-recency-histogram', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/usage-recency-histogram')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(0);
    expect(r.body.body.buckets.length).toBe(6);
  });

  test('populated reflects keys', async () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'A', scopes: ['alerts:read'] }, 'alice', NOW);
    store.create('BIL', { name: 'B', scopes: ['cases:read'] }, 'bob', NOW);
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/admin/api-keys/usage-recency-histogram')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(2);
    expect(r.body.body.total_active_keys).toBe(2);
    const never = r.body.body.buckets.find(
      (b: { bucket: string }) => b.bucket === 'never_used',
    );
    expect(never.count).toBe(2);
    expect(r.body.body.peak_bucket).toBe('never_used');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTestApp('case_owner');
    const r = await request(app)
      .get('/v1/admin/api-keys/usage-recency-histogram')
      .set(TH);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'A', scopes: ['alerts:read'] }, 'alice', NOW);
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/admin/api-keys/usage-recency-histogram')
      .set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(0);
  });

  test('M1.12 /scope-creator-matrix sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/scope-creator-matrix')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('literal /usage-recency-histogram not captured by /:key_id wildcard', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/usage-recency-histogram')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.buckets).toBeDefined();
  });
});
