// @ts-nocheck
// services/bff/__tests__/scenario_portfolio_ranking.test.ts
//
// T6 M16.25 — Scenario preset portfolio impact ranking.

import request from 'supertest';
import { buildScenarioPortfolioRanking } from '../src/scenario_portfolio_ranking';
import { SCENARIO_PRESETS } from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function preset(overrides) {
  return {
    id: 'test',
    name: 'Test',
    description: '',
    category: 'business',
    regulator: 'INTERNAL',
    severity: 'mild',
    shocks: { gdp: 0, rate: 0, fx: 0 },
    source_doc: '',
    ...overrides,
  };
}

// ─── pure function ───────────────────────────────────────────────────

describe('M16.25 — buildScenarioPortfolioRanking envelope', () => {
  test('total_presets matches library size', () => {
    const s = buildScenarioPortfolioRanking(NOW);
    expect(s.total_presets).toBe(SCENARIO_PRESETS.length);
    expect(s.rankings.length).toBe(SCENARIO_PRESETS.length);
  });

  test('generated_at is ISO string', () => {
    const s = buildScenarioPortfolioRanking(NOW);
    expect(s.generated_at).toBe(NOW.toISOString());
  });

  test('rankings sorted by impact_index desc', () => {
    const s = buildScenarioPortfolioRanking(NOW);
    for (let i = 0; i < s.rankings.length - 1; i++) {
      expect(s.rankings[i].impact_index).toBeGreaterThanOrEqual(s.rankings[i + 1].impact_index);
    }
  });
});

describe('M16.25 — impact_index calculation', () => {
  test('zero shocks => impact_index = 0', () => {
    const s = buildScenarioPortfolioRanking(NOW, [
      preset({ id: 'a', shocks: { gdp: 0, rate: 0, fx: 0 } }),
    ]);
    expect(s.rankings[0].impact_index).toBe(0);
  });

  test('max GDP shock alone', () => {
    const s = buildScenarioPortfolioRanking(NOW, [
      preset({ id: 'a', shocks: { gdp: -7, rate: 0, fx: 0 } }),
    ]);
    // |gdp|/7 * 0.4 = 1 * 0.4 = 0.4
    expect(s.rankings[0].impact_index).toBe(0.4);
  });

  test('portfolio_tier catastrophic when impact_index > 0.7', () => {
    const s = buildScenarioPortfolioRanking(NOW, [
      preset({ id: 'a', shocks: { gdp: -7, rate: 400, fx: 15 } }),
    ]);
    expect(s.rankings[0].impact_index).toBe(1.0);
    expect(s.rankings[0].portfolio_tier).toBe('catastrophic');
  });

  test('portfolio_tier mild when impact_index low', () => {
    const s = buildScenarioPortfolioRanking(NOW, [
      preset({ id: 'a', shocks: { gdp: -1, rate: 0, fx: 0 } }),
    ]);
    expect(s.rankings[0].portfolio_tier).toBe('mild');
  });
});

describe('M16.25 — leaderboards', () => {
  test('most_impactful points at highest impact_index preset', () => {
    const s = buildScenarioPortfolioRanking(NOW, [
      preset({ id: 'a', shocks: { gdp: -1, rate: 0, fx: 0 } }),
      preset({ id: 'b', shocks: { gdp: -7, rate: 400, fx: 15 } }),
    ]);
    expect(s.most_impactful.preset_id).toBe('b');
  });

  test('most_impactful is null for empty list', () => {
    const s = buildScenarioPortfolioRanking(NOW, []);
    expect(s.most_impactful).toBeNull();
    expect(s.average_impact_index).toBe(0);
  });

  test('zero_impact_count counts baseline presets', () => {
    const s = buildScenarioPortfolioRanking(NOW, [
      preset({ id: 'a', shocks: { gdp: 0, rate: 0, fx: 0 } }),
      preset({ id: 'b', shocks: { gdp: -4, rate: 0, fx: 0 } }),
    ]);
    expect(s.zero_impact_count).toBe(1);
  });

  test('ranks are 1-based contiguous', () => {
    const s = buildScenarioPortfolioRanking(NOW);
    for (let i = 0; i < s.rankings.length; i++) {
      expect(s.rankings[i].rank).toBe(i + 1);
    }
  });
});

// ─── route ───────────────────────────────────────────────────────────

function makeApp2(role) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M16.25 — GET /v1/scenarios/library/portfolio-ranking', () => {
  test('analyst+ → 200 with rankings', async () => {
    const { app } = makeApp2('risk_analyst');
    const r = await request(app).get('/v1/scenarios/library/portfolio-ranking').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_presets).toBe(SCENARIO_PRESETS.length);
    expect(Array.isArray(r.body.body.rankings)).toBe(true);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeApp2('case_owner');
    const r = await request(app).get('/v1/scenarios/library/portfolio-ranking').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL and BANK_DEMO same response', async () => {
    const { app } = makeApp2('admin');
    const bil = await request(app).get('/v1/scenarios/library/portfolio-ranking').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/scenarios/library/portfolio-ranking')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(bil.body.body.total_presets).toBe(bank.body.body.total_presets);
  });
});
