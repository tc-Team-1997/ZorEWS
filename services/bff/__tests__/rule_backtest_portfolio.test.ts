// @ts-nocheck
// T6 M5.29 — Rule backtest portfolio summary tests.

import request from 'supertest';
import { buildRuleBacktestPortfolio } from '../src/rule_backtest_portfolio';
import { RuleStore } from '../src/rules/store';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'risk_analyst', ruleStore?) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    ruleStore: ruleStore,
  });
  return { app };
}

describe('M5.29 — buildRuleBacktestPortfolio pure', () => {
  test('empty store returns zero rules', () => {
    const store = new RuleStore([]);
    const result = buildRuleBacktestPortfolio('BIL', NOW, store);
    expect(result.total_live_rules).toBe(0); // no active rules in empty store
    expect(result.rules).toHaveLength(0);
    expect(result.highest_roi_rule).toBeNull();
    expect(result.portfolio_roi).toBe(0);
  });

  test('live rules have valid ROI', () => {
    const result = buildRuleBacktestPortfolio('BIL', NOW);
    for (const r of result.rules) {
      expect(typeof r.roi).toBe('number');
      expect(typeof r.fires_30d).toBe('number');
      expect(r.fires_30d).toBeGreaterThan(0);
      expect(r.precision).toBeGreaterThan(0);
      expect(r.precision).toBeLessThanOrEqual(1);
    }
  });

  test('sorted by roi descending', () => {
    const result = buildRuleBacktestPortfolio('BIL', NOW);
    for (let i = 1; i < result.rules.length; i++) {
      expect(result.rules[i - 1].roi).toBeGreaterThanOrEqual(result.rules[i].roi);
    }
  });

  test('highest_roi_rule matches first rule', () => {
    const result = buildRuleBacktestPortfolio('BIL', NOW);
    if (result.rules.length > 0) {
      expect(result.highest_roi_rule).toBe(result.rules[0].rule_id);
    }
  });

  test('throws on empty tenant_id', () => {
    expect(() => buildRuleBacktestPortfolio('', NOW)).toThrow();
  });
});

describe('M5.29 — GET /v1/rules/backtest/portfolio-summary route', () => {
  test('risk_analyst returns 200', async () => {
    const { app } = makeTestApp('risk_analyst');
    const res = await request(app)
      .get('/v1/rules/backtest/portfolio-summary')
      .set(TH);
    expect(res.status).toBe(200);
    expect(typeof res.body.body.total_live_rules).toBe('number');
    expect(Array.isArray(res.body.body.rules)).toBe(true);
  });

  test('unknown role returns 403', async () => {
    const { app } = makeTestApp('viewer');
    const res = await request(app)
      .get('/v1/rules/backtest/portfolio-summary')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('missing tenant header returns 400', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app).get('/v1/rules/backtest/portfolio-summary');
    expect(res.status).toBe(400);
  });
});
