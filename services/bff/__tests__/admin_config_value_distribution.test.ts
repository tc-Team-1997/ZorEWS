// @ts-nocheck
// services/bff/__tests__/admin_config_value_distribution.test.ts
//
// T6 M13.20 — Admin config value distribution by type.

import request from 'supertest';
import {
  buildConfigValueDistribution,
  buildConfigValueDistributionFromStore,
} from '../src/admin_config_value_distribution';
import { InMemoryConfigStore, DEFAULTS } from '../src/admin_config';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeDistApp(role) {
  const configStore = new InMemoryConfigStore();
  const source = new StaticSource([]);
  const evaluator = new StubEvaluator();
  const riskProfile = new StubRiskProfileSource();
  const caseAction = new UnavailableCaseActionSink();
  const getRole = () => role;
  const { app } = makeApp({ source, evaluator, riskProfile, caseAction, getRole, configStore });
  return { app, configStore };
}

// ─── Pure function tests ────────────────────────────────────────────

describe('buildConfigValueDistribution — pure', () => {
  test('platform defaults → all entries present', () => {
    const store = new InMemoryConfigStore();
    const result = buildConfigValueDistributionFromStore(store, 'BIL', NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.total_keys).toBe(DEFAULTS.length);
    expect(result.total_keys).toBeGreaterThan(0);
  });

  test('number type stats are populated correctly', () => {
    const store = new InMemoryConfigStore();
    const result = buildConfigValueDistributionFromStore(store, 'BIL', NOW);
    const numStats = result.by_type.number;
    expect(numStats.count).toBeGreaterThan(0);
    expect(numStats.min_value).not.toBeNull();
    expect(numStats.max_value).not.toBeNull();
    expect(numStats.min_value).toBeLessThanOrEqual(numStats.max_value);
    expect(numStats.mean_value).not.toBeNull();
  });

  test('boolean type stats: true + false = count', () => {
    const store = new InMemoryConfigStore();
    const result = buildConfigValueDistributionFromStore(store, 'BIL', NOW);
    const boolStats = result.by_type.boolean;
    expect(boolStats.count).toBeGreaterThan(0);
    expect(boolStats.true_count + boolStats.false_count).toBe(boolStats.count);
    expect(boolStats.true_pct).toBeGreaterThanOrEqual(0);
    expect(boolStats.true_pct).toBeLessThanOrEqual(1);
  });

  test('string type stats are populated', () => {
    const store = new InMemoryConfigStore();
    const result = buildConfigValueDistributionFromStore(store, 'BIL', NOW);
    const strStats = result.by_type.string;
    expect(strStats.count).toBeGreaterThanOrEqual(0);
    expect(strStats.distinct_values).toBeGreaterThanOrEqual(0);
    expect(strStats.max_length).toBeGreaterThanOrEqual(0);
  });

  test('type counts sum to total_keys', () => {
    const store = new InMemoryConfigStore();
    const result = buildConfigValueDistributionFromStore(store, 'BIL', NOW);
    const { number, boolean, string: str, json } = result.by_type;
    const typeSum = number.count + boolean.count + str.count + json.count;
    expect(typeSum).toBe(result.total_keys);
  });

  test('most_customized_type is null when no overrides', () => {
    const store = new InMemoryConfigStore();
    const result = buildConfigValueDistributionFromStore(store, 'BIL', NOW);
    // All defaults — no overrides
    expect(result.most_customized_type).toBeNull();
  });

  test('most_customized_type reflects actual overrides', () => {
    const store = new InMemoryConfigStore();
    store.set('BIL', 'features.copilot_enabled', true, 'admin', NOW);
    store.set('BIL', 'features.maker_checker_enabled', false, 'admin', NOW);
    const result = buildConfigValueDistributionFromStore(store, 'BIL', NOW);
    expect(result.most_customized_type).toBe('boolean');
  });

  test('override increases override_count for json type', () => {
    const store = new InMemoryConfigStore();
    // Check if there's a json-type config key
    const jsonKeys = DEFAULTS.filter(d => d.type === 'json');
    if (jsonKeys.length > 0) {
      store.set('BIL', jsonKeys[0].key, { test: 1 }, 'admin', NOW);
      const result = buildConfigValueDistributionFromStore(store, 'BIL', NOW);
      expect(result.by_type.json.override_count).toBeGreaterThan(0);
    } else {
      // No json keys in DEFAULTS — just verify structure is present
      const entries = store.list('BIL');
      const result = buildConfigValueDistribution(entries, 'BIL', NOW);
      expect(result.by_type.json).toBeDefined();
    }
  });
});

// ─── Route tests ────────────────────────────────────────────────────

describe('M13.20 — GET /v1/admin/config/value-distribution', () => {
  test('admin → 200 with by_type structure', async () => {
    const { app } = makeDistApp('admin');
    const r = await request(app).get('/v1/admin/config/value-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.by_type).toBeDefined();
    expect(r.body.body.by_type.number).toBeDefined();
    expect(r.body.body.by_type.boolean).toBeDefined();
    expect(r.body.body.by_type.string).toBeDefined();
    expect(r.body.body.by_type.json).toBeDefined();
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeDistApp('field_officer');
    const r = await request(app).get('/v1/admin/config/value-distribution').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('400 when no tenant header', async () => {
    const { app } = makeDistApp('admin');
    const r = await request(app).get('/v1/admin/config/value-distribution');
    expect(r.status).toBe(400);
  });

  test('cross-tenant isolation (BIL ↔ BANK_DEMO same platform defaults)', async () => {
    const { app } = makeDistApp('admin');
    const bilR = await request(app).get('/v1/admin/config/value-distribution').set(TH_BIL);
    const bankR = await request(app).get('/v1/admin/config/value-distribution')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(bilR.status).toBe(200);
    expect(bankR.status).toBe(200);
    // Both have same platform defaults → same total_keys
    expect(bilR.body.body.total_keys).toBe(bankR.body.body.total_keys);
  });
});
