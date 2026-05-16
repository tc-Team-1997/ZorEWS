// services/bff/__tests__/ai_model_framework_distribution.test.ts
//
// T6 M7.13 — AI model framework distribution.

import request from 'supertest';
import {
  summarizeModelFrameworkDistribution,
  ALL_MODEL_FRAMEWORKS,
} from '../src/ai_model_framework_distribution';
import {
  InMemoryAiModelRegistry,
  type AiModelRegistry,
  type ModelType,
  type ModelFramework,
  type ModelVersion,
} from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

class FakeRegistry implements AiModelRegistry {
  constructor(private readonly items: ModelVersion[]) {}
  list(filter?: { type?: ModelType; status?: string }): ModelVersion[] {
    let out = [...this.items];
    if (filter?.type) out = out.filter((m) => m.type === filter.type);
    if (filter?.status) out = out.filter((m) => m.status === filter.status);
    return out;
  }
  get(model_id: string): ModelVersion | null {
    return this.items.find((m) => m.model_id === model_id) ?? null;
  }
  getProductionByType(): ModelVersion | null { return null; }
  score(): never { throw new Error('not implemented'); }
}

function model(overrides: Partial<ModelVersion>): ModelVersion {
  return {
    model_id: 'test-model',
    name: 'Test',
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

function makeFwApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── summarizeModelFrameworkDistribution — pure ──────────────────────

describe('M7.13 — empty registry', () => {
  test('zero models → every framework row at 0 with every status + type key emitted', () => {
    const s = summarizeModelFrameworkDistribution(new FakeRegistry([]), NOW);
    expect(s.total_models).toBe(0);
    expect(s.frameworks.length).toBe(5);
    for (const row of s.frameworks) {
      expect(row.count).toBe(0);
      expect(row.has_production).toBe(false);
      expect(row.production_count).toBe(0);
      expect(row.most_recent_trained_at).toBeNull();
      expect(row.model_ids).toEqual([]);
      expect(Object.keys(row.by_status).length).toBe(5);
      expect(Object.keys(row.by_type).length).toBe(6);
    }
    expect(s.most_common_framework).toBeNull();
    expect(s.unused_frameworks).toEqual([...ALL_MODEL_FRAMEWORKS]);
    expect(s.framework_with_most_production).toBeNull();
  });
});

describe('M7.13 — canonical framework order', () => {
  test('frameworks[] in canonical xgboost → sklearn → torch → lightgbm → isolation_forest order', () => {
    const s = summarizeModelFrameworkDistribution(new FakeRegistry([]), NOW);
    expect(s.frameworks.map((r) => r.framework)).toEqual([...ALL_MODEL_FRAMEWORKS]);
  });
});

describe('M7.13 — single placement', () => {
  test('one xgboost model → only xgboost row populated', () => {
    const reg = new FakeRegistry([model({ model_id: 'm-x', framework: 'xgboost' })]);
    const s = summarizeModelFrameworkDistribution(reg, NOW);
    const xgb = s.frameworks.find((r) => r.framework === 'xgboost')!;
    expect(xgb.count).toBe(1);
    expect(xgb.model_ids).toEqual(['m-x']);
    const torch = s.frameworks.find((r) => r.framework === 'torch')!;
    expect(torch.count).toBe(0);
  });
});

describe('M7.13 — by_status partition', () => {
  test('Σ by_status per row = row.count', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', status: 'production' }),
      model({ model_id: 'b', framework: 'xgboost', status: 'staging' }),
      model({ model_id: 'c', framework: 'xgboost', status: 'retired' }),
    ]);
    const s = summarizeModelFrameworkDistribution(reg, NOW);
    const xgb = s.frameworks.find((r) => r.framework === 'xgboost')!;
    const sum = Object.values(xgb.by_status).reduce((a, b) => a + b, 0);
    expect(sum).toBe(xgb.count);
  });
});

describe('M7.13 — by_type partition', () => {
  test('Σ by_type per row = row.count', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', type: 'pd' }),
      model({ model_id: 'b', framework: 'xgboost', type: 'fraud' }),
      model({ model_id: 'c', framework: 'xgboost', type: 'churn' }),
    ]);
    const s = summarizeModelFrameworkDistribution(reg, NOW);
    const xgb = s.frameworks.find((r) => r.framework === 'xgboost')!;
    const sum = Object.values(xgb.by_type).reduce((a, b) => a + b, 0);
    expect(sum).toBe(xgb.count);
  });
});

describe('M7.13 — has_production + production_count', () => {
  test('has_production = (by_status.production > 0); production_count matches', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', status: 'production' }),
      model({ model_id: 'b', framework: 'xgboost', status: 'production' }),
      model({ model_id: 'c', framework: 'torch', status: 'staging' }),
    ]);
    const s = summarizeModelFrameworkDistribution(reg, NOW);
    const xgb = s.frameworks.find((r) => r.framework === 'xgboost')!;
    const torch = s.frameworks.find((r) => r.framework === 'torch')!;
    expect(xgb.has_production).toBe(true);
    expect(xgb.production_count).toBe(2);
    expect(torch.has_production).toBe(false);
    expect(torch.production_count).toBe(0);
  });
});

