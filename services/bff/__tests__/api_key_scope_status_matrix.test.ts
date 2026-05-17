// services/bff/__tests__/api_key_scope_status_matrix.test.ts
//
// T6 M1.8 — API key scope × status cross-tab matrix.

import request from 'supertest';
import {
  buildApiKeyScopeStatusMatrix,
  ALL_API_KEY_STATUSES,
} from '../src/api_key_scope_status_matrix';
import {
  InMemoryApiKeyStore,
  VALID_SCOPES,
  type ApiKeyEntry,
} from '../src/api_keys';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeSsApp(role: string = 'admin') {
  const store = new InMemoryApiKeyStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    apiKeyStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

// ─── buildApiKeyScopeStatusMatrix — pure ─────────────────────────────

describe('M1.8 — empty input', () => {
  test('zero entries → every row × col at 0, peak null, leaderboards null', () => {
    const m = buildApiKeyScopeStatusMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.generated_at).toBe(NOW.toISOString());
    expect(m.total_keys).toBe(0);
    expect(m.total_dispatches).toBe(0);
    expect(m.total_active_dispatches).toBe(0);
    expect(m.total_revoked_dispatches).toBe(0);
    expect(m.rows.length).toBe(VALID_SCOPES.length);
    expect(m.columns.length).toBe(ALL_API_KEY_STATUSES.length);
    for (const row of m.rows) {
      expect(row.total).toBe(0);
      expect(row.by_status.active).toBe(0);
      expect(row.by_status.revoked).toBe(0);
    }
    expect(m.peak_cell).toBeNull();
    expect(m.most_distributed_scope).toBeNull();
    expect(m.empty_cells.length).toBe(VALID_SCOPES.length * ALL_API_KEY_STATUSES.length);
  });
});

describe('M1.8 — rows in canonical scope order', () => {
  test('rows[] follows VALID_SCOPES', () => {
    const m = buildApiKeyScopeStatusMatrix('BIL', [], NOW);
    expect(m.rows.map((r) => r.scope)).toEqual([...VALID_SCOPES]);
  });
});

describe('M1.8 — columns in canonical status order', () => {
  test('columns[] follows ALL_API_KEY_STATUSES (active → revoked)', () => {
    const m = buildApiKeyScopeStatusMatrix('BIL', [], NOW);
    expect(m.columns.map((c) => c.status)).toEqual([...ALL_API_KEY_STATUSES]);
  });
});

describe('M1.8 — single key single scope', () => {
  test('1 active key with audit:read → only that cell populated', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    const entries = store.list('BIL', 1, 100).items;
    const m = buildApiKeyScopeStatusMatrix('BIL', entries, NOW);
    expect(m.total_keys).toBe(1);
    expect(m.total_dispatches).toBe(1);
    const audit = m.rows.find((r) => r.scope === 'audit:read')!;
    expect(audit.by_status.active).toBe(1);
    expect(audit.by_status.revoked).toBe(0);
    expect(audit.total).toBe(1);
    const activeCol = m.columns.find((c) => c.status === 'active')!;
    expect(activeCol.by_scope['audit:read']).toBe(1);
    expect(activeCol.total).toBe(1);
    expect(m.peak_cell).toEqual({ scope: 'audit:read', status: 'active', count: 1 });
  });
});

describe('M1.8 — multi-scope key', () => {
  test('1 key with 3 scopes → contributes to 3 (scope, active) cells', () => {
    const store = new InMemoryApiKeyStore();
    store.create(
      'BIL',
      { name: 'wide', scopes: ['audit:read', 'cases:read', 'reports:read'] },
      'admin',
      NOW,
    );
    const entries = store.list('BIL', 1, 100).items;
    const m = buildApiKeyScopeStatusMatrix('BIL', entries, NOW);
    expect(m.total_keys).toBe(1);
    expect(m.total_dispatches).toBe(3);
    expect(m.rows.find((r) => r.scope === 'audit:read')!.by_status.active).toBe(1);
    expect(m.rows.find((r) => r.scope === 'cases:read')!.by_status.active).toBe(1);
    expect(m.rows.find((r) => r.scope === 'reports:read')!.by_status.active).toBe(1);
  });
});

