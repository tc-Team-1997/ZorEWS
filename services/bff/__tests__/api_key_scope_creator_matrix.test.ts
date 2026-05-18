// services/bff/__tests__/api_key_scope_creator_matrix.test.ts
//
// T6 M1.12 — API key scope × creator cross-tab matrix.

import request from 'supertest';
import { buildApiKeyScopeCreatorMatrix } from '../src/api_key_scope_creator_matrix';
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
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeScApp(role: string = 'admin', apiKeyStore?: ApiKeyStore) {
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

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M1.12 — empty input', () => {
  test('zero keys → N zero rows + empty columns + null peak (N=VALID_SCOPES.length)', () => {
    const s = buildApiKeyScopeCreatorMatrix('BIL', [], NOW);
    expect(s.total_keys).toBe(0);
    expect(s.total_creators).toBe(0);
    expect(s.total_scopes).toBe(VALID_SCOPES.length);
    expect(s.total_bindings).toBe(0);
    expect(s.rows.length).toBe(VALID_SCOPES.length);
    for (const r of s.rows) {
      expect(r.total_bindings).toBe(0);
      expect(r.distinct_creators).toBe(0);
      expect(r.top_creators).toEqual([]);
    }
    expect(s.columns).toEqual([]);
    expect(s.peak_cell).toBeNull();
    expect(s.most_versatile_creator).toBeNull();
    expect(s.unused_scopes).toEqual([...VALID_SCOPES]);
  });
});

describe('M1.12 — canonical row order', () => {
  test('rows[] in canonical VALID_SCOPES order', () => {
    const s = buildApiKeyScopeCreatorMatrix('BIL', [], NOW);
    expect(s.rows.map((r) => r.scope)).toEqual([...VALID_SCOPES]);
  });
});

describe('M1.12 — single key single scope', () => {
  test('alice with 1 key [alerts:read] → 1 binding in alerts:read row', () => {
    const k = key({ created_by: 'alice', scopes: ['alerts:read'] });
    const s = buildApiKeyScopeCreatorMatrix('BIL', [k], NOW);
    expect(s.total_keys).toBe(1);
    expect(s.total_bindings).toBe(1);
    expect(s.total_creators).toBe(1);
    const alertsRow = s.rows.find((r) => r.scope === 'alerts:read')!;
    expect(alertsRow.total_bindings).toBe(1);
    expect(alertsRow.by_creator.alice).toBe(1);
    expect(alertsRow.top_creators[0]).toEqual({ created_by: 'alice', count: 1 });
  });
});

describe('M1.12 — multi-scope single key', () => {
  test('1 key with 3 scopes → 3 bindings (one per scope)', () => {
    const k = key({
      created_by: 'alice',
      scopes: ['alerts:read', 'cases:read', 'audit:read'],
    });
    const s = buildApiKeyScopeCreatorMatrix('BIL', [k], NOW);
    expect(s.total_keys).toBe(1);
    expect(s.total_bindings).toBe(3);
    expect(s.columns[0].total_bindings).toBe(3);
    expect(s.columns[0].distinct_scopes).toBe(3);
  });
});

describe('M1.12 — intra-key scope dedup', () => {
  test('key with [alerts:read, alerts:read] → 1 binding (deduped)', () => {
    const k = key({
      created_by: 'alice',
      scopes: ['alerts:read', 'alerts:read'] as never,
    });
    const s = buildApiKeyScopeCreatorMatrix('BIL', [k], NOW);
    expect(s.total_bindings).toBe(1);
    const alertsRow = s.rows.find((r) => r.scope === 'alerts:read')!;
    expect(alertsRow.by_creator.alice).toBe(1);
  });
});

describe('M1.12 — multi-creator cohort', () => {
  test('alice 5 bindings + bob 2 → alice column first', () => {
    const k1 = key({
      key_id: 'k1',
      created_by: 'alice',
      scopes: ['alerts:read', 'cases:read', 'audit:read'],
    });
    const k2 = key({
      key_id: 'k2',
      created_by: 'alice',
      scopes: ['reports:read', 'notifications:send'],
    });
    const k3 = key({
      key_id: 'k3',
      created_by: 'bob',
      scopes: ['alerts:read', 'webhooks:dispatch'],
    });
    const s = buildApiKeyScopeCreatorMatrix('BIL', [k1, k2, k3], NOW);
    expect(s.columns[0].created_by).toBe('alice');
    expect(s.columns[0].total_bindings).toBe(5);
    expect(s.columns[1].created_by).toBe('bob');
    expect(s.columns[1].total_bindings).toBe(2);
  });

  test('canonical username asc tie-break at tied bindings', () => {
    const k1 = key({ key_id: 'k1', created_by: 'zoe', scopes: ['alerts:read'] });
    const k2 = key({ key_id: 'k2', created_by: 'alice', scopes: ['alerts:read'] });
    const s = buildApiKeyScopeCreatorMatrix('BIL', [k1, k2], NOW);
    expect(s.columns[0].created_by).toBe('alice');
  });
});

