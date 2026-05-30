// Phase 9 T11 — Master Setup framework foundation tests.
//
// Covers the reusable store factory + the CRUD route block. The factory
// is the headline contract — each of the 3 representative entities
// (countries / departments / risk-categories) is exercised through it.

import request from 'supertest';
import {
  createMasterStore,
  MasterStoreError,
  type MasterSchema,
} from '../src/masters/createMasterStore';
import {
  getMasterStore,
  listMasterCatalog,
  MASTER_SCHEMAS,
} from '../src/masters/registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-30T15:00:00.000Z');
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeMasterApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ── createMasterStore — pure factory ──────────────────────────────────

const TINY_SCHEMA: MasterSchema = {
  entity: 'tiny',
  label: 'Tiny',
  label_plural: 'Tinies',
  tenant_scoped: true,
  fields: [
    { name: 'name', type: 'string', required: true, max_length: 20 },
    { name: 'count', type: 'integer' },
    { name: 'kind', type: 'enum', enum_values: ['a', 'b', 'c'] },
    { name: 'active', type: 'boolean' },
  ],
};

describe('createMasterStore — validation', () => {
  test('rejects missing required field on create', () => {
    const s = createMasterStore(TINY_SCHEMA);
    expect(() => s.create('BIL', 'alice', { count: 1 })).toThrow(MasterStoreError);
  });

  test('rejects wrong type', () => {
    const s = createMasterStore(TINY_SCHEMA);
    expect(() => s.create('BIL', 'alice', { name: 'a', count: 'not-a-number' })).toThrow(
      /must be an integer/,
    );
  });

  test('rejects enum violation', () => {
    const s = createMasterStore(TINY_SCHEMA);
    expect(() => s.create('BIL', 'alice', { name: 'a', kind: 'd' })).toThrow(
      /must be one of/,
    );
  });

  test('rejects too-long string', () => {
    const s = createMasterStore(TINY_SCHEMA);
    const huge = 'x'.repeat(25);
    expect(() => s.create('BIL', 'alice', { name: huge })).toThrow(/max length 20/);
  });

  test('accepts every valid field type', () => {
    const s = createMasterStore(TINY_SCHEMA);
    const row = s.create('BIL', 'alice', { name: 'demo', count: 7, kind: 'a', active: true });
    expect(row.fields).toEqual({ name: 'demo', count: 7, kind: 'a', active: true });
  });
});

describe('createMasterStore — CRUD lifecycle', () => {
  test('create + get + update + delete round-trip', () => {
    const s = createMasterStore(TINY_SCHEMA);
    const row = s.create('BIL', 'alice', { name: 'demo' });
    expect(s.get('BIL', row.id)?.fields.name).toBe('demo');
    const upd = s.update('BIL', row.id, 'bob', { name: 'renamed', count: 5 });
    expect(upd.fields.name).toBe('renamed');
    expect(upd.fields.count).toBe(5);
    expect(upd.updated_by).toBe('bob');
    expect(s.delete('BIL', row.id)).toBe(true);
    expect(s.get('BIL', row.id)).toBeUndefined();
    expect(s.delete('BIL', row.id)).toBe(false); // 2nd delete returns false
  });

  test('update on unknown id throws unknown_row', () => {
    const s = createMasterStore(TINY_SCHEMA);
    expect(() => s.update('BIL', 'bogus', 'alice', { name: 'x' })).toThrow(
      /unknown.*bogus/,
    );
  });

  test('list returns newest-first', () => {
    const s = createMasterStore(TINY_SCHEMA);
    const a = s.create('BIL', 'alice', { name: 'first' });
    const b = s.create('BIL', 'alice', { name: 'second' });
    const rows = s.list('BIL');
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
  });
});

describe('createMasterStore — tenant scoping', () => {
  test('tenant_scoped=true: BIL rows invisible to BANK_DEMO', () => {
    const s = createMasterStore(TINY_SCHEMA);
    s.create('BIL', 'alice', { name: 'bil-row' });
    expect(s.list('BIL')).toHaveLength(1);
    expect(s.list('BANK_DEMO')).toHaveLength(0);
  });

  test('tenant_scoped=false: every tenant sees the same shared row set', () => {
    const platformSchema: MasterSchema = { ...TINY_SCHEMA, entity: 'platform', tenant_scoped: false };
    const s = createMasterStore(platformSchema);
    s.create('BIL', 'alice', { name: 'shared-row' });
    expect(s.list('BIL')).toHaveLength(1);
    expect(s.list('BANK_DEMO')).toHaveLength(1);
    expect(s.list('BANK_DEMO')[0]!.tenant_id).toBe('PLATFORM');
  });
});

