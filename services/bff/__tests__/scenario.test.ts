import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { runScenario, stageFromPd, stressPd, validateShocks } from '../src/scenario/engine';
import { defaultPortfolio, makeSyntheticPortfolio, type Account } from '../src/scenario/portfolio';

const NOW = new Date('2026-04-28T12:00:00.000Z');

function makeScenarioApp(portfolio?: Account[]) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    portfolio,
    now: () => NOW,
    getRole: () => 'risk_analyst',
  });
}

describe('scenario engine — stressPd()', () => {
  const baseAccount: Account = {
    customer_id: 'c-2000',
    name: 'Test Obligor',
    product: 'personal',
    tenure_months: 36,
    ead_kes: 500_000,
    lgd: 0.65,
    baseline_pd: 0.1,
    income_band: 'mid',
    fx_exposed: false,
  };

  test('returns baseline_pd when all shocks are zero', () => {
    expect(stressPd(baseAccount, { gdp: 0, rate: 0, fx: 0 })).toBeCloseTo(0.1, 4);
  });

  test('GDP contraction raises PD; expansion lowers it', () => {
    const contracted = stressPd(baseAccount, { gdp: -4, rate: 0, fx: 0 });
    const expanded = stressPd(baseAccount, { gdp: +2, rate: 0, fx: 0 });
    expect(contracted).toBeGreaterThan(0.1);
    expect(expanded).toBeLessThan(0.1);
  });

  test('low-income obligors are more sensitive to GDP than high-income', () => {
    const low = stressPd({ ...baseAccount, income_band: 'low' }, { gdp: -4, rate: 0, fx: 0 });
    const high = stressPd({ ...baseAccount, income_band: 'high' }, { gdp: -4, rate: 0, fx: 0 });
    expect(low - 0.1).toBeGreaterThan(high - 0.1);
  });

  test('rate hike raises PD only on rate-sensitive products; mortgage absorbs less', () => {
    const personalDelta =
      stressPd({ ...baseAccount, product: 'personal' }, { gdp: 0, rate: 200, fx: 0 }) - 0.1;
    const mortgageDelta =
      stressPd({ ...baseAccount, product: 'mortgage' }, { gdp: 0, rate: 200, fx: 0 }) - 0.1;
    expect(personalDelta).toBeGreaterThan(mortgageDelta);
  });

  test('FX shock affects only fx_exposed obligors', () => {
    const exposed = stressPd({ ...baseAccount, fx_exposed: true }, { gdp: 0, rate: 0, fx: 10 });
    const sheltered = stressPd({ ...baseAccount, fx_exposed: false }, { gdp: 0, rate: 0, fx: 10 });
    expect(exposed).toBeGreaterThan(0.1);
    expect(sheltered).toBeCloseTo(0.1, 4);
  });

  test('PD never exceeds 0.95 even under the worst shock', () => {
    const cap = stressPd(
      { ...baseAccount, baseline_pd: 0.45, fx_exposed: true, income_band: 'low' },
      { gdp: -8, rate: 400, fx: 20 },
    );
    expect(cap).toBeLessThanOrEqual(0.95);
  });
});

describe('scenario engine — validateShocks()', () => {
  test('accepts a baseline payload', () => {
    expect(validateShocks({ gdp: 0, rate: 0, fx: 0 })).toEqual({ gdp: 0, rate: 0, fx: 0 });
  });

  test('rejects out-of-range gdp', () => {
    expect(() => validateShocks({ gdp: -10, rate: 0, fx: 0 })).toThrow(/gdp/);
  });

  test('rejects out-of-range rate', () => {
    expect(() => validateShocks({ gdp: 0, rate: 500, fx: 0 })).toThrow(/rate/);
  });

  test('rejects out-of-range fx', () => {
    expect(() => validateShocks({ gdp: 0, rate: 0, fx: 25 })).toThrow(/fx/);
  });

  test('rejects non-numeric values', () => {
    expect(() => validateShocks({ gdp: 'oops', rate: 0, fx: 0 })).toThrow(/gdp/);
  });

  test('rejects non-object body', () => {
    expect(() => validateShocks(null)).toThrow();
  });
});

