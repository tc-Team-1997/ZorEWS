// services/bff/__tests__/indicator_backtest_compare.test.ts
//
// T6 M4.8 — Indicator backtest result comparison.

import request from 'supertest';
import {
  BacktestCompareError,
  compareBacktestResults,
  compareFromUnknown,
} from '../src/indicator_backtest_compare';
import type { BacktestResult } from '../src/indicator_backtest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
  return {
    indicator_id: overrides.indicator_id ?? 'FIN-001',
    indicator_name: overrides.indicator_name ?? 'DPD ≥ 30',
    vertical: overrides.vertical ?? 'banking',
    days: overrides.days ?? 90,
    customer_segment: overrides.customer_segment ?? 'all',
    total_customers_evaluated: overrides.total_customers_evaluated ?? 1000,
    total_fires: overrides.total_fires ?? 100,
    daily: overrides.daily ?? [
      { day: '2026-05-12', fires: 30, true_positives: 10 },
      { day: '2026-05-13', fires: 40, true_positives: 15 },
      { day: '2026-05-14', fires: 30, true_positives: 12 },
    ],
    confusion: overrides.confusion ?? {
      true_positive: 37,
      false_positive: 63,
      false_negative: 20,
      true_negative: 880,
    },
    metrics: overrides.metrics ?? {
      precision: 0.37,
      recall: 0.65,
      f1: 0.47,
      weighted_contribution: 0.21,
    },
    mean_value: overrides.mean_value ?? 0.62,
    generated_at: overrides.generated_at ?? NOW.toISOString(),
  };
}

// ─── compareBacktestResults ──────────────────────────────────────────

describe('M4.8 — compareBacktestResults — identical', () => {
  test('identical results → identical=true, all deltas 0', () => {
    const r = mkResult();
    const d = compareBacktestResults(r, r);
    expect(d.identical).toBe(true);
    expect(d.fires_delta).toBe(0);
    expect(d.precision_delta).toBe(0);
    expect(d.recall_delta).toBe(0);
    expect(d.confusion_delta).toEqual({
      true_positive: 0,
      false_positive: 0,
      false_negative: 0,
      true_negative: 0,
    });
    expect(d.per_day_fires_delta.every((p) => p.delta === 0)).toBe(true);
    expect(d.a_only_days).toEqual([]);
    expect(d.b_only_days).toEqual([]);
  });
});

describe('M4.8 — fires + metrics deltas', () => {
  test('fires_delta = b.total_fires - a.total_fires (signed)', () => {
    const a = mkResult({ total_fires: 100 });
    const b = mkResult({ total_fires: 75 });
    const d = compareBacktestResults(a, b);
    expect(d.fires_delta).toBe(-25);
    expect(d.identical).toBe(false);
  });

  test('precision/recall/f1 deltas surface direction of change', () => {
    const a = mkResult({
      metrics: { precision: 0.4, recall: 0.6, f1: 0.48, weighted_contribution: 0.2 },
    });
    const b = mkResult({
      metrics: { precision: 0.55, recall: 0.55, f1: 0.55, weighted_contribution: 0.2 },
    });
    const d = compareBacktestResults(a, b);
    expect(d.precision_delta).toBeCloseTo(0.15, 5);
    expect(d.recall_delta).toBeCloseTo(-0.05, 5);
    expect(d.f1_delta).toBeCloseTo(0.07, 5);
  });

  test('confusion_delta per-cell signed', () => {
    const a = mkResult({
      confusion: { true_positive: 50, false_positive: 80, false_negative: 30, true_negative: 840 },
    });
    const b = mkResult({
      confusion: { true_positive: 70, false_positive: 50, false_negative: 25, true_negative: 855 },
    });
    const d = compareBacktestResults(a, b);
    expect(d.confusion_delta).toEqual({
      true_positive: 20,
      false_positive: -30,
      false_negative: -5,
      true_negative: 15,
    });
  });

  test('mean_value_delta surfaces shift in indicator strength', () => {
    const a = mkResult({ mean_value: 0.5 });
    const b = mkResult({ mean_value: 0.7 });
    const d = compareBacktestResults(a, b);
    expect(d.mean_value_delta).toBeCloseTo(0.2, 5);
  });
});

describe('M4.8 — per-day alignment', () => {
  test('overlapping days produce per-day deltas; days only on one side surface in *_only_days', () => {
    const a = mkResult({
      daily: [
        { day: '2026-05-12', fires: 30, true_positives: 10 },
        { day: '2026-05-13', fires: 40, true_positives: 15 },
        { day: '2026-05-14', fires: 30, true_positives: 12 },
      ],
    });
    const b = mkResult({
      daily: [
        { day: '2026-05-13', fires: 50, true_positives: 20 },
        { day: '2026-05-14', fires: 20, true_positives: 5 },
        { day: '2026-05-15', fires: 35, true_positives: 18 },
      ],
    });
    const d = compareBacktestResults(a, b);
    expect(d.per_day_fires_delta).toEqual([
      { day: '2026-05-13', a_fires: 40, b_fires: 50, delta: 10 },
      { day: '2026-05-14', a_fires: 30, b_fires: 20, delta: -10 },
    ]);
    expect(d.a_only_days).toEqual(['2026-05-12']);
    expect(d.b_only_days).toEqual(['2026-05-15']);
  });

  test('per_day_fires_delta sorted oldest-first', () => {
    const a = mkResult({
      daily: [
        { day: '2026-05-15', fires: 1, true_positives: 0 },
        { day: '2026-05-13', fires: 2, true_positives: 0 },
        { day: '2026-05-14', fires: 3, true_positives: 0 },
      ],
    });
    const b = mkResult({
      daily: [
        { day: '2026-05-13', fires: 5, true_positives: 0 },
        { day: '2026-05-14', fires: 5, true_positives: 0 },
        { day: '2026-05-15', fires: 5, true_positives: 0 },
      ],
    });
    const d = compareBacktestResults(a, b);
    expect(d.per_day_fires_delta.map((p) => p.day)).toEqual([
      '2026-05-13',
      '2026-05-14',
      '2026-05-15',
    ]);
  });

  test('identical fires-only diff still flags identical=false because counts move', () => {
    // Same metrics + confusion, but per-day fires shifted (so total_fires
    // also moves). Catches the case where caller's metrics are stale.
    const a = mkResult({
      total_fires: 100,
      daily: [{ day: '2026-05-12', fires: 100, true_positives: 30 }],
    });
    const b = mkResult({
      total_fires: 50,
      daily: [{ day: '2026-05-12', fires: 50, true_positives: 30 }],
    });
    const d = compareBacktestResults(a, b);
    expect(d.identical).toBe(false);
    expect(d.fires_delta).toBe(-50);
  });
});

