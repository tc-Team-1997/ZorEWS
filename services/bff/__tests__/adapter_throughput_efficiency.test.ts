// @ts-nocheck
import request from 'supertest';
import { buildAdapterThroughputEfficiency } from '../src/adapter_throughput_efficiency';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-11T12:00:00Z');
const H = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function fakeApp(role = 'admin') {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), getRole: () => role, now: () => NOW });
  return app;
}

describe('buildAdapterThroughputEfficiency', () => {
  test('returns 8 adapters', () => {
    const r = buildAdapterThroughputEfficiency('BIL', NOW);
    expect(r.adapters).toHaveLength(8);
  });
  test('each adapter has efficiency_score 0-100', () => {
    const r = buildAdapterThroughputEfficiency('BIL', NOW);
    for (const a of r.adapters) {
      expect(a.throughput_efficiency_score).toBeGreaterThanOrEqual(0);
      expect(a.throughput_efficiency_score).toBeLessThanOrEqual(100);
    }
  });
  test('each adapter has efficiency_grade A-D', () => {
    const r = buildAdapterThroughputEfficiency('BIL', NOW);
    for (const a of r.adapters) {
      expect(['A','B','C','D']).toContain(a.efficiency_grade);
    }
  });
  test('most_efficient_adapter is set', () => {
    const r = buildAdapterThroughputEfficiency('BIL', NOW);
    expect(r.most_efficient_adapter).toBeTruthy();
  });
  test('avg_efficiency is between 0 and 100', () => {
    const r = buildAdapterThroughputEfficiency('BIL', NOW);
    expect(r.avg_efficiency).toBeGreaterThanOrEqual(0);
    expect(r.avg_efficiency).toBeLessThanOrEqual(100);
  });
  test('deterministic', () => {
    const a = buildAdapterThroughputEfficiency('BIL', NOW);
    const b = buildAdapterThroughputEfficiency('BIL', NOW);
    expect(a.adapters[0].throughput_efficiency_score).toBe(b.adapters[0].throughput_efficiency_score);
  });
  test('tenant_id echoed', () => {
    const r = buildAdapterThroughputEfficiency('BIL', NOW);
    expect(r.tenant_id).toBe('BIL');
  });
});

describe('GET /v1/integrations/adapters/throughput-efficiency', () => {
  test('admin → 200', async () => {
    const res = await request(fakeApp()).get('/v1/integrations/adapters/throughput-efficiency').set(H);
    expect(res.status).toBe(200);
    expect(res.body.body.adapters).toHaveLength(8);
  });
  test('field_officer → 403', async () => {
    const res = await request(fakeApp('field_officer')).get('/v1/integrations/adapters/throughput-efficiency').set(H);
    expect(res.status).toBe(403);
  });
  test('no tenant → 400', async () => {
    const res = await request(fakeApp()).get('/v1/integrations/adapters/throughput-efficiency').set('X-Channel','API');
    expect(res.status).toBe(400);
  });
});
