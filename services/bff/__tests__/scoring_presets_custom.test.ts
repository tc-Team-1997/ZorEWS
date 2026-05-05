// services/bff/__tests__/scoring_presets_custom.test.ts
//
// T6 M6.4 — Custom user-defined weight presets.

import request from 'supertest';
import {
  CustomWeightPresetError,
  InMemoryCustomWeightPresetStore,
  getEffectiveWeightPreset,
} from '../src/scoring_presets_custom';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T20:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const VALID = {
  name: 'BIL banking — DPD-heavy',
  description: 'Internal posture for over-leveraged customers',
  vertical: 'banking',
  mode: 'conservative',
  weight_multipliers: { 'FIN-001': 1.4, 'BEH-001': 1.3 },
};

function makeApp4Test(role = 'admin') {
  const store = new InMemoryCustomWeightPresetStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    customWeightPresetStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

describe('InMemoryCustomWeightPresetStore', () => {
  test('happy: create returns valid WeightPreset', () => {
    const s = new InMemoryCustomWeightPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    expect(p.id).toMatch(/^wp_custom_/);
    expect(p.vertical).toBe('banking');
    expect(p.mode).toBe('conservative');
    expect(p.weight_multipliers['FIN-001']).toBe(1.4);
  });

  test('rejects empty name', () => {
    const s = new InMemoryCustomWeightPresetStore();
    expect(() => s.create('BIL', { ...VALID, name: '' }, 'admin', NOW)).toThrow(/name/);
  });

  test('rejects invalid vertical', () => {
    const s = new InMemoryCustomWeightPresetStore();
    expect(() => s.create('BIL', { ...VALID, vertical: 'crypto' }, 'admin', NOW)).toThrow(
      /vertical/,
    );
  });

  test('rejects invalid mode', () => {
    const s = new InMemoryCustomWeightPresetStore();
    expect(() => s.create('BIL', { ...VALID, mode: 'extreme' }, 'admin', NOW)).toThrow(/mode/);
  });

  test('rejects multiplier below 0.1', () => {
    const s = new InMemoryCustomWeightPresetStore();
    expect(() =>
      s.create(
        'BIL',
        { ...VALID, weight_multipliers: { 'FIN-001': 0.05 } },
        'admin',
        NOW,
      ),
    ).toThrow(/FIN-001/);
  });

  test('rejects multiplier above 5.0', () => {
    const s = new InMemoryCustomWeightPresetStore();
    expect(() =>
      s.create(
        'BIL',
        { ...VALID, weight_multipliers: { 'FIN-001': 10 } },
        'admin',
        NOW,
      ),
    ).toThrow(/FIN-001/);
  });

  test('rejects non-finite multiplier', () => {
    const s = new InMemoryCustomWeightPresetStore();
    expect(() =>
      s.create(
        'BIL',
        { ...VALID, weight_multipliers: { 'FIN-001': Number.POSITIVE_INFINITY } },
        'admin',
        NOW,
      ),
    ).toThrow(/FIN-001/);
  });

  test('rejects > 50 multiplier keys', () => {
    const wm: Record<string, number> = {};
    for (let i = 0; i < 51; i++) wm[`IND-${i}`] = 1.1;
    const s = new InMemoryCustomWeightPresetStore();
    expect(() =>
      s.create('BIL', { ...VALID, weight_multipliers: wm }, 'admin', NOW),
    ).toThrow(/50/);
  });

  test('empty multipliers map accepted (catalog passthrough)', () => {
    const s = new InMemoryCustomWeightPresetStore();
    const p = s.create('BIL', { ...VALID, weight_multipliers: {} }, 'admin', NOW);
    expect(Object.keys(p.weight_multipliers)).toEqual([]);
  });

  test('cap_reached after 30 presets', () => {
    const s = new InMemoryCustomWeightPresetStore();
    for (let i = 0; i < 30; i++) {
      s.create('BIL', { ...VALID, name: `p-${i}` }, 'admin', NOW);
    }
    try {
      s.create('BIL', VALID, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as CustomWeightPresetError).code).toBe('cap_reached');
    }
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryCustomWeightPresetStore();
    const a = s.create('BIL', VALID, 'admin', NOW);
    s.create('BANK_DEMO', VALID, 'admin', NOW);
    expect(s.get('BIL', a.id)?.id).toBe(a.id);
    expect(s.get('BANK_DEMO', a.id)).toBeNull();
  });

  test('delete returns true on hit, false on miss', () => {
    const s = new InMemoryCustomWeightPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    expect(s.delete('BIL', p.id)).toBe(true);
    expect(s.delete('BIL', p.id)).toBe(false);
  });
});

