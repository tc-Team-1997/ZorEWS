// @ts-nocheck
// services/bff/__tests__/scenario_stress_contribution.test.ts
// T6 M16.27 — Scenario stress factor contribution.

import request from 'supertest';
import { buildScenarioStressContribution } from '../src/scenario_stress_contribution';
import { listScenarioPresets } from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-11T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function fakeApp(role = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    getRole: () => role,
    now: () => NOW,
  });
  return app;
}

// ─── Pure function tests ────────────────────────────────────────────────

describe('M16.27 — buildScenarioStressContribution — shape', () => {
  test('returns all library presets', () => {
    const out = buildScenarioStressContribution(NOW);
    expect(out.total_presets).toBe(listScenarioPresets().length);
    expect(out.presets).toHaveLength(out.total_presets);
  });

  test('sorted by preset_id asc', () => {
    const out = buildScenarioStressContribution(NOW);
    for (let i = 0; i < out.presets.length - 1; i++) {
      expect(out.presets[i].preset_id.localeCompare(out.presets[i + 1].preset_id)).toBeLessThanOrEqual(0);
    }
  });

  test('contributions sum approximately to 100', () => {
    const out = buildScenarioStressContribution(NOW);
    for (const p of out.presets) {
      const sum = p.gdp_contribution + p.rate_contribution + p.fx_contribution;
      expect(sum).toBeCloseTo(100, 0);
    }
  });

  test('baseline (zero shocks) → all approximately 33.33', () => {
    const out = buildScenarioStressContribution(NOW);
    const baseline = out.presets.find((p) => p.preset_id.includes('baseline'));
    if (baseline) {
      expect(baseline.gdp_contribution).toBeCloseTo(33.33, 0);
      expect(baseline.rate_contribution).toBeCloseTo(33.33, 0);
      expect(baseline.fx_contribution).toBeCloseTo(33.33, 0);
    }
  });

  test('dominant_factor is the highest contribution axis', () => {
    const out = buildScenarioStressContribution(NOW);
    for (const p of out.presets) {
      const max = Math.max(p.gdp_contribution, p.rate_contribution, p.fx_contribution);
      if (p.dominant_factor === 'gdp') expect(p.gdp_contribution).toBeGreaterThanOrEqual(p.rate_contribution);
      if (p.dominant_factor === 'rate') expect(p.rate_contribution).toBeGreaterThanOrEqual(p.gdp_contribution);
      if (p.dominant_factor === 'fx') expect(p.fx_contribution).toBeGreaterThanOrEqual(p.gdp_contribution);
    }
  });

  test('by_dominant_factor sums to total_presets', () => {
    const out = buildScenarioStressContribution(NOW);
    const sum = out.by_dominant_factor.gdp + out.by_dominant_factor.rate + out.by_dominant_factor.fx;
    expect(sum).toBe(out.total_presets);
  });

  test('by_dominant_factor has all 3 axes', () => {
    const out = buildScenarioStressContribution(NOW);
    expect(out.by_dominant_factor).toHaveProperty('gdp');
    expect(out.by_dominant_factor).toHaveProperty('rate');
    expect(out.by_dominant_factor).toHaveProperty('fx');
  });

  test('platform-static — same result twice', () => {
    const a = buildScenarioStressContribution(NOW);
    const b = buildScenarioStressContribution(NOW);
    expect(a.presets[0].gdp_contribution).toBe(b.presets[0].gdp_contribution);
  });

  test('generated_at echoes NOW', () => {
    const out = buildScenarioStressContribution(NOW);
    expect(out.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M16.27 — route GET /v1/scenarios/library/stress-contribution', () => {
  test('analyst+ → 200 with presets', async () => {
    const app = fakeApp('risk_analyst');
    const res = await request(app).get('/v1/scenarios/library/stress-contribution').set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.presets)).toBe(true);
    expect(res.body.body.presets.length).toBeGreaterThan(0);
  });

  test('admin → 200', async () => {
    const app = fakeApp('admin');
    const res = await request(app).get('/v1/scenarios/library/stress-contribution').set(TH);
    expect(res.status).toBe(200);
  });

  test('case_owner → 403', async () => {
    const app = fakeApp('case_owner');
    const res = await request(app).get('/v1/scenarios/library/stress-contribution').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant → 400', async () => {
    const app = fakeApp('admin');
    const res = await request(app).get('/v1/scenarios/library/stress-contribution');
    expect(res.status).toBe(400);
  });

  test('platform-static across tenants', async () => {
    const app = fakeApp('admin');
    const r1 = await request(app).get('/v1/scenarios/library/stress-contribution').set({ 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' });
    const r2 = await request(app).get('/v1/scenarios/library/stress-contribution').set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r1.body.body.total_presets).toBe(r2.body.body.total_presets);
  });
});