describe('M1.8 — revoked keys', () => {
  test('revoked counted in revoked column, excluded from active', () => {
    const store = new InMemoryApiKeyStore();
    const c = store.create('BIL', { name: 'k1', scopes: ['audit:read'] }, 'admin', NOW);
    store.create('BIL', { name: 'k2', scopes: ['audit:read'] }, 'admin', NOW);
    store.revoke('BIL', c.key_id, 'admin', NOW);
    const entries = store.list('BIL', 1, 100).items;
    const m = buildApiKeyScopeStatusMatrix('BIL', entries, NOW);
    expect(m.total_keys).toBe(2);
    expect(m.total_dispatches).toBe(2);
    const audit = m.rows.find((r) => r.scope === 'audit:read')!;
    expect(audit.by_status.active).toBe(1);
    expect(audit.by_status.revoked).toBe(1);
    expect(audit.total).toBe(2);
    expect(m.total_active_dispatches).toBe(1);
    expect(m.total_revoked_dispatches).toBe(1);
  });
});

describe('M1.8 — partition invariants', () => {
  test('Σ by_status = row.total per row', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k1', scopes: ['audit:read', 'cases:read'] }, 'admin', NOW);
    const entries = store.list('BIL', 1, 100).items;
    const m = buildApiKeyScopeStatusMatrix('BIL', entries, NOW);
    for (const row of m.rows) {
      const sum = Object.values(row.by_status).reduce((a, b) => a + b, 0);
      expect(row.total).toBe(sum);
    }
  });

  test('Σ by_scope = col.total per col', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k1', scopes: ['audit:read', 'cases:read'] }, 'admin', NOW);
    const entries = store.list('BIL', 1, 100).items;
    const m = buildApiKeyScopeStatusMatrix('BIL', entries, NOW);
    for (const col of m.columns) {
      const sum = Object.values(col.by_scope).reduce((a, b) => a + b, 0);
      expect(col.total).toBe(sum);
    }
  });

  test('Σ rows.total = Σ cols.total = total_dispatches', () => {
    const store = new InMemoryApiKeyStore();
    store.create(
      'BIL',
      { name: 'k1', scopes: ['audit:read', 'cases:read', 'reports:read'] },
      'admin',
      NOW,
    );
    const c = store.create('BIL', { name: 'k2', scopes: ['audit:read'] }, 'admin', NOW);
    store.revoke('BIL', c.key_id, 'admin', NOW);
    const entries = store.list('BIL', 1, 100).items;
    const m = buildApiKeyScopeStatusMatrix('BIL', entries, NOW);
    const rowSum = m.rows.reduce((acc, r) => acc + r.total, 0);
    const colSum = m.columns.reduce((acc, c2) => acc + c2.total, 0);
    expect(rowSum).toBe(m.total_dispatches);
    expect(colSum).toBe(m.total_dispatches);
    expect(m.total_dispatches).toBe(4); // 3 from k1-active + 1 from k2-revoked
  });
});

describe('M1.8 — every-key-present invariants', () => {
  test('row.by_status has every ApiKeyStatus key', () => {
    const m = buildApiKeyScopeStatusMatrix('BIL', [], NOW);
    for (const row of m.rows) {
      for (const s of ALL_API_KEY_STATUSES) {
        expect(row.by_status).toHaveProperty(s);
        expect(typeof row.by_status[s]).toBe('number');
      }
    }
  });

  test('col.by_scope has every ApiKeyScope key', () => {
    const m = buildApiKeyScopeStatusMatrix('BIL', [], NOW);
    for (const col of m.columns) {
      for (const s of VALID_SCOPES) {
        expect(col.by_scope).toHaveProperty(s);
        expect(typeof col.by_scope[s]).toBe('number');
      }
    }
  });
});

describe('M1.8 — cell cross-check invariant', () => {
  test('row[scope].by_status[status] === col[status].by_scope[scope]', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k1', scopes: ['audit:read', 'cases:read'] }, 'admin', NOW);
    const c = store.create('BIL', { name: 'k2', scopes: ['reports:read'] }, 'admin', NOW);
    store.revoke('BIL', c.key_id, 'admin', NOW);
    const entries = store.list('BIL', 1, 100).items;
    const m = buildApiKeyScopeStatusMatrix('BIL', entries, NOW);
    for (const row of m.rows) {
      for (const col of m.columns) {
        expect(row.by_status[col.status]).toBe(col.by_scope[row.scope]);
      }
    }
  });
});

