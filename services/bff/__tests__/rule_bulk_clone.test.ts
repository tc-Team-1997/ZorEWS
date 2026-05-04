// services/bff/__tests__/rule_bulk_clone.test.ts
//
// T6 M5.2 — Rule bulk-clone.

import request from 'supertest';
import {
  BulkCloneError,
  expandBulkClone,
  resolveBulkClone,
  type BulkCloneInput,
  type BulkCloneResult,
  type ClonedRule,
} from '../src/rule_bulk_clone';
import { RULE_TEMPLATES, listTemplates } from '../src/rule_templates';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeBcApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── resolveBulkClone ─────────────────────────────────────────────────

describe('resolveBulkClone', () => {
  test('by_ids mode resolves listed templates in order', () => {
    const out = resolveBulkClone({
      template_ids: ['tpl_dpd_30_60', 'tpl_repeat_claim_180d'],
    });
    expect(out.selection.mode).toBe('by_ids');
    expect(out.requested_count).toBe(2);
    expect(out.templates.length).toBe(2);
    expect(out.templates[0]!.template.id).toBe('tpl_dpd_30_60');
    expect(out.templates[1]!.template.id).toBe('tpl_repeat_claim_180d');
    expect(out.skipped).toEqual([]);
  });

  test('by_filter mode resolves all matching templates', () => {
    const out = resolveBulkClone({ category: 'fraud_detection' });
    expect(out.selection.mode).toBe('by_filter');
    if (out.selection.mode === 'by_filter') {
      expect(out.selection.category).toBe('fraud_detection');
    }
    expect(out.templates.length).toBeGreaterThan(0);
    for (const r of out.templates) {
      expect(r.template.category).toBe('fraud_detection');
    }
  });

  test('by_filter vertical only', () => {
    const out = resolveBulkClone({ vertical: 'banking' });
    expect(out.templates.length).toBeGreaterThan(0);
    for (const r of out.templates) {
      expect(['banking', 'both']).toContain(r.template.vertical);
    }
  });

  test('by_filter (category + vertical) AND', () => {
    const out = resolveBulkClone({ category: 'compliance', vertical: 'both' });
    for (const r of out.templates) {
      expect(r.template.category).toBe('compliance');
      expect(r.template.vertical).toBe('both');
    }
  });

  test('both modes supplied → invalid_input', () => {
    expect(() =>
      resolveBulkClone({ template_ids: ['tpl_dpd_30_60'], category: 'fraud_detection' }),
    ).toThrow(/either.*not both/);
  });

  test('neither supplied → invalid_input', () => {
    expect(() => resolveBulkClone({})).toThrow(/required/);
  });

  test('empty template_ids[] treated as not supplied → invalid_input', () => {
    expect(() => resolveBulkClone({ template_ids: [] })).toThrow(/required/);
  });

  test('> 50 template_ids → invalid_input', () => {
    const ids = new Array(51).fill('tpl_dpd_30_60');
    expect(() => resolveBulkClone({ template_ids: ids })).toThrow(/at most 50/);
  });

  test('non-string template_id → invalid_input', () => {
    expect(() =>
      resolveBulkClone({ template_ids: [42 as unknown as string] }),
    ).toThrow(/non-empty string/);
  });

  test('unknown template_id → skipped[unknown_template], not throw', () => {
    const out = resolveBulkClone({
      template_ids: ['tpl_dpd_30_60', 'NO-SUCH', 'tpl_repeat_claim_180d'],
    });
    expect(out.templates.length).toBe(2);
    expect(out.skipped).toEqual([{ template_id: 'NO-SUCH', reason: 'unknown_template' }]);
  });

  test('duplicate template_id → first kept, second skipped[duplicate]', () => {
    const out = resolveBulkClone({
      template_ids: ['tpl_dpd_30_60', 'tpl_dpd_30_60', 'tpl_repeat_claim_180d'],
    });
    expect(out.templates.length).toBe(2); // first + second-distinct
    expect(out.templates.map((r) => r.template.id)).toEqual([
      'tpl_dpd_30_60',
      'tpl_repeat_claim_180d',
    ]);
    expect(out.skipped).toEqual([{ template_id: 'tpl_dpd_30_60', reason: 'duplicate' }]);
  });

  test('invalid category → invalid_category', () => {
    try {
      resolveBulkClone({ category: 'crypto' as never });
      fail('expected throw');
    } catch (e) {
      expect((e as BulkCloneError).code).toBe('invalid_category');
    }
  });

  test('invalid vertical → invalid_vertical', () => {
    try {
      resolveBulkClone({ vertical: 'hybrid' as never });
      fail('expected throw');
    } catch (e) {
      expect((e as BulkCloneError).code).toBe('invalid_vertical');
    }
  });

  test('name_prefix > 80 chars → invalid_input', () => {
    expect(() =>
      resolveBulkClone({ template_ids: ['tpl_dpd_30_60'], name_prefix: 'p'.repeat(81) }),
    ).toThrow(/≤ 80/);
  });

  test('non-string name_prefix → invalid_input', () => {
    expect(() =>
      resolveBulkClone({
        template_ids: ['tpl_dpd_30_60'],
        name_prefix: 42 as unknown as string,
      }),
    ).toThrow(/name_prefix/);
  });
});

