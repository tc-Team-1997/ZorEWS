// services/bff/__tests__/connector_schema_compat.test.ts
//
// T6 M3.9 — Connector schema breaking-change check.

import request from 'supertest';
import {
  compareConnectorSchemas,
  validateCandidateSchema,
  SchemaCompatInputError,
} from '../src/connector_schema_compat';
import {
  getConnectorSchema,
  listSchemaConnectorIds,
  type ConnectorSchema,
  type FieldDef,
} from '../src/connector_schema';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkField(o: Partial<FieldDef> & { name: string }): FieldDef {
  return {
    name: o.name,
    type: o.type ?? 'string',
    required: o.required ?? false,
    description: o.description ?? '',
    sample: o.sample ?? '',
    enum_values: o.enum_values,
    max_length: o.max_length,
    min: o.min,
    max: o.max,
  };
}

function mkSchema(o: Partial<ConnectorSchema> & { connector_id: string; fields: FieldDef[] }): ConnectorSchema {
  return {
    connector_id: o.connector_id,
    version: o.version ?? '1.0',
    record_format: o.record_format ?? 'csv',
    primary_key: o.primary_key ?? [],
    fields: o.fields,
  };
}

// ─── compareConnectorSchemas — pure ──────────────────────────────────

describe('M3.9 — identical schemas → compatible', () => {
  test('no diff → compatible=true, zero breaks, all unchanged', () => {
    const s = mkSchema({
      connector_id: 'cbs',
      fields: [
        mkField({ name: 'customer_id', type: 'string', required: true }),
        mkField({ name: 'amount', type: 'number' }),
      ],
    });
    const r = compareConnectorSchemas(s, s);
    expect(r.compatible).toBe(true);
    expect(r.breaking_count).toBe(0);
    expect(r.unchanged_field_count).toBe(2);
  });
});

describe('M3.9 — field_removed', () => {
  test('removed field surfaces in breaking_changes', () => {
    const a = mkSchema({
      connector_id: 'cbs',
      fields: [mkField({ name: 'customer_id' }), mkField({ name: 'amount' })],
    });
    const b = mkSchema({
      connector_id: 'cbs',
      fields: [mkField({ name: 'customer_id' })],
    });
    const r = compareConnectorSchemas(a, b);
    expect(r.compatible).toBe(false);
    expect(r.breaking_changes).toContainEqual(
      expect.objectContaining({ field: 'amount', kind: 'field_removed' }),
    );
  });
});

describe('M3.9 — type_changed', () => {
  test('type swap from number to string is breaking', () => {
    const a = mkSchema({
      connector_id: 'cbs',
      fields: [mkField({ name: 'amount', type: 'number' })],
    });
    const b = mkSchema({
      connector_id: 'cbs',
      fields: [mkField({ name: 'amount', type: 'string' })],
    });
    const r = compareConnectorSchemas(a, b);
    expect(r.compatible).toBe(false);
    expect(r.breaking_changes).toContainEqual(
      expect.objectContaining({ field: 'amount', kind: 'type_changed' }),
    );
  });
});

describe('M3.9 — required transitions', () => {
  test('optional → required is breaking (required_added)', () => {
    const a = mkSchema({
      connector_id: 'cbs',
      fields: [mkField({ name: 'amount', required: false })],
    });
    const b = mkSchema({
      connector_id: 'cbs',
      fields: [mkField({ name: 'amount', required: true })],
    });
    const r = compareConnectorSchemas(a, b);
    expect(r.compatible).toBe(false);
    expect(r.breaking_changes).toContainEqual(
      expect.objectContaining({ field: 'amount', kind: 'required_added' }),
    );
  });

  test('required → optional is additive (required_loosened)', () => {
    const a = mkSchema({
      connector_id: 'cbs',
      fields: [mkField({ name: 'amount', required: true })],
    });
    const b = mkSchema({
      connector_id: 'cbs',
      fields: [mkField({ name: 'amount', required: false })],
    });
    const r = compareConnectorSchemas(a, b);
    expect(r.compatible).toBe(true);
    expect(r.additive_changes).toContainEqual(
      expect.objectContaining({ field: 'amount', kind: 'required_loosened' }),
    );
  });
});

