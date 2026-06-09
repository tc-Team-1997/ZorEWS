// @ts-nocheck
// __tests__/connector_schema_field_frequency.test.ts
// T6 M3.21 — Connector schema field name frequency

import request from 'supertest';
import { buildConnectorSchemaFieldFrequency } from '../src/connector_schema_field_frequency';
import { listSchemaConnectorIds } from '../src/connector_schema';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-09T10:00:00Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('buildConnectorSchemaFieldFrequency — M3.21', () => {
  it('returns generated_at in envelope', () => {
    const result = buildConnectorSchemaFieldFrequency(NOW);
    expect(result.generated_at).toBe(NOW.toISOString());
  });

  it('total_connectors matches catalog size', () => {
    const result = buildConnectorSchemaFieldFrequency(NOW);
    const catalogSize = listSchemaConnectorIds().length;
    expect(result.total_connectors).toBe(catalogSize);
  });

  it('total_unique_fields > 0', () => {
    const result = buildConnectorSchemaFieldFrequency(NOW);
    expect(result.total_unique_fields).toBeGreaterThan(0);
  });

  it('fields sorted by count desc + field_name asc tie-break', () => {
    const result = buildConnectorSchemaFieldFrequency(NOW);
    for (let i = 1; i < result.fields.length; i++) {
      const prev = result.fields[i - 1];
      const cur = result.fields[i];
      if (prev.count === cur.count) {
        expect(prev.field_name <= cur.field_name).toBe(true);
      } else {
        expect(prev.count).toBeGreaterThan(cur.count);
      }
    }
  });

  it('every field entry has required shape', () => {
    const result = buildConnectorSchemaFieldFrequency(NOW);
    for (const field of result.fields) {
      expect(typeof field.field_name).toBe('string');
      expect(typeof field.count).toBe('number');
      expect(field.count).toBeGreaterThan(0);
      expect(Array.isArray(field.observed_in_connectors)).toBe(true);
      expect(Array.isArray(field.observed_types)).toBe(true);
      expect(typeof field.has_type_drift).toBe('boolean');
    }
  });

  it('observed_in_connectors sorted asc', () => {
    const result = buildConnectorSchemaFieldFrequency(NOW);
    for (const field of result.fields) {
      const sorted = [...field.observed_in_connectors].sort();
      expect(field.observed_in_connectors).toEqual(sorted);
    }
  });

  it('observed_types sorted asc', () => {
    const result = buildConnectorSchemaFieldFrequency(NOW);
    for (const field of result.fields) {
      const sorted = [...field.observed_types].sort();
      expect(field.observed_types).toEqual(sorted);
    }
  });

  it('has_type_drift true when multiple types observed', () => {
    const result = buildConnectorSchemaFieldFrequency(NOW);
    for (const field of result.fields) {
      expect(field.has_type_drift).toBe(field.observed_types.length > 1);
    }
  });

  it('most_shared_field has the highest count', () => {
    const result = buildConnectorSchemaFieldFrequency(NOW);
    if (result.most_shared_field) {
      expect(result.most_shared_field.count).toBe(result.fields[0].count);
    }
  });

  it('universal_fields are all connectors (count === total_connectors)', () => {
    const result = buildConnectorSchemaFieldFrequency(NOW);
    for (const fname of result.universal_fields) {
      const entry = result.fields.find(f => f.field_name === fname);
      expect(entry).toBeDefined();
      expect(entry.count).toBe(result.total_connectors);
    }
  });

  it('admin route GET /v1/ingestion/schema/field-frequency → 200', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/ingestion/schema/field-frequency')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(typeof res.body.body.total_connectors).toBe('number');
    expect(Array.isArray(res.body.body.fields)).toBe(true);
  });

  it('non-admin → 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/ingestion/schema/field-frequency')
      .set(TH_BIL)
      .set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });
});
