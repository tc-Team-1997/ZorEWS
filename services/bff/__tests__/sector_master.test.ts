// services/bff/__tests__/sector_master.test.ts
//
// Phase A.1 — Sector & Industry Master Setup.
//
// Layered tests:
//   1. Schema invariants — enum closed, regex, type-guard.
//   2. validateCreate / validateUpdate (via store.create/.update).
//   3. InMemorySectorMasterStore — full lifecycle including soft-delete + restore.
//   4. Routes — RBAC, envelope, validation errors, recovery archive on delete.

import request from 'supertest';
import {
  ALL_REGULATORY_CATEGORIES,
  InMemorySectorMasterStore,
  isRegulatoryCategory,
  SECTOR_MASTER_CAP_PER_TENANT,
  SectorMasterError,
  defaultSectorMasterStore,
} from '../src/master/sector_master';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryRecoveryStore } from '../src/recovery/store';

const NOW = new Date('2026-05-21T09:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function makeSecApp(role: string = 'admin', overrides: {
  sectorMasterStore?: InMemorySectorMasterStore;
  recoveryStore?: InMemoryRecoveryStore;
} = {}) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    sectorMasterStore: overrides.sectorMasterStore ?? new InMemorySectorMasterStore(),
    recoveryStore: overrides.recoveryStore ?? new InMemoryRecoveryStore(),
  });
  return app;
}

const validInput = (overrides: Record<string, unknown> = {}) => ({
  sector_id: 'AGRICULTURE',
  sector_name: 'Agriculture & allied',
  risk_weight: 0.65,
  regulatory_category: 'agriculture' as const,
  description: 'Farming, dairy, fisheries',
  ...overrides,
});

// ─── 1. Schema invariants ──────────────────────────────────────────────

describe('ALL_REGULATORY_CATEGORIES', () => {
  test('contains exactly the 8 declared categories', () => {
    expect(ALL_REGULATORY_CATEGORIES.length).toBe(8);
    expect(new Set(ALL_REGULATORY_CATEGORIES).size).toBe(8);
  });

  test('isRegulatoryCategory type-guard accepts every declared value', () => {
    for (const c of ALL_REGULATORY_CATEGORIES) expect(isRegulatoryCategory(c)).toBe(true);
  });

  test('isRegulatoryCategory rejects unknown / non-string', () => {
    expect(isRegulatoryCategory('bogus')).toBe(false);
    expect(isRegulatoryCategory(42)).toBe(false);
    expect(isRegulatoryCategory(null)).toBe(false);
    expect(isRegulatoryCategory(undefined)).toBe(false);
  });
});

// ─── 2. Validation via store.create / .update ─────────────────────────

