// services/bff/__tests__/ai_model_deployment_age.test.ts
//
// T6 M7.11 — Model deployment age histogram.

import request from 'supertest';
import { bucketModelsByDeploymentAge } from '../src/ai_model_deployment_age';
import {
  InMemoryAiModelRegistry,
  SEED_MODELS,
  type ModelVersion,
} from '../src/ai_model_registry';
import type { AiModelRegistry } from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// FakeRegistry — lets us inject arbitrary model arrays.
class FakeRegistry implements AiModelRegistry {
  constructor(private readonly items: ModelVersion[]) {}
  list(): ModelVersion[] {
    return this.items;
  }
  get(model_id: string): ModelVersion | null {
    return this.items.find((m) => m.model_id === model_id) ?? null;
  }
  getProductionByType(): ModelVersion | null {
    return null;
  }
  score(): never {
    throw new Error('not implemented in FakeRegistry');
  }
}

function model(overrides: Partial<ModelVersion>): ModelVersion {
  return {
    model_id: 'test-model',
    name: 'Test Model',
    type: 'pd',
    version: '1.0.0',
    status: 'production',
    framework: 'xgboost',
    description: 'test',
    trained_at: NOW.toISOString(),
    deployed_at: NOW.toISOString(),
    retired_at: null,
    training_data_window_days: 90,
    key_features: ['x'],
    metrics: {
      auc: 0.8,
      precision: 0.7,
      recall: 0.7,
      f1: 0.7,
      mae: null,
      training_rows: 1000,
      evaluated_at: NOW.toISOString(),
    },
    ...overrides,
  };
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ─── bucketModelsByDeploymentAge — pure ──────────────────────────────

describe('M7.11 — empty registry', () => {
  test('zero models → zero everything', () => {
    const h = bucketModelsByDeploymentAge(new FakeRegistry([]), NOW);
    expect(h.total_models_considered).toBe(0);
    expect(h.total_models_in_registry).toBe(0);
    expect(h.total_retired_excluded).toBe(0);
    expect(h.dominant_bucket).toBeNull();
    expect(h.buckets.length).toBe(6); // 5 deployed buckets + never_deployed
    for (const b of h.buckets) {
      expect(b.count).toBe(0);
      expect(b.samples).toEqual([]);
    }
  });
});

describe('M7.11 — bucket boundaries', () => {
  test('under_30d for < 30 days', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', deployed_at: daysAgo(0) }),
      model({ model_id: 'b', deployed_at: daysAgo(29) }),
    ]);
    const h = bucketModelsByDeploymentAge(reg, NOW);
    const u30 = h.buckets.find((b) => b.bucket === 'under_30d')!;
    expect(u30.count).toBe(2);
  });

  test('30_to_90d for [30, 90)', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', deployed_at: daysAgo(30) }),
      model({ model_id: 'b', deployed_at: daysAgo(89) }),
    ]);
    const h = bucketModelsByDeploymentAge(reg, NOW);
    const b3090 = h.buckets.find((b) => b.bucket === '30_to_90d')!;
    expect(b3090.count).toBe(2);
  });

  test('90_to_180d for [90, 180)', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', deployed_at: daysAgo(90) }),
      model({ model_id: 'b', deployed_at: daysAgo(179) }),
    ]);
    const h = bucketModelsByDeploymentAge(reg, NOW);
    const b90180 = h.buckets.find((b) => b.bucket === '90_to_180d')!;
    expect(b90180.count).toBe(2);
  });

  test('180_to_365d for [180, 365)', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', deployed_at: daysAgo(180) }),
      model({ model_id: 'b', deployed_at: daysAgo(364) }),
    ]);
    const h = bucketModelsByDeploymentAge(reg, NOW);
    const b180365 = h.buckets.find((b) => b.bucket === '180_to_365d')!;
    expect(b180365.count).toBe(2);
  });

  test('365d_plus for >= 365', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', deployed_at: daysAgo(365) }),
      model({ model_id: 'b', deployed_at: daysAgo(1000) }),
    ]);
    const h = bucketModelsByDeploymentAge(reg, NOW);
    const b365 = h.buckets.find((b) => b.bucket === '365d_plus')!;
    expect(b365.count).toBe(2);
  });

  test('never_deployed for null deployed_at', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', status: 'experimental', deployed_at: null }),
      model({ model_id: 'b', status: 'staging', deployed_at: null }),
    ]);
    const h = bucketModelsByDeploymentAge(reg, NOW);
    const nd = h.buckets.find((b) => b.bucket === 'never_deployed')!;
    expect(nd.count).toBe(2);
  });
});

describe('M7.11 — retired excluded', () => {
  test('retired models counted in total_retired_excluded but not in buckets', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', status: 'production', deployed_at: daysAgo(60) }),
      model({ model_id: 'b', status: 'retired', deployed_at: daysAgo(500) }),
    ]);
    const h = bucketModelsByDeploymentAge(reg, NOW);
    expect(h.total_models_in_registry).toBe(2);
    expect(h.total_retired_excluded).toBe(1);
    expect(h.total_models_considered).toBe(1);
    // Sum across buckets = 1
    const sum = h.buckets.reduce((acc, b) => acc + b.count, 0);
    expect(sum).toBe(1);
  });
});

