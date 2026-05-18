// services/bff/__tests__/api_key_creator_scope_matrix.test.ts
//
// T6 M1.12 — API key creator × scope cross-tab matrix.

import request from 'supertest';
import { buildApiKeyCreatorScopeMatrix } from '../src/api_key_creator_scope_matrix';
import {
  InMemoryApiKeyStore,
  VALID_SCOPES,
  type ApiKeyEntry,
  type ApiKeyScope,
  type ApiKeyStore,
} from '../src/api_keys';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeMatrixApp(role: string = 'admin', apiKeyStore?: ApiKeyStore) {
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
    prefix: 'abcdef123456',
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

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M1.12 — empty input', () => {
  test('zero keys → empty rows + N cols at 0 + null peak (N=VALID_SCOPES.length)', () => {
    const s = buildApiKeyCreatorScopeMatrix('BIL', [], NOW);
    expect(s.total_active_keys).toBe(0);
    expect(s.total_creators).toBe(0);
    expect(s.total_scopes).toBe(VALID_SCOPES.length);
    expect(s.total_permissions).toBe(0);
    expect(s.rows).toEqual([]);
    expect(s.columns.length).toBe(VALID_SCOPES.length);
    for (const c of s.columns) {
      expect(c.total).toBe(0);
      expect(c.top_creators).toEqual([]);
      expect(c.distinct_creators).toBe(0);
    }
    expect(s.peak_cell).toBeNull();
    expect(s.broadest_grant_creator).toBeNull();
    // Empty input → every scope unused.
    expect(s.unused_scopes).toEqual([...VALID_SCOPES]);
  });
});

describe('M1.12 — canonical column order', () => {
  test('columns[] in canonical VALID_SCOPES order', () => {
    const s = buildApiKeyCreatorScopeMatrix('BIL', [], NOW);
    expect(s.columns.map((c) => c.scope)).toEqual([...VALID_SCOPES]);
  });
});

describe('M1.12 — single key single scope', () => {
  test('one alice/alerts:read key populates exactly one cell', () => {
    const s = buildApiKeyCreatorScopeMatrix('BIL', [key()], NOW);
    expect(s.total_active_keys).toBe(1);
    expect(s.total_creators).toBe(1);
    expect(s.total_permissions).toBe(1);
    expect(s.rows[0].by_scope['alerts:read']).toBe(1);
    expect(s.rows[0].by_scope['cases:read']).toBe(0);
    expect(s.rows[0].total_permissions).toBe(1);
    expect(s.rows[0].distinct_scopes).toBe(1);
    expect(s.rows[0].scopes_without).toHaveLength(VALID_SCOPES.length - 1);
    const alertsCol = s.columns.find((c) => c.scope === 'alerts:read')!;
    expect(alertsCol.total).toBe(1);
    expect(alertsCol.distinct_creators).toBe(1);
    expect(alertsCol.top_creators).toEqual([{ created_by: 'alice', count: 1 }]);
  });
});

describe('M1.12 — multi-scope key contributes to each scope', () => {
  test('one key with 3 scopes → 3 cell increments, 1 total_keys, 3 total_permissions', () => {
    const k = key({ scopes: ['alerts:read', 'cases:read', 'audit:read'] });
    const s = buildApiKeyCreatorScopeMatrix('BIL', [k], NOW);
    expect(s.total_active_keys).toBe(1);
    expect(s.total_permissions).toBe(3);
    const row = s.rows[0];
    expect(row.total_keys).toBe(1);
    expect(row.total_permissions).toBe(3);
    expect(row.distinct_scopes).toBe(3);
    expect(row.by_scope['alerts:read']).toBe(1);
    expect(row.by_scope['cases:read']).toBe(1);
    expect(row.by_scope['audit:read']).toBe(1);
    expect(row.by_scope['reports:read']).toBe(0);
  });
});

describe('M1.12 — revoked keys excluded', () => {
  test('only active keys count toward matrix', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'alice', status: 'active' }),
      key({
        key_id: 'k2',
        created_by: 'alice',
        status: 'revoked',
        revoked_at: NOW.toISOString(),
        revoked_by: 'admin',
      }),
    ];
    const s = buildApiKeyCreatorScopeMatrix('BIL', keys, NOW);
    expect(s.total_active_keys).toBe(1);
    expect(s.total_permissions).toBe(1);
    expect(s.rows[0].total_keys).toBe(1);
  });
});

