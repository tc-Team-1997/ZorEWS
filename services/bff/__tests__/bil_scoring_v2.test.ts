// services/bff/__tests__/bil_scoring_v2.test.ts
//
// T6 M6.2 — BIL scoring with catalog weight lookup.

import request from 'supertest';
import {
  IndicatorLookupError,
  STUB_CATALOG,
  StubIndicatorWeightLookup,
  isScoringVertical,
  scoreFromIndicators,
  type IndicatorWeightLookup,
  type ScoringByIndicatorsResult,
} from '../src/bil_scoring_v2';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeScoringApp(role: string = 'admin', indicatorWeightLookup?: IndicatorWeightLookup) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    indicatorWeightLookup,
  });
}

// ─── Type guard + STUB_CATALOG schema ──────────────────────────────────

describe('Type guard + STUB_CATALOG schema', () => {
  test('isScoringVertical accepts banking/insurance, rejects others', () => {
    expect(isScoringVertical('banking')).toBe(true);
    expect(isScoringVertical('insurance')).toBe(true);
    expect(isScoringVertical('Banking')).toBe(false);
    expect(isScoringVertical('crypto')).toBe(false);
  });

  test('every catalog entry declares weight in (0, 1] and a non-empty name', () => {
    const ids = Object.keys(STUB_CATALOG);
    expect(ids.length).toBeGreaterThanOrEqual(15);
    for (const id of ids) {
      const e = STUB_CATALOG[id]!;
      expect(e.weight).toBeGreaterThan(0);
      expect(e.weight).toBeLessThanOrEqual(1);
      expect(typeof e.name).toBe('string');
      expect(e.name.length).toBeGreaterThan(0);
      expect(['banking', 'insurance']).toContain(e.vertical);
    }
  });

  test('catalogue spans both verticals', () => {
    const verticals = new Set(Object.values(STUB_CATALOG).map((e) => e.vertical));
    expect(verticals.has('banking')).toBe(true);
    expect(verticals.has('insurance')).toBe(true);
  });

  test('id prefixes match catalogue conventions', () => {
    const VALID_PREFIXES = ['FIN', 'BEH', 'TXN', 'CRD', 'POL', 'CUS', 'AGT', 'CLM', 'OPS'];
    for (const id of Object.keys(STUB_CATALOG)) {
      const prefix = id.split('-')[0]!;
      expect(VALID_PREFIXES).toContain(prefix);
    }
  });
});

// ─── StubIndicatorWeightLookup ─────────────────────────────────────────

describe('StubIndicatorWeightLookup', () => {
  test('returns weight + name for known id', () => {
    const l = new StubIndicatorWeightLookup();
    const w = l.getWeight('FIN-001');
    expect(w).not.toBeNull();
    expect(w!.weight).toBe(0.9);
    expect(w!.name).toMatch(/DPD/);
  });

  test('returns null for unknown id', () => {
    const l = new StubIndicatorWeightLookup();
    expect(l.getWeight('NO-SUCH-001')).toBeNull();
  });

  test('vertical filter — banking id queried as insurance returns null', () => {
    const l = new StubIndicatorWeightLookup();
    expect(l.getWeight('FIN-001', 'insurance')).toBeNull();
  });

  test('vertical filter — insurance id queried as banking returns null', () => {
    const l = new StubIndicatorWeightLookup();
    expect(l.getWeight('CLM-001', 'banking')).toBeNull();
  });

  test('vertical match returns the entry', () => {
    const l = new StubIndicatorWeightLookup();
    expect(l.getWeight('FIN-001', 'banking')).not.toBeNull();
    expect(l.getWeight('CLM-001', 'insurance')).not.toBeNull();
  });

  test('no vertical filter → returns regardless of vertical', () => {
    const l = new StubIndicatorWeightLookup();
    expect(l.getWeight('FIN-001')).not.toBeNull();
    expect(l.getWeight('CLM-001')).not.toBeNull();
  });
});

// ─── scoreFromIndicators ───────────────────────────────────────────────

