// services/bff/__tests__/adapter_param_type_required_matrix.test.ts
//
// T6 M14.29 — Adapter operation parameter type × required cross-tab.

import request from 'supertest';
import {
  buildAdapterParamTypeRequiredMatrix,
  ALL_PARAMETER_TYPES,
  ALL_REQUIRED_COLUMNS,
} from '../src/adapter_param_type_required_matrix';
import { listAdapterOperationCatalog } from '../src/adapter_operation_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makePmApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

function manualParamScan() {
  const catalog = listAdapterOperationCatalog();
  let total = 0;
  const byTypeRequired: Record<string, number> = {};
  const byTypeOptional: Record<string, number> = {};
  for (const t of ALL_PARAMETER_TYPES) {
    byTypeRequired[t] = 0;
    byTypeOptional[t] = 0;
  }
  for (const adapter of catalog.adapters) {
    for (const op of adapter.operations) {
      for (const p of op.parameters) {
        total++;
        if (p.required) byTypeRequired[p.type]++;
        else byTypeOptional[p.type]++;
      }
    }
  }
  return { total, byTypeRequired, byTypeOptional };
}

// ─── buildAdapterParamTypeRequiredMatrix — pure ──────────────────────

describe('M14.29 — basic shape', () => {
  test('envelope contains every expected field', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    expect(m.generated_at).toBe(NOW.toISOString());
    expect(m.total_adapters).toBeGreaterThan(0);
    expect(m.total_operations).toBeGreaterThan(0);
    expect(m.total_parameters).toBeGreaterThan(0);
    expect(m.rows.length).toBe(ALL_PARAMETER_TYPES.length);
    expect(m.columns.length).toBe(2);
  });
});

describe('M14.29 — rows in canonical type order', () => {
  test('rows[] follows ALL_PARAMETER_TYPES', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    expect(m.rows.map((r) => r.type)).toEqual([...ALL_PARAMETER_TYPES]);
  });
});

describe('M14.29 — columns required then optional', () => {
  test('columns[].required_column = [required, optional]', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    expect(m.columns.map((c) => c.required_column)).toEqual([...ALL_REQUIRED_COLUMNS]);
  });
});

describe('M14.29 — total_parameters matches manual scan', () => {
  test('total_parameters = Σ params across all operations', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    const manual = manualParamScan();
    expect(m.total_parameters).toBe(manual.total);
  });
});

describe('M14.29 — per-row counts match manual', () => {
  test('required_count + optional_count match manual filter', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    const manual = manualParamScan();
    for (const row of m.rows) {
      expect(row.required_count).toBe(manual.byTypeRequired[row.type]);
      expect(row.optional_count).toBe(manual.byTypeOptional[row.type]);
    }
  });
});

describe('M14.29 — per-row partition invariant', () => {
  test('required_count + optional_count = row.total', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    for (const row of m.rows) {
      expect(row.required_count + row.optional_count).toBe(row.total);
    }
  });
});

describe('M14.29 — per-column total = Σ by_type', () => {
  test('Σ by_type = col.total per column', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    for (const col of m.columns) {
      const sum = Object.values(col.by_type).reduce((a, b) => a + b, 0);
      expect(col.total).toBe(sum);
    }
  });
});

describe('M14.29 — grand-total cross-check', () => {
  test('Σ rows.total = Σ cols.total = total_parameters', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    const rowSum = m.rows.reduce((acc, r) => acc + r.total, 0);
    const colSum = m.columns.reduce((acc, c) => acc + c.total, 0);
    expect(rowSum).toBe(m.total_parameters);
    expect(colSum).toBe(m.total_parameters);
  });
});

describe('M14.29 — every-type-key-present per column', () => {
  test('col.by_type has every ParameterType key', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    for (const col of m.columns) {
      for (const t of ALL_PARAMETER_TYPES) {
        expect(col.by_type).toHaveProperty(t);
        expect(typeof col.by_type[t]).toBe('number');
      }
    }
  });
});

