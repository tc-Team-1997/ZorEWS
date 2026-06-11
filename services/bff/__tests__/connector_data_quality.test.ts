// @ts-nocheck
// services/bff/__tests__/connector_data_quality.test.ts
// T6 M3.24 — Connector data quality score

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryIngestionRegistry, defaultIngestionRegistry } from '../src/ingestion';
import { computeConnectorDataQuality } from '../src/connector_data_quality';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('computeConnectorDataQuality()', () => {
  test('returns connector entries for seeded registry', () => {
    const result = computeConnectorDataQuality('BIL', defaultIngestionRegistry, NOW);
    expect(result.connectors.length).toBeGreaterThan(0);
    expect(result.tenant_id).toBe('BIL');
  });

  test('each entry has quality_score in 0-100 range', () => {
    const result = computeConnectorDataQuality('BIL', defaultIngestionRegistry, NOW);
    for (const entry of result.connectors) {
      expect(entry.quality_score).toBeGreaterThanOrEqual(0);
      expect(entry.quality_score).toBeLessThanOrEqual(100);
    }
  });

  test('avg_quality_score is between 0 and 100', () => {
    const result = computeConnectorDataQuality('BIL', defaultIngestionRegistry, NOW);
    expect(result.avg_quality_score).toBeGreaterThanOrEqual(0);
    expect(result.avg_quality_score).toBeLessThanOrEqual(100);
  });

  test('lowest_quality_connector is non-null when connectors exist', () => {
    const result = computeConnectorDataQuality('BIL', defaultIngestionRegistry, NOW);
    if (result.connectors.length > 0) {
      expect(result.lowest_quality_connector).not.toBeNull();
      expect(result.highest_quality_connector).not.toBeNull();
    }
  });

  test('avg_quality_score is non-negative for seeded registry', () => {
    // InMemoryIngestionRegistry always returns SEED_CONNECTORS, so we use the default
    const registry = new InMemoryIngestionRegistry();
    const result = computeConnectorDataQuality('BIL', registry, NOW);
    // With seed connectors, avg should be > 0
    expect(result.avg_quality_score).toBeGreaterThan(0);
    expect(result.avg_quality_score).toBeLessThanOrEqual(100);
    expect(result.lowest_quality_connector).not.toBeNull();
    expect(result.highest_quality_connector).not.toBeNull();
  });

  test('connectivity_score for healthy connector is 100', () => {
    const result = computeConnectorDataQuality('BIL', defaultIngestionRegistry, NOW);
    // CBS loan book is healthy by default
    const cbs = result.connectors.find((c) => c.connector_id === 'cbs_loan_book');
    if (cbs) {
      expect(cbs.connectivity_score).toBe(100);
    }
  });

  test('generated_at echoed correctly', () => {
    const result = computeConnectorDataQuality('BIL', defaultIngestionRegistry, NOW);
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

describe('GET /v1/ingestion/connectors/data-quality', () => {
  test('admin returns 200 with connectors array', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/ingestion/connectors/data-quality')
      .set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('connectors');
    expect(res.body.body).toHaveProperty('avg_quality_score');
  });

  test('non-admin returns 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/ingestion/connectors/data-quality')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('missing tenant header returns 400', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/ingestion/connectors/data-quality')
      .set('X-Channel', 'API');
    expect(res.status).toBe(400);
  });
});