describe('scoreFromIndicators', () => {
  const lookup = new StubIndicatorWeightLookup();

  test('happy path — resolves weights + delegates to M6.1, returns score + resolved[]', () => {
    const r = scoreFromIndicators(
      [
        { indicator_id: 'FIN-001', value: 0.8 },
        { indicator_id: 'FIN-002', value: 0.5 },
      ],
      lookup,
    );
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(['low', 'medium', 'high']).toContain(r.category);
    expect(r.resolved.length).toBe(2);
    expect(r.resolved[0]!.indicator_id).toBe('FIN-001');
    expect(r.resolved[0]!.weight).toBe(0.9);
    expect(r.resolved[0]!.name).toMatch(/DPD/);
    expect(r.vertical).toBeNull();
  });

  test('resolved order matches input order (not catalog order)', () => {
    const r = scoreFromIndicators(
      [
        { indicator_id: 'CLM-001', value: 0.7 },
        { indicator_id: 'POL-001', value: 0.4 },
        { indicator_id: 'AGT-001', value: 0.5 },
      ],
      lookup,
    );
    expect(r.resolved.map((x) => x.indicator_id)).toEqual(['CLM-001', 'POL-001', 'AGT-001']);
  });

  test('vertical filter passed through to lookup', () => {
    const r = scoreFromIndicators(
      [
        { indicator_id: 'CLM-001', value: 0.7 },
        { indicator_id: 'POL-001', value: 0.4 },
      ],
      lookup,
      { vertical: 'insurance' },
    );
    expect(r.vertical).toBe('insurance');
  });

  test('threshold override forwarded to M6.1', () => {
    const r = scoreFromIndicators(
      [{ indicator_id: 'FIN-001', value: 0.4 }],
      lookup,
      { thresholds: { low_max: 50, medium_max: 70 } },
    );
    expect(r.thresholds).toEqual({ low_max: 50, medium_max: 70 });
  });

  test('formula matches M6.1 — Σ(W×V)/Σ(W) × 100', () => {
    const r = scoreFromIndicators(
      [
        { indicator_id: 'FIN-001', value: 1.0 }, // weight 0.9 → contributes 0.9
        { indicator_id: 'FIN-002', value: 0.5 }, // weight 0.7 → contributes 0.35
      ],
      lookup,
    );
    // total weight 1.6; raw 1.25; score = 1.25/1.6 * 100 = 78.125
    expect(r.score).toBeCloseTo(78.125, 1);
    expect(r.total_weight).toBeCloseTo(1.6, 4);
    expect(r.raw_sum).toBeCloseTo(1.25, 4);
    expect(r.category).toBe('high');
  });

  test('unknown indicator → IndicatorLookupError(unknown_indicator) — fail-fast', () => {
    try {
      scoreFromIndicators(
        [
          { indicator_id: 'FIN-001', value: 0.5 },
          { indicator_id: 'NO-SUCH-001', value: 0.3 },
        ],
        lookup,
      );
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(IndicatorLookupError);
      expect((e as IndicatorLookupError).code).toBe('unknown_indicator');
      expect((e as IndicatorLookupError).message).toMatch(/NO-SUCH-001/);
    }
  });

  test('cross-vertical id with vertical filter → unknown_indicator', () => {
    try {
      scoreFromIndicators(
        [{ indicator_id: 'FIN-001', value: 0.5 }],
        lookup,
        { vertical: 'insurance' },
      );
      fail('expected throw');
    } catch (e) {
      expect((e as IndicatorLookupError).code).toBe('unknown_indicator');
      expect((e as IndicatorLookupError).message).toMatch(/insurance/);
    }
  });

  test('non-array items → invalid_input', () => {
    expect(() =>
      scoreFromIndicators(undefined as unknown as never, lookup),
    ).toThrow(/items must be an array/);
  });

  test('missing indicator_id → invalid_input', () => {
    expect(() =>
      scoreFromIndicators([{ indicator_id: '', value: 0.5 }], lookup),
    ).toThrow(/indicator_id is required/);
  });

  test('NaN value → invalid_input', () => {
    expect(() =>
      scoreFromIndicators([{ indicator_id: 'FIN-001', value: NaN }], lookup),
    ).toThrow(/finite number/);
  });

  test('empty items defers to M6.1 empty_items path', () => {
    expect(() => scoreFromIndicators([], lookup)).toThrow(/non-empty/);
  });
});

// ─── Route ─────────────────────────────────────────────────────────────