describe('M14.29 — cell cross-check invariant', () => {
  test('row.required_count === columns[required].by_type[type]', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    const reqCol = m.columns.find((c) => c.required_column === 'required')!;
    const optCol = m.columns.find((c) => c.required_column === 'optional')!;
    for (const row of m.rows) {
      expect(row.required_count).toBe(reqCol.by_type[row.type]);
      expect(row.optional_count).toBe(optCol.by_type[row.type]);
    }
  });
});

describe('M14.29 — required_ratio formula', () => {
  test('= required/total for non-zero total; 0 for zero total', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    for (const row of m.rows) {
      if (row.total > 0) {
        expect(row.required_ratio).toBeCloseTo(row.required_count / row.total);
      } else {
        expect(row.required_ratio).toBe(0);
      }
    }
  });

  test('required_ratio bounded in [0, 1]', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    for (const row of m.rows) {
      expect(row.required_ratio).toBeGreaterThanOrEqual(0);
      expect(row.required_ratio).toBeLessThanOrEqual(1);
    }
  });
});

describe('M14.29 — peak_cell formula', () => {
  test('peak_cell.count equals max across all cells', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    let maxSeen = 0;
    for (const row of m.rows) {
      if (row.required_count > maxSeen) maxSeen = row.required_count;
      if (row.optional_count > maxSeen) maxSeen = row.optional_count;
    }
    expect(m.peak_cell!.count).toBe(maxSeen);
  });

  test('peak_cell.samples sorted (adapter_id, operation_id, parameter_name) asc + cap 5', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    const samples = m.peak_cell!.samples;
    expect(samples.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1]!;
      const curr = samples[i]!;
      if (prev.adapter_id !== curr.adapter_id) {
        expect(prev.adapter_id.localeCompare(curr.adapter_id)).toBeLessThan(0);
      } else if (prev.operation_id !== curr.operation_id) {
        expect(prev.operation_id.localeCompare(curr.operation_id)).toBeLessThan(0);
      } else {
        expect(prev.parameter_name.localeCompare(curr.parameter_name)).toBeLessThan(0);
      }
    }
  });

  test('peak_cell.samples carry valid (adapter, op, param) triples', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    const catalog = listAdapterOperationCatalog();
    for (const s of m.peak_cell!.samples) {
      const adapter = catalog.adapters.find((a) => a.adapter_id === s.adapter_id);
      expect(adapter).toBeDefined();
      const op = adapter!.operations.find((o) => o.operation_id === s.operation_id);
      expect(op).toBeDefined();
      const param = op!.parameters.find((p) => p.name === s.parameter_name);
      expect(param).toBeDefined();
      expect(param!.type).toBe(m.peak_cell!.type);
      expect(param!.required).toBe(m.peak_cell!.required_column === 'required');
    }
  });
});

describe('M14.29 — empty_cells', () => {
  test('every empty_cell has count=0 on both axes', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    for (const ec of m.empty_cells) {
      const row = m.rows.find((r) => r.type === ec.type)!;
      if (ec.required_column === 'required') {
        expect(row.required_count).toBe(0);
      } else {
        expect(row.optional_count).toBe(0);
      }
    }
  });

  test('canonical row-major order (type asc, required before optional)', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    for (let i = 1; i < m.empty_cells.length; i++) {
      const prev = m.empty_cells[i - 1]!;
      const curr = m.empty_cells[i]!;
      const prevTIdx = ALL_PARAMETER_TYPES.indexOf(prev.type);
      const currTIdx = ALL_PARAMETER_TYPES.indexOf(curr.type);
      if (prevTIdx !== currTIdx) {
        expect(currTIdx).toBeGreaterThan(prevTIdx);
      } else {
        expect(prev.required_column).toBe('required');
        expect(curr.required_column).toBe('optional');
      }
    }
  });

  test('partition: empty + non_empty = 8 cells (4 types × 2 required-cols)', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    const total_cells = ALL_PARAMETER_TYPES.length * ALL_REQUIRED_COLUMNS.length;
    let non_empty = 0;
    for (const row of m.rows) {
      if (row.required_count > 0) non_empty++;
      if (row.optional_count > 0) non_empty++;
    }
    expect(m.empty_cells.length + non_empty).toBe(total_cells);
  });
});

