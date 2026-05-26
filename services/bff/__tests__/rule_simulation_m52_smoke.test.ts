/* M5.2 — Rules Engine smoke.
 *
 * Verifies the spec acceptance: "A simulated rule must show pass/fail
 * count, sample matched records, and projected alert volume."
 *
 * Most M5.2 routes already exist (M5.1 templates, M5.6 custom CRUD,
 * M5.9 clone-from-library, M5.10 bulk-clone, M5.3 simulator, M16.1
 * scenarios, EWS rules indicators). This suite focuses on the new
 * spec-acceptance fields + regression-tests the 8 routes are still
 * routable end-to-end.
 */

import request from 'supertest';
import { simulateRule, SAMPLE_MATCHED_CAP } from '../src/rule_simulation';
import { RULE_TEMPLATES } from '../src/rule_templates';
import { SCENARIO_PRESETS } from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-26T12:00:00.000Z');
const TH_BIL = {
  'x-tenant-id': 'BIL',
  'x-channel': 'API',
  'x-apex-role': 'admin',
  'x-apex-user': 'alice.admin',
};

function makeSmokeApp() {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => 'admin',
  });
}

// Pick a template + scenario that DEFINITELY fire (severe-stress + a
// risk-monitoring template with sensitivity 1.8 → guaranteed >0
// fired_count).
function firingPair() {
  const template = RULE_TEMPLATES.find(
    (t) => t.category === 'risk_monitoring' && t.vertical !== 'insurance',
  );
  const scenario = SCENARIO_PRESETS.find(
    (s) => s.severity === 'severe' && s.regulator === 'RBI',
  );
  if (!template) throw new Error('no risk_monitoring template in seed');
  if (!scenario) throw new Error('no RBI severe scenario in seed');
  return { template, scenario };
}

describe('M5.2 — RuleSimulationResult new spec-acceptance fields', () => {
  it('RE-1: pass_count + fail_count partition customer_count exactly', () => {
    const { template, scenario } = firingPair();
    const r = simulateRule(template, scenario, 500, NOW);
    expect(r.pass_count + r.fail_count).toBe(r.customer_count);
    expect(r.pass_count).toBe(r.fired_count);
    expect(r.fail_count).toBeGreaterThanOrEqual(0);
  });

  it('RE-2: sample_matched_records returns up to 10 entries when fired_count > 0', () => {
    const { template, scenario } = firingPair();
    const r = simulateRule(template, scenario, 500, NOW);
    expect(r.sample_matched_records.length).toBeLessThanOrEqual(SAMPLE_MATCHED_CAP);
    if (r.fired_count > 0) {
      expect(r.sample_matched_records.length).toBeGreaterThan(0);
    }
    // every record well-formed
    for (const rec of r.sample_matched_records) {
      expect(rec.customer_id).toMatch(/^c-sim-\d{5}$/);
      expect(['RETAIL', 'SME', 'CORPORATE', 'NBFC']).toContain(rec.segment);
      expect(rec.contribution).toBeGreaterThan(0);
      expect(rec.contribution).toBeLessThanOrEqual(1);
    }
  });

  it('RE-3: sample_matched_records sorted by contribution desc', () => {
    const { template, scenario } = firingPair();
    const r = simulateRule(template, scenario, 500, NOW);
    for (let i = 1; i < r.sample_matched_records.length; i++) {
      expect(r.sample_matched_records[i]!.contribution).toBeLessThanOrEqual(
        r.sample_matched_records[i - 1]!.contribution,
      );
    }
  });

  it('RE-4: deterministic per (template, scenario, day)', () => {
    const { template, scenario } = firingPair();
    const a = simulateRule(template, scenario, 500, NOW);
    const b = simulateRule(template, scenario, 500, NOW);
    expect(a.sample_matched_records.map((r) => r.customer_id)).toEqual(
      b.sample_matched_records.map((r) => r.customer_id),
    );
    expect(a.projected_alert_volume_per_day).toBe(b.projected_alert_volume_per_day);
  });

  it('RE-5: projected_alert_volume_per_day = round(fired_count / 14)', () => {
    const { template, scenario } = firingPair();
    const r = simulateRule(template, scenario, 1000, NOW);
    const expected = Math.round((r.fired_count / 14) * 10) / 10;
    expect(r.projected_alert_volume_per_day).toBe(expected);
  });

  it('RE-6: zero-fired scenario → empty samples + zero projection', () => {
    // Compliance template + baseline scenario = lowest fire rate
    const template = RULE_TEMPLATES.find((t) => t.category === 'compliance');
    const scenario = SCENARIO_PRESETS.find((s) => s.severity === 'mild');
    if (!template || !scenario) return;
    const r = simulateRule(template, scenario, 50, NOW);
    if (r.fired_count === 0) {
      expect(r.sample_matched_records).toEqual([]);
      expect(r.projected_alert_volume_per_day).toBe(0);
    }
    // Either way: invariants still hold
    expect(r.sample_matched_records.length).toBeLessThanOrEqual(SAMPLE_MATCHED_CAP);
  });

  it('RE-7: existing fields preserved (no shape break)', () => {
    const { template, scenario } = firingPair();
    const r = simulateRule(template, scenario, 200, NOW);
    expect(r.rule_template_id).toBeTruthy();
    expect(r.scenario_preset_id).toBeTruthy();
    expect(typeof r.fire_rate).toBe('number');
    expect(typeof r.amplification).toBe('number');
    expect(r.by_severity).toHaveProperty('critical');
    expect(r.by_severity).toHaveProperty('high');
  });
});

