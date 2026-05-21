// services/bff/__tests__/ifrs9_stage_movement.test.ts
//
// Phase T3.2 — IFRS9 Stage Movement + ECL Inputs tests.

import request from 'supertest';
import {
  ALL_IFRS9_STAGES,
  ALL_STAGE_MOVEMENT_REASONS,
  isIfrs9Stage,
  isStageMovementReason,
  computeEcl,
  applyEclOverride,
  validateEclInputs,
  InMemoryStageMovementLedger,
  InMemoryEclOverrideStore,
  Ifrs9StageError,
  IFRS9_MOVEMENT_CAP_PER_TENANT,
  IFRS9_OVERRIDE_CAP_PER_TENANT,
  type StageMovementCreateInput,
  type EclOverrideCreateInput,
  type EclInputs,
} from '../src/ifrs9/stage_movement';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T17:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function makeIfrs9App(
  role: string = 'admin',
  overrides: {
    stageMovementLedger?: InMemoryStageMovementLedger;
    eclOverrideStore?: InMemoryEclOverrideStore;
  } = {},
) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    stageMovementLedger: overrides.stageMovementLedger ?? new InMemoryStageMovementLedger(),
    eclOverrideStore: overrides.eclOverrideStore ?? new InMemoryEclOverrideStore(),
  });
  return app;
}

const validInputs = (over: Partial<EclInputs> = {}): EclInputs => ({
  pd: 0.05,
  lgd: 0.4,
  ead: 1_000_000,
  ...over,
});

const validMovementCreate = (
  over: Partial<StageMovementCreateInput> = {},
): StageMovementCreateInput => ({
  customer_id: 'CUST-100001',
  from_stage: 1,
  to_stage: 2,
  reason: 'dpd_30_breach',
  inputs: validInputs(),
  movement_at: '2026-05-15T09:00:00.000Z',
  notes: 'Customer crossed 30-day DPD threshold',
  ...over,
});

const validOverrideCreate = (
  over: Partial<EclOverrideCreateInput> = {},
): EclOverrideCreateInput => ({
  customer_id: 'CUST-100001',
  pd_override: 0.12,
  lgd_override: 0.5,
  notes: 'Operator override after CBS engine returned anomalous PD',
  ...over,
});

// ── 1. Constants + type guards ────────────────────────────────────────

describe('ifrs9 constants', () => {
  test('ALL_IFRS9_STAGES = [1, 2, 3]', () => {
    expect(ALL_IFRS9_STAGES).toEqual([1, 2, 3]);
  });

  test('ALL_STAGE_MOVEMENT_REASONS has 8 closed-enum entries', () => {
    expect(ALL_STAGE_MOVEMENT_REASONS).toEqual([
      'dpd_30_breach',
      'dpd_90_breach',
      'restructure',
      'pd_lifetime_increased',
      'watchlist_flagged',
      'cured',
      'manual_override',
      'data_quality_correction',
    ]);
  });

  test('isIfrs9Stage / isStageMovementReason type guards', () => {
    expect(isIfrs9Stage(1)).toBe(true);
    expect(isIfrs9Stage(4)).toBe(false);
    expect(isIfrs9Stage('1')).toBe(false);
    expect(isStageMovementReason('dpd_30_breach')).toBe(true);
    expect(isStageMovementReason('nope')).toBe(false);
  });
});

// ── 2. computeEcl + applyEclOverride ──────────────────────────────────