describe('scenario engine — runScenario()', () => {
  test('zero-shock baseline_ecl equals stressed_ecl', () => {
    const portfolio = makeSyntheticPortfolio(50, 7);
    const result = runScenario(portfolio, { gdp: 0, rate: 0, fx: 0 }, () => NOW);
    expect(result.baseline_ecl_kes).toBe(result.stressed_ecl_kes);
    expect(result.ecl_delta_kes).toBe(0);
  });

  test('adverse shock raises stressed_ecl above baseline_ecl', () => {
    const portfolio = makeSyntheticPortfolio(50, 7);
    const result = runScenario(portfolio, { gdp: -4, rate: 200, fx: 5 }, () => NOW);
    expect(result.stressed_ecl_kes).toBeGreaterThan(result.baseline_ecl_kes);
    expect(result.ecl_delta_kes).toBeGreaterThan(0);
  });

  test('benign shock lowers stressed_ecl below baseline_ecl', () => {
    const portfolio = makeSyntheticPortfolio(50, 7);
    const result = runScenario(portfolio, { gdp: 2, rate: -100, fx: 0 }, () => NOW);
    expect(result.stressed_ecl_kes).toBeLessThan(result.baseline_ecl_kes);
    expect(result.ecl_delta_kes).toBeLessThan(0);
  });

  test('top_affected returns at most 10 customers ranked by absolute pd_delta', () => {
    const portfolio = makeSyntheticPortfolio(50, 7);
    const result = runScenario(portfolio, { gdp: -3, rate: 100, fx: 5 }, () => NOW);
    expect(result.top_affected.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < result.top_affected.length; i++) {
      expect(Math.abs(result.top_affected[i - 1].pd_delta_pp)).toBeGreaterThanOrEqual(
        Math.abs(result.top_affected[i].pd_delta_pp),
      );
    }
  });

  test('segment rows cover every product in the portfolio', () => {
    const portfolio = makeSyntheticPortfolio(80, 7);
    const result = runScenario(portfolio, { gdp: -2, rate: 50, fx: 0 }, () => NOW);
    const products = new Set(portfolio.map((a) => a.product));
    const segments = new Set(result.segments.map((s) => s.segment));
    expect(segments).toEqual(products);
  });

  test('result is deterministic for the same shock + seed', () => {
    const portfolio = makeSyntheticPortfolio(50, 7);
    const a = runScenario(portfolio, { gdp: -3, rate: 100, fx: 5 }, () => NOW);
    const b = runScenario(portfolio, { gdp: -3, rate: 100, fx: 5 }, () => NOW);
    expect(a).toEqual(b);
  });

  test('default cached portfolio has 240 accounts', () => {
    expect(defaultPortfolio()).toHaveLength(240);
  });
});

describe('scenario engine — stageFromPd()', () => {
  test('PD < 0.05 → Stage 1', () => {
    expect(stageFromPd(0)).toBe(1);
    expect(stageFromPd(0.01)).toBe(1);
    expect(stageFromPd(0.0499)).toBe(1);
  });
  test('0.05 ≤ PD < 0.20 → Stage 2', () => {
    expect(stageFromPd(0.05)).toBe(2);
    expect(stageFromPd(0.12)).toBe(2);
    expect(stageFromPd(0.1999)).toBe(2);
  });
  test('PD ≥ 0.20 → Stage 3', () => {
    expect(stageFromPd(0.2)).toBe(3);
    expect(stageFromPd(0.5)).toBe(3);
    expect(stageFromPd(0.95)).toBe(3);
  });
});

