// services/bff/__tests__/admin_config_override_rate.test.ts
//
// T6 M13.12 — Config category override-rate snapshot.

import request from 'supertest';
import { buildConfigOverrideRateSnapshot } from '../src/admin_config_override_rate';
import {
  InMemoryConfigStore,
  listCategories,
  DEFAULTS,
  type ConfigCategory,
} from '../src/admin_config';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── buildConfigOverrideRateSnapshot — pure ──────────────────────────

describe('M13.12 — fresh tenant (no overrides)', () => {
  test('every category present with zero overrides + 100% defaults', () => {
    const store = new InMemoryConfigStore();
    const snap = buildConfigOverrideRateSnapshot(store, 'BIL', NOW);
    expect(snap.tenant_id).toBe('BIL');
    expect(snap.generated_at).toBe(NOW.toISOString());
    expect(snap.total_keys).toBe(DEFAULTS.length);
    expect(snap.total_overrides).toBe(0);
    expect(snap.overall_override_rate).toBe(0);
    expect(snap.categories.length).toBe(listCategories().length);
    for (const c of snap.categories) {
      expect(c.override_count).toBe(0);
      expect(c.override_rate).toBe(0);
      expect(c.default_count).toBe(c.total_keys);
      expect(c.override_keys).toEqual([]);
    }
    expect(snap.most_customised_category).not.toBeNull();
    // First non-empty category by alphabetical (declared) order at 0% rate
    expect(snap.most_customised_category!.override_rate).toBe(0);
    expect(snap.pristine_categories.length).toBe(listCategories().length);
  });
});

describe('M13.12 — single category override', () => {
  test('overriding one key updates that category only', () => {
    const store = new InMemoryConfigStore();
    // Find an alerts key to override
    const alertsKey = DEFAULTS.find((d) => d.category === 'alerts')!.key;
    store.set('BIL', alertsKey, 1, 'alice', NOW);
    const snap = buildConfigOverrideRateSnapshot(store, 'BIL', NOW);
    expect(snap.total_overrides).toBe(1);
    const alertsRow = snap.categories.find((c) => c.category === 'alerts')!;
    expect(alertsRow.override_count).toBe(1);
    expect(alertsRow.override_keys).toContain(alertsKey);
    expect(alertsRow.override_rate).toBeCloseTo(1 / alertsRow.total_keys);
    // Other categories unchanged
    for (const c of snap.categories) {
      if (c.category !== 'alerts') {
        expect(c.override_count).toBe(0);
      }
    }
  });
});

describe('M13.12 — sort order', () => {
  test('categories sorted by override_count desc with category asc tie-break', () => {
    const store = new InMemoryConfigStore();
    // Override 2 alerts keys + 1 notifications key
    const alertsKeys = DEFAULTS.filter((d) => d.category === 'alerts').slice(0, 2);
    const notifKey = DEFAULTS.find((d) => d.category === 'notifications')!;
    for (const k of alertsKeys) {
      // override with whatever value matches the type
      if (k.type === 'number') store.set('BIL', k.key, 1, 'alice', NOW);
      else if (k.type === 'boolean') store.set('BIL', k.key, true, 'alice', NOW);
      else if (k.type === 'string') store.set('BIL', k.key, 'x', 'alice', NOW);
      else store.set('BIL', k.key, {}, 'alice', NOW);
    }
    if (notifKey.type === 'number') store.set('BIL', notifKey.key, 1, 'alice', NOW);
    else if (notifKey.type === 'boolean') store.set('BIL', notifKey.key, true, 'alice', NOW);
    else if (notifKey.type === 'string') store.set('BIL', notifKey.key, 'x', 'alice', NOW);
    else store.set('BIL', notifKey.key, {}, 'alice', NOW);

    const snap = buildConfigOverrideRateSnapshot(store, 'BIL', NOW);
    // Top row should have the most overrides (alerts: 2); next should
    // be notifications: 1; rest at 0 sorted alphabetically.
    expect(snap.categories[0]!.category).toBe('alerts');
    expect(snap.categories[0]!.override_count).toBe(2);
    expect(snap.categories[1]!.category).toBe('notifications');
    expect(snap.categories[1]!.override_count).toBe(1);
    // Remaining categories at 0 overrides — alphabetical
    const zeroes = snap.categories.slice(2).map((c) => c.category);
    expect(zeroes).toEqual([...zeroes].sort());
  });
});

describe('M13.12 — most_customised_category', () => {
  test('highest override_rate wins (not the highest count)', () => {
    const store = new InMemoryConfigStore();
    // Override every alerts key (100% rate)
    const alertsKeys = DEFAULTS.filter((d) => d.category === 'alerts');
    for (const k of alertsKeys) {
      if (k.type === 'number') store.set('BIL', k.key, 1, 'alice', NOW);
      else if (k.type === 'boolean') store.set('BIL', k.key, true, 'alice', NOW);
      else if (k.type === 'string') store.set('BIL', k.key, 'x', 'alice', NOW);
      else store.set('BIL', k.key, {}, 'alice', NOW);
    }
    // Override only 1 notifications key — much lower rate
    const notifKey = DEFAULTS.find((d) => d.category === 'notifications')!;
    if (notifKey.type === 'number') store.set('BIL', notifKey.key, 1, 'alice', NOW);
    else if (notifKey.type === 'boolean') store.set('BIL', notifKey.key, true, 'alice', NOW);
    else if (notifKey.type === 'string') store.set('BIL', notifKey.key, 'x', 'alice', NOW);
    else store.set('BIL', notifKey.key, {}, 'alice', NOW);
    const snap = buildConfigOverrideRateSnapshot(store, 'BIL', NOW);
    expect(snap.most_customised_category!.category).toBe('alerts');
    expect(snap.most_customised_category!.override_rate).toBe(1.0);
  });
});

