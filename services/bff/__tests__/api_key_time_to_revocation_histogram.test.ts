// services/bff/__tests__/api_key_time_to_revocation_histogram.test.ts
//
// T6 M1.18 — pure + HTTP route tests for the API key time-to-revocation
// distribution histogram.

import {
  summarizeApiKeyTimeToRevocation,
  bucketForLifetime,
  ALL_TIME_TO_REVOCATION_BUCKETS,
  SAMPLE_KEYS_CAP,
  DAY_MS,
} from '../src/api_key_time_to_revocation_histogram';
import { type ApiKeyEntry, type ApiKeyScope, VALID_SCOPES } from '../src/api_keys';

const NOW = new Date('2026-05-22T12:00:00.000Z');

function mkEntry(opts: Partial<ApiKeyEntry> & { key_id: string }): ApiKeyEntry {
  return {
    key_id: opts.key_id,
    tenant_id: opts.tenant_id ?? 'BANK_DEMO',
    name: opts.name ?? `Key ${opts.key_id}`,
    prefix: opts.prefix ?? opts.key_id.slice(0, 8),
    status: opts.status ?? 'active',
    scopes: opts.scopes ?? ['alerts:read'],
    created_at: opts.created_at ?? new Date(NOW.getTime() - 30 * DAY_MS).toISOString(),
    created_by: opts.created_by ?? 'alice.admin',
    expires_at: opts.expires_at ?? null,
    last_used_at: opts.last_used_at ?? null,
    revoked_at: opts.revoked_at ?? null,
    revoked_by: opts.revoked_by ?? null,
  };
}

/** Build a revoked key with explicit lifetime in days. */
function revokedKey(opts: {
  key_id: string;
  lifetime_days: number;
  revoked_by?: string;
  ever_used?: boolean;
  scopes?: ApiKeyScope[];
}): ApiKeyEntry {
  const createdMs = NOW.getTime() - opts.lifetime_days * DAY_MS;
  return mkEntry({
    key_id: opts.key_id,
    status: 'revoked',
    created_at: new Date(createdMs).toISOString(),
    revoked_at: NOW.toISOString(),
    revoked_by: opts.revoked_by ?? 'admin',
    last_used_at: opts.ever_used ? new Date(NOW.getTime() - DAY_MS).toISOString() : null,
    scopes: opts.scopes ?? ['alerts:read'],
  });
}

// ---------------------------------------------------------------------
// bucketForLifetime pure helper
// ---------------------------------------------------------------------

describe('bucketForLifetime — bucket assignment', () => {
  test('0 days → under_1d', () => {
    expect(bucketForLifetime(0)).toBe('under_1d');
  });
  test('0.5 days → under_1d', () => {
    expect(bucketForLifetime(0.5)).toBe('under_1d');
  });
  test('0.999 days → under_1d', () => {
    expect(bucketForLifetime(0.999)).toBe('under_1d');
  });
  test('1 day exactly → 1_to_7d (strict-< upper)', () => {
    expect(bucketForLifetime(1)).toBe('1_to_7d');
  });
  test('5 days → 1_to_7d', () => {
    expect(bucketForLifetime(5)).toBe('1_to_7d');
  });
  test('6.999 days → 1_to_7d', () => {
    expect(bucketForLifetime(6.999)).toBe('1_to_7d');
  });
  test('7 days exactly → 7_to_30d (strict-< boundary)', () => {
    expect(bucketForLifetime(7)).toBe('7_to_30d');
  });
  test('29.999 days → 7_to_30d', () => {
    expect(bucketForLifetime(29.999)).toBe('7_to_30d');
  });
  test('30 days exactly → 30_to_90d', () => {
    expect(bucketForLifetime(30)).toBe('30_to_90d');
  });
  test('89.999 days → 30_to_90d', () => {
    expect(bucketForLifetime(89.999)).toBe('30_to_90d');
  });
  test('90 days exactly → 90d_plus', () => {
    expect(bucketForLifetime(90)).toBe('90d_plus');
  });
  test('500 days → 90d_plus (open-ended top)', () => {
    expect(bucketForLifetime(500)).toBe('90d_plus');
  });
});

// ---------------------------------------------------------------------
// summarizeApiKeyTimeToRevocation pure resolver
// ---------------------------------------------------------------------

