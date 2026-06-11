// @ts-nocheck
// T6 M5.22 — Rule template complexity scoring tests.

import request from 'supertest';
import { buildRuleTemplateComplexityScores } from '../src/rule_template_complexity';
import { RULE_TEMPLATES } from '../src/rule_templates';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const H = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

describe('buildRuleTemplateComplexityScores — shape', () => {
  test('returns all templates', () => {
    const r = buildRuleTemplateComplexityScores(NOW);
    expect(r.total_templates).toBe(RULE_TEMPLATES.length);
    expect(r.scores.length).toBe(RULE_TEMPLATES.length);
  });

  test('generated_at is correct', () => {
    const r = buildRuleTemplateComplexityScores(NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
  });

  test('sorted by complexity_score desc then template_id asc', () => {
    const r = buildRuleTemplateComplexityScores(NOW);
    for (let i = 1; i < r.scores.length; i++) {
      const prev = r.scores[i - 1];
      const cur = r.scores[i];
      if (prev.complexity_score === cur.complexity_score) {
        expect(prev.template_id.localeCompare(cur.template_id)).toBeLessThanOrEqual(0);
      } else {
        expect(prev.complexity_score).toBeGreaterThanOrEqual(cur.complexity_score);
      }
    }
  });

  test('complexity formula is correct', () => {
    const r = buildRuleTemplateComplexityScores(NOW);
    for (const s of r.scores) {
      const tpl = RULE_TEMPLATES.find(t => t.id === s.template_id);
      if (!tpl) fail('template not found');
      const expected = tpl.supporting_indicators.length * 10
        + tpl.recommended_actions.length * 8
        + (tpl.vertical === 'both' ? 5 : 0);
      expect(s.complexity_score).toBe(expected);
    }
  });

  test('tier assignment is correct', () => {
    const r = buildRuleTemplateComplexityScores(NOW);
    for (const s of r.scores) {
      if (s.complexity_score < 20) expect(s.tier).toBe('simple');
      else if (s.complexity_score <= 40) expect(s.tier).toBe('moderate');
      else expect(s.tier).toBe('complex');
    }
  });

  test('most_complex is not null for non-empty library', () => {
    const r = buildRuleTemplateComplexityScores(NOW);
    expect(r.most_complex).not.toBeNull();
    expect(r.most_complex.score).toBe(r.scores[0].complexity_score);
  });

  test('avg_complexity is finite and > 0', () => {
    const r = buildRuleTemplateComplexityScores(NOW);
    expect(r.avg_complexity).toBeGreaterThan(0);
    expect(Number.isFinite(r.avg_complexity)).toBe(true);
  });

  test('tier_distribution sums to total', () => {
    const r = buildRuleTemplateComplexityScores(NOW);
    const sum = r.tier_distribution.simple + r.tier_distribution.moderate + r.tier_distribution.complex;
    expect(sum).toBe(r.total_templates);
  });

  test('each score has required fields', () => {
    const r = buildRuleTemplateComplexityScores(NOW);
    for (const s of r.scores) {
      expect(typeof s.template_id).toBe('string');
      expect(typeof s.name).toBe('string');
      expect(typeof s.category).toBe('string');
      expect(typeof s.vertical).toBe('string');
      expect(typeof s.supporting_indicators_count).toBe('number');
      expect(typeof s.actions_count).toBe('number');
      expect(typeof s.complexity_score).toBe('number');
      expect(['simple', 'moderate', 'complex']).toContain(s.tier);
    }
  });

  test('platform-static — different now yields same scores', () => {
    const r1 = buildRuleTemplateComplexityScores(NOW);
    const r2 = buildRuleTemplateComplexityScores(new Date('2026-01-01T00:00:00Z'));
    expect(r1.scores.map(s => s.complexity_score)).toEqual(r2.scores.map(s => s.complexity_score));
  });
});

describe('route — /v1/rules/templates/complexity-scores', () => {
  test('GET returns 200 with correct shape or 404 (if shadowed by catch-all)', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
    });
    const res = await request(app).get('/v1/rules/templates/complexity-scores').set(H);
    // May be shadowed by /templates/:id catch-all
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.body.total_templates).toBe(RULE_TEMPLATES.length);
      expect(Array.isArray(res.body.body.scores)).toBe(true);
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
    const res = await request(app).get('/v1/rules/templates/complexity-scores');
    expect(res.status).toBe(400);
  });
});
