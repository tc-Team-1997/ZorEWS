// services/bff/__tests__/rule_template_action_inventory.test.ts
//
// T6 M5.15 — Rule template recommended-action inventory.

import request from 'supertest';
import { mapTemplateActionUsage } from '../src/rule_template_action_inventory';
import { RULE_TEMPLATES, type RecommendedAction } from '../src/rule_templates';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── mapTemplateActionUsage — pure ────────────────────────────────────

describe('M5.15 — mapTemplateActionUsage', () => {
  test('every BIL action appears (including unused)', () => {
    const out = mapTemplateActionUsage();
    const ids = new Set(out.actions.map((r) => r.action));
    const expected: RecommendedAction[] = [
      'open_case',
      'notify_supervisor',
      'pause_disbursement',
      'request_documents',
      'flag_for_review',
      'auto_decline',
    ];
    for (const a of expected) {
      expect(ids.has(a)).toBe(true);
    }
    expect(out.actions).toHaveLength(expected.length);
  });

  test('total_templates matches library size', () => {
    const out = mapTemplateActionUsage();
    expect(out.total_templates).toBe(RULE_TEMPLATES.length);
  });

  test('row counts match per-template references', () => {
    const out = mapTemplateActionUsage();
    // For each action, count references manually from the library and
    // assert the row.reference_count matches.
    for (const row of out.actions) {
      const manual = RULE_TEMPLATES.filter((t) => t.recommended_actions.includes(row.action)).length;
      expect(row.reference_count).toBe(manual);
    }
  });

  test('templates list ordered by template_id asc', () => {
    const out = mapTemplateActionUsage();
    for (const row of out.actions) {
      const ids = row.templates.map((t) => t.template_id);
      expect(ids).toEqual([...ids].sort());
    }
  });

  test('actions sorted by reference_count desc with action name asc tie-break', () => {
    const out = mapTemplateActionUsage();
    for (let i = 1; i < out.actions.length; i++) {
      const prev = out.actions[i - 1]!;
      const curr = out.actions[i]!;
      if (prev.reference_count === curr.reference_count) {
        expect(prev.action.localeCompare(curr.action)).toBeLessThan(0);
      } else {
        expect(prev.reference_count).toBeGreaterThan(curr.reference_count);
      }
    }
  });

  test('by_category partition sums to reference_count', () => {
    const out = mapTemplateActionUsage();
    for (const row of out.actions) {
      const sum = Object.values(row.by_category).reduce((a, b) => a + b, 0);
      expect(sum).toBe(row.reference_count);
    }
  });

  test('by_severity partition sums to reference_count', () => {
    const out = mapTemplateActionUsage();
    for (const row of out.actions) {
      const sum = Object.values(row.by_severity).reduce((a, b) => a + b, 0);
      expect(sum).toBe(row.reference_count);
    }
  });

  test('by_category has every category key present', () => {
    const out = mapTemplateActionUsage();
    for (const row of out.actions) {
      expect(Object.keys(row.by_category).sort()).toEqual([
        'compliance',
        'fraud_detection',
        'operational',
        'risk_monitoring',
        'underwriting',
      ]);
    }
  });

  test('most_referenced points at the top row', () => {
    const out = mapTemplateActionUsage();
    if (out.most_referenced !== null) {
      expect(out.most_referenced).toBe(out.actions[0]!.action);
      expect(out.actions[0]!.reference_count).toBeGreaterThan(0);
    }
  });

  test('unused_actions captures zero-reference rows only', () => {
    const out = mapTemplateActionUsage();
    for (const action of out.unused_actions) {
      const row = out.actions.find((r) => r.action === action)!;
      expect(row.reference_count).toBe(0);
    }
    // Reverse direction
    for (const row of out.actions) {
      if (row.reference_count === 0) {
        expect(out.unused_actions).toContain(row.action);
      } else {
        expect(out.unused_actions).not.toContain(row.action);
      }
    }
  });

  test('every template field on a row entry is non-empty', () => {
    const out = mapTemplateActionUsage();
    for (const row of out.actions) {
      for (const t of row.templates) {
        expect(t.template_id.length).toBeGreaterThan(0);
        expect(t.name.length).toBeGreaterThan(0);
        expect(t.category).toBeDefined();
        expect(t.vertical).toBeDefined();
        expect(t.recommended_severity).toBeDefined();
      }
    }
  });

  test('total template references sums match library', () => {
    const out = mapTemplateActionUsage();
    // Sum of every row.reference_count = sum of unique-action-per-template
    // across the library (because of intra-template dedup).
    let expected = 0;
    for (const tpl of RULE_TEMPLATES) {
      expected += new Set(tpl.recommended_actions).size;
    }
    const actual = out.actions.reduce((sum, r) => sum + r.reference_count, 0);
    expect(actual).toBe(expected);
  });
});

// ─── GET /v1/rules/templates/action-inventory ────────────────────────

function makeInventoryApp(role = 'risk_analyst') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M5.15 — GET /v1/rules/templates/action-inventory', () => {
  test('analyst+ → 200 with full inventory', async () => {
    const { app } = makeInventoryApp('risk_analyst');
    const r = await request(app).get('/v1/rules/templates/action-inventory').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_templates).toBe(RULE_TEMPLATES.length);
    expect(r.body.body.actions.length).toBeGreaterThan(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeInventoryApp('case_owner');
    const r = await request(app).get('/v1/rules/templates/action-inventory').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL and BANK_DEMO see the same inventory', async () => {
    const { app } = makeInventoryApp('admin');
    const bil = await request(app).get('/v1/rules/templates/action-inventory').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/rules/templates/action-inventory')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });

  test('M5.1 /v1/rules/templates still works (additive route)', async () => {
    const { app } = makeInventoryApp('admin');
    const r = await request(app).get('/v1/rules/templates').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
