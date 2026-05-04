// services/bff/__tests__/admin_config.test.ts
//
// T6 M13.1 — Admin Configuration registry.
//
// Layered tests:
//   1. Schema invariants — keys unique, every default validates against
//      its declared type, categories enumerated correctly.
//   2. InMemoryConfigStore — list/get/set/reset behaviour, type
//      validation, tenant isolation, override metadata.
//   3. Routes — RBAC, envelope, validation errors, 404 paths.

import request from 'supertest';
import {
  ConfigValidationError,
  DEFAULTS,
  InMemoryConfigStore,
  listCategories,
  listDefaultKeys,
  validateValue,
  type ConfigDef,
} from '../src/admin_config';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeCfgApp(role: string = 'admin', configStore?: InMemoryConfigStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    configStore: configStore ?? new InMemoryConfigStore(),
  });
}

// ─── Schema invariants ─────────────────────────────────────────────────

describe('DEFAULTS schema', () => {
  test('keys are unique', () => {
    const keys = DEFAULTS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every default_value validates against its declared type', () => {
    for (const def of DEFAULTS) {
      expect(() => validateValue(def, def.default_value)).not.toThrow();
    }
  });

  test('listDefaultKeys returns every key', () => {
    expect(listDefaultKeys().length).toBe(DEFAULTS.length);
  });

  test('listCategories enumerates the 5 categories in stable order', () => {
    const cats = listCategories();
    expect(cats).toEqual(['alerts', 'notifications', 'reporting', 'scoring', 'features']);
  });

  test('every category has at least one entry', () => {
    const counts = new Map<string, number>();
    for (const d of DEFAULTS) counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
    for (const c of listCategories()) {
      expect(counts.get(c) ?? 0).toBeGreaterThan(0);
    }
  });

  test('schema includes the BIL operational anchors (alerts SLAs, scoring thresholds)', () => {
    const keys = new Set(DEFAULTS.map((d) => d.key));
    expect(keys.has('alerts.red_sla_hours')).toBe(true);
    expect(keys.has('alerts.orange_sla_hours')).toBe(true);
    expect(keys.has('alerts.yellow_sla_hours')).toBe(true);
    expect(keys.has('scoring.default_thresholds.low_max')).toBe(true);
    expect(keys.has('scoring.default_thresholds.medium_max')).toBe(true);
  });
});

describe('validateValue()', () => {
  const numberDef: ConfigDef = {
    key: 'k',
    category: 'alerts',
    type: 'number',
    description: '',
    default_value: 0,
  };
  const stringDef: ConfigDef = { ...numberDef, type: 'string', default_value: 'x' };
  const boolDef: ConfigDef = { ...numberDef, type: 'boolean', default_value: false };
  const jsonDef: ConfigDef = { ...numberDef, type: 'json', default_value: {} };

  test('number: accepts finite numbers, rejects NaN/Infinity/non-number', () => {
    expect(validateValue(numberDef, 42)).toBe(42);
    expect(validateValue(numberDef, -1.5)).toBe(-1.5);
    expect(() => validateValue(numberDef, NaN)).toThrow(/finite number/);
    expect(() => validateValue(numberDef, Infinity)).toThrow(/finite number/);
    expect(() => validateValue(numberDef, '42')).toThrow();
  });

  test('string: accepts non-empty strings, rejects empty + non-string', () => {
    expect(validateValue(stringDef, 'hello')).toBe('hello');
    expect(() => validateValue(stringDef, '')).toThrow(/non-empty string/);
    expect(() => validateValue(stringDef, 5)).toThrow();
  });

  test('boolean: accepts only true/false', () => {
    expect(validateValue(boolDef, true)).toBe(true);
    expect(validateValue(boolDef, false)).toBe(false);
    expect(() => validateValue(boolDef, 'true')).toThrow();
    expect(() => validateValue(boolDef, 1)).toThrow();
  });

  test('json: accepts plain objects, rejects arrays + primitives', () => {
    expect(validateValue(jsonDef, { a: 1 })).toEqual({ a: 1 });
    expect(() => validateValue(jsonDef, [1, 2])).toThrow(/JSON object/);
    expect(() => validateValue(jsonDef, null)).toThrow();
    expect(() => validateValue(jsonDef, 'hi')).toThrow();
  });

  test('throws ConfigValidationError with code invalid_value', () => {
    try {
      validateValue(numberDef, 'oops');
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      expect((e as ConfigValidationError).code).toBe('invalid_value');
    }
  });
});

// ─── InMemoryConfigStore ───────────────────────────────────────────────

