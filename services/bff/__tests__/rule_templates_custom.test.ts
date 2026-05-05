// services/bff/__tests__/rule_templates_custom.test.ts
//
// T6 M5.6 — Custom rule templates per-tenant.

import request from 'supertest';
import {
  CustomRuleTemplateError,
  InMemoryCustomRuleTemplateStore,
  getEffectiveRuleTemplate,
} from '../src/rule_templates_custom';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-06T03:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const VALID = {
  name: 'BIL bespoke — agent fraud',
  description: 'Custom rule for BIL agent fraud-cluster signal',
  vertical: 'insurance',
  category: 'fraud_detection',
  condition_pseudocode: 'count(claims.filed_by_agent_id) > 5 in 30d',
  recommended_severity: 'high',
  recommended_actions: ['open_case', 'flag_for_review'],
  supporting_indicators: ['AGT-001', 'CLM-001'],
};

function makeTplApp(role = 'admin') {
  const store = new InMemoryCustomRuleTemplateStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    customRuleTemplateStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

describe('InMemoryCustomRuleTemplateStore', () => {
  test('happy: create returns valid RuleTemplate', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    const t = s.create('BIL', VALID, 'admin', NOW);
    expect(t.id).toMatch(/^tpl_custom_/);
    expect(t.vertical).toBe('insurance');
    expect(t.recommended_actions).toEqual(['open_case', 'flag_for_review']);
  });

  test('rejects empty name', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    expect(() => s.create('BIL', { ...VALID, name: '' }, 'admin', NOW)).toThrow(/name/);
  });

  test('rejects invalid vertical', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    expect(() => s.create('BIL', { ...VALID, vertical: 'crypto' }, 'admin', NOW)).toThrow(
      /vertical/,
    );
  });

  test('rejects invalid category', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    expect(() => s.create('BIL', { ...VALID, category: 'tax' }, 'admin', NOW)).toThrow(
      /category/,
    );
  });

  test('rejects invalid severity', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    expect(() =>
      s.create('BIL', { ...VALID, recommended_severity: 'extreme' }, 'admin', NOW),
    ).toThrow(/severity/);
  });

  test('rejects empty recommended_actions', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    expect(() =>
      s.create('BIL', { ...VALID, recommended_actions: [] }, 'admin', NOW),
    ).toThrow(/recommended_actions/);
  });

  test('rejects unknown action', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    expect(() =>
      s.create('BIL', { ...VALID, recommended_actions: ['delete_account'] }, 'admin', NOW),
    ).toThrow(/recommended_action/);
  });

  test('rejects empty supporting_indicators', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    expect(() =>
      s.create('BIL', { ...VALID, supporting_indicators: [] }, 'admin', NOW),
    ).toThrow(/supporting_indicators/);
  });

  test('rejects > 25 supporting_indicators', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    const too_many = new Array(26).fill('IND-X');
    expect(() =>
      s.create('BIL', { ...VALID, supporting_indicators: too_many }, 'admin', NOW),
    ).toThrow(/≤ 25/);
  });

  test('rejects condition_pseudocode > 1000 chars', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    expect(() =>
      s.create('BIL', { ...VALID, condition_pseudocode: 'x'.repeat(1001) }, 'admin', NOW),
    ).toThrow(/condition_pseudocode/);
  });

  test('dedupes recommended_actions and supporting_indicators', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    const t = s.create(
      'BIL',
      {
        ...VALID,
        recommended_actions: ['open_case', 'open_case', 'flag_for_review'],
        supporting_indicators: ['IND-1', 'IND-1', 'IND-2'],
      },
      'admin',
      NOW,
    );
    expect(t.recommended_actions).toEqual(['open_case', 'flag_for_review']);
    expect(t.supporting_indicators).toEqual(['IND-1', 'IND-2']);
  });

  test('cap_reached after 30 templates', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    for (let i = 0; i < 30; i++) {
      s.create('BIL', { ...VALID, name: `t-${i}` }, 'admin', NOW);
    }
    try {
      s.create('BIL', VALID, 'admin', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as CustomRuleTemplateError).code).toBe('cap_reached');
    }
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    const a = s.create('BIL', VALID, 'admin', NOW);
    s.create('BANK_DEMO', VALID, 'admin', NOW);
    expect(s.get('BIL', a.id)?.id).toBe(a.id);
    expect(s.get('BANK_DEMO', a.id)).toBeNull();
  });

  test('default source_doc mentions creator', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    const noDoc = { ...VALID } as Record<string, unknown>;
    delete noDoc.source_doc;
    const t = s.create('BIL', noDoc, 'compliance.lead', NOW);
    expect(t.source_doc).toContain('compliance.lead');
  });

  test('delete returns true on hit, false on miss', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    const t = s.create('BIL', VALID, 'admin', NOW);
    expect(s.delete('BIL', t.id)).toBe(true);
    expect(s.delete('BIL', t.id)).toBe(false);
  });
});

