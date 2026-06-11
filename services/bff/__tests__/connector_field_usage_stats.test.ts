// @ts-nocheck
// T6 M3.29 — Connector schema field usage stats tests.

import request from 'supertest';
import { buildConnectorFieldUsageStats } from '../src/connector_field_usage_stats';
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
  return { app };
}

describe('M3.29 — buildConnectorFieldUsageStats pure', () => {
  test('returns stats for every catalog connector', () => {
    const result = buildConnectorFieldUsageStats(NOW);
    const catalogIds = listSchemaConnectorIds();
    expect(result.connectors).toHaveLength(catalogIds.length);
    expect(result.generated_at).toBe(NOW.toISOString());
  });

  test('every connector has required fields', () => {
    const result = buildConnectorFieldUsageStats(NOW);
    for (const c of result.connectors) {
      expect(typeof c.connector_id).toBe('string');
      expect(typeof c.total_fields).toBe('number');
      expect(c.total_fields).toBeGreaterThan(0);
      expect(typeof c.required_pct).toBe('number');
      expect(c.required_pct).toBeGreaterThanOrEqual(0);
      expect(c.required_pct).toBeLessThanOrEqual(1);
      expect(typeof c.schema_complexity_score).toBe('number');
    }
  });

  test('sorted by complexity descending', () => {
    const result = buildConnectorFieldUsageStats(NOW);
    for (let i = 1; i < result.connectors.length; i++) {
      expect(result.connectors[i - 1].schema_complexity_score).toBeGreaterThanOrEqual(
        result.connectors[i].schema_complexity_score,
      );
    }
  });

  test('complexity score formula is correct', () => {
    const result = buildConnectorFieldUsageStats(NOW);
    for (const c of result.connectors) {
      const expected = c.enum_field_count * 3 + c.numeric_field_count * 2 + Math.round(c.required_pct * 10);
      expect(c.schema_complexity_score).toBe(expected);
    }
  });
});

describe('M3.29 — GET /v1/ingestion/schema/field-usage-stats route', () => {
  test('admin returns 200 with connectors list', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/ingestion/schema/field-usage-stats')
      .set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.connectors)).toBe(true);
    expect(res.body.body.connectors.length).toBeGreaterThan(0);
  });

  test('field_officer returns 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/ingestion/schema/field-usage-stats')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('platform-static: BIL = BANK_DEMO', async () => {
    const { app } = makeTestApp('admin');
    const r1 = await request(app).get('/v1/ingestion/schema/field-usage-stats').set(TH);
    const r2 = await request(app)
      .get('/v1/ingestion/schema/field-usage-stats')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r1.body.body.connectors).toEqual(r2.body.body.connectors);
  });
});
