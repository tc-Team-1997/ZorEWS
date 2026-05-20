// services/bff/__tests__/geography_master.test.ts
//
// Phase A.2 — Geography & Risk Region Master Setup. Mirrors A.1
// sector_master test shape.

import request from 'supertest';
import {
  ALL_AML_REGIMES,
  ALL_GEO_RISK_LEVELS,
  defaultGeographyMasterStore,
  GeographyMasterError,
  GEOGRAPHY_MASTER_CAP_PER_TENANT,
  InMemoryGeographyMasterStore,
  isAmlRegime,
  isGeoRiskLevel,
} from '../src/master/geography_master';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryRecoveryStore } from '../src/recovery/store';

const NOW = new Date('2026-05-21T09:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function makeGeoApp(role: string = 'admin', overrides: {
  geographyMasterStore?: InMemoryGeographyMasterStore;
  recoveryStore?: InMemoryRecoveryStore;
} = {}) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    geographyMasterStore: overrides.geographyMasterStore ?? new InMemoryGeographyMasterStore(),
    recoveryStore: overrides.recoveryStore ?? new InMemoryRecoveryStore(),
  });
  return app;
}

const validInput = (overrides: Record<string, unknown> = {}) => ({
  country_code: 'IN',
  country_name: 'India',
  risk_level: 'medium' as const,
  sanction_flag: false,
  aml_regime: 'standard' as const,
  region: 'APAC',
  notes: 'Domestic',
  ...overrides,
});

// ─── 1. Schema invariants ──────────────────────────────────────────────

describe('GeographyMaster enums', () => {
  test('ALL_GEO_RISK_LEVELS contains exactly high/medium/low', () => {
    expect(ALL_GEO_RISK_LEVELS).toEqual(['high', 'medium', 'low']);
  });

  test('isGeoRiskLevel accepts every declared value', () => {
    for (const r of ALL_GEO_RISK_LEVELS) expect(isGeoRiskLevel(r)).toBe(true);
  });

  test('isGeoRiskLevel rejects unknown', () => {
    expect(isGeoRiskLevel('critical')).toBe(false);
    expect(isGeoRiskLevel(null)).toBe(false);
  });

  test('ALL_AML_REGIMES contains the 5 canonical regimes', () => {
    expect(ALL_AML_REGIMES.length).toBe(5);
    expect(ALL_AML_REGIMES).toContain('fatf_blacklist');
    expect(ALL_AML_REGIMES).toContain('standard');
  });

  test('isAmlRegime accepts every declared value', () => {
    for (const r of ALL_AML_REGIMES) expect(isAmlRegime(r)).toBe(true);
    expect(isAmlRegime('bogus')).toBe(false);
  });
});

// ─── 2. Validation ─────────────────────────────────────────────────────

