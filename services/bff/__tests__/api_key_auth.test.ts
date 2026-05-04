// services/bff/__tests__/api_key_auth.test.ts
//
// T6 M1.3 — API key auth middleware.

import express, { type Request, type Response } from 'express';
import request from 'supertest';
import {
  optionalApiKeyAuth,
  requireApiKey,
  requireScope,
} from '../src/api_key_auth';
import { InMemoryApiKeyStore } from '../src/api_keys';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T12:00:00.000Z');

// ─── Standalone middleware tests ──────────────────────────────────────

describe('optionalApiKeyAuth', () => {
  function makeMiniApp(store: InMemoryApiKeyStore) {
    const app = express();
    app.use(express.json());
    app.use(optionalApiKeyAuth(store, () => NOW));
    app.get('/probe', (req: Request, res: Response) => {
      res.json({
        has_api_key: !!req.apiKey,
        tenant_id: req.tenant?.tenant_id ?? null,
        scopes: req.apiKey?.scopes ?? null,
        channel: req.channel ?? null,
      });
    });
    return app;
  }

  test('no Authorization header → falls through silently', async () => {
    const store = new InMemoryApiKeyStore();
    const r = await request(makeMiniApp(store)).get('/probe');
    expect(r.status).toBe(200);
    expect(r.body.has_api_key).toBe(false);
    expect(r.body.tenant_id).toBeNull();
  });

  test('non-Bearer Authorization (e.g. Basic) falls through silently', async () => {
    const store = new InMemoryApiKeyStore();
    const r = await request(makeMiniApp(store)).get('/probe').set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(r.status).toBe(200);
    expect(r.body.has_api_key).toBe(false);
  });

  test('malformed Bearer token → 401 EWS_401_invalid_api_key', async () => {
    const store = new InMemoryApiKeyStore();
    const r = await request(makeMiniApp(store)).get('/probe').set('Authorization', 'Bearer notakey');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('EWS_401_invalid_api_key');
  });

  test('Bearer with wrong format (no apex_ prefix) → 401', async () => {
    const store = new InMemoryApiKeyStore();
    const r = await request(makeMiniApp(store)).get('/probe').set('Authorization', 'Bearer foo.bar');
    expect(r.status).toBe(401);
  });

  test('valid Bearer key → req.apiKey + req.tenant populated', async () => {
    const store = new InMemoryApiKeyStore();
    const created = store.create('BIL', { name: 'svc', scopes: ['audit:read'] }, 'admin', NOW);
    const r = await request(makeMiniApp(store))
      .get('/probe')
      .set('Authorization', `Bearer ${created.key}`);
    expect(r.status).toBe(200);
    expect(r.body.has_api_key).toBe(true);
    expect(r.body.tenant_id).toBe('BIL');
    expect(r.body.scopes).toEqual(['audit:read']);
    expect(r.body.channel).toBe('API');
  });

  test('valid key bumps last_used_at via touch()', async () => {
    const store = new InMemoryApiKeyStore();
    const created = store.create('BIL', { name: 'svc', scopes: ['audit:read'] }, 'admin', NOW);
    expect(store.get('BIL', created.key_id)?.last_used_at).toBeNull();
    await request(makeMiniApp(store))
      .get('/probe')
      .set('Authorization', `Bearer ${created.key}`);
    expect(store.get('BIL', created.key_id)?.last_used_at).toBe(NOW.toISOString());
  });

  test('revoked key → 401', async () => {
    const store = new InMemoryApiKeyStore();
    const created = store.create('BIL', { name: 'svc', scopes: ['audit:read'] }, 'admin', NOW);
    store.revoke('BIL', created.key_id, 'admin', NOW);
    const r = await request(makeMiniApp(store))
      .get('/probe')
      .set('Authorization', `Bearer ${created.key}`);
    expect(r.status).toBe(401);
  });

  test('expired key → 401', async () => {
    const store = new InMemoryApiKeyStore();
    const created = store.create(
      'BIL',
      { name: 'svc', scopes: ['audit:read'], expires_at: '2026-05-06T00:00:00Z' },
      'admin',
      new Date('2026-05-04T00:00:00Z'),
    );
    // Now is 2026-05-05T12:00 < expires; should still be valid
    const valid = await request(makeMiniApp(store))
      .get('/probe')
      .set('Authorization', `Bearer ${created.key}`);
    expect(valid.status).toBe(200);
    // Now use a clock past the expiry
    const lateApp = express();
    lateApp.use(express.json());
    lateApp.use(optionalApiKeyAuth(store, () => new Date('2026-05-07T00:00:00Z')));
    lateApp.get('/probe', (req: Request, res: Response) => res.json({ has: !!req.apiKey }));
    const expired = await request(lateApp).get('/probe').set('Authorization', `Bearer ${created.key}`);
    expect(expired.status).toBe(401);
  });

  test('tampered secret (correct prefix, wrong tail) → 401', async () => {
    const store = new InMemoryApiKeyStore();
    const created = store.create('BIL', { name: 'svc', scopes: ['audit:read'] }, 'admin', NOW);
    const tampered = `apex_${created.prefix}.${'0'.repeat(48)}`;
    const r = await request(makeMiniApp(store))
      .get('/probe')
      .set('Authorization', `Bearer ${tampered}`);
    expect(r.status).toBe(401);
  });

  test('cross-tenant: BIL key → req.tenant.tenant_id=BIL regardless of X-Tenant-ID', async () => {
    const store = new InMemoryApiKeyStore();
    const created = store.create('BIL', { name: 'svc', scopes: ['audit:read'] }, 'admin', NOW);
    const r = await request(makeMiniApp(store))
      .get('/probe')
      .set('Authorization', `Bearer ${created.key}`)
      .set('X-Tenant-ID', 'BANK_DEMO'); // attacker tries to override
    expect(r.body.tenant_id).toBe('BIL');
  });
});

