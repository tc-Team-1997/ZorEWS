// services/bff/__tests__/api_keys.test.ts
//
// T6 M1.2 — Service-account API keys.

import request from 'supertest';
import {
  ApiKeyError,
  InMemoryApiKeyStore,
  VALID_SCOPES,
  compareKey,
  isApiKeyScope,
  validateInput,
  type ApiKeyCreated,
  type ApiKeyEntry,
} from '../src/api_keys';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeKeysApp(role: string = 'admin') {
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

const VALID_BODY = {
  name: 'compliance integration',
  scopes: ['audit:read', 'reports:read'],
};

// ─── Type guards / utilities ──────────────────────────────────────────

describe('isApiKeyScope', () => {
  test('accepts every catalogue scope', () => {
    for (const s of VALID_SCOPES) {
      expect(isApiKeyScope(s)).toBe(true);
    }
  });
  test('rejects bogus scopes', () => {
    expect(isApiKeyScope('admin:full')).toBe(false);
    expect(isApiKeyScope(42)).toBe(false);
  });
});

describe('compareKey', () => {
  test('hash + compareKey agrees', () => {
    const s = new InMemoryApiKeyStore();
    const created = s.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    // Internal hash isn't exposed via redact; verify by re-creating + comparing.
    const verified = s.verify(created.key, NOW);
    expect(verified).not.toBeNull();
    expect(verified!.tenant_id).toBe('BIL');
  });

  test('mismatched length returns false', () => {
    expect(compareKey('apex_short', 'a'.repeat(64))).toBe(false);
  });
});

// ─── validateInput ────────────────────────────────────────────────────

describe('validateInput', () => {
  test('happy path returns canonical input', () => {
    const out = validateInput({ name: '  k  ', scopes: ['audit:read'] }, NOW);
    expect(out.name).toBe('k');
    expect(out.scopes).toEqual(['audit:read']);
    expect(out.expires_at).toBeUndefined();
  });

  test('non-object body rejected', () => {
    expect(() => validateInput('foo', NOW)).toThrow(ApiKeyError);
    expect(() => validateInput(null, NOW)).toThrow(ApiKeyError);
  });

  test('missing name rejected', () => {
    expect(() => validateInput({ scopes: ['audit:read'] }, NOW)).toThrow(/name/);
  });

  test('blank name rejected', () => {
    expect(() => validateInput({ name: '   ', scopes: ['audit:read'] }, NOW)).toThrow(/name/);
  });

  test('overlong name rejected', () => {
    expect(() =>
      validateInput({ name: 'x'.repeat(81), scopes: ['audit:read'] }, NOW),
    ).toThrow(/≤ 80/);
  });

  test('empty scopes[] → invalid_scopes', () => {
    try {
      validateInput({ name: 'k', scopes: [] }, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ApiKeyError).code).toBe('invalid_scopes');
    }
  });

  test('non-array scopes rejected', () => {
    try {
      validateInput({ name: 'k', scopes: 'audit:read' }, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ApiKeyError).code).toBe('invalid_scopes');
    }
  });

  test('invalid scope value rejected', () => {
    try {
      validateInput({ name: 'k', scopes: ['audit:read', 'fake:scope'] }, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ApiKeyError).code).toBe('invalid_scopes');
    }
  });

  test('duplicates deduped silently', () => {
    const out = validateInput(
      { name: 'k', scopes: ['audit:read', 'audit:read', 'reports:read'] },
      NOW,
    );
    expect(out.scopes).toEqual(['audit:read', 'reports:read']);
  });

  test('expires_at must be ISO format', () => {
    try {
      validateInput({ name: 'k', scopes: ['audit:read'], expires_at: 'tomorrow' }, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ApiKeyError).code).toBe('invalid_expires_at');
    }
  });

  test('expires_at in the past rejected', () => {
    try {
      validateInput(
        { name: 'k', scopes: ['audit:read'], expires_at: '2020-01-01T00:00:00Z' },
        NOW,
      );
      fail('expected throw');
    } catch (e) {
      expect((e as ApiKeyError).code).toBe('invalid_expires_at');
    }
  });

  test('expires_at in future accepted', () => {
    const out = validateInput(
      { name: 'k', scopes: ['audit:read'], expires_at: '2027-01-01T00:00:00Z' },
      NOW,
    );
    expect(out.expires_at).toBe('2027-01-01T00:00:00Z');
  });
});

