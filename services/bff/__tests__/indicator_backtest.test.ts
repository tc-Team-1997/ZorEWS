// services/bff/__tests__/indicator_backtest.test.ts
//
// T6 M4.2 — Indicator backtest.

import request from 'supertest';
import {
  BacktestError,
  isCustomerSegment,
  runBacktest,
  validateInput,
  type BacktestInput,
  type BacktestResult,
} from '../src/indicator_backtest';
import { StubIndicatorWeightLookup } from '../src/bil_scoring_v2';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeBtApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

const VALID_INPUT: BacktestInput = {
  indicator_id: 'FIN-001',
  days: 30,
  customer_segment: 'all',
};

// ─── Type guard ───────────────────────────────────────────────────────

describe('isCustomerSegment', () => {
  test('accepts the 4 valid segments', () => {
    for (const s of ['all', 'retail', 'sme', 'corporate']) {
      expect(isCustomerSegment(s)).toBe(true);
    }
  });
  test('rejects everything else', () => {
    expect(isCustomerSegment('ALL')).toBe(false);
    expect(isCustomerSegment('private_banking')).toBe(false);
  });
});

// ─── validateInput ────────────────────────────────────────────────────

describe('validateInput', () => {
  test('happy path returns the validated input + default segment', () => {
    const out = validateInput({ indicator_id: 'FIN-001', days: 30 });
    expect(out.indicator_id).toBe('FIN-001');
    expect(out.days).toBe(30);
    expect(out.customer_segment).toBe('all');
  });

  test('missing indicator_id throws invalid_input', () => {
    expect(() => validateInput({ days: 30 })).toThrow(/indicator_id/);
  });

  test('non-integer days throws invalid_input', () => {
    expect(() => validateInput({ indicator_id: 'X', days: 30.5 })).toThrow(/integer/);
  });

  test('days = 0 throws invalid_days', () => {
    expect(() => validateInput({ indicator_id: 'X', days: 0 })).toThrow(/\[1, 365\]/);
  });

  test('days > 365 throws invalid_days', () => {
    expect(() => validateInput({ indicator_id: 'X', days: 400 })).toThrow(/\[1, 365\]/);
  });

  test('invalid vertical throws invalid_vertical', () => {
    expect(() =>
      validateInput({ indicator_id: 'X', days: 10, vertical: 'crypto' as never }),
    ).toThrow(/vertical/);
  });

  test('invalid segment throws invalid_segment', () => {
    expect(() =>
      validateInput({
        indicator_id: 'X',
        days: 10,
        customer_segment: 'private_banking' as never,
      }),
    ).toThrow(/customer_segment/);
  });

  test('error code surfaced via BacktestError', () => {
    try {
      validateInput({});
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BacktestError);
      expect((e as BacktestError).code).toBe('invalid_input');
    }
  });
});

// ─── runBacktest ──────────────────────────────────────────────────────

