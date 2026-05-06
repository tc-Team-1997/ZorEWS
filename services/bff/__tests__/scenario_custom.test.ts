// services/bff/__tests__/scenario_custom.test.ts
//
// T6 M16.4 — Custom user-defined scenario presets.

import request from 'supertest';
import {
  CustomPresetError,
  InMemoryCustomPresetStore,
  diffPresetVersions,
  diffPresetVersionsByNumber,
  getEffectivePreset,
} from '../src/scenario_custom';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T19:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const VALID = {
  name: 'BIL — Eurozone slowdown',
  description: 'Internal stress for European exposure',
  category: 'business',
  regulator: 'INTERNAL',
  severity: 'moderate',
  shocks: { gdp: -1.5, rate: 75, fx: 4 },
  source_doc: 'BIL Risk Council 2026-Q2',
};

function makeCustomApp(role = 'admin') {
  const store = new InMemoryCustomPresetStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    customPresetStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

describe('InMemoryCustomPresetStore', () => {
  test('happy: create returns valid ScenarioPreset', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    expect(p.id).toMatch(/^custom_/);
    expect(p.name).toBe(VALID.name);
    expect(p.shocks.gdp).toBe(-1.5);
  });

  test('rejects empty name', () => {
    const s = new InMemoryCustomPresetStore();
    expect(() => s.create('BIL', { ...VALID, name: '' }, 'admin', NOW)).toThrow(/name/);
  });

  test('rejects invalid category', () => {
    const s = new InMemoryCustomPresetStore();
    expect(() => s.create('BIL', { ...VALID, category: 'crypto' }, 'admin', NOW)).toThrow(/category/);
  });

  test('rejects out-of-range gdp', () => {
    const s = new InMemoryCustomPresetStore();
    expect(() =>
      s.create('BIL', { ...VALID, shocks: { gdp: 100, rate: 0, fx: 0 } }, 'admin', NOW),
    ).toThrow(/gdp/);
  });

  test('rejects non-finite gdp', () => {
    const s = new InMemoryCustomPresetStore();
    expect(() =>
      s.create(
        'BIL',
        { ...VALID, shocks: { gdp: Number.POSITIVE_INFINITY, rate: 0, fx: 0 } },
        'admin',
        NOW,
      ),
    ).toThrow(/gdp/);
  });

  test('cap_reached after 50 presets', () => {
    const s = new InMemoryCustomPresetStore();
    for (let i = 0; i < 50; i++) {
      s.create('BIL', { ...VALID, name: `p-${i}` }, 'admin', NOW);
    }
    try {
      s.create('BIL', VALID, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as CustomPresetError).code).toBe('cap_reached');
    }
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryCustomPresetStore();
    const a = s.create('BIL', VALID, 'admin', NOW);
    s.create('BANK_DEMO', VALID, 'admin', NOW);
    expect(s.get('BIL', a.id)?.id).toBe(a.id);
    expect(s.get('BANK_DEMO', a.id)).toBeNull();
  });

  test('source_doc default mentions creator', () => {
    const s = new InMemoryCustomPresetStore();
    const noDoc = { ...VALID } as Record<string, unknown>;
    delete noDoc.source_doc;
    const p = s.create('BIL', noDoc, 'compliance.lead', NOW);
    expect(p.source_doc).toContain('compliance.lead');
  });

  test('delete returns true on hit, false on miss', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    expect(s.delete('BIL', p.id)).toBe(true);
    expect(s.delete('BIL', p.id)).toBe(false);
  });
});

describe('getEffectivePreset (library + custom merge)', () => {
  test('library id resolves from library (custom store ignored)', () => {
    const s = new InMemoryCustomPresetStore();
    const p = getEffectivePreset(s, 'BIL', 'preset_rbi_baseline_stress');
    expect(p?.id).toBe('preset_rbi_baseline_stress');
  });

  test('custom id resolves from per-tenant store', () => {
    const s = new InMemoryCustomPresetStore();
    const created = s.create('BIL', VALID, 'admin', NOW);
    const p = getEffectivePreset(s, 'BIL', created.id);
    expect(p?.name).toBe(VALID.name);
  });

  test('custom id from a DIFFERENT tenant returns null', () => {
    const s = new InMemoryCustomPresetStore();
    const created = s.create('BIL', VALID, 'admin', NOW);
    const p = getEffectivePreset(s, 'BANK_DEMO', created.id);
    expect(p).toBeNull();
  });

  test('unknown id returns null', () => {
    const s = new InMemoryCustomPresetStore();
    expect(getEffectivePreset(s, 'BIL', 'NO-SUCH')).toBeNull();
  });
});