describe('requireApiKey', () => {
  function makeStrictApp(store: InMemoryApiKeyStore) {
    const app = express();
    app.use(express.json());
    app.use(optionalApiKeyAuth(store, () => NOW));
    app.use(requireApiKey(() => NOW));
    app.get('/private', (_req, res) => res.json({ ok: true }));
    return app;
  }

  test('no header → 401', async () => {
    const r = await request(makeStrictApp(new InMemoryApiKeyStore())).get('/private');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('EWS_401_invalid_api_key');
  });

  test('valid key → 200', async () => {
    const store = new InMemoryApiKeyStore();
    const created = store.create('BIL', { name: 'svc', scopes: ['audit:read'] }, 'admin', NOW);
    const r = await request(makeStrictApp(store))
      .get('/private')
      .set('Authorization', `Bearer ${created.key}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

describe('requireScope', () => {
  function makeScopedApp(store: InMemoryApiKeyStore) {
    const app = express();
    app.use(express.json());
    app.use(optionalApiKeyAuth(store, () => NOW));
    app.use(requireApiKey(() => NOW));
    app.get('/audit', requireScope('audit:read', () => NOW), (_req, res) => res.json({ ok: true }));
    return app;
  }

  test('key with scope → 200', async () => {
    const store = new InMemoryApiKeyStore();
    const created = store.create('BIL', { name: 'svc', scopes: ['audit:read'] }, 'admin', NOW);
    const r = await request(makeScopedApp(store))
      .get('/audit')
      .set('Authorization', `Bearer ${created.key}`);
    expect(r.status).toBe(200);
  });

  test('key without scope → 403 EWS_403_missing_scope', async () => {
    const store = new InMemoryApiKeyStore();
    const created = store.create('BIL', { name: 'svc', scopes: ['reports:read'] }, 'admin', NOW);
    const r = await request(makeScopedApp(store))
      .get('/audit')
      .set('Authorization', `Bearer ${created.key}`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('EWS_403_missing_scope');
  });

  test('no key (defensive) → 401', async () => {
    const app = express();
    app.use(express.json());
    app.get('/audit', requireScope('audit:read', () => NOW), (_req, res) => res.json({ ok: true }));
    const r = await request(app).get('/audit');
    expect(r.status).toBe(401);
  });
});

// ─── End-to-end through the BFF /v1/svc/* surface ─────────────────────

function makeSvcApp(initial: Array<{ tenant: string; scopes: string[]; name?: string }> = []) {
  const store = new InMemoryApiKeyStore();
  const created = initial.map((i) =>
    store.create(
      i.tenant,
      { name: i.name ?? 'svc', scopes: i.scopes as Array<Parameters<typeof store.create>[1]['scopes'][number]> },
      'admin',
      NOW,
    ),
  );
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    apiKeyStore: store,
    now: () => NOW,
    getRole: () => 'admin',
  });
  return { ...built, store, keys: created };
}

describe('GET /v1/svc/whoami', () => {
  test('valid key: 200 with redacted entry shape', async () => {
    const { app, keys } = makeSvcApp([{ tenant: 'BIL', scopes: ['audit:read', 'reports:read'] }]);
    const key = keys[0]!;
    const r = await request(app).get('/v1/svc/whoami').set('Authorization', `Bearer ${key.key}`);
    expect(r.status).toBe(200);
    expect(r.body.body.key_id).toBe(key.key_id);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.scopes).toEqual(['audit:read', 'reports:read']);
    expect(r.body.body).not.toHaveProperty('hash');
    expect(r.body.body).not.toHaveProperty('key');
  });

  test('no Authorization header → 401', async () => {
    const { app } = makeSvcApp();
    const r = await request(app).get('/v1/svc/whoami');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('EWS_401_invalid_api_key');
  });

  test('mangled key → 401', async () => {
    const { app } = makeSvcApp([{ tenant: 'BIL', scopes: ['audit:read'] }]);
    const r = await request(app).get('/v1/svc/whoami').set('Authorization', 'Bearer notakey');
    expect(r.status).toBe(401);
  });

  test('revoked key → 401', async () => {
    const { app, store, keys } = makeSvcApp([{ tenant: 'BIL', scopes: ['audit:read'] }]);
    const key = keys[0]!;
    store.revoke('BIL', key.key_id, 'admin', NOW);
    const r = await request(app).get('/v1/svc/whoami').set('Authorization', `Bearer ${key.key}`);
    expect(r.status).toBe(401);
  });

  test('whoami does NOT need a scope (any active key works)', async () => {
    const { app, keys } = makeSvcApp([{ tenant: 'BIL', scopes: ['notifications:send'] }]);
    const key = keys[0]!;
    const r = await request(app).get('/v1/svc/whoami').set('Authorization', `Bearer ${key.key}`);
    expect(r.status).toBe(200);
  });

  test('X-Tenant-ID header is ignored — tenant binds from key', async () => {
    const { app, keys } = makeSvcApp([{ tenant: 'BIL', scopes: ['audit:read'] }]);
    const key = keys[0]!;
    const r = await request(app)
      .get('/v1/svc/whoami')
      .set('Authorization', `Bearer ${key.key}`)
      .set('X-Tenant-ID', 'BANK_DEMO');
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('valid request bumps last_used_at (visible via /v1/admin/api-keys/:id)', async () => {
    const { app, keys } = makeSvcApp([{ tenant: 'BIL', scopes: ['audit:read'] }]);
    const key = keys[0]!;
    await request(app).get('/v1/svc/whoami').set('Authorization', `Bearer ${key.key}`);
    const r = await request(app)
      .get(`/v1/admin/api-keys/${key.key_id}`)
      .set('X-Tenant-ID', 'BIL')
      .set('X-Channel', 'API');
    expect(r.body.body.last_used_at).toBe(NOW.toISOString());
  });
});

describe('GET /v1/svc/audit/integrity (requireScope demo)', () => {
  test('key with audit:read → 200 with chain verification', async () => {
    const { app, keys } = makeSvcApp([{ tenant: 'BIL', scopes: ['audit:read'] }]);
    const key = keys[0]!;
    const r = await request(app)
      .get('/v1/svc/audit/integrity')
      .set('Authorization', `Bearer ${key.key}`);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.valid).toBe(true);
  });

  test('key without audit:read → 403 EWS_403_missing_scope', async () => {
    const { app, keys } = makeSvcApp([{ tenant: 'BIL', scopes: ['reports:read'] }]);
    const key = keys[0]!;
    const r = await request(app)
      .get('/v1/svc/audit/integrity')
      .set('Authorization', `Bearer ${key.key}`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('EWS_403_missing_scope');
  });

  test('no Authorization → 401', async () => {
    const { app } = makeSvcApp();
    const r = await request(app).get('/v1/svc/audit/integrity');
    expect(r.status).toBe(401);
  });

  test('cross-tenant: BIL key sees only BIL chain', async () => {
    const { app, keys, store } = makeSvcApp([
      { tenant: 'BIL', scopes: ['audit:read'] },
      { tenant: 'BANK_DEMO', scopes: ['audit:read'] },
    ]);
    void store;
    const bilKey = keys[0]!;
    const r = await request(app)
      .get('/v1/svc/audit/integrity')
      .set('Authorization', `Bearer ${bilKey.key}`)
      .set('X-Tenant-ID', 'BANK_DEMO'); // attempt override
    expect(r.body.body.tenant_id).toBe('BIL');
  });
});

// ─── No-regression ────────────────────────────────────────────────────

describe('No-regression: human auth path still works', () => {
  test('GET /v1/alerts with X-Tenant-ID still 200 (no Bearer header)', async () => {
    const { app } = makeSvcApp();
    const r = await request(app).get('/v1/alerts').set('X-Tenant-ID', 'BIL').set('X-Channel', 'API');
    expect(r.status).toBe(200);
  });

  test('GET /v1/admin/api-keys still 200 (admin path uncoupled from /svc/*)', async () => {
    const { app } = makeSvcApp();
    const r = await request(app)
      .get('/v1/admin/api-keys')
      .set('X-Tenant-ID', 'BIL')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
  });
});
