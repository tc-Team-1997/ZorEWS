// @ts-nocheck
// services/bff/__tests__/config_schema_drift.test.ts
// T6 M13.24 — Config schema drift detection tests

import { detectConfigSchemaDrift } from '../src/config_schema_drift';
import { InMemoryConfigStore, DEFAULTS } from '../src/admin_config';

const NOW = new Date('2026-05-22T12:00:00.000Z');

describe('detectConfigSchemaDrift — pure resolver', () => {
  test('empty overrides → schema_healthy=true, no drifted keys', () => {
    const store = new InMemoryConfigStore();
    const r = detectConfigSchemaDrift(store, 'BANK_DEMO', NOW);
    expect(r.schema_healthy).toBe(true);
    expect(r.drifted_keys).toEqual([]);
    expect(r.total_keys).toBe(DEFAULTS.length);
  });

  test('total_keys = DEFAULTS.length', () => {
    const store = new InMemoryConfigStore();
    const r = detectConfigSchemaDrift(store, 'BANK_DEMO', NOW);
    expect(r.total_keys).toBe(DEFAULTS.length);
  });

  test('correct-type override → not drifted', () => {
    const store = new InMemoryConfigStore();
    // Find a number key and set with number
    const numKey = DEFAULTS.find((d) => d.type === 'number');
    if (numKey) {
      store.set('BANK_DEMO', numKey.key, numKey.default_value, 'alice', NOW);
    }
    const r = detectConfigSchemaDrift(store, 'BANK_DEMO', NOW);
    expect(r.schema_healthy).toBe(true);
  });

  test('generated_at matches now', () => {
    const store = new InMemoryConfigStore();
    const r = detectConfigSchemaDrift(store, 'BANK_DEMO', NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
  });

  test('tenant scoping: BIL overrides not seen by BANK_DEMO', () => {
    const store = new InMemoryConfigStore();
    const numKey = DEFAULTS.find((d) => d.type === 'number');
    if (numKey) {
      store.set('BIL', numKey.key, numKey.default_value, 'alice', NOW);
    }
    const r = detectConfigSchemaDrift(store, 'BANK_DEMO', NOW);
    expect(r.drifted_keys).toHaveLength(0);
  });

  test('default values → not counted as drifted (only overrides)', () => {
    const store = new InMemoryConfigStore();
    const r = detectConfigSchemaDrift(store, 'BANK_DEMO', NOW);
    expect(r.drifted_keys).toHaveLength(0);
  });

  test('throws on empty tenant_id', () => {
    const store = new InMemoryConfigStore();
    expect(() => detectConfigSchemaDrift(store, '', NOW)).toThrow();
  });

  test('schema_healthy = drifted_keys.length === 0', () => {
    const store = new InMemoryConfigStore();
    const r = detectConfigSchemaDrift(store, 'BANK_DEMO', NOW);
    expect(r.schema_healthy).toBe(r.drifted_keys.length === 0);
  });
});

// ─── Route tests ──────────────────────────────────────────────────────

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('GET /v1/admin/config/schema-drift', () => {
  test('admin 200 with envelope', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/config/schema-drift')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(typeof r.body.body.schema_healthy).toBe('boolean');
    expect(typeof r.body.body.total_keys).toBe('number');
  });

  test('403 for field_officer', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/config/schema-drift')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/config/schema-drift')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });

  test('cross-tenant isolation: BANK_DEMO vs BIL', async () => {
    const { app } = makeApp({});
    const r1 = await request(app)
      .get('/v1/admin/config/schema-drift')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BANK_DEMO' });
    const r2 = await request(app)
      .get('/v1/admin/config/schema-drift')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});
