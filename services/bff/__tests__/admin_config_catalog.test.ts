// services/bff/__tests__/admin_config_catalog.test.ts
//
// T6 M13.10 — Admin config schema catalog introspection.

import request from 'supertest';
import { introspectConfigCatalog } from '../src/admin_config_catalog';
import { DEFAULTS, listCategories } from '../src/admin_config';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── introspectConfigCatalog — pure ──────────────────────────────────

describe('M13.10 — introspectConfigCatalog — shape', () => {
  test('total_keys matches DEFAULTS length', () => {
    const cat = introspectConfigCatalog();
    expect(cat.total_keys).toBe(DEFAULTS.length);
  });

  test('by_type sum equals total_keys', () => {
    const cat = introspectConfigCatalog();
    const sum = cat.by_type.number + cat.by_type.string + cat.by_type.boolean + cat.by_type.json;
    expect(sum).toBe(cat.total_keys);
  });

  test('categories cover every category that has at least one key', () => {
    const cat = introspectConfigCatalog();
    const expected = new Set(DEFAULTS.map((d) => d.category));
    expect(new Set(cat.categories.map((c) => c.category))).toEqual(expected);
  });

  test('categories ordered by listCategories canonical order', () => {
    const cat = introspectConfigCatalog();
    const expectedOrder = listCategories().filter((c) => DEFAULTS.some((d) => d.category === c));
    expect(cat.categories.map((c) => c.category)).toEqual(expectedOrder);
  });

  test('keys within each category sorted alphabetically', () => {
    const cat = introspectConfigCatalog();
    for (const group of cat.categories) {
      const keys = group.keys.map((k) => k.key);
      expect(keys).toEqual([...keys].sort());
    }
  });

  test('every key carries the full ConfigDef shape', () => {
    const cat = introspectConfigCatalog();
    for (const group of cat.categories) {
      for (const def of group.keys) {
        expect(typeof def.key).toBe('string');
        expect(def.key.length).toBeGreaterThan(0);
        expect(['number', 'string', 'boolean', 'json']).toContain(def.type);
        expect(typeof def.description).toBe('string');
        expect(def.default_value).toBeDefined();
        expect(def.category).toBe(group.category);
      }
    }
  });

  test('per-group key_count matches keys[].length', () => {
    const cat = introspectConfigCatalog();
    for (const group of cat.categories) {
      expect(group.key_count).toBe(group.keys.length);
    }
  });
});

describe('M13.10 — by_type counts match recount', () => {
  test('manual recount over DEFAULTS matches by_type', () => {
    const expected = { number: 0, string: 0, boolean: 0, json: 0 };
    for (const def of DEFAULTS) expected[def.type] += 1;
    const cat = introspectConfigCatalog();
    expect(cat.by_type).toEqual(expected);
  });
});

// ─── GET /v1/admin/config/catalog ────────────────────────────────────

function makeCatalogApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M13.10 — GET /v1/admin/config/catalog', () => {
  test('admin → 200 with full catalog', async () => {
    const { app } = makeCatalogApp('admin');
    const r = await request(app).get('/v1/admin/config/catalog').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(DEFAULTS.length);
    expect(Array.isArray(r.body.body.categories)).toBe(true);
    expect(r.body.body.categories.length).toBeGreaterThan(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCatalogApp('case_owner');
    const r = await request(app).get('/v1/admin/config/catalog').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static — same response across tenants', async () => {
    const { app } = makeCatalogApp('admin');
    const bil = await request(app).get('/v1/admin/config/catalog').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/admin/config/catalog')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.status).toBe(200);
    expect(bank.status).toBe(200);
    expect(bil.body.body).toEqual(bank.body.body);
  });

  test('M13.1 GET /v1/admin/config still works (catalog route is additive)', async () => {
    const { app } = makeCatalogApp('admin');
    const r = await request(app).get('/v1/admin/config').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