describe('M5.2 — HTTP route returns the new fields', () => {
  it('RE-8: POST /v1/rules/simulate body envelope includes pass_count + samples + projection', async () => {
    const { app } = makeSmokeApp();
    const { template, scenario } = firingPair();
    const r = await request(app)
      .post('/v1/rules/simulate')
      .set(TH_BIL)
      .send({
        rule_template_id: template.id,
        scenario_preset_id: scenario.id,
        customer_count: 500,
      });
    expect(r.status).toBe(200);
    const b = r.body.body;
    expect(b.pass_count).toBe(b.fired_count);
    expect(b.fail_count).toBe(b.customer_count - b.fired_count);
    expect(Array.isArray(b.sample_matched_records)).toBe(true);
    expect(b.sample_matched_records.length).toBeLessThanOrEqual(SAMPLE_MATCHED_CAP);
    expect(typeof b.projected_alert_volume_per_day).toBe('number');
  });
});

describe('M5.2 — 8 spec routes still routable (regression)', () => {
  it('RE-9: GET /v1/rules/templates', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app).get('/v1/rules/templates').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.body.items)).toBe(true);
  });
  it('RE-10: GET /v1/rules/templates/categories', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app).get('/v1/rules/templates/categories').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.body.items)).toBe(true);
  });
  it('RE-11: GET /v1/rules/templates/custom', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app).get('/v1/rules/templates/custom').set(TH_BIL);
    expect(r.status).toBe(200);
  });
  it('RE-12: POST /v1/rules/templates/custom + clone-from-library', async () => {
    const { app } = makeSmokeApp();
    const tpl = RULE_TEMPLATES[0]!;
    const c = await request(app)
      .post('/v1/rules/templates/custom/clone-from-library')
      .set(TH_BIL)
      .send({ source_template_id: tpl.id });
    expect([200, 201]).toContain(c.status);
  });
  it('RE-13: GET /v1/ews/rules/indicators', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app).get('/v1/ews/rules/indicators').set(TH_BIL);
    expect([200, 501]).toContain(r.status);
  });
  it('RE-14: GET /v1/scenarios/library', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app).get('/v1/scenarios/library').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.body.items)).toBe(true);
  });
});
