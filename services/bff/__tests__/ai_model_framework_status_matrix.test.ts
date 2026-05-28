// services/bff/__tests__/ai_model_framework_status_matrix.test.ts
//
// T6 M7.19 — AI model framework × status cross-tab matrix.

import request from 'supertest';
import {
  buildAiModelFrameworkStatusMatrix,
  ALL_MODEL_STATUSES,
} from '../src/ai_model_framework_status_matrix';
import { ALL_MODEL_FRAMEWORKS } from '../src/ai_model_framework_distribution';
import {
  type AiModelRegistry,
  type ModelStatus,
  type ModelType,
  type ModelVersion,
} from '../src/ai_model_registry';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-28T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

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
  score(): never { throw new Error('not implemented'); }
  create(): never { throw new Error('not implemented'); }
  update(): never { throw new Error('not implemented'); }
  retire(): never { throw new Error('not implemented'); }
}

let nextSeq = 1;
function model(overrides: Partial<ModelVersion>): ModelVersion {
  return {
    model_id: `m-${nextSeq++}`,
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

function makeTestApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Pure resolver ─────────────────────────────────────────────────────

describe('M7.19 — buildAiModelFrameworkStatusMatrix', () => {
  test('ALL_MODEL_STATUSES canonical order', () => {
    expect(ALL_MODEL_STATUSES).toEqual([
      'experimental',
      'staging',
      'production',
      'shadow',
      'retired',
    ]);
  });

  test('empty registry → 25 empty cells + null leaderboards', () => {
    const m = buildAiModelFrameworkStatusMatrix(new FakeRegistry([]), NOW);
    expect(m.generated_at).toBe(NOW.toISOString());
    expect(m.total_models).toBe(0);
    expect(m.total_frameworks).toBe(ALL_MODEL_FRAMEWORKS.length);
    expect(m.total_statuses).toBe(5);
    expect(m.rows.length).toBe(ALL_MODEL_FRAMEWORKS.length);
    expect(m.columns.length).toBe(5);
    for (const row of m.rows) {
      expect(row.total).toBe(0);
      expect(row.distinct_statuses).toBe(0);
      expect(row.statuses_without).toEqual([...ALL_MODEL_STATUSES]);
    }
    for (const col of m.columns) {
      expect(col.total).toBe(0);
      expect(col.distinct_frameworks).toBe(0);
      expect(col.frameworks_without).toEqual([...ALL_MODEL_FRAMEWORKS]);
    }
    expect(m.peak_cell).toBeNull();
    expect(m.most_deployed_framework).toBeNull();
    expect(m.frameworks_in_production).toEqual([]);
    expect(m.most_common_status).toBeNull();
    expect(m.most_versatile_framework).toBeNull();
    expect(m.empty_cells.length).toBe(ALL_MODEL_FRAMEWORKS.length * 5);
  });

  test('rows canonical framework order, columns canonical status order', () => {
    const m = buildAiModelFrameworkStatusMatrix(new FakeRegistry([]), NOW);
    expect(m.rows.map((r) => r.framework)).toEqual([...ALL_MODEL_FRAMEWORKS]);
    expect(m.columns.map((c) => c.status)).toEqual([...ALL_MODEL_STATUSES]);
  });

  test('single model lands in correct cell', () => {
    const m = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([model({ model_id: 'a', framework: 'torch', status: 'staging' })]),
      NOW,
    );
    expect(m.total_models).toBe(1);
    const torchRow = m.rows.find((r) => r.framework === 'torch')!;
    expect(torchRow.by_status.staging).toBe(1);
    expect(torchRow.by_status.production).toBe(0);
    expect(torchRow.distinct_statuses).toBe(1);
    const stagingCol = m.columns.find((c) => c.status === 'staging')!;
    expect(stagingCol.by_framework.torch).toBe(1);
    expect(stagingCol.distinct_frameworks).toBe(1);
  });

  test('Σ rows = Σ cols = total_models (each model in exactly one cell)', () => {
    const m = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([
        model({ framework: 'xgboost', status: 'production' }),
        model({ framework: 'xgboost', status: 'retired' }),
        model({ framework: 'torch', status: 'experimental' }),
      ]),
      NOW,
    );
    const rowSum = m.rows.reduce((a, r) => a + r.total, 0);
    const colSum = m.columns.reduce((a, c) => a + c.total, 0);
    expect(rowSum).toBe(3);
    expect(colSum).toBe(3);
    expect(m.total_models).toBe(3);
  });

  test('Σ row.by_status = row.total + Σ col.by_framework = col.total', () => {
    const m = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([
        model({ framework: 'xgboost', status: 'production' }),
        model({ framework: 'xgboost', status: 'production' }),
        model({ framework: 'sklearn', status: 'staging' }),
      ]),
      NOW,
    );
    for (const row of m.rows) {
      const sum = ALL_MODEL_STATUSES.reduce((a, s) => a + row.by_status[s], 0);
      expect(sum).toBe(row.total);
    }
    for (const col of m.columns) {
      const sum = ALL_MODEL_FRAMEWORKS.reduce((a, f) => a + col.by_framework[f], 0);
      expect(sum).toBe(col.total);
    }
  });

  test('cell cross-check: row.by_status[s] === col[s].by_framework[framework]', () => {
    const m = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([
        model({ framework: 'xgboost', status: 'production' }),
        model({ framework: 'xgboost', status: 'shadow' }),
        model({ framework: 'lightgbm', status: 'production' }),
      ]),
      NOW,
    );
    for (const row of m.rows) {
      for (const s of ALL_MODEL_STATUSES) {
        const fromRow = row.by_status[s];
        const col = m.columns.find((c) => c.status === s)!;
        expect(fromRow).toBe(col.by_framework[row.framework]);
      }
    }
  });

  test('peak_cell = highest cell + model_ids sorted asc', () => {
    const m = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([
        model({ model_id: 'z', framework: 'xgboost', status: 'production' }),
        model({ model_id: 'a', framework: 'xgboost', status: 'production' }),
        model({ model_id: 'm', framework: 'xgboost', status: 'production' }),
        model({ framework: 'torch', status: 'retired' }),
      ]),
      NOW,
    );
    expect(m.peak_cell?.framework).toBe('xgboost');
    expect(m.peak_cell?.status).toBe('production');
    expect(m.peak_cell?.count).toBe(3);
    expect(m.peak_cell?.model_ids).toEqual(['a', 'm', 'z']);
  });

  test('peak_cell canonical iteration tie-break (frameworks × statuses)', () => {
    // sklearn@staging and torch@production both 1 → sklearn iterates first → wins
    const m = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([
        model({ framework: 'sklearn', status: 'staging' }),
        model({ framework: 'torch', status: 'production' }),
      ]),
      NOW,
    );
    expect(m.peak_cell?.framework).toBe('sklearn');
    expect(m.peak_cell?.status).toBe('staging');
  });

  test('peak_cell null on empty', () => {
    expect(buildAiModelFrameworkStatusMatrix(new FakeRegistry([]), NOW).peak_cell).toBeNull();
  });

  test('most_deployed_framework = highest production count', () => {
    const m = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([
        model({ framework: 'xgboost', status: 'production' }),
        model({ framework: 'xgboost', status: 'production' }),
        model({ framework: 'lightgbm', status: 'production' }),
        model({ framework: 'torch', status: 'experimental' }), // no production
      ]),
      NOW,
    );
    expect(m.most_deployed_framework).toEqual({ framework: 'xgboost', production_count: 2 });
  });

  test('most_deployed_framework canonical tie-break + null when no production', () => {
    const tie = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([
        model({ framework: 'xgboost', status: 'production' }),
        model({ framework: 'sklearn', status: 'production' }),
      ]),
      NOW,
    );
    expect(tie.most_deployed_framework?.framework).toBe('xgboost'); // canonical first

    const noProd = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([model({ framework: 'torch', status: 'experimental' })]),
      NOW,
    );
    expect(noProd.most_deployed_framework).toBeNull();
  });

  test('frameworks_in_production canonical order', () => {
    const m = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([
        model({ framework: 'torch', status: 'production' }),
        model({ framework: 'xgboost', status: 'production' }),
        model({ framework: 'sklearn', status: 'staging' }), // not production
      ]),
      NOW,
    );
    // canonical order: xgboost before torch
    expect(m.frameworks_in_production).toEqual(['xgboost', 'torch']);
  });

  test('most_common_status = highest column total + canonical tie-break', () => {
    const m = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([
        model({ framework: 'xgboost', status: 'experimental' }),
        model({ framework: 'sklearn', status: 'experimental' }),
        model({ framework: 'torch', status: 'experimental' }),
        model({ framework: 'lightgbm', status: 'production' }),
      ]),
      NOW,
    );
    expect(m.most_common_status).toEqual({ status: 'experimental', count: 3 });

    const tie = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([
        model({ framework: 'xgboost', status: 'experimental' }),
        model({ framework: 'sklearn', status: 'staging' }),
      ]),
      NOW,
    );
    // both 1 → experimental wins (canonical first)
    expect(tie.most_common_status?.status).toBe('experimental');
  });

  test('most_common_status null on empty', () => {
    expect(
      buildAiModelFrameworkStatusMatrix(new FakeRegistry([]), NOW).most_common_status,
    ).toBeNull();
  });

  test('most_versatile_framework = most distinct statuses', () => {
    const m = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([
        // xgboost spans 3 statuses
        model({ framework: 'xgboost', status: 'experimental' }),
        model({ framework: 'xgboost', status: 'production' }),
        model({ framework: 'xgboost', status: 'retired' }),
        // torch spans 1
        model({ framework: 'torch', status: 'staging' }),
      ]),
      NOW,
    );
    expect(m.most_versatile_framework).toEqual({ framework: 'xgboost', statuses_covered: 3 });
  });

  test('most_versatile_framework canonical tie-break', () => {
    const m = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([
        model({ framework: 'sklearn', status: 'experimental' }),
        model({ framework: 'sklearn', status: 'production' }),
        model({ framework: 'torch', status: 'experimental' }),
        model({ framework: 'torch', status: 'production' }),
      ]),
      NOW,
    );
    // both span 2 → sklearn wins (canonical before torch)
    expect(m.most_versatile_framework?.framework).toBe('sklearn');
  });

  test('most_versatile_framework null on empty', () => {
    expect(
      buildAiModelFrameworkStatusMatrix(new FakeRegistry([]), NOW).most_versatile_framework,
    ).toBeNull();
  });

  test('statuses_without per row + frameworks_without per col canonical order', () => {
    // xgboost only production
    const m = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([model({ framework: 'xgboost', status: 'production' })]),
      NOW,
    );
    const xgbRow = m.rows.find((r) => r.framework === 'xgboost')!;
    expect(xgbRow.statuses_without).toEqual(['experimental', 'staging', 'shadow', 'retired']);
    const prodCol = m.columns.find((c) => c.status === 'production')!;
    // production has only xgboost → other 4 frameworks absent (canonical order)
    expect(prodCol.frameworks_without).toEqual(['sklearn', 'torch', 'lightgbm', 'isolation_forest']);
  });

  test('empty_cells canonical row-major (framework × status)', () => {
    const m = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([model({ framework: 'xgboost', status: 'production' })]),
      NOW,
    );
    // 25 cells, 1 populated → 24 empty
    expect(m.empty_cells.length).toBe(24);
    // xgboost's other statuses first (experimental, staging, then production skipped, shadow, retired)
    expect(m.empty_cells[0]).toEqual({ framework: 'xgboost', status: 'experimental' });
    expect(m.empty_cells[1]).toEqual({ framework: 'xgboost', status: 'staging' });
    expect(m.empty_cells[2]).toEqual({ framework: 'xgboost', status: 'shadow' });
    expect(m.empty_cells[3]).toEqual({ framework: 'xgboost', status: 'retired' });
    expect(m.empty_cells[4]).toEqual({ framework: 'sklearn', status: 'experimental' });
  });

  test('out-of-enum framework / status skipped', () => {
    const m = buildAiModelFrameworkStatusMatrix(
      new FakeRegistry([
        model({ framework: 'bogus' as never, status: 'production' }),
        model({ framework: 'xgboost', status: 'zombie' as never }),
        model({ framework: 'xgboost', status: 'production' }),
      ]),
      NOW,
    );
    expect(m.total_models).toBe(1);
  });

  test('generated_at echo', () => {
    expect(buildAiModelFrameworkStatusMatrix(new FakeRegistry([]), NOW).generated_at).toBe(
      NOW.toISOString(),
    );
  });
});

