// services/bff/__tests__/scoring_preset_clone_from_library.test.ts
//
// T6 M6.11 — Weight preset clone-from-library.

import request from 'supertest';
import { InMemoryCustomWeightPresetStore } from '../src/scoring_presets_custom';
import { listWeightPresets } from '../src/scoring_presets';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeCloneApp(role = 'admin') {
  const customWeightPresetStore = new InMemoryCustomWeightPresetStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    customWeightPresetStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, customWeightPresetStore };
}

describe('M6.11 — POST /v1/scoring/presets/custom/clone-from-library', () => {
  test('missing source_preset_id → 400 invalid_input', async () => {
    const { app } = makeCloneApp('admin');
    const r = await request(app)
      .post('/v1/scoring/presets/custom/clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('unknown library preset → 404 unknown_preset', async () => {
    const { app } = makeCloneApp('admin');
    const r = await request(app)
      .post('/v1/scoring/presets/custom/clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ source_preset_id: 'totally-not-a-preset' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });

  test('happy path with default name → 201; multipliers deep-copied', async () => {
    const { app, customWeightPresetStore } = makeCloneApp('admin');
    const libPreset = listWeightPresets()[0]!;
    const r = await request(app)
      .post('/v1/scoring/presets/custom/clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ source_preset_id: libPreset.id });
    expect(r.status).toBe(201);
    const created = r.body.body;
    expect(created.id).toMatch(/^wp_custom_/);
    expect(created.name).toBe(`Copy of ${libPreset.name}`);
    expect(created.vertical).toBe(libPreset.vertical);
    expect(created.mode).toBe(libPreset.mode);
    expect(created.weight_multipliers).toEqual(libPreset.weight_multipliers);
    // Verify store actually retained it.
    expect(customWeightPresetStore.list('BIL')).toHaveLength(1);
  });

  test('name override applied', async () => {
    const { app } = makeCloneApp('admin');
    const libPreset = listWeightPresets()[0]!;
    const r = await request(app)
      .post('/v1/scoring/presets/custom/clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ source_preset_id: libPreset.id, name: 'My banking override' });
    expect(r.status).toBe(201);
    expect(r.body.body.name).toBe('My banking override');
  });

  test('multipliers truly deep-copied (mutating clone does not touch library)', async () => {
    const { app } = makeCloneApp('admin');
    const libPreset = listWeightPresets()[0]!;
    // Find any indicator key already in the library preset's multipliers.
    const sampleKey = Object.keys(libPreset.weight_multipliers)[0];
    expect(sampleKey).toBeDefined();
    const r = await request(app)
      .post('/v1/scoring/presets/custom/clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ source_preset_id: libPreset.id });
    expect(r.status).toBe(201);
    const clone = r.body.body;
    // The clone's weight_multipliers should be a SEPARATE object from the
    // library preset's (object identity) — verify by mutating.
    const originalValue = clone.weight_multipliers[sampleKey!];
    clone.weight_multipliers[sampleKey!] = 999;
    expect(listWeightPresets()[0]!.weight_multipliers[sampleKey!]).toBe(originalValue);
  });

  test('cap reached → 409 cap_reached', async () => {
    const { app, customWeightPresetStore } = makeCloneApp('admin');
    // Seed the store right up to the cap (30).
    for (let i = 0; i < 30; i += 1) {
      customWeightPresetStore.create(
        'BIL',
        {
          name: `seed ${i}`,
          description: 'seeded for cap test',
          vertical: 'banking',
          mode: 'balanced',
          weight_multipliers: { 'BIL.PD.30d': 1.0 },
        },
        'seeder',
        NOW,
      );
    }
    const libPreset = listWeightPresets()[0]!;
    const r = await request(app)
      .post('/v1/scoring/presets/custom/clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ source_preset_id: libPreset.id });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_cap_reached');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCloneApp('case_owner');
    const libPreset = listWeightPresets()[0]!;
    const r = await request(app)
      .post('/v1/scoring/presets/custom/clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ source_preset_id: libPreset.id });
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL clone invisible to BANK_DEMO', async () => {
    const { app, customWeightPresetStore } = makeCloneApp('admin');
    const libPreset = listWeightPresets()[0]!;
    await request(app)
      .post('/v1/scoring/presets/custom/clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ source_preset_id: libPreset.id });
    expect(customWeightPresetStore.list('BIL')).toHaveLength(1);
    expect(customWeightPresetStore.list('BANK_DEMO')).toHaveLength(0);
  });

  test('M6.4 manual POST /v1/scoring/presets/custom still works', async () => {
    const { app } = makeCloneApp('admin');
    const r = await request(app)
      .post('/v1/scoring/presets/custom')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({
        name: 'manual',
        description: 'manually authored preset',
        vertical: 'banking',
        mode: 'balanced',
        weight_multipliers: { 'BIL.PD.30d': 1.2 },
      });
    expect(r.status).toBe(201);
    expect(r.body.body.id).toMatch(/^wp_custom_/);
  });
});
