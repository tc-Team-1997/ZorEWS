// services/bff/__tests__/connector_schema_overrides.test.ts
//
// T6 M3.3 — Per-tenant schema overrides.

import request from 'supertest';
import {
  InMemorySchemaOverrideStore,
  SchemaOverrideError,
} from '../src/connector_schema_overrides';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T21:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const FIELD_OK = {
  name: 'tenant_internal_ref',
  type: 'string',
  required: false,
  description: 'BIL internal reference',
  sample: 'INT-12345',
  max_length: 32,
};

function makeOverrideApp(role = 'admin') {
  const store = new InMemorySchemaOverrideStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    schemaOverrideStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

describe('InMemorySchemaOverrideStore', () => {
  test('add → list returns the field', () => {
    const s = new InMemorySchemaOverrideStore();
    s.add('BIL', 'cbs_loan_book', FIELD_OK);
    const items = s.list('BIL', 'cbs_loan_book');
    expect(items.length).toBe(1);
    expect(items[0]!.name).toBe('tenant_internal_ref');
  });

  test('reserved_field: rejecting platform-existing field name', () => {
    const s = new InMemorySchemaOverrideStore();
    expect(() =>
      s.add('BIL', 'cbs_loan_book', { ...FIELD_OK, name: 'customer_id' }),
    ).toThrow(/reserved_field|already in the platform/);
  });

  test('duplicate_field: same field added twice', () => {
    const s = new InMemorySchemaOverrideStore();
    s.add('BIL', 'cbs_loan_book', FIELD_OK);
    try {
      s.add('BIL', 'cbs_loan_book', FIELD_OK);
      fail('expected throw');
    } catch (e) {
      expect((e as SchemaOverrideError).code).toBe('duplicate_field');
    }
  });

  test('unknown_connector → throws', () => {
    const s = new InMemorySchemaOverrideStore();
    try {
      s.add('BIL', 'NO-SUCH', FIELD_OK);
      fail('expected throw');
    } catch (e) {
      expect((e as SchemaOverrideError).code).toBe('unknown_connector');
    }
  });

  test('cap_reached after 25 fields', () => {
    const s = new InMemorySchemaOverrideStore();
    for (let i = 0; i < 25; i++) {
      s.add('BIL', 'cbs_loan_book', { ...FIELD_OK, name: `extra_${i}` });
    }
    try {
      s.add('BIL', 'cbs_loan_book', { ...FIELD_OK, name: 'extra_26' });
      fail('expected throw');
    } catch (e) {
      expect((e as SchemaOverrideError).code).toBe('cap_reached');
    }
  });

  test('enum field requires enum_values', () => {
    const s = new InMemorySchemaOverrideStore();
    expect(() =>
      s.add('BIL', 'cbs_loan_book', { ...FIELD_OK, type: 'enum' }),
    ).toThrow(/enum_values/);
  });

  test('enum field with enum_values accepted', () => {
    const s = new InMemorySchemaOverrideStore();
    const f = s.add('BIL', 'cbs_loan_book', {
      ...FIELD_OK,
      name: 'priority',
      type: 'enum',
      enum_values: ['low', 'high'],
    });
    expect(f.enum_values).toEqual(['low', 'high']);
  });

  test('cross-tenant isolation', () => {
    const s = new InMemorySchemaOverrideStore();
    s.add('BIL', 'cbs_loan_book', FIELD_OK);
    expect(s.list('BANK_DEMO', 'cbs_loan_book')).toEqual([]);
  });

  test('remove returns true on hit, false on miss', () => {
    const s = new InMemorySchemaOverrideStore();
    s.add('BIL', 'cbs_loan_book', FIELD_OK);
    expect(s.remove('BIL', 'cbs_loan_book', 'tenant_internal_ref')).toBe(true);
    expect(s.remove('BIL', 'cbs_loan_book', 'tenant_internal_ref')).toBe(false);
  });

  test('effective() merges platform + overrides', () => {
    const s = new InMemorySchemaOverrideStore();
    s.add('BIL', 'cbs_loan_book', FIELD_OK);
    const eff = s.effective('BIL', 'cbs_loan_book')!;
    const platformCount = eff.fields.length - 1;
    expect(platformCount).toBeGreaterThan(0);
    expect(eff.fields[eff.fields.length - 1]!.name).toBe('tenant_internal_ref');
  });

  test('effective() returns null for unknown connector', () => {
    const s = new InMemorySchemaOverrideStore();
    expect(s.effective('BIL', 'NO-SUCH')).toBeNull();
  });
});

describe('Routes', () => {
  test('GET overrides list 200 (empty initially)', async () => {
    const { app } = makeOverrideApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/schema/overrides')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });

  test('GET overrides 404 on unknown connector', async () => {
    const { app } = makeOverrideApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/connectors/NO-SUCH/schema/overrides')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('POST add → 201 → list shows it', async () => {
    const { app } = makeOverrideApp('admin');
    const c = await request(app)
      .post('/v1/ingestion/connectors/cbs_loan_book/schema/overrides')
      .set(TH_BIL)
      .send(FIELD_OK);
    expect(c.status).toBe(201);
    const list = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/schema/overrides')
      .set(TH_BIL);
    expect(list.body.body.total).toBe(1);
  });

  test('POST reserved_field → 409 EWS_409_reserved_field', async () => {
    const { app } = makeOverrideApp('admin');
    const r = await request(app)
      .post('/v1/ingestion/connectors/cbs_loan_book/schema/overrides')
      .set(TH_BIL)
      .send({ ...FIELD_OK, name: 'customer_id' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_reserved_field');
  });

  test('POST duplicate → 409', async () => {
    const { app } = makeOverrideApp('admin');
    await request(app)
      .post('/v1/ingestion/connectors/cbs_loan_book/schema/overrides')
      .set(TH_BIL)
      .send(FIELD_OK);
    const r = await request(app)
      .post('/v1/ingestion/connectors/cbs_loan_book/schema/overrides')
      .set(TH_BIL)
      .send(FIELD_OK);
    expect(r.status).toBe(409);
  });

  test('POST unknown connector → 404', async () => {
    const { app } = makeOverrideApp('admin');
    const r = await request(app)
      .post('/v1/ingestion/connectors/NO-SUCH/schema/overrides')
      .set(TH_BIL)
      .send(FIELD_OK);
    expect(r.status).toBe(404);
  });

  test('DELETE 204 then 404', async () => {
    const { app } = makeOverrideApp('admin');
    await request(app)
      .post('/v1/ingestion/connectors/cbs_loan_book/schema/overrides')
      .set(TH_BIL)
      .send(FIELD_OK);
    const d1 = await request(app)
      .delete('/v1/ingestion/connectors/cbs_loan_book/schema/overrides/tenant_internal_ref')
      .set(TH_BIL);
    expect(d1.status).toBe(204);
    const d2 = await request(app)
      .delete('/v1/ingestion/connectors/cbs_loan_book/schema/overrides/tenant_internal_ref')
      .set(TH_BIL);
    expect(d2.status).toBe(404);
  });

  test('GET effective merges platform + overrides', async () => {
    const { app } = makeOverrideApp('admin');
    await request(app)
      .post('/v1/ingestion/connectors/cbs_loan_book/schema/overrides')
      .set(TH_BIL)
      .send(FIELD_OK);
    const eff = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/schema/effective')
      .set(TH_BIL);
    expect(eff.status).toBe(200);
    const last = eff.body.body.fields[eff.body.body.fields.length - 1];
    expect(last.name).toBe('tenant_internal_ref');
  });
});