describe('computeEcl', () => {
  test('rounds PD × LGD × EAD to nearest integer', () => {
    expect(computeEcl({ pd: 0.1, lgd: 0.5, ead: 1_000_000 })).toBe(50_000);
    expect(computeEcl({ pd: 0.05, lgd: 0.4, ead: 1_000_000 })).toBe(20_000);
  });

  test('rounds correctly on fractional inputs', () => {
    // 0.123 × 0.456 × 1000 = 56.0688 → 56
    expect(computeEcl({ pd: 0.123, lgd: 0.456, ead: 1000 })).toBe(56);
  });

  test('throws on out-of-range PD', () => {
    expect(() => computeEcl({ pd: 1.5, lgd: 0.5, ead: 1000 })).toThrow(/invalid_inputs/);
  });

  test('throws on LGD = 0', () => {
    expect(() => computeEcl({ pd: 0.5, lgd: 0, ead: 1000 })).toThrow(/invalid_inputs/);
  });

  test('throws on non-integer EAD', () => {
    expect(() => computeEcl({ pd: 0.5, lgd: 0.5, ead: 1000.5 })).toThrow(/invalid_inputs/);
  });

  test('zero EAD is valid', () => {
    expect(computeEcl({ pd: 0.5, lgd: 0.5, ead: 0 })).toBe(0);
  });
});

describe('applyEclOverride', () => {
  test('null override returns base', () => {
    const r = applyEclOverride({ pd: 0.1, lgd: 0.5, ead: 1000 }, null);
    expect(r).toEqual({ pd: 0.1, lgd: 0.5, ead: 1000 });
  });

  test('inactive override returns base', () => {
    const r = applyEclOverride(
      { pd: 0.1, lgd: 0.5, ead: 1000 },
      { pd_override: 0.9, lgd_override: null, ead_override: null, active: false },
    );
    expect(r.pd).toBe(0.1);
  });

  test('active override fields win, null fields fall back to base', () => {
    const r = applyEclOverride(
      { pd: 0.1, lgd: 0.5, ead: 1000 },
      { pd_override: 0.9, lgd_override: null, ead_override: 5000, active: true },
    );
    expect(r).toEqual({ pd: 0.9, lgd: 0.5, ead: 5000 });
  });
});

describe('validateEclInputs', () => {
  test('accepts valid', () => {
    expect(() => validateEclInputs({ pd: 0.1, lgd: 0.5, ead: 1000 })).not.toThrow();
  });

  test('rejects non-object', () => {
    expect(() => validateEclInputs(null)).toThrow(/invalid_inputs/);
    expect(() => validateEclInputs([1, 2, 3])).toThrow(/invalid_inputs/);
  });
});

// ── 3. StageMovementLedger CRUD ───────────────────────────────────────

