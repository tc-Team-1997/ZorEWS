// services/bff/__tests__/threshold_auto_tune.test.ts
//
// T6 M4.10 — Indicator threshold auto-tune suggestion.

import request from 'supertest';
import {
  suggestThresholdsFromHistory,
  ThresholdSuggestionError,
  isThresholdPolarity,
} from '../src/threshold_auto_tune';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── isThresholdPolarity ─────────────────────────────────────────────

describe('M4.10 — isThresholdPolarity', () => {
  test('accepts the two valid values', () => {
    expect(isThresholdPolarity('higher_is_worse')).toBe(true);
    expect(isThresholdPolarity('lower_is_worse')).toBe(true);
  });
  test('rejects everything else', () => {
    expect(isThresholdPolarity('bogus')).toBe(false);
    expect(isThresholdPolarity(null)).toBe(false);
    expect(isThresholdPolarity(undefined)).toBe(false);
    expect(isThresholdPolarity(1)).toBe(false);
  });
});

// ─── suggestThresholdsFromHistory — pure ─────────────────────────────

describe('M4.10 — insufficient samples', () => {
  test('empty values → no_finite_values reason', () => {
    const out = suggestThresholdsFromHistory([]);
    expect(out.suggested).toBeNull();
    expect(out.sample_size).toBe(0);
    expect(out.insufficient_reason).toBe('no_finite_values');
  });

  test('< 5 samples → too_few_samples reason; sample_min/max populated', () => {
    const out = suggestThresholdsFromHistory([0.3, 0.5, 0.7]);
    expect(out.suggested).toBeNull();
    expect(out.sample_size).toBe(3);
    expect(out.sample_min).toBe(0.3);
    expect(out.sample_max).toBe(0.7);
    expect(out.insufficient_reason).toBe('too_few_samples');
  });

  test('all-NaN values → no_finite_values', () => {
    const out = suggestThresholdsFromHistory([NaN, Infinity, -Infinity]);
    expect(out.suggested).toBeNull();
    expect(out.insufficient_reason).toBe('no_finite_values');
  });
});

describe('M4.10 — higher_is_worse polarity', () => {
  test('uniform [0..1] sample → red ≈ p95, orange ≈ p75, yellow ≈ p50', () => {
    const values = Array.from({ length: 101 }, (_, i) => i / 100);
    const out = suggestThresholdsFromHistory(values, 'higher_is_worse')!;
    expect(out.suggested).not.toBeNull();
    const t = out.suggested!;
    expect(t.yellow_at).toBeCloseTo(0.5, 2);
    expect(t.orange_at).toBeCloseTo(0.75, 2);
    expect(t.red_at).toBeCloseTo(0.95, 2);
    // Monotonic strictly increasing.
    expect(t.yellow_at).toBeLessThan(t.orange_at);
    expect(t.orange_at).toBeLessThan(t.red_at);
  });

  test('skewed sample (most-bad) raises all three thresholds', () => {
    const easy = Array.from({ length: 100 }, (_, i) => i / 100); // 0..1 uniform
    const hard = Array.from({ length: 100 }, (_, i) => 0.5 + i / 200); // 0.5..1
    const a = suggestThresholdsFromHistory(easy)!;
    const b = suggestThresholdsFromHistory(hard)!;
    expect(b.suggested!.red_at).toBeGreaterThan(a.suggested!.red_at);
    expect(b.suggested!.yellow_at).toBeGreaterThan(a.suggested!.yellow_at);
  });
});

describe('M4.10 — lower_is_worse polarity', () => {
  test('uniform [0..1] sample → red ≈ p5, orange ≈ p25, yellow ≈ p50', () => {
    const values = Array.from({ length: 101 }, (_, i) => i / 100);
    const out = suggestThresholdsFromHistory(values, 'lower_is_worse')!;
    const t = out.suggested!;
    expect(t.yellow_at).toBeCloseTo(0.5, 2);
    expect(t.orange_at).toBeCloseTo(0.25, 2);
    expect(t.red_at).toBeCloseTo(0.05, 2);
    // For lower_is_worse: red < orange < yellow (lower = worse).
    expect(t.red_at).toBeLessThan(t.orange_at);
    expect(t.orange_at).toBeLessThan(t.yellow_at);
  });
});

