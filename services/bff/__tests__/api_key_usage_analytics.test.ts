// services/bff/__tests__/api_key_usage_analytics.test.ts
//
// T6 M1.4 — Service-account API key usage analytics.

import request from 'supertest';
import {
  summarizeApiKeyUsage,
  EXPIRES_SOON_DAYS,
  DORMANT_DAYS,
  IDLE_NEVER_USED_DAYS,
} from '../src/api_key_usage_analytics';
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
function daysForward(d: number): Date {
  return new Date(NOW.getTime() + d * 24 * 60 * 60 * 1000);
}
function isoForward(d: number): string {
  return daysForward(d).toISOString();
}

function makeUsageApp(role: string = 'admin') {
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

// ─── summarizeApiKeyUsage — pure ─────────────────────────────────────

describe('M1.4 — empty input', () => {
  test('zero entries → zero-everywhere rollup', () => {
    const s = summarizeApiKeyUsage('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_keys).toBe(0);
    expect(s.total_active).toBe(0);
    expect(s.total_revoked).toBe(0);
    expect(s.total_expired).toBe(0);
    expect(s.total_active_expires_soon).toBe(0);
    expect(s.total_active_dormant).toBe(0);
    expect(s.total_active_idle_never_used).toBe(0);
    expect(s.keys).toEqual([]);
    expect(s.most_recent_use).toBeNull();
    expect(s.expiring_soon).toEqual([]);
    expect(s.dormant_keys).toEqual([]);
    // by_scope: every scope key present at 0.
    for (const sc of VALID_SCOPES) expect(s.by_scope[sc]).toBe(0);
    expect(Object.keys(s.by_scope).length).toBe(VALID_SCOPES.length);
  });
});

describe('M1.4 — single active never-used key', () => {
  test('young never-used key → ever_used=false, not idle, not dormant', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'fresh', scopes: ['audit:read'] }, 'admin', daysBack(2));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    expect(s.total_keys).toBe(1);
    expect(s.total_active).toBe(1);
    const row = s.keys[0]!;
    expect(row.ever_used).toBe(false);
    expect(row.last_used_at).toBeNull();
    expect(row.days_since_last_use).toBeNull();
    expect(row.days_since_creation).toBe(2);
    expect(row.is_idle_never_used).toBe(false);
    expect(row.is_dormant).toBe(false);
    expect(row.is_expired).toBe(false);
    expect(s.most_recent_use).toBeNull();
    expect(s.by_scope['audit:read']).toBe(1);
  });
});

describe('M1.4 — never-used key crosses idle threshold', () => {
  test('never-used key older than IDLE_NEVER_USED_DAYS → is_idle_never_used=true', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'forgotten', scopes: ['audit:read'] }, 'admin', daysBack(IDLE_NEVER_USED_DAYS + 5));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    expect(s.keys[0]!.is_idle_never_used).toBe(true);
    expect(s.keys[0]!.is_dormant).toBe(false); // never used → not dormant
    expect(s.total_active_idle_never_used).toBe(1);
  });

  test('never-used key at exact IDLE_NEVER_USED_DAYS boundary → still NOT idle', () => {
    // Threshold is strict > so age == IDLE_NEVER_USED_DAYS should NOT flip the flag.
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'edge', scopes: ['audit:read'] }, 'admin', daysBack(IDLE_NEVER_USED_DAYS));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    expect(s.keys[0]!.is_idle_never_used).toBe(false);
  });
});

describe('M1.4 — dormant detection (active + ever-used + > DORMANT_DAYS)', () => {
  test('used long ago → is_dormant=true', () => {
    const store = new InMemoryApiKeyStore();
    const created = store.create('BIL', { name: 'old client', scopes: ['audit:read'] }, 'admin', daysBack(200));
    store.touch('BIL', created.key_id, daysBack(DORMANT_DAYS + 10));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    const row = s.keys[0]!;
    expect(row.ever_used).toBe(true);
    expect(row.days_since_last_use).toBe(DORMANT_DAYS + 10);
    expect(row.is_dormant).toBe(true);
    expect(s.total_active_dormant).toBe(1);
    expect(s.dormant_keys).toHaveLength(1);
    expect(s.dormant_keys[0]!.key_id).toBe(row.key_id);
  });

  test('used recently → is_dormant=false', () => {
    const store = new InMemoryApiKeyStore();
    const created = store.create('BIL', { name: 'busy', scopes: ['audit:read'] }, 'admin', daysBack(200));
    store.touch('BIL', created.key_id, daysBack(5));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    expect(s.keys[0]!.is_dormant).toBe(false);
    expect(s.total_active_dormant).toBe(0);
  });
});

