// @ts-nocheck
// T6 M14.38 — Adapter data volume analysis.

import request from 'supertest';
import { buildAdapterDataVolume } from '../src/adapter_data_volume';
import { InMemoryIngestionRegistry } from '../src/ingestion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeVolApp(role = 'admin', registry = new InMemoryIngestionRegistry()) {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => role, ingestionRegistry: registry });
  return app;
}

describe('M14.38 — data volume', () => {
  test('returns volume for all connectors', () => {
    const registry = new InMemoryIngestionRegistry();
    const out = buildAdapterDataVolume(registry, 'BIL', NOW);
    expect(out.connectors.length).toBeGreaterThan(0);
  });

  test('monthly_volume = daily_volume * 30', () => {
    const registry = new InMemoryIngestionRegistry();
    const out = buildAdapterDataVolume(registry, 'BIL', NOW);
    for (const c of out.connectors) {
      expect(c.monthly_volume).toBe(c.daily_volume_estimate * 30);
    }
  });

  test('data_category values are valid', () => {
    const registry = new InMemoryIngestionRegistry();
    const out = buildAdapterDataVolume(registry, 'BIL', NOW);
    for (const c of out.connectors) {
      expect(['high_volume', 'medium', 'low']).toContain(c.data_category);
    }
  });

  test('sorted by monthly_volume desc', () => {
    const registry = new InMemoryIngestionRegistry();
    const out = buildAdapterDataVolume(registry, 'BIL', NOW);
    for (let i = 0; i < out.connectors.length - 1; i++) {
      expect(out.connectors[i].monthly_volume).toBeGreaterThanOrEqual(out.connectors[i + 1].monthly_volume);
    }
  });

  test('highest_volume_connector is first', () => {
    const registry = new InMemoryIngestionRegistry();
    const out = buildAdapterDataVolume(registry, 'BIL', NOW);
    expect(out.highest_volume_connector).toBe(out.connectors[0].connector_id);
  });

  test('data_tier_summary counts add up', () => {
    const registry = new InMemoryIngestionRegistry();
    const out = buildAdapterDataVolume(registry, 'BIL', NOW);
    const total = out.data_tier_summary.high_volume + out.data_tier_summary.medium + out.data_tier_summary.low;
    expect(total).toBe(out.connectors.length);
  });

  test('cross-tenant: different tenants may differ', () => {
    const registry = new InMemoryIngestionRegistry();
    const out1 = buildAdapterDataVolume(registry, 'BIL', NOW);
    expect(out1.tenant_id).toBe('BIL');
  });
});

describe('M14.38 — route', () => {
  test('admin GET /v1/integrations/adapters/data-volume returns 200', async () => {
    const app = makeVolApp();
    const res = await request(app).get('/v1/integrations/adapters/data-volume').set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.connectors)).toBe(true);
  });

  test('non-admin gets 403', async () => {
    const app = makeVolApp('field_officer');
    const res = await request(app).get('/v1/integrations/adapters/data-volume').set(TH);
    expect(res.status).toBe(403);
  });
});
