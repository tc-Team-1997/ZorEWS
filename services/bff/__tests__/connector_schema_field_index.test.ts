// services/bff/__tests__/connector_schema_field_index.test.ts
//
// T6 M3.8 — Connector schema field cross-index.

import request from 'supertest';
import { indexConnectorSchemaFields } from '../src/connector_schema_field_index';
import type { ConnectorSchema } from '../src/connector_schema';
import {
  getConnectorSchema,
  listSchemaConnectorIds,
} from '../src/connector_schema';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── indexConnectorSchemaFields — pure ───────────────────────────────

describe('M3.8 — indexConnectorSchemaFields — empty', () => {
  test('zero connector ids → empty index', () => {
    const idx = indexConnectorSchemaFields([], () => null);
    expect(idx.total_connectors_scanned).toBe(0);
    expect(idx.total_unique_field_names).toBe(0);
    expect(idx.entries).toEqual([]);
  });

  test('connector ids with no schemas → empty index', () => {
    const idx = indexConnectorSchemaFields(['x', 'y', 'z'], () => null);
    expect(idx.total_connectors_scanned).toBe(0);
    expect(idx.total_unique_field_names).toBe(0);
  });
});

function mkSchema(connector_id: string, fields: ConnectorSchema['fields']): ConnectorSchema {
  return {
    connector_id,
    version: '1.0',
    record_format: 'csv',
    primary_key: [],
    fields,
  };
}

describe('M3.8 — single connector', () => {
  test('every field surfaces with observed_count=1 + single connector_id', () => {
    const schema = mkSchema('cbs', [
      { name: 'customer_id', type: 'string', required: true, description: '', sample: 'C1' },
      { name: 'loan_id', type: 'string', required: true, description: '', sample: 'L1' },
    ]);
    const idx = indexConnectorSchemaFields(['cbs'], (id) => (id === 'cbs' ? schema : null));
    expect(idx.total_connectors_scanned).toBe(1);
    expect(idx.total_unique_field_names).toBe(2);
    for (const e of idx.entries) {
      expect(e.observed_count).toBe(1);
      expect(e.connector_ids).toEqual(['cbs']);
    }
  });
});

describe('M3.8 — cross-connector shared field', () => {
  test('shared `customer_id` aggregates connector_ids', () => {
    const a = mkSchema('cbs', [
      { name: 'customer_id', type: 'string', required: true, description: '', sample: 'C1' },
      { name: 'loan_id', type: 'string', required: true, description: '', sample: 'L1' },
    ]);
    const b = mkSchema('bureau', [
      { name: 'customer_id', type: 'string', required: true, description: '', sample: 'C1' },
      { name: 'bureau_score', type: 'integer', required: true, description: '', sample: '750' },
    ]);
    const idx = indexConnectorSchemaFields(
      ['cbs', 'bureau'],
      (id) => (id === 'cbs' ? a : id === 'bureau' ? b : null),
    );
    expect(idx.total_connectors_scanned).toBe(2);
    const cust = idx.entries.find((e) => e.field_name === 'customer_id')!;
    expect(cust.observed_count).toBe(2);
    expect(cust.connector_ids).toEqual(['bureau', 'cbs']);
    expect(cust.observed_types).toEqual(['string']);
  });

  test('entries sorted by observed_count desc, field_name asc tie-break', () => {
    const a = mkSchema('cbs', [
      { name: 'a_uniq', type: 'string', required: true, description: '', sample: '' },
      { name: 'customer_id', type: 'string', required: true, description: '', sample: '' },
    ]);
    const b = mkSchema('bureau', [
      { name: 'b_uniq', type: 'string', required: true, description: '', sample: '' },
      { name: 'customer_id', type: 'string', required: true, description: '', sample: '' },
    ]);
    const idx = indexConnectorSchemaFields(
      ['cbs', 'bureau'],
      (id) => (id === 'cbs' ? a : id === 'bureau' ? b : null),
    );
    expect(idx.entries.map((e) => e.field_name)).toEqual(['customer_id', 'a_uniq', 'b_uniq']);
  });
});

describe('M3.8 — type drift detection', () => {
  test('same field with different types surfaces multiple observed_types', () => {
    const a = mkSchema('cbs', [
      { name: 'amount', type: 'number', required: true, description: '', sample: '100.00' },
    ]);
    const b = mkSchema('bureau', [
      { name: 'amount', type: 'integer', required: true, description: '', sample: '100' },
    ]);
    const idx = indexConnectorSchemaFields(
      ['cbs', 'bureau'],
      (id) => (id === 'cbs' ? a : id === 'bureau' ? b : null),
    );
    const amt = idx.entries.find((e) => e.field_name === 'amount')!;
    expect(amt.observed_types).toEqual(['integer', 'number']);
    expect(amt.observed_count).toBe(2);
  });
});

// ─── GET /v1/ingestion/schema/field-index ────────────────────────────

function makeIndexApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M3.8 — GET /v1/ingestion/schema/field-index', () => {
  test('admin → 200 with non-empty index over real catalog', async () => {
    const { app } = makeIndexApp('admin');
    const r = await request(app).get('/v1/ingestion/schema/field-index').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_connectors_scanned).toBeGreaterThan(0);
    expect(r.body.body.total_unique_field_names).toBeGreaterThan(0);
    expect(Array.isArray(r.body.body.entries)).toBe(true);
    // Spot-check: every entry has the required shape.
    for (const e of r.body.body.entries as Array<{ connector_ids: string[]; observed_types: string[]; observed_count: number }>) {
      expect(e.connector_ids.length).toBe(e.observed_count);
      expect(e.observed_types.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeIndexApp('readonly');
    const r = await request(app).get('/v1/ingestion/schema/field-index').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static — same response across tenants', async () => {
    const { app } = makeIndexApp('admin');
    const bil = await request(app).get('/v1/ingestion/schema/field-index').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/ingestion/schema/field-index')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });
});

// touch the imports so they aren't dropped — they're used inside server.ts
// via the real route, but tests touch them directly to assert coverage
void getConnectorSchema;
void listSchemaConnectorIds;