describe('M1.8 — statuses_without per row', () => {
  test('canonical status order; entries have by_status=0', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    const entries = store.list('BIL', 1, 100).items;
    const m = buildApiKeyScopeStatusMatrix('BIL', entries, NOW);
    const audit = m.rows.find((r) => r.scope === 'audit:read')!;
    expect(audit.statuses_without).toEqual(['revoked']);
  });
});

describe('M1.8 — scopes_without per column', () => {
  test('canonical scope order; entries have by_scope=0', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    const entries = store.list('BIL', 1, 100).items;
    const m = buildApiKeyScopeStatusMatrix('BIL', entries, NOW);
    const active = m.columns.find((c) => c.status === 'active')!;
    expect(active.scopes_without).toEqual(VALID_SCOPES.filter((s) => s !== 'audit:read'));
  });
});

describe('M1.8 — peak_cell formula', () => {
  test('points at highest-count cell', () => {
    const store = new InMemoryApiKeyStore();
    // 3 active keys with audit:read
    store.create('BIL', { name: 'k1', scopes: ['audit:read'] }, 'admin', NOW);
    store.create('BIL', { name: 'k2', scopes: ['audit:read'] }, 'admin', NOW);
    store.create('BIL', { name: 'k3', scopes: ['audit:read'] }, 'admin', NOW);
    // 1 active key with cases:read
    store.create('BIL', { name: 'k4', scopes: ['cases:read'] }, 'admin', NOW);
    const entries = store.list('BIL', 1, 100).items;
    const m = buildApiKeyScopeStatusMatrix('BIL', entries, NOW);
    expect(m.peak_cell).toEqual({ scope: 'audit:read', status: 'active', count: 3 });
  });

  test('null on empty', () => {
    const m = buildApiKeyScopeStatusMatrix('BIL', [], NOW);
    expect(m.peak_cell).toBeNull();
  });
});

describe('M1.8 — empty_cells', () => {
  test('every empty_cell has count=0 on both axes', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    const entries = store.list('BIL', 1, 100).items;
    const m = buildApiKeyScopeStatusMatrix('BIL', entries, NOW);
    for (const ec of m.empty_cells) {
      const row = m.rows.find((r) => r.scope === ec.scope)!;
      expect(row.by_status[ec.status]).toBe(0);
    }
  });

  test('canonical row-major order (scope asc index, then status asc index)', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    const entries = store.list('BIL', 1, 100).items;
    const m = buildApiKeyScopeStatusMatrix('BIL', entries, NOW);
    for (let i = 1; i < m.empty_cells.length; i++) {
      const prev = m.empty_cells[i - 1]!;
      const curr = m.empty_cells[i]!;
      const prevSIdx = VALID_SCOPES.indexOf(prev.scope);
      const currSIdx = VALID_SCOPES.indexOf(curr.scope);
      if (prevSIdx !== currSIdx) {
        expect(currSIdx).toBeGreaterThan(prevSIdx);
      } else {
        const prevStIdx = ALL_API_KEY_STATUSES.indexOf(prev.status);
        const currStIdx = ALL_API_KEY_STATUSES.indexOf(curr.status);
        expect(currStIdx).toBeGreaterThan(prevStIdx);
      }
    }
  });

  test('partition: empty + non_empty = 14 (7 scopes × 2 statuses)', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    const entries = store.list('BIL', 1, 100).items;
    const m = buildApiKeyScopeStatusMatrix('BIL', entries, NOW);
    const total_cells = VALID_SCOPES.length * ALL_API_KEY_STATUSES.length;
    let non_empty = 0;
    for (const row of m.rows) {
      for (const s of ALL_API_KEY_STATUSES) {
        if (row.by_status[s] > 0) non_empty++;
      }
    }
    expect(m.empty_cells.length + non_empty).toBe(total_cells);
  });
});