describe('M7.13 — most_recent_trained_at', () => {
  test('takes newest trained_at across framework versions', () => {
    const t1 = new Date(NOW.getTime() - 100 * 86400_000).toISOString();
    const t2 = new Date(NOW.getTime() - 10 * 86400_000).toISOString();
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', trained_at: t1 }),
      model({ model_id: 'b', framework: 'xgboost', trained_at: t2 }),
    ]);
    const s = summarizeModelFrameworkDistribution(reg, NOW);
    const xgb = s.frameworks.find((r) => r.framework === 'xgboost')!;
    expect(xgb.most_recent_trained_at).toBe(t2);
  });
});

describe('M7.13 — model_ids sorted asc', () => {
  test('per-row model_ids sorted asc', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'z-1', framework: 'xgboost' }),
      model({ model_id: 'a-1', framework: 'xgboost' }),
      model({ model_id: 'm-1', framework: 'xgboost' }),
    ]);
    const s = summarizeModelFrameworkDistribution(reg, NOW);
    expect(s.frameworks.find((r) => r.framework === 'xgboost')!.model_ids)
      .toEqual(['a-1', 'm-1', 'z-1']);
  });
});

describe('M7.13 — most_common_framework', () => {
  test('points at highest-count framework', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'torch' }),
      model({ model_id: 'b', framework: 'torch' }),
      model({ model_id: 'c', framework: 'torch' }),
      model({ model_id: 'd', framework: 'xgboost' }),
    ]);
    const s = summarizeModelFrameworkDistribution(reg, NOW);
    expect(s.most_common_framework).toBe('torch');
  });

  test('canonical tie-break: xgboost > sklearn at same count', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'sklearn' }),
      model({ model_id: 'b', framework: 'xgboost' }),
    ]);
    const s = summarizeModelFrameworkDistribution(reg, NOW);
    expect(s.most_common_framework).toBe('xgboost');
  });

  test('null when no models', () => {
    const s = summarizeModelFrameworkDistribution(new FakeRegistry([]), NOW);
    expect(s.most_common_framework).toBeNull();
  });
});

describe('M7.13 — unused_frameworks', () => {
  test('zero-count frameworks in canonical order', () => {
    const reg = new FakeRegistry([model({ model_id: 'a', framework: 'xgboost' })]);
    const s = summarizeModelFrameworkDistribution(reg, NOW);
    expect(s.unused_frameworks).toEqual(['sklearn', 'torch', 'lightgbm', 'isolation_forest']);
  });
});

describe('M7.13 — framework_with_most_production', () => {
  test('points at framework with highest production_count', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', status: 'production' }),
      model({ model_id: 'b', framework: 'xgboost', status: 'production' }),
      model({ model_id: 'c', framework: 'torch', status: 'production' }),
      model({ model_id: 'd', framework: 'sklearn', status: 'staging' }),
    ]);
    const s = summarizeModelFrameworkDistribution(reg, NOW);
    expect(s.framework_with_most_production!.framework).toBe('xgboost');
    expect(s.framework_with_most_production!.production_count).toBe(2);
  });

  test('canonical tie-break at tied production_count', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'torch', status: 'production' }),
      model({ model_id: 'b', framework: 'xgboost', status: 'production' }),
    ]);
    const s = summarizeModelFrameworkDistribution(reg, NOW);
    expect(s.framework_with_most_production!.framework).toBe('xgboost');
  });

  test('null when no production models', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', status: 'staging' }),
    ]);
    const s = summarizeModelFrameworkDistribution(reg, NOW);
    expect(s.framework_with_most_production).toBeNull();
  });
});

describe('M7.13 — Σ count = total_models', () => {
  test('partition across frameworks', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost' }),
      model({ model_id: 'b', framework: 'torch' }),
      model({ model_id: 'c', framework: 'sklearn' }),
    ]);
    const s = summarizeModelFrameworkDistribution(reg, NOW);
    const sum = s.frameworks.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(s.total_models);
    expect(s.total_models).toBe(3);
  });
});

describe('M7.13 — default 8-model seed integration', () => {
  test('SEED_MODELS distributed across frameworks; xgboost has most per seed', () => {
    const reg = new InMemoryAiModelRegistry();
    const s = summarizeModelFrameworkDistribution(reg, NOW);
    expect(s.total_models).toBeGreaterThan(0);
    const sum = s.frameworks.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(s.total_models);
    // Seed has 4 xgboost + 2 lightgbm + 1 torch + 1 isolation_forest = 8.
    expect(s.most_common_framework).toBe('xgboost');
  });
});

// ─── GET /v1/ai/models/framework-distribution ────────────────────────

describe('M7.13 — GET /v1/ai/models/framework-distribution', () => {
  test('admin → 200 with populated rollup', async () => {
    const { app } = makeFwApp('admin');
    const r = await request(app).get('/v1/ai/models/framework-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.frameworks.length).toBe(5);
    expect(r.body.body.total_models).toBeGreaterThan(0);
    expect(r.body.body.most_common_framework).toBe('xgboost');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeFwApp('case_owner');
    const r = await request(app).get('/v1/ai/models/framework-distribution').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('literal /framework-distribution not captured by :model_id wildcard', async () => {
    const { app } = makeFwApp('admin');
    const r = await request(app).get('/v1/ai/models/framework-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.frameworks.length).toBe(5);
  });

  test('M7.12 /v1/ai/models/type-coverage still works (sibling regression)', async () => {
    const { app } = makeFwApp('admin');
    const r = await request(app).get('/v1/ai/models/type-coverage').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