describe('Routes', () => {
  test('GET list 200 empty', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app).get('/v1/scenarios/library/custom').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });

  test('POST 201 → list shows it', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    expect(c.status).toBe(201);
    expect(c.body.body.id).toMatch(/^custom_/);
    const list = await request(app).get('/v1/scenarios/library/custom').set(TH_BIL);
    expect(list.body.body.total).toBe(1);
  });

  test('POST validation: bad gdp → 400', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom')
      .set(TH_BIL)
      .send({ ...VALID, shocks: { gdp: 999, rate: 0, fx: 0 } });
    expect(r.status).toBe(400);
  });

  test('DELETE 204 then 404', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const d1 = await request(app).delete(`/v1/scenarios/library/custom/${id}`).set(TH_BIL);
    expect(d1.status).toBe(204);
    const d2 = await request(app).delete(`/v1/scenarios/library/custom/${id}`).set(TH_BIL);
    expect(d2.status).toBe(404);
  });

  test('cross-tenant isolation via routes', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const otherList = await request(app)
      .get('/v1/scenarios/library/custom')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(otherList.body.body.total).toBe(0);
    const otherDel = await request(app)
      .delete(`/v1/scenarios/library/custom/${id}`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(otherDel.status).toBe(404);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCustomApp('case_owner');
    const r = await request(app).get('/v1/scenarios/library/custom').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

// ─── M16.5 — Custom presets through bulk-run + diff ──────────────────

describe('M16.5 — custom presets resolve through bulk-run', () => {
  test('bulk-run accepts a custom preset id', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const customId = c.body.body.id;
    const r = await request(app)
      .post('/v1/scenarios/bulk-run')
      .set(TH_BIL)
      .send({ preset_ids: [customId] });
    expect(r.status).toBe(200);
    expect(r.body.body.results.length).toBe(1);
  });

  test('bulk-run mixes library + custom ids', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const customId = c.body.body.id;
    const r = await request(app)
      .post('/v1/scenarios/bulk-run')
      .set(TH_BIL)
      .send({ preset_ids: [customId, 'preset_baseline_no_shock'] });
    expect(r.status).toBe(200);
    expect(r.body.body.results.length).toBe(2);
  });

  test('bulk-run cross-tenant: BIL custom id not visible from BANK_DEMO', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const customId = c.body.body.id;
    const r = await request(app)
      .post('/v1/scenarios/bulk-run')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .send({ preset_ids: [customId] });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });
});

describe('M16.5 — custom presets resolve through diff', () => {
  test('diff accepts custom-vs-library', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const customId = c.body.body.id;
    const r = await request(app)
      .post('/v1/scenarios/diff')
      .set(TH_BIL)
      .send({ left_id: customId, right_id: 'preset_rbi_severely_adverse' });
    expect(r.status).toBe(200);
    expect(r.body.body.left.id).toBe(customId);
  });

  test('diff cross-tenant: BIL custom id not visible from BANK_DEMO', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const customId = c.body.body.id;
    const r = await request(app)
      .post('/v1/scenarios/diff')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .send({ left_id: customId, right_id: 'preset_baseline_no_shock' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });

  test('diff library-only ids still work (M16.3 no-regression)', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/diff')
      .set(TH_BIL)
      .send({
        left_id: 'preset_rbi_baseline_stress',
        right_id: 'preset_rbi_severely_adverse',
      });
    expect(r.status).toBe(200);
  });
});

// ─── M16.6 — Scenario history (audit log) ────────────────────────────

