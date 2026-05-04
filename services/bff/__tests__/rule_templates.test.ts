// services/bff/__tests__/rule_templates.test.ts
//
// T6 M5.1 — BIL rule template library.

import request from 'supertest';
import {
  RULE_TEMPLATES,
  getTemplate,
  isRuleTemplateCategory,
  isRuleTemplateVertical,
  listCategories,
  listTemplates,
  type RuleTemplate,
} from '../src/rule_templates';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTplApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Type guards ───────────────────────────────────────────────────────

describe('Type guards', () => {
  test('isRuleTemplateCategory', () => {
    expect(isRuleTemplateCategory('risk_monitoring')).toBe(true);
    expect(isRuleTemplateCategory('underwriting')).toBe(true);
    expect(isRuleTemplateCategory('FOO')).toBe(false);
  });
  test('isRuleTemplateVertical', () => {
    expect(isRuleTemplateVertical('banking')).toBe(true);
    expect(isRuleTemplateVertical('insurance')).toBe(true);
    expect(isRuleTemplateVertical('both')).toBe(true);
    expect(isRuleTemplateVertical('hybrid')).toBe(false);
  });
});

// ─── Schema invariants ─────────────────────────────────────────────────

describe('RULE_TEMPLATES schema', () => {
  test('exactly 12 BIL templates seeded', () => {
    expect(RULE_TEMPLATES.length).toBe(12);
  });

  test('ids unique', () => {
    const ids = RULE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every template declares required fields with valid types', () => {
    for (const t of RULE_TEMPLATES) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.name).toBe('string');
      expect(['banking', 'insurance', 'both']).toContain(t.vertical);
      expect(['risk_monitoring', 'fraud_detection', 'compliance', 'operational', 'underwriting']).toContain(t.category);
      expect(['critical', 'high', 'medium', 'low']).toContain(t.recommended_severity);
      expect(Array.isArray(t.recommended_actions)).toBe(true);
      expect(t.recommended_actions.length).toBeGreaterThan(0);
      for (const a of t.recommended_actions) {
        expect([
          'open_case',
          'notify_supervisor',
          'pause_disbursement',
          'request_documents',
          'flag_for_review',
          'auto_decline',
        ]).toContain(a);
      }
      expect(typeof t.condition_pseudocode).toBe('string');
      expect(t.condition_pseudocode.length).toBeGreaterThan(0);
      expect(Array.isArray(t.supporting_indicators)).toBe(true);
    }
  });

  test('all 5 categories represented', () => {
    const categories = new Set(RULE_TEMPLATES.map((t) => t.category));
    expect(categories.size).toBe(5);
    for (const c of listCategories()) expect(categories.has(c)).toBe(true);
  });

  test('all 3 verticals represented', () => {
    const verticals = new Set(RULE_TEMPLATES.map((t) => t.vertical));
    expect(verticals.has('banking')).toBe(true);
    expect(verticals.has('insurance')).toBe(true);
    expect(verticals.has('both')).toBe(true);
  });

  test('compliance templates use vertical=both (apply to either bank or insurer)', () => {
    const compliance = RULE_TEMPLATES.filter((t) => t.category === 'compliance');
    expect(compliance.length).toBeGreaterThan(0);
    for (const t of compliance) {
      expect(t.vertical).toBe('both');
    }
  });

  test('supporting_indicator ids match the catalogue prefix conventions', () => {
    const VALID_PREFIXES = ['FIN', 'BEH', 'TXN', 'CRD', 'POL', 'CUS', 'AGT', 'CLM', 'OPS'];
    for (const t of RULE_TEMPLATES) {
      for (const ind of t.supporting_indicators) {
        const prefix = ind.split('-')[0];
        expect(VALID_PREFIXES).toContain(prefix);
      }
    }
  });
});

// ─── listTemplates filter behaviour ────────────────────────────────────

describe('listTemplates', () => {
  test('no filter returns all 12', () => {
    expect(listTemplates().length).toBe(12);
  });

  test('vertical=banking returns banking AND both (inclusive)', () => {
    const items = listTemplates({ vertical: 'banking' });
    for (const t of items) {
      expect(['banking', 'both']).toContain(t.vertical);
    }
    // banking-only + both
    const banking = RULE_TEMPLATES.filter((t) => t.vertical === 'banking').length;
    const both = RULE_TEMPLATES.filter((t) => t.vertical === 'both').length;
    expect(items.length).toBe(banking + both);
  });

  test('vertical=insurance returns insurance AND both (inclusive)', () => {
    const items = listTemplates({ vertical: 'insurance' });
    for (const t of items) {
      expect(['insurance', 'both']).toContain(t.vertical);
    }
  });

  test('vertical=both returns ONLY the cross-cutting templates', () => {
    const items = listTemplates({ vertical: 'both' });
    for (const t of items) {
      expect(t.vertical).toBe('both');
    }
    expect(items.length).toBeGreaterThan(0);
  });

  test('category filter narrows correctly', () => {
    const items = listTemplates({ category: 'fraud_detection' });
    for (const t of items) {
      expect(t.category).toBe('fraud_detection');
    }
    expect(items.length).toBeGreaterThan(0);
  });

  test('vertical + category combine as AND', () => {
    const items = listTemplates({ vertical: 'insurance', category: 'fraud_detection' });
    for (const t of items) {
      expect(['insurance', 'both']).toContain(t.vertical);
      expect(t.category).toBe('fraud_detection');
    }
  });

  test('listCategories returns the 5 in canonical order', () => {
    expect(listCategories()).toEqual([
      'risk_monitoring',
      'fraud_detection',
      'compliance',
      'operational',
      'underwriting',
    ]);
  });
});