describe('summarizeApiKeyTimeToRevocation — pure resolver', () => {
  test('empty input → 5 zero buckets + null leaderboards', () => {
    const r = summarizeApiKeyTimeToRevocation('BANK_DEMO', [], NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.generated_at).toBe('2026-05-22T12:00:00.000Z');
    expect(r.total_revoked_analyzed).toBe(0);
    expect(r.total_excluded_malformed).toBe(0);
    expect(r.total_distinct_revokers).toBe(0);
    expect(r.buckets).toHaveLength(5);
    expect(r.peak_bucket).toBeNull();
    expect(r.peak_count).toBe(0);
    expect(r.mean_lifetime_days).toBeNull();
    expect(r.median_lifetime_days).toBeNull();
    expect(r.p95_lifetime_days).toBeNull();
    expect(r.shortest_lived).toBeNull();
    expect(r.longest_lived).toBeNull();
    expect(r.unused_at_revocation_count).toBe(0);
    for (const b of r.buckets) {
      expect(b.count).toBe(0);
      expect(b.sample_keys).toEqual([]);
      // Every scope key present
      expect(Object.keys(b.by_scope).sort()).toEqual([...VALID_SCOPES].sort());
      for (const scope of VALID_SCOPES) {
        expect(b.by_scope[scope]).toBe(0);
      }
      // by_revoker is compact (empty for zero bucket)
      expect(Object.keys(b.by_revoker)).toEqual([]);
    }
  });

  test('buckets emitted in canonical order regardless of input', () => {
    const r = summarizeApiKeyTimeToRevocation('BANK_DEMO', [], NOW);
    expect(r.buckets.map((b) => b.bucket)).toEqual([
      'under_1d',
      '1_to_7d',
      '7_to_30d',
      '30_to_90d',
      '90d_plus',
    ]);
  });

  test('active keys ignored (not revoked → not analyzed)', () => {
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [mkEntry({ key_id: 'k-active' })],
      NOW,
    );
    expect(r.total_revoked_analyzed).toBe(0);
  });

  test('revoked key missing revoked_at → excluded as malformed', () => {
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [
        mkEntry({
          key_id: 'k-bad',
          status: 'revoked',
          revoked_by: 'admin',
          revoked_at: null,
        }),
      ],
      NOW,
    );
    expect(r.total_revoked_analyzed).toBe(0);
    expect(r.total_excluded_malformed).toBe(1);
  });

  test('revoked key missing revoked_by → excluded', () => {
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [
        mkEntry({
          key_id: 'k-bad',
          status: 'revoked',
          revoked_at: NOW.toISOString(),
          revoked_by: null,
        }),
      ],
      NOW,
    );
    expect(r.total_revoked_analyzed).toBe(0);
    expect(r.total_excluded_malformed).toBe(1);
  });

  test('malformed created_at → excluded', () => {
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [
        mkEntry({
          key_id: 'k-bad',
          status: 'revoked',
          created_at: 'not-a-date',
          revoked_at: NOW.toISOString(),
          revoked_by: 'admin',
        }),
      ],
      NOW,
    );
    expect(r.total_revoked_analyzed).toBe(0);
    expect(r.total_excluded_malformed).toBe(1);
  });

  test('revoked-before-created → excluded as nonsensical', () => {
    const createdMs = NOW.getTime();
    const revokedMs = NOW.getTime() - DAY_MS; // 1 day BEFORE created
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [
        mkEntry({
          key_id: 'k-impossible',
          status: 'revoked',
          created_at: new Date(createdMs).toISOString(),
          revoked_at: new Date(revokedMs).toISOString(),
          revoked_by: 'admin',
        }),
      ],
      NOW,
    );
    expect(r.total_revoked_analyzed).toBe(0);
    expect(r.total_excluded_malformed).toBe(1);
  });

  test('single under_1d key (revoked 6h after create)', () => {
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [revokedKey({ key_id: 'k-001', lifetime_days: 0.25 })],
      NOW,
    );
    expect(r.total_revoked_analyzed).toBe(1);
    const under1d = r.buckets.find((b) => b.bucket === 'under_1d')!;
    expect(under1d.count).toBe(1);
    expect(under1d.by_scope['alerts:read']).toBe(1);
    expect(under1d.by_revoker.admin).toBe(1);
    expect(under1d.sample_keys[0].lifetime_days).toBe(0.25);
  });

  test('each bucket reachable via direct seeding', () => {
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [
        revokedKey({ key_id: 'k-under', lifetime_days: 0.5 }),
        revokedKey({ key_id: 'k-1to7', lifetime_days: 3 }),
        revokedKey({ key_id: 'k-7to30', lifetime_days: 15 }),
        revokedKey({ key_id: 'k-30to90', lifetime_days: 60 }),
        revokedKey({ key_id: 'k-90plus', lifetime_days: 200 }),
      ],
      NOW,
    );
    expect(r.total_revoked_analyzed).toBe(5);
    for (const b of r.buckets) {
      expect(b.count).toBe(1);
    }
  });

  test('boundary placements: 1d / 7d / 30d / 90d all fall UP via strict-<', () => {
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [
        revokedKey({ key_id: 'k-1d-exact', lifetime_days: 1 }),
        revokedKey({ key_id: 'k-7d-exact', lifetime_days: 7 }),
        revokedKey({ key_id: 'k-30d-exact', lifetime_days: 30 }),
        revokedKey({ key_id: 'k-90d-exact', lifetime_days: 90 }),
      ],
      NOW,
    );
    // 1d falls UP to 1_to_7d
    expect(r.buckets.find((b) => b.bucket === '1_to_7d')!.count).toBe(1);
    expect(r.buckets.find((b) => b.bucket === 'under_1d')!.count).toBe(0);
    // 7d → 7_to_30d
    expect(r.buckets.find((b) => b.bucket === '7_to_30d')!.count).toBe(1);
    // 30d → 30_to_90d
    expect(r.buckets.find((b) => b.bucket === '30_to_90d')!.count).toBe(1);
    // 90d → 90d_plus
    expect(r.buckets.find((b) => b.bucket === '90d_plus')!.count).toBe(1);
  });

  test('peak_bucket formula', () => {
    // 3 keys in 7_to_30d, 1 each elsewhere → 7_to_30d wins
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [
        revokedKey({ key_id: 'k-1', lifetime_days: 0.5 }),
        revokedKey({ key_id: 'k-2', lifetime_days: 10 }),
        revokedKey({ key_id: 'k-3', lifetime_days: 15 }),
        revokedKey({ key_id: 'k-4', lifetime_days: 20 }),
        revokedKey({ key_id: 'k-5', lifetime_days: 200 }),
      ],
      NOW,
    );
    expect(r.peak_bucket).toBe('7_to_30d');
    expect(r.peak_count).toBe(3);
  });

  test('peak_bucket canonical iteration tie-break (under_1d wins at tied)', () => {
    // 1 in under_1d + 1 in 1_to_7d → both at 1 → under_1d wins (earlier)
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [
        revokedKey({ key_id: 'k-1', lifetime_days: 0.5 }),
        revokedKey({ key_id: 'k-2', lifetime_days: 3 }),
      ],
      NOW,
    );
    expect(r.peak_bucket).toBe('under_1d');
  });

  test('by_scope accumulation within bucket (multi-scope key contributes per scope)', () => {
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [
        revokedKey({
          key_id: 'k-1',
          lifetime_days: 10,
          scopes: ['alerts:read', 'cases:read'],
        }),
      ],
      NOW,
    );
    const b = r.buckets.find((b) => b.bucket === '7_to_30d')!;
    expect(b.count).toBe(1);
    expect(b.by_scope['alerts:read']).toBe(1);
    expect(b.by_scope['cases:read']).toBe(1);
    // others 0
    for (const s of VALID_SCOPES) {
      if (s !== 'alerts:read' && s !== 'cases:read') {
        expect(b.by_scope[s]).toBe(0);
      }
    }
  });

  test('bogus scope silently filtered from by_scope (closed-enum guard)', () => {
    const entry = revokedKey({ key_id: 'k-1', lifetime_days: 10 });
    entry.scopes = ['alerts:read', 'bogus' as ApiKeyScope];
    const r = summarizeApiKeyTimeToRevocation('BANK_DEMO', [entry], NOW);
    const b = r.buckets.find((b) => b.bucket === '7_to_30d')!;
    expect(b.by_scope['alerts:read']).toBe(1);
    // total count still 1 (entry counted) — verify no 'bogus' key in by_scope
    expect(Object.keys(b.by_scope).sort()).toEqual([...VALID_SCOPES].sort());
  });

  test('by_revoker compact (only revokers with > 0 count appear)', () => {
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [
        revokedKey({ key_id: 'k-1', lifetime_days: 10, revoked_by: 'alice' }),
        revokedKey({ key_id: 'k-2', lifetime_days: 10, revoked_by: 'alice' }),
        revokedKey({ key_id: 'k-3', lifetime_days: 10, revoked_by: 'bob' }),
      ],
      NOW,
    );
    const b = r.buckets.find((b) => b.bucket === '7_to_30d')!;
    expect(b.by_revoker).toEqual({ alice: 2, bob: 1 });
  });

  test('sample_keys sorted lifetime_days asc + cap SAMPLE_KEYS_CAP', () => {
    // 7 keys all in 1_to_7d at varying lifetimes
    const entries = [
      revokedKey({ key_id: 'k-6.5d', lifetime_days: 6.5 }),
      revokedKey({ key_id: 'k-1.5d', lifetime_days: 1.5 }),
      revokedKey({ key_id: 'k-4d', lifetime_days: 4 }),
      revokedKey({ key_id: 'k-2d', lifetime_days: 2 }),
      revokedKey({ key_id: 'k-5d', lifetime_days: 5 }),
      revokedKey({ key_id: 'k-3d', lifetime_days: 3 }),
      revokedKey({ key_id: 'k-6d', lifetime_days: 6 }),
    ];
    const r = summarizeApiKeyTimeToRevocation('BANK_DEMO', entries, NOW);
    const b = r.buckets.find((b) => b.bucket === '1_to_7d')!;
    expect(b.count).toBe(7);
    expect(b.sample_keys).toHaveLength(SAMPLE_KEYS_CAP);
    // Sorted shortest-first
    const lifetimes = b.sample_keys.map((s) => s.lifetime_days);
    expect(lifetimes).toEqual([1.5, 2, 3, 4, 5]);
  });

  test('shortest_lived + longest_lived span the input correctly', () => {
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [
        revokedKey({ key_id: 'k-short', lifetime_days: 0.25 }),
        revokedKey({ key_id: 'k-mid', lifetime_days: 30 }),
        revokedKey({ key_id: 'k-long', lifetime_days: 365 }),
      ],
      NOW,
    );
    expect(r.shortest_lived!.key_id).toBe('k-short');
    expect(r.shortest_lived!.lifetime_days).toBe(0.25);
    expect(r.longest_lived!.key_id).toBe('k-long');
    expect(r.longest_lived!.lifetime_days).toBe(365);
  });

  test('shortest_lived + longest_lived null on empty', () => {
    const r = summarizeApiKeyTimeToRevocation('BANK_DEMO', [], NOW);
    expect(r.shortest_lived).toBeNull();
    expect(r.longest_lived).toBeNull();
  });

  test('unused_at_revocation_count tracks never-used revoked keys', () => {
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [
        revokedKey({ key_id: 'k-1', lifetime_days: 5, ever_used: false }),
        revokedKey({ key_id: 'k-2', lifetime_days: 5, ever_used: false }),
        revokedKey({ key_id: 'k-3', lifetime_days: 5, ever_used: true }),
      ],
      NOW,
    );
    expect(r.total_revoked_analyzed).toBe(3);
    expect(r.unused_at_revocation_count).toBe(2);
  });

  test('mean_lifetime_days = arithmetic mean rounded to 2 decimals', () => {
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [
        revokedKey({ key_id: 'k-1', lifetime_days: 5 }),
        revokedKey({ key_id: 'k-2', lifetime_days: 10 }),
        revokedKey({ key_id: 'k-3', lifetime_days: 15 }),
      ],
      NOW,
    );
    expect(r.mean_lifetime_days).toBe(10);
  });

  test('median + p95 via linear interpolation', () => {
    // [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] — median = 5.5, p95 = 9.55
    const entries: ApiKeyEntry[] = [];
    for (let i = 1; i <= 10; i++) {
      entries.push(revokedKey({ key_id: `k-${i}`, lifetime_days: i }));
    }
    const r = summarizeApiKeyTimeToRevocation('BANK_DEMO', entries, NOW);
    expect(r.median_lifetime_days).toBe(5.5);
    expect(r.p95_lifetime_days).toBeCloseTo(9.55, 2);
  });

  test('mean/median/p95 null when no analyzed keys', () => {
    const r = summarizeApiKeyTimeToRevocation('BANK_DEMO', [], NOW);
    expect(r.mean_lifetime_days).toBeNull();
    expect(r.median_lifetime_days).toBeNull();
    expect(r.p95_lifetime_days).toBeNull();
  });

  test('total_distinct_revokers dedups across all buckets', () => {
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [
        revokedKey({ key_id: 'k-1', lifetime_days: 0.5, revoked_by: 'alice' }),
        revokedKey({ key_id: 'k-2', lifetime_days: 10, revoked_by: 'bob' }),
        revokedKey({ key_id: 'k-3', lifetime_days: 200, revoked_by: 'alice' }),
      ],
      NOW,
    );
    expect(r.total_distinct_revokers).toBe(2);
  });

  test('Σ buckets.count = total_revoked_analyzed', () => {
    const r = summarizeApiKeyTimeToRevocation(
      'BANK_DEMO',
      [
        revokedKey({ key_id: 'k-1', lifetime_days: 0.5 }),
        revokedKey({ key_id: 'k-2', lifetime_days: 3 }),
        revokedKey({ key_id: 'k-3', lifetime_days: 50 }),
        revokedKey({ key_id: 'k-4', lifetime_days: 200 }),
      ],
      NOW,
    );
    const sum = r.buckets.reduce((a, b) => a + b.count, 0);
    expect(sum).toBe(r.total_revoked_analyzed);
    expect(sum).toBe(4);
  });

  test('bucket metadata (min_days + max_days_exclusive + label)', () => {
    const r = summarizeApiKeyTimeToRevocation('BANK_DEMO', [], NOW);
    const under1d = r.buckets.find((b) => b.bucket === 'under_1d')!;
    expect(under1d.min_days).toBe(0);
    expect(under1d.max_days_exclusive).toBe(1);
    expect(under1d.label).toContain('Under 1 day');

    const top = r.buckets.find((b) => b.bucket === '90d_plus')!;
    expect(top.min_days).toBe(90);
    expect(top.max_days_exclusive).toBeNull();
  });

  test('rejects empty tenant_id', () => {
    expect(() =>
      summarizeApiKeyTimeToRevocation('', [], NOW),
    ).toThrow(/tenant_id/);
  });

  test('exports constants + canonical enum', () => {
    expect(SAMPLE_KEYS_CAP).toBe(5);
    expect(DAY_MS).toBe(24 * 60 * 60 * 1000);
    expect(ALL_TIME_TO_REVOCATION_BUCKETS).toEqual([
      'under_1d',
      '1_to_7d',
      '7_to_30d',
      '30_to_90d',
      '90d_plus',
    ]);
  });
});