describe('M1.12 — intra-key scope dedup', () => {
  test('same scope listed twice on a key counts once for that cell', () => {
    // Cast: VALID_SCOPES rejects duplicate elements at the type level but a
    // bad-data path could surface a duplicated scope; resolver must dedup.
    const k = key({
      scopes: ['alerts:read', 'alerts:read', 'cases:read'] as ApiKeyScope[],
    });
    const s = buildApiKeyCreatorScopeMatrix('BIL', [k], NOW);
    expect(s.rows[0].by_scope['alerts:read']).toBe(1);
    expect(s.rows[0].by_scope['cases:read']).toBe(1);
    expect(s.rows[0].total_permissions).toBe(2);
  });
});

describe('M1.12 — bogus scope filtered', () => {
  test('non-VALID_SCOPES values don\'t poison counts', () => {
    const k = key({
      scopes: ['alerts:read', 'bogus:scope' as ApiKeyScope, 'cases:read'],
    });
    const s = buildApiKeyCreatorScopeMatrix('BIL', [k], NOW);
    expect(s.total_permissions).toBe(2);
    expect(s.rows[0].by_scope['alerts:read']).toBe(1);
    expect(s.rows[0].by_scope['cases:read']).toBe(1);
  });
});

describe('M1.12 — multi-creator accumulation', () => {
  test('alice has 2 keys + bob has 1 key', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'alice', scopes: ['alerts:read'] }),
      key({ key_id: 'k2', created_by: 'alice', scopes: ['cases:read', 'alerts:read'] }),
      key({ key_id: 'k3', created_by: 'bob', scopes: ['audit:read'] }),
    ];
    const s = buildApiKeyCreatorScopeMatrix('BIL', keys, NOW);
    expect(s.total_creators).toBe(2);
    expect(s.total_active_keys).toBe(3);
    expect(s.total_permissions).toBe(4);
    const alice = s.rows.find((r) => r.created_by === 'alice')!;
    expect(alice.total_keys).toBe(2);
    expect(alice.by_scope['alerts:read']).toBe(2);
    expect(alice.by_scope['cases:read']).toBe(1);
    expect(alice.total_permissions).toBe(3);
    const bob = s.rows.find((r) => r.created_by === 'bob')!;
    expect(bob.total_keys).toBe(1);
    expect(bob.by_scope['audit:read']).toBe(1);
    expect(bob.total_permissions).toBe(1);
  });
});

describe('M1.12 — row sort order', () => {
  test('total_keys desc, created_by asc tie-break', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'zoe', scopes: ['alerts:read'] }),
      key({ key_id: 'k2', created_by: 'alice', scopes: ['alerts:read'] }),
      key({ key_id: 'k3', created_by: 'alice', scopes: ['cases:read'] }),
      key({ key_id: 'k4', created_by: 'bob', scopes: ['alerts:read'] }),
    ];
    const s = buildApiKeyCreatorScopeMatrix('BIL', keys, NOW);
    // alice (2) > bob (1) = zoe (1) → alice, bob, zoe (bob wins canonical tie)
    expect(s.rows.map((r) => r.created_by)).toEqual(['alice', 'bob', 'zoe']);
  });
});

