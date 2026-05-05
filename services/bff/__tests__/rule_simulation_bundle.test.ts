// services/bff/__tests__/rule_simulation_bundle.test.ts
//
// T6 M5.4 — Rule simulation bundle.

import request from 'supertest';
import { simulateRuleBundle } from '../src/rule_simulation_bundle';
import { RULE_TEMPLATES } from '../src/rule_templates';
import { SCENARIO_PRESETS } from '../src/scenario_library';
import { RuleSimulationError } from '../src/rule_simulation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T17:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const FIRST_TEMPLATE = RULE_TEMPLATES[0]!;

function makeBundleApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('simulateRuleBundle', () => {
  test('happy: returns one result per scenario, sorted desc', () => {
    const r = simulateRuleBundle({ rule_template_id: FIRST_TEMPLATE.id }, NOW);
    expect(r.results.length).toBe(SCENARIO_PRESETS.length);
    for (let i = 1; i < r.results.length; i++) {
      expect(r.results[i - 1]!.fire_rate).toBeGreaterThanOrEqual(r.results[i]!.fire_rate);
    }
  });

  test('worst is the highest fire_rate, best is lowest', () => {
    const r = simulateRuleBundle({ rule_template_id: FIRST_TEMPLATE.id }, NOW);
    expect(r.worst.fire_rate).toBe(r.results[0]!.fire_rate);
    expect(r.best.fire_rate).toBe(r.results[r.results.length - 1]!.fire_rate);
  });

  test('mean_fire_rate is the arithmetic mean', () => {
    const r = simulateRuleBundle({ rule_template_id: FIRST_TEMPLATE.id }, NOW);
    const expected = r.results.reduce((acc, x) => acc + x.fire_rate, 0) / r.results.length;
    expect(r.mean_fire_rate).toBeCloseTo(expected);
  });

  test('preset_ids subset honoured', () => {
    const r = simulateRuleBundle(
      {
        rule_template_id: FIRST_TEMPLATE.id,
        preset_ids: ['preset_baseline_no_shock', 'preset_rbi_severely_adverse'],
      },
      NOW,
    );
    expect(r.results.length).toBe(2);
  });

  test('customer_count default 200', () => {
    const r = simulateRuleBundle({ rule_template_id: FIRST_TEMPLATE.id }, NOW);
    expect(r.customer_count).toBe(200);
  });

  test('customer_count honoured', () => {
    const r = simulateRuleBundle(
      { rule_template_id: FIRST_TEMPLATE.id, customer_count: 1000 },
      NOW,
    );
    expect(r.customer_count).toBe(1000);
  });

  test('unknown rule_template_id → unknown_template', () => {
    try {
      simulateRuleBundle({ rule_template_id: 'NO-SUCH' }, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as RuleSimulationError).code).toBe('unknown_template');
    }
  });

  test('unknown preset id in subset → unknown_scenario', () => {
    try {
      simulateRuleBundle(
        { rule_template_id: FIRST_TEMPLATE.id, preset_ids: ['NO-SUCH'] },
        NOW,
      );
      fail('expected throw');
    } catch (e) {
      expect((e as RuleSimulationError).code).toBe('unknown_scenario');
    }
  });

  test('empty preset_ids[] → invalid_input', () => {
    expect(() =>
      simulateRuleBundle({ rule_template_id: FIRST_TEMPLATE.id, preset_ids: [] }, NOW),
    ).toThrow(/non-empty/);
  });

  test('> 50 preset_ids → invalid_input', () => {
    expect(() =>
      simulateRuleBundle(
        {
          rule_template_id: FIRST_TEMPLATE.id,
          preset_ids: new Array(51).fill('preset_baseline_no_shock'),
        },
        NOW,
      ),
    ).toThrow(/at most 50/);
  });

  test('customer_count out of range → invalid_input', () => {
    expect(() =>
      simulateRuleBundle(
        { rule_template_id: FIRST_TEMPLATE.id, customer_count: 50000 },
        NOW,
      ),
    ).toThrow(/\[1, 10000\]/);
  });
});

describe('POST /v1/rules/simulate/bundle', () => {
  test('analyst+: 200 with bundle body', async () => {
    const { app } = makeBundleApp('risk_analyst');
    const r = await request(app)
      .post('/v1/rules/simulate/bundle')
      .set(TH_BIL)
      .send({ rule_template_id: FIRST_TEMPLATE.id });
    expect(r.status).toBe(200);
    expect(r.body.body.results.length).toBe(SCENARIO_PRESETS.length);
  });

  test('accepts enveloped body', async () => {
    const { app } = makeBundleApp('admin');
    const r = await request(app)
      .post('/v1/rules/simulate/bundle')
      .set(TH_BIL)
      .send({
        header: { requestId: 'r-1' },
        body: { rule_template_id: FIRST_TEMPLATE.id },
      });
    expect(r.status).toBe(200);
  });

  test('unknown template → 404', async () => {
    const { app } = makeBundleApp('admin');
    const r = await request(app)
      .post('/v1/rules/simulate/bundle')
      .set(TH_BIL)
      .send({ rule_template_id: 'NO-SUCH' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_template');
  });

  test('unknown preset → 404', async () => {
    const { app } = makeBundleApp('admin');
    const r = await request(app)
      .post('/v1/rules/simulate/bundle')
      .set(TH_BIL)
      .send({ rule_template_id: FIRST_TEMPLATE.id, preset_ids: ['NO-SUCH'] });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_scenario');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBundleApp('case_owner');
    const r = await request(app)
      .post('/v1/rules/simulate/bundle')
      .set(TH_BIL)
      .send({ rule_template_id: FIRST_TEMPLATE.id });
    expect(r.status).toBe(403);
  });
});
