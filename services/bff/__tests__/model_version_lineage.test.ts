// @ts-nocheck
// T6 M7.28 — Model version lineage tracker.

import request from 'supertest';
import { buildModelVersionLineage } from '../src/model_version_lineage';
import { InMemoryAiModelRegistry } from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeLineageApp(role = 'admin') {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => role });
  return app;
}

describe('M7.28 — model lineage', () => {
  test('returns all 6 model types', () => {
    const registry = new InMemoryAiModelRegistry();
    const out = buildModelVersionLineage(registry, 'BIL', NOW);
    expect(out.by_type.length).toBe(6);
  });

  test('by_type contains valid type names', () => {
    const registry = new InMemoryAiModelRegistry();
    const out = buildModelVersionLineage(registry, 'BIL', NOW);
    const types = out.by_type.map((r) => r.type);
    expect(types).toContain('pd');
    expect(types).toContain('fraud');
  });

  test('version_count is non-negative for all types', () => {
    const registry = new InMemoryAiModelRegistry();
    const out = buildModelVersionLineage(registry, 'BIL', NOW);
    for (const row of out.by_type) {
      expect(row.version_count).toBeGreaterThanOrEqual(0);
    }
  });

  test('most_iterated_type has highest version_count', () => {
    const registry = new InMemoryAiModelRegistry();
    const out = buildModelVersionLineage(registry, 'BIL', NOW);
    if (out.most_iterated_type) {
      const row = out.by_type.find((r) => r.type === out.most_iterated_type);
      const maxCount = Math.max(...out.by_type.map((r) => r.version_count));
      expect(row.version_count).toBe(maxCount);
    }
  });

  test('avg_generations_across_types is mean of version_counts', () => {
    const registry = new InMemoryAiModelRegistry();
    const out = buildModelVersionLineage(registry, 'BIL', NOW);
    const mean = Math.round(out.by_type.reduce((s, r) => s + r.version_count, 0) / out.by_type.length * 100) / 100;
    expect(out.avg_generations_across_types).toBe(mean);
  });

  test('oldest and latest differ when version_count >= 2', () => {
    const registry = new InMemoryAiModelRegistry();
    const out = buildModelVersionLineage(registry, 'BIL', NOW);
    for (const row of out.by_type) {
      if (row.version_count >= 2) {
        expect(row.oldest_version_id).not.toBe(row.latest_version_id);
      }
    }
  });
});

describe('M7.28 — route', () => {
  test('risk_analyst GET /v1/ai/models/version-lineage returns 200', async () => {
    const app = makeLineageApp('risk_analyst');
    const res = await request(app).get('/v1/ai/models/version-lineage').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('by_type');
  });

  test('non-allowed role gets 403', async () => {
    const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => 'unknown_role' });
    const res = await request(app).get('/v1/ai/models/version-lineage').set(TH);
    expect(res.status).toBe(403);
  });
});
