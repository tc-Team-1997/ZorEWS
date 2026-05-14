// services/bff/__tests__/scenario_shock_vectors.test.ts
//
// T6 M16.15 — Scenario shock-vector radar transform.

import request from 'supertest';
import { normaliseScenarioShockVectors } from '../src/scenario_shock_vectors';
import {
  listScenarioPresets,
  type ScenarioPreset,
} from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkPreset(o: Partial<ScenarioPreset> & { id: string; shocks: ScenarioPreset['shocks'] }): ScenarioPreset {
  return {
    id: o.id,
    name: o.name ?? `Preset ${o.id}`,
    description: o.description ?? 'desc',
    category: o.category ?? 'business',
    regulator: o.regulator ?? 'INTERNAL',
    severity: o.severity ?? 'moderate',
    source_doc: o.source_doc ?? '',
    shocks: o.shocks,
  };
}

// ─── normaliseScenarioShockVectors — pure ────────────────────────────

describe('M16.15 — empty input', () => {
  test('zero presets → zero envelope + zero ranges', () => {
    const r = normaliseScenarioShockVectors([]);
    expect(r.total_presets).toBe(0);
    expect(r.vectors).toEqual([]);
    expect(r.ranges.gdp).toEqual({ min: 0, max: 0 });
  });
});

describe('M16.15 — single preset', () => {
  test('single preset → all axes normalized to 0 (no variation)', () => {
    const p = mkPreset({ id: 'a', shocks: { gdp: -2, rate: 150, fx: 5 } });
    const r = normaliseScenarioShockVectors([p]);
    expect(r.total_presets).toBe(1);
    expect(r.ranges.gdp.min).toBe(-2);
    expect(r.ranges.gdp.max).toBe(-2);
    expect(r.vectors[0]!.normalized).toEqual({ gdp: 0, rate: 0, fx: 0 });
  });
});

describe('M16.15 — three presets normalise to [-1, 1]', () => {
  test('min → -1, max → +1, middle → 0', () => {
    const presets = [
      mkPreset({ id: 'a', shocks: { gdp: -4, rate: 0, fx: 0 } }),    // gdp min, rate min, fx min
      mkPreset({ id: 'b', shocks: { gdp: 0, rate: 150, fx: 6 } }),    // mid
      mkPreset({ id: 'c', shocks: { gdp: 4, rate: 300, fx: 12 } }),  // max
    ];
    const r = normaliseScenarioShockVectors(presets);
    const va = r.vectors.find((v) => v.preset_id === 'a')!;
    const vb = r.vectors.find((v) => v.preset_id === 'b')!;
    const vc = r.vectors.find((v) => v.preset_id === 'c')!;
    expect(va.normalized.gdp).toBe(-1);
    expect(va.normalized.rate).toBe(-1);
    expect(va.normalized.fx).toBe(-1);
    expect(vc.normalized.gdp).toBe(1);
    expect(vc.normalized.rate).toBe(1);
    expect(vc.normalized.fx).toBe(1);
    expect(vb.normalized.gdp).toBe(0);
    expect(vb.normalized.rate).toBe(0);
    expect(vb.normalized.fx).toBe(0);
  });
});

describe('M16.15 — monotonicity preserved', () => {
  test('larger raw → larger normalized', () => {
    const presets = [
      mkPreset({ id: 'a', shocks: { gdp: -4, rate: 0, fx: 0 } }),
      mkPreset({ id: 'b', shocks: { gdp: -2, rate: 100, fx: 4 } }),
      mkPreset({ id: 'c', shocks: { gdp: 0, rate: 200, fx: 8 } }),
      mkPreset({ id: 'd', shocks: { gdp: 4, rate: 400, fx: 16 } }),
    ];
    const r = normaliseScenarioShockVectors(presets);
    const ordered = r.vectors.sort((x, y) => x.raw.gdp - y.raw.gdp);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i]!.normalized.gdp).toBeGreaterThanOrEqual(ordered[i - 1]!.normalized.gdp);
    }
  });
});

describe('M16.15 — constant axis', () => {
  test('every preset has the same gdp value → gdp normalized to 0 across the board', () => {
    const presets = [
      mkPreset({ id: 'a', shocks: { gdp: -2, rate: 100, fx: 0 } }),
      mkPreset({ id: 'b', shocks: { gdp: -2, rate: 200, fx: 5 } }),
      mkPreset({ id: 'c', shocks: { gdp: -2, rate: 300, fx: 10 } }),
    ];
    const r = normaliseScenarioShockVectors(presets);
    for (const v of r.vectors) {
      expect(v.normalized.gdp).toBe(0);
    }
    // rate + fx still vary
    expect(r.vectors.find((v) => v.preset_id === 'a')!.normalized.rate).toBe(-1);
    expect(r.vectors.find((v) => v.preset_id === 'c')!.normalized.rate).toBe(1);
  });
});

describe('M16.15 — sort order', () => {
  test('vectors sorted by preset_id asc', () => {
    const presets = [
      mkPreset({ id: 'c_late', shocks: { gdp: 0, rate: 0, fx: 0 } }),
      mkPreset({ id: 'a_early', shocks: { gdp: -1, rate: 50, fx: 1 } }),
      mkPreset({ id: 'b_mid', shocks: { gdp: -2, rate: 100, fx: 2 } }),
    ];
    const r = normaliseScenarioShockVectors(presets);
    expect(r.vectors.map((v) => v.preset_id)).toEqual(['a_early', 'b_mid', 'c_late']);
  });
});

describe('M16.15 — default registry integration', () => {
  test('called with no args → uses real M16.1 library', () => {
    const r = normaliseScenarioShockVectors();
    expect(r.total_presets).toBe(listScenarioPresets().length);
    // Every preset gets a vector
    expect(r.vectors).toHaveLength(r.total_presets);
    // Every normalised value is in [-1, 1] inclusive
    for (const v of r.vectors) {
      expect(v.normalized.gdp).toBeGreaterThanOrEqual(-1);
      expect(v.normalized.gdp).toBeLessThanOrEqual(1);
      expect(v.normalized.rate).toBeGreaterThanOrEqual(-1);
      expect(v.normalized.rate).toBeLessThanOrEqual(1);
      expect(v.normalized.fx).toBeGreaterThanOrEqual(-1);
      expect(v.normalized.fx).toBeLessThanOrEqual(1);
    }
  });
});

// ─── GET /v1/scenarios/library/shock-vectors ─────────────────────────

function makeVectorApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M16.15 — GET /v1/scenarios/library/shock-vectors', () => {
  test('analyst+ → 200 with full library', async () => {
    const { app } = makeVectorApp('admin');
    const r = await request(app).get('/v1/scenarios/library/shock-vectors').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_presets).toBeGreaterThan(0);
    expect(r.body.body.vectors).toHaveLength(r.body.body.total_presets);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeVectorApp('case_owner');
    const r = await request(app).get('/v1/scenarios/library/shock-vectors').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static — same response across tenants', async () => {
    const { app } = makeVectorApp('admin');
    const bil = await request(app).get('/v1/scenarios/library/shock-vectors').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/scenarios/library/shock-vectors')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });

  test('M16.1 /v1/scenarios/library still works', async () => {
    const { app } = makeVectorApp('admin');
    const r = await request(app).get('/v1/scenarios/library').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
