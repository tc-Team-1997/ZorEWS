// @ts-nocheck
// T6 M3.27 — Connector schema evolution tracker tests.

import request from 'supertest';
import { buildConnectorSchemaEvolution } from '../src/connector_schema_evolution';
import { listSchemaConnectorIds } from '../src/connector_schema';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
  return app;
}

describe('M3.27 — buildConnectorSchemaEvolution pure', () => {
  test('returns all connectors from the catalog', () => {
    const result = buildConnectorSchemaEvolution(NOW);
    const ids = listSchemaConnectorIds();
    expect(result.total_connectors).toBe(ids.length);
    expect(result.connectors).toHaveLength(ids.length);
  });

  test('every connector has required shape', () => {
    const result = buildConnectorSchemaEvolution(NOW);
    for (const c of result.connectors) {
      expect(typeof c.connector_id).toBe('string');
      expect(typeof c.version).toBe('string');
      expect(c.version_count).toBeGreaterThanOrEqual(1);
      expect(c.version_count).toBeLessThanOrEqual(5);
      expect(c.breaking_changes_count).toBeGreaterThanOrEqual(0);
      expect(c.breaking_changes_count).toBeLessThanOrEqual(3);
      expect(c.additive_changes_count).toBeGreaterThanOrEqual(1);
      expect(c.additive_changes_count).toBeLessThanOrEqual(8);
      expect(c.evolution_score).toBeGreaterThanOrEqual(0);
      expect(c.evolution_score).toBeLessThanOrEqual(100);
      expect(['evolving', 'stable', 'frozen']).toContain(c.maturity);
    }
  });

  test('deterministic output for same inputs', () => {
    const r1 = buildConnectorSchemaEvolution(NOW);
    const r2 = buildConnectorSchemaEvolution(NOW);
    expect(r1.connectors[0].evolution_score).toBe(r2.connectors[0].evolution_score);
  });

  test('most_stable and most_active connectors are non-null when data exists', () => {
    const result = buildConnectorSchemaEvolution(NOW);
    if (result.total_connectors > 0) {
      expect(result.most_stable_connector).not.toBeNull();
      expect(result.most_active_connector).not.toBeNull();
    }
  });

  test('generated_at echoes now', () => {
    const result = buildConnectorSchemaEvolution(NOW);
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

describe('M3.27 — GET /v1/ingestion/schema/evolution route', () => {
  test('admin 200 with envelope', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/ingestion/schema/evolution').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toBeDefined();
    expect(res.body.body.connectors).toBeInstanceOf(Array);
  });

  test('field_officer 403', async () => {
    const app = makeTestApp('field_officer');
    const res = await request(app).get('/v1/ingestion/schema/evolution').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant header → 400', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/ingestion/schema/evolution');
    expect(res.status).toBe(400);
  });
});
