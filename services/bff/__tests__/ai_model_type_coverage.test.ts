// services/bff/__tests__/ai_model_type_coverage.test.ts
//
// T6 M7.12 — AI model type coverage matrix.

import request from 'supertest';
import {
  buildModelTypeCoverageMatrix,
  ALL_MODEL_TYPES,
} from '../src/ai_model_type_coverage';
import {
  InMemoryAiModelRegistry,
  type AiModelRegistry,
  type ModelType,
  type ModelVersion,
} from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

/** Mock registry with type-filter support (matches the M7.1 list signature). */
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
  getProductionByType(type: ModelType): ModelVersion | null {
    return this.items.find((m) => m.type === type && m.status === 'production') ?? null;
  }
  score(): never { throw new Error('not implemented'); }
  create(): never { throw new Error('not implemented'); }
  update(): never { throw new Error('not implemented'); }
  retire(): never { throw new Error('not implemented'); }
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

function makeCovApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── buildModelTypeCoverageMatrix — pure ─────────────────────────────

describe('M7.12 — empty input', () => {
  test('zero models → zero envelope + every type row at 0', () => {
    const s = buildModelTypeCoverageMatrix(new FakeRegistry([]), NOW);
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_models).toBe(0);
    expect(s.types.length).toBe(6);
    for (const row of s.types) {
      expect(row.count).toBe(0);
      expect(row.has_production).toBe(false);
      expect(row.production_model_id).toBeNull();
      expect(row.most_recent_trained_at).toBeNull();
      expect(row.distinct_frameworks).toBe(0);
      // Every status key present at 0.
      expect(row.by_status.experimental).toBe(0);
      expect(row.by_status.staging).toBe(0);
      expect(row.by_status.production).toBe(0);
      expect(row.by_status.shadow).toBe(0);
      expect(row.by_status.retired).toBe(0);
      expect(Object.keys(row.by_status).length).toBe(5);
      // Every framework key present at 0.
      expect(Object.keys(row.by_framework).length).toBe(5);
    }
    expect(s.most_supported_type).toBeNull();
    // Every type missing production.
    expect(s.types_without_production).toEqual([...ALL_MODEL_TYPES]);
  });
});

describe('M7.12 — canonical type order', () => {
  test('types[] order is pd → fraud → churn → lapse → anomaly → claim_severity', () => {
    const s = buildModelTypeCoverageMatrix(new FakeRegistry([]), NOW);
    expect(s.types.map((r) => r.type)).toEqual([
      'pd', 'fraud', 'churn', 'lapse', 'anomaly', 'claim_severity',
    ]);
  });
});

describe('M7.12 — single-type placement', () => {
  test('one pd model → only pd row populated', () => {
    const reg = new FakeRegistry([model({ model_id: 'm-pd', type: 'pd' })]);
    const s = buildModelTypeCoverageMatrix(reg, NOW);
    const pd = s.types.find((r) => r.type === 'pd')!;
    expect(pd.count).toBe(1);
    expect(pd.by_status.production).toBe(1);
    expect(pd.has_production).toBe(true);
    expect(pd.production_model_id).toBe('m-pd');
    const fraud = s.types.find((r) => r.type === 'fraud')!;
    expect(fraud.count).toBe(0);
    expect(fraud.has_production).toBe(false);
  });
});

describe('M7.12 — by_status accumulation', () => {
  test('multiple statuses in same type all counted', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', type: 'pd', status: 'production' }),
      model({ model_id: 'b', type: 'pd', status: 'staging' }),
      model({ model_id: 'c', type: 'pd', status: 'shadow' }),
      model({ model_id: 'd', type: 'pd', status: 'retired' }),
      model({ model_id: 'e', type: 'pd', status: 'experimental' }),
    ]);
    const s = buildModelTypeCoverageMatrix(reg, NOW);
    const pd = s.types.find((r) => r.type === 'pd')!;
    expect(pd.count).toBe(5);
    expect(pd.by_status.production).toBe(1);
    expect(pd.by_status.staging).toBe(1);
    expect(pd.by_status.shadow).toBe(1);
    expect(pd.by_status.retired).toBe(1);
    expect(pd.by_status.experimental).toBe(1);
  });
});

