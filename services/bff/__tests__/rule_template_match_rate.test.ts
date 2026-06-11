// @ts-nocheck
// services/bff/__tests__/rule_template_match_rate.test.ts
// T6 M5.23 — Rule template recommendation match rate

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { RuleStore, defaultStore as defaultRuleStore } from '../src/rules/store';
import { RULE_TEMPLATES } from '../src/rule_templates';
import { computeTemplateMatchRates } from '../src/rule_template_match_rate';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('computeTemplateMatchRates()', () => {
  test('returns one entry per RULE_TEMPLATES template', () => {
    const store = new RuleStore([]);
    const result = computeTemplateMatchRates('BIL', store, NOW);
    expect(result.templates).toHaveLength(RULE_TEMPLATES.length);
  });

  test('match_rate is 0 when no active rules', () => {
    const store = new RuleStore([]);
    const result = computeTemplateMatchRates('BIL', store, NOW);
    for (const t of result.templates) {
      expect(t.match_rate).toBe(0);
    }
  });

  test('total_active_rules is 0 with empty store', () => {
    const store = new RuleStore([]);
    const result = computeTemplateMatchRates('BIL', store, NOW);
    expect(result.total_active_rules).toBe(0);
  });

  test('each template entry has required fields', () => {
    const store = new RuleStore([]);
    const result = computeTemplateMatchRates('BIL', store, NOW);
    for (const t of result.templates) {
      expect(t).toHaveProperty('template_id');
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('category');
      expect(t).toHaveProperty('vertical');
      expect(t).toHaveProperty('match_rate');
      expect(t).toHaveProperty('coverage_score');
    }
  });

  test('overall_coverage_rate is 0 when no templates match', () => {
    const store = new RuleStore([]);
    const result = computeTemplateMatchRates('BIL', store, NOW);
    expect(result.overall_coverage_rate).toBe(0);
  });

  test('match_rate is in [0, 1]', () => {
    const store = new RuleStore([]);
    const result = computeTemplateMatchRates('BIL', store, NOW);
    for (const t of result.templates) {
      expect(t.match_rate).toBeGreaterThanOrEqual(0);
      expect(t.match_rate).toBeLessThanOrEqual(1);
    }
  });

  test('coverage_score is in [0, 100]', () => {
    const store = new RuleStore([]);
    const result = computeTemplateMatchRates('BIL', store, NOW);
    for (const t of result.templates) {
      expect(t.coverage_score).toBeGreaterThanOrEqual(0);
      expect(t.coverage_score).toBeLessThanOrEqual(100);
    }
  });

  test('tenant_id echoed', () => {
    const store = new RuleStore([]);
    const result = computeTemplateMatchRates('BIL', store, NOW);
    expect(result.tenant_id).toBe('BIL');
  });
});

describe('GET /v1/rules/templates/match-rate', () => {
  test('admin returns 200 with templates array', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/rules/templates/match-rate')
      .set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('templates');
    expect(res.body.body).toHaveProperty('overall_coverage_rate');
  });

  test('risk_analyst accepted (rules:list)', async () => {
    const { app } = makeTestApp('risk_analyst');
    const res = await request(app)
      .get('/v1/rules/templates/match-rate')
      .set(TH);
    expect(res.status).toBe(200);
  });

  test('unknown role returns 403', async () => {
    const { app } = makeTestApp('unknown_role_xyz');
    const res = await request(app)
      .get('/v1/rules/templates/match-rate')
      .set(TH);
    expect(res.status).toBe(403);
  });
});