describe('M1.4 — expires_soon detection', () => {
  test('active key expiring within EXPIRES_SOON_DAYS → expires_soon=true', () => {
    const store = new InMemoryApiKeyStore();
    store.create(
      'BIL',
      { name: 'renew me', scopes: ['audit:read'], expires_at: isoForward(15) },
      'admin',
      daysBack(2),
    );
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    expect(s.keys[0]!.expires_soon).toBe(true);
    expect(s.keys[0]!.days_until_expiry).toBe(15);
    expect(s.total_active_expires_soon).toBe(1);
    expect(s.expiring_soon).toHaveLength(1);
  });

  test('expiry beyond EXPIRES_SOON_DAYS → expires_soon=false', () => {
    const store = new InMemoryApiKeyStore();
    store.create(
      'BIL',
      { name: 'far future', scopes: ['audit:read'], expires_at: isoForward(EXPIRES_SOON_DAYS + 10) },
      'admin',
      daysBack(2),
    );
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    expect(s.keys[0]!.expires_soon).toBe(false);
  });
});

describe('M1.4 — is_expired classification', () => {
  test('expires_at in the past → is_expired=true, days_until_expiry negative', () => {
    const store = new InMemoryApiKeyStore();
    // Create with a future expiry, then summarize at a "now" past the expiry.
    // Easiest: pick a far-future "now" relative to created+expires.
    store.create(
      'BIL',
      { name: 'will expire', scopes: ['audit:read'], expires_at: daysBack(-5).toISOString() }, // 5 days in the future
      'admin',
      daysBack(100),
    );
    // Summarize at NOW + 100 days, which is well past the expires_at.
    const farFuture = new Date(NOW.getTime() + 100 * 24 * 60 * 60 * 1000);
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, farFuture);
    expect(s.keys[0]!.is_expired).toBe(true);
    expect(s.keys[0]!.days_until_expiry).toBeLessThan(0);
    expect(s.keys[0]!.expires_soon).toBe(false); // expired ≠ expires_soon
    expect(s.total_expired).toBe(1);
  });

  test('no expires_at → is_expired=false, days_until_expiry=null', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'no expiry', scopes: ['audit:read'] }, 'admin', daysBack(5));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    expect(s.keys[0]!.is_expired).toBe(false);
    expect(s.keys[0]!.days_until_expiry).toBeNull();
  });
});

describe('M1.4 — revoked keys', () => {
  test('revoked key: counted in total_revoked, excluded from total_active + by_scope', () => {
    const store = new InMemoryApiKeyStore();
    const c1 = store.create('BIL', { name: 'k1', scopes: ['audit:read'] }, 'admin', daysBack(5));
    store.create('BIL', { name: 'k2', scopes: ['audit:read', 'cases:read'] }, 'admin', daysBack(5));
    store.revoke('BIL', c1.key_id, 'admin', daysBack(1));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    expect(s.total_keys).toBe(2);
    expect(s.total_active).toBe(1);
    expect(s.total_revoked).toBe(1);
    // by_scope counts ACTIVE keys only: k2 contributes audit:read + cases:read; k1 (revoked) does not.
    expect(s.by_scope['audit:read']).toBe(1);
    expect(s.by_scope['cases:read']).toBe(1);
  });

  test('revoked key cannot be dormant (only active keys flagged)', () => {
    const store = new InMemoryApiKeyStore();
    const c = store.create('BIL', { name: 'old', scopes: ['audit:read'] }, 'admin', daysBack(300));
    store.touch('BIL', c.key_id, daysBack(200));
    store.revoke('BIL', c.key_id, 'admin', daysBack(1));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    const row = s.keys[0]!;
    expect(row.status).toBe('revoked');
    expect(row.is_dormant).toBe(false);
    expect(s.total_active_dormant).toBe(0);
  });
});

