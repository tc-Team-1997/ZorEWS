// @ts-nocheck
// T6 M6.29 — Scoring preset drift velocity tests.

import request from 'supertest';
import { buildScoringPresetDriftVelocity } from '../src/scoring_preset_drift_velocity';
import { InMemoryCustomWeightPresetStore } from '../src/scoring_presets_custom';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'risk_analyst', customWeightPresetStore?) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    customWeightPresetStore,
  });
  return { app };
}

describe('M6.29 — buildScoringPresetDriftVelocity pure', () => {
  test('empty store returns zero presets', () => {
    const store = new InMemoryCustomWeightPresetStore();
    const result = buildScoringPresetDriftVelocity('BIL', NOW, store);
    expect(result.tenant_id).toBe('BIL');
    expect(result.total_custom_presets).toBe(0);
    expect(result.presets).toHaveLength(0);
    expect(result.fastest_drifting_preset).toBeNull();
    expect(result.most_stable_preset).toBeNull();
  });

  test('presets have valid velocity class', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create('BIL', {
      name: 'Custom 1',
      description: 'desc',
      vertical: 'banking',
      mode: 'conservative',
      weight_multipliers: { 'FIN-001': 1.5, 'BEH-001': 0.8 },
    }, 'admin', NOW);
    const result = buildScoringPresetDriftVelocity('BIL', NOW, store);
    expect(result.presets).toHaveLength(1);
    expect(['fast_drift', 'slow_drift', 'stable']).toContain(result.presets[0].velocity_class);
    expect(result.fastest_drifting_preset).toBe(result.presets[0].preset_id);
  });

  test('throws on empty tenant_id', () => {
    const store = new InMemoryCustomWeightPresetStore();
    expect(() => buildScoringPresetDriftVelocity('', NOW, store)).toThrow();
  });
});

describe('M6.29 — GET /v1/scoring/presets/drift-velocity route', () => {
  test('risk_analyst returns 200', async () => {
    const { app } = makeTestApp('risk_analyst');
    const res = await request(app)
      .get('/v1/scoring/presets/drift-velocity')
      .set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.presets)).toBe(true);
    expect(typeof res.body.body.total_custom_presets).toBe('number');
  });

  test('unknown role returns 403', async () => {
    const { app } = makeTestApp('viewer');
    const res = await request(app)
      .get('/v1/scoring/presets/drift-velocity')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('cross-tenant isolation', async () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create('BIL', {
      name: 'BIL Custom',
      description: 'test',
      vertical: 'banking',
      mode: 'conservative',
      weight_multipliers: { 'FIN-001': 1.3 },
    }, 'admin', NOW);
    const { app } = makeTestApp('risk_analyst', store);
    const res = await request(app)
      .get('/v1/scoring/presets/drift-velocity')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(res.status).toBe(200);
    expect(res.body.body.total_custom_presets).toBe(0);
  });
});
