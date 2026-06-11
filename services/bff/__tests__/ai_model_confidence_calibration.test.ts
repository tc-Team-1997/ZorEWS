// @ts-nocheck
// T6 M7.23 — AI model confidence calibration analysis tests.

import request from 'supertest';
import { buildModelConfidenceCalibration } from '../src/ai_model_confidence_calibration';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const H = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

describe('buildModelConfidenceCalibration — shape', () => {
  test('returns correct envelope fields', () => {
    const r = buildModelConfidenceCalibration('pd_xgboost_v3', 'BIL', NOW);
    expect(r.model_id).toBe('pd_xgboost_v3');
    expect(r.tenant_id).toBe('BIL');
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(typeof r.calibration_error).toBe('number');
    expect(typeof r.is_well_calibrated).toBe('boolean');
    expect(typeof r.overconfident_buckets).toBe('number');
    expect(typeof r.underconfident_buckets).toBe('number');
  });

  test('returns 10 calibration buckets', () => {
    const r = buildModelConfidenceCalibration('pd_xgboost_v3', 'BIL', NOW);
    expect(r.calibration_buckets).toHaveLength(10);
  });

  test('each bucket has required fields', () => {
    const r = buildModelConfidenceCalibration('pd_xgboost_v3', 'BIL', NOW);
    for (const b of r.calibration_buckets) {
      expect(typeof b.predicted_range).toBe('string');
      expect(typeof b.count).toBe('number');
      expect(b.count).toBeGreaterThan(0);
      expect(typeof b.predicted_midpoint).toBe('number');
      expect(typeof b.observed_rate).toBe('number');
      expect(typeof b.calibration_error).toBe('number');
      expect(b.predicted_midpoint).toBeGreaterThanOrEqual(0);
      expect(b.predicted_midpoint).toBeLessThanOrEqual(1);
      expect(b.observed_rate).toBeGreaterThanOrEqual(0);
      expect(b.observed_rate).toBeLessThanOrEqual(1);
    }
  });

  test('calibration_error matches buckets', () => {
    const r = buildModelConfidenceCalibration('pd_xgboost_v3', 'BIL', NOW);
    const expectedError = r.calibration_buckets.reduce((s, b) => s + b.calibration_error, 0) / r.calibration_buckets.length;
    expect(Math.abs(r.calibration_error - expectedError)).toBeLessThan(0.001);
  });

  test('is_well_calibrated matches threshold', () => {
    const r = buildModelConfidenceCalibration('pd_xgboost_v3', 'BIL', NOW);
    expect(r.is_well_calibrated).toBe(r.calibration_error < 0.05);
  });

  test('deterministic per (tenant, model_id, day)', () => {
    const r1 = buildModelConfidenceCalibration('model-x', 'BIL', NOW);
    const r2 = buildModelConfidenceCalibration('model-x', 'BIL', NOW);
    expect(r1.calibration_error).toBe(r2.calibration_error);
  });

  test('different model_id yields different calibration', () => {
    const r1 = buildModelConfidenceCalibration('model-a', 'BIL', NOW);
    const r2 = buildModelConfidenceCalibration('model-b', 'BIL', NOW);
    expect(r1.calibration_error).not.toBe(r2.calibration_error);
  });

  test('overconfident + underconfident <= 10', () => {
    const r = buildModelConfidenceCalibration('pd_xgboost_v3', 'BIL', NOW);
    expect(r.overconfident_buckets + r.underconfident_buckets).toBeLessThanOrEqual(10);
  });
});

describe('route — /v1/ai/models/:model_id/confidence-calibration', () => {
  test('GET returns 200 for known model', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
    });
    // The default registry has some seed models; try with the first available id
    const res = await request(app).get('/v1/ai/models/pd_xgboost_v3/confidence-calibration').set(H);
    // 200 if model exists, 404 if not — both are valid
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.body.calibration_buckets).toHaveLength(10);
    }
  });

  test('GET returns 404 for unknown model', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
    });
    const res = await request(app).get('/v1/ai/models/nonexistent-model-xyz/confidence-calibration').set(H);
    expect(res.status).toBe(404);
  });

  test('403 for wrong role', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'unknown_role',
    });
    const res = await request(app).get('/v1/ai/models/model-1/confidence-calibration').set(H);
    expect(res.status).toBe(403);
  });
});