describe('M16.6 — scenario history', () => {
  test('POST custom writes a scenario.create audit event', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app)
      .post('/v1/scenarios/library/custom')
      .set(TH_BIL)
      .set('X-APEX-USER', 'compliance.lead')
      .send(VALID);
    const id = c.body.body.id;
    // Read the slim history
    const h = await request(app)
      .get(`/v1/scenarios/library/custom/${id}/history`)
      .set(TH_BIL);
    expect(h.status).toBe(200);
    expect(h.body.body.total).toBe(1);
    expect(h.body.body.items[0].action).toBe('scenario.create');
    expect(h.body.body.items[0].actor_username).toBe('compliance.lead');
    expect(h.body.body.items[0].metadata.name).toBe(VALID.name);
  });

  test('DELETE custom writes a scenario.delete audit event', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    await request(app)
      .delete(`/v1/scenarios/library/custom/${id}`)
      .set(TH_BIL)
      .set('X-APEX-USER', 'admin');
    const h = await request(app)
      .get(`/v1/scenarios/library/custom/${id}/history`)
      .set(TH_BIL);
    expect(h.body.body.total).toBe(2);
    const actions = h.body.body.items.map((x: { action: string }) => x.action).sort();
    expect(actions).toEqual(['scenario.create', 'scenario.delete']);
  });

  test('history endpoint returns empty for never-touched preset id', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .get('/v1/scenarios/library/custom/custom_no_such/history')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });

  test('history filters by preset_id (no leakage from other presets)', async () => {
    const { app } = makeCustomApp('admin');
    const c1 = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const c2 = await request(app)
      .post('/v1/scenarios/library/custom')
      .set(TH_BIL)
      .send({ ...VALID, name: 'Other preset' });
    const h1 = await request(app)
      .get(`/v1/scenarios/library/custom/${c1.body.body.id}/history`)
      .set(TH_BIL);
    expect(h1.body.body.total).toBe(1);
    expect(h1.body.body.items[0].metadata.name).toBe(VALID.name);
    void c2;
  });

  test('cross-tenant: history isolated', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const r = await request(app)
      .get(`/v1/scenarios/library/custom/${id}/history`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });

  test('history endpoint declared before /library/:id (literal /custom wins)', async () => {
    const { app } = makeCustomApp('admin');
    // GET /v1/scenarios/library/custom/<id>/history should NOT be matched
    // by the `:id` route; it's a longer literal path.
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    // Library /:id route returns the preset shape, not the history shape
    // Check the history route returns the history shape:
    const h = await request(app)
      .get(`/v1/scenarios/library/custom/${id}/history`)
      .set(TH_BIL);
    expect(h.body.body).toHaveProperty('items');
    expect(h.body.body).toHaveProperty('preset_id');
  });
});

// ─── M16.7 — Preset edit (PUT) ───────────────────────────────────────

describe('M16.7 — preset edit', () => {
  test('PUT replaces mutable fields and preserves id', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const r = await request(app)
      .put(`/v1/scenarios/library/custom/${id}`)
      .set(TH_BIL)
      .send({ ...VALID, name: 'Updated name', shocks: { gdp: -2, rate: 100, fx: 5 } });
    expect(r.status).toBe(200);
    expect(r.body.body.id).toBe(id);
    expect(r.body.body.name).toBe('Updated name');
    expect(r.body.body.shocks.gdp).toBe(-2);
  });

  test('PUT writes scenario.update audit event', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    await request(app)
      .put(`/v1/scenarios/library/custom/${id}`)
      .set(TH_BIL)
      .set('X-APEX-USER', 'compliance.lead')
      .send({ ...VALID, name: 'Renamed' });
    const h = await request(app)
      .get(`/v1/scenarios/library/custom/${id}/history`)
      .set(TH_BIL);
    const update = h.body.body.items.find(
      (x: { action: string }) => x.action === 'scenario.update',
    );
    expect(update).toBeDefined();
    expect(update.actor_username).toBe('compliance.lead');
    expect(update.metadata.previous_name).toBe(VALID.name);
    expect(update.metadata.new_name).toBe('Renamed');
  });

  test('PUT on unknown preset → 404', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .put('/v1/scenarios/library/custom/custom_no_such')
      .set(TH_BIL)
      .send(VALID);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });

  test('PUT validation: bad gdp → 400', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const r = await request(app)
      .put(`/v1/scenarios/library/custom/${id}`)
      .set(TH_BIL)
      .send({ ...VALID, shocks: { gdp: 999, rate: 0, fx: 0 } });
    expect(r.status).toBe(400);
  });

  test('cross-tenant: BIL caller cannot PUT BANK_DEMO\'s preset', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const r = await request(app)
      .put(`/v1/scenarios/library/custom/${id}`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .send(VALID);
    expect(r.status).toBe(404);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCustomApp('case_owner');
    const r = await request(app)
      .put('/v1/scenarios/library/custom/anything')
      .set(TH_BIL)
      .send(VALID);
    expect(r.status).toBe(403);
  });
});

