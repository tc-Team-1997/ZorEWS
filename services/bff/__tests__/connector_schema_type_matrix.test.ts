// services/bff/__tests__/connector_schema_type_matrix.test.ts
//
// T6 M3.11 — Connector schema field type-coverage matrix.

import request from 'supertest';
import { buildConnectorSchemaTypeMatrix } from '../src/connector_schema_type_matrix';
import {
  listSchemaConnectorIds,
  getConnectorSchema,
  type FieldType,
} from '../src/connector_schema';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── buildConnectorSchemaTypeMatrix — pure ───────────────────────────

describe('M3.11 — matrix shape', () => {
  test('covers every connector in the M3.2 catalog', () => {
    const m = buildConnectorSchemaTypeMatrix();
    expect(m.total_connectors).toBe(listSchemaConnectorIds().length);
    expect(m.connectors.length).toBe(m.total_connectors);
    const ids = new Set(m.connectors.map((r) => r.connector_id));
    for (const id of listSchemaConnectorIds()) {
      expect(ids.has(id)).toBe(true);
    }
  });

  test('every row has all 7 FieldType keys', () => {
    const m = buildConnectorSchemaTypeMatrix();
    const expectedKeys: FieldType[] = ['string', 'integer', 'number', 'boolean', 'date', 'datetime', 'enum'];
    for (const row of m.connectors) {
      for (const k of expectedKeys) {
        expect(row.by_type).toHaveProperty(k);
        expect(typeof row.by_type[k]).toBe('number');
      }
    }
  });

  test('per-row by_type counts agree with schema field types', () => {
    const m = buildConnectorSchemaTypeMatrix();
    for (const row of m.connectors) {
      const schema = getConnectorSchema(row.connector_id)!;
      const expected: Record<FieldType, number> = {
        string: 0, integer: 0, number: 0, boolean: 0, date: 0, datetime: 0, enum: 0,
      };
      for (const f of schema.fields) expected[f.type]++;
      expect(row.by_type).toEqual(expected);
      expect(row.total_fields).toBe(schema.fields.length);
    }
  });

  test('required + optional sum to total_fields per row', () => {
    const m = buildConnectorSchemaTypeMatrix();
    for (const row of m.connectors) {
      expect(row.required_count + row.optional_count).toBe(row.total_fields);
    }
  });

  test('per-type total Σ across connectors equals by_type_totals', () => {
    const m = buildConnectorSchemaTypeMatrix();
    const types: FieldType[] = ['string', 'integer', 'number', 'boolean', 'date', 'datetime', 'enum'];
    for (const t of types) {
      const sum = m.connectors.reduce((acc, r) => acc + r.by_type[t], 0);
      expect(m.by_type_totals[t]).toBe(sum);
    }
  });

  test('total_fields = Σ per-row total_fields = Σ by_type_totals', () => {
    const m = buildConnectorSchemaTypeMatrix();
    const rowSum = m.connectors.reduce((acc, r) => acc + r.total_fields, 0);
    expect(m.total_fields).toBe(rowSum);
    const types: FieldType[] = ['string', 'integer', 'number', 'boolean', 'date', 'datetime', 'enum'];
    const typeSum = types.reduce((acc, t) => acc + m.by_type_totals[t], 0);
    expect(m.total_fields).toBe(typeSum);
  });

  test('total_required + total_optional = total_fields', () => {
    const m = buildConnectorSchemaTypeMatrix();
    expect(m.total_required + m.total_optional).toBe(m.total_fields);
  });

  test('connectors sorted by total_fields desc with connector_id asc tie-break', () => {
    const m = buildConnectorSchemaTypeMatrix();
    for (let i = 1; i < m.connectors.length; i++) {
      const prev = m.connectors[i - 1]!;
      const curr = m.connectors[i]!;
      if (prev.total_fields === curr.total_fields) {
        expect(prev.connector_id < curr.connector_id).toBe(true);
      } else {
        expect(prev.total_fields).toBeGreaterThan(curr.total_fields);
      }
    }
  });

  test('dominant_type is the highest-count type per row', () => {
    const m = buildConnectorSchemaTypeMatrix();
    for (const row of m.connectors) {
      if (row.total_fields === 0) {
        expect(row.dominant_type).toBeNull();
        continue;
      }
      expect(row.dominant_type).not.toBeNull();
      const max = Math.max(...Object.values(row.by_type));
      expect(row.by_type[row.dominant_type!]).toBe(max);
    }
  });

  test('connectors_without_type has every FieldType key', () => {
    const m = buildConnectorSchemaTypeMatrix();
    const types: FieldType[] = ['string', 'integer', 'number', 'boolean', 'date', 'datetime', 'enum'];
    for (const t of types) {
      expect(m.connectors_without_type).toHaveProperty(t);
      expect(Array.isArray(m.connectors_without_type[t])).toBe(true);
    }
  });

  test('connectors_without_type[t] only contains rows with by_type[t]=0, sorted asc', () => {
    const m = buildConnectorSchemaTypeMatrix();
    const types: FieldType[] = ['string', 'integer', 'number', 'boolean', 'date', 'datetime', 'enum'];
    for (const t of types) {
      const list = m.connectors_without_type[t];
      // sorted asc
      expect([...list].sort()).toEqual(list);
      for (const id of list) {
        const row = m.connectors.find((r) => r.connector_id === id)!;
        expect(row.by_type[t]).toBe(0);
      }
      // Reverse direction: any row with by_type[t]=0 must be in the list
      for (const row of m.connectors) {
        if (row.by_type[t] === 0) {
          expect(list).toContain(row.connector_id);
        } else {
          expect(list).not.toContain(row.connector_id);
        }
      }
    }
  });

  test('connector versions echoed from schemas', () => {
    const m = buildConnectorSchemaTypeMatrix();
    for (const row of m.connectors) {
      const schema = getConnectorSchema(row.connector_id)!;
      expect(row.version).toBe(schema.version);
    }
  });

  test('total_connectors > 0 (catalog has at least one)', () => {
    const m = buildConnectorSchemaTypeMatrix();
    expect(m.total_connectors).toBeGreaterThan(0);
  });
});

// ─── GET /v1/ingestion/schema/type-matrix ────────────────────────────

function makeMatrixApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M3.11 — GET /v1/ingestion/schema/type-matrix', () => {
  test('admin → 200 with full matrix', async () => {
    const { app } = makeMatrixApp('admin');
    const r = await request(app).get('/v1/ingestion/schema/type-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_connectors).toBeGreaterThan(0);
    expect(r.body.body.connectors.length).toBe(r.body.body.total_connectors);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeMatrixApp('case_owner');
    const r = await request(app).get('/v1/ingestion/schema/type-matrix').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL and BANK_DEMO see the same matrix', async () => {
    const { app } = makeMatrixApp('admin');
    const bil = await request(app).get('/v1/ingestion/schema/type-matrix').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/ingestion/schema/type-matrix')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });

  test('M3.8 /v1/ingestion/schema/field-index still works (sibling route)', async () => {
    const { app } = makeMatrixApp('admin');
    const r = await request(app).get('/v1/ingestion/schema/field-index').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
