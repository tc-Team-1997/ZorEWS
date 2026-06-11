// @ts-nocheck
// T6 M14.37 — Adapter dependency graph tests.

import request from 'supertest';
import { buildAdapterDependencyGraph } from '../src/adapter_dependency_graph';
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
  return app;
}

describe('M14.37 — buildAdapterDependencyGraph pure', () => {
  test('returns all fleet adapters', () => {
    const result = buildAdapterDependencyGraph(NOW);
    expect(result.total_adapters).toBe(listFleetAdapters().length);
  });

  test('edges have valid from and to adapter_ids', () => {
    const result = buildAdapterDependencyGraph(NOW);
    const validIds = new Set(result.adapters.map((a) => a.adapter_id));
    for (const edge of result.edges) {
      expect(validIds.has(edge.from)).toBe(true);
      expect(validIds.has(edge.to)).toBe(true);
      expect(typeof edge.relationship).toBe('string');
    }
  });

  test('depends_on and depended_by are consistent with edges', () => {
    const result = buildAdapterDependencyGraph(NOW);
    for (const edge of result.edges) {
      const fromAdapter = result.adapters.find((a) => a.adapter_id === edge.from);
      const toAdapter = result.adapters.find((a) => a.adapter_id === edge.to);
      expect(fromAdapter.depends_on).toContain(edge.to);
      expect(toAdapter.depended_by).toContain(edge.from);
    }
  });

  test('centrality_score = depends_on + depended_by', () => {
    const result = buildAdapterDependencyGraph(NOW);
    for (const adapter of result.adapters) {
      expect(adapter.centrality_score).toBe(adapter.depends_on.length + adapter.depended_by.length);
    }
  });

  test('most_central_adapter has highest centrality', () => {
    const result = buildAdapterDependencyGraph(NOW);
    if (result.most_central_adapter) {
      const maxCentrality = Math.max(...result.adapters.map((a) => a.centrality_score));
      const centralAdapter = result.adapters.find((a) => a.adapter_id === result.most_central_adapter);
      expect(centralAdapter.centrality_score).toBe(maxCentrality);
    }
  });

  test('isolated adapters have centrality_score 0', () => {
    const result = buildAdapterDependencyGraph(NOW);
    for (const id of result.isolated_adapters) {
      const adapter = result.adapters.find((a) => a.adapter_id === id);
      expect(adapter.centrality_score).toBe(0);
    }
  });

  test('generated_at echoes now', () => {
    const result = buildAdapterDependencyGraph(NOW);
    expect(result.generated_at).toBe(NOW.toISOString());
  });

  test('sorted by centrality desc', () => {
    const result = buildAdapterDependencyGraph(NOW);
    for (let i = 1; i < result.adapters.length; i++) {
      expect(result.adapters[i-1].centrality_score).toBeGreaterThanOrEqual(result.adapters[i].centrality_score);
    }
  });
});

describe('M14.37 — GET /v1/integrations/adapters/dependency-graph route', () => {
  test('admin 200 with envelope', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/integrations/adapters/dependency-graph').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body.adapters).toBeInstanceOf(Array);
    expect(res.body.body.edges).toBeInstanceOf(Array);
  });

  test('field_officer 403', async () => {
    const app = makeTestApp('field_officer');
    const res = await request(app).get('/v1/integrations/adapters/dependency-graph').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant header → 400', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/v1/integrations/adapters/dependency-graph');
    expect(res.status).toBe(400);
  });
});
