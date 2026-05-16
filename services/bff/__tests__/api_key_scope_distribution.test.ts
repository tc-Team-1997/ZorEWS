// services/bff/__tests__/api_key_scope_distribution.test.ts
//
// T6 M1.5 — Service-account API key scope distribution rollup.

import request from 'supertest';
import { summarizeApiKeyScopeDistribution } from '../src/api_key_scope_distribution';
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

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function daysBack(d: number): Date {
  return new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
}

function makeScopeApp(role: string = 'admin') {
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

// ─── summarizeApiKeyScopeDistribution — pure ─────────────────────────

describe('M1.5 — empty input', () => {
  test('zero entries → every scope key emitted at 0', () => {
    const s = summarizeApiKeyScopeDistribution('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_keys).toBe(0);
    expect(s.total_active_keys).toBe(0);
    expect(s.total_revoked_keys).toBe(0);
    expect(s.scopes.length).toBe(VALID_SCOPES.length);
    for (const row of s.scopes) {
      expect(row.total_keys).toBe(0);
      expect(row.active_keys).toBe(0);
      expect(row.revoked_keys).toBe(0);
      expect(row.ever_used_count).toBe(0);
      expect(row.latest_active_created_at).toBeNull();
      expect(row.most_recently_used_key_id).toBeNull();
      expect(row.most_recently_used_at).toBeNull();
    }
    expect(s.most_used_scope).toBeNull();
    expect(s.unused_scopes).toEqual([...VALID_SCOPES]);
    expect(s.scope_coverage_rate).toBe(0);
  });
});

describe('M1.5 — canonical scope order', () => {
  test('scopes[] order matches VALID_SCOPES', () => {
    const s = summarizeApiKeyScopeDistribution('BIL', [], NOW);
    expect(s.scopes.map((r) => r.scope)).toEqual([...VALID_SCOPES]);
  });
});

describe('M1.5 — single key single scope', () => {
  test('one active key with audit:read → only that row populated', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', daysBack(5));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    const row = s.scopes.find((r) => r.scope === 'audit:read')!;
    expect(row.total_keys).toBe(1);
    expect(row.active_keys).toBe(1);
    expect(row.revoked_keys).toBe(0);
    expect(row.ever_used_count).toBe(0);
    expect(row.latest_active_created_at).toBe(daysBack(5).toISOString());

    const other = s.scopes.find((r) => r.scope === 'alerts:read')!;
    expect(other.total_keys).toBe(0);
    expect(other.active_keys).toBe(0);
  });
});

describe('M1.5 — multi-scope key', () => {
  test('one key with 3 scopes contributes to each row', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'wide', scopes: ['audit:read', 'cases:read', 'reports:read'] }, 'admin', daysBack(2));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    expect(s.scopes.find((r) => r.scope === 'audit:read')!.active_keys).toBe(1);
    expect(s.scopes.find((r) => r.scope === 'cases:read')!.active_keys).toBe(1);
    expect(s.scopes.find((r) => r.scope === 'reports:read')!.active_keys).toBe(1);
    expect(s.scopes.find((r) => r.scope === 'alerts:read')!.active_keys).toBe(0);
  });
});

describe('M1.5 — revoked keys', () => {
  test('revoked counted in revoked_keys + excluded from active_keys', () => {
    const store = new InMemoryApiKeyStore();
    const c = store.create('BIL', { name: 'k1', scopes: ['audit:read'] }, 'admin', daysBack(5));
    store.create('BIL', { name: 'k2', scopes: ['audit:read'] }, 'admin', daysBack(3));
    store.revoke('BIL', c.key_id, 'admin', daysBack(1));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    const row = s.scopes.find((r) => r.scope === 'audit:read')!;
    expect(row.total_keys).toBe(2);
    expect(row.active_keys).toBe(1);
    expect(row.revoked_keys).toBe(1);
    expect(s.total_active_keys).toBe(1);
    expect(s.total_revoked_keys).toBe(1);
  });
});

describe('M1.5 — ever_used_count counts only active keys', () => {
  test('used active keys bump ever_used_count; used-then-revoked does not', () => {
    const store = new InMemoryApiKeyStore();
    const cA = store.create('BIL', { name: 'used-active', scopes: ['audit:read'] }, 'admin', daysBack(10));
    store.touch('BIL', cA.key_id, daysBack(2));
    const cB = store.create('BIL', { name: 'used-revoked', scopes: ['audit:read'] }, 'admin', daysBack(10));
    store.touch('BIL', cB.key_id, daysBack(2));
    store.revoke('BIL', cB.key_id, 'admin', daysBack(1));
    store.create('BIL', { name: 'never-used', scopes: ['audit:read'] }, 'admin', daysBack(5));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    const row = s.scopes.find((r) => r.scope === 'audit:read')!;
    // 3 active rows? No — cB was revoked, so 2 active total.
    expect(row.active_keys).toBe(2);
    // ever_used_count: only the still-active key with last_used_at != null counts.
    expect(row.ever_used_count).toBe(1);
  });
});