describe('getTemplate', () => {
  test('returns the template by id', () => {
    expect(getTemplate('tpl_dpd_30_60')!.category).toBe('risk_monitoring');
  });

  test('returns null on miss', () => {
    expect(getTemplate('no.such.template')).toBeNull();
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/rules/templates/categories', () => {
  test('returns the 5 categories', async () => {
    const { app } = makeTplApp('admin');
    const r = await request(app).get('/v1/rules/templates/categories').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.items).toEqual([
      'risk_monitoring',
      'fraud_detection',
      'compliance',
      'operational',
      'underwriting',
    ]);
  });

  test('analyst+ accepted (rules:list)', async () => {
    const { app } = makeTplApp('risk_analyst');
    const r = await request(app).get('/v1/rules/templates/categories').set(TH);
    expect(r.status).toBe(200);
  });

  test('unknown role → 403', async () => {
    const { app } = makeTplApp('case_owner');
    const r = await request(app).get('/v1/rules/templates/categories').set(TH);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/rules/templates', () => {
  test('admin: 200 with all 12', async () => {
    const { app } = makeTplApp('admin');
    const r = await request(app).get('/v1/rules/templates').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(12);
  });

  test('?vertical=banking narrows', async () => {
    const { app } = makeTplApp('admin');
    const r = await request(app).get('/v1/rules/templates?vertical=banking').set(TH);
    for (const t of r.body.body.items as RuleTemplate[]) {
      expect(['banking', 'both']).toContain(t.vertical);
    }
  });

  test('?category=compliance narrows', async () => {
    const { app } = makeTplApp('admin');
    const r = await request(app).get('/v1/rules/templates?category=compliance').set(TH);
    for (const t of r.body.body.items as RuleTemplate[]) {
      expect(t.category).toBe('compliance');
    }
  });

  test('?vertical+category combine as AND', async () => {
    const { app } = makeTplApp('admin');
    const r = await request(app)
      .get('/v1/rules/templates?vertical=insurance&category=fraud_detection')
      .set(TH);
    for (const t of r.body.body.items as RuleTemplate[]) {
      expect(['insurance', 'both']).toContain(t.vertical);
      expect(t.category).toBe('fraud_detection');
    }
  });

  test('?vertical=invalid → 400 EWS_400_invalid_vertical', async () => {
    const { app } = makeTplApp('admin');
    const r = await request(app).get('/v1/rules/templates?vertical=hybrid').set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_vertical');
  });

  test('?category=invalid → 400 EWS_400_invalid_category', async () => {
    const { app } = makeTplApp('admin');
    const r = await request(app).get('/v1/rules/templates?category=foo').set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_category');
  });

  test('unknown role → 403', async () => {
    const { app } = makeTplApp('case_owner');
    const r = await request(app).get('/v1/rules/templates').set(TH);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/rules/templates/:id', () => {
  test('valid id → 200 with full template', async () => {
    const { app } = makeTplApp('admin');
    const r = await request(app).get('/v1/rules/templates/tpl_dpd_30_60').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.id).toBe('tpl_dpd_30_60');
    expect(r.body.body.condition_pseudocode).toMatch(/dpd/);
  });

  test('unknown id → 404 EWS_404_unknown_template', async () => {
    const { app } = makeTplApp('admin');
    const r = await request(app).get('/v1/rules/templates/no.such').set(TH);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_template');
  });
});

describe('Existing /v1/rules/:id still works (no regression)', () => {
  test('templates routes do not shadow /v1/rules/:id', async () => {
    const { app } = makeTplApp('admin');
    // /v1/rules/non-existent-id hits the rules :id handler which 404s
    // for unknown rule ids — confirming the templates routes did NOT
    // greedy-match this path.
    const r = await request(app).get('/v1/rules/non-existent-rule-id').set(TH);
    expect(r.status).toBe(404);
    // The error code from the rules :id handler is EWS_404 (not _unknown_template)
    expect(r.body.error.code).not.toBe('EWS_404_unknown_template');
  });
});