// ─── Store: create ────────────────────────────────────────────────────

describe('InMemoryApiKeyStore.create', () => {
  test('returns full key once + redacted entry shape', () => {
    const s = new InMemoryApiKeyStore();
    const out = s.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    expect(out.key).toMatch(/^apex_[a-z0-9]{12}\.[0-9a-f]{48}$/);
    expect(out.key_id).toMatch(/^key-/);
    expect(out.tenant_id).toBe('BIL');
    expect(out.scopes).toEqual(['audit:read']);
    expect(out.status).toBe('active');
    expect(out.created_by).toBe('admin');
    expect(out.last_used_at).toBeNull();
    expect(out.expires_at).toBeNull();
    expect(out.prefix).toMatch(/^[a-z0-9]{12}$/);
  });

  test('subsequent get does NOT include the key value', () => {
    const s = new InMemoryApiKeyStore();
    const created = s.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    const fetched = s.get('BIL', created.key_id);
    expect(fetched).not.toBeNull();
    expect((fetched as ApiKeyEntry & { key?: string }).key).toBeUndefined();
    expect(fetched!.prefix).toBe(created.prefix);
  });

  test('list does NOT include hash or key value', () => {
    const s = new InMemoryApiKeyStore();
    s.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    const r = s.list('BIL', 1, 10);
    expect(r.items[0]).not.toHaveProperty('hash');
    expect(r.items[0]).not.toHaveProperty('key');
  });

  test('expires_at is honoured', () => {
    const s = new InMemoryApiKeyStore();
    const out = s.create(
      'BIL',
      { name: 'k', scopes: ['audit:read'], expires_at: '2027-01-01T00:00:00Z' },
      'admin',
      NOW,
    );
    expect(out.expires_at).toBe('2027-01-01T00:00:00Z');
  });

  test('cap_reached after N active', () => {
    const s = new InMemoryApiKeyStore({ cap: 2 });
    s.create('BIL', { name: 'a', scopes: ['audit:read'] }, 'admin', NOW);
    s.create('BIL', { name: 'b', scopes: ['audit:read'] }, 'admin', NOW);
    try {
      s.create('BIL', { name: 'c', scopes: ['audit:read'] }, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ApiKeyError).code).toBe('cap_reached');
    }
  });

  test('revoked keys do not count toward cap', () => {
    const s = new InMemoryApiKeyStore({ cap: 2 });
    const a = s.create('BIL', { name: 'a', scopes: ['audit:read'] }, 'admin', NOW);
    s.create('BIL', { name: 'b', scopes: ['audit:read'] }, 'admin', NOW);
    s.revoke('BIL', a.key_id, 'admin', NOW);
    // Now there's only 1 active → can create again
    const c = s.create('BIL', { name: 'c', scopes: ['audit:read'] }, 'admin', NOW);
    expect(c.key_id).not.toBe(a.key_id);
  });

  test('missing created_by rejected', () => {
    const s = new InMemoryApiKeyStore();
    expect(() => s.create('BIL', { name: 'k', scopes: ['audit:read'] }, '', NOW)).toThrow(
      /created_by/,
    );
  });

  test('cross-tenant: keys are tenant-scoped', () => {
    const s = new InMemoryApiKeyStore();
    const a = s.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    s.create('BANK_DEMO', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    expect(s.get('BIL', a.key_id)?.key_id).toBe(a.key_id);
    expect(s.get('BANK_DEMO', a.key_id)).toBeNull();
  });
});

// ─── Store: revoke / delete / touch / verify ──────────────────────────

