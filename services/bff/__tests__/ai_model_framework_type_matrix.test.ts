// services/bff/__tests__/ai_model_framework_type_matrix.test.ts
//
// T6 M7.14 — AI model framework × type cross-tab matrix.

import request from 'supertest';
import { buildAiModelFrameworkTypeMatrix } from '../src/ai_model_framework_type_matrix';
import { ALL_MODEL_TYPES } from '../src/ai_model_type_coverage';
import { ALL_MODEL_FRAMEWORKS } from '../src/ai_model_framework_distribution';
import {
  InMemoryAiModelRegistry,
  type AiModelRegistry,
  type ModelFramework,
  type ModelStatus,
  type ModelType,
  type ModelVersion,
} from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

class FakeRegistry implements AiModelRegistry {
  constructor(private readonly items: ModelVersion[]) {}
  list(filter?: { type?: ModelType; status?: ModelStatus }): ModelVersion[] {
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
  score(): never {
    throw new Error('not implemented');
  }
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

function makeFtmApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── buildAiModelFrameworkTypeMatrix — pure ──────────────────────────

describe('M7.14 — basic shape (empty)', () => {
  test('empty registry → every row + column at 0, leaderboards null', () => {
    const m = buildAiModelFrameworkTypeMatrix(new FakeRegistry([]), NOW);
    expect(m.generated_at).toBe(NOW.toISOString());
    expect(m.total_models).toBe(0);
    expect(m.total_frameworks).toBe(ALL_MODEL_FRAMEWORKS.length);
    expect(m.total_types).toBe(ALL_MODEL_TYPES.length);
    expect(m.rows.length).toBe(ALL_MODEL_FRAMEWORKS.length);
    expect(m.columns.length).toBe(ALL_MODEL_TYPES.length);
    for (const row of m.rows) {
      expect(row.total).toBe(0);
      for (const t of ALL_MODEL_TYPES) expect(row.by_type[t]).toBe(0);
    }
    expect(m.peak_cell).toBeNull();
    expect(m.most_versatile_framework).toBeNull();
    expect(m.best_supported_type).toBeNull();
    // empty registry → every cell is empty
    expect(m.empty_cells.length).toBe(ALL_MODEL_FRAMEWORKS.length * ALL_MODEL_TYPES.length);
  });
});

describe('M7.14 — rows in canonical framework order', () => {
  test('rows[] follows ALL_MODEL_FRAMEWORKS', () => {
    const m = buildAiModelFrameworkTypeMatrix(new FakeRegistry([]), NOW);
    expect(m.rows.map((r) => r.framework)).toEqual([...ALL_MODEL_FRAMEWORKS]);
  });
});

describe('M7.14 — columns in canonical type order', () => {
  test('columns[] follows ALL_MODEL_TYPES', () => {
    const m = buildAiModelFrameworkTypeMatrix(new FakeRegistry([]), NOW);
    expect(m.columns.map((c) => c.type)).toEqual([...ALL_MODEL_TYPES]);
  });
});

describe('M7.14 — single model placement', () => {
  test('1 xgboost/pd model → cell populated; only that row + column reflect it', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'm-pd-1', framework: 'xgboost', type: 'pd' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    expect(m.total_models).toBe(1);
    const xgb = m.rows.find((r) => r.framework === 'xgboost')!;
    expect(xgb.total).toBe(1);
    expect(xgb.by_type.pd).toBe(1);
    expect(xgb.by_type.fraud).toBe(0);
    const pd = m.columns.find((c) => c.type === 'pd')!;
    expect(pd.total).toBe(1);
    expect(pd.by_framework.xgboost).toBe(1);
    expect(pd.by_framework.sklearn).toBe(0);
    expect(m.peak_cell).not.toBeNull();
    expect(m.peak_cell!.framework).toBe('xgboost');
    expect(m.peak_cell!.type).toBe('pd');
    expect(m.peak_cell!.count).toBe(1);
    expect(m.peak_cell!.model_ids).toEqual(['m-pd-1']);
  });
});

describe('M7.14 — multiple models same cell', () => {
  test('3 xgboost/pd versions → cell count=3 with sorted model_ids', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'pd-zeta', framework: 'xgboost', type: 'pd' }),
      model({ model_id: 'pd-alpha', framework: 'xgboost', type: 'pd' }),
      model({ model_id: 'pd-mike', framework: 'xgboost', type: 'pd' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    expect(m.peak_cell!.count).toBe(3);
    expect(m.peak_cell!.model_ids).toEqual(['pd-alpha', 'pd-mike', 'pd-zeta']);
  });
});

