// @ts-nocheck
import { describe, it, expect } from '@jest/globals';
import { makeApp } from '../src/server';
import supertest from 'supertest';
import { buildModelEnsembleRecommendation } from '../src/model_ensemble_recommendation';
import { InMemoryAiModelRegistry } from '../src/ai_model_registry';

const NOW = new Date('2026-06-11T12:00:00Z');

describe('buildModelEnsembleRecommendation', () => {
  it('returns 6 types', () => {
    const registry = new InMemoryAiModelRegistry();
    const out = buildModelEnsembleRecommendation(registry, NOW);
    expect(out.by_type.length).toBe(6);
  });

  it('recommendation is one of the valid values', () => {
    const registry = new InMemoryAiModelRegistry();
    const out = buildModelEnsembleRecommendation(registry, NOW);
    for (const t of out.by_type) {
      expect(['ensemble', 'single_model', 'retrain_needed']).toContain(t.recommendation);
    }
  });

  it('types_ready_for_ensemble + types_needing_retraining <= 6', () => {
    const registry = new InMemoryAiModelRegistry();
    const out = buildModelEnsembleRecommendation(registry, NOW);
    expect(out.types_ready_for_ensemble + out.types_needing_retraining).toBeLessThanOrEqual(6);
  });

  it('ensemble types have both primary and secondary model ids', () => {
    const registry = new InMemoryAiModelRegistry();
    const out = buildModelEnsembleRecommendation(registry, NOW);
    for (const t of out.by_type) {
      if (t.recommendation === 'ensemble') {
        expect(t.primary_model_id).not.toBeNull();
        expect(t.secondary_model_id).not.toBeNull();
      }
    }
  });

  it('retrain_needed types have null model ids', () => {
    const registry = new InMemoryAiModelRegistry();
    const out = buildModelEnsembleRecommendation(registry, NOW);
    for (const t of out.by_type) {
      if (t.recommendation === 'retrain_needed') {
        expect(t.primary_model_id).toBeNull();
        expect(t.secondary_model_id).toBeNull();
      }
    }
  });

  it('ensemble_benefit_estimate >= 0', () => {
    const registry = new InMemoryAiModelRegistry();
    const out = buildModelEnsembleRecommendation(registry, NOW);
    for (const t of out.by_type) {
      expect(t.ensemble_benefit_estimate).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('GET /v1/ai/models/ensemble-recommendation', () => {
  it('returns 200 for risk_analyst', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/ai/models/ensemble-recommendation')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'risk_analyst');
    expect(res.status).toBe(200);
    expect(res.body.body.by_type.length).toBe(6);
  });

  it('returns 403 for case_owner', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/ai/models/ensemble-recommendation')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'case_owner');
    expect(res.status).toBe(403);
  });
});