describe('M1.8 — most_distributed_scope', () => {
  test('points at scope with most distinct non-zero statuses', () => {
    const store = new InMemoryApiKeyStore();
    // audit:read has both statuses
    const c1 = store.create('BIL', { name: 'k1', scopes: ['audit:read'] }, 'admin', NOW);
    store.create('BIL', { name: 'k2', scopes: ['audit:read'] }, 'admin', NOW);
    store.revoke('BIL', c1.key_id, 'admin', NOW);
    // cases:read only has active
    store.create('BIL', { name: 'k3', scopes: ['cases:read'] }, 'admin', NOW);
    const entries = store.list('BIL', 1, 100).items;
    const m = buildApiKeyScopeStatusMatrix('BIL', entries, NOW);
    expect(m.most_distributed_scope!.scope).toBe('audit:read');
    expect(m.most_distributed_scope!.statuses_seen).toBe(2);
  });

  test('null on empty', () => {
    const m = buildApiKeyScopeStatusMatrix('BIL', [], NOW);
    expect(m.most_distributed_scope).toBeNull();
  });
});

describe('M1.8 — intra-key scope dedup defensive', () => {
  test('same scope listed twice in entry → counted once', () => {
    // Construct an entry directly (the store would reject duplicates,
    // but the resolver must defend against bad data).
    const entry: ApiKeyEntry = {
      key_id: 'k1',
      tenant_id: 'BIL',
      name: 'k',
      prefix: 'abc',
      scopes: ['audit:read', 'audit:read'],
      status: 'active',
      created_by: 'admin',
      created_at: NOW.toISOString(),
      expires_at: null,
      last_used_at: null,
      revoked_at: null,
      revoked_by: null,
    };
    const m = buildApiKeyScopeStatusMatrix('BIL', [entry], NOW);
    expect(m.total_dispatches).toBe(1);
    expect(m.rows.find((r) => r.scope === 'audit:read')!.by_status.active).toBe(1);
  });
});

describe('M1.8 — out-of-enum scope silently skipped', () => {
  test('bogus scope ignored', () => {
    const entry: ApiKeyEntry = {
      key_id: 'k1',
      tenant_id: 'BIL',
      name: 'k',
      prefix: 'abc',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scopes: ['unknown_scope' as any, 'audit:read'],
      status: 'active',
      created_by: 'admin',
      created_at: NOW.toISOString(),
      expires_at: null,
      last_used_at: null,
      revoked_at: null,
      revoked_by: null,
    };
    const m = buildApiKeyScopeStatusMatrix('BIL', [entry], NOW);
    expect(m.total_dispatches).toBe(1);
  });
});

// ─── GET /v1/admin/api-keys/scope-status-matrix ──────────────────────

describe('M1.8 — GET /v1/admin/api-keys/scope-status-matrix', () => {
  test('admin → 200 with empty matrix on fresh tenant', async () => {
    const { app } = makeSsApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/scope-status-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.total_keys).toBe(0);
    expect(r.body.body.rows.length).toBe(VALID_SCOPES.length);
    expect(r.body.body.columns.length).toBe(ALL_API_KEY_STATUSES.length);
  });

  test('populated matrix reflects created keys', async () => {
    const { app, store } = makeSsApp('admin');
    store.create(
      'BIL',
      { name: 'k1', scopes: ['audit:read', 'cases:read'] },
      'alice',
      NOW,
    );
    store.create('BIL', { name: 'k2', scopes: ['reports:read'] }, 'alice', NOW);
    const r = await request(app).get('/v1/admin/api-keys/scope-status-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(2);
    expect(r.body.body.total_dispatches).toBe(3);
    expect(r.body.body.peak_cell.status).toBe('active');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSsApp('case_owner');
    const r = await request(app).get('/v1/admin/api-keys/scope-status-matrix').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL keys invisible to BANK_DEMO', async () => {
    const { app, store } = makeSsApp('admin');
    store.create('BIL', { name: 'k1', scopes: ['audit:read'] }, 'alice', NOW);
    const bank = await request(app)
      .get('/v1/admin/api-keys/scope-status-matrix')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_keys).toBe(0);
  });

  test('literal `/scope-status-matrix` not captured by `:key_id` wildcard', async () => {
    const { app } = makeSsApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/scope-status-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('M1.5 /v1/admin/api-keys/scope-distribution still 200 (sibling regression)', async () => {
    const { app } = makeSsApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/scope-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