describe('InMemoryStageMovementLedger', () => {
  test('create with from_stage=1, to_stage=2 → recorded', () => {
    const led = new InMemoryStageMovementLedger();
    const m = led.create('BIL', validMovementCreate(), 'admin', NOW);
    expect(m.from_stage).toBe(1);
    expect(m.to_stage).toBe(2);
    expect(m.reason).toBe('dpd_30_breach');
    expect(m.ecl).toBe(20_000); // 0.05 × 0.4 × 1_000_000
    expect(m.tenant_id).toBe('BIL');
  });

  test('create with from_stage=null (opening entry)', () => {
    const led = new InMemoryStageMovementLedger();
    const m = led.create('BIL', validMovementCreate({ from_stage: null }), 'admin', NOW);
    expect(m.from_stage).toBeNull();
    expect(m.to_stage).toBe(2);
  });

  test('no-op transition (from === to) rejected', () => {
    const led = new InMemoryStageMovementLedger();
    expect(() =>
      led.create('BIL', validMovementCreate({ from_stage: 2, to_stage: 2 }), 'admin', NOW),
    ).toThrow(/invalid_transition/);
  });

  test('invalid stage rejected', () => {
    const led = new InMemoryStageMovementLedger();
    expect(() =>
      led.create('BIL', validMovementCreate({ to_stage: 5 as never }), 'admin', NOW),
    ).toThrow(/invalid_stage/);
  });

  test('invalid reason rejected', () => {
    const led = new InMemoryStageMovementLedger();
    expect(() =>
      led.create('BIL', validMovementCreate({ reason: 'bogus' as never }), 'admin', NOW),
    ).toThrow(/invalid_reason/);
  });

  test('invalid movement_at rejected', () => {
    const led = new InMemoryStageMovementLedger();
    expect(() =>
      led.create('BIL', validMovementCreate({ movement_at: 'not-iso' }), 'admin', NOW),
    ).toThrow(/invalid_movement_at/);
  });

  test('resolveCurrentStage returns null when no movements', () => {
    const led = new InMemoryStageMovementLedger();
    expect(led.resolveCurrentStage('BIL', 'CUST-X')).toBeNull();
  });

  test('resolveCurrentStage returns newest stage', () => {
    const led = new InMemoryStageMovementLedger();
    led.create(
      'BIL',
      validMovementCreate({
        movement_id: 'sm_a',
        from_stage: null,
        to_stage: 1,
        movement_at: '2026-01-01T09:00:00.000Z',
      }),
      'admin',
      NOW,
    );
    led.create(
      'BIL',
      validMovementCreate({
        movement_id: 'sm_b',
        from_stage: 1,
        to_stage: 2,
        movement_at: '2026-03-15T09:00:00.000Z',
      }),
      'admin',
      NOW,
    );
    led.create(
      'BIL',
      validMovementCreate({
        movement_id: 'sm_c',
        from_stage: 2,
        to_stage: 3,
        reason: 'dpd_90_breach',
        movement_at: '2026-04-20T09:00:00.000Z',
      }),
      'admin',
      NOW,
    );
    expect(led.resolveCurrentStage('BIL', 'CUST-100001')).toBe(3);
  });

  test('list filters by customer + stage + reason', () => {
    const led = new InMemoryStageMovementLedger();
    led.create('BIL', validMovementCreate({ movement_id: 'sm_alpha', customer_id: 'CUST-A' }), 'admin', NOW);
    led.create(
      'BIL',
      validMovementCreate({
        movement_id: 'sm_beta',
        customer_id: 'CUST-B',
        to_stage: 3,
        reason: 'dpd_90_breach',
      }),
      'admin',
      NOW,
    );
    expect(led.list('BIL', { customer_id: 'CUST-A' })).toHaveLength(1);
    expect(led.list('BIL', { to_stage: 3 })).toHaveLength(1);
    expect(led.list('BIL', { reason: 'dpd_90_breach' })).toHaveLength(1);
  });

  test('cross-tenant isolation', () => {
    const led = new InMemoryStageMovementLedger();
    led.create('BIL', validMovementCreate(), 'admin', NOW);
    expect(led.list('BANK_DEMO')).toHaveLength(0);
  });

  test('soft-delete + restore', () => {
    const led = new InMemoryStageMovementLedger();
    const m = led.create('BIL', validMovementCreate(), 'admin', NOW);
    led.softDelete('BIL', m.movement_id, 'admin', NOW);
    expect(led.get('BIL', m.movement_id)).toBeNull();
    expect(led.list('BIL', { include_deleted: true })).toHaveLength(1);
    expect(led.restore({ ...m, deleted_at: NOW.toISOString(), deleted_by: 'admin' })).toBe(true);
    expect(led.get('BIL', m.movement_id)?.deleted_at).toBeNull();
  });

  test('portfolioRollup aggregates by stage + reason', () => {
    const led = new InMemoryStageMovementLedger();
    led.create('BIL', validMovementCreate({ customer_id: 'C1', movement_id: 'sm_alpha' }), 'admin', NOW);
    led.create(
      'BIL',
      validMovementCreate({
        customer_id: 'C2',
        movement_id: 'sm_beta',
        to_stage: 3,
        reason: 'dpd_90_breach',
      }),
      'admin',
      NOW,
    );
    const r = led.portfolioRollup('BIL');
    expect(r.total_customers_with_movements).toBe(2);
    expect(r.customers_by_current_stage[2]).toBe(1);
    expect(r.customers_by_current_stage[3]).toBe(1);
    expect(r.movements_by_reason.dpd_30_breach).toBe(1);
    expect(r.movements_by_reason.dpd_90_breach).toBe(1);
    expect(r.stage_3_ecl).toBe(20_000);
  });
});

// ── 4. EclOverrideStore CRUD ──────────────────────────────────────────

