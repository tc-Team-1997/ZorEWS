// __tests__/scoring_preset_ab_comparison.test.ts
// T6 M6.20 — Weight preset A/B effectiveness comparison

import request from 'supertest';
import {
  buildPresetAbComparison,
  PresetAbComparisonError,
} from '../src/scoring_preset_ab_comparison';
import { InMemoryCustomWeightPresetStore } from '../src/scoring_presets_custom';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-08T00:00:00Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeAbApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

function makeStore(): InMemoryCustomWeightPresetStore {
  return new InMemoryCustomWeightPresetStore();
}

describe('buildPresetAbComparison — M6.20', () => {
  it('library vs library comparison returns valid shape', () => {
    const store = makeStore();
    const result = buildPresetAbComparison('preset_banking_conservative', 'preset_banking_balanced', NOW, 'BIL', store);
    expect(result.preset_a.id).toBe('preset_banking_conservative');
    expect(result.preset_b.id).toBe('preset_banking_balanced');
    expect(result.sample_size).toBe(50);
    expect(typeof result.score_delta_mean).toBe('number');
    expect(typeof result.score_delta_p50).toBe('number');
    expect(typeof result.score_delta_p95).toBe('number');
    expect(result.a_higher_count + result.b_higher_count + result.tied_count).toBe(50);
    expect(result.band_agreement_rate).toBeGreaterThanOrEqual(0);
    expect(result.band_agreement_rate).toBeLessThanOrEqual(1);
    expect(result.per_band_shift.b_higher_band + result.per_band_shift.b_same_band + result.per_band_shift.b_lower_band).toBe(50);
    expect(typeof result.recommendation).toBe('string');
  });

  it('same preset_id throws same_preset', () => {
    const store = makeStore();
    expect(() =>
      buildPresetAbComparison('preset_banking_conservative', 'preset_banking_conservative', NOW, 'BIL', store),
    ).toThrow(PresetAbComparisonError);
  });

  it('unknown preset_a throws WeightPresetError', () => {
    const store = makeStore();
    expect(() =>
      buildPresetAbComparison('unknown-preset-xyz', 'preset_banking_balanced', NOW, 'BIL', store),
    ).toThrow();
  });

  it('unknown preset_b throws WeightPresetError', () => {
    const store = makeStore();
    expect(() =>
      buildPresetAbComparison('preset_banking_conservative', 'unknown-preset-xyz', NOW, 'BIL', store),
    ).toThrow();
  });

  it('missing preset_a throws invalid_input', () => {
    const store = makeStore();
    expect(() =>
      buildPresetAbComparison('', 'preset_banking_balanced', NOW, 'BIL', store),
    ).toThrow();
  });

  it('deterministic — same inputs same day produce same result', () => {
    const store = makeStore();
    const r1 = buildPresetAbComparison('preset_banking_conservative', 'preset_banking_aggressive', NOW, 'BIL', store);
    const r2 = buildPresetAbComparison('preset_banking_conservative', 'preset_banking_aggressive', NOW, 'BIL', store);
    expect(r1.score_delta_mean).toBeCloseTo(r2.score_delta_mean, 6);
    expect(r1.a_higher_count).toBe(r2.a_higher_count);
  });

  it('conservative preset produces higher scores than balanced on average', () => {
    const store = makeStore();
    const result = buildPresetAbComparison('preset_banking_balanced', 'preset_banking_conservative', NOW, 'BIL', store);
    // conservative multipliers boost heavy indicators so B (conservative) should be higher
    expect(result.score_delta_mean).toBeGreaterThan(0);
  });

  it('p95 is non-negative', () => {
    const store = makeStore();
    const result = buildPresetAbComparison('preset_banking_conservative', 'preset_banking_balanced', NOW, 'BIL', store);
    expect(result.score_delta_p95).toBeGreaterThanOrEqual(0);
  });

  it('insurance vs insurance presets compare correctly', () => {
    const store = makeStore();
    const result = buildPresetAbComparison('preset_insurance_conservative', 'preset_insurance_balanced', NOW, 'BIL', store);
    expect(result.preset_a.vertical).toBe('insurance');
    expect(result.preset_b.vertical).toBe('insurance');
  });

  it('admin route GET /v1/scoring/presets/compare-effectiveness → 200', async () => {
    const { app } = makeAbApp('admin');
    const res = await request(app)
      .get('/v1/scoring/presets/compare-effectiveness?preset_a=preset_banking_conservative&preset_b=preset_banking_balanced')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.sample_size).toBe(50);
    expect(res.body.body.preset_a.id).toBe('preset_banking_conservative');
  });

  it('missing query params → 400', async () => {
    const { app } = makeAbApp('admin');
    const res = await request(app)
      .get('/v1/scoring/presets/compare-effectiveness?preset_a=preset_banking_conservative')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });

  it('non-allowed role → 403', async () => {
    const { app } = makeAbApp('unknown_role');
    const res = await request(app)
      .get('/v1/scoring/presets/compare-effectiveness?preset_a=preset_banking_conservative&preset_b=preset_banking_balanced')
      .set(TH_BIL)
      .set('x-apex-role', 'unknown_role');
    expect(res.status).toBe(403);
  });
});