// ---------------------------------------------------------------------
// HTTP route tests
// ---------------------------------------------------------------------

import request from 'supertest';
import { makeApp } from '../src/server';
import { defaultApiKeyStore } from '../src/api_keys';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('GET /v1/admin/api-keys/time-to-revocation-histogram', () => {
  test('admin happy path empty (BIL tenant)', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/api-keys/time-to-revocation-histogram')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.buckets).toHaveLength(5);
    expect(r.body.body.peak_bucket).toBeNull();
    expect(r.body.body.shortest_lived).toBeNull();
    expect(r.body.body.longest_lived).toBeNull();
  });

  test('403 when role lacks audit:read', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/api-keys/time-to-revocation-histogram')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/api-keys/time-to-revocation-histogram')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });

  test('populated reflects revoked key (BIL tenant for isolation)', async () => {
    const { app } = makeApp({});
    const createdAt = new Date(NOW.getTime() - 10 * DAY_MS);
    const created = defaultApiKeyStore.create(
      'BIL',
      {
        name: 'M1.18 time-to-revoke smoke',
        scopes: ['alerts:read', 'audit:read'],
      },
      'alice.admin',
      createdAt,
    );
    defaultApiKeyStore.revoke('BIL', created.key_id, 'bob.security', NOW);

    const r = await request(app)
      .get('/v1/admin/api-keys/time-to-revocation-histogram')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.status).toBe(200);
    expect(r.body.body.total_revoked_analyzed).toBeGreaterThanOrEqual(1);
    // Lifetime = 10 days → 7_to_30d bucket
    const b = r.body.body.buckets.find(
      (row: { bucket: string }) => row.bucket === '7_to_30d',
    );
    expect(b.count).toBeGreaterThanOrEqual(1);
  });

  test('route mounted BEFORE /:key_id wildcard (literal segment wins)', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/api-keys/time-to-revocation-histogram')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.status).toBe(200);
    expect(r.body.body.buckets).toBeDefined();
  });
});