describe('POST /v1/scoring/risk/by-indicators', () => {
  test('admin: 200 with score + resolved[]', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-indicators')
      .set(TH)
      .send({
        items: [
          { indicator_id: 'FIN-001', value: 0.8 },
          { indicator_id: 'FIN-002', value: 0.5 },
        ],
      });
    expect(r.status).toBe(200);
    const body = r.body.body as ScoringByIndicatorsResult;
    expect(body.score).toBeGreaterThan(0);
    expect(body.resolved.length).toBe(2);
    expect(body.resolved[0]!.weight).toBe(0.9);
  });

  test('accepts an enveloped request body', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-indicators')
      .set(TH)
      .send({
        header: { requestId: 'r-1' },
        body: {
          items: [{ indicator_id: 'CLM-001', value: 0.6 }],
          vertical: 'insurance',
        },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.vertical).toBe('insurance');
  });

  test('vertical=insurance happy path', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-indicators')
      .set(TH)
      .send({
        items: [
          { indicator_id: 'CLM-001', value: 0.7 },
          { indicator_id: 'CLM-002', value: 0.5 },
        ],
        vertical: 'insurance',
      });
    expect(r.status).toBe(200);
    expect(r.body.body.vertical).toBe('insurance');
  });

  test('vertical=invalid → 400 EWS_400_invalid_vertical', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-indicators')
      .set(TH)
      .send({
        items: [{ indicator_id: 'FIN-001', value: 0.5 }],
        vertical: 'crypto',
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_vertical');
  });

  test('unknown indicator → 404 EWS_404_unknown_indicator', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-indicators')
      .set(TH)
      .send({ items: [{ indicator_id: 'NO-SUCH-001', value: 0.5 }] });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_indicator');
  });

  test('cross-vertical mismatch → 404 EWS_404_unknown_indicator', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-indicators')
      .set(TH)
      .send({
        items: [{ indicator_id: 'FIN-001', value: 0.5 }],
        vertical: 'insurance',
      });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_indicator');
  });

  test('threshold override is forwarded to the formula', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-indicators')
      .set(TH)
      .send({
        items: [{ indicator_id: 'FIN-001', value: 0.4 }],
        thresholds: { low_max: 50, medium_max: 70 },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.thresholds).toEqual({ low_max: 50, medium_max: 70 });
  });

  test('missing customer_id-style empty body → 400', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-indicators')
      .set(TH)
      .set('Content-Type', 'application/json')
      .send('null');
    expect(r.status).toBe(400);
  });

  test('invalid value (NaN) → 400 EWS_400_invalid_input', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk/by-indicators')
      .set(TH)
      .send({ items: [{ indicator_id: 'FIN-001', value: 'oops' }] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-analyst role → 403', async () => {
    const { app } = makeScoringApp('case_owner');
    const r = await request(app)
      .post('/v1/scoring/risk/by-indicators')
      .set(TH)
      .send({ items: [{ indicator_id: 'FIN-001', value: 0.5 }] });
    expect(r.status).toBe(403);
  });

  test('risk_analyst (real role) accepted', async () => {
    const { app } = makeScoringApp('risk_analyst');
    const r = await request(app)
      .post('/v1/scoring/risk/by-indicators')
      .set(TH)
      .send({ items: [{ indicator_id: 'FIN-001', value: 0.5 }] });
    expect(r.status).toBe(200);
  });

  test('custom lookup injected via deps takes effect', async () => {
    const customLookup: IndicatorWeightLookup = {
      getWeight: (id) =>
        id === 'CUSTOM-001' ? { weight: 0.42, name: 'Custom test indicator' } : null,
    };
    const { app } = makeScoringApp('admin', customLookup);
    const r = await request(app)
      .post('/v1/scoring/risk/by-indicators')
      .set(TH)
      .send({ items: [{ indicator_id: 'CUSTOM-001', value: 0.5 }] });
    expect(r.status).toBe(200);
    expect(r.body.body.resolved[0].weight).toBe(0.42);
  });
});

// ─── Sanity: M6.1 unaffected ───────────────────────────────────────────

describe('No-regression: M6.1 /v1/scoring/risk still works', () => {
  test('the original M6.1 endpoint still accepts explicit weights', async () => {
    const { app } = makeScoringApp('admin');
    const r = await request(app)
      .post('/v1/scoring/risk')
      .set(TH)
      .send({
        items: [
          { indicator_id: 'X', weight: 0.5, value: 0.6 },
          { indicator_id: 'Y', weight: 0.3, value: 0.4 },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.body.score).toBeCloseTo(52.5, 1);
  });
});