describe('M1.12 — partition invariants', () => {
  test('Σ row.total_keys = total_active_keys', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'alice' }),
      key({ key_id: 'k2', created_by: 'bob' }),
    ];
    const s = buildApiKeyCreatorScopeMatrix('BIL', keys, NOW);
    const sum = s.rows.reduce((acc, r) => acc + r.total_keys, 0);
    expect(sum).toBe(s.total_active_keys);
  });

  test('Σ row.by_scope (per row) = row.total_permissions', () => {
    const k = key({ scopes: ['alerts:read', 'cases:read', 'audit:read'] });
    const s = buildApiKeyCreatorScopeMatrix('BIL', [k], NOW);
    const row = s.rows[0];
    const sum = VALID_SCOPES.reduce((acc, scope) => acc + row.by_scope[scope], 0);
    expect(sum).toBe(row.total_permissions);
  });

  test('Σ col.total = total_permissions = Σ row.total_permissions', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'alice', scopes: ['alerts:read', 'cases:read'] }),
      key({ key_id: 'k2', created_by: 'bob', scopes: ['audit:read'] }),
    ];
    const s = buildApiKeyCreatorScopeMatrix('BIL', keys, NOW);
    const sumCols = s.columns.reduce((acc, c) => acc + c.total, 0);
    const sumRows = s.rows.reduce((acc, r) => acc + r.total_permissions, 0);
    expect(sumCols).toBe(s.total_permissions);
    expect(sumRows).toBe(s.total_permissions);
  });

  test('cell cross-check: row[creator].by_scope[scope] = col[scope].top_creators[creator]', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'alice', scopes: ['alerts:read'] }),
      key({ key_id: 'k2', created_by: 'alice', scopes: ['alerts:read', 'cases:read'] }),
      key({ key_id: 'k3', created_by: 'bob', scopes: ['alerts:read'] }),
    ];
    const s = buildApiKeyCreatorScopeMatrix('BIL', keys, NOW);
    const alertsCol = s.columns.find((c) => c.scope === 'alerts:read')!;
    const aliceTop = alertsCol.top_creators.find((t) => t.created_by === 'alice')!;
    const aliceRow = s.rows.find((r) => r.created_by === 'alice')!;
    expect(aliceRow.by_scope['alerts:read']).toBe(aliceTop.count);
    expect(aliceTop.count).toBe(2);
  });
});

describe('M1.12 — peak_cell', () => {
  test('finds highest cell across matrix', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'alice', scopes: ['alerts:read'] }),
      key({ key_id: 'k2', created_by: 'alice', scopes: ['alerts:read'] }),
      key({ key_id: 'k3', created_by: 'alice', scopes: ['alerts:read'] }),
      key({ key_id: 'k4', created_by: 'bob', scopes: ['cases:read'] }),
    ];
    const s = buildApiKeyCreatorScopeMatrix('BIL', keys, NOW);
    expect(s.peak_cell?.created_by).toBe('alice');
    expect(s.peak_cell?.scope).toBe('alerts:read');
    expect(s.peak_cell?.count).toBe(3);
  });

  test('null on empty', () => {
    const s = buildApiKeyCreatorScopeMatrix('BIL', [], NOW);
    expect(s.peak_cell).toBeNull();
  });

  test('tie-break by row order then canonical scope', () => {
    // alice (3 keys, total) and bob (3 keys, total) — alice wins username asc.
    // Within alice both alerts:read and cases:read have count 1 → alerts:read
    // wins canonical scope order.
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'alice', scopes: ['alerts:read'] }),
      key({ key_id: 'k2', created_by: 'alice', scopes: ['cases:read'] }),
      key({ key_id: 'k3', created_by: 'alice', scopes: ['audit:read'] }),
      key({ key_id: 'k4', created_by: 'bob', scopes: ['alerts:read'] }),
      key({ key_id: 'k5', created_by: 'bob', scopes: ['cases:read'] }),
      key({ key_id: 'k6', created_by: 'bob', scopes: ['audit:read'] }),
    ];
    const s = buildApiKeyCreatorScopeMatrix('BIL', keys, NOW);
    expect(s.peak_cell?.created_by).toBe('alice');
    expect(s.peak_cell?.scope).toBe('alerts:read');
    expect(s.peak_cell?.count).toBe(1);
  });
});

describe('M1.12 — broadest_grant_creator', () => {
  test('creator with most total_permissions wins', () => {
    const keys: ApiKeyEntry[] = [
      // alice has 1 key with 3 scopes = 3 permissions
      key({
        key_id: 'k1',
        created_by: 'alice',
        scopes: ['alerts:read', 'cases:read', 'audit:read'],
      }),
      // bob has 2 keys with 1 scope each = 2 permissions
      key({ key_id: 'k2', created_by: 'bob', scopes: ['alerts:read'] }),
      key({ key_id: 'k3', created_by: 'bob', scopes: ['cases:read'] }),
    ];
    const s = buildApiKeyCreatorScopeMatrix('BIL', keys, NOW);
    // bob has 2 total_keys (more than alice's 1) so rows[0]=bob, but alice
    // has more permissions — broadest_grant_creator picks by permissions.
    expect(s.broadest_grant_creator).toBe('alice');
  });

  test('null on empty input', () => {
    const s = buildApiKeyCreatorScopeMatrix('BIL', [], NOW);
    expect(s.broadest_grant_creator).toBeNull();
  });

  test('canonical username asc tie-break on equal permissions', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'bob', scopes: ['alerts:read'] }),
      key({ key_id: 'k2', created_by: 'alice', scopes: ['cases:read'] }),
    ];
    const s = buildApiKeyCreatorScopeMatrix('BIL', keys, NOW);
    expect(s.broadest_grant_creator).toBe('alice');
  });
});