describe('M3.9 — new field addition', () => {
  test('new optional field is additive', () => {
    const a = mkSchema({
      connector_id: 'cbs',
      fields: [mkField({ name: 'customer_id', required: true })],
    });
    const b = mkSchema({
      connector_id: 'cbs',
      fields: [
        mkField({ name: 'customer_id', required: true }),
        mkField({ name: 'new_optional', required: false }),
      ],
    });
    const r = compareConnectorSchemas(a, b);
    expect(r.compatible).toBe(true);
    expect(r.additive_changes).toContainEqual(
      expect.objectContaining({ field: 'new_optional', kind: 'field_added' }),
    );
  });

  test('new required field is breaking (new_required_field)', () => {
    const a = mkSchema({
      connector_id: 'cbs',
      fields: [mkField({ name: 'customer_id', required: true })],
    });
    const b = mkSchema({
      connector_id: 'cbs',
      fields: [
        mkField({ name: 'customer_id', required: true }),
        mkField({ name: 'new_required', required: true }),
      ],
    });
    const r = compareConnectorSchemas(a, b);
    expect(r.compatible).toBe(false);
    expect(r.breaking_changes).toContainEqual(
      expect.objectContaining({ field: 'new_required', kind: 'new_required_field' }),
    );
  });
});

describe('M3.9 — enum changes', () => {
  test('enum value removed → breaking; enum value added → additive', () => {
    const a = mkSchema({
      connector_id: 'cbs',
      fields: [
        mkField({ name: 'status', type: 'enum', enum_values: ['ACTIVE', 'INACTIVE'] }),
      ],
    });
    const removed = mkSchema({
      connector_id: 'cbs',
      fields: [
        mkField({ name: 'status', type: 'enum', enum_values: ['ACTIVE'] }),
      ],
    });
    const added = mkSchema({
      connector_id: 'cbs',
      fields: [
        mkField({ name: 'status', type: 'enum', enum_values: ['ACTIVE', 'INACTIVE', 'PENDING'] }),
      ],
    });
    const r1 = compareConnectorSchemas(a, removed);
    expect(r1.compatible).toBe(false);
    expect(r1.breaking_changes).toContainEqual(
      expect.objectContaining({ field: 'status', kind: 'enum_narrowed' }),
    );
    const r2 = compareConnectorSchemas(a, added);
    expect(r2.compatible).toBe(true);
    expect(r2.additive_changes).toContainEqual(
      expect.objectContaining({ field: 'status', kind: 'enum_widened' }),
    );
  });
});

describe('M3.9 — numeric bounds + length', () => {
  test('max_length decreased is breaking', () => {
    const a = mkSchema({ connector_id: 'c', fields: [mkField({ name: 'n', type: 'string', max_length: 200 })] });
    const b = mkSchema({ connector_id: 'c', fields: [mkField({ name: 'n', type: 'string', max_length: 100 })] });
    const r = compareConnectorSchemas(a, b);
    expect(r.compatible).toBe(false);
    expect(r.breaking_changes).toContainEqual(
      expect.objectContaining({ kind: 'max_length_decreased' }),
    );
  });

  test('min raised is breaking; max raised is additive', () => {
    const a = mkSchema({ connector_id: 'c', fields: [mkField({ name: 'n', type: 'number', min: 0, max: 100 })] });
    const b = mkSchema({ connector_id: 'c', fields: [mkField({ name: 'n', type: 'number', min: 10, max: 200 })] });
    const r = compareConnectorSchemas(a, b);
    expect(r.compatible).toBe(false);
    expect(r.breaking_changes).toContainEqual(expect.objectContaining({ kind: 'min_increased' }));
    expect(r.additive_changes).toContainEqual(expect.objectContaining({ kind: 'max_increased' }));
  });
});

describe('M3.9 — record_format change', () => {
  test('format swap is breaking', () => {
    const a = mkSchema({ connector_id: 'c', record_format: 'csv', fields: [] });
    const b = mkSchema({ connector_id: 'c', record_format: 'rest_json', fields: [] });
    const r = compareConnectorSchemas(a, b);
    expect(r.compatible).toBe(false);
    expect(r.breaking_changes).toContainEqual(
      expect.objectContaining({ kind: 'record_format_changed', field: null }),
    );
  });
});