// ─── M16.8 — Clone library preset into custom ────────────────────────

describe('POST /v1/scenarios/library/custom/clone-from-library', () => {
  test('happy: 201 with custom copy of library preset', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/clone-from-library')
      .set(TH_BIL)
      .send({ source_preset_id: 'preset_rbi_severely_adverse' });
    expect(r.status).toBe(201);
    expect(r.body.body.id).toMatch(/^custom_/);
    expect(r.body.body.name).toBe('Copy of RBI Severely Adverse');
    expect(r.body.body.shocks).toEqual({ gdp: -4, rate: 300, fx: 12 });
  });

  test('caller can override name', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/clone-from-library')
      .set(TH_BIL)
      .send({
        source_preset_id: 'preset_rbi_baseline_stress',
        name: 'BIL Q3 Stress Run',
      });
    expect(r.body.body.name).toBe('BIL Q3 Stress Run');
  });

  test('source_doc carries cloned-from + creator', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/clone-from-library')
      .set(TH_BIL)
      .set('X-APEX-USER', 'compliance.lead')
      .send({ source_preset_id: 'preset_rbi_baseline_stress' });
    expect(r.body.body.source_doc).toContain('preset_rbi_baseline_stress');
    expect(r.body.body.source_doc).toContain('compliance.lead');
  });

  test('writes scenario.create audit with cloned_from metadata', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app)
      .post('/v1/scenarios/library/custom/clone-from-library')
      .set(TH_BIL)
      .send({ source_preset_id: 'preset_rbi_severely_adverse' });
    const id = c.body.body.id;
    const h = await request(app)
      .get(`/v1/scenarios/library/custom/${id}/history`)
      .set(TH_BIL);
    expect(h.body.body.items[0].action).toBe('scenario.create');
    expect(h.body.body.items[0].metadata.cloned_from).toBe('preset_rbi_severely_adverse');
  });

  test('clone is independently editable (PUT works on it)', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app)
      .post('/v1/scenarios/library/custom/clone-from-library')
      .set(TH_BIL)
      .send({ source_preset_id: 'preset_rbi_baseline_stress' });
    const id = c.body.body.id;
    const u = await request(app)
      .put(`/v1/scenarios/library/custom/${id}`)
      .set(TH_BIL)
      .send({
        name: 'Edited clone',
        description: 'Tweaked',
        category: 'business',
        regulator: 'INTERNAL',
        severity: 'mild',
        shocks: { gdp: -0.5, rate: 25, fx: 1 },
      });
    expect(u.status).toBe(200);
    expect(u.body.body.name).toBe('Edited clone');
  });

  test('missing source_preset_id → 400', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/clone-from-library')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
  });

  test('unknown source preset → 404', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/clone-from-library')
      .set(TH_BIL)
      .send({ source_preset_id: 'NO-SUCH' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCustomApp('case_owner');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/clone-from-library')
      .set(TH_BIL)
      .send({ source_preset_id: 'preset_rbi_baseline_stress' });
    expect(r.status).toBe(403);
  });

  test('PUT /:preset_id still works (literal clone-from-library didn\'t shadow)', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const u = await request(app)
      .put(`/v1/scenarios/library/custom/${id}`)
      .set(TH_BIL)
      .send({ ...VALID, name: 'Still works' });
    expect(u.status).toBe(200);
    expect(u.body.body.name).toBe('Still works');
  });
});

// ─── M16.9 — Bulk-clone library presets ──────────────────────────────