describe('InMemoryApiKeyStore.revoke', () => {
  test('flips status + records revoked_at + revoked_by', () => {
    const s = new InMemoryApiKeyStore();
    const a = s.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    const r = s.revoke('BIL', a.key_id, 'compliance.lead', NOW);
    expect(r.status).toBe('revoked');
    expect(r.revoked_at).toBe(NOW.toISOString());
    expect(r.revoked_by).toBe('compliance.lead');
  });

  test('unknown key throws unknown_key', () => {
    const s = new InMemoryApiKeyStore();
    try {
      s.revoke('BIL', 'NO-SUCH', 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ApiKeyError).code).toBe('unknown_key');
    }
  });

  test('2nd revoke throws already_revoked', () => {
    const s = new InMemoryApiKeyStore();
    const a = s.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    s.revoke('BIL', a.key_id, 'admin', NOW);
    try {
      s.revoke('BIL', a.key_id, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ApiKeyError).code).toBe('already_revoked');
    }
  });

  test('missing revoked_by rejected', () => {
    const s = new InMemoryApiKeyStore();
    const a = s.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    expect(() => s.revoke('BIL', a.key_id, '', NOW)).toThrow(/revoked_by/);
  });
});

describe('InMemoryApiKeyStore.delete', () => {
  test('returns true on hit, false on miss, false on 2nd attempt', () => {
    const s = new InMemoryApiKeyStore();
    const a = s.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    expect(s.delete('BIL', a.key_id)).toBe(true);
    expect(s.delete('BIL', a.key_id)).toBe(false);
    expect(s.get('BIL', a.key_id)).toBeNull();
  });

  test('verify of deleted key returns null (prefix index also cleaned)', () => {
    const s = new InMemoryApiKeyStore();
    const a = s.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    s.delete('BIL', a.key_id);
    expect(s.verify(a.key, NOW)).toBeNull();
  });
});

describe('InMemoryApiKeyStore.touch', () => {
  test('bumps last_used_at on active key', () => {
    const s = new InMemoryApiKeyStore();
    const a = s.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    const later = new Date('2026-05-06T01:00:00.000Z');
    const t = s.touch('BIL', a.key_id, later);
    expect(t).not.toBeNull();
    expect(t!.last_used_at).toBe(later.toISOString());
  });

  test('returns null on revoked key', () => {
    const s = new InMemoryApiKeyStore();
    const a = s.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    s.revoke('BIL', a.key_id, 'admin', NOW);
    expect(s.touch('BIL', a.key_id, NOW)).toBeNull();
  });

  test('returns null on expired key', () => {
    const s = new InMemoryApiKeyStore();
    const a = s.create(
      'BIL',
      { name: 'k', scopes: ['audit:read'], expires_at: '2026-05-04T00:00:00Z' },
      'admin',
      new Date('2026-05-03T00:00:00Z'),
    );
    expect(s.touch('BIL', a.key_id, NOW)).toBeNull();
  });

  test('returns null on unknown key', () => {
    const s = new InMemoryApiKeyStore();
    expect(s.touch('BIL', 'NO-SUCH', NOW)).toBeNull();
  });
});

