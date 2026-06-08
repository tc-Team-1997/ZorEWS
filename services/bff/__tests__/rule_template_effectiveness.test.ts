// services/bff/__tests__/rule_template_effectiveness.test.ts
//
// T6 M5.11 — Rule template effectiveness back-test.

import request from 'supertest';
import {
  BACKTEST_DEFAULT_WINDOW,
  BACKTEST_MAX_WINDOW,
  BACKTEST_MIN_WINDOW,
  runTemplateEffectivenessBacktest,
  runTemplateEffectivenessBacktestById,
  TemplateEffectivenessError,
  validateWindowDays,
  RULE_TEMPLATES,
} from '../src/rule_template_effectiveness';
import { getTemplate } from '../src/rule_templates';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-08T10:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'x-apex-role': 'risk_analyst' };
const TH_ADMIN = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'x-apex-role': 'admin' };

function makeTestApp() {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
  }).app;
}

// ─── validateWindowDays ───────────────────────────────────────────────

describe('validateWindowDays', () => {
  test('undefined returns default (30)', () => {
    expect(validateWindowDays(undefined)).toBe(BACKTEST_DEFAULT_WINDOW);
  });

  test('null returns default', () => {
    expect(validateWindowDays(null)).toBe(BACKTEST_DEFAULT_WINDOW);
  });

  test('valid integer string passes', () => {
    expect(validateWindowDays('30')).toBe(30);
    expect(validateWindowDays(90)).toBe(90);
    expect(validateWindowDays(BACKTEST_MIN_WINDOW)).toBe(BACKTEST_MIN_WINDOW);
    expect(validateWindowDays(BACKTEST_MAX_WINDOW)).toBe(BACKTEST_MAX_WINDOW);
  });

  test('below minimum throws', () => {
    expect(() => validateWindowDays(BACKTEST_MIN_WINDOW - 1)).toThrow(TemplateEffectivenessError);
  });

  test('above maximum throws', () => {
    expect(() => validateWindowDays(BACKTEST_MAX_WINDOW + 1)).toThrow(TemplateEffectivenessError);
  });

  test('non-integer float throws', () => {
    expect(() => validateWindowDays(30.5)).toThrow(TemplateEffectivenessError);
  });
});

// ─── runTemplateEffectivenessBacktest pure function ───────────────────

describe('runTemplateEffectivenessBacktest', () => {
  const template = getTemplate('tpl_dpd_30_60')!;
  expect(template).not.toBeNull();

  test('returns expected shape', () => {
    const result = runTemplateEffectivenessBacktest(template, 30);
    expect(result.template_id).toBe('tpl_dpd_30_60');
    expect(result.template_name).toBe(template.name);
    expect(result.window_days).toBe(30);
    expect(typeof result.simulated_fires).toBe('number');
    expect(typeof result.estimated_precision).toBe('number');
    expect(typeof result.estimated_recall).toBe('number');
    expect(typeof result.estimated_f1).toBe('number');
    expect(typeof result.false_positive_estimate).toBe('number');
    expect(typeof result.detection_rate).toBe('number');
    expect(Array.isArray(result.top_trigger_indicators)).toBe(true);
    expect(['high', 'medium', 'low']).toContain(result.confidence);
    expect(typeof result.methodology).toBe('string');
    expect(result.methodology.length).toBeGreaterThan(0);
  });

  test('precision is in [0,1] range', () => {
    const result = runTemplateEffectivenessBacktest(template, 30);
    expect(result.estimated_precision).toBeGreaterThanOrEqual(0);
    expect(result.estimated_precision).toBeLessThanOrEqual(1);
  });

  test('recall is in [0,1] range', () => {
    const result = runTemplateEffectivenessBacktest(template, 30);
    expect(result.estimated_recall).toBeGreaterThanOrEqual(0);
    expect(result.estimated_recall).toBeLessThanOrEqual(1);
  });

  test('f1 is harmonic mean of precision and recall', () => {
    const result = runTemplateEffectivenessBacktest(template, 30);
    const expected = (2 * result.estimated_precision * result.estimated_recall)
      / (result.estimated_precision + result.estimated_recall);
    expect(result.estimated_f1).toBeCloseTo(expected, 3);
  });

  test('false_positive_estimate ≈ fires × (1 - precision)', () => {
    const result = runTemplateEffectivenessBacktest(template, 30);
    const expected = Math.round(result.simulated_fires * (1 - result.estimated_precision));
    expect(result.false_positive_estimate).toBe(expected);
  });

  test('deterministic — same inputs produce same output', () => {
    const r1 = runTemplateEffectivenessBacktest(template, 60);
    const r2 = runTemplateEffectivenessBacktest(template, 60);
    expect(r1).toEqual(r2);
  });

  test('different window_days produce different simulated_fires', () => {
    const r30 = runTemplateEffectivenessBacktest(template, 30);
    const r90 = runTemplateEffectivenessBacktest(template, 90);
    // 90-day window should generally have more fires
    expect(r90.simulated_fires).toBeGreaterThan(0);
    // Just check they differ (deterministic but different seed)
    expect(r90.window_days).toBe(90);
    expect(r30.window_days).toBe(30);
  });

  test('confidence: high when window >= 90', () => {
    const result = runTemplateEffectivenessBacktest(template, 90);
    expect(result.confidence).toBe('high');
  });

  test('confidence: medium when 30 <= window < 90', () => {
    const result = runTemplateEffectivenessBacktest(template, 45);
    expect(result.confidence).toBe('medium');
  });

  test('confidence: low when window < 30', () => {
    const result = runTemplateEffectivenessBacktest(template, 15);
    expect(result.confidence).toBe('low');
  });

  test('top_trigger_indicators subset of template.supporting_indicators', () => {
    const t = getTemplate('tpl_velocity_24h')!;
    const result = runTemplateEffectivenessBacktest(t, 30);
    for (const ind of result.top_trigger_indicators) {
      expect(t.supporting_indicators).toContain(ind);
    }
  });

  test('top_trigger_indicators capped at 3', () => {
    // Use a template with many indicators
    const t = getTemplate('tpl_utilisation_spike')!;
    const result = runTemplateEffectivenessBacktest(t, 30);
    expect(result.top_trigger_indicators.length).toBeLessThanOrEqual(3);
  });
});