describe('POST /v1/scenarios/library/custom/bulk-clone-from-library', () => {
  test('happy: 200 with created[] for valid ids', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .send({
        preset_ids: ['preset_rbi_baseline_stress', 'preset_rbi_severely_adverse'],
      });
    expect(r.status).toBe(200);
    expect(r.body.body.requested_count).toBe(2);
    expect(r.body.body.created_count).toBe(2);
    expect(r.body.body.skipped_count).toBe(0);
    expect(r.body.body.created[0].source_preset_id).toBe('preset_rbi_baseline_stress');
  });

  test('name_prefix applied to clone names', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .send({
        preset_ids: ['preset_rbi_baseline_stress'],
        name_prefix: 'BIL-Q3-',
      });
    expect(r.body.body.created[0].name).toMatch(/^BIL-Q3-/);
  });

  test('mixed valid + unknown: created[] + skipped[]', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .send({
        preset_ids: ['preset_rbi_baseline_stress', 'NO-SUCH', 'preset_rbi_severely_adverse'],
      });
    expect(r.status).toBe(200);
    expect(r.body.body.created_count).toBe(2);
    expect(r.body.body.skipped_count).toBe(1);
    expect(r.body.body.skipped[0].reason).toBe('unknown_source');
    expect(r.body.body.skipped[0].source_preset_id).toBe('NO-SUCH');
  });

  test('writes scenario.create audit per successful clone', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .send({ preset_ids: ['preset_rbi_baseline_stress'] });
    const newId = r.body.body.created[0].preset_id;
    const h = await request(app)
      .get(`/v1/scenarios/library/custom/${newId}/history`)
      .set(TH_BIL);
    expect(h.body.body.items[0].action).toBe('scenario.create');
    expect(h.body.body.items[0].metadata.bulk).toBe(true);
    expect(h.body.body.items[0].metadata.cloned_from).toBe('preset_rbi_baseline_stress');
  });

  test('empty preset_ids[] → 400', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .send({ preset_ids: [] });
    expect(r.status).toBe(400);
  });

  test('> 10 preset_ids → 400', async () => {
    const { app } = makeCustomApp('admin');
    const ids = new Array(11).fill('preset_rbi_baseline_stress');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .send({ preset_ids: ids });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-string id reported as skipped', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .send({ preset_ids: ['preset_rbi_baseline_stress', 42] });
    expect(r.status).toBe(200);
    expect(r.body.body.skipped_count).toBe(1);
    expect(r.body.body.skipped[0].reason).toBe('invalid_id');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCustomApp('case_owner');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/bulk-clone-from-library')
      .set(TH_BIL)
      .send({ preset_ids: ['preset_rbi_baseline_stress'] });
    expect(r.status).toBe(403);
  });

  test('M16.8 single-clone still works (literal bulk- didn\'t shadow)', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/clone-from-library')
      .set(TH_BIL)
      .send({ source_preset_id: 'preset_rbi_baseline_stress' });
    expect(r.status).toBe(201);
  });
});

// ─── M16.10 — Preset versioning + restore ────────────────────────────

describe('M16.10 — version snapshots (store)', () => {
  test('create captures v1', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    const versions = s.listVersions('BIL', p.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
    expect(versions[0]!.captured_by).toBe('admin');
    expect(versions[0]!.snapshot.name).toBe(VALID.name);
  });

  test('update appends a new version with post-state snapshot', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    s.update('BIL', p.id, { ...VALID, name: 'Renamed' }, 'lead', NOW);
    const versions = s.listVersions('BIL', p.id);
    expect(versions).toHaveLength(2);
    expect(versions[0]!.snapshot.name).toBe(VALID.name);
    expect(versions[1]!.snapshot.name).toBe('Renamed');
    expect(versions[1]!.captured_by).toBe('lead');
  });

  test('restoreVersion applies prior snapshot and pushes a new history entry', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    s.update('BIL', p.id, { ...VALID, name: 'Renamed' }, 'lead', NOW);
    const out = s.restoreVersion('BIL', p.id, 1, 'admin', NOW);
    expect(out.restored_from_version).toBe(1);
    expect(out.preset.name).toBe(VALID.name);
    // Live state reflects the restore
    expect(s.get('BIL', p.id)?.name).toBe(VALID.name);
    // History grew by one (v1 + Renamed + restored = 3)
    expect(s.listVersions('BIL', p.id)).toHaveLength(3);
  });

  test('restoreVersion preserves immutable id', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    s.update('BIL', p.id, { ...VALID, name: 'v2' }, 'admin', NOW);
    const out = s.restoreVersion('BIL', p.id, 1, 'admin', NOW);
    expect(out.preset.id).toBe(p.id);
  });

  test('restoreVersion: unknown_preset', () => {
    const s = new InMemoryCustomPresetStore();
    expect(() => s.restoreVersion('BIL', 'custom_nope', 1, 'admin', NOW)).toThrow(
      /not found/,
    );
  });

  test('restoreVersion: unknown_version', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    try {
      s.restoreVersion('BIL', p.id, 99, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as CustomPresetError).code).toBe('unknown_version');
    }
  });

  test('restoreVersion: invalid version arg', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    expect(() => s.restoreVersion('BIL', p.id, 0, 'admin', NOW)).toThrow(/version/);
    expect(() => s.restoreVersion('BIL', p.id, -1, 'admin', NOW)).toThrow(/version/);
    expect(() => s.restoreVersion('BIL', p.id, 1.5, 'admin', NOW)).toThrow(/version/);
  });

  test('restoreVersion: empty restored_by rejected', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    expect(() => s.restoreVersion('BIL', p.id, 1, '   ', NOW)).toThrow(/restored_by/);
  });

  test('cross-tenant: BANK_DEMO cannot see BIL versions', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    expect(s.listVersions('BANK_DEMO', p.id)).toEqual([]);
    expect(() => s.restoreVersion('BANK_DEMO', p.id, 1, 'admin', NOW)).toThrow(
      /not found/,
    );
  });

  test('20-version cap evicts oldest snapshots', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW); // v1
    // 22 updates → 23 total snapshots, capped at 20
    for (let i = 2; i <= 23; i++) {
      s.update('BIL', p.id, { ...VALID, name: `v${i}` }, 'admin', NOW);
    }
    const versions = s.listVersions('BIL', p.id);
    expect(versions).toHaveLength(20);
    // Oldest preserved should be v4 (1,2,3 evicted)
    expect(versions[0]!.version).toBe(4);
    expect(versions[versions.length - 1]!.version).toBe(23);
  });

  test('after eviction, restore of evicted version raises unknown_version', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    for (let i = 2; i <= 23; i++) {
      s.update('BIL', p.id, { ...VALID, name: `v${i}` }, 'admin', NOW);
    }
    try {
      s.restoreVersion('BIL', p.id, 1, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as CustomPresetError).code).toBe('unknown_version');
    }
  });
});