describe('M1.5 — latest_active_created_at', () => {
  test('takes the newest created_at across active keys with this scope', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'old', scopes: ['audit:read'] }, 'admin', daysBack(20));
    store.create('BIL', { name: 'mid', scopes: ['audit:read'] }, 'admin', daysBack(10));
    store.create('BIL', { name: 'newest', scopes: ['audit:read'] }, 'admin', daysBack(2));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    const row = s.scopes.find((r) => r.scope === 'audit:read')!;
    expect(row.latest_active_created_at).toBe(daysBack(2).toISOString());
  });

  test('null when no active key has this scope (all revoked)', () => {
    const store = new InMemoryApiKeyStore();
    const c = store.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', daysBack(5));
    store.revoke('BIL', c.key_id, 'admin', daysBack(1));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    const row = s.scopes.find((r) => r.scope === 'audit:read')!;
    expect(row.latest_active_created_at).toBeNull();
    expect(row.total_keys).toBe(1);
    expect(row.active_keys).toBe(0);
  });
});

describe('M1.5 — most_recently_used', () => {
  test('points at active key with newest last_used_at', () => {
    const store = new InMemoryApiKeyStore();
    const cA = store.create('BIL', { name: 'old-use', scopes: ['audit:read'] }, 'admin', daysBack(10));
    store.touch('BIL', cA.key_id, daysBack(7));
    const cB = store.create('BIL', { name: 'recent-use', scopes: ['audit:read'] }, 'admin', daysBack(10));
    store.touch('BIL', cB.key_id, daysBack(1));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    const row = s.scopes.find((r) => r.scope === 'audit:read')!;
    expect(row.most_recently_used_key_id).toBe(cB.key_id);
    expect(row.most_recently_used_at).toBe(daysBack(1).toISOString());
  });

  test('null when no active key has been used', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', daysBack(5));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    const row = s.scopes.find((r) => r.scope === 'audit:read')!;
    expect(row.most_recently_used_key_id).toBeNull();
    expect(row.most_recently_used_at).toBeNull();
  });
});

describe('M1.5 — most_used_scope', () => {
  test('points at scope with highest active_keys count', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k1', scopes: ['audit:read', 'cases:read'] }, 'admin', daysBack(5));
    store.create('BIL', { name: 'k2', scopes: ['audit:read', 'cases:read'] }, 'admin', daysBack(5));
    store.create('BIL', { name: 'k3', scopes: ['audit:read'] }, 'admin', daysBack(5));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    // audit:read on 3 keys, cases:read on 2 keys → audit:read wins.
    expect(s.most_used_scope).toBe('audit:read');
  });

  test('canonical-order tie-break: first VALID_SCOPES wins at same count', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k', scopes: ['cases:read', 'alerts:read'] }, 'admin', daysBack(5));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    // Both at 1; alerts:read is first in VALID_SCOPES.
    expect(s.most_used_scope).toBe(VALID_SCOPES[0]);
  });

  test('null when no active keys', () => {
    const s = summarizeApiKeyScopeDistribution('BIL', [], NOW);
    expect(s.most_used_scope).toBeNull();
  });
});

describe('M1.5 — unused_scopes', () => {
  test('lists every scope with zero active keys in canonical order', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k', scopes: ['audit:read', 'cases:read'] }, 'admin', daysBack(5));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    const expected = VALID_SCOPES.filter((s) => s !== 'audit:read' && s !== 'cases:read');
    expect(s.unused_scopes).toEqual(expected);
  });

  test('revoked-only scope counts as unused', () => {
    const store = new InMemoryApiKeyStore();
    const c = store.create('BIL', { name: 'k', scopes: ['webhooks:dispatch'] }, 'admin', daysBack(5));
    store.revoke('BIL', c.key_id, 'admin', daysBack(1));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    expect(s.unused_scopes).toContain('webhooks:dispatch');
  });

  test('empty when every scope has at least one active key', () => {
    const store = new InMemoryApiKeyStore();
    for (const scope of VALID_SCOPES) {
      store.create('BIL', { name: scope, scopes: [scope] }, 'admin', daysBack(5));
    }
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    expect(s.unused_scopes).toEqual([]);
  });
});