describe('M3.9 — validateCandidateSchema', () => {
  test('rejects non-object', () => {
    expect(() => validateCandidateSchema(null, 'cbs')).toThrow(SchemaCompatInputError);
    expect(() => validateCandidateSchema('oops', 'cbs')).toThrow(SchemaCompatInputError);
  });

  test('rejects missing version', () => {
    expect(() =>
      validateCandidateSchema({ record_format: 'csv', fields: [] }, 'cbs'),
    ).toThrow(/version/);
  });

  test('rejects bad field type', () => {
    expect(() =>
      validateCandidateSchema(
        {
          version: '1.0',
          record_format: 'csv',
          fields: [{ name: 'x', type: 'bogus' }],
        },
        'cbs',
      ),
    ).toThrow(/invalid type/);
  });

  test('accepts minimal valid candidate', () => {
    const s = validateCandidateSchema(
      {
        version: '2.0',
        record_format: 'csv',
        fields: [{ name: 'x', type: 'string', required: true }],
      },
      'cbs',
    );
    expect(s.connector_id).toBe('cbs');
    expect(s.version).toBe('2.0');
    expect(s.fields).toHaveLength(1);
  });
});

// ─── POST /v1/ingestion/connectors/:id/schema/compare ────────────────

function makeCompatApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M3.9 — POST /v1/ingestion/connectors/:id/schema/compare', () => {
  test('happy path: candidate identical to current → compatible', async () => {
    const { app } = makeCompatApp('admin');
    const id = listSchemaConnectorIds()[0]!;
    const current = getConnectorSchema(id)!;
    const r = await request(app)
      .post(`/v1/ingestion/connectors/${id}/schema/compare`)
      .set(TH_BIL)
      .send({ candidate: current });
    expect(r.status).toBe(200);
    expect(r.body.body.compatible).toBe(true);
    expect(r.body.body.breaking_count).toBe(0);
  });

  test('candidate that drops a field → not compatible', async () => {
    const { app } = makeCompatApp('admin');
    const id = listSchemaConnectorIds()[0]!;
    const current = getConnectorSchema(id)!;
    expect(current.fields.length).toBeGreaterThan(0);
    const candidate = { ...current, fields: current.fields.slice(0, -1) };
    const r = await request(app)
      .post(`/v1/ingestion/connectors/${id}/schema/compare`)
      .set(TH_BIL)
      .send({ candidate });
    expect(r.status).toBe(200);
    expect(r.body.body.compatible).toBe(false);
    expect(r.body.body.breaking_count).toBeGreaterThan(0);
  });

  test('unknown connector → 404', async () => {
    const { app } = makeCompatApp('admin');
    const r = await request(app)
      .post('/v1/ingestion/connectors/not-real/schema/compare')
      .set(TH_BIL)
      .send({ candidate: { version: '1.0', record_format: 'csv', fields: [] } });
    expect(r.status).toBe(404);
  });

  test('missing candidate → 400', async () => {
    const { app } = makeCompatApp('admin');
    const id = listSchemaConnectorIds()[0]!;
    const r = await request(app)
      .post(`/v1/ingestion/connectors/${id}/schema/compare`)
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
  });

  test('invalid candidate field type → 400', async () => {
    const { app } = makeCompatApp('admin');
    const id = listSchemaConnectorIds()[0]!;
    const r = await request(app)
      .post(`/v1/ingestion/connectors/${id}/schema/compare`)
      .set(TH_BIL)
      .send({
        candidate: {
          version: '1.0',
          record_format: 'csv',
          fields: [{ name: 'x', type: 'bogus' }],
        },
      });
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCompatApp('readonly');
    const id = listSchemaConnectorIds()[0]!;
    const r = await request(app)
      .post(`/v1/ingestion/connectors/${id}/schema/compare`)
      .set(TH_BIL)
      .send({ candidate: { version: '1.0', record_format: 'csv', fields: [] } });
    expect(r.status).toBe(403);
  });
});