describe('scenario engine — stage_distribution + stage_migration', () => {
  test('zero shock keeps every account on the migration diagonal', () => {
    const portfolio = makeSyntheticPortfolio(50, 7);
    const result = runScenario(portfolio, { gdp: 0, rate: 0, fx: 0 }, () => NOW);
    // Off-diagonal cells must all be 0 — nothing migrated.
    expect(result.stage_migration.s1.s2).toBe(0);
    expect(result.stage_migration.s1.s3).toBe(0);
    expect(result.stage_migration.s2.s1).toBe(0);
    expect(result.stage_migration.s2.s3).toBe(0);
    expect(result.stage_migration.s3.s1).toBe(0);
    expect(result.stage_migration.s3.s2).toBe(0);
    // Diagonal counts equal the baseline distribution.
    expect(result.stage_migration.s1.s1).toBe(result.baseline_stages.stage_1);
    expect(result.stage_migration.s2.s2).toBe(result.baseline_stages.stage_2);
    expect(result.stage_migration.s3.s3).toBe(result.baseline_stages.stage_3);
  });

  test('adverse shock causes net deterioration: more S2/S3 stressed than baseline', () => {
    const portfolio = makeSyntheticPortfolio(80, 7);
    const result = runScenario(portfolio, { gdp: -4, rate: 200, fx: 5 }, () => NOW);
    const baselineWorse = result.baseline_stages.stage_2 + result.baseline_stages.stage_3;
    const stressedWorse = result.stressed_stages.stage_2 + result.stressed_stages.stage_3;
    expect(stressedWorse).toBeGreaterThanOrEqual(baselineWorse);
  });

  test('stage_distribution counts sum to the portfolio size on both sides', () => {
    const portfolio = makeSyntheticPortfolio(100, 7);
    const result = runScenario(portfolio, { gdp: -2, rate: 100, fx: 5 }, () => NOW);
    const baselineSum =
      result.baseline_stages.stage_1 + result.baseline_stages.stage_2 + result.baseline_stages.stage_3;
    const stressedSum =
      result.stressed_stages.stage_1 + result.stressed_stages.stage_2 + result.stressed_stages.stage_3;
    expect(baselineSum).toBe(portfolio.length);
    expect(stressedSum).toBe(portfolio.length);
  });

  test('migration matrix totals equal the portfolio size', () => {
    const portfolio = makeSyntheticPortfolio(100, 7);
    const result = runScenario(portfolio, { gdp: -3, rate: 100, fx: 0 }, () => NOW);
    let total = 0;
    for (const from of ['s1', 's2', 's3'] as const) {
      for (const to of ['s1', 's2', 's3'] as const) {
        total += result.stage_migration[from][to];
      }
    }
    expect(total).toBe(portfolio.length);
  });

  test('row sums of the migration matrix equal baseline_stages', () => {
    const portfolio = makeSyntheticPortfolio(100, 7);
    const result = runScenario(portfolio, { gdp: -3, rate: 100, fx: 0 }, () => NOW);
    const m = result.stage_migration;
    expect(m.s1.s1 + m.s1.s2 + m.s1.s3).toBe(result.baseline_stages.stage_1);
    expect(m.s2.s1 + m.s2.s2 + m.s2.s3).toBe(result.baseline_stages.stage_2);
    expect(m.s3.s1 + m.s3.s2 + m.s3.s3).toBe(result.baseline_stages.stage_3);
  });

  test('column sums of the migration matrix equal stressed_stages', () => {
    const portfolio = makeSyntheticPortfolio(100, 7);
    const result = runScenario(portfolio, { gdp: -3, rate: 100, fx: 0 }, () => NOW);
    const m = result.stage_migration;
    expect(m.s1.s1 + m.s2.s1 + m.s3.s1).toBe(result.stressed_stages.stage_1);
    expect(m.s1.s2 + m.s2.s2 + m.s3.s2).toBe(result.stressed_stages.stage_2);
    expect(m.s1.s3 + m.s2.s3 + m.s3.s3).toBe(result.stressed_stages.stage_3);
  });
});

