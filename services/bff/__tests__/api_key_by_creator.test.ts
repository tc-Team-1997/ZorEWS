// services/bff/__tests__/api_key_by_creator.test.ts
//
// T6 M1.6 — Service-account API key by-creator governance rollup.

import request from 'supertest';
import { summarizeApiKeysByCreator } from '../src/api_key_by_creator';
import {
  InMemoryApiKeyStore,
  type ApiKeyEntry,
} from '../src/api_keys';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function daysBack(d: number): Date {
  return new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
}

function makeBcApp(role: string = 'admin') {
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

// ─── summarizeApiKeysByCreator — pure ────────────────────────────────

describe('M1.6 — empty input', () => {
  test('zero entries → empty creators[] + null leaderboards', () => {
    const s = summarizeApiKeysByCreator('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_keys).toBe(0);
    expect(s.total_active_keys).toBe(0);
    expect(s.total_revoked_keys).toBe(0);
    expect(s.total_creators).toBe(0);
    expect(s.creators_with_active_keys).toBe(0);
    expect(s.creators).toEqual([]);
    expect(s.most_prolific_creator).toBeNull();
    expect(s.largest_active_provisioner).toBeNull();
  });
});

describe('M1.6 — single key single creator', () => {
  test('one key by alice → single row with active=1', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k1', scopes: ['audit:read'] }, 'alice', daysBack(5));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeysByCreator('BIL', entries, NOW);
    expect(s.total_keys).toBe(1);
    expect(s.total_creators).toBe(1);
    expect(s.creators_with_active_keys).toBe(1);
    expect(s.creators).toHaveLength(1);
    const row = s.creators[0]!;
    expect(row.creator_username).toBe('alice');
    expect(row.total_keys).toBe(1);
    expect(row.active_keys).toBe(1);
    expect(row.revoked_keys).toBe(0);
    expect(row.scopes).toEqual(['audit:read']);
    expect(row.most_recent_creation_at).toBe(daysBack(5).toISOString());
    expect(row.key_names).toEqual(['k1']);
    expect(s.most_prolific_creator).toBe('alice');
    expect(s.largest_active_provisioner).toBe('alice');
  });
});

describe('M1.6 — multi-creator', () => {
  test('grouped by creator_username with own counts', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'a1', scopes: ['audit:read'] }, 'alice', daysBack(5));
    store.create('BIL', { name: 'a2', scopes: ['cases:read'] }, 'alice', daysBack(3));
    store.create('BIL', { name: 'b1', scopes: ['reports:read'] }, 'bob', daysBack(2));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeysByCreator('BIL', entries, NOW);
    expect(s.total_keys).toBe(3);
    expect(s.total_creators).toBe(2);
    expect(s.creators).toHaveLength(2);
    const alice = s.creators.find((c) => c.creator_username === 'alice')!;
    const bob = s.creators.find((c) => c.creator_username === 'bob')!;
    expect(alice.total_keys).toBe(2);
    expect(bob.total_keys).toBe(1);
  });
});

describe('M1.6 — sort total_keys desc with username asc tie-break', () => {
  test('alice 2 keys > bob 1 key', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'a1', scopes: ['audit:read'] }, 'alice', daysBack(5));
    store.create('BIL', { name: 'a2', scopes: ['cases:read'] }, 'alice', daysBack(3));
    store.create('BIL', { name: 'b1', scopes: ['reports:read'] }, 'bob', daysBack(1));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeysByCreator('BIL', entries, NOW);
    expect(s.creators[0]!.creator_username).toBe('alice');
    expect(s.creators[1]!.creator_username).toBe('bob');
  });

  test('username asc tie-break when total_keys tied', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'a1', scopes: ['audit:read'] }, 'zoe', daysBack(5));
    store.create('BIL', { name: 'b1', scopes: ['audit:read'] }, 'alice', daysBack(4));
    store.create('BIL', { name: 'c1', scopes: ['audit:read'] }, 'mike', daysBack(3));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeysByCreator('BIL', entries, NOW);
    expect(s.creators.map((c) => c.creator_username)).toEqual(['alice', 'mike', 'zoe']);
  });
});

describe('M1.6 — revoked keys', () => {
  test('revoked counted in revoked_keys + excluded from active_keys', () => {
    const store = new InMemoryApiKeyStore();
    const c = store.create('BIL', { name: 'k1', scopes: ['audit:read'] }, 'alice', daysBack(5));
    store.create('BIL', { name: 'k2', scopes: ['audit:read'] }, 'alice', daysBack(3));
    store.revoke('BIL', c.key_id, 'alice', daysBack(1));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeysByCreator('BIL', entries, NOW);
    expect(s.total_active_keys).toBe(1);
    expect(s.total_revoked_keys).toBe(1);
    expect(s.creators).toHaveLength(1);
    const alice = s.creators[0]!;
    expect(alice.total_keys).toBe(2);
    expect(alice.active_keys).toBe(1);
    expect(alice.revoked_keys).toBe(1);
  });
});

