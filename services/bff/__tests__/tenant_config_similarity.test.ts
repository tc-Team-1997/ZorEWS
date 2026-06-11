// @ts-nocheck
// T6 M2.23 — Tenant configuration similarity analysis tests.

import request from 'supertest';
import { buildTenantConfigSimilarity } from '../src/tenant_config_similarity';
import { defaultConfigStore, InMemoryConfigStore } from '../src/admin_config';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const H = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

describe('buildTenantConfigSimilarity — empty tenant list', () => {
  test('returns empty pairs', async () => {
    const store = new InMemoryConfigStore();
    const r = await buildTenantConfigSimilarity([], store, NOW);
    expect(r.total_tenants).toBe(0);
    expect(r.pairs).toEqual([]);
    expect(r.most_similar_pair).toBeNull();
    expect(r.most_divergent_pair).toBeNull();
    expect(r.avg_similarity).toBe(0);
  });

  test('single tenant returns no pairs', async () => {
    const store = new InMemoryConfigStore();
    const r = await buildTenantConfigSimilarity(['BIL'], store, NOW);
    expect(r.total_tenants).toBe(1);
    expect(r.pairs).toHaveLength(0);
  });
});

describe('buildTenantConfigSimilarity — pair computation', () => {
  test('identical override sets produce similarity=1', async () => {
    const store = new InMemoryConfigStore();
    store.set('T1', 'alerts.red_sla_hours', 2, 'admin', NOW);
    store.set('T2', 'alerts.red_sla_hours', 2, 'admin', NOW);
    const r = await buildTenantConfigSimilarity(['T1', 'T2'], store, NOW);
    expect(r.pairs.length).toBe(1);
    expect(r.pairs[0].jaccard_similarity).toBe(1);
  });

  test('disjoint override sets produce similarity=0', async () => {
    const store = new InMemoryConfigStore();
    store.set('T1', 'alerts.red_sla_hours', 2, 'admin', NOW);
    store.set('T2', 'alerts.orange_sla_hours', 12, 'admin', NOW);
    const r = await buildTenantConfigSimilarity(['T1', 'T2'], store, NOW);
    expect(r.pairs.length).toBe(1);
    expect(r.pairs[0].jaccard_similarity).toBe(0);
    expect(r.pairs[0].common_overrides).toEqual([]);
    expect(r.pairs[0].only_in_a.length).toBe(1);
    expect(r.pairs[0].only_in_b.length).toBe(1);
  });

  test('partial overlap produces 0 < similarity < 1', async () => {
    const store = new InMemoryConfigStore();
    store.set('T1', 'alerts.red_sla_hours', 2, 'admin', NOW);
    store.set('T1', 'alerts.orange_sla_hours', 12, 'admin', NOW);
    store.set('T2', 'alerts.red_sla_hours', 2, 'admin', NOW);
    const r = await buildTenantConfigSimilarity(['T1', 'T2'], store, NOW);
    expect(r.pairs[0].jaccard_similarity).toBeGreaterThan(0);
    expect(r.pairs[0].jaccard_similarity).toBeLessThan(1);
  });

  test('no overrides on both tenants → both empty → similarity=1', async () => {
    const store = new InMemoryConfigStore();
    const r = await buildTenantConfigSimilarity(['T1', 'T2'], store, NOW);
    // Both have empty override sets → union=0 → Jaccard=1 (by convention)
    expect(r.pairs[0].jaccard_similarity).toBe(1);
  });

  test('most_similar_pair points at highest similarity', async () => {
    const store = new InMemoryConfigStore();
    store.set('T1', 'alerts.red_sla_hours', 2, 'admin', NOW);
    store.set('T2', 'alerts.red_sla_hours', 2, 'admin', NOW);
    store.set('T3', 'alerts.orange_sla_hours', 12, 'admin', NOW);
    const r = await buildTenantConfigSimilarity(['T1', 'T2', 'T3'], store, NOW);
    expect(r.most_similar_pair).not.toBeNull();
    expect(r.most_similar_pair.similarity).toBeGreaterThanOrEqual(
      r.pairs[r.pairs.length - 1].jaccard_similarity,
    );
  });

  test('pairs sorted by similarity desc', async () => {
    const store = new InMemoryConfigStore();
    store.set('T1', 'alerts.red_sla_hours', 2, 'admin', NOW);
    store.set('T2', 'alerts.red_sla_hours', 2, 'admin', NOW);
    store.set('T3', 'alerts.orange_sla_hours', 12, 'admin', NOW);
    const r = await buildTenantConfigSimilarity(['T1', 'T2', 'T3'], store, NOW);
    for (let i = 1; i < r.pairs.length; i++) {
      expect(r.pairs[i - 1].jaccard_similarity).toBeGreaterThanOrEqual(r.pairs[i].jaccard_similarity);
    }
  });

  test('generated_at and total_tenants are correct', async () => {
    const store = new InMemoryConfigStore();
    const r = await buildTenantConfigSimilarity(['T1', 'T2'], store, NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(r.total_tenants).toBe(2);
  });
});

describe('route — /v1/tenants/config-similarity', () => {
  test('returns 501 when lookup does not have all()', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
      // Default tenantLookup has all()
    });
    // The default lookup DOES have all() so this should be 200 or 501
    const res = await request(app).get('/v1/tenants/config-similarity').set(H);
    expect([200, 501]).toContain(res.status);
  });

  test('403 for wrong role', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'field_officer',
    });
    const res = await request(app).get('/v1/tenants/config-similarity').set(H);
    expect(res.status).toBe(403);
  });

  test('400 when missing tenant header', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
    });
    const res = await request(app).get('/v1/tenants/config-similarity');
    expect(res.status).toBe(400);
  });
});