describe('InMemoryGeographyMasterStore.create validation', () => {
  test('happy path returns a populated entry', () => {
    const s = new InMemoryGeographyMasterStore();
    const e = s.create('BIL', validInput(), 'alice.admin', NOW);
    expect(e.country_code).toBe('IN');
    expect(e.country_name).toBe('India');
    expect(e.risk_level).toBe('medium');
    expect(e.sanction_flag).toBe(false);
    expect(e.aml_regime).toBe('standard');
    expect(e.region).toBe('APAC');
    expect(e.active).toBe(true);
    expect(e.created_by).toBe('alice.admin');
    expect(e.tenant_id).toBe('BIL');
  });

  test('country_code must be ISO 3166-1 alpha-2 uppercase', () => {
    const s = new InMemoryGeographyMasterStore();
    expect(() => s.create('BIL', validInput({ country_code: 'in' }), 'a', NOW)).toThrow(
      GeographyMasterError,
    );
    expect(() => s.create('BIL', validInput({ country_code: 'IND' }), 'a', NOW)).toThrow(
      GeographyMasterError,
    );
    expect(() => s.create('BIL', validInput({ country_code: 'I' }), 'a', NOW)).toThrow(
      GeographyMasterError,
    );
    expect(() => s.create('BIL', validInput({ country_code: '12' }), 'a', NOW)).toThrow(
      GeographyMasterError,
    );
  });

  test('blank or overlong country_name → invalid_country_name', () => {
    const s = new InMemoryGeographyMasterStore();
    expect(() => s.create('BIL', validInput({ country_name: '' }), 'a', NOW)).toThrow(
      GeographyMasterError,
    );
    expect(() =>
      s.create('BIL', validInput({ country_name: 'x'.repeat(121) }), 'a', NOW),
    ).toThrow(GeographyMasterError);
  });

  test('invalid risk_level rejected', () => {
    const s = new InMemoryGeographyMasterStore();
    expect(() =>
      s.create('BIL', validInput({ risk_level: 'critical' }), 'a', NOW),
    ).toThrow(GeographyMasterError);
  });

  test('invalid aml_regime rejected', () => {
    const s = new InMemoryGeographyMasterStore();
    expect(() =>
      s.create('BIL', validInput({ aml_regime: 'made_up' }), 'a', NOW),
    ).toThrow(GeographyMasterError);
  });

  test('aml_regime defaults to "standard" when omitted', () => {
    const s = new InMemoryGeographyMasterStore();
    const { aml_regime: _drop, ...rest } = validInput();
    void _drop;
    const e = s.create('BIL', rest as never, 'a', NOW);
    expect(e.aml_regime).toBe('standard');
  });

  test('overlong region / notes rejected', () => {
    const s = new InMemoryGeographyMasterStore();
    expect(() =>
      s.create('BIL', validInput({ region: 'x'.repeat(81) }), 'a', NOW),
    ).toThrow(GeographyMasterError);
    expect(() =>
      s.create('BIL', validInput({ notes: 'x'.repeat(1001) }), 'a', NOW),
    ).toThrow(GeographyMasterError);
  });

  test('non-boolean sanction_flag rejected', () => {
    const s = new InMemoryGeographyMasterStore();
    expect(() =>
      s.create('BIL', validInput({ sanction_flag: 'yes' as never }), 'a', NOW),
    ).toThrow(GeographyMasterError);
  });

  test('missing actor → invalid_input', () => {
    const s = new InMemoryGeographyMasterStore();
    expect(() => s.create('BIL', validInput(), '', NOW)).toThrow(GeographyMasterError);
  });
});

// ─── 3. CRUD lifecycle + tenant scoping + restore ─────────────────────

