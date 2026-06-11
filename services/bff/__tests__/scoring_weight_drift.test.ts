// @ts-nocheck
// services/bff/__tests__/scoring_weight_drift.test.ts
// T6 M6.24 — Scoring weight drift from baseline

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  InMemoryCustomWeightPresetStore,
  defaultCustomWeightPresetStore,
} from '../src/scoring_presets_custom';
import { computeScoringWeightDrift } from '../src/scoring_weight_drift';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('computeScoringWeightDrift()', () => {
  test('empty store returns empty presets array', () => {
    const store = new InMemoryCustomWeightPresetStore();
    const result = computeScoringWeightDrift('BIL', store, NOW);
    expect(result.presets).toHaveLength(0);
    expect(result.most_drifted_preset).toBeNull();
    expect(result.avg_drift_across_presets).toBe(0);
  });

  test('balanced preset (empty multipliers) has zero drift', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create("BIL", {
      name: 'My Balanced',
      description: 'Balanced preset',
      vertical: 'banking',
      mode: 'balanced',
      weight_multipliers: {},
    }, 'admin', NOW);
    const result = computeScoringWeightDrift('BIL', store, NOW);
    expect(result.presets[0].avg_drift).toBe(0);
    expect(result.presets[0].total_indicators_modified).toBe(0);
    expect(result.presets[0].drift_direction).toBe('none');
  });

  test('preset with boosted multipliers has tighten direction', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create("BIL", {
      name: 'Conservative',
      description: 'Conservative',
      vertical: 'banking',
      mode: 'conservative',
      weight_multipliers: { 'FIN-001': 1.5, 'BEH-001': 1.3 },
    }, 'admin', NOW);
    const result = computeScoringWeightDrift('BIL', store, NOW);
    expect(result.presets[0].drift_direction).toBe('tighten');
    expect(result.presets[0].avg_drift).toBeGreaterThan(0);
  });

  test('preset with dampened multipliers has loosen direction', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create("BIL", {
      name: 'Aggressive',
      description: 'Aggressive',
      vertical: 'banking',
      mode: 'aggressive',
      weight_multipliers: { 'FIN-001': 0.5, 'BEH-001': 0.7 },
    }, 'admin', NOW);
    const result = computeScoringWeightDrift('BIL', store, NOW);
    expect(result.presets[0].drift_direction).toBe('loosen');
  });

  test('most_drifted_preset is the one with highest avg_drift', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create("BIL", {
      name: 'P1',
      description: 'P1',
      vertical: 'banking',
      mode: 'conservative',
      weight_multipliers: { 'FIN-001': 2.0 },
    }, 'admin', NOW);
    store.create("BIL", {
      name: 'P2',
      description: 'P2',
      vertical: 'banking',
      mode: 'balanced',
      weight_multipliers: { 'FIN-001': 1.1 },
    }, 'admin', NOW);
    const result = computeScoringWeightDrift('BIL', store, NOW);
    expect(result.most_drifted_preset.name).toBe('P1');
  });

  test('tenant isolation', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create('BANK_DEMO', {
      name: 'Other',
      description: 'Other',
      vertical: 'banking',
      mode: 'balanced',
      weight_multipliers: {},
    }, 'admin', NOW);
    const result = computeScoringWeightDrift('BIL', store, NOW);
    expect(result.presets).toHaveLength(0);
  });

  test('generated_at echoed', () => {
    const store = new InMemoryCustomWeightPresetStore();
    const result = computeScoringWeightDrift('BIL', store, NOW);
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

describe('GET /v1/scoring/presets/weight-drift', () => {
  test('admin returns 200', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/scoring/presets/weight-drift')
      .set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('presets');
    expect(res.body.body).toHaveProperty('avg_drift_across_presets');
  });

  test('risk_analyst accepted', async () => {
    const { app } = makeTestApp('risk_analyst');
    const res = await request(app)
      .get('/v1/scoring/presets/weight-drift')
      .set(TH);
    expect(res.status).toBe(200);
  });

  test('unknown role returns 403', async () => {
    const { app } = makeTestApp('unknown_role_xyz');
    const res = await request(app)
      .get('/v1/scoring/presets/weight-drift')
      .set(TH);
    expect(res.status).toBe(403);
  });
});