describe('M7.14 — per-row partition invariant', () => {
  test('Σ by_type = row.total per row', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', type: 'pd' }),
      model({ model_id: 'b', framework: 'xgboost', type: 'fraud' }),
      model({ model_id: 'c', framework: 'sklearn', type: 'churn' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    for (const row of m.rows) {
      const sum = Object.values(row.by_type).reduce((a, b) => a + b, 0);
      expect(row.total).toBe(sum);
    }
  });
});

describe('M7.14 — per-column partition invariant', () => {
  test('Σ by_framework = col.total per col', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', type: 'pd' }),
      model({ model_id: 'b', framework: 'lightgbm', type: 'pd' }),
      model({ model_id: 'c', framework: 'sklearn', type: 'churn' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    for (const col of m.columns) {
      const sum = Object.values(col.by_framework).reduce((a, b) => a + b, 0);
      expect(col.total).toBe(sum);
    }
  });
});

describe('M7.14 — grand-total cross-check', () => {
  test('Σ rows.total = Σ cols.total = total_models', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', type: 'pd' }),
      model({ model_id: 'b', framework: 'lightgbm', type: 'pd' }),
      model({ model_id: 'c', framework: 'sklearn', type: 'churn' }),
      model({ model_id: 'd', framework: 'isolation_forest', type: 'anomaly' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    const rowSum = m.rows.reduce((acc, r) => acc + r.total, 0);
    const colSum = m.columns.reduce((acc, c) => acc + c.total, 0);
    expect(rowSum).toBe(m.total_models);
    expect(colSum).toBe(m.total_models);
    expect(m.total_models).toBe(4);
  });
});

describe('M7.14 — every-key-present invariants', () => {
  test('row.by_type has every ModelType key', () => {
    const m = buildAiModelFrameworkTypeMatrix(new FakeRegistry([]), NOW);
    for (const row of m.rows) {
      for (const t of ALL_MODEL_TYPES) {
        expect(row.by_type).toHaveProperty(t);
        expect(typeof row.by_type[t]).toBe('number');
      }
    }
  });

  test('col.by_framework has every ModelFramework key', () => {
    const m = buildAiModelFrameworkTypeMatrix(new FakeRegistry([]), NOW);
    for (const col of m.columns) {
      for (const f of ALL_MODEL_FRAMEWORKS) {
        expect(col.by_framework).toHaveProperty(f);
        expect(typeof col.by_framework[f]).toBe('number');
      }
    }
  });
});

describe('M7.14 — cell cross-check invariant', () => {
  test('row[fw].by_type[t] === col[t].by_framework[fw] for every pair', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', type: 'pd' }),
      model({ model_id: 'b', framework: 'torch', type: 'fraud' }),
      model({ model_id: 'c', framework: 'sklearn', type: 'lapse' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    for (const row of m.rows) {
      for (const col of m.columns) {
        expect(row.by_type[col.type]).toBe(col.by_framework[row.framework]);
      }
    }
  });
});

describe('M7.14 — types_without per row', () => {
  test('canonical type order; entries have by_type=0', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', type: 'pd' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    for (const row of m.rows) {
      const expected = ALL_MODEL_TYPES.filter((t) => row.by_type[t] === 0);
      expect(row.types_without).toEqual(expected);
      for (const t of row.types_without) {
        expect(row.by_type[t]).toBe(0);
      }
    }
  });
});

describe('M7.14 — frameworks_without per column', () => {
  test('canonical framework order; entries have by_framework=0', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', type: 'pd' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    for (const col of m.columns) {
      const expected = ALL_MODEL_FRAMEWORKS.filter((f) => col.by_framework[f] === 0);
      expect(col.frameworks_without).toEqual(expected);
      for (const f of col.frameworks_without) {
        expect(col.by_framework[f]).toBe(0);
      }
    }
  });
});