describe('M1.6 — partition invariant', () => {
  test('Σ per-creator total_keys = total_keys; active + revoked ≤ total', () => {
    const store = new InMemoryApiKeyStore();
    const c = store.create('BIL', { name: 'a1', scopes: ['audit:read'] }, 'alice', daysBack(5));
    store.create('BIL', { name: 'a2', scopes: ['cases:read'] }, 'alice', daysBack(4));
    store.create('BIL', { name: 'b1', scopes: ['reports:read'] }, 'bob', daysBack(3));
    store.revoke('BIL', c.key_id, 'alice', daysBack(1));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeysByCreator('BIL', entries, NOW);
    const sum = s.creators.reduce((acc, c2) => acc + c2.total_keys, 0);
    expect(sum).toBe(s.total_keys);
    expect(s.total_keys).toBe(3);
    expect(s.total_active_keys + s.total_revoked_keys).toBeLessThanOrEqual(s.total_keys);
    expect(s.total_active_keys + s.total_revoked_keys).toBe(s.total_keys);
    for (const c2 of s.creators) {
      expect(c2.active_keys + c2.revoked_keys).toBe(c2.total_keys);
    }
  });
});

describe('M1.6 — scopes union with dedup', () => {
  test('union across all keys; sorted asc; dedup within key', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'k1', scopes: ['cases:read', 'audit:read'] }, 'alice', daysBack(5));
    store.create('BIL', { name: 'k2', scopes: ['audit:read', 'reports:read'] }, 'alice', daysBack(3));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeysByCreator('BIL', entries, NOW);
    const alice = s.creators[0]!;
    expect(alice.scopes).toEqual(['audit:read', 'cases:read', 'reports:read']);
  });
});

describe('M1.6 — most_recent_creation_at', () => {
  test('newest created_at across creator keys', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'old', scopes: ['audit:read'] }, 'alice', daysBack(10));
    store.create('BIL', { name: 'new', scopes: ['audit:read'] }, 'alice', daysBack(2));
    store.create('BIL', { name: 'mid', scopes: ['audit:read'] }, 'alice', daysBack(5));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeysByCreator('BIL', entries, NOW);
    expect(s.creators[0]!.most_recent_creation_at).toBe(daysBack(2).toISOString());
  });
});

describe('M1.6 — key_names', () => {
  test('sorted asc per creator', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'zebra', scopes: ['audit:read'] }, 'alice', daysBack(5));
    store.create('BIL', { name: 'apple', scopes: ['audit:read'] }, 'alice', daysBack(3));
    store.create('BIL', { name: 'mango', scopes: ['audit:read'] }, 'alice', daysBack(1));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeysByCreator('BIL', entries, NOW);
    expect(s.creators[0]!.key_names).toEqual(['apple', 'mango', 'zebra']);
  });
});

describe('M1.6 — most_prolific_creator', () => {
  test('points at creator with highest total_keys', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'a1', scopes: ['audit:read'] }, 'alice', daysBack(5));
    store.create('BIL', { name: 'a2', scopes: ['audit:read'] }, 'alice', daysBack(4));
    store.create('BIL', { name: 'a3', scopes: ['audit:read'] }, 'alice', daysBack(3));
    store.create('BIL', { name: 'b1', scopes: ['audit:read'] }, 'bob', daysBack(2));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeysByCreator('BIL', entries, NOW);
    expect(s.most_prolific_creator).toBe('alice');
  });

  test('username asc tie-break', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'z1', scopes: ['audit:read'] }, 'zoe', daysBack(5));
    store.create('BIL', { name: 'a1', scopes: ['audit:read'] }, 'alice', daysBack(4));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeysByCreator('BIL', entries, NOW);
    expect(s.most_prolific_creator).toBe('alice'); // tied at 1; alice wins alphabetically
  });

  test('null on empty', () => {
    const s = summarizeApiKeysByCreator('BIL', [], NOW);
    expect(s.most_prolific_creator).toBeNull();
  });
});

describe('M1.6 — largest_active_provisioner', () => {
  test('highest active_keys (not total_keys) wins', () => {
    const store = new InMemoryApiKeyStore();
    // alice has 2 total but both revoked = 0 active
    const a1 = store.create('BIL', { name: 'a1', scopes: ['audit:read'] }, 'alice', daysBack(5));
    const a2 = store.create('BIL', { name: 'a2', scopes: ['audit:read'] }, 'alice', daysBack(4));
    store.revoke('BIL', a1.key_id, 'admin', daysBack(2));
    store.revoke('BIL', a2.key_id, 'admin', daysBack(1));
    // bob has 1 active
    store.create('BIL', { name: 'b1', scopes: ['audit:read'] }, 'bob', daysBack(3));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeysByCreator('BIL', entries, NOW);
    // alice has higher total_keys → most_prolific_creator
    expect(s.most_prolific_creator).toBe('alice');
    // bob has higher active_keys → largest_active_provisioner
    expect(s.largest_active_provisioner).toBe('bob');
  });

  test('null when no active keys', () => {
    const store = new InMemoryApiKeyStore();
    const c = store.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'alice', daysBack(5));
    store.revoke('BIL', c.key_id, 'admin', daysBack(1));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeysByCreator('BIL', entries, NOW);
    expect(s.most_prolific_creator).toBe('alice'); // still names alice
    expect(s.largest_active_provisioner).toBeNull(); // but no one active
  });
});

