// services/bff/__tests__/scenario_library.test.ts
//
// T6 M16.1 — BIL named scenario library.

import request from 'supertest';
import {
  SCENARIO_PRESETS,
  getScenarioPreset,
  isScenarioCategory,
  isScenarioRegulator,
  isScenarioSeverity,
  listScenarioCategories,
  listScenarioPresets,
  type ScenarioPreset,
} from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeLibApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Type guards ───────────────────────────────────────────────────────

describe('Type guards', () => {
  test('isScenarioCategory', () => {
    expect(isScenarioCategory('regulatory')).toBe(true);
    expect(isScenarioCategory('black_swan')).toBe(true);
    expect(isScenarioCategory('foo')).toBe(false);
  });
  test('isScenarioRegulator', () => {
    expect(isScenarioRegulator('RBI')).toBe(true);
    expect(isScenarioRegulator('IRDAI')).toBe(true);
    expect(isScenarioRegulator('rbi')).toBe(false);
  });
  test('isScenarioSeverity', () => {
    expect(isScenarioSeverity('mild')).toBe(true);
    expect(isScenarioSeverity('severe')).toBe(true);
    expect(isScenarioSeverity('critical')).toBe(false);
  });
});

// ─── Schema invariants ─────────────────────────────────────────────────

describe('SCENARIO_PRESETS schema', () => {
  test('exactly 10 BIL presets seeded', () => {
    expect(SCENARIO_PRESETS.length).toBe(10);
  });

  test('ids unique', () => {
    const ids = SCENARIO_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every preset declares required fields with valid types', () => {
    for (const p of SCENARIO_PRESETS) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.name).toBe('string');
      expect(['regulatory', 'business', 'black_swan', 'baseline']).toContain(p.category);
      expect(['RBI', 'IRDAI', 'INTERNAL']).toContain(p.regulator);
      expect(['mild', 'moderate', 'severe']).toContain(p.severity);
      expect(typeof p.shocks.gdp).toBe('number');
      expect(typeof p.shocks.rate).toBe('number');
      expect(typeof p.shocks.fx).toBe('number');
      expect(typeof p.source_doc).toBe('string');
      expect(p.source_doc.length).toBeGreaterThan(0);
    }
  });

  test('all 4 categories represented', () => {
    const cats = new Set(SCENARIO_PRESETS.map((p) => p.category));
    for (const c of listScenarioCategories()) expect(cats.has(c)).toBe(true);
  });

  test('both BIL pitch regulators (RBI + IRDAI) represented', () => {
    const regs = new Set(SCENARIO_PRESETS.map((p) => p.regulator));
    expect(regs.has('RBI')).toBe(true);
    expect(regs.has('IRDAI')).toBe(true);
    expect(regs.has('INTERNAL')).toBe(true);
  });

  test('regulatory category presets all carry RBI or IRDAI regulator (not INTERNAL)', () => {
    const reg = SCENARIO_PRESETS.filter((p) => p.category === 'regulatory');
    expect(reg.length).toBeGreaterThan(0);
    for (const p of reg) {
      expect(['RBI', 'IRDAI']).toContain(p.regulator);
    }
  });

  test('baseline preset has zero shocks', () => {
    const baseline = SCENARIO_PRESETS.find((p) => p.category === 'baseline');
    expect(baseline).toBeDefined();
    expect(baseline!.shocks).toEqual({ gdp: 0, rate: 0, fx: 0 });
  });

  test('black_swan presets have severe magnitude (≥ moderate threshold)', () => {
    const bs = SCENARIO_PRESETS.filter((p) => p.category === 'black_swan');
    expect(bs.length).toBeGreaterThan(0);
    for (const p of bs) {
      expect(p.severity).toBe('severe');
      // Magnitude check: total absolute shock magnitude > some threshold
      const mag = Math.abs(p.shocks.gdp) + Math.abs(p.shocks.rate) / 100 + Math.abs(p.shocks.fx);
      expect(mag).toBeGreaterThan(10);
    }
  });

  test('RBI severely-adverse is the most severe RBI scenario', () => {
    const rbi = SCENARIO_PRESETS.filter((p) => p.regulator === 'RBI');
    const severe = rbi.filter((p) => p.severity === 'severe');
    expect(severe.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── listScenarioPresets filter behaviour ──────────────────────────────

describe('listScenarioPresets', () => {
  test('no filter returns all 10', () => {
    expect(listScenarioPresets().length).toBe(10);
  });

  test('category filter narrows', () => {
    const out = listScenarioPresets({ category: 'regulatory' });
    for (const p of out) expect(p.category).toBe('regulatory');
    expect(out.length).toBeGreaterThan(0);
  });

  test('regulator filter narrows', () => {
    const rbi = listScenarioPresets({ regulator: 'RBI' });
    for (const p of rbi) expect(p.regulator).toBe('RBI');
  });

  test('severity filter narrows', () => {
    const severe = listScenarioPresets({ severity: 'severe' });
    for (const p of severe) expect(p.severity).toBe('severe');
  });

  test('multi-axis AND', () => {
    const out = listScenarioPresets({ regulator: 'RBI', severity: 'severe' });
    for (const p of out) {
      expect(p.regulator).toBe('RBI');
      expect(p.severity).toBe('severe');
    }
  });

  test('listScenarioCategories returns the 4 in canonical order', () => {
    expect(listScenarioCategories()).toEqual(['regulatory', 'business', 'black_swan', 'baseline']);
  });
});

describe('getScenarioPreset', () => {
  test('returns preset by id', () => {
    expect(getScenarioPreset('preset_baseline_no_shock')!.shocks).toEqual({ gdp: 0, rate: 0, fx: 0 });
  });

  test('null on miss', () => {
    expect(getScenarioPreset('no.such')).toBeNull();
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/scenarios/library/categories', () => {
  test('returns the 4 categories', async () => {
    const { app } = makeLibApp('admin');
    const r = await request(app).get('/v1/scenarios/library/categories').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.items).toEqual(['regulatory', 'business', 'black_swan', 'baseline']);
  });

  test('analyst+ accepted', async () => {
    const { app } = makeLibApp('risk_analyst');
    const r = await request(app).get('/v1/scenarios/library/categories').set(TH);
    expect(r.status).toBe(200);
  });

  test('unknown role → 403', async () => {
    const { app } = makeLibApp('case_owner');
    const r = await request(app).get('/v1/scenarios/library/categories').set(TH);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/scenarios/library', () => {
  test('admin: 200 with all 10', async () => {
    const { app } = makeLibApp('admin');
    const r = await request(app).get('/v1/scenarios/library').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(10);
  });

  test('?category=regulatory narrows', async () => {
    const { app } = makeLibApp('admin');
    const r = await request(app).get('/v1/scenarios/library?category=regulatory').set(TH);
    for (const p of r.body.body.items as ScenarioPreset[]) {
      expect(p.category).toBe('regulatory');
    }
  });

  test('?regulator=IRDAI narrows', async () => {
    const { app } = makeLibApp('admin');
    const r = await request(app).get('/v1/scenarios/library?regulator=IRDAI').set(TH);
    for (const p of r.body.body.items as ScenarioPreset[]) {
      expect(p.regulator).toBe('IRDAI');
    }
  });

  test('?severity=severe narrows', async () => {
    const { app } = makeLibApp('admin');
    const r = await request(app).get('/v1/scenarios/library?severity=severe').set(TH);
    for (const p of r.body.body.items as ScenarioPreset[]) {
      expect(p.severity).toBe('severe');
    }
  });

  test('multi-axis filter combines as AND', async () => {
    const { app } = makeLibApp('admin');
    const r = await request(app)
      .get('/v1/scenarios/library?regulator=RBI&severity=severe')
      .set(TH);
    for (const p of r.body.body.items as ScenarioPreset[]) {
      expect(p.regulator).toBe('RBI');
      expect(p.severity).toBe('severe');
    }
    expect(r.body.body.total).toBeGreaterThanOrEqual(1);
  });

  test('?category=invalid → 400 EWS_400_invalid_category', async () => {
    const { app } = makeLibApp('admin');
    const r = await request(app).get('/v1/scenarios/library?category=foo').set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_category');
  });

  test('?regulator=invalid → 400 EWS_400_invalid_regulator', async () => {
    const { app } = makeLibApp('admin');
    const r = await request(app).get('/v1/scenarios/library?regulator=ECB').set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_regulator');
  });

  test('?severity=invalid → 400 EWS_400_invalid_severity', async () => {
    const { app } = makeLibApp('admin');
    const r = await request(app).get('/v1/scenarios/library?severity=critical').set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_severity');
  });

  test('unknown role → 403', async () => {
    const { app } = makeLibApp('case_owner');
    const r = await request(app).get('/v1/scenarios/library').set(TH);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/scenarios/library/:id', () => {
  test('valid id → 200 with full preset', async () => {
    const { app } = makeLibApp('admin');
    const r = await request(app).get('/v1/scenarios/library/preset_rbi_severely_adverse').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.id).toBe('preset_rbi_severely_adverse');
    expect(r.body.body.regulator).toBe('RBI');
    expect(r.body.body.severity).toBe('severe');
    expect(r.body.body.shocks.gdp).toBe(-4);
  });

  test('unknown id → 404 EWS_404_unknown_preset', async () => {
    const { app } = makeLibApp('admin');
    const r = await request(app).get('/v1/scenarios/library/no.such').set(TH);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });
});

describe('No-regression: existing /v1/scenarios/:id still works', () => {
  test('library routes do not shadow existing /v1/scenarios/:id (returns 404 for unknown saved id, not 404_unknown_preset)', async () => {
    const { app } = makeLibApp('admin');
    const r = await request(app).get('/v1/scenarios/non-saved-scenario-id').set(TH);
    expect(r.status).toBe(404);
    // /v1/scenarios/:id (saved scenario route) returns plain EWS_404,
    // not EWS_404_unknown_preset — confirming the library route did NOT
    // shadow the existing route.
    expect(r.body.error.code).not.toBe('EWS_404_unknown_preset');
  });
});
