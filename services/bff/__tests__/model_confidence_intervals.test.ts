// @ts-nocheck
// services/bff/__tests__/model_confidence_intervals.test.ts
// T6 M7.26 — Model confidence interval analysis tests

import { buildModelConfidenceIntervals } from '../src/model_confidence_intervals';
import { defaultAiModelRegistry } from '../src/ai_model_registry';

const NOW = new Date('2026-05-22T12:00:00.000Z');

describe('buildModelConfidenceIntervals — pure resolver', () => {
  test('returns envelope shape', () => {
    const r = buildModelConfidenceIntervals(defaultAiModelRegistry, 'BANK_DEMO', NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(Array.isArray(r.models)).toBe(true);
    expect(typeof r.reliable_model_count).toBe('number');
  });

  test('only production models included', () => {
    const r = buildModelConfidenceIntervals(defaultAiModelRegistry, 'BANK_DEMO', NOW);
    // All models in result should be production
    const production = defaultAiModelRegistry.list({ status: 'production' });
    // Should have at most production.length rows (some may be skipped if no metric)
    expect(r.models.length).toBeLessThanOrEqual(production.length);
  });

  test('each model has CI fields', () => {
    const r = buildModelConfidenceIntervals(defaultAiModelRegistry, 'BANK_DEMO', NOW);
    for (const m of r.models) {
      expect(typeof m.model_id).toBe('string');
      expect(typeof m.point_estimate).toBe('number');
      expect(typeof m.lower_ci).toBe('number');
      expect(typeof m.upper_ci).toBe('number');
      expect(typeof m.ci_width).toBe('number');
      expect(typeof m.is_reliable).toBe('boolean');
    }
  });

  test('lower_ci <= point_estimate <= upper_ci', () => {
    const r = buildModelConfidenceIntervals(defaultAiModelRegistry, 'BANK_DEMO', NOW);
    for (const m of r.models) {
      expect(m.lower_ci).toBeLessThanOrEqual(m.point_estimate);
      expect(m.upper_ci).toBeGreaterThanOrEqual(m.point_estimate);
    }
  });

  test('AUC CIs clamped to [0, 1]', () => {
    const r = buildModelConfidenceIntervals(defaultAiModelRegistry, 'BANK_DEMO', NOW);
    for (const m of r.models) {
      if (m.metric_name === 'AUC') {
        expect(m.lower_ci).toBeGreaterThanOrEqual(0);
        expect(m.upper_ci).toBeLessThanOrEqual(1);
      }
    }
  });

  test('is_reliable = ci_width < 0.05', () => {
    const r = buildModelConfidenceIntervals(defaultAiModelRegistry, 'BANK_DEMO', NOW);
    for (const m of r.models) {
      expect(m.is_reliable).toBe(m.ci_width < 0.05);
    }
  });

  test('reliable_model_count matches is_reliable count', () => {
    const r = buildModelConfidenceIntervals(defaultAiModelRegistry, 'BANK_DEMO', NOW);
    const actual = r.models.filter((m) => m.is_reliable).length;
    expect(r.reliable_model_count).toBe(actual);
  });

  test('deterministic: same result on repeated calls', () => {
    const r1 = buildModelConfidenceIntervals(defaultAiModelRegistry, 'BANK_DEMO', NOW);
    const r2 = buildModelConfidenceIntervals(defaultAiModelRegistry, 'BANK_DEMO', NOW);
    expect(r1.models.length).toBe(r2.models.length);
    if (r1.models.length > 0) {
      expect(r1.models[0].ci_width).toBe(r2.models[0].ci_width);
    }
  });

  test('throws on empty tenant_id', () => {
    expect(() => buildModelConfidenceIntervals(defaultAiModelRegistry, '', NOW)).toThrow();
  });
});

// ─── Route tests ──────────────────────────────────────────────────────

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ANALYST = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'risk_analyst',
};

describe('GET /v1/ai/models/confidence-intervals', () => {
  test('analyst+ 200 with envelope', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/ai/models/confidence-intervals')
      .set(HEADERS_ANALYST);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(Array.isArray(r.body.body.models)).toBe(true);
  });

  test('admin 200', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/ai/models/confidence-intervals')
      .set({ ...HEADERS_ANALYST, 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(200);
  });

  test('403 for case_owner', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/ai/models/confidence-intervals')
      .set({ ...HEADERS_ANALYST, 'X-Apex-Role': 'case_owner' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/ai/models/confidence-intervals')
      .set({ 'X-Apex-Role': 'risk_analyst' });
    expect(r.status).toBe(400);
  });
});