describe('M7.12 — by_status partition', () => {
  test('Σ by_status = count per row', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', type: 'fraud', status: 'production' }),
      model({ model_id: 'b', type: 'fraud', status: 'staging' }),
      model({ model_id: 'c', type: 'fraud', status: 'retired' }),
    ]);
    const s = buildModelTypeCoverageMatrix(reg, NOW);
    for (const row of s.types) {
      const sum = Object.values(row.by_status).reduce((a, c) => a + c, 0);
      expect(sum).toBe(row.count);
    }
  });
});

describe('M7.12 — by_framework accumulation', () => {
  test('frameworks counted; distinct_frameworks reflects uniqueness', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', type: 'pd', framework: 'xgboost' }),
      model({ model_id: 'b', type: 'pd', framework: 'xgboost' }), // dup
      model({ model_id: 'c', type: 'pd', framework: 'lightgbm' }),
      model({ model_id: 'd', type: 'pd', framework: 'torch' }),
    ]);
    const s = buildModelTypeCoverageMatrix(reg, NOW);
    const pd = s.types.find((r) => r.type === 'pd')!;
    expect(pd.by_framework.xgboost).toBe(2);
    expect(pd.by_framework.lightgbm).toBe(1);
    expect(pd.by_framework.torch).toBe(1);
    expect(pd.by_framework.sklearn).toBe(0);
    expect(pd.by_framework.isolation_forest).toBe(0);
    expect(pd.distinct_frameworks).toBe(3);
  });
});

describe('M7.12 — has_production', () => {
  test('= by_status.production > 0', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', type: 'pd', status: 'staging' }),
      model({ model_id: 'b', type: 'fraud', status: 'production' }),
    ]);
    const s = buildModelTypeCoverageMatrix(reg, NOW);
    expect(s.types.find((r) => r.type === 'pd')!.has_production).toBe(false);
    expect(s.types.find((r) => r.type === 'fraud')!.has_production).toBe(true);
  });
});

describe('M7.12 — production_model_id picks most-recently-trained production', () => {
  test('on ties multiple production rows → newest trained_at wins', () => {
    const older = new Date(NOW.getTime() - 30 * 86400_000).toISOString();
    const newer = new Date(NOW.getTime() - 5 * 86400_000).toISOString();
    const reg = new FakeRegistry([
      model({ model_id: 'old-prod', type: 'pd', status: 'production', trained_at: older }),
      model({ model_id: 'new-prod', type: 'pd', status: 'production', trained_at: newer }),
    ]);
    const s = buildModelTypeCoverageMatrix(reg, NOW);
    expect(s.types.find((r) => r.type === 'pd')!.production_model_id).toBe('new-prod');
  });

  test('null when no production row', () => {
    const reg = new FakeRegistry([
      model({ model_id: 's', type: 'pd', status: 'staging' }),
    ]);
    const s = buildModelTypeCoverageMatrix(reg, NOW);
    expect(s.types.find((r) => r.type === 'pd')!.production_model_id).toBeNull();
  });
});

describe('M7.12 — most_recent_trained_at', () => {
  test('takes the newest trained_at across all versions of the type', () => {
    const t1 = new Date(NOW.getTime() - 100 * 86400_000).toISOString();
    const t2 = new Date(NOW.getTime() - 10 * 86400_000).toISOString();
    const t3 = new Date(NOW.getTime() - 50 * 86400_000).toISOString();
    const reg = new FakeRegistry([
      model({ model_id: 'a', type: 'pd', trained_at: t1 }),
      model({ model_id: 'b', type: 'pd', trained_at: t2 }),
      model({ model_id: 'c', type: 'pd', trained_at: t3 }),
    ]);
    const s = buildModelTypeCoverageMatrix(reg, NOW);
    expect(s.types.find((r) => r.type === 'pd')!.most_recent_trained_at).toBe(t2);
  });
});