describe('InMemorySectorMasterStore.create validation', () => {
  test('happy path returns a fully populated entry', () => {
    const s = new InMemorySectorMasterStore();
    const e = s.create('BIL', validInput(), 'alice.admin', NOW);
    expect(e.sector_id).toBe('AGRICULTURE');
    expect(e.sector_name).toBe('Agriculture & allied');
    expect(e.risk_weight).toBe(0.65);
    expect(e.regulatory_category).toBe('agriculture');
    expect(e.active).toBe(true);
    expect(e.created_at).toBe(NOW.toISOString());
    expect(e.created_by).toBe('alice.admin');
    expect(e.updated_at).toBe(NOW.toISOString());
    expect(e.updated_by).toBe('alice.admin');
    expect(e.deleted_at).toBeNull();
    expect(e.tenant_id).toBe('BIL');
  });

  test('invalid sector_id format → invalid_sector_id', () => {
    const s = new InMemorySectorMasterStore();
    expect(() =>
      s.create('BIL', validInput({ sector_id: 'lowercase' }), 'a', NOW),
    ).toThrow(SectorMasterError);
    expect(() =>
      s.create('BIL', validInput({ sector_id: '1STARTS_WITH_DIGIT' }), 'a', NOW),
    ).toThrow(SectorMasterError);
    expect(() => s.create('BIL', validInput({ sector_id: '' }), 'a', NOW)).toThrow(
      SectorMasterError,
    );
  });

  test('blank or overlong sector_name → invalid_name', () => {
    const s = new InMemorySectorMasterStore();
    expect(() =>
      s.create('BIL', validInput({ sector_name: '' }), 'a', NOW),
    ).toThrow(SectorMasterError);
    expect(() =>
      s.create('BIL', validInput({ sector_name: '   ' }), 'a', NOW),
    ).toThrow(SectorMasterError);
    expect(() =>
      s.create('BIL', validInput({ sector_name: 'x'.repeat(201) }), 'a', NOW),
    ).toThrow(SectorMasterError);
  });

  test('risk_weight out of (0, 1] → invalid_risk_weight', () => {
    const s = new InMemorySectorMasterStore();
    expect(() =>
      s.create('BIL', validInput({ risk_weight: 0 }), 'a', NOW),
    ).toThrow(SectorMasterError);
    expect(() =>
      s.create('BIL', validInput({ risk_weight: 1.01 }), 'a', NOW),
    ).toThrow(SectorMasterError);
    expect(() =>
      s.create('BIL', validInput({ risk_weight: -0.1 }), 'a', NOW),
    ).toThrow(SectorMasterError);
    expect(() =>
      s.create('BIL', validInput({ risk_weight: NaN }), 'a', NOW),
    ).toThrow(SectorMasterError);
  });

  test('invalid regulatory_category → invalid_category', () => {
    const s = new InMemorySectorMasterStore();
    expect(() =>
      s.create('BIL', validInput({ regulatory_category: 'not_a_category' }), 'a', NOW),
    ).toThrow(SectorMasterError);
  });

  test('description >1000 chars → invalid_description', () => {
    const s = new InMemorySectorMasterStore();
    expect(() =>
      s.create('BIL', validInput({ description: 'x'.repeat(1001) }), 'a', NOW),
    ).toThrow(SectorMasterError);
  });

  test('missing actor → invalid_input', () => {
    const s = new InMemorySectorMasterStore();
    expect(() => s.create('BIL', validInput(), '', NOW)).toThrow(SectorMasterError);
  });

  test('risk_weight=1.0 boundary accepted', () => {
    const s = new InMemorySectorMasterStore();
    const e = s.create('BIL', validInput({ risk_weight: 1.0 }), 'a', NOW);
    expect(e.risk_weight).toBe(1.0);
  });
});

// ─── 3. CRUD lifecycle + tenant scoping + restore ─────────────────────