describe('M16.10 — versioning routes', () => {
  test('GET /versions returns v1 after create', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const v = await request(app)
      .get(`/v1/scenarios/library/custom/${id}/versions`)
      .set(TH_BIL);
    expect(v.status).toBe(200);
    expect(v.body.body.total).toBe(1);
    expect(v.body.body.preset_id).toBe(id);
    expect(v.body.body.items[0].version).toBe(1);
    expect(v.body.body.items[0].snapshot.name).toBe(VALID.name);
  });

  test('GET /versions grows after PUT', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    await request(app)
      .put(`/v1/scenarios/library/custom/${id}`)
      .set(TH_BIL)
      .send({ ...VALID, name: 'Renamed' });
    const v = await request(app)
      .get(`/v1/scenarios/library/custom/${id}/versions`)
      .set(TH_BIL);
    expect(v.body.body.total).toBe(2);
    expect(v.body.body.items[1].snapshot.name).toBe('Renamed');
  });

  test('GET /versions on unknown preset → 404', async () => {
    const { app } = makeCustomApp('admin');
    const v = await request(app)
      .get('/v1/scenarios/library/custom/custom_no_such/versions')
      .set(TH_BIL);
    expect(v.status).toBe(404);
    expect(v.body.error.code).toBe('EWS_404_unknown_preset');
  });

  test('POST /restore/:version rolls live state back', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    await request(app)
      .put(`/v1/scenarios/library/custom/${id}`)
      .set(TH_BIL)
      .send({ ...VALID, name: 'Renamed' });
    const r = await request(app)
      .post(`/v1/scenarios/library/custom/${id}/restore/1`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.restored_from_version).toBe(1);
    expect(r.body.body.preset.name).toBe(VALID.name);
    // Live state confirms via list
    const list = await request(app)
      .get('/v1/scenarios/library/custom')
      .set(TH_BIL);
    const live = list.body.body.items.find((x: { id: string }) => x.id === id);
    expect(live.name).toBe(VALID.name);
  });

  test('POST /restore writes scenario.update audit with restored_from_version', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    await request(app)
      .put(`/v1/scenarios/library/custom/${id}`)
      .set(TH_BIL)
      .send({ ...VALID, name: 'Renamed' });
    await request(app)
      .post(`/v1/scenarios/library/custom/${id}/restore/1`)
      .set(TH_BIL)
      .set('X-APEX-USER', 'compliance.lead');
    const h = await request(app)
      .get(`/v1/scenarios/library/custom/${id}/history`)
      .set(TH_BIL);
    const restoreEvent = h.body.body.items.find(
      (x: { metadata: { restored_from_version?: number } }) =>
        x.metadata.restored_from_version === 1,
    );
    expect(restoreEvent).toBeDefined();
    expect(restoreEvent.action).toBe('scenario.update');
    expect(restoreEvent.actor_username).toBe('compliance.lead');
    expect(restoreEvent.metadata.previous_name).toBe('Renamed');
    expect(restoreEvent.metadata.new_name).toBe(VALID.name);
  });

  test('POST /restore on unknown preset → 404', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/custom_no_such/restore/1')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });

  test('POST /restore on unknown version → 404', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const r = await request(app)
      .post(`/v1/scenarios/library/custom/${id}/restore/99`)
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_version');
  });

  test('POST /restore with non-numeric version → 400', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const r = await request(app)
      .post(`/v1/scenarios/library/custom/${id}/restore/abc`)
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('cross-tenant: BANK_DEMO cannot see BIL preset versions', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const v = await request(app)
      .get(`/v1/scenarios/library/custom/${id}/versions`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(v.status).toBe(404);
    const r = await request(app)
      .post(`/v1/scenarios/library/custom/${id}/restore/1`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(404);
  });

  test('non-allowed role → 403 on /versions', async () => {
    const { app } = makeCustomApp('case_owner');
    const v = await request(app)
      .get('/v1/scenarios/library/custom/custom_anything/versions')
      .set(TH_BIL);
    expect(v.status).toBe(403);
  });

  test('non-allowed role → 403 on /restore', async () => {
    const { app } = makeCustomApp('case_owner');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/custom_anything/restore/1')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M16.7 PUT no-regression: literal /versions and /restore did not shadow PUT :preset_id', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const r = await request(app)
      .put(`/v1/scenarios/library/custom/${id}`)
      .set(TH_BIL)
      .send({ ...VALID, name: 'still works' });
    expect(r.status).toBe(200);
    expect(r.body.body.name).toBe('still works');
  });
});

