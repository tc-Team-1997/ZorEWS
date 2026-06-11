// @ts-nocheck
// services/bff/__tests__/rule_template_condition_complexity.test.ts
// T6 M5.26 — Rule template condition complexity tests

import { buildRuleTemplateConditionComplexity } from '../src/rule_template_condition_complexity';
import { RULE_TEMPLATES } from '../src/rule_templates';

const NOW = new Date('2026-05-22T12:00:00.000Z');

describe('buildRuleTemplateConditionComplexity — pure resolver', () => {
  test('returns envelope shape', () => {
    const r = buildRuleTemplateConditionComplexity(NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(typeof r.total_templates).toBe('number');
    expect(Array.isArray(r.templates)).toBe(true);
    expect(typeof r.avg_complexity).toBe('number');
  });

  test('total_templates matches RULE_TEMPLATES.length', () => {
    const r = buildRuleTemplateConditionComplexity(NOW);
    expect(r.total_templates).toBe(RULE_TEMPLATES.length);
  });

  test('each row has required fields', () => {
    const r = buildRuleTemplateConditionComplexity(NOW);
    for (const row of r.templates) {
      expect(typeof row.template_id).toBe('string');
      expect(typeof row.name).toBe('string');
      expect(typeof row.complexity_score).toBe('number');
      expect(['simple', 'moderate', 'complex']).toContain(row.tier);
    }
  });

  test('complexity_score formula: indicators*3 + actions*2 + both-vertical*5', () => {
    const r = buildRuleTemplateConditionComplexity(NOW);
    for (const row of r.templates) {
      const tpl = RULE_TEMPLATES.find((t) => t.id === row.template_id);
      const expected =
        (tpl.supporting_indicators.length * 3) +
        (tpl.recommended_actions.length * 2) +
        (tpl.vertical === 'both' ? 5 : 0);
      expect(row.complexity_score).toBe(expected);
    }
  });

  test('tier boundaries: <15 simple, 15-25 moderate, >25 complex', () => {
    const r = buildRuleTemplateConditionComplexity(NOW);
    for (const row of r.templates) {
      if (row.complexity_score < 15) expect(row.tier).toBe('simple');
      else if (row.complexity_score <= 25) expect(row.tier).toBe('moderate');
      else expect(row.tier).toBe('complex');
    }
  });

  test('sorted by score desc', () => {
    const r = buildRuleTemplateConditionComplexity(NOW);
    for (let i = 1; i < r.templates.length; i++) {
      expect(r.templates[i - 1].complexity_score).toBeGreaterThanOrEqual(r.templates[i].complexity_score);
    }
  });

  test('most_complex_template is the first template in sorted list', () => {
    const r = buildRuleTemplateConditionComplexity(NOW);
    if (r.templates.length > 0) {
      expect(r.most_complex_template).toBe(r.templates[0].template_id);
    }
  });

  test('avg_complexity = round(sum / count)', () => {
    const r = buildRuleTemplateConditionComplexity(NOW);
    const sum = r.templates.reduce((s, t) => s + t.complexity_score, 0);
    const expected = Math.round(sum / r.templates.length);
    expect(r.avg_complexity).toBe(expected);
  });

  test('platform-static: same result for different timestamps', () => {
    const r1 = buildRuleTemplateConditionComplexity(NOW);
    const r2 = buildRuleTemplateConditionComplexity(new Date('2026-06-01T00:00:00.000Z'));
    expect(r1.total_templates).toBe(r2.total_templates);
    expect(r1.avg_complexity).toBe(r2.avg_complexity);
  });
});

// ─── Route tests ──────────────────────────────────────────────────────

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ANALYST = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'risk_analyst',
};

describe('GET /v1/rules/templates/condition-complexity', () => {
  test('analyst+ 200 with envelope', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/rules/templates/condition-complexity')
      .set(HEADERS_ANALYST);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(Array.isArray(r.body.body.templates)).toBe(true);
  });

  test('403 for unknown role', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/rules/templates/condition-complexity')
      .set({ ...HEADERS_ANALYST, 'X-Apex-Role': 'unknown_role' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/rules/templates/condition-complexity')
      .set({ 'X-Apex-Role': 'risk_analyst' });
    expect(r.status).toBe(400);
  });

  test('platform-static across tenants', async () => {
    const { app } = makeApp({});
    const r1 = await request(app)
      .get('/v1/rules/templates/condition-complexity')
      .set({ ...HEADERS_ANALYST, 'X-Tenant-ID': 'BANK_DEMO' });
    const r2 = await request(app)
      .get('/v1/rules/templates/condition-complexity')
      .set({ ...HEADERS_ANALYST, 'X-Tenant-ID': 'BIL' });
    expect(r1.body.body.total_templates).toBe(r2.body.body.total_templates);
  });
});
