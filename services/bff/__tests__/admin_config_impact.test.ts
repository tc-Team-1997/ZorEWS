// @ts-nocheck
// services/bff/__tests__/admin_config_impact.test.ts
// T6 M13.22 — Config change impact score.

import request from 'supertest';
import { buildConfigImpactScores } from '../src/admin_config_impact';
import { DEFAULTS } from '../src/admin_config';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-11T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function fakeApp(role = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    getRole: () => role,
    now: () => NOW,
  });
  return app;
}

// ─── Pure function tests ────────────────────────────────────────────────

describe('M13.22 — buildConfigImpactScores — shape', () => {
  test('total_keys matches DEFAULTS length', () => {
    const out = buildConfigImpactScores(NOW);
    expect(out.total_keys).toBe(DEFAULTS.length);
    expect(out.keys).toHaveLength(DEFAULTS.length);
  });

  test('sorted by impact_score desc', () => {
    const out = buildConfigImpactScores(NOW);
    for (let i = 0; i < out.keys.length - 1; i++) {
      expect(out.keys[i].impact_score).toBeGreaterThanOrEqual(out.keys[i + 1].impact_score);
    }
  });

  test('features category has highest base score (90)', () => {
    const out = buildConfigImpactScores(NOW);
    const featureKeys = out.keys.filter((k) => k.category === 'features');
    expect(featureKeys.length).toBeGreaterThan(0);
    // Features + boolean = 100
    for (const k of featureKeys) {
      expect(k.impact_score).toBeGreaterThanOrEqual(90);
    }
  });

  test('all scores in [0, 100]', () => {
    const out = buildConfigImpactScores(NOW);
    for (const k of out.keys) {
      expect(k.impact_score).toBeGreaterThanOrEqual(0);
      expect(k.impact_score).toBeLessThanOrEqual(100);
    }
  });

  test('highest_impact_key is the first key', () => {
    const out = buildConfigImpactScores(NOW);
    expect(out.highest_impact_key).toBe(out.keys[0].key);
  });

  test('category_avg_scores has all categories', () => {
    const out = buildConfigImpactScores(NOW);
    expect(out.category_avg_scores).toHaveProperty('alerts');
    expect(out.category_avg_scores).toHaveProperty('features');
    expect(out.category_avg_scores).toHaveProperty('scoring');
    expect(out.category_avg_scores).toHaveProperty('notifications');
    expect(out.category_avg_scores).toHaveProperty('reporting');
  });

  test('features avg > reporting avg', () => {
    const out = buildConfigImpactScores(NOW);
    expect(out.category_avg_scores.features).toBeGreaterThan(out.category_avg_scores.reporting);
  });

  test('generated_at echoes NOW', () => {
    const out = buildConfigImpactScores(NOW);
    expect(out.generated_at).toBe(NOW.toISOString());
  });

  test('platform-static — different date same scores', () => {
    const a = buildConfigImpactScores(NOW);
    const b = buildConfigImpactScores(new Date('2027-01-01T00:00:00.000Z'));
    expect(a.keys.map((k) => k.impact_score)).toEqual(b.keys.map((k) => k.impact_score));
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M13.22 — route GET /v1/admin/config/impact-scores', () => {
  test('admin → 200 with keys array', async () => {
    const app = fakeApp('admin');
    const res = await request(app).get('/v1/admin/config/impact-scores').set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.keys)).toBe(true);
    expect(res.body.body.total_keys).toBe(DEFAULTS.length);
  });

  test('case_owner → 403', async () => {
    const app = fakeApp('case_owner');
    const res = await request(app).get('/v1/admin/config/impact-scores').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant → 400', async () => {
    const app = fakeApp('admin');
    const res = await request(app).get('/v1/admin/config/impact-scores');
    expect(res.status).toBe(400);
  });
});
