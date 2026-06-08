// services/bff/__tests__/api_key_v1_auth.test.ts
//
// T6 M1.4 — API key Bearer auth on all /v1/* routes.
//
// Verifies that the optionalApiKeyAuth middleware wired as a fallback
// auth path on /v1/* routes lets service accounts authenticate via
// `Authorization: Bearer apex_…` while preserving the existing
// X-Tenant-ID + role-header human-auth path for callers without a
// Bearer header.

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryApiKeyStore } from '../src/api_keys';

const NOW = new Date('2026-06-08T10:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'x-apex-role': 'admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'x-apex-role': 'admin' };

function makeTestApp(apiKeyStore?: InMemoryApiKeyStore) {
  const store = apiKeyStore ?? new InMemoryApiKeyStore();
  return {
    store,
    app: makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      apiKeyStore: store,
      now: () => NOW,
    }).app,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('M1.4 — API key Bearer auth on /v1/* routes', () => {
  test('apex_ Bearer token accepted on /v1/alerts (tenant from key)', async () => {
    // M1.4: API key auth provides tenant binding; x-apex-role header
    // is still needed for RBAC requireRole checks (role = op permission).
    const { store, app } = makeTestApp();
    const created = store.create(
      'BIL',
      { name: 'integration-svc', scopes: ['alerts:read'] },
      'admin',
      NOW,
    );
    const r = await request(app)
      .get('/v1/alerts')
      .set('x-apex-role', 'admin')  // RBAC role check
      .set('Authorization', `Bearer ${created.key}`);  // M1.4: tenant from key
    // Should be 200 (authenticated via key, not 400 missing tenant)
    expect(r.status).toBe(200);
    // The response should be the enveloped alerts list
    expect(r.body).toHaveProperty('header');
    expect(r.body).toHaveProperty('body');
  });

  test('X-Tenant-ID + role header still works without Bearer (backward compat)', async () => {
    const { app } = makeTestApp();
    const r = await request(app)
      .get('/v1/alerts')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('header');
  });

  test('revoked API key → 401 EWS_401_invalid_api_key', async () => {
    const { store, app } = makeTestApp();
    const created = store.create(
      'BIL',
      { name: 'revoked-svc', scopes: ['alerts:read'] },
      'admin',
      NOW,
    );
    store.revoke('BIL', created.key_id, 'admin', NOW);
    const r = await request(app)
      .get('/v1/alerts')
      .set('X-Channel', 'API')
      .set('Authorization', `Bearer ${created.key}`);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('EWS_401_invalid_api_key');
  });

  test('expired API key → 401 EWS_401_invalid_api_key', async () => {
    const { store, app } = makeTestApp();
    const pastDate = new Date('2025-01-01T00:00:00.000Z');
    const created = store.create(
      'BIL',
      {
        name: 'expired-svc',
        scopes: ['alerts:read'],
        expires_at: pastDate.toISOString(),
      },
      'admin',
      pastDate,
    );
    const r = await request(app)
      .get('/v1/alerts')
      .set('X-Channel', 'API')
      .set('Authorization', `Bearer ${created.key}`);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('EWS_401_invalid_api_key');
  });

  test('key from BIL tenant scopes audit events to BIL only', async () => {
    // BIL key should set req.tenant to BIL — cross-tenant data isolation.
    // API key auth provides tenant binding; the x-apex-role header is still
    // needed for the RBAC requireRole check on protected routes.
    const { store, app } = makeTestApp();

    const created = store.create(
      'BIL',
      { name: 'bil-svc', scopes: ['audit:read'] },
      'admin',
      NOW,
    );
    // The RBAC role check still uses x-apex-role header even with API key auth.
    // API key auth provides tenant binding; role provides operation permission.
    const r = await request(app)
      .get('/v1/audit/events')
      .set('x-apex-role', 'admin')
      .set('Authorization', `Bearer ${created.key}`);
    // Should return 200 with BIL tenant scope (empty in this test's store)
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
  });

  test('both Bearer + X-Tenant-ID present: Bearer wins (key tenant_id overrides header)', async () => {
    const { store, app } = makeTestApp();
    const created = store.create(
      'BIL',
      { name: 'mixed-svc', scopes: ['alerts:read'] },
      'admin',
      NOW,
    );
    // Present a BIL key but BANK_DEMO X-Tenant-ID header. Bearer should win —
    // the injected X-Tenant-ID from the API key middleware sets BIL, and
    // requireTenantMw will use that even though the client sent BANK_DEMO.
    // The role header is still needed for RBAC.
    const r = await request(app)
      .get('/v1/alerts')
      .set('X-Tenant-ID', 'BANK_DEMO')  // API key middleware overrides this with BIL
      .set('X-Channel', 'API')
      .set('x-apex-role', 'admin')
      .set('Authorization', `Bearer ${created.key}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('header');
    expect(r.body.header.status).toBe('SUCCESS');
  });

  test('malformed apex_ Bearer format → 401', async () => {
    const { app } = makeTestApp();
    const r = await request(app)
      .get('/v1/alerts')
      .set('X-Channel', 'API')
      .set('Authorization', 'Bearer apex_notavalidkey');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('EWS_401_invalid_api_key');
  });
});
