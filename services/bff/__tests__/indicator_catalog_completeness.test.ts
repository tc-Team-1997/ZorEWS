// @ts-nocheck
// services/bff/__tests__/indicator_catalog_completeness.test.ts
// T6 M4.27 — Indicator catalog completeness check tests

import { checkIndicatorCatalogCompleteness } from '../src/indicator_catalog_completeness';
import { STUB_CATALOG } from '../src/bil_scoring_v2';

const NOW = new Date('2026-05-22T12:00:00.000Z');

describe('checkIndicatorCatalogCompleteness — pure resolver', () => {
  test('returns envelope shape with all required fields', () => {
    const r = checkIndicatorCatalogCompleteness(NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(typeof r.total_indicators).toBe('number');
    expect(typeof r.avg_completeness_score).toBe('number');
    expect(typeof r.fully_complete_count).toBe('number');
    expect(Array.isArray(r.incomplete_indicators)).toBe(true);
  });

  test('total_indicators matches STUB_CATALOG size', () => {
    const r = checkIndicatorCatalogCompleteness(NOW);
    expect(r.total_indicators).toBe(Object.keys(STUB_CATALOG).length);
  });

  test('avg_completeness_score in [0, 100]', () => {
    const r = checkIndicatorCatalogCompleteness(NOW);
    expect(r.avg_completeness_score).toBeGreaterThanOrEqual(0);
    expect(r.avg_completeness_score).toBeLessThanOrEqual(100);
  });

  test('fully_complete_count + incomplete_count = total_indicators (partition)', () => {
    const r = checkIndicatorCatalogCompleteness(NOW);
    expect(r.fully_complete_count + r.incomplete_indicators.length).toBe(r.total_indicators);
  });

  test('fully_complete_count >= 0 and <= total_indicators', () => {
    const r = checkIndicatorCatalogCompleteness(NOW);
    expect(r.fully_complete_count).toBeGreaterThanOrEqual(0);
    expect(r.fully_complete_count).toBeLessThanOrEqual(r.total_indicators);
  });

  test('all rows have completeness_score in [0, 100]', () => {
    const r = checkIndicatorCatalogCompleteness(NOW);
    for (const row of r.incomplete_indicators) {
      expect(row.completeness_score).toBeGreaterThanOrEqual(0);
      expect(row.completeness_score).toBeLessThanOrEqual(100);
      expect(row.completeness_score).toBeLessThan(100); // only incomplete here
    }
  });

  test('each row has required fields', () => {
    const r = checkIndicatorCatalogCompleteness(NOW);
    const all = [...r.incomplete_indicators];
    for (const row of all) {
      expect(typeof row.indicator_id).toBe('string');
      expect(typeof row.has_weight).toBe('boolean');
      expect(typeof row.has_name).toBe('boolean');
      expect(typeof row.has_vertical).toBe('boolean');
      expect(typeof row.has_family).toBe('boolean');
    }
  });

  test('deterministic: same result on repeated calls', () => {
    const r1 = checkIndicatorCatalogCompleteness(NOW);
    const r2 = checkIndicatorCatalogCompleteness(NOW);
    expect(r1.total_indicators).toBe(r2.total_indicators);
    expect(r1.fully_complete_count).toBe(r2.fully_complete_count);
  });

  test('platform-static: same result for different timestamps', () => {
    const r1 = checkIndicatorCatalogCompleteness(NOW);
    const r2 = checkIndicatorCatalogCompleteness(new Date('2026-06-01T00:00:00.000Z'));
    expect(r1.total_indicators).toBe(r2.total_indicators);
    expect(r1.fully_complete_count).toBe(r2.fully_complete_count);
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

describe('GET /v1/indicators/catalog-completeness', () => {
  test('analyst+ 200 with envelope', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/indicators/catalog-completeness')
      .set(HEADERS_ANALYST);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(typeof r.body.body.total_indicators).toBe('number');
  });

  test('admin also 200', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/indicators/catalog-completeness')
      .set({ ...HEADERS_ANALYST, 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(200);
  });

  test('403 for unknown role', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/indicators/catalog-completeness')
      .set({ ...HEADERS_ANALYST, 'X-Apex-Role': 'unknown_role' });
    expect(r.status).toBe(403);
  });

  test('platform-static across tenants', async () => {
    const { app } = makeApp({});
    const r1 = await request(app)
      .get('/v1/indicators/catalog-completeness')
      .set({ ...HEADERS_ANALYST, 'X-Tenant-ID': 'BANK_DEMO' });
    const r2 = await request(app)
      .get('/v1/indicators/catalog-completeness')
      .set({ ...HEADERS_ANALYST, 'X-Tenant-ID': 'BIL' });
    expect(r1.body.body.total_indicators).toBe(r2.body.body.total_indicators);
  });
});