describe('InMemorySectorMasterStore lifecycle', () => {
  test('list empty for fresh tenant', () => {
    const s = new InMemorySectorMasterStore();
    expect(s.list('BIL')).toEqual([]);
  });

  test('list orders by sector_name asc then sector_id asc', () => {
    const s = new InMemorySectorMasterStore();
    s.create('BIL', validInput({ sector_id: 'Z_FIRST', sector_name: 'Aardvark' }), 'a', NOW);
    s.create('BIL', validInput({ sector_id: 'A_LAST', sector_name: 'Zebra' }), 'a', NOW);
    s.create('BIL', validInput({ sector_id: 'MM', sector_name: 'Mango' }), 'a', NOW);
    const items = s.list('BIL');
    expect(items.map((e) => e.sector_id)).toEqual(['Z_FIRST', 'MM', 'A_LAST']);
  });

  test('get returns the live row, null on miss', () => {
    const s = new InMemorySectorMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    expect(s.get('BIL', 'AGRICULTURE')?.sector_id).toBe('AGRICULTURE');
    expect(s.get('BIL', 'UNKNOWN')).toBeNull();
  });

  test('duplicate sector_id → duplicate_sector_id', () => {
    const s = new InMemorySectorMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    expect(() => s.create('BIL', validInput(), 'a', NOW)).toThrow(SectorMasterError);
  });

  test('update applies patch + bumps updated_at/_by', () => {
    const s = new InMemorySectorMasterStore();
    s.create('BIL', validInput(), 'alice', NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const updated = s.update(
      'BIL',
      'AGRICULTURE',
      { risk_weight: 0.9, sector_name: 'Agriculture (Updated)' },
      'bob',
      later,
    );
    expect(updated.risk_weight).toBe(0.9);
    expect(updated.sector_name).toBe('Agriculture (Updated)');
    expect(updated.updated_by).toBe('bob');
    expect(updated.updated_at).toBe(later.toISOString());
    expect(updated.created_by).toBe('alice'); // unchanged
  });

  test('update unknown_sector throws', () => {
    const s = new InMemorySectorMasterStore();
    expect(() => s.update('BIL', 'GHOST', { risk_weight: 0.5 }, 'a', NOW)).toThrow(
      SectorMasterError,
    );
  });

  test('update on soft-deleted row throws unknown_sector', () => {
    const s = new InMemorySectorMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    s.softDelete('BIL', 'AGRICULTURE', 'a', NOW);
    expect(() => s.update('BIL', 'AGRICULTURE', { risk_weight: 0.5 }, 'a', NOW)).toThrow(
      SectorMasterError,
    );
  });

  test('softDelete flips deleted_at/_by + drops from default list', () => {
    const s = new InMemorySectorMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    const t = s.softDelete('BIL', 'AGRICULTURE', 'b', NOW);
    expect(t.deleted_at).toBe(NOW.toISOString());
    expect(t.deleted_by).toBe('b');
    expect(s.list('BIL')).toEqual([]);
    expect(s.get('BIL', 'AGRICULTURE')).toBeNull();
  });

  test('list({include_deleted: true}) surfaces tombstoned rows', () => {
    const s = new InMemorySectorMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    s.softDelete('BIL', 'AGRICULTURE', 'b', NOW);
    expect(s.list('BIL', { include_deleted: true }).length).toBe(1);
  });

  test('softDelete unknown_sector throws', () => {
    const s = new InMemorySectorMasterStore();
    expect(() => s.softDelete('BIL', 'GHOST', 'a', NOW)).toThrow(SectorMasterError);
  });

  test('softDelete twice → second call throws unknown_sector', () => {
    const s = new InMemorySectorMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    s.softDelete('BIL', 'AGRICULTURE', 'a', NOW);
    expect(() => s.softDelete('BIL', 'AGRICULTURE', 'a', NOW)).toThrow(SectorMasterError);
  });

  test('restore resurrects a soft-deleted row', () => {
    const s = new InMemorySectorMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    const t = s.softDelete('BIL', 'AGRICULTURE', 'b', NOW);
    expect(s.restore(t)).toBe(true);
    const live = s.get('BIL', 'AGRICULTURE');
    expect(live).toBeDefined();
    expect(live?.deleted_at).toBeNull();
  });

  test('restore conflict when a live row already holds the id', () => {
    const s = new InMemorySectorMasterStore();
    const e1 = s.create('BIL', validInput(), 'a', NOW);
    // Simulate an external attempt to restore the same id while a
    // live row exists — must refuse.
    expect(s.restore(e1)).toBe(false);
  });

  test('restore rejects malformed payload', () => {
    const s = new InMemorySectorMasterStore();
    expect(s.restore(null as never)).toBe(false);
    expect(s.restore({} as never)).toBe(false);
  });

  test('tenant scoping — BIL rows invisible to BANK_DEMO', () => {
    const s = new InMemorySectorMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    s.create('BANK_DEMO', validInput({ sector_id: 'MANUFACTURING', sector_name: 'Manufacturing' }), 'a', NOW);
    expect(s.list('BIL').map((e) => e.sector_id)).toEqual(['AGRICULTURE']);
    expect(s.list('BANK_DEMO').map((e) => e.sector_id)).toEqual(['MANUFACTURING']);
  });

  test('cap_reached throws once live count hits SECTOR_MASTER_CAP_PER_TENANT', () => {
    const s = new InMemorySectorMasterStore();
    for (let i = 0; i < SECTOR_MASTER_CAP_PER_TENANT; i++) {
      const id = `S${String(i).padStart(4, '0')}`;
      s.create('BIL', validInput({ sector_id: id, sector_name: `Sector ${i}` }), 'a', NOW);
    }
    expect(() =>
      s.create('BIL', validInput({ sector_id: 'OVERFLOW', sector_name: 'OF' }), 'a', NOW),
    ).toThrow(SectorMasterError);
  });

  test('cap respects soft-delete (deleted rows do not count)', () => {
    const s = new InMemorySectorMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    s.softDelete('BIL', 'AGRICULTURE', 'a', NOW);
    // After soft-delete only 0 live; should be able to fill back up.
    const ok = s.create('BIL', validInput({ sector_id: 'NEW', sector_name: 'New' }), 'a', NOW);
    expect(ok.sector_id).toBe('NEW');
  });

  test('defensive copy — mutating returned entry does not change store', () => {
    const s = new InMemorySectorMasterStore();
    const e = s.create('BIL', validInput(), 'a', NOW);
    (e as { sector_name: string }).sector_name = 'TAMPERED';
    expect(s.get('BIL', 'AGRICULTURE')?.sector_name).toBe('Agriculture & allied');
  });
});

// ─── 4. Routes ─────────────────────────────────────────────────────────

describe('GET /v1/master/sectors/categories', () => {
  test('admin happy path returns the 8 categories', async () => {
    const app = makeSecApp('admin');
    const r = await request(app).get('/v1/master/sectors/categories').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.categories).toEqual([...ALL_REGULATORY_CATEGORIES]);
  });

  test('non-admin role → 403', async () => {
    const app = makeSecApp('field_officer');
    const r = await request(app).get('/v1/master/sectors/categories').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/master/sectors', () => {
  test('admin happy path → 201 with envelope', async () => {
    const app = makeSecApp('admin');
    const r = await request(app).post('/v1/master/sectors').set(TH_BIL).send(validInput());
    expect(r.status).toBe(201);
    expect(r.body.header.code).toBe('EWS_201');
    expect(r.body.body.sector_id).toBe('AGRICULTURE');
    expect(r.body.body.created_by).toBe('alice.admin');
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('enveloped request body honoured', async () => {
    const app = makeSecApp('admin');
    const r = await request(app)
      .post('/v1/master/sectors')
      .set(TH_BIL)
      .send({ header: {}, body: validInput() });
    expect(r.status).toBe(201);
  });

  test('duplicate id → 409 EWS_409_duplicate_sector_id', async () => {
    const store = new InMemorySectorMasterStore();
    const app = makeSecApp('admin', { sectorMasterStore: store });
    await request(app).post('/v1/master/sectors').set(TH_BIL).send(validInput());
    const r = await request(app).post('/v1/master/sectors').set(TH_BIL).send(validInput());
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_sector_id');
  });

  test('invalid risk_weight → 400 EWS_400_invalid_risk_weight', async () => {
    const app = makeSecApp('admin');
    const r = await request(app)
      .post('/v1/master/sectors')
      .set(TH_BIL)
      .send(validInput({ risk_weight: 2.5 }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_risk_weight');
  });

  test('invalid category → 400', async () => {
    const app = makeSecApp('admin');
    const r = await request(app)
      .post('/v1/master/sectors')
      .set(TH_BIL)
      .send(validInput({ regulatory_category: 'bogus' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_category');
  });

  test('non-admin role → 403', async () => {
    const app = makeSecApp('field_officer');
    const r = await request(app)
      .post('/v1/master/sectors')
      .set(TH_BIL)
      .send(validInput());
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/master/sectors', () => {
  test('lists tenant-scoped rows only', async () => {
    const store = new InMemorySectorMasterStore();
    const app = makeSecApp('admin', { sectorMasterStore: store });
    await request(app).post('/v1/master/sectors').set(TH_BIL).send(validInput());
    await request(app)
      .post('/v1/master/sectors')
      .set(TH_BANK)
      .send(validInput({ sector_id: 'MFG', sector_name: 'Manufacturing' }));
    const rBIL = await request(app).get('/v1/master/sectors').set(TH_BIL);
    expect(rBIL.status).toBe(200);
    expect(rBIL.body.body.total).toBe(1);
    expect(rBIL.body.body.items[0].sector_id).toBe('AGRICULTURE');
    const rBANK = await request(app).get('/v1/master/sectors').set(TH_BANK);
    expect(rBANK.body.body.items[0].sector_id).toBe('MFG');
  });

  test('?include_deleted=true surfaces tombstoned rows', async () => {
    const store = new InMemorySectorMasterStore();
    const app = makeSecApp('admin', { sectorMasterStore: store });
    await request(app).post('/v1/master/sectors').set(TH_BIL).send(validInput());
    await request(app).delete('/v1/master/sectors/AGRICULTURE').set(TH_BIL);
    const r1 = await request(app).get('/v1/master/sectors').set(TH_BIL);
    expect(r1.body.body.total).toBe(0);
    const r2 = await request(app).get('/v1/master/sectors?include_deleted=true').set(TH_BIL);
    expect(r2.body.body.total).toBe(1);
    expect(r2.body.body.items[0].deleted_at).toBeTruthy();
  });
});

describe('GET /v1/master/sectors/:sector_id', () => {
  test('happy path 200', async () => {
    const store = new InMemorySectorMasterStore();
    const app = makeSecApp('admin', { sectorMasterStore: store });
    await request(app).post('/v1/master/sectors').set(TH_BIL).send(validInput());
    const r = await request(app).get('/v1/master/sectors/AGRICULTURE').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.sector_id).toBe('AGRICULTURE');
  });

  test('unknown → 404 EWS_404_unknown_sector', async () => {
    const app = makeSecApp('admin');
    const r = await request(app).get('/v1/master/sectors/GHOST').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_sector');
  });

  test('cross-tenant lookup → 404', async () => {
    const store = new InMemorySectorMasterStore();
    const app = makeSecApp('admin', { sectorMasterStore: store });
    await request(app).post('/v1/master/sectors').set(TH_BIL).send(validInput());
    const r = await request(app).get('/v1/master/sectors/AGRICULTURE').set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('PATCH /v1/master/sectors/:sector_id', () => {
  test('happy path applies patch', async () => {
    const store = new InMemorySectorMasterStore();
    const app = makeSecApp('admin', { sectorMasterStore: store });
    await request(app).post('/v1/master/sectors').set(TH_BIL).send(validInput());
    const r = await request(app)
      .patch('/v1/master/sectors/AGRICULTURE')
      .set(TH_BIL)
      .send({ risk_weight: 0.95, active: false });
    expect(r.status).toBe(200);
    expect(r.body.body.risk_weight).toBe(0.95);
    expect(r.body.body.active).toBe(false);
  });

  test('unknown → 404', async () => {
    const app = makeSecApp('admin');
    const r = await request(app)
      .patch('/v1/master/sectors/GHOST')
      .set(TH_BIL)
      .send({ risk_weight: 0.5 });
    expect(r.status).toBe(404);
  });

  test('invalid patch → 400', async () => {
    const store = new InMemorySectorMasterStore();
    const app = makeSecApp('admin', { sectorMasterStore: store });
    await request(app).post('/v1/master/sectors').set(TH_BIL).send(validInput());
    const r = await request(app)
      .patch('/v1/master/sectors/AGRICULTURE')
      .set(TH_BIL)
      .send({ risk_weight: 3 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_risk_weight');
  });
});

describe('DELETE /v1/master/sectors/:sector_id + recovery archive', () => {
  test('soft-deletes + archives to recovery store', async () => {
    const store = new InMemorySectorMasterStore();
    const recovery = new InMemoryRecoveryStore();
    const app = makeSecApp('admin', {
      sectorMasterStore: store,
      recoveryStore: recovery,
    });
    await request(app).post('/v1/master/sectors').set(TH_BIL).send(validInput());
    const r = await request(app).delete('/v1/master/sectors/AGRICULTURE').set(TH_BIL);
    expect(r.status).toBe(204);
    // Live list empty
    const live = await request(app).get('/v1/master/sectors').set(TH_BIL);
    expect(live.body.body.total).toBe(0);
    // Recovery store has the archive row (async list)
    const archived = await recovery.list({ tenant_id: 'BIL', entity_type: 'sector_master' });
    expect(archived.items.length).toBe(1);
    expect(archived.items[0].original_id).toBe('AGRICULTURE');
    expect(archived.items[0].deleted_by).toBe('alice.admin');
    expect(archived.items[0].module).toBe('bff');
    expect(archived.items[0].original_table).toBe('app_master.sectors');
  });

  test('unknown → 404', async () => {
    const app = makeSecApp('admin');
    const r = await request(app).delete('/v1/master/sectors/GHOST').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('non-admin → 403', async () => {
    const app = makeSecApp('field_officer');
    const r = await request(app).delete('/v1/master/sectors/AGRICULTURE').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

// ─── 5. Singleton sanity check ────────────────────────────────────────

describe('defaultSectorMasterStore singleton', () => {
  test('exports an InMemorySectorMasterStore instance', () => {
    expect(defaultSectorMasterStore).toBeDefined();
    expect(typeof defaultSectorMasterStore.list).toBe('function');
    expect(typeof defaultSectorMasterStore.create).toBe('function');
    expect(typeof defaultSectorMasterStore.softDelete).toBe('function');
    expect(typeof defaultSectorMasterStore.restore).toBe('function');
  });
});
