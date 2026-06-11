// @ts-nocheck
import { describe, it, expect } from '@jest/globals';
import { makeApp } from '../src/server';
import supertest from 'supertest';
import { buildIndicatorCorrelationMatrix } from '../src/indicator_correlation_matrix';

const NOW = new Date('2026-06-11T12:00:00Z');

describe('buildIndicatorCorrelationMatrix', () => {
  it('returns 6 indicators', () => {
    const out = buildIndicatorCorrelationMatrix('BIL', NOW);
    expect(out.indicators.length).toBe(6);
  });

  it('returns 6x6 matrix', () => {
    const out = buildIndicatorCorrelationMatrix('BIL', NOW);
    expect(out.matrix.length).toBe(6);
    for (const row of out.matrix) {
      expect(row.length).toBe(6);
    }
  });

  it('has 1.0 on diagonal', () => {
    const out = buildIndicatorCorrelationMatrix('BIL', NOW);
    for (let i = 0; i < 6; i++) {
      expect(out.matrix[i][i]).toBe(1);
    }
  });

  it('correlations are in [-1, 1]', () => {
    const out = buildIndicatorCorrelationMatrix('BIL', NOW);
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        expect(out.matrix[i][j]).toBeGreaterThanOrEqual(-1);
        expect(out.matrix[i][j]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is deterministic per tenant+day', () => {
    const out1 = buildIndicatorCorrelationMatrix('BIL', NOW);
    const out2 = buildIndicatorCorrelationMatrix('BIL', NOW);
    expect(out1.matrix).toEqual(out2.matrix);
  });

  it('differs across tenants', () => {
    const out1 = buildIndicatorCorrelationMatrix('BIL', NOW);
    const out2 = buildIndicatorCorrelationMatrix('BANK_DEMO', NOW);
    // At least one off-diagonal pair should differ
    let differs = false;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        if (i !== j && out1.matrix[i][j] !== out2.matrix[i][j]) differs = true;
      }
    }
    expect(differs).toBe(true);
  });

  it('has most_correlated_pair with max |r|', () => {
    const out = buildIndicatorCorrelationMatrix('BIL', NOW);
    expect(out.most_correlated_pair).not.toBeNull();
    expect(out.most_correlated_pair.r).toBeDefined();
  });

  it('has avg_abs_correlation >= 0', () => {
    const out = buildIndicatorCorrelationMatrix('BIL', NOW);
    expect(out.avg_abs_correlation).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /v1/indicators/correlation-matrix', () => {
  it('returns 200 for risk_analyst', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/indicators/correlation-matrix')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'risk_analyst');
    expect(res.status).toBe(200);
    expect(res.body.body.indicators.length).toBe(6);
  });

  it('returns 403 for unknown role', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/indicators/correlation-matrix')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'unknown_role');
    expect(res.status).toBe(403);
  });
});