describe('M7.11 — samples top 3 sorted oldest-first', () => {
  test('samples capped at 3 and sorted by days desc', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'newest', deployed_at: daysAgo(5) }),
      model({ model_id: 'middle', deployed_at: daysAgo(15) }),
      model({ model_id: 'older', deployed_at: daysAgo(20) }),
      model({ model_id: 'oldest', deployed_at: daysAgo(25) }),
    ]);
    const h = bucketModelsByDeploymentAge(reg, NOW);
    const u30 = h.buckets.find((b) => b.bucket === 'under_30d')!;
    expect(u30.count).toBe(4);
    expect(u30.samples.length).toBe(3);
    // oldest first
    expect(u30.samples[0]!.model_id).toBe('oldest');
    expect(u30.samples[1]!.model_id).toBe('older');
    expect(u30.samples[2]!.model_id).toBe('middle');
  });

  test('never_deployed samples sorted by days_since_trained desc', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', status: 'experimental', deployed_at: null, trained_at: daysAgo(10) }),
      model({ model_id: 'b', status: 'experimental', deployed_at: null, trained_at: daysAgo(60) }),
      model({ model_id: 'c', status: 'experimental', deployed_at: null, trained_at: daysAgo(30) }),
    ]);
    const h = bucketModelsByDeploymentAge(reg, NOW);
    const nd = h.buckets.find((b) => b.bucket === 'never_deployed')!;
    expect(nd.samples[0]!.model_id).toBe('b');
    expect(nd.samples[1]!.model_id).toBe('c');
    expect(nd.samples[2]!.model_id).toBe('a');
  });
});

describe('M7.11 — dominant_bucket', () => {
  test('points at the bucket with the highest count', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', deployed_at: daysAgo(15) }),
      model({ model_id: 'b', deployed_at: daysAgo(20) }),
      model({ model_id: 'c', deployed_at: daysAgo(200) }),
    ]);
    const h = bucketModelsByDeploymentAge(reg, NOW);
    expect(h.dominant_bucket).toBe('under_30d');
  });

  test('tie-break by canonical BUCKETS order', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', deployed_at: daysAgo(15) }),
      model({ model_id: 'b', deployed_at: daysAgo(200) }),
    ]);
    const h = bucketModelsByDeploymentAge(reg, NOW);
    // Both buckets at 1 → under_30d wins (earlier in BUCKETS)
    expect(h.dominant_bucket).toBe('under_30d');
  });

  test('null when zero models considered', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', status: 'retired', deployed_at: daysAgo(60) }),
    ]);
    const h = bucketModelsByDeploymentAge(reg, NOW);
    expect(h.dominant_bucket).toBeNull();
  });
});

describe('M7.11 — bucket shape', () => {
  test('all 6 canonical buckets in declared order', () => {
    const reg = new FakeRegistry([]);
    const h = bucketModelsByDeploymentAge(reg, NOW);
    expect(h.buckets.map((b) => b.bucket)).toEqual([
      'under_30d',
      '30_to_90d',
      '90_to_180d',
      '180_to_365d',
      '365d_plus',
      'never_deployed',
    ]);
  });

  test('each bucket has min_days/max_days/label set', () => {
    const reg = new FakeRegistry([]);
    const h = bucketModelsByDeploymentAge(reg, NOW);
    for (const b of h.buckets) {
      expect(b.label.length).toBeGreaterThan(0);
    }
  });
});

describe('M7.11 — default registry integration', () => {
  test('M7.1 seed models all assigned to some bucket', () => {
    const reg = new InMemoryAiModelRegistry();
    const h = bucketModelsByDeploymentAge(reg, NOW);
    const sumBuckets = h.buckets.reduce((acc, b) => acc + b.count, 0);
    const expected = SEED_MODELS.filter((m) => m.status !== 'retired').length;
    expect(sumBuckets).toBe(expected);
    expect(h.total_models_considered).toBe(expected);
  });
});

// ─── GET /v1/ai/models/deployment-age ────────────────────────────────

function makeAgeApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M7.11 — GET /v1/ai/models/deployment-age', () => {
  test('admin → 200 with histogram from default registry', async () => {
    const { app } = makeAgeApp('admin');
    const r = await request(app).get('/v1/ai/models/deployment-age').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.buckets.length).toBe(6);
    expect(r.body.body.total_models_in_registry).toBeGreaterThan(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAgeApp('case_owner');
    const r = await request(app).get('/v1/ai/models/deployment-age').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL and BANK_DEMO see the same histogram', async () => {
    const { app } = makeAgeApp('admin');
    const bil = await request(app).get('/v1/ai/models/deployment-age').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/ai/models/deployment-age')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });

  test('M7.9 /v1/ai/models/retirement-candidates still works (sibling)', async () => {
    const { app } = makeAgeApp('admin');
    const r = await request(app).get('/v1/ai/models/retirement-candidates').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
