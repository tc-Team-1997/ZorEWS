// services/bff/__tests__/scoring_preset_bulk_clone.test.ts
//
// T6 M6.12 — Bulk-clone weight presets from library.

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

function makeBulkApp(role = 'admin') {
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

describe('M6.12 — POST /v1/scoring/presets/custom/bulk-clone-from-library', () => {
  test('missing source_preset_ids → 400', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/scoring/presets/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('empty source_preset_ids → 400', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/scoring/presets/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .send({ source_preset_ids: [] });
    expect(r.status).toBe(400);
  });

  test('over-cap → 400', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/scoring/presets/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .send({ source_preset_ids: new Array(11).fill('whatever') });
    expect(r.status).toBe(400);
  });

  test('happy path: 2 valid library ids → 2 created', async () => {
    const { app, customWeightPresetStore } = makeBulkApp('admin');
    const lib = listWeightPresets();
    const ids = [lib[0]!.id, lib[1]!.id];
    const r = await request(app)
      .post('/v1/scoring/presets/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ source_preset_ids: ids });
    expect(r.status).toBe(201);
    expect(r.body.body.total_requested).toBe(2);
    expect(r.body.body.created_count).toBe(2);
    expect(r.body.body.skipped_count).toBe(0);
    expect(r.body.body.created).toHaveLength(2);
    expect(customWeightPresetStore.list('BIL')).toHaveLength(2);
  });

  test('name_prefix applied to every clone', async () => {
    const { app } = makeBulkApp('admin');
    const lib = listWeightPresets();
    const r = await request(app)
      .post('/v1/scoring/presets/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({
        source_preset_ids: [lib[0]!.id, lib[1]!.id],
        name_prefix: '[BIL Q2] ',
      });
    expect(r.status).toBe(201);
    for (const c of r.body.body.created) {
      // Trailing space in the prefix is trimmed server-side; assert
      // the bracketed prefix lands but spacing is implementation-detail.
      expect(c.name.startsWith('[BIL Q2]')).toBe(true);
    }
  });

  test('unknown id surfaces in skipped[]', async () => {
    const { app } = makeBulkApp('admin');
    const lib = listWeightPresets();
    const r = await request(app)
      .post('/v1/scoring/presets/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ source_preset_ids: [lib[0]!.id, 'not-a-real-preset'] });
    expect(r.status).toBe(201);
    expect(r.body.body.created_count).toBe(1);
    expect(r.body.body.skipped_count).toBe(1);
    expect(r.body.body.skipped[0].source_preset_id).toBe('not-a-real-preset');
    expect(r.body.body.skipped[0].reason).toBe('unknown_preset');
  });

  test('duplicate id in request → skipped as duplicate_in_request', async () => {
    const { app } = makeBulkApp('admin');
    const lib = listWeightPresets();
    const r = await request(app)
      .post('/v1/scoring/presets/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ source_preset_ids: [lib[0]!.id, lib[0]!.id] });
    expect(r.status).toBe(201);
    expect(r.body.body.created_count).toBe(1);
    expect(r.body.body.skipped_count).toBe(1);
    expect(r.body.body.skipped[0].reason).toBe('duplicate_in_request');
  });

  test('non-string id surfaces as invalid_id', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/scoring/presets/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .send({ source_preset_ids: [42, null] });
    expect(r.status).toBe(201);
    expect(r.body.body.skipped_count).toBe(2);
    expect(r.body.body.skipped.every((s: { reason: string }) => s.reason === 'invalid_id')).toBe(true);
  });

  test('cap_reached on 31st preset surfaces in skipped[]', async () => {
    const { app, customWeightPresetStore } = makeBulkApp('admin');
    const lib = listWeightPresets();
    // Pre-seed 30 (the per-tenant cap).
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
    const r = await request(app)
      .post('/v1/scoring/presets/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ source_preset_ids: [lib[0]!.id] });
    expect(r.status).toBe(201);
    expect(r.body.body.created_count).toBe(0);
    expect(r.body.body.skipped[0].reason).toBe('cap_reached');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBulkApp('case_owner');
    const r = await request(app)
      .post('/v1/scoring/presets/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .send({ source_preset_ids: ['x'] });
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL clones invisible to BANK_DEMO', async () => {
    const { app, customWeightPresetStore } = makeBulkApp('admin');
    const lib = listWeightPresets();
    await request(app)
      .post('/v1/scoring/presets/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ source_preset_ids: [lib[0]!.id] });
    expect(customWeightPresetStore.list('BIL')).toHaveLength(1);
    expect(customWeightPresetStore.list('BANK_DEMO')).toHaveLength(0);
  });

  test('M6.11 single clone-from-library still works (route ordering)', async () => {
    const { app } = makeBulkApp('admin');
    const lib = listWeightPresets();
    const r = await request(app)
      .post('/v1/scoring/presets/custom/clone-from-library')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ source_preset_id: lib[0]!.id });
    expect(r.status).toBe(201);
  });
});