describe('M7.14 — peak_cell', () => {
  test('points at highest-count cell with canonical tie-break', () => {
    const reg = new FakeRegistry([
      // xgboost/pd: 2 models (top)
      model({ model_id: 'a', framework: 'xgboost', type: 'pd' }),
      model({ model_id: 'b', framework: 'xgboost', type: 'pd' }),
      // sklearn/churn: 1 model
      model({ model_id: 'c', framework: 'sklearn', type: 'churn' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    expect(m.peak_cell!.framework).toBe('xgboost');
    expect(m.peak_cell!.type).toBe('pd');
    expect(m.peak_cell!.count).toBe(2);
  });

  test('canonical iteration tie-break: xgboost/pd wins over xgboost/fraud at tied count', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'pd-1', framework: 'xgboost', type: 'pd' }),
      model({ model_id: 'fr-1', framework: 'xgboost', type: 'fraud' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    expect(m.peak_cell!.framework).toBe('xgboost');
    expect(m.peak_cell!.type).toBe('pd');
  });

  test('peak_cell.model_ids sorted asc + matches manual filter', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'pd-zeta', framework: 'xgboost', type: 'pd' }),
      model({ model_id: 'pd-alpha', framework: 'xgboost', type: 'pd' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    expect(m.peak_cell!.model_ids).toEqual(['pd-alpha', 'pd-zeta']);
  });

  test('null on empty', () => {
    const m = buildAiModelFrameworkTypeMatrix(new FakeRegistry([]), NOW);
    expect(m.peak_cell).toBeNull();
  });
});

describe('M7.14 — empty_cells', () => {
  test('every empty_cell pair has count=0 on both axes', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', type: 'pd' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    for (const ec of m.empty_cells) {
      const row = m.rows.find((r) => r.framework === ec.framework)!;
      expect(row.by_type[ec.type]).toBe(0);
    }
  });

  test('partition: empty + non_empty = total_cells', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', type: 'pd' }),
      model({ model_id: 'b', framework: 'torch', type: 'fraud' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    const total_cells = ALL_MODEL_FRAMEWORKS.length * ALL_MODEL_TYPES.length;
    let non_empty = 0;
    for (const row of m.rows) {
      for (const t of ALL_MODEL_TYPES) {
        if (row.by_type[t] > 0) non_empty++;
      }
    }
    expect(m.empty_cells.length + non_empty).toBe(total_cells);
  });

  test('canonical row-major order (framework asc index, then type asc index)', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', type: 'pd' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    for (let i = 1; i < m.empty_cells.length; i++) {
      const prev = m.empty_cells[i - 1]!;
      const curr = m.empty_cells[i]!;
      const prevFwIdx = ALL_MODEL_FRAMEWORKS.indexOf(prev.framework);
      const currFwIdx = ALL_MODEL_FRAMEWORKS.indexOf(curr.framework);
      if (prevFwIdx !== currFwIdx) {
        expect(currFwIdx).toBeGreaterThan(prevFwIdx);
      } else {
        const prevTyIdx = ALL_MODEL_TYPES.indexOf(prev.type);
        const currTyIdx = ALL_MODEL_TYPES.indexOf(curr.type);
        expect(currTyIdx).toBeGreaterThan(prevTyIdx);
      }
    }
  });
});