describe('scenario engine — portfolio_pd + npa_pct', () => {
  test('zero shock leaves portfolio_pd and npa_pct unchanged', () => {
    const portfolio = makeSyntheticPortfolio(80, 7);
    const result = runScenario(portfolio, { gdp: 0, rate: 0, fx: 0 }, () => NOW);
    expect(result.stressed_portfolio_pd).toBe(result.baseline_portfolio_pd);
    expect(result.stressed_npa_pct).toBe(result.baseline_npa_pct);
  });

  test('adverse shock raises both portfolio_pd and npa_pct', () => {
    const portfolio = makeSyntheticPortfolio(80, 7);
    const result = runScenario(portfolio, { gdp: -4, rate: 200, fx: 5 }, () => NOW);
    expect(result.stressed_portfolio_pd).toBeGreaterThan(result.baseline_portfolio_pd);
    expect(result.stressed_npa_pct).toBeGreaterThanOrEqual(result.baseline_npa_pct);
  });

  test('portfolio_pd is in [0, 1]', () => {
    const portfolio = makeSyntheticPortfolio(80, 7);
    const result = runScenario(portfolio, { gdp: -8, rate: 400, fx: 20 }, () => NOW);
    expect(result.stressed_portfolio_pd).toBeGreaterThanOrEqual(0);
    expect(result.stressed_portfolio_pd).toBeLessThanOrEqual(1);
  });

  test('npa_pct equals stage_3 share of portfolio', () => {
    const portfolio = makeSyntheticPortfolio(80, 7);
    const result = runScenario(portfolio, { gdp: -3, rate: 100, fx: 5 }, () => NOW);
    const expected = result.stressed_stages.stage_3 / portfolio.length;
    expect(result.stressed_npa_pct).toBeCloseTo(expected, 4);
  });
});

describe('scenario engine — segment_risk_matrix', () => {
  test('matrix has one row per product in the portfolio', () => {
    const portfolio = makeSyntheticPortfolio(80, 7);
    const result = runScenario(portfolio, { gdp: -2, rate: 100, fx: 0 }, () => NOW);
    const portfolioProducts = new Set(portfolio.map((a) => a.product));
    const matrixSegments = new Set(result.segment_risk_matrix.map((r) => r.segment));
    expect(matrixSegments).toEqual(portfolioProducts);
  });

  test('every row sums to its segment account count, both baseline and stressed', () => {
    const portfolio = makeSyntheticPortfolio(80, 7);
    const result = runScenario(portfolio, { gdp: -2, rate: 100, fx: 0 }, () => NOW);
    for (const row of result.segment_risk_matrix) {
      const segCount = portfolio.filter((a) => a.product === row.segment).length;
      expect(row.baseline.low + row.baseline.medium + row.baseline.high).toBe(segCount);
      expect(row.stressed.low + row.stressed.medium + row.stressed.high).toBe(segCount);
    }
  });

  test('matrix totals equal portfolio risk-band totals', () => {
    const portfolio = makeSyntheticPortfolio(80, 7);
    const result = runScenario(portfolio, { gdp: -3, rate: 100, fx: 0 }, () => NOW);
    const matLow = result.segment_risk_matrix.reduce((acc, r) => acc + r.stressed.low, 0);
    const matMed = result.segment_risk_matrix.reduce((acc, r) => acc + r.stressed.medium, 0);
    const matHigh = result.segment_risk_matrix.reduce((acc, r) => acc + r.stressed.high, 0);
    expect(matLow).toBe(result.stressed_bands.low);
    expect(matMed).toBe(result.stressed_bands.medium);
    expect(matHigh).toBe(result.stressed_bands.high);
  });
});

describe('POST /v1/scenario/run (T4.24 enveloped)', () => {
  const TENANT_HEADERS = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

  test('returns a full ScenarioResult wrapped in the envelope on a valid payload', async () => {
    const { app } = makeScenarioApp();
    const r = await request(app)
      .post('/v1/scenario/run')
      .set(TENANT_HEADERS)
      .send({ gdp: -2, rate: 100, fx: 5 });
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    const inner = r.body.body;
    expect(inner.portfolio_size).toBeGreaterThan(0);
    expect(inner.inputs).toEqual({ gdp: -2, rate: 100, fx: 5 });
    expect(inner.computed_at).toBe(NOW.toISOString());
    expect(inner.baseline_bands).toMatchObject({ low: expect.any(Number) });
    expect(Array.isArray(inner.segments)).toBe(true);
    expect(Array.isArray(inner.top_affected)).toBe(true);
  });

  test('400 envelope on out-of-range shock', async () => {
    const { app } = makeScenarioApp();
    const r = await request(app)
      .post('/v1/scenario/run')
      .set(TENANT_HEADERS)
      .send({ gdp: -20, rate: 0, fx: 0 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400');
    expect(r.body.error.message).toMatch(/gdp/);
  });

  test('400 envelope on missing body', async () => {
    const { app } = makeScenarioApp();
    const r = await request(app).post('/v1/scenario/run').set(TENANT_HEADERS).send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400');
  });
});