// ─── expandBulkClone ──────────────────────────────────────────────────

describe('expandBulkClone', () => {
  test('happy path — clones in input order, all in draft state', () => {
    const out = expandBulkClone(
      { template_ids: ['tpl_dpd_30_60', 'tpl_repeat_claim_180d'] },
      NOW,
    );
    expect(out.cloned.length).toBe(2);
    expect(out.cloned[0]!.source_template_id).toBe('tpl_dpd_30_60');
    expect(out.cloned[1]!.source_template_id).toBe('tpl_repeat_claim_180d');
    for (const c of out.cloned) {
      expect(c.state).toBe('draft');
      expect(c.condition_pseudocode.length).toBeGreaterThan(0);
      expect(c.recommended_actions.length).toBeGreaterThan(0);
    }
  });

  test('clones preserve template fields (severity, actions, indicators, vertical, category)', () => {
    const out = expandBulkClone({ template_ids: ['tpl_dpd_30_60'] }, NOW);
    const tpl = RULE_TEMPLATES.find((t) => t.id === 'tpl_dpd_30_60')!;
    const clone = out.cloned[0]!;
    expect(clone.recommended_severity).toBe(tpl.recommended_severity);
    expect(clone.recommended_actions).toEqual(tpl.recommended_actions);
    expect(clone.supporting_indicators).toEqual(tpl.supporting_indicators);
    expect(clone.category).toBe(tpl.category);
    expect(clone.vertical).toBe(tpl.vertical);
    expect(clone.description).toBe(tpl.description);
    expect(clone.condition_pseudocode).toBe(tpl.condition_pseudocode);
  });

  test('name_prefix is applied to clone.name', () => {
    const out = expandBulkClone(
      { template_ids: ['tpl_dpd_30_60'], name_prefix: 'BIL-prod-' },
      NOW,
    );
    expect(out.cloned[0]!.name).toMatch(/^BIL-prod-/);
    expect(out.cloned[0]!.name).toContain('DPD 30-60');
  });

  test('empty name_prefix passes name through unchanged', () => {
    const out = expandBulkClone({ template_ids: ['tpl_dpd_30_60'], name_prefix: '' }, NOW);
    const tpl = RULE_TEMPLATES.find((t) => t.id === 'tpl_dpd_30_60')!;
    expect(out.cloned[0]!.name).toBe(tpl.name);
  });

  test('clone arrays are detached from template (mutation safe)', () => {
    const out = expandBulkClone({ template_ids: ['tpl_dpd_30_60'] }, NOW);
    const clone = out.cloned[0]!;
    clone.recommended_actions.push('auto_decline');
    clone.supporting_indicators.push('FAKE-001');
    // Re-resolve and check the source template is unchanged.
    const out2 = expandBulkClone({ template_ids: ['tpl_dpd_30_60'] }, NOW);
    expect(out2.cloned[0]!.recommended_actions).not.toContain('auto_decline');
    expect(out2.cloned[0]!.supporting_indicators).not.toContain('FAKE-001');
  });

  test('mixed valid + unknown ids → cloned only for valid; skipped[unknown] reported', () => {
    const out = expandBulkClone(
      { template_ids: ['tpl_dpd_30_60', 'NO-SUCH', 'tpl_repeat_claim_180d'] },
      NOW,
    );
    expect(out.requested_count).toBe(3);
    expect(out.cloned.length).toBe(2);
    expect(out.skipped).toEqual([{ template_id: 'NO-SUCH', reason: 'unknown_template' }]);
  });

  test('by_filter mode: requested_count = matched template count', () => {
    const out = expandBulkClone({ category: 'fraud_detection' }, NOW);
    const matchedCount = listTemplates({ category: 'fraud_detection' }).length;
    expect(out.requested_count).toBe(matchedCount);
    expect(out.cloned.length).toBe(matchedCount);
    expect(out.skipped).toEqual([]);
  });

  test('returns generated_at = now', () => {
    const out = expandBulkClone({ template_ids: ['tpl_dpd_30_60'] }, NOW);
    expect(out.generated_at).toBe(NOW.toISOString());
  });

  test('selection echoes the chosen mode + filter', () => {
    const out1 = expandBulkClone({ template_ids: ['tpl_dpd_30_60'] }, NOW);
    expect(out1.selection.mode).toBe('by_ids');
    const out2 = expandBulkClone({ category: 'compliance', vertical: 'both' }, NOW);
    if (out2.selection.mode === 'by_filter') {
      expect(out2.selection.category).toBe('compliance');
      expect(out2.selection.vertical).toBe('both');
    }
  });
});