describe('runBacktest', () => {
  const lookup = new StubIndicatorWeightLookup();

  test('happy path — returns a valid result with all required fields', () => {
    const r = runBacktest('BIL', VALID_INPUT, lookup, NOW);
    expect(r.indicator_id).toBe('FIN-001');
    expect(r.indicator_name).toMatch(/DPD/);
    expect(r.days).toBe(30);
    expect(r.customer_segment).toBe('all');
    expect(r.total_customers_evaluated).toBe(5000);
    expect(r.daily.length).toBe(30);
    expect(r.generated_at).toBe(NOW.toISOString());
  });

  test('daily buckets are oldest-first and have YYYY-MM-DD shape', () => {
    const r = runBacktest('BIL', VALID_INPUT, lookup, NOW);
    expect(r.daily[0]!.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (let i = 1; i < r.daily.length; i++) {
      expect(r.daily[i - 1]!.day < r.daily[i]!.day).toBe(true);
    }
  });

  test('total_fires equals sum of daily.fires', () => {
    const r = runBacktest('BIL', VALID_INPUT, lookup, NOW);
    const sum = r.daily.reduce((s, d) => s + d.fires, 0);
    expect(r.total_fires).toBe(sum);
  });

  test('confusion matrix is non-negative + each cell non-zero on a 30-day window', () => {
    const r = runBacktest('BIL', VALID_INPUT, lookup, NOW);
    expect(r.confusion.true_positive).toBeGreaterThan(0);
    expect(r.confusion.false_positive).toBeGreaterThan(0);
    expect(r.confusion.true_negative).toBeGreaterThan(0);
    expect(r.confusion.true_positive + r.confusion.false_positive).toBe(r.total_fires);
  });

  test('precision = TP / (TP + FP)', () => {
    const r = runBacktest('BIL', VALID_INPUT, lookup, NOW);
    const c = r.confusion;
    const expected = Math.round((c.true_positive / (c.true_positive + c.false_positive)) * 10000) / 10000;
    expect(r.metrics.precision).toBeCloseTo(expected, 3);
  });

  test('recall = TP / (TP + FN)', () => {
    const r = runBacktest('BIL', VALID_INPUT, lookup, NOW);
    const c = r.confusion;
    const tp = c.true_positive;
    const fn = c.false_negative;
    if (tp + fn > 0) {
      const expected = Math.round((tp / (tp + fn)) * 10000) / 10000;
      expect(r.metrics.recall).toBeCloseTo(expected, 3);
    }
  });

  test('f1 in [0, 1]', () => {
    const r = runBacktest('BIL', VALID_INPUT, lookup, NOW);
    expect(r.metrics.f1).toBeGreaterThanOrEqual(0);
    expect(r.metrics.f1).toBeLessThanOrEqual(1);
  });

  test('mean_value in [0, 1]', () => {
    const r = runBacktest('BIL', VALID_INPUT, lookup, NOW);
    expect(r.mean_value).toBeGreaterThanOrEqual(0);
    expect(r.mean_value).toBeLessThanOrEqual(1);
  });

  test('weighted_contribution = catalog_weight × mean_value', () => {
    const r = runBacktest('BIL', VALID_INPUT, lookup, NOW);
    // FIN-001 weight is 0.9 per STUB_CATALOG
    const expected = Math.round(0.9 * r.mean_value * 10000) / 10000;
    expect(r.metrics.weighted_contribution).toBeCloseTo(expected, 3);
  });

  test('deterministic — same (tenant, indicator, day, days, segment) → same result', () => {
    const a = runBacktest('BIL', VALID_INPUT, lookup, NOW);
    const b = runBacktest('BIL', VALID_INPUT, lookup, NOW);
    expect(a).toEqual(b);
  });

  test('different tenants → different results', () => {
    const bil = runBacktest('BIL', VALID_INPUT, lookup, NOW);
    const bank = runBacktest('BANK_DEMO', VALID_INPUT, lookup, NOW);
    expect(bil).not.toEqual(bank);
  });

  test('different days → different result', () => {
    const a = runBacktest('BIL', { ...VALID_INPUT, days: 7 }, lookup, NOW);
    const b = runBacktest('BIL', { ...VALID_INPUT, days: 30 }, lookup, NOW);
    expect(a.daily.length).toBe(7);
    expect(b.daily.length).toBe(30);
  });

  test('segment changes total_customers_evaluated', () => {
    const all = runBacktest('BIL', { ...VALID_INPUT, customer_segment: 'all' }, lookup, NOW);
    const corp = runBacktest('BIL', { ...VALID_INPUT, customer_segment: 'corporate' }, lookup, NOW);
    expect(all.total_customers_evaluated).toBe(5000);
    expect(corp.total_customers_evaluated).toBe(300);
  });

  test('heavier-weight indicators yield higher precision than lighter ones', () => {
    const heavy = runBacktest('BIL', { indicator_id: 'FIN-001', days: 90 }, lookup, NOW); // weight 0.9
    const light = runBacktest('BIL', { indicator_id: 'BEH-002', days: 90 }, lookup, NOW); // weight 0.4
    expect(heavy.metrics.precision).toBeGreaterThan(light.metrics.precision);
  });

  test('vertical filter passed through to lookup', () => {
    const r = runBacktest(
      'BIL',
      { indicator_id: 'CLM-001', days: 10, vertical: 'insurance' },
      lookup,
      NOW,
    );
    expect(r.vertical).toBe('insurance');
  });

  test('unknown indicator → BacktestError(unknown_indicator)', () => {
    try {
      runBacktest('BIL', { indicator_id: 'NO-SUCH', days: 10 }, lookup, NOW);
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BacktestError);
      expect((e as BacktestError).code).toBe('unknown_indicator');
    }
  });

  test('cross-vertical id with vertical filter → unknown_indicator', () => {
    try {
      runBacktest(
        'BIL',
        { indicator_id: 'FIN-001', days: 10, vertical: 'insurance' },
        lookup,
        NOW,
      );
      fail('expected throw');
    } catch (e) {
      expect((e as BacktestError).code).toBe('unknown_indicator');
    }
  });
});