describe('InMemoryApiKeyStore.verify', () => {
  test('happy: presented key resolves to (tenant, entry)', () => {
    const s = new InMemoryApiKeyStore();
    const a = s.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    const v = s.verify(a.key, NOW);
    expect(v).not.toBeNull();
    expect(v!.tenant_id).toBe('BIL');
    expect(v!.entry.key_id).toBe(a.key_id);
  });

  test('non-apex_ key returns null', () => {
    const s = new InMemoryApiKeyStore();
    expect(s.verify('Bearer foo', NOW)).toBeNull();
  });

  test('mangled key returns null', () => {
    const s = new InMemoryApiKeyStore();
    s.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    expect(s.verify('apex_aaaaaaaaaaaa.deadbeef', NOW)).toBeNull();
  });

  test('revoked key fails verify', () => {
    const s = new InMemoryApiKeyStore();
    const a = s.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    s.revoke('BIL', a.key_id, 'admin', NOW);
    expect(s.verify(a.key, NOW)).toBeNull();
  });

  test('expired key fails verify', () => {
    const s = new InMemoryApiKeyStore();
    const created = s.create(
      'BIL',
      { name: 'k', scopes: ['audit:read'], expires_at: '2026-06-01T00:00:00Z' },
      'admin',
      NOW,
    );
    expect(s.verify(created.key, NOW)).not.toBeNull();
    expect(s.verify(created.key, new Date('2026-07-01T00:00:00Z'))).toBeNull();
  });

  test('verify uses constant-time compare (substituting wrong secret fails)', () => {
    const s = new InMemoryApiKeyStore();
    const a = s.create('BIL', { name: 'k', scopes: ['audit:read'] }, 'admin', NOW);
    const tampered = `apex_${a.prefix}.${'0'.repeat(48)}`;
    expect(s.verify(tampered, NOW)).toBeNull();
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('POST /v1/admin/api-keys', () => {
  test('admin: 201 with key + redacted entry', async () => {
    const { app } = makeKeysApp('admin');
    const r = await request(app)
      .post('/v1/admin/api-keys')
      .set(TH_BIL)
      .set('X-APEX-USER', 'compliance.lead')
      .send(VALID_BODY);
    expect(r.status).toBe(201);
    const body = r.body.body as ApiKeyCreated;
    expect(body.key).toMatch(/^apex_/);
    expect(body.created_by).toBe('compliance.lead');
    expect(body.scopes).toEqual(['audit:read', 'reports:read']);
  });

  test('accepts enveloped body', async () => {
    const { app } = makeKeysApp('admin');
    const r = await request(app)
      .post('/v1/admin/api-keys')
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: VALID_BODY });
    expect(r.status).toBe(201);
  });

  test('default created_by = admin when no X-APEX-USER', async () => {
    const { app } = makeKeysApp('admin');
    const r = await request(app).post('/v1/admin/api-keys').set(TH_BIL).send(VALID_BODY);
    expect(r.body.body.created_by).toBe('admin');
  });

  test('blank name → 400 EWS_400_invalid_input', async () => {
    const { app } = makeKeysApp('admin');
    const r = await request(app)
      .post('/v1/admin/api-keys')
      .set(TH_BIL)
      .send({ name: '', scopes: ['audit:read'] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('empty scopes → 400 EWS_400_invalid_scopes', async () => {
    const { app } = makeKeysApp('admin');
    const r = await request(app)
      .post('/v1/admin/api-keys')
      .set(TH_BIL)
      .send({ name: 'k', scopes: [] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_scopes');
  });

  test('invalid scope → 400', async () => {
    const { app } = makeKeysApp('admin');
    const r = await request(app)
      .post('/v1/admin/api-keys')
      .set(TH_BIL)
      .send({ name: 'k', scopes: ['fake:scope'] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_scopes');
  });

  test('past expires_at → 400 EWS_400_invalid_expires_at', async () => {
    const { app } = makeKeysApp('admin');
    const r = await request(app)
      .post('/v1/admin/api-keys')
      .set(TH_BIL)
      .send({ ...VALID_BODY, expires_at: '2020-01-01T00:00:00Z' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_expires_at');
  });

  test('cap_reached → 409', async () => {
    const store = new InMemoryApiKeyStore({ cap: 1 });
    const built = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      apiKeyStore: store,
      now: () => NOW,
      getRole: () => 'admin',
    });
    await request(built.app).post('/v1/admin/api-keys').set(TH_BIL).send(VALID_BODY);
    const r = await request(built.app).post('/v1/admin/api-keys').set(TH_BIL).send(VALID_BODY);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_cap_reached');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeKeysApp('case_owner');
    const r = await request(app).post('/v1/admin/api-keys').set(TH_BIL).send(VALID_BODY);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/admin/api-keys', () => {
  test('admin: 200 newest-first list', async () => {
    const { app } = makeKeysApp('admin');
    await request(app).post('/v1/admin/api-keys').set(TH_BIL).send({ ...VALID_BODY, name: 'A' });
    await request(app).post('/v1/admin/api-keys').set(TH_BIL).send({ ...VALID_BODY, name: 'B' });
    const r = await request(app).get('/v1/admin/api-keys').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
  });

  test('list items do NOT carry the secret key value', async () => {
    const { app } = makeKeysApp('admin');
    await request(app).post('/v1/admin/api-keys').set(TH_BIL).send(VALID_BODY);
    const r = await request(app).get('/v1/admin/api-keys').set(TH_BIL);
    expect(r.body.body.items[0]).not.toHaveProperty('key');
    expect(r.body.body.items[0]).not.toHaveProperty('hash');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeKeysApp('case_owner');
    const r = await request(app).get('/v1/admin/api-keys').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/admin/api-keys/:key_id', () => {
  test('200 on hit', async () => {
    const { app } = makeKeysApp('admin');
    const created = await request(app).post('/v1/admin/api-keys').set(TH_BIL).send(VALID_BODY);
    const id = created.body.body.key_id;
    const r = await request(app).get(`/v1/admin/api-keys/${id}`).set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.key_id).toBe(id);
    expect(r.body.body).not.toHaveProperty('key');
  });

  test('404 on miss with EWS_404_unknown_key', async () => {
    const { app } = makeKeysApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/key-NO').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_key');
  });

  test('cross-tenant 404', async () => {
    const { app } = makeKeysApp('admin');
    const created = await request(app).post('/v1/admin/api-keys').set(TH_BIL).send(VALID_BODY);
    const id = created.body.body.key_id;
    const r = await request(app)
      .get(`/v1/admin/api-keys/${id}`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(404);
  });
});

describe('POST /v1/admin/api-keys/:key_id/revoke', () => {
  test('200 with revoked entry', async () => {
    const { app } = makeKeysApp('admin');
    const created = await request(app).post('/v1/admin/api-keys').set(TH_BIL).send(VALID_BODY);
    const id = created.body.body.key_id;
    const r = await request(app)
      .post(`/v1/admin/api-keys/${id}/revoke`)
      .set(TH_BIL)
      .set('X-APEX-USER', 'compliance.lead')
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('revoked');
    expect(r.body.body.revoked_by).toBe('compliance.lead');
  });

  test('404 on unknown', async () => {
    const { app } = makeKeysApp('admin');
    const r = await request(app)
      .post('/v1/admin/api-keys/key-NO/revoke')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_key');
  });

  test('409 on already_revoked', async () => {
    const { app } = makeKeysApp('admin');
    const created = await request(app).post('/v1/admin/api-keys').set(TH_BIL).send(VALID_BODY);
    const id = created.body.body.key_id;
    await request(app).post(`/v1/admin/api-keys/${id}/revoke`).set(TH_BIL).send({});
    const r = await request(app).post(`/v1/admin/api-keys/${id}/revoke`).set(TH_BIL).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_already_revoked');
  });
});

describe('DELETE /v1/admin/api-keys/:key_id', () => {
  test('204 on success then 404 on second delete', async () => {
    const { app } = makeKeysApp('admin');
    const created = await request(app).post('/v1/admin/api-keys').set(TH_BIL).send(VALID_BODY);
    const id = created.body.body.key_id;
    const r = await request(app).delete(`/v1/admin/api-keys/${id}`).set(TH_BIL);
    expect(r.status).toBe(204);
    const again = await request(app).delete(`/v1/admin/api-keys/${id}`).set(TH_BIL);
    expect(again.status).toBe(404);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeKeysApp('case_owner');
    const r = await request(app).delete('/v1/admin/api-keys/key-X').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

// ─── No-regression ────────────────────────────────────────────────────

describe('No-regression: /v1/admin/config still works', () => {
  test('GET /v1/admin/config still 200', async () => {
    const { app } = makeKeysApp('admin');
    const r = await request(app).get('/v1/admin/config').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('GET /v1/admin/config/categories still 200 (api-keys path didn\'t shadow)', async () => {
    const { app } = makeKeysApp('admin');
    const r = await request(app).get('/v1/admin/config/categories').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