describe('M1.4 — by_scope counts all scopes on active keys', () => {
  test('multi-scope key contributes to every listed scope', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'wide', scopes: ['audit:read', 'cases:read', 'reports:read'] }, 'admin', NOW);
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    expect(s.by_scope['audit:read']).toBe(1);
    expect(s.by_scope['cases:read']).toBe(1);
    expect(s.by_scope['reports:read']).toBe(1);
    expect(s.by_scope['alerts:read']).toBe(0);
  });
});

describe('M1.4 — keys[] sort order', () => {
  test('last_used_at desc, nulls last, created_at desc tie-break', () => {
    const store = new InMemoryApiKeyStore();
    const c1 = store.create('BIL', { name: 'old-used', scopes: ['audit:read'] }, 'admin', daysBack(100));
    store.touch('BIL', c1.key_id, daysBack(50));
    const c2 = store.create('BIL', { name: 'recent-used', scopes: ['audit:read'] }, 'admin', daysBack(80));
    store.touch('BIL', c2.key_id, daysBack(2));
    store.create('BIL', { name: 'never-used-older', scopes: ['audit:read'] }, 'admin', daysBack(30));
    store.create('BIL', { name: 'never-used-newer', scopes: ['audit:read'] }, 'admin', daysBack(10));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    const order = s.keys.map((r) => r.name);
    // First two: ever-used by last_used_at desc.
    expect(order[0]).toBe('recent-used');
    expect(order[1]).toBe('old-used');
    // Then never-used by created_at desc.
    expect(order[2]).toBe('never-used-newer');
    expect(order[3]).toBe('never-used-older');
  });
});

describe('M1.4 — most_recent_use', () => {
  test('points at the row with newest last_used_at', () => {
    const store = new InMemoryApiKeyStore();
    const c1 = store.create('BIL', { name: 'a', scopes: ['audit:read'] }, 'admin', daysBack(50));
    store.touch('BIL', c1.key_id, daysBack(20));
    const c2 = store.create('BIL', { name: 'b', scopes: ['audit:read'] }, 'admin', daysBack(50));
    store.touch('BIL', c2.key_id, daysBack(3));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    expect(s.most_recent_use).not.toBeNull();
    expect(s.most_recent_use!.key_id).toBe(c2.key_id);
  });

  test('null when no key has been used', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'never', scopes: ['audit:read'] }, 'admin', daysBack(5));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    expect(s.most_recent_use).toBeNull();
  });
});

describe('M1.4 — expiring_soon[] sort order', () => {
  test('sorted by days_until_expiry asc (soonest first)', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'far', scopes: ['audit:read'], expires_at: isoForward(28) }, 'admin', daysBack(2));
    store.create('BIL', { name: 'mid', scopes: ['audit:read'], expires_at: isoForward(10) }, 'admin', daysBack(2));
    store.create('BIL', { name: 'soonest', scopes: ['audit:read'], expires_at: isoForward(2) }, 'admin', daysBack(2));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    expect(s.expiring_soon.map((e) => e.name)).toEqual(['soonest', 'mid', 'far']);
  });
});

describe('M1.4 — dormant_keys[] sort order', () => {
  test('sorted by days_since_last_use desc (most dormant first)', () => {
    const store = new InMemoryApiKeyStore();
    const c1 = store.create('BIL', { name: 'mid-dormant', scopes: ['audit:read'] }, 'admin', daysBack(300));
    store.touch('BIL', c1.key_id, daysBack(120));
    const c2 = store.create('BIL', { name: 'most-dormant', scopes: ['audit:read'] }, 'admin', daysBack(300));
    store.touch('BIL', c2.key_id, daysBack(250));
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    expect(s.dormant_keys.map((d) => d.name)).toEqual(['most-dormant', 'mid-dormant']);
  });
});