describe('M7.12 — types_without_production', () => {
  test('lists every type with has_production=false in canonical order', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'pd-prod', type: 'pd', status: 'production' }),
      model({ model_id: 'fraud-prod', type: 'fraud', status: 'production' }),
      model({ model_id: 'churn-stg', type: 'churn', status: 'staging' }),
    ]);
    const s = buildModelTypeCoverageMatrix(reg, NOW);
    // pd + fraud have production; churn/lapse/anomaly/claim_severity don't.
    expect(s.types_without_production).toEqual([
      'churn', 'lapse', 'anomaly', 'claim_severity',
    ]);
  });

  test('empty when every type has production', () => {
    const reg = new FakeRegistry(
      ALL_MODEL_TYPES.map((t) =>
        model({ model_id: `${t}-prod`, type: t, status: 'production' }),
      ),
    );
    const s = buildModelTypeCoverageMatrix(reg, NOW);
    expect(s.types_without_production).toEqual([]);
  });
});

describe('M7.12 — most_supported_type', () => {
  test('points at the type with highest count', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', type: 'fraud' }),
      model({ model_id: 'b', type: 'fraud' }),
      model({ model_id: 'c', type: 'fraud' }),
      model({ model_id: 'd', type: 'pd' }),
    ]);
    const s = buildModelTypeCoverageMatrix(reg, NOW);
    expect(s.most_supported_type).toBe('fraud');
  });

  test('canonical-order tie-break: pd wins over fraud at same count', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', type: 'fraud' }),
      model({ model_id: 'b', type: 'pd' }),
    ]);
    const s = buildModelTypeCoverageMatrix(reg, NOW);
    expect(s.most_supported_type).toBe('pd');
  });

  test('null when no models', () => {
    const s = buildModelTypeCoverageMatrix(new FakeRegistry([]), NOW);
    expect(s.most_supported_type).toBeNull();
  });
});

describe('M7.12 — partition: Σ count = total_models', () => {
  test('counts sum across types', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', type: 'pd' }),
      model({ model_id: 'b', type: 'pd' }),
      model({ model_id: 'c', type: 'fraud' }),
      model({ model_id: 'd', type: 'churn' }),
    ]);
    const s = buildModelTypeCoverageMatrix(reg, NOW);
    const sum = s.types.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(s.total_models);
    expect(s.total_models).toBe(4);
  });
});

describe('M7.12 — default registry integration', () => {
  test('M7.1 seed models all surface in coverage matrix', () => {
    const reg = new InMemoryAiModelRegistry();
    const s = buildModelTypeCoverageMatrix(reg, NOW);
    const sum = s.types.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(s.total_models);
    expect(s.total_models).toBeGreaterThan(0);
    // At least pd + fraud should have production deployments per seed.
    expect(s.types.find((r) => r.type === 'pd')!.has_production).toBe(true);
    expect(s.types.find((r) => r.type === 'fraud')!.has_production).toBe(true);
  });
});

// ─── GET /v1/ai/models/type-coverage ─────────────────────────────────

describe('M7.12 — GET /v1/ai/models/type-coverage', () => {
  test('admin → 200 with populated rollup from default registry', async () => {
    const { app } = makeCovApp('admin');
    const r = await request(app).get('/v1/ai/models/type-coverage').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.types.length).toBe(6);
    expect(r.body.body.types.map((t: { type: string }) => t.type)).toEqual([
      'pd', 'fraud', 'churn', 'lapse', 'anomaly', 'claim_severity',
    ]);
    expect(r.body.body.total_models).toBeGreaterThan(0);
    expect(r.body.body.most_supported_type).not.toBeNull();
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCovApp('case_owner');
    const r = await request(app).get('/v1/ai/models/type-coverage').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('literal /type-coverage not captured by :model_id wildcard', async () => {
    const { app } = makeCovApp('admin');
    const r = await request(app).get('/v1/ai/models/type-coverage').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.types.length).toBe(6);
  });

  test('M7.11 /v1/ai/models/deployment-age still works (sibling regression)', async () => {
    const { app } = makeCovApp('admin');
    const r = await request(app).get('/v1/ai/models/deployment-age').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M7.10 /v1/ai/models/promotion-fleet still works (sibling regression)', async () => {
    const { app } = makeCovApp('admin');
    const r = await request(app).get('/v1/ai/models/promotion-fleet').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M7.1 /v1/ai/models (list) still works (parent regression)', async () => {
    const { app } = makeCovApp('admin');
    const r = await request(app).get('/v1/ai/models').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
