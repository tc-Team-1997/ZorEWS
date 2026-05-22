// services/bff/__tests__/api_key_revoker_rollup.test.ts
//
// T6 M1.17 — pure resolver + HTTP route tests for the API key
// per-revoker rollup.

import {
  summarizeApiKeyRevokerRollup,
  KEY_IDS_CAP,
  MASS_REVOCATION_THRESHOLD,
  MASS_REVOCATION_WINDOW_MS,
} from '../src/api_key_revoker_rollup';
import { type ApiKeyEntry, type ApiKeyScope } from '../src/api_keys';

const NOW = new Date('2026-05-22T12:00:00.000Z');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function mkEntry(opts: Partial<ApiKeyEntry> & { key_id: string }): ApiKeyEntry {
  return {
    key_id: opts.key_id,
    tenant_id: opts.tenant_id ?? 'BANK_DEMO',
    name: opts.name ?? `Key ${opts.key_id}`,
    prefix: opts.prefix ?? opts.key_id.slice(0, 8),
    status: opts.status ?? 'active',
    scopes: opts.scopes ?? ['alerts:read'],
    created_at: opts.created_at ?? new Date(NOW.getTime() - 30 * ONE_DAY_MS).toISOString(),
    created_by: opts.created_by ?? 'alice.admin',
    expires_at: opts.expires_at ?? null,
    last_used_at: opts.last_used_at ?? null,
    revoked_at: opts.revoked_at ?? null,
    revoked_by: opts.revoked_by ?? null,
  };
}

function revokedEntry(opts: {
  key_id: string;
  revoked_by: string;
  revoked_at: Date;
  created_by?: string;
  scopes?: ApiKeyScope[];
  tenant_id?: string;
}): ApiKeyEntry {
  return mkEntry({
    key_id: opts.key_id,
    tenant_id: opts.tenant_id,
    status: 'revoked',
    revoked_by: opts.revoked_by,
    revoked_at: opts.revoked_at.toISOString(),
    created_by: opts.created_by ?? 'alice.admin',
    scopes: opts.scopes ?? ['alerts:read'],
  });
}

// ---------------------------------------------------------------------
// Pure resolver
// ---------------------------------------------------------------------