describe('M1.12 — every by_scope key present', () => {
  test('col.by_scope carries all VALID_SCOPES keys', () => {
    const k = key({ created_by: 'alice', scopes: ['alerts:read'] });
    const s = buildApiKeyScopeCreatorMatrix('BIL', [k], NOW);
    const col = s.columns[0];
    for (const scope of VALID_SCOPES) {
      expect(col.by_scope[scope]).toBeGreaterThanOrEqual(0);
    }
    expect(Object.keys(col.by_scope).length).toBe(VALID_SCOPES.length);
  });
});

describe('M1.12 — scopes_without per column', () => {
  test('alice using only alerts:read → other VALID_SCOPES.length-1 scopes in scopes_without', () => {
    const k = key({ created_by: 'alice', scopes: ['alerts:read'] });
    const s = buildApiKeyScopeCreatorMatrix('BIL', [k], NOW);
    const col = s.columns[0];
    expect(col.scopes_without.length).toBe(VALID_SCOPES.length - 1);
    expect(col.scopes_without).not.toContain('alerts:read');
  });
});

describe('M1.12 — per-row rollup', () => {
  test('alerts:read row aggregates across creators', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'alice', scopes: ['alerts:read'] }),
      key({ key_id: 'k2', created_by: 'alice', scopes: ['alerts:read'] }),
      key({ key_id: 'k3', created_by: 'bob', scopes: ['alerts:read'] }),
    ];
    const s = buildApiKeyScopeCreatorMatrix('BIL', keys, NOW);
    const row = s.rows.find((r) => r.scope === 'alerts:read')!;
    expect(row.total_bindings).toBe(3);
    expect(row.distinct_creators).toBe(2);
    expect(row.by_creator.alice).toBe(2);
    expect(row.by_creator.bob).toBe(1);
    expect(row.top_creators).toEqual([
      { created_by: 'alice', count: 2 },
      { created_by: 'bob', count: 1 },
    ]);
  });

  test('top_creators cap 3', () => {
    const keys: ApiKeyEntry[] = [];
    for (let i = 0; i < 5; i++) {
      keys.push(
        key({
          key_id: `k${i}`,
          created_by: `user-${String(i).padStart(2, '0')}`,
          scopes: ['alerts:read'],
        }),
      );
    }
    const s = buildApiKeyScopeCreatorMatrix('BIL', keys, NOW);
    const row = s.rows.find((r) => r.scope === 'alerts:read')!;
    expect(row.distinct_creators).toBe(5);
    expect(row.top_creators.length).toBe(3);
  });
});

describe('M1.12 — peak_cell', () => {
  test('finds highest cell across matrix', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'alice', scopes: ['alerts:read'] }),
      key({ key_id: 'k2', created_by: 'alice', scopes: ['alerts:read'] }),
      key({ key_id: 'k3', created_by: 'alice', scopes: ['alerts:read'] }),
      key({ key_id: 'k4', created_by: 'bob', scopes: ['audit:read'] }),
    ];
    const s = buildApiKeyScopeCreatorMatrix('BIL', keys, NOW);
    expect(s.peak_cell?.scope).toBe('alerts:read');
    expect(s.peak_cell?.created_by).toBe('alice');
    expect(s.peak_cell?.count).toBe(3);
  });

  test('null on empty', () => {
    const s = buildApiKeyScopeCreatorMatrix('BIL', [], NOW);
    expect(s.peak_cell).toBeNull();
  });
});

describe('M1.12 — most_versatile_creator', () => {
  test('creator with most distinct scopes wins', () => {
    const keys: ApiKeyEntry[] = [
      // alice has 3 distinct scopes
      key({
        key_id: 'k1',
        created_by: 'alice',
        scopes: ['alerts:read', 'cases:read', 'audit:read'],
      }),
      // bob has 1 scope (but 2 bindings)
      key({ key_id: 'k2', created_by: 'bob', scopes: ['alerts:read'] }),
      key({ key_id: 'k3', created_by: 'bob', scopes: ['alerts:read'] }),
    ];
    const s = buildApiKeyScopeCreatorMatrix('BIL', keys, NOW);
    expect(s.most_versatile_creator).toBe('alice');
  });

  test('canonical username asc tie-break', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'zoe', scopes: ['alerts:read'] }),
      key({ key_id: 'k2', created_by: 'alice', scopes: ['cases:read'] }),
    ];
    const s = buildApiKeyScopeCreatorMatrix('BIL', keys, NOW);
    expect(s.most_versatile_creator).toBe('alice');
  });

  test('null on empty', () => {
    const s = buildApiKeyScopeCreatorMatrix('BIL', [], NOW);
    expect(s.most_versatile_creator).toBeNull();
  });
});

describe('M1.12 — unused_scopes', () => {
  test('zero-binding scopes surface in canonical order', () => {
    const k = key({ created_by: 'alice', scopes: ['alerts:read'] });
    const s = buildApiKeyScopeCreatorMatrix('BIL', [k], NOW);
    expect(s.unused_scopes.length).toBe(VALID_SCOPES.length - 1);
    expect(s.unused_scopes).not.toContain('alerts:read');
    // canonical order — first is cases:read
    expect(s.unused_scopes[0]).toBe('cases:read');
  });

  test('empty when all scopes covered', () => {
    const k = key({ created_by: 'alice', scopes: [...VALID_SCOPES] });
    const s = buildApiKeyScopeCreatorMatrix('BIL', [k], NOW);
    expect(s.unused_scopes).toEqual([]);
  });
});

