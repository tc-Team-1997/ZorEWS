// services/bff/__tests__/scenario_custom.test.ts
//
// T6 M16.4 — Custom user-defined scenario presets.

import request from 'supertest';
import {
  CustomPresetError,
  InMemoryCustomPresetStore,
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
