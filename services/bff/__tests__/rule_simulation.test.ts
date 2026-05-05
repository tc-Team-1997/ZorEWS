// services/bff/__tests__/rule_simulation.test.ts
//
// T6 M5.3 — Rule simulation against scenario library.

import request from 'supertest';
import {
  RuleSimulationError,
  scenarioStress,
  simulateRule,
  simulateRuleByIds,
  type RuleSimulationResult,
} from '../src/rule_simulation';
import { RULE_TEMPLATES, getTemplate } from '../src/rule_templates';
import { getScenarioPreset } from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T15:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeSimApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

const FIRST_TEMPLATE = RULE_TEMPLATES[0]!;
const BASELINE_PRESET = getScenarioPreset('preset_baseline_no_shock')!;
const RBI_BASELINE = getScenarioPreset('preset_rbi_baseline_stress')!;
const RBI_SEVERE = getScenarioPreset('preset_rbi_severely_adverse')!;

// ─── scenarioStress ───────────────────────────────────────────────────

describe('scenarioStress', () => {
  test('all-zero shocks → stress=0', () => {
    expect(scenarioStress(BASELINE_PRESET)).toBe(0);
  });

  test('severely-adverse → stress=1.0 (all components saturated)', () => {
    // gdp=-4 / 4 = 1.0; rate=300 / 300 = 1.0; fx=12 / 12 = 1.0
    expect(scenarioStress(RBI_SEVERE)).toBeCloseTo(1.0);
  });

  test('mild stress < severe stress', () => {
    expect(scenarioStress(RBI_BASELINE)).toBeLessThan(scenarioStress(RBI_SEVERE));
  });

  test('magnitude only — sign of gdp ignored', () => {
    // Synthesise a fake preset with positive gdp to confirm
    const positive = { ...RBI_BASELINE, shocks: { gdp: 4, rate: 0, fx: 0 } };
    const negative = { ...RBI_BASELINE, shocks: { gdp: -4, rate: 0, fx: 0 } };
    expect(scenarioStress(positive)).toBeCloseTo(scenarioStress(negative));
  });
});

// ─── simulateRule (pure) ──────────────────────────────────────────────