describe('M1.12 — partition invariants', () => {
  test('Σ row.total_bindings = total_bindings', () => {
    const k1 = key({
      key_id: 'k1',
      created_by: 'alice',
      scopes: ['alerts:read', 'cases:read'],
    });
    const k2 = key({ key_id: 'k2', created_by: 'bob', scopes: ['audit:read'] });
    const s = buildApiKeyScopeCreatorMatrix('BIL', [k1, k2], NOW);
    const sum = s.rows.reduce((acc, r) => acc + r.total_bindings, 0);
    expect(sum).toBe(s.total_bindings);
  });

  test('Σ col.total_bindings = total_bindings', () => {
    const k1 = key({
      key_id: 'k1',
      created_by: 'alice',
      scopes: ['alerts:read', 'cases:read'],
    });
    const k2 = key({ key_id: 'k2', created_by: 'bob', scopes: ['audit:read'] });
    const s = buildApiKeyScopeCreatorMatrix('BIL', [k1, k2], NOW);
    const sum = s.columns.reduce((acc, c) => acc + c.total_bindings, 0);
    expect(sum).toBe(s.total_bindings);
  });

  test('cell cross-check: row.by_creator[creator] === col.by_scope[scope]', () => {
    const k = key({
      created_by: 'alice',
      scopes: ['alerts:read', 'audit:read'],
    });
    const s = buildApiKeyScopeCreatorMatrix('BIL', [k], NOW);
    const alertsRow = s.rows.find((r) => r.scope === 'alerts:read')!;
    const aliceCol = s.columns.find((c) => c.created_by === 'alice')!;
    expect(alertsRow.by_creator.alice).toBe(aliceCol.by_scope['alerts:read']);
  });

  test('Σ col.by_scope per col = col.total_bindings', () => {
    const k = key({
      created_by: 'alice',
      scopes: ['alerts:read', 'audit:read'],
    });
    const s = buildApiKeyScopeCreatorMatrix('BIL', [k], NOW);
    const col = s.columns[0];
    const sum = VALID_SCOPES.reduce((acc, sc) => acc + col.by_scope[sc], 0);
    expect(sum).toBe(col.total_bindings);
  });
});

describe('M1.12 — defensive empty created_by', () => {
  test('key with empty created_by not counted', () => {
    const k1 = key({ created_by: '', scopes: ['alerts:read'] });
    const k2 = key({ created_by: 'alice', scopes: ['alerts:read'] });
    const s = buildApiKeyScopeCreatorMatrix('BIL', [k1, k2], NOW);
    expect(s.total_keys).toBe(1);
    expect(s.total_creators).toBe(1);
  });
});

describe('M1.12 — defensive out-of-enum scopes', () => {
  test('non-VALID_SCOPES values silently filtered', () => {
    const k = key({
      created_by: 'alice',
      scopes: ['alerts:read', 'bogus:scope' as never],
    });
    const s = buildApiKeyScopeCreatorMatrix('BIL', [k], NOW);
    expect(s.total_bindings).toBe(1);
  });
});

describe('M1.12 — tenant_id + generated_at echo', () => {
  test('envelope echoes', () => {
    const s = buildApiKeyScopeCreatorMatrix('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M1.12 — GET /v1/admin/api-keys/scope-creator-matrix', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeScApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/scope-creator-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(0);
    expect(r.body.body.rows.length).toBe(VALID_SCOPES.length);
    expect(r.body.body.columns).toEqual([]);
  });

  test('populated → reflects keys', async () => {
    const store = new InMemoryApiKeyStore();
    store.create(
      'BIL',
      { name: 'Alice Key', scopes: ['alerts:read', 'audit:read'] },
      'alice',
      NOW,
    );
    store.create(
      'BIL',
      { name: 'Bob Key', scopes: ['cases:read'] },
      'bob',
      NOW,
    );
    const { app } = makeScApp('admin', store);
    const r = await request(app)
      .get('/v1/admin/api-keys/scope-creator-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(2);
    expect(r.body.body.total_bindings).toBe(3);
    expect(r.body.body.most_versatile_creator).toBe('alice');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeScApp('case_owner');
    const r = await request(app)
      .get('/v1/admin/api-keys/scope-creator-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'BIL Key', scopes: ['alerts:read'] }, 'alice', NOW);
    const { app } = makeScApp('admin', store);
    const bankR = await request(app)
      .get('/v1/admin/api-keys/scope-creator-matrix')
      .set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.total_keys).toBe(0);
  });

  test('M1.11 /v1/admin/api-keys/creator-lifecycle-matrix sibling regression still 200', async () => {
    const { app } = makeScApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/creator-lifecycle-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('literal `/scope-creator-matrix` not captured by `:key_id` wildcard', async () => {
    const { app } = makeScApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/scope-creator-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.rows).toBeDefined();
  });
});