describe('M4.10 — polarity validation', () => {
  test('invalid polarity throws ThresholdSuggestionError', () => {
    expect(() => suggestThresholdsFromHistory([1, 2, 3, 4, 5], 'sideways' as never)).toThrow(
      ThresholdSuggestionError,
    );
  });
});

describe('M4.10 — drops non-finite values', () => {
  test('mixed finite + non-finite → only finite contribute to count', () => {
    const out = suggestThresholdsFromHistory([0.1, NaN, 0.3, Infinity, 0.5, 0.7, 0.9], 'higher_is_worse')!;
    expect(out.sample_size).toBe(5);
    expect(out.suggested).not.toBeNull();
  });
});

// ─── POST /v1/indicators/:indicator_id/thresholds/suggest ────────────

function makeSuggestApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M4.10 — POST /v1/indicators/:indicator_id/thresholds/suggest', () => {
  test('happy path: sufficient samples → suggested envelope', async () => {
    const { app } = makeSuggestApp('admin');
    const values = Array.from({ length: 50 }, (_, i) => i / 50);
    const r = await request(app)
      .post('/v1/indicators/thresholds/FIN-001/suggest')
      .set(TH_BIL)
      .send({ values, polarity: 'higher_is_worse' });
    expect(r.status).toBe(200);
    expect(r.body.body.suggested).not.toBeNull();
    expect(r.body.body.sample_size).toBe(50);
    expect(r.body.body.polarity).toBe('higher_is_worse');
  });

  test('insufficient samples → 200 with null suggested + reason', async () => {
    const { app } = makeSuggestApp('admin');
    const r = await request(app)
      .post('/v1/indicators/thresholds/FIN-001/suggest')
      .set(TH_BIL)
      .send({ values: [0.5, 0.6] });
    expect(r.status).toBe(200);
    expect(r.body.body.suggested).toBeNull();
    expect(r.body.body.insufficient_reason).toBe('too_few_samples');
  });

  test('default polarity is higher_is_worse', async () => {
    const { app } = makeSuggestApp('admin');
    const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    const r = await request(app)
      .post('/v1/indicators/thresholds/FIN-001/suggest')
      .set(TH_BIL)
      .send({ values });
    expect(r.status).toBe(200);
    expect(r.body.body.polarity).toBe('higher_is_worse');
  });

  test('unknown indicator → 404 unknown_indicator', async () => {
    const { app } = makeSuggestApp('admin');
    const r = await request(app)
      .post('/v1/indicators/thresholds/NOT-A-REAL-IND/suggest')
      .set(TH_BIL)
      .send({ values: [0.1, 0.2, 0.3, 0.4, 0.5] });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_indicator');
  });

  test('missing values array → 400', async () => {
    const { app } = makeSuggestApp('admin');
    const r = await request(app)
      .post('/v1/indicators/thresholds/FIN-001/suggest')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-numeric values → 400', async () => {
    const { app } = makeSuggestApp('admin');
    const r = await request(app)
      .post('/v1/indicators/thresholds/FIN-001/suggest')
      .set(TH_BIL)
      .send({ values: ['oops', 'not', 'numbers'] });
    expect(r.status).toBe(400);
  });

  test('invalid polarity → 400', async () => {
    const { app } = makeSuggestApp('admin');
    const r = await request(app)
      .post('/v1/indicators/thresholds/FIN-001/suggest')
      .set(TH_BIL)
      .send({ values: [0.1, 0.2, 0.3, 0.4, 0.5], polarity: 'sideways' });
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSuggestApp('readonly');
    const r = await request(app)
      .post('/v1/indicators/thresholds/FIN-001/suggest')
      .set(TH_BIL)
      .send({ values: [0.1, 0.2, 0.3, 0.4, 0.5] });
    expect(r.status).toBe(403);
  });
});
