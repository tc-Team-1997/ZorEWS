// @ts-nocheck
// services/bff/__tests__/scoring_preset_coverage.test.ts
// T6 M6.26 — Scoring preset coverage ratio tests

import { buildPresetCoverageRatio } from '../src/scoring_preset_coverage';
import { WEIGHT_PRESETS } from '../src/scoring_presets';
import { InMemoryCustomWeightPresetStore } from '../src/scoring_presets_custom';

const NOW = new Date('2026-05-22T12:00:00.000Z');

describe('buildPresetCoverageRatio — pure resolver', () => {
  test('empty custom store → coverage_ratio=0, all uncovered', () => {
    const store = new InMemoryCustomWeightPresetStore();
    const r = buildPresetCoverageRatio('BANK_DEMO', store, NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.coverage_ratio).toBe(0);
    expect(r.covered_count).toBe(0);
    expect(r.uncovered_cells.length).toBe(WEIGHT_PRESETS.length);
    expect(r.covered_cells.length).toBe(0);
    expect(r.most_common_custom_mode).toBeNull();
  });

  test('total_library = WEIGHT_PRESETS.length', () => {
    const store = new InMemoryCustomWeightPresetStore();
    const r = buildPresetCoverageRatio('BANK_DEMO', store, NOW);
    expect(r.total_library).toBe(WEIGHT_PRESETS.length);
  });

  test('adding custom preset for one (mode, vertical) increases covered_count', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create(
      'BANK_DEMO',
      { name: 'My Custom', description: 'test', vertical: 'banking', mode: 'conservative', weight_multipliers: {} },
      'alice',
      NOW,
    );
    const r = buildPresetCoverageRatio('BANK_DEMO', store, NOW);
    expect(r.covered_count).toBe(1);
    expect(r.covered_cells.length).toBe(1);
    expect(r.covered_cells[0].has_custom).toBe(true);
  });

  test('coverage_ratio = covered / total in [0, 1]', () => {
    const store = new InMemoryCustomWeightPresetStore();
    const r = buildPresetCoverageRatio('BANK_DEMO', store, NOW);
    expect(r.coverage_ratio).toBeGreaterThanOrEqual(0);
    expect(r.coverage_ratio).toBeLessThanOrEqual(1);
  });

  test('covered + uncovered = total_library', () => {
    const store = new InMemoryCustomWeightPresetStore();
    const r = buildPresetCoverageRatio('BANK_DEMO', store, NOW);
    expect(r.covered_cells.length + r.uncovered_cells.length).toBe(r.total_library);
  });

  test('most_common_custom_mode reflects most common mode among customs', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create('BANK_DEMO', { name: 'A', description: 'x', vertical: 'banking', mode: 'conservative', weight_multipliers: {} }, 'a', NOW);
    store.create('BANK_DEMO', { name: 'B', description: 'x', vertical: 'insurance', mode: 'conservative', weight_multipliers: {} }, 'a', NOW);
    store.create('BANK_DEMO', { name: 'C', description: 'x', vertical: 'banking', mode: 'aggressive', weight_multipliers: {} }, 'a', NOW);
    const r = buildPresetCoverageRatio('BANK_DEMO', store, NOW);
    expect(r.most_common_custom_mode).toBe('conservative');
  });

  test('tenant scoping: BIL customs invisible to BANK_DEMO', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create('BIL', { name: 'BIL Custom', description: 'x', vertical: 'banking', mode: 'conservative', weight_multipliers: {} }, 'a', NOW);
    const r = buildPresetCoverageRatio('BANK_DEMO', store, NOW);
    expect(r.covered_count).toBe(0);
  });

  test('throws on empty tenant_id', () => {
    const store = new InMemoryCustomWeightPresetStore();
    expect(() => buildPresetCoverageRatio('', store, NOW)).toThrow();
  });
});

// ─── Route tests ──────────────────────────────────────────────────────

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ANALYST = {
  'X-Tenant-ID': 'BIL',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'risk_analyst',
};

describe('GET /v1/scoring/presets/coverage-ratio', () => {
  test('analyst+ 200 with envelope', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/scoring/presets/coverage-ratio')
      .set(HEADERS_ANALYST);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(typeof r.body.body.coverage_ratio).toBe('number');
  });

  test('403 for unknown role', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/scoring/presets/coverage-ratio')
      .set({ ...HEADERS_ANALYST, 'X-Apex-Role': 'unknown_role' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/scoring/presets/coverage-ratio')
      .set({ 'X-Apex-Role': 'risk_analyst' });
    expect(r.status).toBe(400);
  });

  test('cross-tenant isolation', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/scoring/presets/coverage-ratio')
      .set(HEADERS_ANALYST);
    expect(r.body.body.tenant_id).toBe('BIL');
  });
});
