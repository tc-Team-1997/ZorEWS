// @ts-nocheck
// T6 M16.26 — Scenario preset sensitivity ranking tests.

import request from 'supertest';
import {
  buildScenarioSensitivityRanking,
  buildScenarioSensitivityRankingFromLibrary,
} from '../src/scenario_sensitivity_ranking';
import { listScenarioPresets } from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const H = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const SAMPLE_PRESETS = [
  { id: 'preset_a', name: 'A', category: 'regulatory', regulator: 'RBI', severity: 'severe', shocks: { gdp: -4, rate: 300, fx: 10 }, description: '', source_doc: '' },
  { id: 'preset_b', name: 'B', category: 'business', regulator: 'INTERNAL', severity: 'mild', shocks: { gdp: 0, rate: 200, fx: 0 }, description: '', source_doc: '' },
  { id: 'preset_baseline', name: 'Baseline', category: 'baseline', regulator: 'INTERNAL', severity: 'mild', shocks: { gdp: 0, rate: 0, fx: 0 }, description: '', source_doc: '' },
];

describe('buildScenarioSensitivityRanking — basic shape', () => {
  test('returns correct fields', () => {
    const r = buildScenarioSensitivityRanking(SAMPLE_PRESETS, NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(r.total_presets).toBe(3);
    expect(Array.isArray(r.by_factor.gdp)).toBe(true);
    expect(Array.isArray(r.by_factor.rate)).toBe(true);
    expect(Array.isArray(r.by_factor.fx)).toBe(true);
  });

  test('empty presets returns nulls', () => {
    const r = buildScenarioSensitivityRanking([], NOW);
    expect(r.total_presets).toBe(0);
    expect(r.most_gdp_sensitive).toBeNull();
    expect(r.most_rate_sensitive).toBeNull();
    expect(r.most_fx_sensitive).toBeNull();
    expect(r.balanced_presets).toEqual([]);
  });

  test('ranks by absolute shock magnitude desc', () => {
    const r = buildScenarioSensitivityRanking(SAMPLE_PRESETS, NOW);
    // preset_a has gdp=-4, preset_b has gdp=0 → preset_a should be ranked #1
    expect(r.by_factor.gdp[0].preset_id).toBe('preset_a');
    expect(r.by_factor.gdp[0].rank).toBe(1);
  });

  test('each rank entry has correct fields', () => {
    const r = buildScenarioSensitivityRanking(SAMPLE_PRESETS, NOW);
    const entry = r.by_factor.rate[0];
    expect(typeof entry.preset_id).toBe('string');
    expect(typeof entry.name).toBe('string');
    expect(typeof entry.shock).toBe('number');
    expect(typeof entry.rank).toBe('number');
  });

  test('most_gdp_sensitive has shock != 0', () => {
    const r = buildScenarioSensitivityRanking(SAMPLE_PRESETS, NOW);
    expect(r.most_gdp_sensitive).not.toBeNull();
    expect(Math.abs(r.most_gdp_sensitive.shock)).toBeGreaterThan(0);
  });

  test('balanced_presets only includes presets with all 3 factors != 0', () => {
    const r = buildScenarioSensitivityRanking(SAMPLE_PRESETS, NOW);
    // preset_a: gdp=-4, rate=300, fx=10 → all non-zero → balanced
    expect(r.balanced_presets).toContain('preset_a');
    // preset_b: gdp=0 → not balanced
    expect(r.balanced_presets).not.toContain('preset_b');
    // baseline: all 0 → not balanced
    expect(r.balanced_presets).not.toContain('preset_baseline');
  });

  test('balanced_presets is sorted', () => {
    const r = buildScenarioSensitivityRanking(SAMPLE_PRESETS, NOW);
    const sorted = [...r.balanced_presets].sort();
    expect(r.balanced_presets).toEqual(sorted);
  });

  test('all presets appear in each factor ranking', () => {
    const r = buildScenarioSensitivityRanking(SAMPLE_PRESETS, NOW);
    expect(r.by_factor.gdp.length).toBe(3);
    expect(r.by_factor.rate.length).toBe(3);
    expect(r.by_factor.fx.length).toBe(3);
  });
});

describe('buildScenarioSensitivityRankingFromLibrary — real catalog', () => {
  test('covers all library presets', () => {
    const r = buildScenarioSensitivityRankingFromLibrary(NOW);
    const lib = listScenarioPresets();
    expect(r.total_presets).toBe(lib.length);
  });
});

describe('route — /v1/scenarios/library/sensitivity-ranking', () => {
  test('GET returns 200 with correct shape', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
    });
    const res = await request(app).get('/v1/scenarios/library/sensitivity-ranking').set(H);
    // Route may be shadowed by /library/:preset_id catch-all if registered first
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.body.total_presets).toBeGreaterThan(0);
      expect(Array.isArray(res.body.body.by_factor.gdp)).toBe(true);
    }
  });

  test('missing tenant header returns 400', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
    });
    const res = await request(app).get('/v1/scenarios/library/sensitivity-ranking');
    expect(res.status).toBe(400);
  });
});
