// @ts-nocheck
// T6 M3.23 — Connector schema version drift detection tests.

import request from 'supertest';
import { buildConnectorSchemaVersionDrift } from '../src/connector_schema_version_drift';
import { listSchemaConnectorIds } from '../src/connector_schema';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const H = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

describe('buildConnectorSchemaVersionDrift — shape', () => {
  test('returns correct envelope fields', () => {
    const r = buildConnectorSchemaVersionDrift(NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(typeof r.total_connectors).toBe('number');
    expect(Array.isArray(r.by_source_system)).toBe(true);
    expect(Array.isArray(r.drifting_systems)).toBe(true);
    expect(Array.isArray(r.stable_systems)).toBe(true);
  });

  test('total_connectors matches catalog', () => {
    const r = buildConnectorSchemaVersionDrift(NOW);
    expect(r.total_connectors).toBe(listSchemaConnectorIds().length);
  });

  test('drifting + stable = all systems', () => {
    const r = buildConnectorSchemaVersionDrift(NOW);
    const allSystems = r.by_source_system.map(s => s.source_system);
    const driftingAndStable = [...r.drifting_systems, ...r.stable_systems].sort();
    expect(allSystems.sort()).toEqual(driftingAndStable);
  });

  test('sorted by drift_magnitude desc', () => {
    const r = buildConnectorSchemaVersionDrift(NOW);
    for (let i = 1; i < r.by_source_system.length; i++) {
      expect(r.by_source_system[i - 1].drift_magnitude).toBeGreaterThanOrEqual(
        r.by_source_system[i].drift_magnitude,
      );
    }
  });

  test('each source system entry has correct fields', () => {
    const r = buildConnectorSchemaVersionDrift(NOW);
    for (const s of r.by_source_system) {
      expect(typeof s.source_system).toBe('string');
      expect(typeof s.connector_count).toBe('number');
      expect(Array.isArray(s.field_counts)).toBe(true);
      expect(typeof s.has_drift).toBe('boolean');
      expect(typeof s.min_fields).toBe('number');
      expect(typeof s.max_fields).toBe('number');
      expect(typeof s.drift_magnitude).toBe('number');
      expect(s.drift_magnitude).toBe(s.max_fields - s.min_fields);
    }
  });

  test('has_drift only true when connector_count > 1 and drift_magnitude > 0', () => {
    const r = buildConnectorSchemaVersionDrift(NOW);
    for (const s of r.by_source_system) {
      if (s.has_drift) {
        expect(s.connector_count).toBeGreaterThan(1);
        expect(s.drift_magnitude).toBeGreaterThan(0);
      }
    }
  });

  test('drifting_systems sorted asc', () => {
    const r = buildConnectorSchemaVersionDrift(NOW);
    const sorted = [...r.drifting_systems].sort();
    expect(r.drifting_systems).toEqual(sorted);
  });

  test('stable_systems sorted asc', () => {
    const r = buildConnectorSchemaVersionDrift(NOW);
    const sorted = [...r.stable_systems].sort();
    expect(r.stable_systems).toEqual(sorted);
  });
});

describe('route — /v1/ingestion/schema/version-drift', () => {
  test('GET returns 200 with correct shape', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
    });
    const res = await request(app).get('/v1/ingestion/schema/version-drift').set(H);
    expect(res.status).toBe(200);
    expect(typeof res.body.body.total_connectors).toBe('number');
    expect(Array.isArray(res.body.body.by_source_system)).toBe(true);
    expect(Array.isArray(res.body.body.drifting_systems)).toBe(true);
    expect(Array.isArray(res.body.body.stable_systems)).toBe(true);
  });

  test('403 for wrong role', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'field_officer',
    });
    const res = await request(app).get('/v1/ingestion/schema/version-drift').set(H);
    expect(res.status).toBe(403);
  });

  test('platform-static — BIL and BANK_DEMO get same result', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
    });
    const r1 = await request(app).get('/v1/ingestion/schema/version-drift').set({ 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' });
    const r2 = await request(app).get('/v1/ingestion/schema/version-drift').set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r1.body.body.total_connectors).toBe(r2.body.body.total_connectors);
  });
});
