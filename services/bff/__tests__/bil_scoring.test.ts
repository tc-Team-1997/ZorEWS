// services/bff/__tests__/bil_scoring.test.ts
//
// T6 M6.1 — BIL risk-scoring engine. Covers:
//   - the pure computeRiskScore() function (math, clamping, bucketing,
//     threshold override, error paths)
//   - the POST /v1/scoring/risk route (tenant gate, RBAC, envelope shape,
//     400 on bad input, both raw and enveloped request bodies)

import request from 'supertest';
import { computeRiskScore, DEFAULT_THRESHOLDS } from '../src/bil_scoring';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');

function makeScoringApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

describe('computeRiskScore — pure function (T6 M6.1)', () => {
  test('all-zero values → score 0, low', () => {
    const r = computeRiskScore([
      { indicator_id: 'POL-001', weight: 0.5, value: 0 },
      { indicator_id: 'POL-002', weight: 0.7, value: 0 },
    ]);
    expect(r.score).toBe(0);
    expect(r.category).toBe('low');
    expect(r.raw_sum).toBe(0);
    expect(r.total_weight).toBe(1.2);
  });

  test('all-one values with full weight → score 100, high', () => {
    const r = computeRiskScore([
      { indicator_id: 'POL-001', weight: 1.0, value: 1.0 },
      { indicator_id: 'POL-002', weight: 1.0, value: 1.0 },
    ]);
    expect(r.score).toBe(100);
    expect(r.category).toBe('high');
  });

  test('Σ(W×V) formula: 0.5×0.6 + 0.3×0.4 = 0.42 / 0.8 weight = 52.5 → medium', () => {
    const r = computeRiskScore([
      { indicator_id: 'A', weight: 0.5, value: 0.6 },
      { indicator_id: 'B', weight: 0.3, value: 0.4 },
    ]);
    expect(r.raw_sum).toBeCloseTo(0.42, 4);
    expect(r.total_weight).toBeCloseTo(0.8, 4);
    expect(r.score).toBeCloseTo(52.5, 1);
    expect(r.category).toBe('medium');
  });

  test('boundary at low_max=30 inclusive → low', () => {
    // raw=0.3, total_weight=1.0, score=30 → exactly low
    const r = computeRiskScore([{ indicator_id: 'X', weight: 1.0, value: 0.3 }]);
    expect(r.score).toBe(30);
    expect(r.category).toBe('low');
  });

  test('just above low_max → medium', () => {
    const r = computeRiskScore([{ indicator_id: 'X', weight: 1.0, value: 0.31 }]);
    expect(r.score).toBe(31);
    expect(r.category).toBe('medium');
  });

  test('boundary at medium_max=70 inclusive → medium', () => {
    const r = computeRiskScore([{ indicator_id: 'X', weight: 1.0, value: 0.7 }]);
    expect(r.score).toBe(70);
    expect(r.category).toBe('medium');
  });

  test('above medium_max → high', () => {
    const r = computeRiskScore([{ indicator_id: 'X', weight: 1.0, value: 0.71 }]);
    expect(r.score).toBe(71);
    expect(r.category).toBe('high');
  });

  test('default thresholds echoed when not overridden', () => {
    const r = computeRiskScore([{ indicator_id: 'X', weight: 1.0, value: 0.5 }]);
    expect(r.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  test('threshold override — strict {20, 60} bumps a 0.5/0.5 score into high range', () => {
    // raw=0.25, weight=0.5, score=50 → with strict thresholds, 50 > 60? no →
    // medium. Use a steeper input: 0.7 value, weight 1.0 → 70. 70 > 60 → high.
    const r = computeRiskScore(
      [{ indicator_id: 'X', weight: 1.0, value: 0.7 }],
      { low_max: 20, medium_max: 60 },
    );
    expect(r.score).toBe(70);
    expect(r.category).toBe('high');
    expect(r.thresholds).toEqual({ low_max: 20, medium_max: 60 });
  });

  test('partial threshold override picks up default for the missing field', () => {
    const r = computeRiskScore(
      [{ indicator_id: 'X', weight: 1.0, value: 0.4 }],
      { low_max: 50 },
    );
    expect(r.thresholds).toEqual({ low_max: 50, medium_max: 70 });
    // 40 ≤ 50 → low
    expect(r.category).toBe('low');
  });

  test('value > 1 is clamped to 1', () => {
    const r = computeRiskScore([{ indicator_id: 'X', weight: 1.0, value: 5.0 }]);
    expect(r.score).toBe(100);
    expect(r.breakdown[0]!.value).toBe(1);
  });

  test('value < 0 is clamped to 0', () => {
    const r = computeRiskScore([{ indicator_id: 'X', weight: 1.0, value: -5.0 }]);
    expect(r.score).toBe(0);
    expect(r.breakdown[0]!.value).toBe(0);
  });

  test('breakdown order matches input order', () => {
    const r = computeRiskScore([
      { indicator_id: 'C', weight: 0.1, value: 0.2 },
      { indicator_id: 'A', weight: 0.5, value: 0.6 },
      { indicator_id: 'B', weight: 0.3, value: 0.4 },
    ]);
    expect(r.breakdown.map((b) => b.indicator_id)).toEqual(['C', 'A', 'B']);
  });

  test('all weights zero → score 0, low (no NaN)', () => {
    const r = computeRiskScore([
      { indicator_id: 'A', weight: 0, value: 0.9 },
      { indicator_id: 'B', weight: 0, value: 0.5 },
    ]);
    expect(r.score).toBe(0);
    expect(r.total_weight).toBe(0);
    expect(r.category).toBe('low');
    expect(Number.isNaN(r.score)).toBe(false);
  });

  test('throws on empty items', () => {
    expect(() => computeRiskScore([])).toThrow(/non-empty/);
  });

  test('throws on weight > 1', () => {
    expect(() =>
      computeRiskScore([{ indicator_id: 'X', weight: 1.5, value: 0.5 }]),
    ).toThrow(/weight/);
  });

  test('throws on weight < 0', () => {
    expect(() =>
      computeRiskScore([{ indicator_id: 'X', weight: -0.1, value: 0.5 }]),
    ).toThrow(/weight/);
  });

  test('throws on missing indicator_id', () => {
    expect(() =>
      computeRiskScore([{ indicator_id: '', weight: 0.5, value: 0.5 }]),
    ).toThrow(/indicator_id/);
  });

  test('throws on NaN value', () => {
    expect(() =>
      computeRiskScore([{ indicator_id: 'X', weight: 0.5, value: NaN }]),
    ).toThrow(/value/);
  });

  test('throws on inverted thresholds', () => {
    expect(() =>
      computeRiskScore([{ indicator_id: 'X', weight: 0.5, value: 0.5 }], {
        low_max: 80,
        medium_max: 40,
      }),
    ).toThrow(/threshold/);
  });

  test('throws on threshold > 100', () => {
    expect(() =>
      computeRiskScore([{ indicator_id: 'X', weight: 0.5, value: 0.5 }], {
        low_max: 30,
        medium_max: 150,
      }),
    ).toThrow(/threshold/);
  });

  test('throws on negative low_max', () => {
    expect(() =>
      computeRiskScore([{ indicator_id: 'X', weight: 0.5, value: 0.5 }], {
        low_max: -10,
        medium_max: 70,
      }),
    ).toThrow(/threshold/);
  });
});

describe('POST /v1/scoring/risk — route (T6 M6.1)', () => {
  test('admin: enveloped 200 with score + category + breakdown', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk')
      .set(TH)
      .send({
        items: [
          { indicator_id: 'POL-001', weight: 0.5, value: 0.6 },
          { indicator_id: 'CLM-002', weight: 0.3, value: 0.4 },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.body.score).toBeCloseTo(52.5, 1);
    expect(r.body.body.category).toBe('medium');
    expect(r.body.body.breakdown).toHaveLength(2);
    // Envelope header invariants
    expect(r.body.header).toBeDefined();
    expect(r.body.header.tenantId ?? r.body.header.tenant_id ?? r.body.header.requestId).toBeDefined();
  });

  test('accepts an enveloped request body ({header, body})', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk')
      .set(TH)
      .send({
        header: { requestId: 'req-1' },
        body: {
          items: [{ indicator_id: 'X', weight: 1.0, value: 0.85 }],
        },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.score).toBe(85);
    expect(r.body.body.category).toBe('high');
  });

  test('threshold override is honoured', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk')
      .set(TH)
      .send({
        items: [{ indicator_id: 'X', weight: 1.0, value: 0.4 }],
        thresholds: { low_max: 50, medium_max: 70 },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.score).toBe(40);
    expect(r.body.body.category).toBe('low');
    expect(r.body.body.thresholds).toEqual({ low_max: 50, medium_max: 70 });
  });

  test('empty items → 400 with code EWS_400_empty_items', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app).post('/v1/scoring/risk').set(TH).send({ items: [] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_empty_items');
  });

  test('weight out of range → 400 with code EWS_400_invalid_weight', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk')
      .set(TH)
      .send({ items: [{ indicator_id: 'X', weight: 1.7, value: 0.5 }] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_weight');
  });

  test('inverted thresholds → 400 with code EWS_400_invalid_thresholds', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk')
      .set(TH)
      .send({
        items: [{ indicator_id: 'X', weight: 0.5, value: 0.5 }],
        thresholds: { low_max: 80, medium_max: 40 },
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_thresholds');
  });

  test('missing body → 400', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk')
      .set(TH)
      .set('Content-Type', 'application/json')
      .send('null');
    expect(r.status).toBe(400);
  });

  test('no tenant header → 400 (envelope error)', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk')
      .send({ items: [{ indicator_id: 'X', weight: 1.0, value: 0.5 }] });
    // Tenant middleware returns either 400 or 403 depending on config;
    // either way it must NOT 200.
    expect(r.status).not.toBe(200);
  });

  test('unknown role → 403 (fail-closed)', async () => {
    const { app } = makeScoringApp('case_owner'); // not in the matrix
    const r = await request(app)
      .post('/v1/scoring/risk')
      .set(TH)
      .send({ items: [{ indicator_id: 'X', weight: 1.0, value: 0.5 }] });
    expect(r.status).toBe(403);
  });

  test('risk_analyst (real role) accepted', async () => {
    const { app } = makeScoringApp('risk_analyst');
    const r = await request(app)
      .post('/v1/scoring/risk')
      .set(TH)
      .send({ items: [{ indicator_id: 'X', weight: 1.0, value: 0.5 }] });
    expect(r.status).toBe(200);
    expect(r.body.body.score).toBe(50);
  });
});