// ─── Route ────────────────────────────────────────────────────────────

describe('POST /v1/indicators/backtest', () => {
  test('admin: 200 with the backtest payload', async () => {
    const { app } = makeBtApp('admin');
    const r = await request(app)
      .post('/v1/indicators/backtest')
      .set(TH_BIL)
      .send({ indicator_id: 'FIN-001', days: 30 });
    expect(r.status).toBe(200);
    const body = r.body.body as BacktestResult;
    expect(body.indicator_id).toBe('FIN-001');
    expect(body.daily.length).toBe(30);
    expect(body.metrics.precision).toBeGreaterThan(0);
  });

  test('accepts an enveloped request body', async () => {
    const { app } = makeBtApp('admin');
    const r = await request(app)
      .post('/v1/indicators/backtest')
      .set(TH_BIL)
      .send({
        header: { requestId: 'r-1' },
        body: { indicator_id: 'CLM-001', days: 14, vertical: 'insurance' },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.vertical).toBe('insurance');
    expect(r.body.body.daily.length).toBe(14);
  });

  test('analyst+ accepted', async () => {
    const { app } = makeBtApp('risk_analyst');
    const r = await request(app)
      .post('/v1/indicators/backtest')
      .set(TH_BIL)
      .send({ indicator_id: 'FIN-001', days: 7 });
    expect(r.status).toBe(200);
  });

  test('unknown role → 403', async () => {
    const { app } = makeBtApp('case_owner');
    const r = await request(app)
      .post('/v1/indicators/backtest')
      .set(TH_BIL)
      .send({ indicator_id: 'FIN-001', days: 7 });
    expect(r.status).toBe(403);
  });

  test('missing indicator_id → 400 EWS_400_invalid_input', async () => {
    const { app } = makeBtApp('admin');
    const r = await request(app)
      .post('/v1/indicators/backtest')
      .set(TH_BIL)
      .send({ days: 30 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('days = 400 → 400 EWS_400_invalid_days', async () => {
    const { app } = makeBtApp('admin');
    const r = await request(app)
      .post('/v1/indicators/backtest')
      .set(TH_BIL)
      .send({ indicator_id: 'FIN-001', days: 400 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_days');
  });

  test('invalid vertical → 400 EWS_400_invalid_vertical', async () => {
    const { app } = makeBtApp('admin');
    const r = await request(app)
      .post('/v1/indicators/backtest')
      .set(TH_BIL)
      .send({ indicator_id: 'FIN-001', days: 7, vertical: 'crypto' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_vertical');
  });

  test('invalid segment → 400 EWS_400_invalid_segment', async () => {
    const { app } = makeBtApp('admin');
    const r = await request(app)
      .post('/v1/indicators/backtest')
      .set(TH_BIL)
      .send({
        indicator_id: 'FIN-001',
        days: 7,
        customer_segment: 'private_banking',
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_segment');
  });

  test('unknown indicator → 404 EWS_404_unknown_indicator', async () => {
    const { app } = makeBtApp('admin');
    const r = await request(app)
      .post('/v1/indicators/backtest')
      .set(TH_BIL)
      .send({ indicator_id: 'NO-SUCH', days: 7 });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_indicator');
  });

  test('different tenants get different payloads', async () => {
    const { app } = makeBtApp('admin');
    const bil = await request(app)
      .post('/v1/indicators/backtest')
      .set(TH_BIL)
      .send({ indicator_id: 'FIN-001', days: 30 });
    const bank = await request(app)
      .post('/v1/indicators/backtest')
      .set(TH_BANK)
      .send({ indicator_id: 'FIN-001', days: 30 });
    expect(bil.body.body.total_fires).not.toBe(bank.body.body.total_fires);
  });
});

// ─── M6.2 surface unaffected ───────────────────────────────────────────

describe('No-regression: M6.2 surface still works', () => {
  test('/v1/scoring/risk/by-indicators still 200', async () => {
    const { app } = makeBtApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-indicators')
      .set(TH_BIL)
      .send({ items: [{ indicator_id: 'FIN-001', value: 0.5 }] });
    expect(r.status).toBe(200);
  });
});