describe('InMemoryEclOverrideStore', () => {
  test('create with all 3 override fields', () => {
    const s = new InMemoryEclOverrideStore();
    const o = s.create(
      'BIL',
      validOverrideCreate({ pd_override: 0.2, lgd_override: 0.6, ead_override: 2_000_000 }),
      'admin',
      NOW,
    );
    expect(o.pd_override).toBe(0.2);
    expect(o.active).toBe(true);
  });

  test('create with single override field works', () => {
    const s = new InMemoryEclOverrideStore();
    const o = s.create(
      'BIL',
      validOverrideCreate({ pd_override: 0.2, lgd_override: null, ead_override: null }),
      'admin',
      NOW,
    );
    expect(o.pd_override).toBe(0.2);
    expect(o.lgd_override).toBeNull();
  });

  test('create rejected when all fields null', () => {
    const s = new InMemoryEclOverrideStore();
    expect(() =>
      s.create(
        'BIL',
        validOverrideCreate({ pd_override: null, lgd_override: null, ead_override: null }),
        'admin',
        NOW,
      ),
    ).toThrow(/invalid_inputs/);
  });

  test('duplicate active override per customer rejected', () => {
    const s = new InMemoryEclOverrideStore();
    s.create('BIL', validOverrideCreate({ override_id: 'eo_a' }), 'admin', NOW);
    expect(() =>
      s.create('BIL', validOverrideCreate({ override_id: 'eo_b' }), 'admin', NOW),
    ).toThrow(/duplicate_override/);
  });

  test('inactive duplicate is fine', () => {
    const s = new InMemoryEclOverrideStore();
    s.create('BIL', validOverrideCreate({ override_id: 'eo_a', active: false }), 'admin', NOW);
    expect(() =>
      s.create('BIL', validOverrideCreate({ override_id: 'eo_b' }), 'admin', NOW),
    ).not.toThrow();
  });

  test('resolveActive returns the active override', () => {
    const s = new InMemoryEclOverrideStore();
    s.create('BIL', validOverrideCreate({ override_id: 'eo_a' }), 'admin', NOW);
    expect(s.resolveActive('BIL', 'CUST-100001')?.override_id).toBe('eo_a');
    expect(s.resolveActive('BIL', 'CUST-X')).toBeNull();
  });

  test('update flips active → reactivation conflict refused', () => {
    const s = new InMemoryEclOverrideStore();
    s.create('BIL', validOverrideCreate({ override_id: 'eo_a' }), 'admin', NOW);
    s.create(
      'BIL',
      validOverrideCreate({ override_id: 'eo_b', active: false }),
      'admin',
      NOW,
    );
    expect(() =>
      s.update('BIL', 'eo_b', { active: true }, 'admin', NOW),
    ).toThrow(/duplicate_override/);
  });

  test('update merges + maintains at-least-one-override invariant', () => {
    const s = new InMemoryEclOverrideStore();
    s.create(
      'BIL',
      validOverrideCreate({ override_id: 'eo_a', pd_override: 0.5, lgd_override: null, ead_override: null }),
      'admin',
      NOW,
    );
    // Clearing the only override field → reject.
    expect(() =>
      s.update('BIL', 'eo_a', { pd_override: null }, 'admin', NOW),
    ).toThrow(/invalid_inputs/);
  });

  test('soft-delete frees the customer slot for a new active override', () => {
    const s = new InMemoryEclOverrideStore();
    s.create('BIL', validOverrideCreate({ override_id: 'eo_a' }), 'admin', NOW);
    s.softDelete('BIL', 'eo_a', 'admin', NOW);
    expect(s.resolveActive('BIL', 'CUST-100001')).toBeNull();
    // New active override for the same customer now allowed.
    expect(() =>
      s.create('BIL', validOverrideCreate({ override_id: 'eo_b' }), 'admin', NOW),
    ).not.toThrow();
  });

  test('restore refuses when another active override holds the customer', () => {
    const s = new InMemoryEclOverrideStore();
    const o = s.create('BIL', validOverrideCreate({ override_id: 'eo_a' }), 'admin', NOW);
    s.softDelete('BIL', 'eo_a', 'admin', NOW);
    s.create('BIL', validOverrideCreate({ override_id: 'eo_b' }), 'admin', NOW);
    expect(
      s.restore({ ...o, deleted_at: NOW.toISOString(), deleted_by: 'admin' }),
    ).toBe(false);
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryEclOverrideStore();
    s.create('BIL', validOverrideCreate(), 'admin', NOW);
    expect(s.list('BANK_DEMO')).toHaveLength(0);
  });
});