describe('getEffectiveRuleTemplate', () => {
  test('library id resolves from library', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    const t = getEffectiveRuleTemplate(s, 'BIL', 'tpl_dpd_30_60');
    expect(t?.id).toBe('tpl_dpd_30_60');
  });

  test('custom id resolves from per-tenant store', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    const created = s.create('BIL', VALID, 'admin', NOW);
    const t = getEffectiveRuleTemplate(s, 'BIL', created.id);
    expect(t?.name).toBe(VALID.name);
  });

  test('custom id from a DIFFERENT tenant returns null', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    const created = s.create('BIL', VALID, 'admin', NOW);
    expect(getEffectiveRuleTemplate(s, 'BANK_DEMO', created.id)).toBeNull();
  });

  test('unknown id returns null', () => {
    const s = new InMemoryCustomRuleTemplateStore();
    expect(getEffectiveRuleTemplate(s, 'BIL', 'NO-SUCH')).toBeNull();
  });
});

describe('Routes', () => {
  test('GET list 200 empty', async () => {
    const { app } = makeTplApp('admin');
    const r = await request(app).get('/v1/rules/templates/custom').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });

  test('POST 201 → list shows it', async () => {
    const { app } = makeTplApp('admin');
    const c = await request(app).post('/v1/rules/templates/custom').set(TH_BIL).send(VALID);
    expect(c.status).toBe(201);
    expect(c.body.body.id).toMatch(/^tpl_custom_/);
    const list = await request(app).get('/v1/rules/templates/custom').set(TH_BIL);
    expect(list.body.body.total).toBe(1);
  });

  test('POST validation: bad vertical → 400', async () => {
    const { app } = makeTplApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/custom')
      .set(TH_BIL)
      .send({ ...VALID, vertical: 'crypto' });
    expect(r.status).toBe(400);
  });

  test('DELETE 204 then 404', async () => {
    const { app } = makeTplApp('admin');
    const c = await request(app).post('/v1/rules/templates/custom').set(TH_BIL).send(VALID);
    const id = c.body.body.id;
    const d1 = await request(app).delete(`/v1/rules/templates/custom/${id}`).set(TH_BIL);
    expect(d1.status).toBe(204);
    const d2 = await request(app).delete(`/v1/rules/templates/custom/${id}`).set(TH_BIL);
    expect(d2.status).toBe(404);
  });

  test('cross-tenant isolation', async () => {
    const { app } = makeTplApp('admin');
    await request(app).post('/v1/rules/templates/custom').set(TH_BIL).send(VALID);
    const other = await request(app)
      .get('/v1/rules/templates/custom')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(other.body.body.total).toBe(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTplApp('case_owner');
    const r = await request(app).get('/v1/rules/templates/custom').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M5.1 GET /:id still works (literal /custom didn\'t shadow)', async () => {
    const { app } = makeTplApp('admin');
    const r = await request(app).get('/v1/rules/templates/tpl_dpd_30_60').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.id).toBe('tpl_dpd_30_60');
  });
});