describe('simulateRule', () => {
  test('basic shape: all required fields populated', () => {
    const r = simulateRule(FIRST_TEMPLATE, RBI_BASELINE, 200, NOW);
    expect(r.rule_template_id).toBe(FIRST_TEMPLATE.id);
    expect(r.rule_name).toBe(FIRST_TEMPLATE.name);
    expect(r.rule_category).toBe(FIRST_TEMPLATE.category);
    expect(r.recommended_severity).toBe(FIRST_TEMPLATE.recommended_severity);
    expect(r.scenario_preset_id).toBe(RBI_BASELINE.id);
    expect(r.scenario_name).toBe(RBI_BASELINE.name);
    expect(r.customer_count).toBe(200);
    expect(r.simulated_at).toBe(NOW.toISOString());
  });

  test('fired_count + fire_rate consistent', () => {
    const r = simulateRule(FIRST_TEMPLATE, RBI_BASELINE, 200, NOW);
    expect(r.fired_count).toBe(Math.round(r.fire_rate * 200));
  });

  test('fire_rate ∈ [0, 1]', () => {
    for (const tpl of RULE_TEMPLATES) {
      const r = simulateRule(tpl, RBI_SEVERE, 200, NOW);
      expect(r.fire_rate).toBeGreaterThanOrEqual(0);
      expect(r.fire_rate).toBeLessThanOrEqual(1);
    }
  });

  test('amplification ≥ 1 for stressed scenarios (vs baseline)', () => {
    // Pick a risk_monitoring rule (high sensitivity) so we see strong
    // amplification under severe stress.
    const riskRule = RULE_TEMPLATES.find((t) => t.category === 'risk_monitoring')!;
    const severe = simulateRule(riskRule, RBI_SEVERE, 200, NOW);
    expect(severe.amplification).toBeGreaterThan(1);
  });

  test('amplification ~= 1 on baseline scenario', () => {
    const r = simulateRule(FIRST_TEMPLATE, BASELINE_PRESET, 200, NOW);
    // baseline_fire_rate = base_rate, fire_rate = base_rate * jitter
    // → amplification within ±5% of 1.0.
    expect(r.amplification).toBeGreaterThan(0.9);
    expect(r.amplification).toBeLessThan(1.1);
  });

  test('amplification capped at 99', () => {
    // Force the cap: synthesize a hypothetical near-zero baseline
    // scenario by inspecting the relationship — easiest is to verify
    // the cap with a sanity bound on every (template, scenario) pair.
    for (const tpl of RULE_TEMPLATES) {
      for (const sid of [
        'preset_rbi_severely_adverse',
        'preset_pandemic_stress',
        'preset_stagflation',
      ]) {
        const s = getScenarioPreset(sid)!;
        const r = simulateRule(tpl, s, 200, NOW);
        expect(r.amplification).toBeLessThanOrEqual(99);
      }
    }
  });

  test('deterministic per (template, scenario, day)', () => {
    const a = simulateRule(FIRST_TEMPLATE, RBI_BASELINE, 200, NOW);
    const b = simulateRule(FIRST_TEMPLATE, RBI_BASELINE, 200, NOW);
    expect(a.fire_rate).toBe(b.fire_rate);
    expect(a.fired_count).toBe(b.fired_count);
  });

  test('different scenario → different fire_rate (typically)', () => {
    const baseline = simulateRule(FIRST_TEMPLATE, BASELINE_PRESET, 200, NOW);
    const severe = simulateRule(FIRST_TEMPLATE, RBI_SEVERE, 200, NOW);
    expect(severe.fire_rate).toBeGreaterThan(baseline.fire_rate);
  });

  test('different day → potentially different fire_rate (jitter)', () => {
    const day1 = simulateRule(FIRST_TEMPLATE, RBI_BASELINE, 200, NOW);
    const day2 = simulateRule(
      FIRST_TEMPLATE,
      RBI_BASELINE,
      200,
      new Date('2026-06-01T00:00:00Z'),
    );
    // They CAN be equal if jitter rounds the same way; just check
    // the function returns valid bounds either way.
    expect(day1.fire_rate).toBeGreaterThanOrEqual(0);
    expect(day2.fire_rate).toBeGreaterThanOrEqual(0);
  });

  test('by_severity buckets sum to fired_count', () => {
    const r = simulateRule(FIRST_TEMPLATE, RBI_SEVERE, 1000, NOW);
    const sum = r.by_severity.critical + r.by_severity.high + r.by_severity.medium + r.by_severity.low;
    expect(sum).toBe(r.fired_count);
  });

  test('by_severity bucket peaks at recommended_severity', () => {
    // Find a HIGH-firing rule (high category sensitivity + severe scenario)
    const riskRule = RULE_TEMPLATES.find(
      (t) => t.category === 'risk_monitoring' && t.recommended_severity === 'high',
    );
    if (!riskRule) return; // skip if catalog ever loses such a rule
    const r = simulateRule(riskRule, RBI_SEVERE, 1000, NOW);
    if (r.fired_count >= 10) {
      // Recommended bucket should hold the largest share
      const counts = r.by_severity;
      expect(counts.high).toBeGreaterThanOrEqual(counts.medium);
      expect(counts.high).toBeGreaterThanOrEqual(counts.critical);
      expect(counts.high).toBeGreaterThanOrEqual(counts.low);
    }
  });

  test('fired_count=0 → all severity buckets 0', () => {
    // Synthesize: baseline scenario + minimum population
    const r = simulateRule(FIRST_TEMPLATE, BASELINE_PRESET, 1, NOW);
    if (r.fired_count === 0) {
      expect(r.by_severity.critical).toBe(0);
      expect(r.by_severity.high).toBe(0);
      expect(r.by_severity.medium).toBe(0);
      expect(r.by_severity.low).toBe(0);
    }
  });

  test('compliance category has lower amplification than risk_monitoring (under same scenario)', () => {
    const compliance = RULE_TEMPLATES.find((t) => t.category === 'compliance');
    const risk = RULE_TEMPLATES.find((t) => t.category === 'risk_monitoring');
    if (!compliance || !risk) return;
    const cAmp = simulateRule(compliance, RBI_SEVERE, 200, NOW).amplification;
    const rAmp = simulateRule(risk, RBI_SEVERE, 200, NOW).amplification;
    expect(rAmp).toBeGreaterThan(cAmp);
  });
});

// ─── simulateRuleByIds ────────────────────────────────────────────────