describe('M1.6 — creators_with_active_keys', () => {
  test('counts only creators with ≥ 1 active key', () => {
    const store = new InMemoryApiKeyStore();
    const a1 = store.create('BIL', { name: 'a1', scopes: ['audit:read'] }, 'alice', daysBack(5));
    store.revoke('BIL', a1.key_id, 'admin', daysBack(1));
    store.create('BIL', { name: 'b1', scopes: ['audit:read'] }, 'bob', daysBack(3));
    store.create('BIL', { name: 'c1', scopes: ['audit:read'] }, 'carol', daysBack(2));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeysByCreator('BIL', entries, NOW);
    expect(s.total_creators).toBe(3); // alice, bob, carol
    expect(s.creators_with_active_keys).toBe(2); // alice revoked all
  });
});

describe('M1.6 — defensive missing created_by', () => {
  test('entries with empty created_by are skipped', () => {
    const entries: ApiKeyEntry[] = [
      {
        key_id: 'k1', tenant_id: 'BIL', name: 'k1', prefix: 'abc',
        scopes: ['audit:read'], status: 'active', created_by: '',
        created_at: daysBack(5).toISOString(), expires_at: null,
        last_used_at: null, revoked_at: null, revoked_by: null,
      },
      {
        key_id: 'k2', tenant_id: 'BIL', name: 'k2', prefix: 'def',
        scopes: ['audit:read'], status: 'active', created_by: 'alice',
        created_at: daysBack(3).toISOString(), expires_at: null,
        last_used_at: null, revoked_at: null, revoked_by: null,
      },
    ];
    const s = summarizeApiKeysByCreator('BIL', entries, NOW);
    expect(s.total_keys).toBe(2); // both counted in envelope total
    expect(s.total_creators).toBe(1); // only alice as creator
    expect(s.creators[0]!.creator_username).toBe('alice');
  });
});

// ─── GET /v1/admin/api-keys/by-creator ───────────────────────────────

describe('M1.6 — GET /v1/admin/api-keys/by-creator', () => {
  test('admin → 200 with empty rollup', async () => {
    const { app } = makeBcApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/by-creator').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.total_keys).toBe(0);
    expect(r.body.body.total_creators).toBe(0);
    expect(r.body.body.creators).toEqual([]);
    expect(r.body.body.most_prolific_creator).toBeNull();
  });

  test('populated rollup reflects created keys', async () => {
    const { app, store } = makeBcApp('admin');
    store.create('BIL', { name: 'k1', scopes: ['audit:read'] }, 'alice', NOW);
    store.create('BIL', { name: 'k2', scopes: ['cases:read'] }, 'alice', NOW);
    store.create('BIL', { name: 'k3', scopes: ['reports:read'] }, 'bob', NOW);
    const r = await request(app).get('/v1/admin/api-keys/by-creator').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(3);
    expect(r.body.body.total_creators).toBe(2);
    expect(r.body.body.creators[0].creator_username).toBe('alice');
    expect(r.body.body.creators[0].total_keys).toBe(2);
    expect(r.body.body.creators[1].creator_username).toBe('bob');
    expect(r.body.body.most_prolific_creator).toBe('alice');
    expect(r.body.body.largest_active_provisioner).toBe('alice');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBcApp('case_owner');
    const r = await request(app).get('/v1/admin/api-keys/by-creator').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL keys invisible to BANK_DEMO', async () => {
    const { app, store } = makeBcApp('admin');
    store.create('BIL', { name: 'k1', scopes: ['audit:read'] }, 'alice', NOW);
    const bank = await request(app)
      .get('/v1/admin/api-keys/by-creator')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_keys).toBe(0);
  });

  test('literal `/by-creator` not captured as :key_id param', async () => {
    const { app } = makeBcApp('admin');
    // If shadowed by `/:key_id`, would 404 EWS_404_unknown_key.
    const r = await request(app).get('/v1/admin/api-keys/by-creator').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('M1.5 /v1/admin/api-keys/scope-distribution still 200 (sibling regression)', async () => {
    const { app } = makeBcApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/scope-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M1.4 /v1/admin/api-keys/usage still 200 (sibling regression)', async () => {
    const { app } = makeBcApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/usage').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
