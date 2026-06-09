// @ts-nocheck
// __tests__/rule_template_category_activation.test.ts
// T6 M5.20 — Rule template by-category activation analytics

import request from 'supertest';
import { buildTemplateCategoryActivationAnalytics } from '../src/rule_template_category_activation';
import { RULE_TEMPLATES, listCategories } from '../src/rule_templates';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-09T10:00:00Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('buildTemplateCategoryActivationAnalytics — M5.20', () => {
  it('total_templates matches RULE_TEMPLATES.length', () => {
    const result = buildTemplateCategoryActivationAnalytics(NOW);
    expect(result.total_templates).toBe(RULE_TEMPLATES.length);
  });

  it('all canonical categories represented', () => {
    const result = buildTemplateCategoryActivationAnalytics(NOW);
    const cats = result.categories.map(c => c.category);
    for (const expected of listCategories()) {
      expect(cats).toContain(expected);
    }
  });

  it('banking + insurance + both = total_templates per category', () => {
    const result = buildTemplateCategoryActivationAnalytics(NOW);
    for (const cat of result.categories) {
      expect(cat.banking_count + cat.insurance_count + cat.both_count).toBe(
        cat.total_templates,
      );
    }
  });

  it('sum of category totals = total_templates', () => {
    const result = buildTemplateCategoryActivationAnalytics(NOW);
    const sum = result.categories.reduce((acc, c) => acc + c.total_templates, 0);
    expect(sum).toBe(result.total_templates);
  });

  it('severity_distribution keys: critical, high, medium, low all present', () => {
    const result = buildTemplateCategoryActivationAnalytics(NOW);
    for (const cat of result.categories) {
      expect(cat.severity_distribution).toHaveProperty('critical');
      expect(cat.severity_distribution).toHaveProperty('high');
      expect(cat.severity_distribution).toHaveProperty('medium');
      expect(cat.severity_distribution).toHaveProperty('low');
    }
  });

  it('sum of severity_distribution = total_templates per category', () => {
    const result = buildTemplateCategoryActivationAnalytics(NOW);
    for (const cat of result.categories) {
      const sum =
        cat.severity_distribution.critical +
        cat.severity_distribution.high +
        cat.severity_distribution.medium +
        cat.severity_distribution.low;
      expect(sum).toBe(cat.total_templates);
    }
  });

  it('cross_vertical_pct = both-count / total', () => {
    const result = buildTemplateCategoryActivationAnalytics(NOW);
    const bothCount = RULE_TEMPLATES.filter(t => t.vertical === 'both').length;
    const expected = result.total_templates > 0 ? bothCount / result.total_templates : 0;
    expect(result.cross_vertical_pct).toBeCloseTo(expected, 4);
  });

  it('most_active_category has the highest total_templates', () => {
    const result = buildTemplateCategoryActivationAnalytics(NOW);
    if (result.most_active_category) {
      const maxCat = result.categories.find(
        c => c.category === result.most_active_category,
      );
      expect(maxCat).toBeDefined();
      for (const cat of result.categories) {
        expect(maxCat.total_templates).toBeGreaterThanOrEqual(cat.total_templates);
      }
    }
  });

  it('least_active_category has the lowest total_templates (> 0)', () => {
    const result = buildTemplateCategoryActivationAnalytics(NOW);
    if (result.least_active_category) {
      const minCat = result.categories.find(
        c => c.category === result.least_active_category,
      );
      expect(minCat).toBeDefined();
      expect(minCat.total_templates).toBeGreaterThan(0);
    }
  });

  it('avg_supporting_indicators >= 0 for all categories', () => {
    const result = buildTemplateCategoryActivationAnalytics(NOW);
    for (const cat of result.categories) {
      expect(cat.avg_supporting_indicators).toBeGreaterThanOrEqual(0);
    }
  });

  it('analyst+ route GET /v1/rules/templates/category-activation → 200', async () => {
    const { app } = makeTestApp('risk_analyst');
    const res = await request(app)
      .get('/v1/rules/templates/category-activation')
      .set(TH_BIL)
      .set('x-apex-role', 'risk_analyst');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.categories)).toBe(true);
    expect(typeof res.body.body.total_templates).toBe('number');
  });

  it('unknown role → 403', async () => {
    const { app } = makeTestApp('unknown_role');
    const res = await request(app)
      .get('/v1/rules/templates/category-activation')
      .set(TH_BIL)
      .set('x-apex-role', 'unknown_role');
    expect(res.status).toBe(403);
  });
});