describe('M1.4 — partition invariants', () => {
  test('active + revoked = total_keys; expires_soon/dormant/idle ⊆ active', () => {
    const store = new InMemoryApiKeyStore();
    const cActive = store.create('BIL', { name: 'a', scopes: ['audit:read'] }, 'admin', daysBack(5));
    const cRev = store.create('BIL', { name: 'r', scopes: ['audit:read'] }, 'admin', daysBack(5));
    store.revoke('BIL', cRev.key_id, 'admin', daysBack(1));
    void cActive;
    const entries = store.list('BIL', 1, 100).items;
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    expect(s.total_active + s.total_revoked).toBe(s.total_keys);
    expect(s.total_active_expires_soon).toBeLessThanOrEqual(s.total_active);
    expect(s.total_active_dormant).toBeLessThanOrEqual(s.total_active);
    expect(s.total_active_idle_never_used).toBeLessThanOrEqual(s.total_active);
  });
});

// ─── GET /v1/admin/api-keys/usage ────────────────────────────────────

describe('M1.4 — GET /v1/admin/api-keys/usage', () => {
  test('admin → 200 with empty rollup on fresh tenant', async () => {
    const { app } = makeUsageApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/usage').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.total_keys).toBe(0);
    expect(r.body.body.keys).toEqual([]);
    expect(r.body.body.most_recent_use).toBeNull();
  });

  test('populated rollup reflects created keys', async () => {
    const { app, store } = makeUsageApp('admin');
    const c1 = store.create('BIL', { name: 'k1', scopes: ['audit:read'] }, 'admin', daysBack(10));
    store.touch('BIL', c1.key_id, daysBack(1));
    store.create(
      'BIL',
      { name: 'k2-expires-soon', scopes: ['cases:read'], expires_at: isoForward(7) },
      'admin',
      daysBack(2),
    );
    const r = await request(app).get('/v1/admin/api-keys/usage').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(2);
    expect(r.body.body.total_active).toBe(2);
    expect(r.body.body.total_active_expires_soon).toBe(1);
    expect(r.body.body.most_recent_use).not.toBeNull();
    expect(r.body.body.most_recent_use.key_id).toBe(c1.key_id);
    expect(r.body.body.expiring_soon).toHaveLength(1);
    expect(r.body.body.expiring_soon[0].name).toBe('k2-expires-soon');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeUsageApp('case_owner');
    const r = await request(app).get('/v1/admin/api-keys/usage').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL keys invisible to BANK_DEMO', async () => {
    const { app, store } = makeUsageApp('admin');
    store.create('BIL', { name: 'bil-only', scopes: ['audit:read'] }, 'admin', daysBack(5));
    const bank = await request(app)
      .get('/v1/admin/api-keys/usage')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_keys).toBe(0);
  });

  test('M1.2 GET /v1/admin/api-keys (list) still works (sibling regression)', async () => {
    const { app, store } = makeUsageApp('admin');
    store.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    const r = await request(app).get('/v1/admin/api-keys').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(1);
  });

  test('M1.2 GET /v1/admin/api-keys/:id — `/usage` literal isnt captured as id', async () => {
    // If the /:key_id route shadowed /usage, this call would hit it and 404 on key "usage".
    const { app } = makeUsageApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/usage').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    // Sanity: confirm the param route still works for a real id (gives 404 with EWS_404 envelope).
    const r2 = await request(app).get('/v1/admin/api-keys/key-deadbeef').set(TH_BIL);
    expect(r2.status).toBe(404);
    expect(r2.body.error.code).toBe('EWS_404_unknown_key');
  });
});

// ─── ApiKeyEntry type smoke (compile-time sanity) ─────────────────────

describe('M1.4 — ApiKeyEntry contract', () => {
  test('the redacted entry shape feeds the resolver without runtime tweaks', () => {
    const entries: ApiKeyEntry[] = [
      {
        key_id: 'key-1',
        tenant_id: 'BIL',
        name: 'manual entry',
        prefix: 'aaaabbbbcccc',
        scopes: ['audit:read'],
        status: 'active',
        created_by: 'admin',
        created_at: daysBack(10).toISOString(),
        expires_at: null,
        last_used_at: null,
        revoked_at: null,
        revoked_by: null,
      },
    ];
    const s = summarizeApiKeyUsage('BIL', entries, NOW);
    expect(s.total_keys).toBe(1);
    expect(s.keys[0]!.key_id).toBe('key-1');
  });
});