describe('M1.12 — unused_scopes envelope', () => {
  test('scopes never carried surface in canonical order', () => {
    const keys: ApiKeyEntry[] = [
      key({ scopes: ['alerts:read'] }),
      key({ scopes: ['cases:read'] }),
    ];
    const s = buildApiKeyCreatorScopeMatrix('BIL', keys, NOW);
    // Expected used: alerts:read, cases:read. Unused: rest in canonical order.
    expect(s.unused_scopes).toEqual(
      VALID_SCOPES.filter((s) => s !== 'alerts:read' && s !== 'cases:read'),
    );
  });

  test('empty when every scope present', () => {
    const keys: ApiKeyEntry[] = VALID_SCOPES.map((s, i) =>
      key({ key_id: `k${i}`, scopes: [s] }),
    );
    const matrix = buildApiKeyCreatorScopeMatrix('BIL', keys, NOW);
    expect(matrix.unused_scopes).toEqual([]);
  });
});

describe('M1.12 — top_creators cap 10', () => {
  test('column carries at most 10 creators', () => {
    const keys: ApiKeyEntry[] = [];
    for (let i = 0; i < 15; i++) {
      keys.push(
        key({
          key_id: `k${i}`,
          created_by: `user-${String(i).padStart(2, '0')}`,
          scopes: ['alerts:read'],
        }),
      );
    }
    const s = buildApiKeyCreatorScopeMatrix('BIL', keys, NOW);
    const col = s.columns.find((c) => c.scope === 'alerts:read')!;
    expect(col.distinct_creators).toBe(15);
    expect(col.top_creators.length).toBe(10);
  });
});

describe('M1.12 — null created_by defensively skipped', () => {
  test('key with empty created_by not counted', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: '' }),
      key({ key_id: 'k2', created_by: 'alice' }),
    ];
    const s = buildApiKeyCreatorScopeMatrix('BIL', keys, NOW);
    expect(s.total_active_keys).toBe(1);
    expect(s.total_creators).toBe(1);
  });
});

describe('M1.12 — tenant_id + generated_at echo', () => {
  test('envelope echoes', () => {
    const s = buildApiKeyCreatorScopeMatrix('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M1.12 — GET /v1/admin/api-keys/creator-scope-matrix', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeMatrixApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/creator-scope-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_active_keys).toBe(0);
    expect(r.body.body.columns.length).toBe(VALID_SCOPES.length);
    expect(r.body.body.rows).toEqual([]);
    expect(r.body.body.broadest_grant_creator).toBeNull();
  });

  test('populated → reflects keys with multi-scope counts', async () => {
    const store = new InMemoryApiKeyStore();
    store.create(
      'BIL',
      { name: 'Alice Key', scopes: ['alerts:read', 'cases:read'] },
      'alice',
      NOW,
    );
    store.create(
      'BIL',
      { name: 'Bob Key', scopes: ['audit:read'] },
      'bob',
      NOW,
    );
    const { app } = makeMatrixApp('admin', store);
    const r = await request(app)
      .get('/v1/admin/api-keys/creator-scope-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_active_keys).toBe(2);
    expect(r.body.body.total_creators).toBe(2);
    expect(r.body.body.total_permissions).toBe(3);
    // alice has 1 key with 2 scopes → broader grant than bob
    expect(r.body.body.broadest_grant_creator).toBe('alice');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeMatrixApp('case_owner');
    const r = await request(app)
      .get('/v1/admin/api-keys/creator-scope-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'BIL Key', scopes: ['alerts:read'] }, 'alice', NOW);
    const { app } = makeMatrixApp('admin', store);
    const bankR = await request(app)
      .get('/v1/admin/api-keys/creator-scope-matrix')
      .set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.total_active_keys).toBe(0);
  });

  test('M1.11 /v1/admin/api-keys/creator-lifecycle-matrix sibling regression still 200', async () => {
    const { app } = makeMatrixApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/creator-lifecycle-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('literal `/creator-scope-matrix` not captured by `:key_id` wildcard', async () => {
    const { app } = makeMatrixApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/creator-scope-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.rows).toBeDefined();
  });
});