describe('M14.29 — strictest_type + loosest_type', () => {
  test('strictest_type has highest required_ratio among non-zero-total rows', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    expect(m.strictest_type).not.toBeNull();
    const target = m.rows.find((r) => r.type === m.strictest_type!.type)!;
    expect(m.strictest_type!.required_ratio).toBe(target.required_ratio);
    for (const row of m.rows) {
      if (row.total === 0) continue;
      expect(row.required_ratio).toBeLessThanOrEqual(target.required_ratio);
    }
  });

  test('loosest_type has lowest required_ratio among non-zero-total rows', () => {
    const m = buildAdapterParamTypeRequiredMatrix(NOW);
    expect(m.loosest_type).not.toBeNull();
    const target = m.rows.find((r) => r.type === m.loosest_type!.type)!;
    expect(m.loosest_type!.required_ratio).toBe(target.required_ratio);
    for (const row of m.rows) {
      if (row.total === 0) continue;
      expect(row.required_ratio).toBeGreaterThanOrEqual(target.required_ratio);
    }
  });
});

describe('M14.29 — platform-static', () => {
  test('different now → same matrix data', () => {
    const a = buildAdapterParamTypeRequiredMatrix(new Date('2026-01-01T00:00:00.000Z'));
    const b = buildAdapterParamTypeRequiredMatrix(new Date('2026-12-31T00:00:00.000Z'));
    expect(a.total_parameters).toBe(b.total_parameters);
    expect(a.rows.map((r) => r.total)).toEqual(b.rows.map((r) => r.total));
    expect(a.peak_cell).toEqual(b.peak_cell);
  });
});

// ─── GET /v1/integrations/adapters/operations/param-type-required-matrix ─

describe('M14.29 — GET /v1/integrations/adapters/operations/param-type-required-matrix', () => {
  test('admin → 200 with full matrix', async () => {
    const { app } = makePmApp('admin');
    const r = await request(app)
      .get('/v1/integrations/adapters/operations/param-type-required-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.rows.length).toBe(ALL_PARAMETER_TYPES.length);
    expect(r.body.body.columns.length).toBe(2);
    expect(r.body.body.total_parameters).toBeGreaterThan(0);
  });

  test('shape contains every expected field', async () => {
    const { app } = makePmApp('admin');
    const r = await request(app)
      .get('/v1/integrations/adapters/operations/param-type-required-matrix')
      .set(TH_BIL);
    expect(r.body.body).toHaveProperty('rows');
    expect(r.body.body).toHaveProperty('columns');
    expect(r.body.body).toHaveProperty('peak_cell');
    expect(r.body.body).toHaveProperty('empty_cells');
    expect(r.body.body).toHaveProperty('strictest_type');
    expect(r.body.body).toHaveProperty('loosest_type');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makePmApp('case_owner');
    const r = await request(app)
      .get('/v1/integrations/adapters/operations/param-type-required-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL ↔ BANK_DEMO same response', async () => {
    const { app } = makePmApp('admin');
    const bil = await request(app)
      .get('/v1/integrations/adapters/operations/param-type-required-matrix')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/integrations/adapters/operations/param-type-required-matrix')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body.total_parameters).toBe(bank.body.body.total_parameters);
    expect(bil.body.body.peak_cell).toEqual(bank.body.body.peak_cell);
  });

  test('M14.28 /operations/matrix still 200 (sibling regression)', async () => {
    const { app } = makePmApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/operations/matrix').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M14.27 /operations/method-distribution still 200 (sibling regression)', async () => {
    const { app } = makePmApp('admin');
    const r = await request(app)
      .get('/v1/integrations/adapters/operations/method-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M14.24 /operations still 200 (sibling regression)', async () => {
    const { app } = makePmApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/operations').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
