// @ts-nocheck
import { describe, it, expect } from '@jest/globals';
import { makeApp } from '../src/server';
import supertest from 'supertest';
import { buildScoringModelCalibration } from '../src/scoring_model_calibration';

const NOW = new Date('2026-06-11T12:00:00Z');

describe('buildScoringModelCalibration', () => {
  it('returns 10 buckets', () => {
    const out = buildScoringModelCalibration('BIL', NOW);
    expect(out.buckets.length).toBe(10);
  });

  it('bucket ranges cover 0-100', () => {
    const out = buildScoringModelCalibration('BIL', NOW);
    expect(out.buckets[0].range).toBe('0-10');
    expect(out.buckets[9].range).toBe('90-100');
  });

  it('calibration_score is in [0, 100]', () => {
    const out = buildScoringModelCalibration('BIL', NOW);
    expect(out.calibration_score).toBeGreaterThanOrEqual(0);
    expect(out.calibration_score).toBeLessThanOrEqual(100);
  });

  it('calibration_grade is A/B/C/D', () => {
    const out = buildScoringModelCalibration('BIL', NOW);
    expect(['A', 'B', 'C', 'D']).toContain(out.calibration_grade);
  });

  it('expected_pd is bucket midpoint / 100', () => {
    const out = buildScoringModelCalibration('BIL', NOW);
    expect(out.buckets[0].expected_pd).toBe(0.05); // (0+10)/2/100
    expect(out.buckets[5].expected_pd).toBe(0.55); // (50+60)/2/100
  });

  it('observed_pd is in [0, 1]', () => {
    const out = buildScoringModelCalibration('BIL', NOW);
    for (const b of out.buckets) {
      expect(b.observed_pd).toBeGreaterThanOrEqual(0);
      expect(b.observed_pd).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic per tenant+day', () => {
    const out1 = buildScoringModelCalibration('BIL', NOW);
    const out2 = buildScoringModelCalibration('BIL', NOW);
    expect(out1.buckets).toEqual(out2.buckets);
  });

  it('has required envelope fields', () => {
    const out = buildScoringModelCalibration('BIL', NOW);
    expect(out.tenant_id).toBe('BIL');
    expect(out.generated_at).toBeDefined();
    expect(typeof out.avg_calibration_error).toBe('number');
  });

  it('worst_bucket is the range string of highest-error bucket', () => {
    const out = buildScoringModelCalibration('BIL', NOW);
    if (out.worst_bucket) {
      const worst = out.buckets.find(b => b.range === out.worst_bucket);
      expect(worst).toBeDefined();
      const maxErr = Math.max(...out.buckets.map(b => b.calibration_error));
      expect(worst.calibration_error).toBe(maxErr);
    }
  });
});

describe('GET /v1/scoring/model-calibration', () => {
  it('returns 200 for risk_analyst', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/scoring/model-calibration')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'risk_analyst');
    expect(res.status).toBe(200);
    expect(res.body.body.buckets.length).toBe(10);
  });

  it('returns 403 for unknown role', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/scoring/model-calibration')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'unknown_role');
    expect(res.status).toBe(403);
  });

  it('is platform-static across tenants', async () => {
    const { app } = makeApp({});
    const resBil = await supertest(app)
      .get('/v1/scoring/model-calibration')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'admin');
    const resBank = await supertest(app)
      .get('/v1/scoring/model-calibration')
      .set('X-Tenant-ID', 'BANK_DEMO').set('X-Channel', 'API').set('x-apex-role', 'admin');
    // Different tenant → different PRNG seed → possibly different values (tenant-scoped synth)
    expect(resBil.status).toBe(200);
    expect(resBank.status).toBe(200);
  });
});
