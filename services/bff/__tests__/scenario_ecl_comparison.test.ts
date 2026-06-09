// __tests__/scenario_ecl_comparison.test.ts
// T6 M16.24 — Scenario ECL impact comparison

import request from 'supertest';
import {
  buildScenarioEclComparison,
  ScenarioEclComparisonError,
} from '../src/scenario_ecl_comparison';
import { listScenarioPresets } from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-08T00:00:00Z');
const TENANT = 'BIL';
const TH_BIL = { 'X-Tenant-ID': TENANT, 'X-Channel': 'API' };

function makeEclApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('buildScenarioEclComparison — M16.24', () => {
  it('valid preset list produces correct shape', () => {
    const presets = listScenarioPresets().slice(0, 3).map(p => p.id);
    const result = buildScenarioEclComparison(TENANT, presets, NOW);
    expect(result.tenant_id).toBe(TENANT);
    expect(result.total_presets).toBe(3);
    expect(result.results).toHaveLength(3);
    expect(typeof result.max_ecl_delta_kes).toBe('number');
    expect(typeof result.min_ecl_delta_kes).toBe('number');
    expect(typeof result.spread_kes).toBe('number');
  });

  it('results sorted ecl_delta_kes desc', () => {
    const presets = listScenarioPresets().slice(0, 5).map(p => p.id);
    const result = buildScenarioEclComparison(TENANT, presets, NOW);
    for (let i = 1; i < result.results.length; i++) {
      expect(result.results[i - 1]!.ecl_delta_kes).toBeGreaterThanOrEqual(
        result.results[i]!.ecl_delta_kes,
      );
    }
  });

  it('rank starts at 1 and is sequential', () => {
    const presets = listScenarioPresets().slice(0, 3).map(p => p.id);
    const result = buildScenarioEclComparison(TENANT, presets, NOW);
    const ranks = result.results.map(r => r.rank).sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2, 3]);
  });

  it('most_stressed_preset matches rank 1', () => {
    const presets = listScenarioPresets().slice(0, 3).map(p => p.id);
    const result = buildScenarioEclComparison(TENANT, presets, NOW);
    expect(result.most_stressed_preset?.preset_id).toBe(result.results[0]!.preset_id);
  });

  it('most_resilient_preset matches last row', () => {
    const presets = listScenarioPresets().slice(0, 3).map(p => p.id);
    const result = buildScenarioEclComparison(TENANT, presets, NOW);
    const last = result.results[result.results.length - 1]!;
    expect(result.most_resilient_preset?.preset_id).toBe(last.preset_id);
  });

  it('spread = max - min', () => {
    const presets = listScenarioPresets().slice(0, 4).map(p => p.id);
    const result = buildScenarioEclComparison(TENANT, presets, NOW);
    expect(result.spread_kes).toBeCloseTo(
      result.max_ecl_delta_kes - result.min_ecl_delta_kes,
      0,
    );
  });

  it('per-row stage_migrations_total is non-negative', () => {
    const presets = listScenarioPresets().slice(0, 3).map(p => p.id);
    const result = buildScenarioEclComparison(TENANT, presets, NOW);
    for (const r of result.results) {
      expect(r.stage_migrations_total).toBeGreaterThanOrEqual(0);
    }
  });

  it('worst_segment is a non-empty string', () => {
    const presets = listScenarioPresets().slice(0, 2).map(p => p.id);
    const result = buildScenarioEclComparison(TENANT, presets, NOW);
    for (const r of result.results) {
      expect(typeof r.worst_segment).toBe('string');
      expect(r.worst_segment.length).toBeGreaterThan(0);
    }
  });

  it('unknown preset → ScenarioEclComparisonError unknown_preset', () => {
    expect(() =>
      buildScenarioEclComparison(TENANT, ['unknown-preset-xyz'], NOW),
    ).toThrow(ScenarioEclComparisonError);
  });

  it('empty array → ScenarioEclComparisonError invalid_input', () => {
    expect(() =>
      buildScenarioEclComparison(TENANT, [], NOW),
    ).toThrow(ScenarioEclComparisonError);
  });

  it('exceeds max 15 presets → ScenarioEclComparisonError invalid_input', () => {
    const ids = Array.from({ length: 16 }, (_, i) => `p-${i}`);
    expect(() =>
      buildScenarioEclComparison(TENANT, ids, NOW),
    ).toThrow(ScenarioEclComparisonError);
  });

  it('admin route POST /v1/scenarios/ecl-impact-comparison → 200', async () => {
    const { app } = makeEclApp('admin');
    const presets = listScenarioPresets().slice(0, 3).map(p => p.id);
    const res = await request(app)
      .post('/v1/scenarios/ecl-impact-comparison')
      .set(TH_BIL)
      .set('x-apex-role', 'admin')
      .send({ preset_ids: presets });
    expect(res.status).toBe(200);
    expect(res.body.body.total_presets).toBe(3);
    expect(Array.isArray(res.body.body.results)).toBe(true);
  });

  it('non-allowed role → 403', async () => {
    const { app } = makeEclApp('unknown_role');
    const presets = listScenarioPresets().slice(0, 2).map(p => p.id);
    const res = await request(app)
      .post('/v1/scenarios/ecl-impact-comparison')
      .set(TH_BIL)
      .set('x-apex-role', 'unknown_role')
      .send({ preset_ids: presets });
    expect(res.status).toBe(403);
  });
});
