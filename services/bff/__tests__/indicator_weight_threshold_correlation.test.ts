// @ts-nocheck
// __tests__/indicator_weight_threshold_correlation.test.ts
// T6 M4.21 — Indicator weight vs threshold correlation

import request from 'supertest';
import { buildWeightThresholdCorrelation } from '../src/indicator_weight_threshold_correlation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-09T10:00:00Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('buildWeightThresholdCorrelation — M4.21', () => {
  it('returns generated_at in ISO format', () => {
    const result = buildWeightThresholdCorrelation(NOW);
    expect(result.generated_at).toBe(NOW.toISOString());
  });

  it('total_indicators_with_both > 0 (catalog has matching entries)', () => {
    const result = buildWeightThresholdCorrelation(NOW);
    expect(result.total_indicators_with_both).toBeGreaterThan(0);
  });

  it('entries sorted by red_at_weight_product desc', () => {
    const result = buildWeightThresholdCorrelation(NOW);
    for (let i = 1; i < result.entries.length; i++) {
      expect(result.entries[i - 1].red_at_weight_product).toBeGreaterThanOrEqual(
        result.entries[i].red_at_weight_product,
      );
    }
  });

  it('severity_weight_rank is 1-based sequential', () => {
    const result = buildWeightThresholdCorrelation(NOW);
    for (let i = 0; i < result.entries.length; i++) {
      expect(result.entries[i].severity_weight_rank).toBe(i + 1);
    }
  });

  it('red_at_weight_product formula: weight * red_at', () => {
    const result = buildWeightThresholdCorrelation(NOW);
    for (const entry of result.entries) {
      const expected = entry.weight * entry.red_at;
      expect(entry.red_at_weight_product).toBeCloseTo(expected, 4);
    }
  });

  it('every entry has required shape', () => {
    const result = buildWeightThresholdCorrelation(NOW);
    for (const entry of result.entries) {
      expect(typeof entry.indicator_id).toBe('string');
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.vertical).toBe('string');
      expect(typeof entry.weight).toBe('number');
      expect(typeof entry.red_at).toBe('number');
      expect(typeof entry.orange_at).toBe('number');
      expect(typeof entry.yellow_at).toBe('number');
      expect(typeof entry.risk_band).toBe('string');
    }
  });

  it('high_weight_low_threshold: weight > 0.7 AND red_at < 0.7', () => {
    const result = buildWeightThresholdCorrelation(NOW);
    const hwlt = result.entries.filter(e => e.risk_band === 'high_weight_low_threshold');
    for (const e of hwlt) {
      expect(e.weight).toBeGreaterThan(0.7);
      expect(e.red_at).toBeLessThan(0.7);
    }
    expect(result.high_weight_low_threshold_count).toBe(hwlt.length);
  });

  it('low_weight_high_threshold: weight < 0.3 AND red_at > 0.7', () => {
    const result = buildWeightThresholdCorrelation(NOW);
    const lwht = result.entries.filter(e => e.risk_band === 'low_weight_high_threshold');
    for (const e of lwht) {
      expect(e.weight).toBeLessThan(0.3);
      expect(e.red_at).toBeGreaterThan(0.7);
    }
    expect(result.low_weight_high_threshold_count).toBe(lwht.length);
  });

  it('balanced_count + high_weight_low + low_weight_high = total', () => {
    const result = buildWeightThresholdCorrelation(NOW);
    expect(
      result.balanced_count +
      result.high_weight_low_threshold_count +
      result.low_weight_high_threshold_count,
    ).toBe(result.total_indicators_with_both);
  });

  it('platform-static: same response on same NOW', () => {
    const r1 = buildWeightThresholdCorrelation(NOW);
    const r2 = buildWeightThresholdCorrelation(NOW);
    expect(r1.total_indicators_with_both).toBe(r2.total_indicators_with_both);
    expect(r1.entries.map(e => e.indicator_id)).toEqual(r2.entries.map(e => e.indicator_id));
  });

  it('admin route GET /v1/indicators/weight-threshold-correlation → 200', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/indicators/weight-threshold-correlation')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.entries)).toBe(true);
    expect(typeof res.body.body.total_indicators_with_both).toBe('number');
  });

  it('non-admin → 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/indicators/weight-threshold-correlation')
      .set(TH_BIL)
      .set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });
});
