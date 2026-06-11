// @ts-nocheck
// T6 M6.27 — Weight preset portfolio impact tests.

import request from 'supertest';
import { buildScoringPresetPortfolioImpact } from '../src/scoring_preset_portfolio_impact';
import { WEIGHT_PRESETS } from '../src/scoring_presets';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
  return app;
}

describe('M6.27 — buildScoringPresetPortfolioImpact pure', () => {
  test('returns one entry per library preset', () => {
    const result = buildScoringPresetPortfolioImpact('BIL', NOW);
    expect(result.presets).toHaveLength(WEIGHT_PRESETS.length);
  });

  test('portfolio_size is always 50', () => {
    const result = buildScoringPresetPortfolioImpact('BIL', NOW);
    expect(result.portfolio_size).toBe(50);
  });

  test('counts sum to 50 per preset', () => {
    const result = buildScoringPresetPortfolioImpact('BIL', NOW);
    for (const p of result.presets) {
      expect(p.portfolio_high_risk_count + p.portfolio_medium_risk_count + p.portfolio_low_risk_count).toBe(50);
    }
  });

  test('high_risk_rate = high_count / 50', () => {
    const result = buildScoringPresetPortfolioImpact('BIL', NOW);
    for (const p of result.presets) {
      const expected = Math.round((p.portfolio_high_risk_count / 50) * 10000) / 10000;
      expect(p.high_risk_rate).toBe(expected);
    }
  });

  test('sorted by high_risk_rate desc', () => {
    const result = buildScoringPresetPortfolioImpact('BIL', NOW);
    for (let i = 1; i < result.presets.length; i++) {
      expect(result.presets[i-1].high_risk_rate).toBeGreaterThanOrEqual(result.presets[i].high_risk_rate);
    }
  });

  test('most_conservative has highest high_risk_rate', () => {
    const result = buildScoringPresetPortfolioImpact('BIL', NOW);
    const maxRate = Math.max(...result.presets.map((p) => p.high_risk_rate));
    const conservativePreset = result.presets.find((p) => p.preset_id === result.most_conservative_preset);
    expect(conservativePreset.high_risk_rate).toBe(maxRate);
  });

  test('tenant_id and generated_at echoed', () => {
    const result = buildScoringPresetPortfolioImpact('BIL', NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

describe('M6.27 — GET /v1/scoring/presets/portfolio-impact route', () => {
  test('admin 200 with envelope', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/scoring/presets/portfolio-impact').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toBeDefined();
    expect(res.body.body.portfolio_size).toBe(50);
  });

  test('risk_analyst accepted', async () => {
    const app = makeTestApp('risk_analyst');
    const res = await request(app).get('/v1/scoring/presets/portfolio-impact').set(TH);
    expect(res.status).toBe(200);
  });

  test('unknown_role 403', async () => {
    const app = makeTestApp('unknown_role_xyz');
    const res = await request(app).get('/v1/scoring/presets/portfolio-impact').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant header → 400', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/scoring/presets/portfolio-impact');
    expect(res.status).toBe(400);
  });
});