// ─── Route ──────────────────────────────────────────────────────────────

describe('M7.19 — GET /v1/ai/models/framework-status-matrix', () => {
  test('admin → 200 over the seeded registry', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app).get('/v1/ai/models/framework-status-matrix').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_frameworks).toBe(ALL_MODEL_FRAMEWORKS.length);
    expect(r.body.body.total_statuses).toBe(5);
    expect(r.body.body.rows.length).toBe(ALL_MODEL_FRAMEWORKS.length);
    expect(r.body.body.columns.length).toBe(5);
    // seed has production models (pd + fraud) → leaderboards populated
    expect(r.body.body.total_models).toBeGreaterThan(0);
    expect(r.body.body.most_deployed_framework).not.toBeNull();
    expect(r.body.body.frameworks_in_production.length).toBeGreaterThan(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTestApp('case_owner');
    const r = await request(app).get('/v1/ai/models/framework-status-matrix').set(TH);
    expect(r.status).toBe(403);
  });

  test('M7.14 /framework-type-matrix sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app).get('/v1/ai/models/framework-type-matrix').set(TH);
    expect(r.status).toBe(200);
  });

  test('M7.13 /framework-distribution sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app).get('/v1/ai/models/framework-distribution').set(TH);
    expect(r.status).toBe(200);
  });

  test('/by-type/:type catch-all not shadowed (literal segment wins)', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app).get('/v1/ai/models/framework-status-matrix').set(TH);
    // route returns the matrix shape, not a by-type lookup
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.body.rows)).toBe(true);
    expect(r.body.body.rows.length).toBe(ALL_MODEL_FRAMEWORKS.length);
  });
});