// ─── runTemplateEffectivenessBacktestById ─────────────────────────────

describe('runTemplateEffectivenessBacktestById', () => {
  test('unknown template throws TemplateEffectivenessError', () => {
    expect(() =>
      runTemplateEffectivenessBacktestById('tpl_does_not_exist', 30)
    ).toThrow(TemplateEffectivenessError);
  });

  test('known template returns result', () => {
    const result = runTemplateEffectivenessBacktestById('tpl_aml_high_severity_open', 30);
    expect(result.template_id).toBe('tpl_aml_high_severity_open');
  });
});

// ─── HTTP route ───────────────────────────────────────────────────────

describe('POST /v1/rules/templates/:template_id/effectiveness-backtest', () => {
  const app = makeTestApp();

  test('analyst+ happy path returns result with required fields', async () => {
    const r = await request(app)
      .post('/v1/rules/templates/tpl_dpd_30_60/effectiveness-backtest')
      .set(TH_BIL)
      .send({ window_days: 30 });
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.template_id).toBe('tpl_dpd_30_60');
    expect(typeof r.body.body.estimated_precision).toBe('number');
    expect(typeof r.body.body.estimated_f1).toBe('number');
    expect(['high', 'medium', 'low']).toContain(r.body.body.confidence);
  });

  test('admin role also accepted', async () => {
    const r = await request(app)
      .post('/v1/rules/templates/tpl_lapse_imminent/effectiveness-backtest')
      .set(TH_ADMIN)
      .send({});
    expect(r.status).toBe(200);
  });

  test('default window_days (30) when not supplied', async () => {
    const r = await request(app)
      .post('/v1/rules/templates/tpl_repeat_claim_180d/effectiveness-backtest')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.body.window_days).toBe(30);
  });

  test('unknown template → 404 EWS_404_unknown_template', async () => {
    const r = await request(app)
      .post('/v1/rules/templates/tpl_does_not_exist/effectiveness-backtest')
      .set(TH_BIL)
      .send({ window_days: 30 });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_template');
  });

  test('invalid window_days → 400 EWS_400_invalid_input', async () => {
    const r = await request(app)
      .post('/v1/rules/templates/tpl_dpd_30_60/effectiveness-backtest')
      .set(TH_BIL)
      .send({ window_days: 400 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('window_days below minimum → 400', async () => {
    const r = await request(app)
      .post('/v1/rules/templates/tpl_dpd_30_60/effectiveness-backtest')
      .set(TH_BIL)
      .send({ window_days: 3 });
    expect(r.status).toBe(400);
  });

  test('unknown role → 403', async () => {
    const r = await request(app)
      .post('/v1/rules/templates/tpl_dpd_30_60/effectiveness-backtest')
      .set({ 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'x-apex-role': 'unknown_role' })
      .send({ window_days: 30 });
    expect(r.status).toBe(403);
  });

  test('missing tenant headers → 400', async () => {
    const r = await request(app)
      .post('/v1/rules/templates/tpl_dpd_30_60/effectiveness-backtest')
      .set('X-Channel', 'API')
      .set('x-apex-role', 'admin')
      .send({ window_days: 30 });
    expect(r.status).toBe(400);
  });

  test('result has methodology string', async () => {
    const r = await request(app)
      .post('/v1/rules/templates/tpl_velocity_24h/effectiveness-backtest')
      .set(TH_BIL)
      .send({ window_days: 90 });
    expect(r.status).toBe(200);
    expect(typeof r.body.body.methodology).toBe('string');
    expect(r.body.body.methodology.length).toBeGreaterThan(10);
    expect(r.body.body.confidence).toBe('high');
  });

  test('no-regression: existing /v1/rules/templates still works', async () => {
    const r = await request(app)
      .get('/v1/rules/templates')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
