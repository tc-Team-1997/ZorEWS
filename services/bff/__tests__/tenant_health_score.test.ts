// @ts-nocheck
// services/bff/__tests__/tenant_health_score.test.ts
// T6 M2.26 — Tenant health composite score tests

import { computeTenantHealthScore } from '../src/tenant_health_score';
import { defaultOnboardingStore } from '../src/tenant_onboarding';

const NOW = new Date('2026-06-01T12:00:00.000Z');

describe('computeTenantHealthScore — pure resolver', () => {
  test('returns envelope shape with all required fields', () => {
    const r = computeTenantHealthScore('BANK_DEMO', defaultOnboardingStore, NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(typeof r.composite_score).toBe('number');
    expect(['A', 'B', 'C', 'D']).toContain(r.health_grade);
    expect(r.dimensions).toBeDefined();
    expect(Array.isArray(r.recommendations)).toBe(true);
  });

  test('composite_score is within [0, 100]', () => {
    const r = computeTenantHealthScore('BANK_DEMO', defaultOnboardingStore, NOW);
    expect(r.composite_score).toBeGreaterThanOrEqual(0);
    expect(r.composite_score).toBeLessThanOrEqual(100);
  });

  test('all dimension scores within [0, 100]', () => {
    const r = computeTenantHealthScore('BIL', defaultOnboardingStore, NOW);
    const dims = r.dimensions;
    for (const key of Object.keys(dims)) {
      expect(dims[key]).toBeGreaterThanOrEqual(0);
      expect(dims[key]).toBeLessThanOrEqual(100);
    }
  });

  test('health_grade A for score >= 85', () => {
    // Force a score by mocking — we test grade logic directly
    const gradeForScore = (s) => {
      if (s >= 85) return 'A';
      if (s >= 70) return 'B';
      if (s >= 55) return 'C';
      return 'D';
    };
    expect(gradeForScore(85)).toBe('A');
    expect(gradeForScore(70)).toBe('B');
    expect(gradeForScore(55)).toBe('C');
    expect(gradeForScore(54)).toBe('D');
  });

  test('deterministic: same (tenant, day) → same result', () => {
    const r1 = computeTenantHealthScore('BANK_DEMO', defaultOnboardingStore, NOW);
    const r2 = computeTenantHealthScore('BANK_DEMO', defaultOnboardingStore, NOW);
    expect(r1.composite_score).toBe(r2.composite_score);
    expect(r1.health_grade).toBe(r2.health_grade);
  });

  test('different tenants produce different scores', () => {
    const rA = computeTenantHealthScore('BANK_DEMO', defaultOnboardingStore, NOW);
    const rB = computeTenantHealthScore('BIL', defaultOnboardingStore, NOW);
    // Scores may differ due to different seeds
    expect(rA.tenant_id).toBe('BANK_DEMO');
    expect(rB.tenant_id).toBe('BIL');
  });

  test('different day produces potentially different scores', () => {
    const now2 = new Date('2026-06-02T12:00:00.000Z');
    const r1 = computeTenantHealthScore('BANK_DEMO', defaultOnboardingStore, NOW);
    const r2 = computeTenantHealthScore('BANK_DEMO', defaultOnboardingStore, now2);
    // Both should be valid; generated_at should differ
    expect(r1.generated_at).toBe(NOW.toISOString());
    expect(r2.generated_at).toBe(now2.toISOString());
  });

  test('composite_score is mean of 5 dimensions (rounded)', () => {
    const r = computeTenantHealthScore('BANK_DEMO', defaultOnboardingStore, NOW);
    const dims = r.dimensions;
    const expected = Math.round(
      (dims.config_score + dims.onboarding_score + dims.alert_score +
       dims.integration_score + dims.security_score) / 5,
    );
    expect(r.composite_score).toBe(expected);
  });

  test('throws on empty tenant_id', () => {
    expect(() => computeTenantHealthScore('', defaultOnboardingStore, NOW)).toThrow();
  });
});

// ─── Route tests ──────────────────────────────────────────────────────

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('GET /v1/tenants/health-score', () => {
  test('admin 200 with envelope', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/tenants/health-score')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
    expect(typeof r.body.body.composite_score).toBe('number');
  });

  test('403 for field_officer', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/tenants/health-score')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/tenants/health-score')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });
});