describe('createMasterStore — seed rows', () => {
  test('seed rows applied on construction', () => {
    const seeded: MasterSchema = {
      ...TINY_SCHEMA,
      entity: 'seeded',
      seed: [{ name: 'seed-1' }, { name: 'seed-2', count: 3 }],
    };
    const s = createMasterStore(seeded);
    expect(s.list('BANK_DEMO')).toHaveLength(2);
  });
});

// ── Registry ───────────────────────────────────────────────────────────

describe('master registry', () => {
  test('catalog exposes every registered entity with required metadata', () => {
    const catalog = listMasterCatalog();
    // The framework grew past the original 3 — assert each canonical
    // entity is present rather than locking the count.
    expect(catalog.length).toBeGreaterThanOrEqual(9);
    const names = catalog.map((c) => c.entity).sort();
    for (const expected of [
      'case-priorities',
      'case-types',
      'channels',
      'countries',
      'currencies',
      'departments',
      'regulatory-frameworks',
      'risk-categories',
      'severity-levels',
    ]) {
      expect(names).toContain(expected);
    }
    for (const c of catalog) {
      expect(typeof c.label).toBe('string');
      expect(typeof c.label_plural).toBe('string');
      expect(typeof c.tenant_scoped).toBe('boolean');
      expect(c.field_count).toBeGreaterThan(0);
    }
  });

  test('Countries is platform-static; Departments + Risk Categories are tenant-scoped', () => {
    const byEntity = Object.fromEntries(listMasterCatalog().map((c) => [c.entity, c]));
    expect(byEntity.countries!.tenant_scoped).toBe(false);
    expect(byEntity.departments!.tenant_scoped).toBe(true);
    expect(byEntity['risk-categories']!.tenant_scoped).toBe(true);
  });

  test('Phase-9 expansion entities have correct tenancy + non-empty seeds', () => {
    const byEntity = Object.fromEntries(listMasterCatalog().map((c) => [c.entity, c]));
    // Platform-static entities (canonical ISO / regulator lists).
    expect(byEntity.currencies!.tenant_scoped).toBe(false);
    expect(byEntity['regulatory-frameworks']!.tenant_scoped).toBe(false);
    // Per-tenant entities (operator-configurable).
    expect(byEntity['severity-levels']!.tenant_scoped).toBe(true);
    expect(byEntity['case-types']!.tenant_scoped).toBe(true);
    expect(byEntity['case-priorities']!.tenant_scoped).toBe(true);
    expect(byEntity.channels!.tenant_scoped).toBe(true);
    // Every entity carries at least one seed row out of the box.
    for (const entity of ['currencies', 'severity-levels', 'case-types', 'case-priorities', 'regulatory-frameworks', 'channels']) {
      const store = getMasterStore(entity);
      expect(store).toBeDefined();
      expect(store!.list('BANK_DEMO').length).toBeGreaterThan(0);
    }
  });

  test('getMasterStore returns the store for each entity + undefined for unknown', () => {
    for (const schema of MASTER_SCHEMAS) {
      expect(getMasterStore(schema.entity)).toBeDefined();
    }
    expect(getMasterStore('ghost')).toBeUndefined();
  });
});

// ── HTTP routes ────────────────────────────────────────────────────────

