// @ts-nocheck
// T6 M6.28 — Scoring weight sensitivity heatmap.

import request from 'supertest';
import { buildScoringWeightSensitivityHeatmap } from '../src/scoring_weight_sensitivity_heatmap';
import { STUB_CATALOG } from '../src/bil_scoring_v2';
import { listWeightPresets } from '../src/scoring_presets';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeHeatmapApp(role = 'admin') {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => role });
  return app;
}

describe('M6.28 — sensitivity heatmap', () => {
  test('returns all indicators', () => {
    const out = buildScoringWeightSensitivityHeatmap('BIL', NOW);
    expect(out.indicators.length).toBe(Object.keys(STUB_CATALOG).length);
  });

  test('returns all presets', () => {
    const out = buildScoringWeightSensitivityHeatmap('BIL', NOW);
    expect(out.presets.length).toBe(listWeightPresets().length);
  });

  test('indicators sorted by avg_sensitivity desc', () => {
    const out = buildScoringWeightSensitivityHeatmap('BIL', NOW);
    for (let i = 0; i < out.indicators.length - 1; i++) {
      expect(out.indicators[i].avg_sensitivity).toBeGreaterThanOrEqual(out.indicators[i + 1].avg_sensitivity);
    }
  });

  test('most_sensitive_indicator is first', () => {
    const out = buildScoringWeightSensitivityHeatmap('BIL', NOW);
    expect(out.most_sensitive_indicator).toBe(out.indicators[0].indicator_id);
  });

  test('most_sensitive_preset is first', () => {
    const out = buildScoringWeightSensitivityHeatmap('BIL', NOW);
    expect(out.most_sensitive_preset).toBe(out.presets[0].preset_id);
  });

  test('avg_sensitivity values are non-negative', () => {
    const out = buildScoringWeightSensitivityHeatmap('BIL', NOW);
    for (const ind of out.indicators) expect(ind.avg_sensitivity).toBeGreaterThanOrEqual(0);
    for (const p of out.presets) expect(p.avg_sensitivity).toBeGreaterThanOrEqual(0);
  });
});

describe('M6.28 — route', () => {
  test('risk_analyst GET /v1/scoring/presets/sensitivity-heatmap returns 200', async () => {
    const app = makeHeatmapApp('risk_analyst');
    const res = await request(app).get('/v1/scoring/presets/sensitivity-heatmap').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('indicators');
    expect(res.body.body).toHaveProperty('presets');
  });

  test('non-allowed role gets 403', async () => {
    const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => 'unknown_role' });
    const res = await request(app).get('/v1/scoring/presets/sensitivity-heatmap').set(TH);
    expect(res.status).toBe(403);
  });
});