// ── 5. Route — runbook + compute ECL ──────────────────────────────────

describe('GET /v1/ifrs9/enums', () => {
  test('admin → 200 with enums', async () => {
    const app = makeIfrs9App('admin');
    const r = await request(app).get('/v1/ifrs9/enums').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.stages).toEqual([...ALL_IFRS9_STAGES]);
    expect(r.body.body.movement_reasons).toEqual([...ALL_STAGE_MOVEMENT_REASONS]);
  });

  test('case_owner → 403', async () => {
    const app = makeIfrs9App('case_owner');
    const r = await request(app).get('/v1/ifrs9/enums').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/ifrs9/ecl/compute', () => {
  test('admin → 200 with ecl', async () => {
    const app = makeIfrs9App('admin');
    const r = await request(app).post('/v1/ifrs9/ecl/compute').set(TH_BIL).send(validInputs());
    expect(r.status).toBe(200);
    expect(r.body.body.ecl).toBe(20_000);
  });

  test('invalid inputs → 400', async () => {
    const app = makeIfrs9App('admin');
    const r = await request(app)
      .post('/v1/ifrs9/ecl/compute')
      .set(TH_BIL)
      .send({ pd: 1.5, lgd: 0.5, ead: 1000 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_inputs');
  });

  test('enveloped body accepted', async () => {
    const app = makeIfrs9App('admin');
    const r = await request(app)
      .post('/v1/ifrs9/ecl/compute')
      .set(TH_BIL)
      .send({ header: { requestId: 'x' }, body: validInputs() });
    expect(r.status).toBe(200);
  });
});

// ── 6. Routes — movements ────────────────────────────────────────────

describe('POST /v1/ifrs9/movements', () => {
  test('happy path → 201', async () => {
    const app = makeIfrs9App('admin');
    const r = await request(app)
      .post('/v1/ifrs9/movements')
      .set(TH_BIL)
      .send(validMovementCreate());
    expect(r.status).toBe(201);
    expect(r.body.body.ecl).toBe(20_000);
  });

  test('invalid_transition (from === to) → 400', async () => {
    const app = makeIfrs9App('admin');
    const r = await request(app)
      .post('/v1/ifrs9/movements')
      .set(TH_BIL)
      .send(validMovementCreate({ from_stage: 2, to_stage: 2 }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_transition');
  });

  test('case_owner → 403', async () => {
    const app = makeIfrs9App('case_owner');
    const r = await request(app)
      .post('/v1/ifrs9/movements')
      .set(TH_BIL)
      .send(validMovementCreate());
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/ifrs9/movements + current + single', () => {
  test('list happy + filter by customer', async () => {
    const led = new InMemoryStageMovementLedger();
    const app = makeIfrs9App('admin', { stageMovementLedger: led });
    led.create('BIL', validMovementCreate({ customer_id: 'CUST-A' }), 'admin', NOW);
    led.create(
      'BIL',
      validMovementCreate({ customer_id: 'CUST-B', to_stage: 3, reason: 'dpd_90_breach' }),
      'admin',
      NOW,
    );
    const r = await request(app).get('/v1/ifrs9/movements?customer_id=CUST-A').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
  });

  test('invalid to_stage filter → 400', async () => {
    const app = makeIfrs9App('admin');
    const r = await request(app).get('/v1/ifrs9/movements?to_stage=5').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_stage');
  });

  test('current stage resolves to latest', async () => {
    const led = new InMemoryStageMovementLedger();
    const app = makeIfrs9App('admin', { stageMovementLedger: led });
    led.create('BIL', validMovementCreate(), 'admin', NOW);
    const r = await request(app)
      .get('/v1/ifrs9/movements/current/CUST-100001')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.current_stage).toBe(2);
  });

  test('current stage null when no movements', async () => {
    const app = makeIfrs9App('admin');
    const r = await request(app)
      .get('/v1/ifrs9/movements/current/CUST-NONE')
      .set(TH_BIL);
    expect(r.body.body.current_stage).toBeNull();
  });

  test('single movement 200 + 404', async () => {
    const led = new InMemoryStageMovementLedger();
    const app = makeIfrs9App('admin', { stageMovementLedger: led });
    const m = led.create('BIL', validMovementCreate(), 'admin', NOW);
    const ok = await request(app).get(`/v1/ifrs9/movements/${m.movement_id}`).set(TH_BIL);
    expect(ok.status).toBe(200);
    const miss = await request(app).get('/v1/ifrs9/movements/sm_nope').set(TH_BIL);
    expect(miss.status).toBe(404);
  });
});

describe('DELETE /v1/ifrs9/movements/:movement_id', () => {
  test('happy → 204', async () => {
    const led = new InMemoryStageMovementLedger();
    const app = makeIfrs9App('admin', { stageMovementLedger: led });
    const m = led.create('BIL', validMovementCreate(), 'admin', NOW);
    const r = await request(app).delete(`/v1/ifrs9/movements/${m.movement_id}`).set(TH_BIL);
    expect(r.status).toBe(204);
    expect(led.get('BIL', m.movement_id)).toBeNull();
  });

  test('unknown → 404', async () => {
    const app = makeIfrs9App('admin');
    const r = await request(app).delete('/v1/ifrs9/movements/nope').set(TH_BIL);
    expect(r.status).toBe(404);
  });
});

// ── 7. Routes — portfolio rollup ─────────────────────────────────────

describe('GET /v1/ifrs9/portfolio', () => {
  test('empty → zero rollup', async () => {
    const app = makeIfrs9App('admin');
    const r = await request(app).get('/v1/ifrs9/portfolio').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_customers_with_movements).toBe(0);
  });

  test('populated → rollup reflects ledger', async () => {
    const led = new InMemoryStageMovementLedger();
    const app = makeIfrs9App('admin', { stageMovementLedger: led });
    led.create('BIL', validMovementCreate({ customer_id: 'C1' }), 'admin', NOW);
    led.create(
      'BIL',
      validMovementCreate({
        customer_id: 'C2',
        to_stage: 3,
        reason: 'dpd_90_breach',
      }),
      'admin',
      NOW,
    );
    const r = await request(app).get('/v1/ifrs9/portfolio').set(TH_BIL);
    expect(r.body.body.total_customers_with_movements).toBe(2);
    expect(r.body.body.movements_by_reason.dpd_90_breach).toBe(1);
    expect(r.body.body.stage_3_ecl).toBe(20_000);
  });

  test('cross-tenant invisibility', async () => {
    const led = new InMemoryStageMovementLedger();
    const app = makeIfrs9App('admin', { stageMovementLedger: led });
    led.create('BIL', validMovementCreate(), 'admin', NOW);
    const r = await request(app).get('/v1/ifrs9/portfolio').set(TH_BANK);
    expect(r.body.body.total_customers_with_movements).toBe(0);
  });
});

// ── 8. Routes — ECL overrides ────────────────────────────────────────

describe('POST /v1/ifrs9/ecl-overrides', () => {
  test('happy → 201', async () => {
    const app = makeIfrs9App('admin');
    const r = await request(app)
      .post('/v1/ifrs9/ecl-overrides')
      .set(TH_BIL)
      .send(validOverrideCreate());
    expect(r.status).toBe(201);
    expect(r.body.body.active).toBe(true);
  });

  test('duplicate active override → 409', async () => {
    const app = makeIfrs9App('admin');
    await request(app).post('/v1/ifrs9/ecl-overrides').set(TH_BIL).send(validOverrideCreate());
    const r2 = await request(app).post('/v1/ifrs9/ecl-overrides').set(TH_BIL).send(validOverrideCreate());
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('EWS_409_duplicate_override');
  });

  test('all-null override fields → 400', async () => {
    const app = makeIfrs9App('admin');
    const r = await request(app)
      .post('/v1/ifrs9/ecl-overrides')
      .set(TH_BIL)
      .send(validOverrideCreate({ pd_override: null, lgd_override: null, ead_override: null }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_inputs');
  });
});

describe('GET /v1/ifrs9/ecl-overrides', () => {
  test('list + filter by active', async () => {
    const store = new InMemoryEclOverrideStore();
    const app = makeIfrs9App('admin', { eclOverrideStore: store });
    store.create(
      'BIL',
      validOverrideCreate({ override_id: 'eo_a' }),
      'admin',
      NOW,
    );
    store.create(
      'BIL',
      validOverrideCreate({ override_id: 'eo_b', customer_id: 'CUST-X', active: false }),
      'admin',
      NOW,
    );
    const all = await request(app).get('/v1/ifrs9/ecl-overrides').set(TH_BIL);
    expect(all.body.body.total).toBe(2);
    const onlyActive = await request(app)
      .get('/v1/ifrs9/ecl-overrides?active=true')
      .set(TH_BIL);
    expect(onlyActive.body.body.total).toBe(1);
  });

  test('invalid active filter → 400', async () => {
    const app = makeIfrs9App('admin');
    const r = await request(app)
      .get('/v1/ifrs9/ecl-overrides?active=yes')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });
});

describe('GET /v1/ifrs9/ecl-overrides/active/:customer_id', () => {
  test('returns the active override or null', async () => {
    const store = new InMemoryEclOverrideStore();
    const app = makeIfrs9App('admin', { eclOverrideStore: store });
    store.create('BIL', validOverrideCreate(), 'admin', NOW);
    const hit = await request(app)
      .get('/v1/ifrs9/ecl-overrides/active/CUST-100001')
      .set(TH_BIL);
    expect(hit.body.body.override).not.toBeNull();
    const miss = await request(app)
      .get('/v1/ifrs9/ecl-overrides/active/CUST-NONE')
      .set(TH_BIL);
    expect(miss.body.body.override).toBeNull();
  });
});

describe('PATCH /v1/ifrs9/ecl-overrides/:override_id', () => {
  test('updates pd_override', async () => {
    const store = new InMemoryEclOverrideStore();
    const app = makeIfrs9App('admin', { eclOverrideStore: store });
    const o = store.create('BIL', validOverrideCreate(), 'admin', NOW);
    const r = await request(app)
      .patch(`/v1/ifrs9/ecl-overrides/${o.override_id}`)
      .set(TH_BIL)
      .send({ pd_override: 0.3 });
    expect(r.status).toBe(200);
    expect(r.body.body.pd_override).toBe(0.3);
  });

  test('unknown override → 404', async () => {
    const app = makeIfrs9App('admin');
    const r = await request(app)
      .patch('/v1/ifrs9/ecl-overrides/nope')
      .set(TH_BIL)
      .send({ pd_override: 0.5 });
    expect(r.status).toBe(404);
  });
});

describe('DELETE /v1/ifrs9/ecl-overrides/:override_id', () => {
  test('happy → 204', async () => {
    const store = new InMemoryEclOverrideStore();
    const app = makeIfrs9App('admin', { eclOverrideStore: store });
    const o = store.create('BIL', validOverrideCreate(), 'admin', NOW);
    const r = await request(app).delete(`/v1/ifrs9/ecl-overrides/${o.override_id}`).set(TH_BIL);
    expect(r.status).toBe(204);
    expect(store.get('BIL', o.override_id)).toBeNull();
  });

  test('unknown → 404', async () => {
    const app = makeIfrs9App('admin');
    const r = await request(app).delete('/v1/ifrs9/ecl-overrides/nope').set(TH_BIL);
    expect(r.status).toBe(404);
  });
});