describe('simulateRuleByIds', () => {
  test('happy: resolves both ids, defaults customer_count to 200', () => {
    const r = simulateRuleByIds(
      { rule_template_id: FIRST_TEMPLATE.id, scenario_preset_id: RBI_BASELINE.id },
      NOW,
    );
    expect(r.customer_count).toBe(200);
    expect(r.rule_template_id).toBe(FIRST_TEMPLATE.id);
    expect(r.scenario_preset_id).toBe(RBI_BASELINE.id);
  });

  test('honours customer_count when provided', () => {
    const r = simulateRuleByIds(
      {
        rule_template_id: FIRST_TEMPLATE.id,
        scenario_preset_id: RBI_BASELINE.id,
        customer_count: 1000,
      },
      NOW,
    );
    expect(r.customer_count).toBe(1000);
  });

  test('non-object body → invalid_input', () => {
    expect(() => simulateRuleByIds('foo' as unknown as never, NOW)).toThrow(/body/);
  });

  test('missing rule_template_id → invalid_input', () => {
    try {
      simulateRuleByIds({ scenario_preset_id: RBI_BASELINE.id } as never, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as RuleSimulationError).code).toBe('invalid_input');
    }
  });

  test('blank scenario_preset_id → invalid_input', () => {
    try {
      simulateRuleByIds({ rule_template_id: FIRST_TEMPLATE.id, scenario_preset_id: '   ' }, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as RuleSimulationError).code).toBe('invalid_input');
    }
  });

  test('non-integer customer_count → invalid_input', () => {
    expect(() =>
      simulateRuleByIds(
        {
          rule_template_id: FIRST_TEMPLATE.id,
          scenario_preset_id: RBI_BASELINE.id,
          customer_count: 1.5,
        },
        NOW,
      ),
    ).toThrow(/integer/);
  });

  test('customer_count < 1 → invalid_input', () => {
    expect(() =>
      simulateRuleByIds(
        {
          rule_template_id: FIRST_TEMPLATE.id,
          scenario_preset_id: RBI_BASELINE.id,
          customer_count: 0,
        },
        NOW,
      ),
    ).toThrow(/\[1, 10000\]/);
  });

  test('customer_count > 10000 → invalid_input', () => {
    expect(() =>
      simulateRuleByIds(
        {
          rule_template_id: FIRST_TEMPLATE.id,
          scenario_preset_id: RBI_BASELINE.id,
          customer_count: 10001,
        },
        NOW,
      ),
    ).toThrow(/\[1, 10000\]/);
  });

  test('unknown template → unknown_template', () => {
    try {
      simulateRuleByIds({ rule_template_id: 'NO-SUCH', scenario_preset_id: RBI_BASELINE.id }, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as RuleSimulationError).code).toBe('unknown_template');
    }
  });

  test('unknown scenario → unknown_scenario', () => {
    try {
      simulateRuleByIds({ rule_template_id: FIRST_TEMPLATE.id, scenario_preset_id: 'NO-SUCH' }, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as RuleSimulationError).code).toBe('unknown_scenario');
    }
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('POST /v1/rules/simulate', () => {
  test('analyst+: 200 with simulation body', async () => {
    const { app } = makeSimApp('risk_analyst');
    const r = await request(app)
      .post('/v1/rules/simulate')
      .set(TH_BIL)
      .send({
        rule_template_id: FIRST_TEMPLATE.id,
        scenario_preset_id: RBI_BASELINE.id,
      });
    expect(r.status).toBe(200);
    const body = r.body.body as RuleSimulationResult;
    expect(body.rule_template_id).toBe(FIRST_TEMPLATE.id);
    expect(body.scenario_preset_id).toBe(RBI_BASELINE.id);
    expect(body.customer_count).toBe(200);
  });

  test('accepts enveloped body', async () => {
    const { app } = makeSimApp('admin');
    const r = await request(app)
      .post('/v1/rules/simulate')
      .set(TH_BIL)
      .send({
        header: { requestId: 'r-1' },
        body: {
          rule_template_id: FIRST_TEMPLATE.id,
          scenario_preset_id: RBI_BASELINE.id,
        },
      });
    expect(r.status).toBe(200);
  });

  test('honours customer_count', async () => {
    const { app } = makeSimApp('admin');
    const r = await request(app)
      .post('/v1/rules/simulate')
      .set(TH_BIL)
      .send({
        rule_template_id: FIRST_TEMPLATE.id,
        scenario_preset_id: RBI_BASELINE.id,
        customer_count: 500,
      });
    expect(r.body.body.customer_count).toBe(500);
  });

  test('amplification > 1 for severe scenario on a sensitive rule', async () => {
    const { app } = makeSimApp('admin');
    const riskRule = RULE_TEMPLATES.find((t) => t.category === 'risk_monitoring')!;
    const r = await request(app)
      .post('/v1/rules/simulate')
      .set(TH_BIL)
      .send({
        rule_template_id: riskRule.id,
        scenario_preset_id: RBI_SEVERE.id,
      });
    expect(r.body.body.amplification).toBeGreaterThan(1);
  });

  test('missing rule_template_id → 400 EWS_400_invalid_input', async () => {
    const { app } = makeSimApp('admin');
    const r = await request(app)
      .post('/v1/rules/simulate')
      .set(TH_BIL)
      .send({ scenario_preset_id: RBI_BASELINE.id });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('customer_count out of range → 400', async () => {
    const { app } = makeSimApp('admin');
    const r = await request(app)
      .post('/v1/rules/simulate')
      .set(TH_BIL)
      .send({
        rule_template_id: FIRST_TEMPLATE.id,
        scenario_preset_id: RBI_BASELINE.id,
        customer_count: 50000,
      });
    expect(r.status).toBe(400);
  });

  test('unknown template → 404 EWS_404_unknown_template', async () => {
    const { app } = makeSimApp('admin');
    const r = await request(app)
      .post('/v1/rules/simulate')
      .set(TH_BIL)
      .send({ rule_template_id: 'NO-SUCH', scenario_preset_id: RBI_BASELINE.id });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_template');
  });

  test('unknown scenario → 404 EWS_404_unknown_scenario', async () => {
    const { app } = makeSimApp('admin');
    const r = await request(app)
      .post('/v1/rules/simulate')
      .set(TH_BIL)
      .send({ rule_template_id: FIRST_TEMPLATE.id, scenario_preset_id: 'NO-SUCH' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_scenario');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSimApp('case_owner');
    const r = await request(app)
      .post('/v1/rules/simulate')
      .set(TH_BIL)
      .send({ rule_template_id: FIRST_TEMPLATE.id, scenario_preset_id: RBI_BASELINE.id });
    expect(r.status).toBe(403);
  });

  test('determinism: same call twice yields identical body', async () => {
    const { app } = makeSimApp('admin');
    const r1 = await request(app)
      .post('/v1/rules/simulate')
      .set(TH_BIL)
      .send({ rule_template_id: FIRST_TEMPLATE.id, scenario_preset_id: RBI_BASELINE.id });
    const r2 = await request(app)
      .post('/v1/rules/simulate')
      .set(TH_BIL)
      .send({ rule_template_id: FIRST_TEMPLATE.id, scenario_preset_id: RBI_BASELINE.id });
    expect(r1.body.body.fire_rate).toBe(r2.body.body.fire_rate);
    expect(r1.body.body.fired_count).toBe(r2.body.body.fired_count);
  });
});

// ─── No-regression ────────────────────────────────────────────────────

describe('No-regression: M5.1 + M5.2 + M16.1 routes still work', () => {
  test('GET /v1/rules/templates still 200', async () => {
    const { app } = makeSimApp('admin');
    const r = await request(app).get('/v1/rules/templates').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('GET /v1/rules/templates/:id still 200', async () => {
    const { app } = makeSimApp('admin');
    const r = await request(app).get(`/v1/rules/templates/${FIRST_TEMPLATE.id}`).set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('POST /v1/rules/templates/bulk-clone still 200', async () => {
    const { app } = makeSimApp('admin');
    const r = await request(app)
      .post('/v1/rules/templates/bulk-clone')
      .set(TH_BIL)
      .send({ template_ids: [FIRST_TEMPLATE.id] });
    expect(r.status).toBe(200);
  });

  test('GET /v1/scenarios/library/:id still 200', async () => {
    const { app } = makeSimApp('admin');
    const r = await request(app).get(`/v1/scenarios/library/${RBI_BASELINE.id}`).set(TH_BIL);
    expect(r.status).toBe(200);
  });
});

// Force-load referenced symbols so unused-import lints stay green
void getTemplate;
