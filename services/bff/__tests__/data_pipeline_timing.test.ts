// @ts-nocheck
// T6 M3.28 — Data pipeline execution time analysis.

import request from 'supertest';
import { buildDataPipelineTiming } from '../src/data_pipeline_timing';
import { InMemoryIngestionRegistry } from '../src/ingestion';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTimingApp(role = 'admin', registry = new InMemoryIngestionRegistry()) {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => role, ingestionRegistry: registry });
  return app;
}

describe('M3.28 — pipeline timing', () => {
  test('returns timing for all connectors', () => {
    const registry = new InMemoryIngestionRegistry();
    const out = buildDataPipelineTiming(registry, 'BIL', NOW);
    expect(out.connectors.length).toBeGreaterThan(0);
  });

  test('each connector has all timing fields', () => {
    const registry = new InMemoryIngestionRegistry();
    const out = buildDataPipelineTiming(registry, 'BIL', NOW);
    for (const c of out.connectors) {
      expect(c.avg_extraction_s).toBeGreaterThanOrEqual(10);
      expect(c.avg_transformation_s).toBeGreaterThanOrEqual(5);
      expect(c.avg_load_s).toBeGreaterThanOrEqual(2);
      expect(c.total_pipeline_s).toBe(c.avg_extraction_s + c.avg_transformation_s + c.avg_load_s);
      expect(['extraction', 'transformation', 'load']).toContain(c.bottleneck);
      expect(typeof c.sla_met).toBe('boolean');
    }
  });

  test('sorted by total_pipeline_s desc', () => {
    const registry = new InMemoryIngestionRegistry();
    const out = buildDataPipelineTiming(registry, 'BIL', NOW);
    for (let i = 0; i < out.connectors.length - 1; i++) {
      expect(out.connectors[i].total_pipeline_s).toBeGreaterThanOrEqual(out.connectors[i + 1].total_pipeline_s);
    }
  });

  test('slowest_pipeline points at first row', () => {
    const registry = new InMemoryIngestionRegistry();
    const out = buildDataPipelineTiming(registry, 'BIL', NOW);
    if (out.connectors.length > 0) {
      expect(out.slowest_pipeline?.connector_id).toBe(out.connectors[0].connector_id);
    }
  });

  test('deterministic for same inputs', () => {
    const registry = new InMemoryIngestionRegistry();
    const out1 = buildDataPipelineTiming(registry, 'BIL', NOW);
    const out2 = buildDataPipelineTiming(registry, 'BIL', NOW);
    expect(out1.connectors[0].total_pipeline_s).toBe(out2.connectors[0].total_pipeline_s);
  });
});

describe('M3.28 — route', () => {
  test('admin GET /v1/ingestion/pipeline/timing returns 200', async () => {
    const app = makeTimingApp();
    const res = await request(app).get('/v1/ingestion/pipeline/timing').set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.connectors)).toBe(true);
  });

  test('non-admin gets 403', async () => {
    const app = makeTimingApp('field_officer');
    const res = await request(app).get('/v1/ingestion/pipeline/timing').set(TH);
    expect(res.status).toBe(403);
  });
});