describe('M1.5 — scope_coverage_rate', () => {
  test('= used_scopes / total_scopes', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k', scopes: ['audit:read', 'cases:read'] }, 'admin', daysBack(5));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    // 2 used of 7 = ~0.286
    expect(s.scope_coverage_rate).toBeCloseTo(2 / VALID_SCOPES.length);
  });

  test('= 1.0 when every scope has at least one active key', () => {
    const store = new InMemoryApiKeyStore();
    for (const scope of VALID_SCOPES) {
      store.create('BIL', { name: scope, scopes: [scope] }, 'admin', daysBack(5));
    }
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    expect(s.scope_coverage_rate).toBe(1);
  });

  test('= 0 when no keys', () => {
    const s = summarizeApiKeyScopeDistribution('BIL', [], NOW);
    expect(s.scope_coverage_rate).toBe(0);
  });
});

describe('M1.5 — partition invariants', () => {
  test('total_keys = active + revoked', () => {
    const store = new InMemoryApiKeyStore();
    const c = store.create('BIL', { name: 'a', scopes: ['audit:read'] }, 'admin', daysBack(5));
    store.create('BIL', { name: 'b', scopes: ['audit:read'] }, 'admin', daysBack(5));
    store.revoke('BIL', c.key_id, 'admin', daysBack(1));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    expect(s.total_active_keys + s.total_revoked_keys).toBe(s.total_keys);
  });

  test('per-row active + revoked = total_keys', () => {
    const store = new InMemoryApiKeyStore();
    const c = store.create('BIL', { name: 'a', scopes: ['audit:read'] }, 'admin', daysBack(5));
    store.create('BIL', { name: 'b', scopes: ['audit:read'] }, 'admin', daysBack(5));
    store.revoke('BIL', c.key_id, 'admin', daysBack(1));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyScopeDistribution('BIL', entries, NOW);
    for (const row of s.scopes) {
      expect(row.active_keys + row.revoked_keys).toBe(row.total_keys);
    }
  });
});

// ─── GET /v1/admin/api-keys/scope-distribution ───────────────────────

describe('M1.5 — GET /v1/admin/api-keys/scope-distribution', () => {
  test('admin → 200 with empty rollup on fresh tenant', async () => {
    const { app } = makeScopeApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/scope-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.scopes.length).toBe(VALID_SCOPES.length);
    expect(r.body.body.total_keys).toBe(0);
    expect(r.body.body.most_used_scope).toBeNull();
    expect(r.body.body.scope_coverage_rate).toBe(0);
  });

  test('populated rollup reflects created keys', async () => {
    const { app, store } = makeScopeApp('admin');
    store.create('BIL', { name: 'k1', scopes: ['audit:read', 'cases:read'] }, 'admin', daysBack(5));
    store.create('BIL', { name: 'k2', scopes: ['audit:read'] }, 'admin', daysBack(3));
    const r = await request(app).get('/v1/admin/api-keys/scope-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(2);
    expect(r.body.body.total_active_keys).toBe(2);
    const audit = r.body.body.scopes.find((s: { scope: string }) => s.scope === 'audit:read');
    expect(audit.active_keys).toBe(2);
    expect(r.body.body.most_used_scope).toBe('audit:read');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeScopeApp('case_owner');
    const r = await request(app).get('/v1/admin/api-keys/scope-distribution').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL keys invisible to BANK_DEMO', async () => {
    const { app, store } = makeScopeApp('admin');
    store.create('BIL', { name: 'bil-only', scopes: ['audit:read'] }, 'admin', daysBack(5));
    const bank = await request(app)
      .get('/v1/admin/api-keys/scope-distribution')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_keys).toBe(0);
  });

  test('literal /scope-distribution not captured as :key_id', async () => {
    const { app } = makeScopeApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/scope-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.scopes.length).toBe(VALID_SCOPES.length);

    // Sanity: confirm :key_id route still works for a real unknown id.
    const r2 = await request(app).get('/v1/admin/api-keys/key-deadbeef').set(TH_BIL);
    expect(r2.status).toBe(404);
    expect(r2.body.error.code).toBe('EWS_404_unknown_key');
  });

  test('M1.4 /v1/admin/api-keys/usage still works (sibling regression)', async () => {
    const { app } = makeScopeApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/usage').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M1.2 /v1/admin/api-keys (list) still works (parent regression)', async () => {
    const { app } = makeScopeApp('admin');
    const r = await request(app).get('/v1/admin/api-keys').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