describe('getEffectiveWeightPreset', () => {
  test('library id resolves from library', () => {
    const s = new InMemoryCustomWeightPresetStore();
    const p = getEffectiveWeightPreset(s, 'BIL', 'preset_banking_balanced');
    expect(p?.id).toBe('preset_banking_balanced');
  });

  test('custom id resolves from per-tenant store', () => {
    const s = new InMemoryCustomWeightPresetStore();
    const created = s.create('BIL', VALID, 'admin', NOW);
    const p = getEffectiveWeightPreset(s, 'BIL', created.id);
    expect(p?.name).toBe(VALID.name);
  });

  test('custom id from a DIFFERENT tenant returns null', () => {
    const s = new InMemoryCustomWeightPresetStore();
    const created = s.create('BIL', VALID, 'admin', NOW);
    expect(getEffectiveWeightPreset(s, 'BANK_DEMO', created.id)).toBeNull();
  });

  test('unknown id returns null', () => {
    const s = new InMemoryCustomWeightPresetStore();
    expect(getEffectiveWeightPreset(s, 'BIL', 'NO-SUCH')).toBeNull();
  });
});

describe('Routes', () => {
  test('GET list 200 empty', async () => {
    const { app } = makeApp4Test('admin');
    const r = await request(app).get('/v1/scoring/presets/custom').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });

  test('POST 201 → list shows it', async () => {
    const { app } = makeApp4Test('admin');
    const c = await request(app).post('/v1/scoring/presets/custom').set(TH_BIL).send(VALID);
    expect(c.status).toBe(201);
    expect(c.body.body.id).toMatch(/^wp_custom_/);
    const list = await request(app).get('/v1/scoring/presets/custom').set(TH_BIL);
    expect(list.body.body.total).toBe(1);
  });

  test('POST validation: bad multiplier → 400', async () => {
    const { app } = makeApp4Test('admin');
    const r = await request(app)
      .post('/v1/scoring/presets/custom')
      .set(TH_BIL)
      .send({ ...VALID, weight_multipliers: { 'FIN-001': 100 } });
    expect(r.status).toBe(400);
  });

  test('DELETE 204 then 404', async () => {
    const { app } = makeApp4Test('admin');
    const c = await request(app).post('/v1/scoring/presets/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const d1 = await request(app).delete(`/v1/scoring/presets/custom/${id}`).set(TH_BIL);
    expect(d1.status).toBe(204);
    const d2 = await request(app).delete(`/v1/scoring/presets/custom/${id}`).set(TH_BIL);
    expect(d2.status).toBe(404);
  });

  test('cross-tenant isolation', async () => {
    const { app } = makeApp4Test('admin');
    await request(app).post('/v1/scoring/presets/custom').set(TH_BIL).send(VALID);
    const other = await request(app)
      .get('/v1/scoring/presets/custom')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(other.body.body.total).toBe(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeApp4Test('case_owner');
    const r = await request(app).get('/v1/scoring/presets/custom').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M6.3 GET /v1/scoring/presets/:id still works (literal /custom didn\'t shadow)', async () => {
    const { app } = makeApp4Test('admin');
    const r = await request(app)
      .get('/v1/scoring/presets/preset_banking_balanced')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.id).toBe('preset_banking_balanced');
  });

  test('M6.3 GET /v1/scoring/presets list (no /:id) still works', async () => {
    const { app } = makeApp4Test('admin');
    const r = await request(app).get('/v1/scoring/presets').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(6);
  });
});

// ─── M6.5 — Custom weight presets through scoreByPreset ──────────────

describe('M6.5 — custom presets resolve through scoreByPreset', () => {
  test('score-by-preset accepts a custom preset id', async () => {
    const { app } = makeApp4Test('admin');
    const c = await request(app).post('/v1/scoring/presets/custom').set(TH_BIL).send(VALID);
    const customId = c.body.body.id;
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset')
      .set(TH_BIL)
      .send({
        preset_id: customId,
        items: [{ indicator_id: 'FIN-001', value: 0.8 }],
      });
    expect(r.status).toBe(200);
    expect(r.body.body.preset_id).toBe(customId);
    expect(r.body.body.preset_mode).toBe('conservative');
    // FIN-001 catalog 0.9 × 1.4 = 1.26 → clamped to 1.0
    const fin = r.body.body.effective_weights.find(
      (e: { indicator_id: string }) => e.indicator_id === 'FIN-001',
    );
    expect(fin.multiplier).toBe(1.4);
    expect(fin.effective_weight).toBe(1);
  });

  test('cross-tenant: BIL custom id not visible from BANK_DEMO', async () => {
    const { app } = makeApp4Test('admin');
    const c = await request(app).post('/v1/scoring/presets/custom').set(TH_BIL).send(VALID);
    const customId = c.body.body.id;
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .send({
        preset_id: customId,
        items: [{ indicator_id: 'FIN-001', value: 0.8 }],
      });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });

  test('library presets still work (M6.3 no-regression)', async () => {
    const { app } = makeApp4Test('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-preset')
      .set(TH_BIL)
      .send({
        preset_id: 'preset_banking_balanced',
        items: [{ indicator_id: 'FIN-001', value: 0.5 }],
      });
    expect(r.status).toBe(200);
    expect(r.body.body.preset_id).toBe('preset_banking_balanced');
  });
});