describe('InMemoryGeographyMasterStore lifecycle', () => {
  test('list orders by country_name asc then country_code asc', () => {
    const s = new InMemoryGeographyMasterStore();
    s.create('BIL', validInput({ country_code: 'IN', country_name: 'India' }), 'a', NOW);
    s.create('BIL', validInput({ country_code: 'BT', country_name: 'Bhutan' }), 'a', NOW);
    s.create('BIL', validInput({ country_code: 'NP', country_name: 'Nepal' }), 'a', NOW);
    const items = s.list('BIL');
    expect(items.map((e) => e.country_code)).toEqual(['BT', 'IN', 'NP']);
  });

  test('duplicate country_code → 409 code', () => {
    const s = new InMemoryGeographyMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    expect(() => s.create('BIL', validInput(), 'a', NOW)).toThrow(GeographyMasterError);
  });

  test('list filter: risk_level=high narrows correctly', () => {
    const s = new InMemoryGeographyMasterStore();
    s.create('BIL', validInput({ country_code: 'IN', country_name: 'India', risk_level: 'low' }), 'a', NOW);
    s.create('BIL', validInput({ country_code: 'BT', country_name: 'Bhutan', risk_level: 'high' }), 'a', NOW);
    s.create('BIL', validInput({ country_code: 'NP', country_name: 'Nepal', risk_level: 'high' }), 'a', NOW);
    expect(s.list('BIL', { risk_level: 'high' }).map((e) => e.country_code)).toEqual([
      'BT', 'NP',
    ]);
  });

  test('list filter: sanction_flag=true narrows correctly', () => {
    const s = new InMemoryGeographyMasterStore();
    s.create('BIL', validInput({ country_code: 'IN', country_name: 'India' }), 'a', NOW);
    s.create('BIL', validInput({ country_code: 'KP', country_name: 'DPRK', sanction_flag: true }), 'a', NOW);
    expect(s.list('BIL', { sanction_flag: true }).map((e) => e.country_code)).toEqual([
      'KP',
    ]);
  });

  test('update applies patch + bumps updated_at/_by', () => {
    const s = new InMemoryGeographyMasterStore();
    s.create('BIL', validInput(), 'alice', NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const updated = s.update(
      'BIL',
      'IN',
      { risk_level: 'high', sanction_flag: true, notes: 'Escalation' },
      'bob',
      later,
    );
    expect(updated.risk_level).toBe('high');
    expect(updated.sanction_flag).toBe(true);
    expect(updated.notes).toBe('Escalation');
    expect(updated.updated_by).toBe('bob');
    expect(updated.updated_at).toBe(later.toISOString());
    expect(updated.created_by).toBe('alice');
  });

  test('update unknown_country throws', () => {
    const s = new InMemoryGeographyMasterStore();
    expect(() => s.update('BIL', 'XX', { risk_level: 'high' }, 'a', NOW)).toThrow(
      GeographyMasterError,
    );
  });

  test('softDelete + restore round-trip', () => {
    const s = new InMemoryGeographyMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    const t = s.softDelete('BIL', 'IN', 'b', NOW);
    expect(t.deleted_at).toBe(NOW.toISOString());
    expect(s.get('BIL', 'IN')).toBeNull();
    expect(s.restore(t)).toBe(true);
    expect(s.get('BIL', 'IN')?.deleted_at).toBeNull();
  });

  test('restore conflict on live row', () => {
    const s = new InMemoryGeographyMasterStore();
    const e = s.create('BIL', validInput(), 'a', NOW);
    expect(s.restore(e)).toBe(false);
  });

  test('tenant scoping — BIL invisible to BANK_DEMO', () => {
    const s = new InMemoryGeographyMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    s.create('BANK_DEMO', validInput({ country_code: 'BT', country_name: 'Bhutan' }), 'a', NOW);
    expect(s.list('BIL').map((e) => e.country_code)).toEqual(['IN']);
    expect(s.list('BANK_DEMO').map((e) => e.country_code)).toEqual(['BT']);
  });

  test('cap_reached when live count hits cap', () => {
    const s = new InMemoryGeographyMasterStore();
    // Generate cap distinct 2-letter codes. AA..ZZ covers 676; we need
    // GEOGRAPHY_MASTER_CAP_PER_TENANT (300).
    for (let i = 0; i < GEOGRAPHY_MASTER_CAP_PER_TENANT; i++) {
      const a = String.fromCharCode(65 + Math.floor(i / 26));
      const b = String.fromCharCode(65 + (i % 26));
      s.create('BIL', validInput({ country_code: `${a}${b}`, country_name: `${a}${b}` }), 'a', NOW);
    }
    expect(() =>
      s.create('BIL', validInput({ country_code: 'ZZ', country_name: 'Overflow' }), 'a', NOW),
    ).toThrow(GeographyMasterError);
  });

  test('defensive copy — mutating returned entry does not change store', () => {
    const s = new InMemoryGeographyMasterStore();
    const e = s.create('BIL', validInput(), 'a', NOW);
    (e as { country_name: string }).country_name = 'TAMPERED';
    expect(s.get('BIL', 'IN')?.country_name).toBe('India');
  });
});

// ─── 4. Routes ─────────────────────────────────────────────────────────

describe('GET /v1/master/geographies/risk-levels', () => {
  test('returns risk_levels + aml_regimes', async () => {
    const app = makeGeoApp('admin');
    const r = await request(app).get('/v1/master/geographies/risk-levels').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.risk_levels).toEqual([...ALL_GEO_RISK_LEVELS]);
    expect(r.body.body.aml_regimes).toEqual([...ALL_AML_REGIMES]);
  });

  test('non-admin → 403', async () => {
    const app = makeGeoApp('field_officer');
    const r = await request(app).get('/v1/master/geographies/risk-levels').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/master/geographies', () => {
  test('admin happy path → 201', async () => {
    const app = makeGeoApp('admin');
    const r = await request(app).post('/v1/master/geographies').set(TH_BIL).send(validInput());
    expect(r.status).toBe(201);
    expect(r.body.body.country_code).toBe('IN');
    expect(r.body.body.created_by).toBe('alice.admin');
  });

  test('enveloped request body honoured', async () => {
    const app = makeGeoApp('admin');
    const r = await request(app)
      .post('/v1/master/geographies')
      .set(TH_BIL)
      .send({ header: {}, body: validInput() });
    expect(r.status).toBe(201);
  });

  test('duplicate → 409', async () => {
    const store = new InMemoryGeographyMasterStore();
    const app = makeGeoApp('admin', { geographyMasterStore: store });
    await request(app).post('/v1/master/geographies').set(TH_BIL).send(validInput());
    const r = await request(app).post('/v1/master/geographies').set(TH_BIL).send(validInput());
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_country_code');
  });

  test('invalid country_code → 400', async () => {
    const app = makeGeoApp('admin');
    const r = await request(app)
      .post('/v1/master/geographies')
      .set(TH_BIL)
      .send(validInput({ country_code: 'india' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_country_code');
  });

  test('invalid risk_level → 400', async () => {
    const app = makeGeoApp('admin');
    const r = await request(app)
      .post('/v1/master/geographies')
      .set(TH_BIL)
      .send(validInput({ risk_level: 'CRITICAL' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_risk_level');
  });

  test('non-admin role → 403', async () => {
    const app = makeGeoApp('field_officer');
    const r = await request(app)
      .post('/v1/master/geographies')
      .set(TH_BIL)
      .send(validInput());
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/master/geographies', () => {
  test('lists tenant-scoped rows', async () => {
    const store = new InMemoryGeographyMasterStore();
    const app = makeGeoApp('admin', { geographyMasterStore: store });
    await request(app).post('/v1/master/geographies').set(TH_BIL).send(validInput());
    await request(app)
      .post('/v1/master/geographies')
      .set(TH_BANK)
      .send(validInput({ country_code: 'BT', country_name: 'Bhutan' }));
    const rBIL = await request(app).get('/v1/master/geographies').set(TH_BIL);
    expect(rBIL.body.body.total).toBe(1);
    expect(rBIL.body.body.items[0].country_code).toBe('IN');
    const rBANK = await request(app).get('/v1/master/geographies').set(TH_BANK);
    expect(rBANK.body.body.items[0].country_code).toBe('BT');
  });

  test('?risk_level=high narrows', async () => {
    const store = new InMemoryGeographyMasterStore();
    const app = makeGeoApp('admin', { geographyMasterStore: store });
    await request(app)
      .post('/v1/master/geographies')
      .set(TH_BIL)
      .send(validInput({ country_code: 'IN', country_name: 'India', risk_level: 'low' }));
    await request(app)
      .post('/v1/master/geographies')
      .set(TH_BIL)
      .send(validInput({ country_code: 'KP', country_name: 'DPRK', risk_level: 'high' }));
    const r = await request(app).get('/v1/master/geographies?risk_level=high').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].country_code).toBe('KP');
  });

  test('?risk_level=bogus → 400', async () => {
    const app = makeGeoApp('admin');
    const r = await request(app).get('/v1/master/geographies?risk_level=bogus').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_risk_level');
  });

  test('?sanction_flag=foo → 400', async () => {
    const app = makeGeoApp('admin');
    const r = await request(app).get('/v1/master/geographies?sanction_flag=foo').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_sanction_flag');
  });

  test('?sanction_flag=true narrows', async () => {
    const store = new InMemoryGeographyMasterStore();
    const app = makeGeoApp('admin', { geographyMasterStore: store });
    await request(app).post('/v1/master/geographies').set(TH_BIL).send(validInput());
    await request(app)
      .post('/v1/master/geographies')
      .set(TH_BIL)
      .send(validInput({ country_code: 'KP', country_name: 'DPRK', sanction_flag: true }));
    const r = await request(app).get('/v1/master/geographies?sanction_flag=true').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].country_code).toBe('KP');
  });
});

describe('GET /v1/master/geographies/:country_code', () => {
  test('happy + uppercase coercion', async () => {
    const store = new InMemoryGeographyMasterStore();
    const app = makeGeoApp('admin', { geographyMasterStore: store });
    await request(app).post('/v1/master/geographies').set(TH_BIL).send(validInput());
    // Path parameter forced uppercase by route handler.
    const r = await request(app).get('/v1/master/geographies/in').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.country_code).toBe('IN');
  });

  test('unknown → 404', async () => {
    const app = makeGeoApp('admin');
    const r = await request(app).get('/v1/master/geographies/XX').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('cross-tenant lookup → 404', async () => {
    const store = new InMemoryGeographyMasterStore();
    const app = makeGeoApp('admin', { geographyMasterStore: store });
    await request(app).post('/v1/master/geographies').set(TH_BIL).send(validInput());
    const r = await request(app).get('/v1/master/geographies/IN').set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('PATCH /v1/master/geographies/:country_code', () => {
  test('happy patch', async () => {
    const store = new InMemoryGeographyMasterStore();
    const app = makeGeoApp('admin', { geographyMasterStore: store });
    await request(app).post('/v1/master/geographies').set(TH_BIL).send(validInput());
    const r = await request(app)
      .patch('/v1/master/geographies/IN')
      .set(TH_BIL)
      .send({ risk_level: 'high', sanction_flag: true });
    expect(r.status).toBe(200);
    expect(r.body.body.risk_level).toBe('high');
    expect(r.body.body.sanction_flag).toBe(true);
  });

  test('unknown → 404', async () => {
    const app = makeGeoApp('admin');
    const r = await request(app)
      .patch('/v1/master/geographies/XX')
      .set(TH_BIL)
      .send({ risk_level: 'high' });
    expect(r.status).toBe(404);
  });
});

describe('DELETE /v1/master/geographies/:country_code + recovery', () => {
  test('soft-delete + archive', async () => {
    const store = new InMemoryGeographyMasterStore();
    const recovery = new InMemoryRecoveryStore();
    const app = makeGeoApp('admin', {
      geographyMasterStore: store,
      recoveryStore: recovery,
    });
    await request(app).post('/v1/master/geographies').set(TH_BIL).send(validInput());
    const r = await request(app).delete('/v1/master/geographies/IN').set(TH_BIL);
    expect(r.status).toBe(204);
    const live = await request(app).get('/v1/master/geographies').set(TH_BIL);
    expect(live.body.body.total).toBe(0);
    const archived = await recovery.list({ tenant_id: 'BIL', entity_type: 'geography_master' });
    expect(archived.items.length).toBe(1);
    expect(archived.items[0].original_id).toBe('IN');
    expect(archived.items[0].original_table).toBe('app_master.geographies');
  });

  test('unknown → 404', async () => {
    const app = makeGeoApp('admin');
    const r = await request(app).delete('/v1/master/geographies/XX').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('non-admin → 403', async () => {
    const app = makeGeoApp('field_officer');
    const r = await request(app).delete('/v1/master/geographies/IN').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

// ─── 5. Singleton sanity ──────────────────────────────────────────────

describe('defaultGeographyMasterStore singleton', () => {
  test('exports expected interface', () => {
    expect(defaultGeographyMasterStore).toBeDefined();
    expect(typeof defaultGeographyMasterStore.list).toBe('function');
    expect(typeof defaultGeographyMasterStore.create).toBe('function');
    expect(typeof defaultGeographyMasterStore.softDelete).toBe('function');
    expect(typeof defaultGeographyMasterStore.restore).toBe('function');
  });
});