describe('InMemoryConfigStore', () => {
  test('list() returns one entry per declared key, all is_default=true initially', () => {
    const s = new InMemoryConfigStore();
    const items = s.list('BIL');
    expect(items.length).toBe(DEFAULTS.length);
    for (const it of items) {
      expect(it.is_default).toBe(true);
      expect(it.updated_at).toBeNull();
      expect(it.updated_by).toBeNull();
    }
  });

  test('get() returns null for unknown key', () => {
    const s = new InMemoryConfigStore();
    expect(s.get('BIL', 'no.such.key')).toBeNull();
  });

  test('get() returns default-marked entry for known key', () => {
    const s = new InMemoryConfigStore();
    const e = s.get('BIL', 'alerts.red_sla_hours');
    expect(e).not.toBeNull();
    expect(e!.is_default).toBe(true);
    expect(e!.value).toBe(4);
  });

  test('set() applies override; subsequent get() reflects it with metadata', () => {
    const s = new InMemoryConfigStore();
    const e = s.set('BIL', 'alerts.red_sla_hours', 2, 'taniya', NOW);
    expect(e.value).toBe(2);
    expect(e.is_default).toBe(false);
    expect(e.updated_at).toBe(NOW.toISOString());
    expect(e.updated_by).toBe('taniya');
    const g = s.get('BIL', 'alerts.red_sla_hours');
    expect(g!.value).toBe(2);
  });

  test('set() rejects mismatched type', () => {
    const s = new InMemoryConfigStore();
    expect(() => s.set('BIL', 'alerts.red_sla_hours', 'two', 'taniya', NOW)).toThrow(
      /finite number/,
    );
  });

  test('set() throws ConfigValidationError(unknown_key) for unknown key', () => {
    const s = new InMemoryConfigStore();
    try {
      s.set('BIL', 'no.such.key', 1, 'taniya', NOW);
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      expect((e as ConfigValidationError).code).toBe('unknown_key');
    }
  });

  test('reset() removes the override → entry reverts to default', () => {
    const s = new InMemoryConfigStore();
    s.set('BIL', 'alerts.red_sla_hours', 2, 'taniya', NOW);
    expect(s.get('BIL', 'alerts.red_sla_hours')!.value).toBe(2);
    const after = s.reset('BIL', 'alerts.red_sla_hours');
    expect(after.value).toBe(4);
    expect(after.is_default).toBe(true);
    expect(after.updated_at).toBeNull();
  });

  test('reset() on a key with no override is a no-op', () => {
    const s = new InMemoryConfigStore();
    const before = s.get('BIL', 'alerts.red_sla_hours');
    const after = s.reset('BIL', 'alerts.red_sla_hours');
    expect(after).toEqual(before);
  });

  test('reset() throws unknown_key for unknown key', () => {
    const s = new InMemoryConfigStore();
    expect(() => s.reset('BIL', 'no.such.key')).toThrow(/unknown config key/);
  });

  test('tenant isolation — BIL override does not affect BANK_DEMO', () => {
    const s = new InMemoryConfigStore();
    s.set('BIL', 'alerts.red_sla_hours', 2, 't', NOW);
    expect(s.get('BIL', 'alerts.red_sla_hours')!.value).toBe(2);
    expect(s.get('BANK_DEMO', 'alerts.red_sla_hours')!.value).toBe(4);
    expect(s.get('BANK_DEMO', 'alerts.red_sla_hours')!.is_default).toBe(true);
  });

  test('list() preserves declared order', () => {
    const s = new InMemoryConfigStore();
    const expectedKeys = DEFAULTS.map((d) => d.key);
    expect(s.list('BIL').map((e) => e.key)).toEqual(expectedKeys);
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/admin/config/categories', () => {
  test('admin: returns the 5 categories', async () => {
    const { app } = makeCfgApp('admin');
    const r = await request(app).get('/v1/admin/config/categories').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.items).toEqual([
      'alerts',
      'notifications',
      'reporting',
      'scoring',
      'features',
    ]);
  });

  test('non-admin role → 403', async () => {
    const { app } = makeCfgApp('risk_analyst');
    const r = await request(app).get('/v1/admin/config/categories').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/admin/config', () => {
  test('admin: returns every entry, all is_default=true initially', async () => {
    const { app } = makeCfgApp('admin');
    const r = await request(app).get('/v1/admin/config').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(DEFAULTS.length);
    expect(r.body.body.category).toBeNull();
    for (const it of r.body.body.items) {
      expect(it.is_default).toBe(true);
    }
  });

  test('?category=alerts narrows to alerts entries', async () => {
    const { app } = makeCfgApp('admin');
    const r = await request(app).get('/v1/admin/config?category=alerts').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.category).toBe('alerts');
    for (const it of r.body.body.items) {
      expect(it.category).toBe('alerts');
    }
    expect(r.body.body.total).toBeGreaterThanOrEqual(3); // at least the 3 SLA knobs
  });

  test('?category=invalid → 400 EWS_400_invalid_category', async () => {
    const { app } = makeCfgApp('admin');
    const r = await request(app).get('/v1/admin/config?category=bogus').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_category');
  });

  test('non-admin role → 403', async () => {
    const { app } = makeCfgApp('risk_analyst');
    const r = await request(app).get('/v1/admin/config').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/admin/config/:key', () => {
  test('known key returns the entry', async () => {
    const { app } = makeCfgApp('admin');
    const r = await request(app).get('/v1/admin/config/alerts.red_sla_hours').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.key).toBe('alerts.red_sla_hours');
    expect(r.body.body.value).toBe(4);
    expect(r.body.body.is_default).toBe(true);
  });

  test('unknown key → 404 EWS_404_unknown_key', async () => {
    const { app } = makeCfgApp('admin');
    const r = await request(app).get('/v1/admin/config/no.such.key').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_key');
  });
});

describe('PUT /v1/admin/config/:key', () => {
  test('valid value sets the override', async () => {
    const store = new InMemoryConfigStore();
    const { app } = makeCfgApp('admin', store);
    const r = await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send({ value: 2 });
    expect(r.status).toBe(200);
    expect(r.body.body.value).toBe(2);
    expect(r.body.body.is_default).toBe(false);
    expect(r.body.body.updated_by).toBe('taniya');
    // Persists via store
    expect(store.get('BIL', 'alerts.red_sla_hours')!.value).toBe(2);
  });

  test('accepts an enveloped request body', async () => {
    const store = new InMemoryConfigStore();
    const { app } = makeCfgApp('admin', store);
    const r = await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: { value: 1 } });
    expect(r.status).toBe(200);
    expect(r.body.body.value).toBe(1);
  });

  test('mismatched type → 400 EWS_400_invalid_value', async () => {
    const { app } = makeCfgApp('admin');
    const r = await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({ value: 'two' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_value');
  });

  test('unknown key → 404 EWS_404_unknown_key', async () => {
    const { app } = makeCfgApp('admin');
    const r = await request(app)
      .put('/v1/admin/config/no.such.key')
      .set(TH_BIL)
      .send({ value: 1 });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_key');
  });

  test('missing value field → 400', async () => {
    const { app } = makeCfgApp('admin');
    const r = await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
  });

  test('default updated_by is "admin" when no x-apex-user header', async () => {
    const store = new InMemoryConfigStore();
    const { app } = makeCfgApp('admin', store);
    const r = await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({ value: 1 });
    expect(r.status).toBe(200);
    expect(r.body.body.updated_by).toBe('admin');
  });

  test('non-admin role → 403', async () => {
    const { app } = makeCfgApp('risk_analyst');
    const r = await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({ value: 1 });
    expect(r.status).toBe(403);
  });
});

describe('DELETE /v1/admin/config/:key', () => {
  test('clears override → entry reverts to default', async () => {
    const store = new InMemoryConfigStore();
    store.set('BIL', 'alerts.red_sla_hours', 2, 'taniya', NOW);
    const { app } = makeCfgApp('admin', store);
    const r = await request(app)
      .delete('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.value).toBe(4);
    expect(r.body.body.is_default).toBe(true);
  });

  test('unknown key → 404 EWS_404_unknown_key', async () => {
    const { app } = makeCfgApp('admin');
    const r = await request(app).delete('/v1/admin/config/no.such.key').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_key');
  });

  test('non-admin role → 403', async () => {
    const { app } = makeCfgApp('risk_analyst');
    const r = await request(app).delete('/v1/admin/config/alerts.red_sla_hours').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('Tenant isolation through routes', () => {
  test('BIL override does not affect BANK_DEMO read', async () => {
    const store = new InMemoryConfigStore();
    const { app } = makeCfgApp('admin', store);
    await request(app)
      .put('/v1/admin/config/alerts.red_sla_hours')
      .set(TH_BIL)
      .send({ value: 2 });
    const bil = await request(app).get('/v1/admin/config/alerts.red_sla_hours').set(TH_BIL);
    const bank = await request(app).get('/v1/admin/config/alerts.red_sla_hours').set(TH_BANK);
    expect(bil.body.body.value).toBe(2);
    expect(bank.body.body.value).toBe(4);
    expect(bank.body.body.is_default).toBe(true);
  });
});