describe('summarizeApiKeyRevokerRollup — pure resolver', () => {
  test('empty input → zero rollup + null leaderboard', () => {
    const r = summarizeApiKeyRevokerRollup('BANK_DEMO', [], NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.generated_at).toBe('2026-05-22T12:00:00.000Z');
    expect(r.total_revocations).toBe(0);
    expect(r.total_revokers).toBe(0);
    expect(r.revokers).toEqual([]);
    expect(r.most_active_revoker).toBeNull();
    expect(r.mass_revocation_events).toEqual([]);
  });

  test('only revoked keys counted; active keys ignored', () => {
    const r = summarizeApiKeyRevokerRollup(
      'BANK_DEMO',
      [
        mkEntry({ key_id: 'k-active' }),
        revokedEntry({
          key_id: 'k-rev',
          revoked_by: 'admin',
          revoked_at: NOW,
        }),
      ],
      NOW,
    );
    expect(r.total_revocations).toBe(1);
    expect(r.total_revokers).toBe(1);
  });

  test('revoked key with null revoked_by ignored (defensive)', () => {
    const r = summarizeApiKeyRevokerRollup(
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
    expect(r.total_revocations).toBe(0);
  });

  test('revoked key with null revoked_at ignored (defensive)', () => {
    const r = summarizeApiKeyRevokerRollup(
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
    expect(r.total_revocations).toBe(0);
  });

  test('revoked key with empty revoked_by ignored', () => {
    const r = summarizeApiKeyRevokerRollup(
      'BANK_DEMO',
      [
        revokedEntry({
          key_id: 'k-1',
          revoked_by: '   ',
          revoked_at: NOW,
        }),
      ],
      NOW,
    );
    expect(r.total_revocations).toBe(0);
  });

  test('malformed revoked_at ignored (defensive)', () => {
    const r = summarizeApiKeyRevokerRollup(
      'BANK_DEMO',
      [
        mkEntry({
          key_id: 'k-bad',
          status: 'revoked',
          revoked_by: 'admin',
          revoked_at: 'not-a-date',
        }),
      ],
      NOW,
    );
    expect(r.total_revocations).toBe(0);
  });

  test('single revoker single key', () => {
    const r = summarizeApiKeyRevokerRollup(
      'BANK_DEMO',
      [
        revokedEntry({
          key_id: 'k-001',
          revoked_by: 'admin',
          revoked_at: NOW,
          created_by: 'alice.admin',
          scopes: ['alerts:read'],
        }),
      ],
      NOW,
    );
    expect(r.total_revocations).toBe(1);
    expect(r.total_revokers).toBe(1);
    const row = r.revokers[0];
    expect(row.revoker_username).toBe('admin');
    expect(row.total_revocations).toBe(1);
    expect(row.distinct_creators_revoked).toBe(1);
    expect(row.distinct_scopes_revoked).toBe(1);
    expect(row.key_ids).toEqual(['k-001']);
    expect(row.first_revoked_at).toBe(NOW.toISOString());
    expect(row.last_revoked_at).toBe(NOW.toISOString());
  });

  test('distinct_creators_revoked dedup across keys', () => {
    const r = summarizeApiKeyRevokerRollup(
      'BANK_DEMO',
      [
        revokedEntry({
          key_id: 'k-1',
          revoked_by: 'admin',
          revoked_at: NOW,
          created_by: 'alice.admin',
        }),
        revokedEntry({
          key_id: 'k-2',
          revoked_by: 'admin',
          revoked_at: NOW,
          created_by: 'alice.admin',
        }),
        revokedEntry({
          key_id: 'k-3',
          revoked_by: 'admin',
          revoked_at: NOW,
          created_by: 'bob.maker',
        }),
      ],
      NOW,
    );
    const row = r.revokers[0];
    expect(row.total_revocations).toBe(3);
    expect(row.distinct_creators_revoked).toBe(2);
  });

  test('distinct_scopes_revoked union across revoked keys', () => {
    const r = summarizeApiKeyRevokerRollup(
      'BANK_DEMO',
      [
        revokedEntry({
          key_id: 'k-1',
          revoked_by: 'admin',
          revoked_at: NOW,
          scopes: ['alerts:read', 'cases:read'],
        }),
        revokedEntry({
          key_id: 'k-2',
          revoked_by: 'admin',
          revoked_at: NOW,
          scopes: ['cases:read', 'audit:read'],
        }),
      ],
      NOW,
    );
    const row = r.revokers[0];
    // Union: alerts:read, cases:read, audit:read → 3 distinct
    expect(row.distinct_scopes_revoked).toBe(3);
  });

  test('bogus scope defensively filtered out of union', () => {
    const entry = revokedEntry({
      key_id: 'k-1',
      revoked_by: 'admin',
      revoked_at: NOW,
      scopes: ['alerts:read'],
    });
    entry.scopes = ['alerts:read', 'bogus_scope' as ApiKeyScope];
    const r = summarizeApiKeyRevokerRollup('BANK_DEMO', [entry], NOW);
    expect(r.revokers[0].distinct_scopes_revoked).toBe(1);
  });

  test('first/last_revoked_at = min/max across revocations', () => {
    const earlier = new Date(NOW.getTime() - 5 * ONE_DAY_MS);
    const middle = new Date(NOW.getTime() - 2 * ONE_DAY_MS);
    const r = summarizeApiKeyRevokerRollup(
      'BANK_DEMO',
      [
        revokedEntry({ key_id: 'k-1', revoked_by: 'admin', revoked_at: middle }),
        revokedEntry({ key_id: 'k-2', revoked_by: 'admin', revoked_at: earlier }),
        revokedEntry({ key_id: 'k-3', revoked_by: 'admin', revoked_at: NOW }),
      ],
      NOW,
    );
    const row = r.revokers[0];
    expect(row.first_revoked_at).toBe(earlier.toISOString());
    expect(row.last_revoked_at).toBe(NOW.toISOString());
  });

  test('multiple revokers sorted total_revocations desc + username asc tie-break', () => {
    const r = summarizeApiKeyRevokerRollup(
      'BANK_DEMO',
      [
        revokedEntry({ key_id: 'k-1', revoked_by: 'alice', revoked_at: NOW }),
        revokedEntry({ key_id: 'k-2', revoked_by: 'alice', revoked_at: NOW }),
        revokedEntry({ key_id: 'k-3', revoked_by: 'alice', revoked_at: NOW }),
        revokedEntry({ key_id: 'k-4', revoked_by: 'bob', revoked_at: NOW }),
        revokedEntry({ key_id: 'k-5', revoked_by: 'zoe', revoked_at: NOW }),
        revokedEntry({ key_id: 'k-6', revoked_by: 'bob', revoked_at: NOW }),
      ],
      NOW,
    );
    // alice: 3, bob: 2, zoe: 1 → sort desc by count
    expect(r.revokers.map((row) => row.revoker_username)).toEqual([
      'alice',
      'bob',
      'zoe',
    ]);
  });

  test('username asc tie-break at tied count', () => {
    const r = summarizeApiKeyRevokerRollup(
      'BANK_DEMO',
      [
        revokedEntry({ key_id: 'k-1', revoked_by: 'zoe', revoked_at: NOW }),
        revokedEntry({ key_id: 'k-2', revoked_by: 'alice', revoked_at: NOW }),
        revokedEntry({ key_id: 'k-3', revoked_by: 'bob', revoked_at: NOW }),
      ],
      NOW,
    );
    // All tied at 1 → asc order
    expect(r.revokers.map((row) => row.revoker_username)).toEqual([
      'alice',
      'bob',
      'zoe',
    ]);
  });

  test('most_active_revoker is top row', () => {
    const r = summarizeApiKeyRevokerRollup(
      'BANK_DEMO',
      [
        revokedEntry({ key_id: 'k-1', revoked_by: 'alice', revoked_at: NOW }),
        revokedEntry({ key_id: 'k-2', revoked_by: 'alice', revoked_at: NOW }),
        revokedEntry({ key_id: 'k-3', revoked_by: 'bob', revoked_at: NOW }),
      ],
      NOW,
    );
    expect(r.most_active_revoker).toBe('alice');
  });

  test('key_ids sorted asc + cap KEY_IDS_CAP=50', () => {
    // 55 revocations by same revoker
    const entries: ApiKeyEntry[] = [];
    for (let i = 0; i < 55; i++) {
      entries.push(
        revokedEntry({
          key_id: `k-${String(i).padStart(3, '0')}`,
          revoked_by: 'admin',
          revoked_at: NOW,
        }),
      );
    }
    const r = summarizeApiKeyRevokerRollup('BANK_DEMO', entries, NOW);
    const row = r.revokers[0];
    expect(row.total_revocations).toBe(55);
    expect(row.key_ids).toHaveLength(KEY_IDS_CAP);
    // Verify sorted asc
    for (let i = 1; i < row.key_ids.length; i++) {
      expect(row.key_ids[i].localeCompare(row.key_ids[i - 1])).toBeGreaterThan(0);
    }
    // First 50 (asc: k-000..k-049)
    expect(row.key_ids[0]).toBe('k-000');
    expect(row.key_ids[49]).toBe('k-049');
  });

  test('cross-tenant filter via key.tenant_id (only requested tenant counted)', () => {
    const r = summarizeApiKeyRevokerRollup(
      'BANK_DEMO',
      [
        revokedEntry({
          key_id: 'k-1',
          revoked_by: 'admin',
          revoked_at: NOW,
          tenant_id: 'BANK_DEMO',
        }),
        revokedEntry({
          key_id: 'k-2',
          revoked_by: 'admin',
          revoked_at: NOW,
          tenant_id: 'BIL',
        }),
      ],
      NOW,
    );
    // Resolver doesn't filter by tenant — caller is responsible. The
    // resolver just takes the entries passed in. Verify it counts both.
    // (The route layer pre-filters by listing tenant-scoped entries.)
    expect(r.total_revocations).toBe(2);
  });

  test('mass_revocation_events surfaces burst > THRESHOLD within 1h', () => {
    // 6 revocations by alice in 10 minutes (well within 1h window)
    const entries: ApiKeyEntry[] = [];
    for (let i = 0; i < 6; i++) {
      entries.push(
        revokedEntry({
          key_id: `k-${i}`,
          revoked_by: 'alice',
          revoked_at: new Date(NOW.getTime() + i * 60 * 1000),
        }),
      );
    }
    const r = summarizeApiKeyRevokerRollup('BANK_DEMO', entries, NOW);
    expect(r.mass_revocation_events).toHaveLength(1);
    expect(r.mass_revocation_events[0].revoker_username).toBe('alice');
    expect(r.mass_revocation_events[0].count).toBe(6);
    expect(r.mass_revocation_events[0].sample_key_ids).toHaveLength(5);
  });

  test('no mass_revocation_event when count <= THRESHOLD', () => {
    // Exactly THRESHOLD revocations → not a burst (strict >)
    const entries: ApiKeyEntry[] = [];
    for (let i = 0; i < MASS_REVOCATION_THRESHOLD; i++) {
      entries.push(
        revokedEntry({
          key_id: `k-${i}`,
          revoked_by: 'alice',
          revoked_at: new Date(NOW.getTime() + i * 60 * 1000),
        }),
      );
    }
    const r = summarizeApiKeyRevokerRollup('BANK_DEMO', entries, NOW);
    expect(r.mass_revocation_events).toEqual([]);
  });

  test('no mass_revocation_event when revocations spread > window', () => {
    // 10 revocations spaced 2 hours apart (no 1h window catches > THRESHOLD)
    const entries: ApiKeyEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(
        revokedEntry({
          key_id: `k-${i}`,
          revoked_by: 'alice',
          revoked_at: new Date(NOW.getTime() + i * 2 * 60 * 60 * 1000),
        }),
      );
    }
    const r = summarizeApiKeyRevokerRollup('BANK_DEMO', entries, NOW);
    expect(r.mass_revocation_events).toEqual([]);
  });

  test('mass_revocation_event detects burst at boundary of window', () => {
    // 6 revocations spaced 11 minutes apart → 6 within 55-minute window
    const entries: ApiKeyEntry[] = [];
    for (let i = 0; i < 6; i++) {
      entries.push(
        revokedEntry({
          key_id: `k-${i}`,
          revoked_by: 'alice',
          revoked_at: new Date(NOW.getTime() + i * 11 * 60 * 1000),
        }),
      );
    }
    const r = summarizeApiKeyRevokerRollup('BANK_DEMO', entries, NOW);
    expect(r.mass_revocation_events).toHaveLength(1);
    expect(r.mass_revocation_events[0].count).toBe(6);
  });

  test('mass_revocation_events sorted count desc + username asc tie-break', () => {
    const entries: ApiKeyEntry[] = [];
    // alice: 7 burst
    for (let i = 0; i < 7; i++) {
      entries.push(
        revokedEntry({
          key_id: `a-${i}`,
          revoked_by: 'alice',
          revoked_at: new Date(NOW.getTime() + i * 60 * 1000),
        }),
      );
    }
    // bob: 6 burst
    for (let i = 0; i < 6; i++) {
      entries.push(
        revokedEntry({
          key_id: `b-${i}`,
          revoked_by: 'bob',
          revoked_at: new Date(NOW.getTime() + i * 60 * 1000),
        }),
      );
    }
    // zoe: 6 burst (tied with bob — bob comes first by username asc)
    for (let i = 0; i < 6; i++) {
      entries.push(
        revokedEntry({
          key_id: `z-${i}`,
          revoked_by: 'zoe',
          revoked_at: new Date(NOW.getTime() + i * 60 * 1000),
        }),
      );
    }
    const r = summarizeApiKeyRevokerRollup('BANK_DEMO', entries, NOW);
    // alice (7) > bob (6) > zoe (6, tied with bob by count → username asc)
    expect(r.mass_revocation_events.map((e) => e.revoker_username)).toEqual([
      'alice',
      'bob',
      'zoe',
    ]);
    expect(r.mass_revocation_events[0].count).toBe(7);
    expect(r.mass_revocation_events[1].count).toBe(6);
  });

  test('mass_revocation window_start + window_end mark the burst boundary', () => {
    const start = NOW;
    const entries: ApiKeyEntry[] = [];
    for (let i = 0; i < 6; i++) {
      entries.push(
        revokedEntry({
          key_id: `k-${i}`,
          revoked_by: 'alice',
          revoked_at: new Date(start.getTime() + i * 60 * 1000),
        }),
      );
    }
    const r = summarizeApiKeyRevokerRollup('BANK_DEMO', entries, NOW);
    expect(r.mass_revocation_events[0].window_start).toBe(start.toISOString());
    expect(r.mass_revocation_events[0].window_end).toBe(
      new Date(start.getTime() + 5 * 60 * 1000).toISOString(),
    );
  });

  test('partition: Σ revokers.total_revocations = total_revocations', () => {
    const r = summarizeApiKeyRevokerRollup(
      'BANK_DEMO',
      [
        revokedEntry({ key_id: 'k-1', revoked_by: 'alice', revoked_at: NOW }),
        revokedEntry({ key_id: 'k-2', revoked_by: 'bob', revoked_at: NOW }),
        revokedEntry({ key_id: 'k-3', revoked_by: 'alice', revoked_at: NOW }),
      ],
      NOW,
    );
    const sum = r.revokers.reduce((a, b) => a + b.total_revocations, 0);
    expect(sum).toBe(r.total_revocations);
    expect(sum).toBe(3);
  });

  test('rejects empty tenant_id', () => {
    expect(() =>
      summarizeApiKeyRevokerRollup('', [], NOW),
    ).toThrow(/tenant_id/);
  });

  test('exports constants', () => {
    expect(KEY_IDS_CAP).toBe(50);
    expect(MASS_REVOCATION_THRESHOLD).toBe(5);
    expect(MASS_REVOCATION_WINDOW_MS).toBe(60 * 60 * 1000);
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

describe('GET /v1/admin/api-keys/revoker-rollup', () => {
  test('admin happy path empty (BIL tenant for isolation)', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/api-keys/revoker-rollup')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.total_revocations).toBe(0);
    expect(r.body.body.most_active_revoker).toBeNull();
    expect(r.body.body.revokers).toEqual([]);
    expect(r.body.body.mass_revocation_events).toEqual([]);
  });

  test('403 when role lacks audit:read', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/api-keys/revoker-rollup')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/api-keys/revoker-rollup')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });

  test('populated reflects revoked key in store', async () => {
    const { app } = makeApp({});
    // Create + revoke a key against BIL tenant to isolate from other tests
    const created = defaultApiKeyStore.create(
      'BIL',
      {
        name: 'M1.17 revoker-rollup smoke',
        scopes: ['alerts:read', 'audit:read'],
      },
      'alice.admin',
      new Date(NOW.getTime() - ONE_DAY_MS),
    );
    defaultApiKeyStore.revoke('BIL', created.key_id, 'bob.security', NOW);

    const r = await request(app)
      .get('/v1/admin/api-keys/revoker-rollup')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.status).toBe(200);
    expect(r.body.body.total_revocations).toBeGreaterThanOrEqual(1);
    const bobRow = r.body.body.revokers.find(
      (row: { revoker_username: string }) => row.revoker_username === 'bob.security',
    );
    expect(bobRow).toBeDefined();
    expect(bobRow.distinct_scopes_revoked).toBeGreaterThanOrEqual(2);
  });

  test('route mounted BEFORE /:key_id wildcard (literal segment wins)', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/api-keys/revoker-rollup')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.status).toBe(200);
    expect(r.body.body.revokers).toBeDefined();
  });
});
