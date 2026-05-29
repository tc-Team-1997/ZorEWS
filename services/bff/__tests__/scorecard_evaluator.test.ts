import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  evaluateScorecard,
  evaluateScorecardBatch,
  normalizeFactorValues,
  SCORECARD_BATCH_MAX,
  ScorecardEvalError,
} from '../src/scorecard_evaluator';
import type { ScoreFactor } from '../src/risk_score_config';
import type { AlertClassificationConfig } from '../src/alert_classification_config';
import { _resetRiskScoreConfigStore } from '../src/risk_score_config';
import { _resetAlertClassificationConfigStore } from '../src/alert_classification_config';

const NOW = new Date('2026-05-29T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const TENANT = 'BANK_DEMO';
const H = { 'X-Tenant-ID': TENANT, 'X-Channel': 'API', 'x-apex-user': 'alice.admin' };

function app(role = 'risk_analyst') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
  return app;
}

// A balanced 4-factor banking scorecard mirroring the seed (30/25/25/20).
function factors(): ScoreFactor[] {
  const base = {
    tenant_id: TENANT,
    domain: 'banking' as const,
    description: null,
    enabled: true,
    created_by: 'system',
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
  return [
    { ...base, factor_id: 'f1', code: 'OVERDUE', name: 'Overdue / DPD', weight_pct: 30, sort_order: 0 },
    { ...base, factor_id: 'f2', code: 'EMI_BOUNCE', name: 'EMI Bounce', weight_pct: 25, sort_order: 1 },
    { ...base, factor_id: 'f3', code: 'TXN_BEHAVIOUR', name: 'Transaction Behaviour', weight_pct: 25, sort_order: 2 },
    { ...base, factor_id: 'f4', code: 'BUREAU_SCORE', name: 'Bureau Score', weight_pct: 20, sort_order: 3 },
  ];
}

// Default RAG config: green < 60, amber 60–100, red ≥ 100.
function classification(): AlertClassificationConfig {
  return {
    tenant_id: TENANT,
    score_floor: 0,
    amber_min: 60,
    red_min: 100,
    bands: [
      { band: 'green', label: 'Green', color_hex: '#16a34a', severity_rank: 0, min_score: 0, max_score: 60, action_required: 'No action — monitor', range_label: '< 60' },
      { band: 'amber', label: 'Amber', color_hex: '#d97706', severity_rank: 1, min_score: 60, max_score: 100, action_required: 'Review within SLA', range_label: '60–100' },
      { band: 'red', label: 'Red', color_hex: '#dc2626', severity_rank: 2, min_score: 100, max_score: null, action_required: 'Immediate action — escalate', range_label: '≥ 100' },
    ],
    updated_at: new Date(0).toISOString(),
    updated_by: 'system',
  };
}

// ─── normalizeFactorValues ───────────────────────────────────────────

describe('scorecard_evaluator — normalizeFactorValues', () => {
  it('upper-cases keys + passes finite numbers', () => {
    expect(normalizeFactorValues({ overdue: 80, EMI_BOUNCE: 40 })).toEqual({ OVERDUE: 80, EMI_BOUNCE: 40 });
  });
  it('null/undefined → empty map', () => {
    expect(normalizeFactorValues(undefined)).toEqual({});
    expect(normalizeFactorValues(null)).toEqual({});
  });
  it('rejects non-object + array + non-finite values', () => {
    expect(() => normalizeFactorValues(42)).toThrow(/must be an object/);
    expect(() => normalizeFactorValues([1, 2])).toThrow(/must be an object/);
    expect(() => normalizeFactorValues({ OVERDUE: 'high' })).toThrow(/finite number/);
    expect(() => normalizeFactorValues({ OVERDUE: Infinity })).toThrow(/finite number/);
  });
});

// ─── evaluateScorecard ───────────────────────────────────────────────

describe('scorecard_evaluator — evaluateScorecard', () => {
  it('weighted composite + green band for a low signal set', () => {
    // all signals 20 → composite = Σ(weight/100 × 20) = 20 (since weights sum 100)
    const ev = evaluateScorecard(TENANT, 'banking', factors(), { OVERDUE: 20, EMI_BOUNCE: 20, TXN_BEHAVIOUR: 20, BUREAU_SCORE: 20 }, classification(), NOW_MS);
    expect(ev.composite_score).toBe(20);
    expect(ev.classification.band).toBe('green');
    expect(ev.total_weight_pct).toBe(100);
    expect(ev.balanced).toBe(true);
    expect(ev.factors).toHaveLength(4);
    expect(ev.missing_value_count).toBe(0);
  });

  it('per-factor contribution = weight/100 × signal', () => {
    const ev = evaluateScorecard(TENANT, 'banking', factors(), { OVERDUE: 100, EMI_BOUNCE: 0, TXN_BEHAVIOUR: 0, BUREAU_SCORE: 0 }, classification(), NOW_MS);
    // only OVERDUE (30%) maxed → composite 30, green
    expect(ev.factors.find((f) => f.code === 'OVERDUE')!.contribution).toBe(30);
    expect(ev.factors.find((f) => f.code === 'EMI_BOUNCE')!.contribution).toBe(0);
    expect(ev.composite_score).toBe(30);
    expect(ev.classification.band).toBe('green');
  });

  it('high signals push amber then red', () => {
    const amber = evaluateScorecard(TENANT, 'banking', factors(), { OVERDUE: 80, EMI_BOUNCE: 80, TXN_BEHAVIOUR: 80, BUREAU_SCORE: 80 }, classification(), NOW_MS);
    expect(amber.composite_score).toBe(80);
    expect(amber.classification.band).toBe('amber');
    expect(amber.classification.action_required).toBe('Review within SLA');

    const red = evaluateScorecard(TENANT, 'banking', factors(), { OVERDUE: 100, EMI_BOUNCE: 100, TXN_BEHAVIOUR: 100, BUREAU_SCORE: 100 }, classification(), NOW_MS);
    expect(red.composite_score).toBe(100);
    expect(red.classification.band).toBe('red');
  });

  it('clamps signals to [0,100]', () => {
    const ev = evaluateScorecard(TENANT, 'banking', factors(), { OVERDUE: 999, EMI_BOUNCE: -50, TXN_BEHAVIOUR: 0, BUREAU_SCORE: 0 }, classification(), NOW_MS);
    expect(ev.factors.find((f) => f.code === 'OVERDUE')!.signal_value).toBe(100);
    expect(ev.factors.find((f) => f.code === 'EMI_BOUNCE')!.signal_value).toBe(0);
    expect(ev.composite_score).toBe(30); // 30% × 100
  });

  it('missing factor values default to 0 + counted', () => {
    const ev = evaluateScorecard(TENANT, 'banking', factors(), { OVERDUE: 100 }, classification(), NOW_MS);
    expect(ev.missing_value_count).toBe(3);
    expect(ev.factors.find((f) => f.code === 'EMI_BOUNCE')!.value_provided).toBe(false);
    expect(ev.factors.find((f) => f.code === 'OVERDUE')!.value_provided).toBe(true);
    expect(ev.composite_score).toBe(30);
  });

  it('surfaces unknown codes the caller supplied', () => {
    const ev = evaluateScorecard(TENANT, 'banking', factors(), { OVERDUE: 50, NONSENSE: 90, ZZZ: 10 }, classification(), NOW_MS);
    expect(ev.unknown_value_codes).toEqual(['NONSENSE', 'ZZZ']);
  });

  it('unbalanced weights surface balanced=false', () => {
    const fs = factors();
    fs[0].weight_pct = 50; // 50+25+25+20 = 120
    const ev = evaluateScorecard(TENANT, 'banking', fs, {}, classification(), NOW_MS);
    expect(ev.total_weight_pct).toBe(120);
    expect(ev.balanced).toBe(false);
  });

  it('empty factor set → composite 0, green', () => {
    const ev = evaluateScorecard(TENANT, 'banking', [], { OVERDUE: 100 }, classification(), NOW_MS);
    expect(ev.composite_score).toBe(0);
    expect(ev.classification.band).toBe('green');
    expect(ev.unknown_value_codes).toEqual(['OVERDUE']);
  });
});

// ─── Route ───────────────────────────────────────────────────────────

describe('scorecard_evaluator — POST /v1/config/risk-score/evaluate', () => {
  beforeEach(() => {
    _resetRiskScoreConfigStore();
    _resetAlertClassificationConfigStore();
  });

  it('evaluates against the seeded banking config (analyst)', async () => {
    const res = await request(app('risk_analyst'))
      .post('/v1/config/risk-score/evaluate')
      .set(H)
      .send({ domain: 'banking', factor_values: { OVERDUE: 90, EMI_BOUNCE: 80, TXN_BEHAVIOUR: 70, BUREAU_SCORE: 60 } });
    expect(res.status).toBe(200);
    expect(res.body.body.domain).toBe('banking');
    expect(res.body.body.composite_score).toBeGreaterThan(0);
    expect(res.body.body.classification.band).toMatch(/green|amber|red/);
    expect(res.body.body.factors.length).toBeGreaterThanOrEqual(4);
  });

  it('accepts an enveloped request body', async () => {
    const res = await request(app('admin'))
      .post('/v1/config/risk-score/evaluate')
      .set(H)
      .send({ body: { domain: 'insurance', factor_values: { PREMIUM_MISSED: 100 } } });
    expect(res.status).toBe(200);
    expect(res.body.body.domain).toBe('insurance');
  });

  it('400s an invalid domain', async () => {
    const res = await request(app('risk_analyst'))
      .post('/v1/config/risk-score/evaluate')
      .set(H)
      .send({ domain: 'both', factor_values: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EWS_400_invalid_input');
  });

  it('400s non-numeric factor values', async () => {
    const res = await request(app('risk_analyst'))
      .post('/v1/config/risk-score/evaluate')
      .set(H)
      .send({ domain: 'banking', factor_values: { OVERDUE: 'high' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EWS_400_invalid_input');
  });

  it('403s a role without customers:read_risk_profile', async () => {
    const res = await request(app('nobody'))
      .post('/v1/config/risk-score/evaluate')
      .set(H)
      .send({ domain: 'banking', factor_values: {} });
    expect(res.status).toBe(403);
  });

  it('reflects a config change — tightened bands flip the band', async () => {
    // tighten amber to start at 10 → a composite of 30 lands amber not green
    await request(app('admin'))
      .put('/v1/config/alert-classification/boundaries')
      .set(H)
      .send({ amber_min: 10, red_min: 25 });
    const res = await request(app('admin'))
      .post('/v1/config/risk-score/evaluate')
      .set(H)
      .send({ domain: 'banking', factor_values: { OVERDUE: 100, EMI_BOUNCE: 0, TXN_BEHAVIOUR: 0, BUREAU_SCORE: 0 } });
    expect(res.status).toBe(200);
    expect(res.body.body.composite_score).toBe(30);
    expect(res.body.body.classification.band).toBe('red'); // 30 ≥ red_min(25)
  });
});

// ─── evaluateScorecardBatch ──────────────────────────────────────────

describe('scorecard_evaluator — evaluateScorecardBatch', () => {
  it('scores N rows + rolls up a RAG distribution', () => {
    const rows = [
      { id: 'low', factor_values: { OVERDUE: 10, EMI_BOUNCE: 10, TXN_BEHAVIOUR: 10, BUREAU_SCORE: 10 } }, // 10 → green
      { id: 'mid', factor_values: { OVERDUE: 80, EMI_BOUNCE: 80, TXN_BEHAVIOUR: 80, BUREAU_SCORE: 80 } }, // 80 → amber
      { id: 'high', factor_values: { OVERDUE: 100, EMI_BOUNCE: 100, TXN_BEHAVIOUR: 100, BUREAU_SCORE: 100 } }, // 100 → red
    ];
    const r = evaluateScorecardBatch(TENANT, 'banking', rows, factors(), classification(), NOW_MS);
    expect(r.total).toBe(3);
    expect(r.distribution).toEqual({ green: 1, amber: 1, red: 1 });
    expect(r.rows.map((x) => x.band)).toEqual(['green', 'amber', 'red']);
    expect(r.rows.map((x) => x.id)).toEqual(['low', 'mid', 'high']);
    expect(r.max_composite).toBe(100);
    expect(r.min_composite).toBe(10);
    expect(r.mean_composite).toBeCloseTo((10 + 80 + 100) / 3, 2);
  });

  it('empty batch → zero distribution + null aggregates', () => {
    const r = evaluateScorecardBatch(TENANT, 'banking', [], factors(), classification(), NOW_MS);
    expect(r.total).toBe(0);
    expect(r.distribution).toEqual({ green: 0, amber: 0, red: 0 });
    expect(r.mean_composite).toBeNull();
    expect(r.max_composite).toBeNull();
    expect(r.min_composite).toBeNull();
  });

  it('per-row band matches single-evaluate for the same input', () => {
    const fv = { OVERDUE: 100, EMI_BOUNCE: 0, TXN_BEHAVIOUR: 0, BUREAU_SCORE: 0 };
    const single = evaluateScorecard(TENANT, 'banking', factors(), fv, classification(), NOW_MS);
    const batch = evaluateScorecardBatch(TENANT, 'banking', [{ id: 'x', factor_values: fv }], factors(), classification(), NOW_MS);
    expect(batch.rows[0].composite_score).toBe(single.composite_score);
    expect(batch.rows[0].band).toBe(single.classification.band);
  });

  it('rejects non-array rows, oversized batch, and malformed rows', () => {
    expect(() => evaluateScorecardBatch(TENANT, 'banking', 'nope', factors(), classification(), NOW_MS)).toThrow(/must be an array/);
    const tooMany = Array.from({ length: SCORECARD_BATCH_MAX + 1 }, (_, i) => ({ id: `r${i}`, factor_values: {} }));
    expect(() => evaluateScorecardBatch(TENANT, 'banking', tooMany, factors(), classification(), NOW_MS)).toThrow(/exceeds/);
    expect(() => evaluateScorecardBatch(TENANT, 'banking', [{ factor_values: {} }], factors(), classification(), NOW_MS)).toThrow(/non-empty id/);
    expect(() => evaluateScorecardBatch(TENANT, 'banking', [42], factors(), classification(), NOW_MS)).toThrow(/must be an object/);
  });
});

describe('scorecard_evaluator — POST /v1/config/risk-score/evaluate-batch', () => {
  it('scores a batch against the seeded banking config (analyst)', async () => {
    const res = await request(app('risk_analyst'))
      .post('/v1/config/risk-score/evaluate-batch')
      .set(H)
      .send({
        domain: 'banking',
        rows: [
          { id: 'c-1', factor_values: { OVERDUE: 20 } },
          { id: 'c-2', factor_values: { OVERDUE: 100, EMI_BOUNCE: 100, TXN_BEHAVIOUR: 100, BUREAU_SCORE: 100 } },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.body.total).toBe(2);
    expect(res.body.body.distribution.green + res.body.body.distribution.amber + res.body.body.distribution.red).toBe(2);
    expect(res.body.body.rows.length).toBe(2);
  });

  it('400s an invalid domain', async () => {
    const res = await request(app('admin'))
      .post('/v1/config/risk-score/evaluate-batch')
      .set(H)
      .send({ domain: 'both', rows: [] });
    expect(res.status).toBe(400);
  });

  it('400s a malformed row', async () => {
    const res = await request(app('admin'))
      .post('/v1/config/risk-score/evaluate-batch')
      .set(H)
      .send({ domain: 'banking', rows: [{ factor_values: {} }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EWS_400_invalid_input');
  });

  it('403s a role without customers:read_risk_profile', async () => {
    const res = await request(app('nobody'))
      .post('/v1/config/risk-score/evaluate-batch')
      .set(H)
      .send({ domain: 'banking', rows: [] });
    expect(res.status).toBe(403);
  });
});
