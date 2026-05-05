// services/bff/__tests__/rule_template_diff.test.ts
//
// T6 M5.5 — Rule template diff.

import request from 'supertest';
import {
  RuleTemplateDiffError,
  diffRuleTemplates,
  diffRuleTemplatesByIds,
} from '../src/rule_template_diff';
import { getTemplate } from '../src/rule_templates';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-06T02:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const T1 = getTemplate('tpl_dpd_30_60')!;
const T2 = getTemplate('tpl_utilisation_spike')!;

function makeDiffApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('diffRuleTemplates', () => {
  test('shape: 8 entries (3 enum + 3 string + 2 array)', () => {
    const r = diffRuleTemplates(T1, T2, NOW);
    expect(r.entries.length).toBe(8);
    const kinds = r.entries.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'enum').length).toBe(3);
    expect(kinds.filter((k) => k === 'string').length).toBe(3);
    expect(kinds.filter((k) => k === 'array').length).toBe(2);
  });

  test('same template compared to itself: every entry changed=false', () => {
    const r = diffRuleTemplates(T1, T1, NOW);
    expect(r.entries.every((e) => !e.changed)).toBe(true);
    expect(r.changed_entries).toEqual([]);
  });

  test('array entry surfaces added/removed/common', () => {
    const r = diffRuleTemplates(T1, T2, NOW);
    const ind = r.entries.find((e) => e.field === 'supporting_indicators')!;
    expect(ind.kind).toBe('array');
    expect(ind.added).toBeDefined();
    expect(ind.removed).toBeDefined();
    expect(ind.common).toBeDefined();
  });

  test('array set-diff: added contains right-only, removed contains left-only', () => {
    const fakeLeft = { ...T1, supporting_indicators: ['A', 'B', 'C'] };
    const fakeRight = { ...T1, supporting_indicators: ['B', 'C', 'D'] };
    const r = diffRuleTemplates(
      fakeLeft as typeof T1,
      fakeRight as typeof T1,
      NOW,
    );
    const ind = r.entries.find((e) => e.field === 'supporting_indicators')!;
    expect(ind.added).toEqual(['D']);
    expect(ind.removed).toEqual(['A']);
    expect(ind.common).toEqual(['B', 'C']);
    expect(ind.changed).toBe(true);
  });

  test('array changed=false when same set (any order)', () => {
    const fakeLeft = { ...T1, recommended_actions: ['notify', 'route'] };
    const fakeRight = { ...T1, recommended_actions: ['route', 'notify'] };
    const r = diffRuleTemplates(
      fakeLeft as typeof T1,
      fakeRight as typeof T1,
      NOW,
    );
    const ra = r.entries.find((e) => e.field === 'recommended_actions')!;
    expect(ra.changed).toBe(false);
  });

  test('enum field changed flag accurate', () => {
    const r = diffRuleTemplates(T1, T2, NOW);
    const cat = r.entries.find((e) => e.field === 'category')!;
    expect(cat.changed).toBe(T1.category !== T2.category);
  });

  test('left/right echoed in result', () => {
    const r = diffRuleTemplates(T1, T2, NOW);
    expect(r.left.id).toBe(T1.id);
    expect(r.right.id).toBe(T2.id);
  });

  test('generated_at echoes now', () => {
    const r = diffRuleTemplates(T1, T2, NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
  });
});

describe('diffRuleTemplatesByIds', () => {
  test('happy: resolves both ids', () => {
    const r = diffRuleTemplatesByIds(T1.id, T2.id, NOW);
    expect(r.left.id).toBe(T1.id);
    expect(r.right.id).toBe(T2.id);
  });

  test('missing left_id → invalid_input', () => {
    expect(() => diffRuleTemplatesByIds(undefined, T2.id, NOW)).toThrow(
      RuleTemplateDiffError,
    );
  });

  test('blank right_id → invalid_input', () => {
    try {
      diffRuleTemplatesByIds(T1.id, '   ', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as RuleTemplateDiffError).code).toBe('invalid_input');
    }
  });

  test('non-string left_id rejected', () => {
    expect(() => diffRuleTemplatesByIds(42, T2.id, NOW)).toThrow(/left_id/);
  });

  test('same id → same_template', () => {
    try {
      diffRuleTemplatesByIds(T1.id, T1.id, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as RuleTemplateDiffError).code).toBe('same_template');
    }
  });

  test('unknown left → unknown_template', () => {
    try {
      diffRuleTemplatesByIds('NO-SUCH', T2.id, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as RuleTemplateDiffError).code).toBe('unknown_template');
    }
  });

  test('unknown right → unknown_template', () => {
    try {
      diffRuleTemplatesByIds(T1.id, 'NO-SUCH', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as RuleTemplateDiffError).code).toBe('unknown_template');
    }
  });
});

describe('POST /v1/rules/templates/diff', () => {
  test('analyst+: 200 with diff body', async () => {
    const { app } = makeDiffApp('risk_analyst');
    const r = await request(app)
      .post('/v1/rules/templates/diff')
      .set(TH_BIL)
      .send({ left_id: T1.id, right_id: T2.id });
    expect(r.status).toBe(200);
    expect(r.body.body.left.id).toBe(T1.id);
    expect(r.body.body.right.id).toBe(T2.id);
    expect(r.body.body.entries.length).toBe(8);
  });

  test('accepts enveloped body', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/diff')
      .set(TH_BIL)
      .send({
        header: { requestId: 'r-1' },
        body: { left_id: T1.id, right_id: T2.id },
      });
    expect(r.status).toBe(200);
  });

  test('missing left_id → 400 EWS_400_invalid_input', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/diff')
      .set(TH_BIL)
      .send({ right_id: T2.id });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('same id → 400 EWS_400_same_template', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/diff')
      .set(TH_BIL)
      .send({ left_id: T1.id, right_id: T1.id });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_same_template');
  });

  test('unknown id → 404 EWS_404_unknown_template', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/diff')
      .set(TH_BIL)
      .send({ left_id: 'NO-SUCH', right_id: T2.id });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_template');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeDiffApp('case_owner');
    const r = await request(app)
      .post('/v1/rules/templates/diff')
      .set(TH_BIL)
      .send({ left_id: T1.id, right_id: T2.id });
    expect(r.status).toBe(403);
  });

  test('M5.1 GET /v1/rules/templates/:id still works (literal /diff didn\'t shadow)', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app).get(`/v1/rules/templates/${T1.id}`).set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