describe('M4.8 — same_indicator / same_segment warnings', () => {
  test('different indicator_id → same_indicator=false, but comparison still works', () => {
    const a = mkResult({ indicator_id: 'FIN-001' });
    const b = mkResult({ indicator_id: 'FIN-002' });
    const d = compareBacktestResults(a, b);
    expect(d.same_indicator).toBe(false);
    expect(d.a_indicator_id).toBe('FIN-001');
    expect(d.b_indicator_id).toBe('FIN-002');
  });

  test('different customer_segment → same_segment=false', () => {
    const a = mkResult({ customer_segment: 'retail' });
    const b = mkResult({ customer_segment: 'sme' });
    const d = compareBacktestResults(a, b);
    expect(d.same_segment).toBe(false);
    expect(d.a_segment).toBe('retail');
    expect(d.b_segment).toBe('sme');
  });
});

// ─── compareFromUnknown / validation ─────────────────────────────────

describe('M4.8 — compareFromUnknown validation', () => {
  test('non-object → invalid_input', () => {
    expect(() => compareFromUnknown(null)).toThrow(BacktestCompareError);
    expect(() => compareFromUnknown('not an object')).toThrow(BacktestCompareError);
  });

  test('missing a → invalid_input', () => {
    expect(() => compareFromUnknown({ b: mkResult() })).toThrow(/a must be/);
  });

  test('missing b → invalid_input', () => {
    expect(() => compareFromUnknown({ a: mkResult() })).toThrow(/b must be/);
  });

  test('a without indicator_id → invalid_input', () => {
    expect(() =>
      compareFromUnknown({
        a: { ...mkResult(), indicator_id: '' },
        b: mkResult(),
      }),
    ).toThrow(/indicator_id required/);
  });

  test('a without confusion → invalid_input', () => {
    const bad = { ...mkResult() } as Record<string, unknown>;
    delete bad.confusion;
    expect(() => compareFromUnknown({ a: bad, b: mkResult() })).toThrow(/confusion required/);
  });

  test('well-formed inputs → delegates to compareBacktestResults', () => {
    const d = compareFromUnknown({ a: mkResult(), b: mkResult() });
    expect(d.identical).toBe(true);
  });
});

// ─── Route: POST /v1/indicators/backtest/compare ─────────────────────

function makeCompareApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M4.8 — POST /v1/indicators/backtest/compare', () => {
  test('200 with compare envelope', async () => {
    const { app } = makeCompareApp('admin');
    const r = await request(app)
      .post('/v1/indicators/backtest/compare')
      .set(TH_BIL)
      .send({ a: mkResult({ total_fires: 100 }), b: mkResult({ total_fires: 75 }) });
    expect(r.status).toBe(200);
    expect(r.body.body.diff.fires_delta).toBe(-25);
    expect(r.body.body.diff.same_indicator).toBe(true);
    expect(r.body.body.diff.same_segment).toBe(true);
  });

  test('mismatched indicators warn but still compare', async () => {
    const { app } = makeCompareApp('admin');
    const r = await request(app)
      .post('/v1/indicators/backtest/compare')
      .set(TH_BIL)
      .send({
        a: mkResult({ indicator_id: 'FIN-001' }),
        b: mkResult({ indicator_id: 'FIN-002' }),
      });
    expect(r.status).toBe(200);
    expect(r.body.body.diff.same_indicator).toBe(false);
  });

  test('bad shape → 400 invalid_input', async () => {
    const { app } = makeCompareApp('admin');
    const r = await request(app)
      .post('/v1/indicators/backtest/compare')
      .set(TH_BIL)
      .send({ a: mkResult() }); // missing b
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCompareApp('case_owner');
    const r = await request(app)
      .post('/v1/indicators/backtest/compare')
      .set(TH_BIL)
      .send({ a: mkResult(), b: mkResult() });
    expect(r.status).toBe(403);
  });

  test('cross-tenant header still works (no per-tenant state involved)', async () => {
    const { app } = makeCompareApp('admin');
    const r = await request(app)
      .post('/v1/indicators/backtest/compare')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .send({ a: mkResult(), b: mkResult() });
    expect(r.status).toBe(200);
    expect(r.body.body.diff.identical).toBe(true);
  });
});