// ─── Route ────────────────────────────────────────────────────────────

describe('POST /v1/rules/templates/bulk-clone', () => {
  test('analyst+: 200 with cloned[] in input order', async () => {
    const { app } = makeBcApp('risk_analyst');
    const r = await request(app)
      .post('/v1/rules/templates/bulk-clone')
      .set(TH_BIL)
      .send({ template_ids: ['tpl_dpd_30_60', 'tpl_repeat_claim_180d'] });
    expect(r.status).toBe(200);
    const body = r.body.body as BulkCloneResult;
    expect(body.cloned.length).toBe(2);
    expect(body.cloned[0]!.source_template_id).toBe('tpl_dpd_30_60');
  });

  test('accepts an enveloped request body', async () => {
    const { app } = makeBcApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/bulk-clone')
      .set(TH_BIL)
      .send({
        header: { requestId: 'r-1' },
        body: { category: 'compliance' },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.selection.mode).toBe('by_filter');
  });

  test('by_filter category=fraud_detection narrows', async () => {
    const { app } = makeBcApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/bulk-clone')
      .set(TH_BIL)
      .send({ category: 'fraud_detection' });
    expect(r.status).toBe(200);
    for (const c of r.body.body.cloned as ClonedRule[]) {
      expect(c.category).toBe('fraud_detection');
    }
  });

  test('name_prefix is forwarded', async () => {
    const { app } = makeBcApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/bulk-clone')
      .set(TH_BIL)
      .send({ template_ids: ['tpl_dpd_30_60'], name_prefix: 'BIL-' });
    expect(r.body.body.cloned[0].name).toMatch(/^BIL-/);
  });

  test('both modes supplied → 400 EWS_400_invalid_input', async () => {
    const { app } = makeBcApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/bulk-clone')
      .set(TH_BIL)
      .send({ template_ids: ['tpl_dpd_30_60'], category: 'fraud_detection' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('neither supplied → 400 EWS_400_invalid_input', async () => {
    const { app } = makeBcApp('admin');
    const r = await request(app).post('/v1/rules/templates/bulk-clone').set(TH_BIL).send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('invalid category → 400 EWS_400_invalid_category', async () => {
    const { app } = makeBcApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/bulk-clone')
      .set(TH_BIL)
      .send({ category: 'crypto' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_category');
  });

  test('invalid vertical → 400 EWS_400_invalid_vertical', async () => {
    const { app } = makeBcApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/bulk-clone')
      .set(TH_BIL)
      .send({ vertical: 'hybrid' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_vertical');
  });

  test('> 50 ids → 400 EWS_400_invalid_input', async () => {
    const { app } = makeBcApp('admin');
    const ids = new Array(51).fill('tpl_dpd_30_60');
    const r = await request(app)
      .post('/v1/rules/templates/bulk-clone')
      .set(TH_BIL)
      .send({ template_ids: ids });
    expect(r.status).toBe(400);
  });

  test('unknown ids show in skipped[]', async () => {
    const { app } = makeBcApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/bulk-clone')
      .set(TH_BIL)
      .send({ template_ids: ['tpl_dpd_30_60', 'NO-SUCH'] });
    expect(r.status).toBe(200);
    expect(r.body.body.cloned.length).toBe(1);
    expect(r.body.body.skipped[0].template_id).toBe('NO-SUCH');
    expect(r.body.body.skipped[0].reason).toBe('unknown_template');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBcApp('case_owner');
    const r = await request(app)
      .post('/v1/rules/templates/bulk-clone')
      .set(TH_BIL)
      .send({ template_ids: ['tpl_dpd_30_60'] });
    expect(r.status).toBe(403);
  });
});

// ─── No-regression ────────────────────────────────────────────────────

describe('No-regression: M5.1 routes still work', () => {
  test('GET /v1/rules/templates still 200', async () => {
    const { app } = makeBcApp('admin');
    const r = await request(app).get('/v1/rules/templates').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(12);
  });

  test('GET /v1/rules/templates/:id still 200 (bulk-clone path didn\'t shadow it)', async () => {
    const { app } = makeBcApp('admin');
    const r = await request(app).get('/v1/rules/templates/tpl_dpd_30_60').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.id).toBe('tpl_dpd_30_60');
  });

  test('GET /v1/rules/templates/categories still 200', async () => {
    const { app } = makeBcApp('admin');
    const r = await request(app).get('/v1/rules/templates/categories').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
