// services/bff/__tests__/admin_config_feature_adoption.test.ts
//
// T6 M13.14 — Feature flag adoption across tenants.

import request from 'supertest';
import { summarizeFeatureAdoption } from '../src/admin_config_feature_adoption';
import {
  InMemoryConfigStore,
  DEFAULTS,
} from '../src/admin_config';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import type { Tenant } from '../src/tenant';

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const FEATURE_KEYS = DEFAULTS
  .filter((d) => d.category === 'features' && d.type === 'boolean')
  .map((d) => d.key);

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    tenant_id: 'BIL',
    name: 'BIL test',
    vertical: 'banking',
    channels_allowed: ['API'],
    active: true,
    ...overrides,
  };
}

function makeAdoptionApp(role: string = 'admin') {
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

// ─── summarizeFeatureAdoption — pure ─────────────────────────────────

describe('M13.14 — empty tenant list', () => {
  test('zero tenants → every feature row at 0', () => {
    const store = new InMemoryConfigStore();
    const s = summarizeFeatureAdoption([], store, NOW);
    expect(s.total_tenants).toBe(0);
    expect(s.total_features).toBe(FEATURE_KEYS.length);
    expect(s.features.length).toBe(FEATURE_KEYS.length);
    for (const row of s.features) {
      expect(row.total_tenants).toBe(0);
      expect(row.enabled_count).toBe(0);
      expect(row.disabled_count).toBe(0);
      expect(row.override_count).toBe(0);
      expect(row.enabled_tenant_ids).toEqual([]);
      expect(row.disabled_tenant_ids).toEqual([]);
      expect(row.adoption_rate).toBe(0);
    }
    expect(s.most_adopted_feature).toBeNull();
    expect(s.least_adopted_feature).toBeNull();
    expect(s.features_with_overrides).toEqual([]);
  });
});

describe('M13.14 — canonical features order', () => {
  test('features[] matches DEFAULTS schema order', () => {
    const store = new InMemoryConfigStore();
    const s = summarizeFeatureAdoption([], store, NOW);
    expect(s.features.map((r) => r.key)).toEqual(FEATURE_KEYS);
  });
});

describe('M13.14 — single tenant all defaults', () => {
  test('one tenant → defaults applied, no overrides', () => {
    const store = new InMemoryConfigStore();
    const t = tenant({ tenant_id: 'BIL' });
    const s = summarizeFeatureAdoption([t], store, NOW);
    expect(s.total_tenants).toBe(1);
    for (const row of s.features) {
      // Default value determines enabled/disabled placement.
      if (row.default_value === true) {
        expect(row.enabled_count).toBe(1);
        expect(row.enabled_tenant_ids).toEqual(['BIL']);
      } else {
        expect(row.disabled_count).toBe(1);
        expect(row.disabled_tenant_ids).toEqual(['BIL']);
      }
      expect(row.override_count).toBe(0);
    }
    expect(s.features_with_overrides).toEqual([]);
  });
});

describe('M13.14 — override flips bucket', () => {
  test('explicit override flips tenant from default bucket + bumps override_count', () => {
    const store = new InMemoryConfigStore();
    const t = tenant({ tenant_id: 'BIL' });
    // Override copilot_enabled (default true) to false.
    store.set('BIL', 'features.copilot_enabled', false, 'admin', NOW);
    const s = summarizeFeatureAdoption([t], store, NOW);
    const copilot = s.features.find((r) => r.key === 'features.copilot_enabled')!;
    expect(copilot.disabled_count).toBe(1);
    expect(copilot.disabled_tenant_ids).toEqual(['BIL']);
    expect(copilot.override_count).toBe(1);
    expect(s.features_with_overrides).toContain('features.copilot_enabled');
  });

  test('override TO default value still bumps override_count', () => {
    const store = new InMemoryConfigStore();
    const t = tenant({ tenant_id: 'BIL' });
    // Set copilot_enabled to its default (true) explicitly.
    store.set('BIL', 'features.copilot_enabled', true, 'admin', NOW);
    const s = summarizeFeatureAdoption([t], store, NOW);
    const copilot = s.features.find((r) => r.key === 'features.copilot_enabled')!;
    // Still enabled, but override_count=1 since the store now has an explicit entry.
    expect(copilot.enabled_count).toBe(1);
    expect(copilot.override_count).toBe(1);
  });
});

describe('M13.14 — multi-tenant mixed', () => {
  test('3 tenants with mixed maker_checker_enabled (default false)', () => {
    const store = new InMemoryConfigStore();
    const a = tenant({ tenant_id: 'A' });
    const b = tenant({ tenant_id: 'B' });
    const c = tenant({ tenant_id: 'C' });
    // Enable maker_checker on A + B; C stays at default false.
    store.set('A', 'features.maker_checker_enabled', true, 'admin', NOW);
    store.set('B', 'features.maker_checker_enabled', true, 'admin', NOW);
    const s = summarizeFeatureAdoption([a, b, c], store, NOW);
    const mc = s.features.find((r) => r.key === 'features.maker_checker_enabled')!;
    expect(mc.enabled_count).toBe(2);
    expect(mc.disabled_count).toBe(1);
    expect(mc.override_count).toBe(2);
    expect(mc.enabled_tenant_ids).toEqual(['A', 'B']);
    expect(mc.disabled_tenant_ids).toEqual(['C']);
    expect(mc.adoption_rate).toBeCloseTo(2 / 3);
  });
});

describe('M13.14 — sorted tenant_id arrays', () => {
  test('enabled_tenant_ids + disabled_tenant_ids sorted asc', () => {
    const store = new InMemoryConfigStore();
    const tenants = [
      tenant({ tenant_id: 'ZEBRA' }),
      tenant({ tenant_id: 'ALPHA' }),
      tenant({ tenant_id: 'MIDDLE' }),
    ];
    const s = summarizeFeatureAdoption(tenants, store, NOW);
    for (const row of s.features) {
      if (row.default_value) {
        expect(row.enabled_tenant_ids).toEqual(['ALPHA', 'MIDDLE', 'ZEBRA']);
      } else {
        expect(row.disabled_tenant_ids).toEqual(['ALPHA', 'MIDDLE', 'ZEBRA']);
      }
    }
  });
});

describe('M13.14 — adoption_rate', () => {
  test('= enabled_count / total_tenants', () => {
    const store = new InMemoryConfigStore();
    const tenants = [
      tenant({ tenant_id: 'A' }),
      tenant({ tenant_id: 'B' }),
      tenant({ tenant_id: 'C' }),
      tenant({ tenant_id: 'D' }),
    ];
    // Disable scenario_simulation (default true) on A + B → enabled=2, total=4
    store.set('A', 'features.scenario_simulation_enabled', false, 'admin', NOW);
    store.set('B', 'features.scenario_simulation_enabled', false, 'admin', NOW);
    const s = summarizeFeatureAdoption(tenants, store, NOW);
    const sc = s.features.find((r) => r.key === 'features.scenario_simulation_enabled')!;
    expect(sc.adoption_rate).toBe(0.5);
  });

  test('= 0 when no tenants', () => {
    const store = new InMemoryConfigStore();
    const s = summarizeFeatureAdoption([], store, NOW);
    for (const row of s.features) {
      expect(row.adoption_rate).toBe(0);
    }
  });
});

describe('M13.14 — most_adopted_feature / least_adopted_feature', () => {
  test('points at highest/lowest adoption_rate', () => {
    const store = new InMemoryConfigStore();
    const tenants = [
      tenant({ tenant_id: 'A' }),
      tenant({ tenant_id: 'B' }),
    ];
    // scenario_simulation default=true → both enabled (100%)
    // copilot default=true → disable on both (0%)
    store.set('A', 'features.copilot_enabled', false, 'admin', NOW);
    store.set('B', 'features.copilot_enabled', false, 'admin', NOW);
    // maker_checker default=false → enable on A (50%)
    store.set('A', 'features.maker_checker_enabled', true, 'admin', NOW);
    const s = summarizeFeatureAdoption(tenants, store, NOW);
    expect(s.most_adopted_feature!.key).toBe('features.scenario_simulation_enabled');
    expect(s.most_adopted_feature!.adoption_rate).toBe(1);
    expect(s.least_adopted_feature!.key).toBe('features.copilot_enabled');
    expect(s.least_adopted_feature!.adoption_rate).toBe(0);
  });

  test('canonical tie-break: first DEFAULTS key wins at same rate', () => {
    const store = new InMemoryConfigStore();
    const t = tenant({ tenant_id: 'A' });
    // All defaults — scenario_simulation + copilot both at 1.0 (true defaults).
    const s = summarizeFeatureAdoption([t], store, NOW);
    // First true-default feature in DEFAULTS wins.
    expect(s.most_adopted_feature!.key).toBe('features.scenario_simulation_enabled');
  });

  test('null when no tenants', () => {
    const store = new InMemoryConfigStore();
    const s = summarizeFeatureAdoption([], store, NOW);
    expect(s.most_adopted_feature).toBeNull();
    expect(s.least_adopted_feature).toBeNull();
  });
});

describe('M13.14 — features_with_overrides', () => {
  test('subset of features with at least one override; canonical order', () => {
    const store = new InMemoryConfigStore();
    const t = tenant({ tenant_id: 'A' });
    store.set('A', 'features.maker_checker_enabled', true, 'admin', NOW);
    const s = summarizeFeatureAdoption([t], store, NOW);
    expect(s.features_with_overrides).toEqual(['features.maker_checker_enabled']);
  });

  test('empty when no overrides', () => {
    const store = new InMemoryConfigStore();
    const t = tenant({ tenant_id: 'A' });
    const s = summarizeFeatureAdoption([t], store, NOW);
    expect(s.features_with_overrides).toEqual([]);
  });
});

describe('M13.14 — partition invariants', () => {
  test('enabled_count + disabled_count = total_tenants per row', () => {
    const store = new InMemoryConfigStore();
    const tenants = [
      tenant({ tenant_id: 'A' }),
      tenant({ tenant_id: 'B' }),
      tenant({ tenant_id: 'C' }),
    ];
    store.set('A', 'features.copilot_enabled', false, 'admin', NOW);
    const s = summarizeFeatureAdoption(tenants, store, NOW);
    for (const row of s.features) {
      expect(row.enabled_count + row.disabled_count).toBe(row.total_tenants);
    }
  });
});

// ─── GET /v1/admin/config/feature-adoption ───────────────────────────

describe('M13.14 — GET /v1/admin/config/feature-adoption', () => {
  test('admin → 200 with default registry (BANK_DEMO + BIL)', async () => {
    const { app } = makeAdoptionApp('admin');
    const r = await request(app).get('/v1/admin/config/feature-adoption').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_tenants).toBe(2);
    expect(r.body.body.total_features).toBe(FEATURE_KEYS.length);
    expect(r.body.body.features.length).toBe(FEATURE_KEYS.length);
  });

  test('populated rollup reflects overrides', async () => {
    const { app, configStore } = makeAdoptionApp('admin');
    configStore.set('BIL', 'features.maker_checker_enabled', true, 'admin', NOW);
    const r = await request(app).get('/v1/admin/config/feature-adoption').set(TH_BIL);
    expect(r.status).toBe(200);
    const mc = r.body.body.features.find(
      (f: { key: string }) => f.key === 'features.maker_checker_enabled',
    );
    expect(mc.enabled_count).toBe(1);
    expect(mc.enabled_tenant_ids).toEqual(['BIL']);
    expect(mc.override_count).toBe(1);
    expect(r.body.body.features_with_overrides).toContain('features.maker_checker_enabled');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAdoptionApp('case_owner');
    const r = await request(app).get('/v1/admin/config/feature-adoption').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('literal /feature-adoption not captured by :key wildcard', async () => {
    const { app } = makeAdoptionApp('admin');
    const r = await request(app).get('/v1/admin/config/feature-adoption').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.features.length).toBe(FEATURE_KEYS.length);
  });

  test('M13.13 /v1/admin/config/schema.md still works (sibling regression)', async () => {
    const { app } = makeAdoptionApp('admin');
    const r = await request(app).get('/v1/admin/config/schema.md').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M13.12 /v1/admin/config/override-rate still works (sibling regression)', async () => {
    const { app } = makeAdoptionApp('admin');
    const r = await request(app).get('/v1/admin/config/override-rate').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