// ─── M16.11 — Version diff ───────────────────────────────────────────

describe('diffPresetVersions (M16.11 pure helper)', () => {
  test('identical snapshots → empty diff', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    expect(diffPresetVersions(p, p)).toEqual([]);
  });

  test('renamed preset → one changed entry on `name`', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    const updated = s.update('BIL', p.id, { ...VALID, name: 'Renamed' }, 'lead', NOW);
    const d = diffPresetVersions(p, updated);
    expect(d).toHaveLength(1);
    expect(d[0]!.field).toBe('name');
    expect(d[0]!.kind).toBe('changed');
    expect(d[0]!.before).toBe(VALID.name);
    expect(d[0]!.after).toBe('Renamed');
  });

  test('shocks change reported on the shocks field with object before/after', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    const updated = s.update(
      'BIL',
      p.id,
      { ...VALID, shocks: { gdp: -3, rate: 200, fx: 8 } },
      'lead',
      NOW,
    );
    const d = diffPresetVersions(p, updated);
    expect(d).toHaveLength(1);
    expect(d[0]!.field).toBe('shocks');
    expect(d[0]!.kind).toBe('changed');
    expect(d[0]!.before).toEqual({ gdp: -1.5, rate: 75, fx: 4 });
    expect(d[0]!.after).toEqual({ gdp: -3, rate: 200, fx: 8 });
  });

  test('multiple field changes → one entry per field', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    const updated = s.update(
      'BIL',
      p.id,
      { ...VALID, name: 'X', severity: 'severe', shocks: { gdp: -5, rate: 0, fx: 0 } },
      'lead',
      NOW,
    );
    const d = diffPresetVersions(p, updated);
    const fields = d.map((e) => e.field).sort();
    expect(fields).toEqual(['name', 'severity', 'shocks']);
    for (const e of d) expect(e.kind).toBe('changed');
  });

  test('id is NOT included in the diff (immutable across versions)', () => {
    const s = new InMemoryCustomPresetStore();
    const p1 = s.create('BIL', VALID, 'admin', NOW);
    // Forge a snapshot with a different id and confirm it's ignored.
    const forged = { ...p1, id: 'custom_other' };
    const d = diffPresetVersions(p1, forged);
    expect(d).toEqual([]);
  });

  test('shock equality compares deep — same object yields no entry', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    const same = { ...p, shocks: { ...p.shocks } };
    expect(diffPresetVersions(p, same)).toEqual([]);
  });
});