describe('GET /v1/admin/masters — catalog listing', () => {
  test('admin → 200 with the full catalog', async () => {
    const { app } = makeMasterApp('admin');
    const r = await request(app).get('/v1/admin/masters').set(TH_BIL);
    expect(r.status).toBe(200);
    // Lock the framework's row count to ≥ 9 (3 original + 6 Phase-9
    // expansion) without freezing the exact number — new entities land
    // additively.
    expect(r.body.body.total).toBeGreaterThanOrEqual(9);
    expect(Array.isArray(r.body.body.entities)).toBe(true);
    const ids = r.body.body.entities.map((e: { entity: string }) => e.entity);
    expect(ids).toContain('countries');
    expect(ids).toContain('currencies');
    expect(ids).toContain('case-types');
  });

  test('non-admin → 403', async () => {
    const { app } = makeMasterApp('case_owner_unknown');
    const r = await request(app).get('/v1/admin/masters').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/admin/masters/:entity — list rows', () => {
  test('countries (platform-static) returns the same rows for every tenant', async () => {
    const { app } = makeMasterApp('admin');
    const bil = await request(app).get('/v1/admin/masters/countries').set(TH_BIL);
    const bank = await request(app).get('/v1/admin/masters/countries').set(TH_BANK);
    expect(bil.status).toBe(200);
    expect(bank.status).toBe(200);
    expect(bil.body.body.total).toBe(bank.body.body.total);
    expect(bil.body.body.tenant_scoped).toBe(false);
    expect(bil.body.body.total).toBeGreaterThanOrEqual(8); // seeded
  });

  test('departments seed visible to BANK_DEMO; BIL starts empty (tenant-scoped)', async () => {
    const { app } = makeMasterApp('admin');
    const bank = await request(app).get('/v1/admin/masters/departments').set(TH_BANK);
    const bil = await request(app).get('/v1/admin/masters/departments').set(TH_BIL);
    expect(bank.status).toBe(200);
    expect(bil.status).toBe(200);
    expect(bank.body.body.total).toBeGreaterThanOrEqual(4); // seeded into BANK_DEMO
    expect(bil.body.body.total).toBe(0); // BIL not seeded
  });

  test('unknown entity → 404 EWS_404_unknown_entity', async () => {
    const { app } = makeMasterApp('admin');
    const r = await request(app).get('/v1/admin/masters/ghost').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_entity');
  });
});

describe('POST /v1/admin/masters/:entity — create + validation', () => {
  test('admin creates a department + GET reflects it', async () => {
    const { app } = makeMasterApp('admin');
    const create = await request(app)
      .post('/v1/admin/masters/departments')
      .set(TH_BIL)
      .set('X-APEX-USER', 'alice.admin')
      .send({ code: 'NEW_DEPT', name: 'New Department', function: 'risk', active: true });
    expect(create.status).toBe(201);
    expect(create.body.body.fields.name).toBe('New Department');
    expect(create.body.body.created_by).toBe('alice.admin');
    const list = await request(app).get('/v1/admin/masters/departments').set(TH_BIL);
    expect(list.body.body.total).toBe(1);
  });

  test('missing required field → 400 EWS_400_missing_required', async () => {
    const { app } = makeMasterApp('admin');
    const r = await request(app)
      .post('/v1/admin/masters/departments')
      .set(TH_BIL)
      .send({ function: 'risk' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_missing_required');
  });

  test('enum violation → 400 EWS_400_enum_violation', async () => {
    const { app } = makeMasterApp('admin');
    const r = await request(app)
      .post('/v1/admin/masters/risk-categories')
      .set(TH_BIL)
      .send({ code: 'TEST', name: 'Test', severity: 'extreme' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_enum_violation');
  });
});

describe('PATCH /v1/admin/masters/:entity/:id — update', () => {
  test('PATCH renames a row + reflects updated_by', async () => {
    const { app } = makeMasterApp('admin');
    const create = await request(app)
      .post('/v1/admin/masters/departments')
      .set(TH_BIL)
      .set('X-APEX-USER', 'alice.admin')
      .send({ code: 'EDIT_ME', name: 'Original', function: 'risk' });
    const id = create.body.body.id;
    const patch = await request(app)
      .patch(`/v1/admin/masters/departments/${id}`)
      .set(TH_BIL)
      .set('X-APEX-USER', 'bob.editor')
      .send({ name: 'Renamed' });
    expect(patch.status).toBe(200);
    expect(patch.body.body.fields.name).toBe('Renamed');
    expect(patch.body.body.updated_by).toBe('bob.editor');
  });

  test('PATCH unknown id → 404 EWS_404_unknown_row', async () => {
    const { app } = makeMasterApp('admin');
    const r = await request(app)
      .patch('/v1/admin/masters/departments/mst-departments-bogus')
      .set(TH_BIL)
      .send({ name: 'x' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_row');
  });
});

describe('DELETE /v1/admin/masters/:entity/:id', () => {
  test('DELETE removes row + GET single returns 404', async () => {
    const { app } = makeMasterApp('admin');
    const create = await request(app)
      .post('/v1/admin/masters/departments')
      .set(TH_BIL)
      .send({ code: 'KILL', name: 'Will Be Killed', function: 'risk' });
    const id = create.body.body.id;
    const del = await request(app)
      .delete(`/v1/admin/masters/departments/${id}`)
      .set(TH_BIL);
    expect(del.status).toBe(204);
    const get = await request(app).get(`/v1/admin/masters/departments/${id}`).set(TH_BIL);
    expect(get.status).toBe(404);
  });

  test('DELETE unknown id → 404', async () => {
    const { app } = makeMasterApp('admin');
    const r = await request(app)
      .delete('/v1/admin/masters/departments/mst-departments-bogus')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });
});
