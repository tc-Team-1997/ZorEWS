// @ts-nocheck
// T6 M14.39 — Adapter SLA trend tests.

import request from 'supertest';
import { buildAdapterSlaTrend } from '../src/adapter_sla_trend';
import { listFleetAdapters } from '../src/adapter_health';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
  return { app };
}

describe('M14.39 — buildAdapterSlaTrend pure', () => {
  test('returns all fleet adapters', () => {
    const fleet = listFleetAdapters();
    const result = buildAdapterSlaTrend('BIL', NOW);
    expect(result.adapters).toHaveLength(fleet.length);
    expect(result.tenant_id).toBe('BIL');
  });

  test('every adapter has 5 weekly SLA pcts', () => {
    const result = buildAdapterSlaTrend('BIL', NOW);
    for (const a of result.adapters) {
      expect(a.weekly_sla_pcts).toHaveLength(5);
      for (const pct of a.weekly_sla_pcts) {
        expect(pct).toBeGreaterThanOrEqual(60);
        expect(pct).toBeLessThanOrEqual(100);
      }
    }
  });

  test('trend is valid', () => {
    const result = buildAdapterSlaTrend('BIL', NOW);
    for (const a of result.adapters) {
      expect(['improving', 'degrading', 'stable']).toContain(a.trend);
    }
  });

  test('sorted by current_sla_pct ascending (worst first)', () => {
    const result = buildAdapterSlaTrend('BIL', NOW);
    for (let i = 1; i < result.adapters.length; i++) {
      expect(result.adapters[i - 1].current_sla_pct).toBeLessThanOrEqual(
        result.adapters[i].current_sla_pct,
      );
    }
  });

  test('counts sum to total adapters', () => {
    const result = buildAdapterSlaTrend('BIL', NOW);
    expect(result.improving_count + result.degrading_count + result.stable_count).toBe(result.adapters.length);
  });

  test('throws on empty tenant_id', () => {
    expect(() => buildAdapterSlaTrend('', NOW)).toThrow();
  });
});

describe('M14.39 — GET /v1/integrations/adapters/sla-trend route', () => {
  test('admin returns 200', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/integrations/adapters/sla-trend')
      .set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.adapters)).toBe(true);
    expect(res.body.body.adapters.length).toBeGreaterThan(0);
    expect(typeof res.body.body.fleet_avg_current_sla_pct).toBe('number');
  });

  test('field_officer returns 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/integrations/adapters/sla-trend')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('deterministic: same day same result', async () => {
    const { app } = makeTestApp('admin');
    const r1 = await request(app).get('/v1/integrations/adapters/sla-trend').set(TH);
    const r2 = await request(app).get('/v1/integrations/adapters/sla-trend').set(TH);
    expect(r1.body.body.fleet_avg_current_sla_pct).toBe(r2.body.body.fleet_avg_current_sla_pct);
  });
});