describe('M7.14 — most_versatile_framework', () => {
  test('points at framework with most distinct non-zero types', () => {
    const reg = new FakeRegistry([
      // xgboost covers 3 types
      model({ model_id: 'a', framework: 'xgboost', type: 'pd' }),
      model({ model_id: 'b', framework: 'xgboost', type: 'fraud' }),
      model({ model_id: 'c', framework: 'xgboost', type: 'churn' }),
      // sklearn covers 1 type
      model({ model_id: 'd', framework: 'sklearn', type: 'lapse' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    expect(m.most_versatile_framework!.framework).toBe('xgboost');
    expect(m.most_versatile_framework!.types_covered).toBe(3);
  });

  test('canonical-order tie-break: xgboost wins over sklearn at same span', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', type: 'pd' }),
      model({ model_id: 'b', framework: 'sklearn', type: 'fraud' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    expect(m.most_versatile_framework!.framework).toBe('xgboost');
  });

  test('null on empty', () => {
    const m = buildAiModelFrameworkTypeMatrix(new FakeRegistry([]), NOW);
    expect(m.most_versatile_framework).toBeNull();
  });
});

describe('M7.14 — best_supported_type', () => {
  test('points at type with most distinct non-zero frameworks', () => {
    const reg = new FakeRegistry([
      // pd has 3 frameworks (xgboost + sklearn + torch)
      model({ model_id: 'a', framework: 'xgboost', type: 'pd' }),
      model({ model_id: 'b', framework: 'sklearn', type: 'pd' }),
      model({ model_id: 'c', framework: 'torch', type: 'pd' }),
      // fraud has 1
      model({ model_id: 'd', framework: 'lightgbm', type: 'fraud' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    expect(m.best_supported_type!.type).toBe('pd');
    expect(m.best_supported_type!.frameworks_supporting).toBe(3);
  });

  test('canonical-order tie-break: pd wins over fraud at same span', () => {
    const reg = new FakeRegistry([
      model({ model_id: 'a', framework: 'xgboost', type: 'pd' }),
      model({ model_id: 'b', framework: 'xgboost', type: 'fraud' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    expect(m.best_supported_type!.type).toBe('pd');
  });

  test('null on empty', () => {
    const m = buildAiModelFrameworkTypeMatrix(new FakeRegistry([]), NOW);
    expect(m.best_supported_type).toBeNull();
  });
});

describe('M7.14 — invalid framework/type values silently skipped', () => {
  test('out-of-enum framework/type values not counted', () => {
    const reg = new FakeRegistry([
      // Cast through any to bypass type-check for this defensive test
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model({ model_id: 'a', framework: 'unknown' as any, type: 'pd' }),
      model({ model_id: 'b', framework: 'xgboost', type: 'pd' }),
    ]);
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    expect(m.total_models).toBe(1);
  });
});

describe('M7.14 — default registry integration', () => {
  test('uses default seed: M7.1 has 8 models', () => {
    const reg = new InMemoryAiModelRegistry();
    const m = buildAiModelFrameworkTypeMatrix(reg, NOW);
    expect(m.total_models).toBe(reg.list().length);
    expect(m.total_models).toBeGreaterThan(0);
  });
});

// ─── GET /v1/ai/models/framework-type-matrix ─────────────────────────

describe('M7.14 — GET /v1/ai/models/framework-type-matrix', () => {
  test('admin → 200 with full matrix', async () => {
    const { app } = makeFtmApp('admin');
    const r = await request(app).get('/v1/ai/models/framework-type-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.rows.length).toBe(ALL_MODEL_FRAMEWORKS.length);
    expect(r.body.body.columns.length).toBe(ALL_MODEL_TYPES.length);
    expect(r.body.body.total_models).toBeGreaterThan(0);
  });

  test('shape contains every expected field', async () => {
    const { app } = makeFtmApp('admin');
    const r = await request(app).get('/v1/ai/models/framework-type-matrix').set(TH_BIL);
    expect(r.body.body).toHaveProperty('rows');
    expect(r.body.body).toHaveProperty('columns');
    expect(r.body.body).toHaveProperty('peak_cell');
    expect(r.body.body).toHaveProperty('empty_cells');
    expect(r.body.body).toHaveProperty('most_versatile_framework');
    expect(r.body.body).toHaveProperty('best_supported_type');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeFtmApp('case_owner');
    const r = await request(app).get('/v1/ai/models/framework-type-matrix').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL ↔ BANK_DEMO same response', async () => {
    const { app } = makeFtmApp('admin');
    const bil = await request(app).get('/v1/ai/models/framework-type-matrix').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/ai/models/framework-type-matrix')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body.total_models).toBe(bank.body.body.total_models);
    expect(bil.body.body.peak_cell).toEqual(bank.body.body.peak_cell);
  });

  test('literal `/framework-type-matrix` not captured as :model_id', async () => {
    const { app } = makeFtmApp('admin');
    const r = await request(app).get('/v1/ai/models/framework-type-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M7.12 /v1/ai/models/type-coverage still 200 (sibling regression)', async () => {
    const { app } = makeFtmApp('admin');
    const r = await request(app).get('/v1/ai/models/type-coverage').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M7.13 /v1/ai/models/framework-distribution still 200 (sibling regression)', async () => {
    const { app } = makeFtmApp('admin');
    const r = await request(app).get('/v1/ai/models/framework-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