describe('diffPresetVersionsByNumber (M16.11 pure helper)', () => {
  test('happy: from=1, to=2 returns the rename diff', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    s.update('BIL', p.id, { ...VALID, name: 'Renamed' }, 'lead', NOW);
    const out = diffPresetVersionsByNumber(s, 'BIL', p.id, 1, 2);
    expect(out.preset_id).toBe(p.id);
    expect(out.from_version).toBe(1);
    expect(out.to_version).toBe(2);
    expect(out.change_count).toBe(1);
    expect(out.identical_versions).toBe(false);
    expect(out.diff[0]!.field).toBe('name');
  });

  test('from === to short-circuits to empty diff with identical_versions=true', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    const out = diffPresetVersionsByNumber(s, 'BIL', p.id, 1, 1);
    expect(out.diff).toEqual([]);
    expect(out.change_count).toBe(0);
    expect(out.identical_versions).toBe(true);
  });

  test('reverse direction: from=2, to=1 reports the inverse diff', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    s.update('BIL', p.id, { ...VALID, name: 'Renamed' }, 'lead', NOW);
    const out = diffPresetVersionsByNumber(s, 'BIL', p.id, 2, 1);
    expect(out.diff[0]!.before).toBe('Renamed');
    expect(out.diff[0]!.after).toBe(VALID.name);
  });

  test('unknown_version → CustomPresetError', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    try {
      diffPresetVersionsByNumber(s, 'BIL', p.id, 1, 99);
      fail('expected throw');
    } catch (e) {
      expect((e as CustomPresetError).code).toBe('unknown_version');
    }
  });

  test('invalid_input on non-positive version', () => {
    const s = new InMemoryCustomPresetStore();
    const p = s.create('BIL', VALID, 'admin', NOW);
    expect(() => diffPresetVersionsByNumber(s, 'BIL', p.id, 0, 1)).toThrow(
      /positive integer/,
    );
    expect(() => diffPresetVersionsByNumber(s, 'BIL', p.id, 1, -1)).toThrow(
      /positive integer/,
    );
  });
});

describe('GET /v1/scenarios/library/custom/:preset_id/versions/diff (M16.11 route)', () => {
  test('200 with diff body when both versions exist', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    await request(app)
      .put(`/v1/scenarios/library/custom/${id}`)
      .set(TH_BIL)
      .send({ ...VALID, name: 'Renamed' });
    const r = await request(app)
      .get(`/v1/scenarios/library/custom/${id}/versions/diff?from=1&to=2`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.preset_id).toBe(id);
    expect(r.body.body.change_count).toBe(1);
    expect(r.body.body.diff[0].field).toBe('name');
    expect(r.body.body.identical_versions).toBe(false);
  });

  test('200 with empty diff when from === to', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const r = await request(app)
      .get(`/v1/scenarios/library/custom/${id}/versions/diff?from=1&to=1`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.diff).toEqual([]);
    expect(r.body.body.identical_versions).toBe(true);
  });

  test('404 when preset is unknown', async () => {
    const { app } = makeCustomApp('admin');
    const r = await request(app)
      .get('/v1/scenarios/library/custom/custom_nope/versions/diff?from=1&to=2')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });

  test('404 when version is unknown', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const r = await request(app)
      .get(`/v1/scenarios/library/custom/${id}/versions/diff?from=1&to=99`)
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_version');
  });

  test('400 when from is missing', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const r = await request(app)
      .get(`/v1/scenarios/library/custom/${id}/versions/diff?to=2`)
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('400 when from is not numeric', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const r = await request(app)
      .get(`/v1/scenarios/library/custom/${id}/versions/diff?from=abc&to=2`)
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCustomApp('case_owner');
    const r = await request(app)
      .get('/v1/scenarios/library/custom/custom_x/versions/diff?from=1&to=2')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M16.10 GET /versions still works alongside the new /diff route', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const r = await request(app)
      .get(`/v1/scenarios/library/custom/${id}/versions`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.items.length).toBe(1);
  });

  test('M16.10 POST /restore/:version still works alongside /diff', async () => {
    const { app } = makeCustomApp('admin');
    const c = await request(app).post('/v1/scenarios/library/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    await request(app)
      .put(`/v1/scenarios/library/custom/${id}`)
      .set(TH_BIL)
      .send({ ...VALID, name: 'v2' });
    const r = await request(app)
      .post(`/v1/scenarios/library/custom/${id}/restore/1`)
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.body.preset.name).toBe(VALID.name);
  });
});
