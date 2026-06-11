// @ts-nocheck
// services/bff/__tests__/scoring_preset_multiplier_drift.test.ts
// T6 M6.22 — Scoring weight preset multiplier drift from defaults.

import request from 'supertest';
import { buildScoringPresetMultiplierDrift } from '../src/scoring_preset_multiplier_drift';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryCustomWeightPresetStore } from '../src/scoring_presets_custom';
import { defaultAiModelRegistry } from '../src/ai_model_registry';
import { InMemoryModelPerformanceStore } from '../src/model_performance';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeCustomStore() {
  return new InMemoryCustomWeightPresetStore();
}

function fakeApp(role = 'admin', customWeightPresetStore = makeCustomStore()) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    customWeightPresetStore,
    modelPerformanceStore: new InMemoryModelPerformanceStore(defaultAiModelRegistry),
    getRole: () => role,
    now: () => NOW,
  });
}

// ─── Pure function tests ────────────────────────────────────────────────

describe('M6.22 — buildScoringPresetMultiplierDrift — empty', () => {
  test('empty input → zero results', () => {
    const out = buildScoringPresetMultiplierDrift([], NOW);
    expect(out.total_custom_presets).toBe(0);
    expect(out.presets).toHaveLength(0);
    expect(out.most_drifted).toBeNull();
    expect(out.fleet_avg_drift).toBe(0);
  });
});

describe('M6.22 — drift_score computation', () => {
  test('balanced preset (empty multipliers) → drift_score=0', () => {
    const presets = [
      { id: 'p1', name: 'Balanced', mode: 'balanced', vertical: 'banking', weight_multipliers: {} },
    ];
    const out = buildScoringPresetMultiplierDrift(presets, NOW);
    expect(out.presets[0].drift_score).toBe(0);
    expect(out.presets[0].total_multipliers).toBe(0);
  });

  test('single multiplier 1.5 → drift_score=0.5', () => {
    const presets = [
      { id: 'p1', name: 'Test', mode: 'conservative', vertical: 'banking', weight_multipliers: { 'FIN-001': 1.5 } },
    ];
    const out = buildScoringPresetMultiplierDrift(presets, NOW);
    expect(out.presets[0].drift_score).toBe(0.5);
    expect(out.presets[0].max_deviation).toBe(0.5);
  });

  test('two multipliers → mean deviation', () => {
    const presets = [
      { id: 'p1', name: 'Test', mode: 'conservative', vertical: 'banking',
        weight_multipliers: { 'FIN-001': 1.4, 'FIN-002': 0.6 } },
    ];
    const out = buildScoringPresetMultiplierDrift(presets, NOW);
    expect(out.presets[0].drift_score).toBe(0.4);
    expect(out.presets[0].min_multiplier).toBe(0.6);
    expect(out.presets[0].max_multiplier).toBe(1.4);
  });
});

describe('M6.22 — sort and leaderboards', () => {
  test('sorted drift_score desc + preset_id asc tie-break', () => {
    const presets = [
      { id: 'p2', name: 'B', mode: 'balanced', vertical: 'banking', weight_multipliers: { 'FIN-001': 1.1 } },
      { id: 'p1', name: 'A', mode: 'conservative', vertical: 'banking', weight_multipliers: { 'FIN-001': 1.5 } },
    ];
    const out = buildScoringPresetMultiplierDrift(presets, NOW);
    expect(out.presets[0].preset_id).toBe('p1');
    expect(out.presets[1].preset_id).toBe('p2');
    expect(out.most_drifted.preset_id).toBe('p1');
  });
});

describe('M6.22 — fleet_avg_drift', () => {
  test('avg across presets', () => {
    const presets = [
      { id: 'p1', name: 'A', mode: 'conservative', vertical: 'banking', weight_multipliers: { 'F': 1.5 } },
      { id: 'p2', name: 'B', mode: 'conservative', vertical: 'banking', weight_multipliers: { 'F': 1.1 } },
    ];
    const out = buildScoringPresetMultiplierDrift(presets, NOW);
    expect(out.fleet_avg_drift).toBeCloseTo(0.3, 2);
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M6.22 — route', () => {
  test('GET /v1/scoring/presets/custom/multiplier-drift → 200', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/scoring/presets/custom/multiplier-drift')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(typeof res.body.body.total_custom_presets).toBe('number');
    expect(Array.isArray(res.body.body.presets)).toBe(true);
  });

  test('reflects created custom preset', async () => {
    const store = makeCustomStore();
    store.create('BIL', {
      name: 'TestDrift', description: 'desc', vertical: 'banking',
      mode: 'conservative', weight_multipliers: { 'FIN-001': 1.8 },
    }, 'admin', NOW);
    const { app } = fakeApp('admin', store);
    const res = await request(app)
      .get('/v1/scoring/presets/custom/multiplier-drift')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.total_custom_presets).toBe(1);
    expect(res.body.body.presets[0].drift_score).toBeGreaterThan(0);
  });

  test('403 for unknown role', async () => {
    const { app } = fakeApp('viewer');
    const res = await request(app)
      .get('/v1/scoring/presets/custom/multiplier-drift')
      .set(TH_BIL)
      .set('x-apex-role', 'viewer');
    expect(res.status).toBe(403);
  });

  test('400 when no tenant header', async () => {
    const { app } = fakeApp();
    const res = await request(app)
      .get('/v1/scoring/presets/custom/multiplier-drift')
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });

  test('cross-tenant invisibility', async () => {
    const store = makeCustomStore();
    store.create('BANK_DEMO', {
      name: 'BankPreset', description: 'desc', vertical: 'banking',
      mode: 'balanced', weight_multipliers: { 'FIN-001': 1.5 },
    }, 'admin', NOW);
    const { app } = fakeApp('admin', store);
    const res = await request(app)
      .get('/v1/scoring/presets/custom/multiplier-drift')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.body.body.total_custom_presets).toBe(0);
  });
});