describe('M13.12 — pristine_categories', () => {
  test('captures categories with zero overrides, sorted asc', () => {
    const store = new InMemoryConfigStore();
    const alertsKey = DEFAULTS.find((d) => d.category === 'alerts')!.key;
    store.set('BIL', alertsKey, 1, 'alice', NOW);
    const snap = buildConfigOverrideRateSnapshot(store, 'BIL', NOW);
    expect(snap.pristine_categories).not.toContain('alerts');
    // Should be sorted asc
    expect([...snap.pristine_categories].sort()).toEqual(snap.pristine_categories);
  });
});

describe('M13.12 — total_keys / total_overrides / overall_override_rate', () => {
  test('aggregate counters match category-level sums', () => {
    const store = new InMemoryConfigStore();
    const alertsKey = DEFAULTS.find((d) => d.category === 'alerts')!.key;
    const notifKey = DEFAULTS.find((d) => d.category === 'notifications')!.key;
    store.set('BIL', alertsKey, 1, 'alice', NOW);
    if (DEFAULTS.find((d) => d.key === notifKey)!.type === 'boolean') {
      store.set('BIL', notifKey, true, 'alice', NOW);
    } else {
      store.set('BIL', notifKey, 'x', 'alice', NOW);
    }
    const snap = buildConfigOverrideRateSnapshot(store, 'BIL', NOW);
    const sumKeys = snap.categories.reduce((acc, c) => acc + c.total_keys, 0);
    const sumOver = snap.categories.reduce((acc, c) => acc + c.override_count, 0);
    expect(snap.total_keys).toBe(sumKeys);
    expect(snap.total_overrides).toBe(sumOver);
    expect(snap.overall_override_rate).toBeCloseTo(sumOver / sumKeys);
  });
});

describe('M13.12 — cross-tenant isolation', () => {
  test('BIL overrides invisible to BANK_DEMO', () => {
    const store = new InMemoryConfigStore();
    const alertsKey = DEFAULTS.find((d) => d.category === 'alerts')!.key;
    store.set('BIL', alertsKey, 1, 'alice', NOW);
    const bank = buildConfigOverrideRateSnapshot(store, 'BANK_DEMO', NOW);
    expect(bank.total_overrides).toBe(0);
  });
});

describe('M13.12 — every declared category surfaces even with zero schema keys', () => {
  test('total_keys + total_overrides + categories[].total_keys consistent', () => {
    const store = new InMemoryConfigStore();
    const snap = buildConfigOverrideRateSnapshot(store, 'BIL', NOW);
    // The DEFAULTS schema covers every category in listCategories
    const present = new Set(snap.categories.map((c) => c.category));
    for (const c of listCategories()) {
      expect(present.has(c)).toBe(true);
    }
  });
});

describe('M13.12 — override_keys ordered asc', () => {
  test('per-category override_keys sorted alphabetically', () => {
    const store = new InMemoryConfigStore();
    const alertsKeys = DEFAULTS.filter((d) => d.category === 'alerts').slice(0, 2);
    for (const k of alertsKeys) {
      if (k.type === 'number') store.set('BIL', k.key, 1, 'alice', NOW);
      else if (k.type === 'boolean') store.set('BIL', k.key, true, 'alice', NOW);
      else if (k.type === 'string') store.set('BIL', k.key, 'x', 'alice', NOW);
      else store.set('BIL', k.key, {}, 'alice', NOW);
    }
    const snap = buildConfigOverrideRateSnapshot(store, 'BIL', NOW);
    const alertsRow = snap.categories.find((c) => c.category === 'alerts')!;
    expect(alertsRow.override_keys).toEqual([...alertsRow.override_keys].sort());
  });
});

// ─── GET /v1/admin/config/override-rate ──────────────────────────────

function makeRateApp(role = 'admin') {
  const configStore = new InMemoryConfigStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    configStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, configStore };
}

describe('M13.12 — GET /v1/admin/config/override-rate', () => {
  test('admin → 200 with fresh-tenant snapshot', async () => {
    const { app } = makeRateApp('admin');
    const r = await request(app).get('/v1/admin/config/override-rate').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(DEFAULTS.length);
    expect(r.body.body.total_overrides).toBe(0);
  });

  test('populated snapshot reflects override', async () => {
    const { app, configStore } = makeRateApp('admin');
    const alertsKey = DEFAULTS.find((d) => d.category === 'alerts')!.key;
    configStore.set('BIL', alertsKey, 1, 'alice', NOW);
    const r = await request(app).get('/v1/admin/config/override-rate').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(1);
    expect(r.body.body.most_customised_category.category).toBe('alerts');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRateApp('case_owner');
    const r = await request(app).get('/v1/admin/config/override-rate').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL overrides invisible to BANK_DEMO via route', async () => {
    const { app, configStore } = makeRateApp('admin');
    const alertsKey = DEFAULTS.find((d) => d.category === 'alerts')!.key;
    configStore.set('BIL', alertsKey, 1, 'alice', NOW);
    const bank = await request(app)
      .get('/v1/admin/config/override-rate')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_overrides).toBe(0);
  });

  test('M13.11 /v1/admin/config/override-ages still works (sibling route)', async () => {
    const { app } = makeRateApp('admin');
    const r = await request(app).get('/v1/admin/config/override-ages').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
