// services/bff/__tests__/connector_schema_source_map.test.ts
//
// T6 M3.7 — Connector schema source-map view.

import request from 'supertest';
import { mapConnectorSchemaSources } from '../src/connector_schema_source_map';
import { InMemorySchemaOverrideStore } from '../src/connector_schema_overrides';
import {
  getConnectorSchema,
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

function mkSchema(fields: FieldDef[]): ConnectorSchema {
  return {
    connector_id: 'test',
    version: '1.0',
    record_format: 'rest_json',
    primary_key: ['id'],
    fields,
  };
}

function mkField(name: string, type: FieldDef['type'] = 'string'): FieldDef {
  return { name, type, required: true, description: '', sample: 'x' };
}

// ─── mapConnectorSchemaSources — pure ────────────────────────────────

describe('M3.7 — mapConnectorSchemaSources — empty overrides', () => {
  test('no overrides → every field marked source=platform', () => {
    const platform = mkSchema([mkField('a'), mkField('b'), mkField('c')]);
    const out = mapConnectorSchemaSources(platform, []);
    expect(out.connector_id).toBe('test');
    expect(out.total_fields).toBe(3);
    expect(out.platform_field_count).toBe(3);
    expect(out.tenant_addition_count).toBe(0);
    expect(out.fields.every((f) => f.source === 'platform')).toBe(true);
  });

  test('platform field order preserved', () => {
    const platform = mkSchema([mkField('z'), mkField('a'), mkField('m')]);
    const out = mapConnectorSchemaSources(platform, []);
    expect(out.fields.map((f) => f.name)).toEqual(['z', 'a', 'm']);
  });
});

describe('M3.7 — mapConnectorSchemaSources — with additions', () => {
  test('tenant additions marked source=tenant_addition + counted', () => {
    const platform = mkSchema([mkField('a'), mkField('b')]);
    const out = mapConnectorSchemaSources(platform, [mkField('x'), mkField('y')]);
    expect(out.total_fields).toBe(4);
    expect(out.platform_field_count).toBe(2);
    expect(out.tenant_addition_count).toBe(2);
    expect(out.fields.map((f) => f.source)).toEqual([
      'platform',
      'platform',
      'tenant_addition',
      'tenant_addition',
    ]);
  });

  test('platform fields come BEFORE tenant additions in fields[]', () => {
    const platform = mkSchema([mkField('p1'), mkField('p2')]);
    const out = mapConnectorSchemaSources(platform, [mkField('t1'), mkField('t2')]);
    expect(out.fields.map((f) => f.name)).toEqual(['p1', 'p2', 't1', 't2']);
  });

  test('insertion order preserved across additions', () => {
    const platform = mkSchema([mkField('p1')]);
    const out = mapConnectorSchemaSources(platform, [
      mkField('zeta'),
      mkField('alpha'),
      mkField('mike'),
    ]);
    expect(out.fields.slice(1).map((f) => f.name)).toEqual(['zeta', 'alpha', 'mike']);
  });

  test('override with platform-clashing name is defensively skipped (platform wins)', () => {
    const platform = mkSchema([mkField('shared')]);
    const out = mapConnectorSchemaSources(platform, [mkField('shared'), mkField('extra')]);
    expect(out.tenant_addition_count).toBe(1);
    expect(out.fields.map((f) => f.name)).toEqual(['shared', 'extra']);
    expect(out.fields[0]!.source).toBe('platform');
  });
});

describe('M3.7 — field metadata projection', () => {
  test('type + required carried through from FieldDef', () => {
    const platform = mkSchema([
      { name: 'amount', type: 'number', required: true, description: '', sample: '0' },
      { name: 'note', type: 'string', required: false, description: '', sample: '' },
    ]);
    const out = mapConnectorSchemaSources(platform, []);
    expect(out.fields[0]).toMatchObject({
      name: 'amount',
      type: 'number',
      required: true,
    });
    expect(out.fields[1]).toMatchObject({
      name: 'note',
      type: 'string',
      required: false,
    });
  });
});

// ─── Route — GET /v1/ingestion/connectors/:id/schema/source-map ───────

function makeSchemaApp(role = 'admin', store?: InMemorySchemaOverrideStore) {
  const schemaOverrideStore = store ?? new InMemorySchemaOverrideStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    schemaOverrideStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, schemaOverrideStore };
}

describe('M3.7 — GET /v1/ingestion/connectors/:id/schema/source-map', () => {
  test('valid connector + no overrides → all fields source=platform', async () => {
    const { app } = makeSchemaApp('admin');
    // Use the real `cbs_loan_book` connector which exists in the platform catalog.
    const platform = getConnectorSchema('cbs_loan_book');
    expect(platform).not.toBeNull();
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/schema/source-map')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.connector_id).toBe('cbs_loan_book');
    expect(r.body.body.tenant_addition_count).toBe(0);
    expect(r.body.body.fields.every(
      (f: { source: string }) => f.source === 'platform',
    )).toBe(true);
  });

  test('after adding an override, source-map shows the tenant_addition', async () => {
    const store = new InMemorySchemaOverrideStore();
    store.add('BIL', 'cbs_loan_book', {
      name: 'tenant_extra',
      type: 'string',
      required: false,
      description: 'd',
      sample: 's',
    });
    const { app } = makeSchemaApp('admin', store);
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/schema/source-map')
      .set(TH_BIL);
    expect(r.body.body.tenant_addition_count).toBe(1);
    const tenantField = r.body.body.fields.find(
      (f: { name: string }) => f.name === 'tenant_extra',
    );
    expect(tenantField.source).toBe('tenant_addition');
  });

  test('unknown connector → 404', async () => {
    const { app } = makeSchemaApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/connectors/no.such.connector/schema/source-map')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_connector');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSchemaApp('case_owner');
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/schema/source-map')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL override invisible to BANK_DEMO', async () => {
    const store = new InMemorySchemaOverrideStore();
    store.add('BIL', 'cbs_loan_book', {
      name: 'bil_only',
      type: 'string',
      required: false,
      description: 'd',
      sample: 's',
    });
    const { app } = makeSchemaApp('admin', store);
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/schema/source-map')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_addition_count).toBe(0);
  });

  test('M3.3 /schema/effective still works (source-map is additive)', async () => {
    const { app } = makeSchemaApp('admin');
    const r = await request(app)
      .get('/v1/ingestion/connectors/cbs_loan_book/schema/effective')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
