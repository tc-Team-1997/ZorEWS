// services/bff/__tests__/adapter_operation_matrix.test.ts
//
// T6 M14.28 — Adapter operation method × adapter cross-tab matrix.

import request from 'supertest';
import { buildAdapterOperationMatrix } from '../src/adapter_operation_matrix';
import { ALL_HTTP_METHODS } from '../src/adapter_operation_method_distribution';
import { listAdapterOperationCatalog } from '../src/adapter_operation_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeMxApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── buildAdapterOperationMatrix — pure ──────────────────────────────

describe('M14.28 — basic shape', () => {
  test('envelope carries every expected field', () => {
    const m = buildAdapterOperationMatrix(NOW);
    expect(m.generated_at).toBe(NOW.toISOString());
    expect(m.total_adapters).toBeGreaterThan(0);
    expect(m.total_operations).toBeGreaterThan(0);
    expect(m.rows.length).toBe(ALL_HTTP_METHODS.length);
    expect(m.columns.length).toBe(m.total_adapters);
    expect(m.peak_cell).not.toBeNull();
    expect(m.most_versatile_adapter).not.toBeNull();
  });
});

describe('M14.28 — rows in canonical method order', () => {
  test('rows[] follows ALL_HTTP_METHODS', () => {
    const m = buildAdapterOperationMatrix(NOW);
    expect(m.rows.map((r) => r.method)).toEqual([...ALL_HTTP_METHODS]);
  });
});

describe('M14.28 — columns match catalog adapter list', () => {
  test('columns[].adapter_id matches catalog.adapters', () => {
    const m = buildAdapterOperationMatrix(NOW);
    const catalog = listAdapterOperationCatalog();
    const catalogIds = catalog.adapters.map((a) => a.adapter_id);
    expect(m.columns.map((c) => c.adapter_id)).toEqual(catalogIds);
  });
});

describe('M14.28 — total_operations matches catalog sum', () => {
  test('Σ catalog operations = total_operations', () => {
    const m = buildAdapterOperationMatrix(NOW);
    const catalog = listAdapterOperationCatalog();
    let sum = 0;
    for (const a of catalog.adapters) sum += a.operations.length;
    expect(m.total_operations).toBe(sum);
  });
});

describe('M14.28 — per-row total matches Σ by_adapter', () => {
  test('per-row partition invariant', () => {
    const m = buildAdapterOperationMatrix(NOW);
    for (const row of m.rows) {
      const sum = Object.values(row.by_adapter).reduce((a, b) => a + b, 0);
      expect(row.total).toBe(sum);
    }
  });
});

describe('M14.28 — per-column total matches Σ by_method', () => {
  test('per-column partition invariant', () => {
    const m = buildAdapterOperationMatrix(NOW);
    for (const col of m.columns) {
      const sum = Object.values(col.by_method).reduce((a, b) => a + b, 0);
      expect(col.total).toBe(sum);
    }
  });
});

describe('M14.28 — Σ rows.total = Σ columns.total = total_operations', () => {
  test('grand-total cross-check', () => {
    const m = buildAdapterOperationMatrix(NOW);
    const rowSum = m.rows.reduce((acc, r) => acc + r.total, 0);
    const colSum = m.columns.reduce((acc, c) => acc + c.total, 0);
    expect(rowSum).toBe(m.total_operations);
    expect(colSum).toBe(m.total_operations);
  });
});

describe('M14.28 — by_adapter has every AdapterId per row', () => {
  test('every adapter present at 0 when absent', () => {
    const m = buildAdapterOperationMatrix(NOW);
    const catalogIds = m.columns.map((c) => c.adapter_id);
    for (const row of m.rows) {
      for (const id of catalogIds) {
        expect(row.by_adapter).toHaveProperty(id);
        expect(typeof row.by_adapter[id]).toBe('number');
      }
    }
  });
});

describe('M14.28 — by_method has every HTTP method per column', () => {
  test('every method present at 0 when absent', () => {
    const m = buildAdapterOperationMatrix(NOW);
    for (const col of m.columns) {
      for (const method of ALL_HTTP_METHODS) {
        expect(col.by_method).toHaveProperty(method);
        expect(typeof col.by_method[method]).toBe('number');
      }
    }
  });
});

describe('M14.28 — cell counts cross-check', () => {
  test('row[method].by_adapter[id] === col[id].by_method[method] for every pair', () => {
    const m = buildAdapterOperationMatrix(NOW);
    for (const row of m.rows) {
      for (const col of m.columns) {
        const fromRow = row.by_adapter[col.adapter_id];
        const fromCol = col.by_method[row.method];
        expect(fromRow).toBe(fromCol);
      }
    }
  });
});

describe('M14.28 — adapters_without per row', () => {
  test('subset of catalog adapter_ids where by_adapter=0; sorted asc', () => {
    const m = buildAdapterOperationMatrix(NOW);
    for (const row of m.rows) {
      // sorted asc
      const sorted = [...row.adapters_without].sort((a, z) => a.localeCompare(z));
      expect(row.adapters_without).toEqual(sorted);
      // every adapter in adapters_without has by_adapter=0
      for (const id of row.adapters_without) {
        expect(row.by_adapter[id]).toBe(0);
      }
    }
  });
});

describe('M14.28 — methods_without per column', () => {
  test('canonical method order; methods with by_method=0', () => {
    const m = buildAdapterOperationMatrix(NOW);
    for (const col of m.columns) {
      // canonical order
      const expectedOrder = ALL_HTTP_METHODS.filter((mm) => col.by_method[mm] === 0);
      expect(col.methods_without).toEqual(expectedOrder);
      for (const method of col.methods_without) {
        expect(col.by_method[method]).toBe(0);
      }
    }
  });
});

describe('M14.28 — peak_cell formula', () => {
  test('peak_cell.count equals max over all cells', () => {
    const m = buildAdapterOperationMatrix(NOW);
    let maxSeen = 0;
    for (const row of m.rows) {
      for (const id of m.columns.map((c) => c.adapter_id)) {
        if (row.by_adapter[id] > maxSeen) maxSeen = row.by_adapter[id];
      }
    }
    expect(m.peak_cell!.count).toBe(maxSeen);
  });

  test('peak_cell row × col counts agree', () => {
    const m = buildAdapterOperationMatrix(NOW);
    const peak = m.peak_cell!;
    const row = m.rows.find((r) => r.method === peak.method)!;
    expect(row.by_adapter[peak.adapter_id]).toBe(peak.count);
  });
});

describe('M14.28 — empty_cells lists zero-count pairs', () => {
  test('every empty_cell has count=0; partitions with non-empty cells', () => {
    const m = buildAdapterOperationMatrix(NOW);
    const allCells: { method: string; adapter_id: string }[] = [];
    for (const row of m.rows) {
      for (const id of m.columns.map((c) => c.adapter_id)) {
        allCells.push({ method: row.method, adapter_id: id });
      }
    }
    const expectedEmpty = allCells.filter((c) => {
      const row = m.rows.find((r) => r.method === c.method)!;
      // Cast adapter_id to keyof to avoid TS lookup
      return row.by_adapter[c.adapter_id as keyof typeof row.by_adapter] === 0;
    });
    expect(m.empty_cells.length).toBe(expectedEmpty.length);
    for (const cell of m.empty_cells) {
      expect(cell.count).toBe(0);
    }
  });
});

describe('M14.28 — empty_cells canonical order', () => {
  test('sorted by canonical method order, then adapter_id asc within method', () => {
    const m = buildAdapterOperationMatrix(NOW);
    for (let i = 1; i < m.empty_cells.length; i++) {
      const prev = m.empty_cells[i - 1]!;
      const curr = m.empty_cells[i]!;
      const prevMethodIdx = ALL_HTTP_METHODS.indexOf(prev.method);
      const currMethodIdx = ALL_HTTP_METHODS.indexOf(curr.method);
      if (prevMethodIdx !== currMethodIdx) {
        expect(currMethodIdx).toBeGreaterThan(prevMethodIdx);
      } else {
        expect(prev.adapter_id.localeCompare(curr.adapter_id)).toBeLessThan(0);
      }
    }
  });
});

describe('M14.28 — most_versatile_adapter', () => {
  test('points at adapter with the most non-zero method counts', () => {
    const m = buildAdapterOperationMatrix(NOW);
    const target = m.columns.find((c) => c.adapter_id === m.most_versatile_adapter!.adapter_id)!;
    const supportedMethods = ALL_HTTP_METHODS.filter((mm) => target.by_method[mm] > 0).length;
    expect(m.most_versatile_adapter!.methods_supported).toBe(supportedMethods);
    // No other adapter has STRICTLY more supported methods.
    for (const col of m.columns) {
      const span = ALL_HTTP_METHODS.filter((mm) => col.by_method[mm] > 0).length;
      expect(span).toBeLessThanOrEqual(supportedMethods);
    }
  });
});

describe('M14.28 — platform-static', () => {
  test('different `now` → same matrix data', () => {
    const a = buildAdapterOperationMatrix(new Date('2026-01-01T00:00:00.000Z'));
    const b = buildAdapterOperationMatrix(new Date('2026-12-31T00:00:00.000Z'));
    expect(a.total_adapters).toBe(b.total_adapters);
    expect(a.total_operations).toBe(b.total_operations);
    expect(a.rows.map((r) => r.total)).toEqual(b.rows.map((r) => r.total));
  });
});

// ─── GET /v1/integrations/adapters/operations/matrix ─────────────────

describe('M14.28 — GET /v1/integrations/adapters/operations/matrix', () => {
  test('admin → 200 with full matrix', async () => {
    const { app } = makeMxApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/operations/matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_operations).toBeGreaterThan(0);
    expect(r.body.body.rows.length).toBe(ALL_HTTP_METHODS.length);
  });

  test('shape contains every expected field', async () => {
    const { app } = makeMxApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/operations/matrix').set(TH_BIL);
    expect(r.body.body).toHaveProperty('rows');
    expect(r.body.body).toHaveProperty('columns');
    expect(r.body.body).toHaveProperty('peak_cell');
    expect(r.body.body).toHaveProperty('empty_cells');
    expect(r.body.body).toHaveProperty('most_versatile_adapter');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeMxApp('case_owner');
    const r = await request(app).get('/v1/integrations/adapters/operations/matrix').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL ↔ BANK_DEMO same response', async () => {
    const { app } = makeMxApp('admin');
    const bil = await request(app).get('/v1/integrations/adapters/operations/matrix').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/integrations/adapters/operations/matrix')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body.total_operations).toBe(bank.body.body.total_operations);
    expect(bil.body.body.peak_cell).toEqual(bank.body.body.peak_cell);
  });

  test('M14.24 /operations still 200 (sibling regression)', async () => {
    const { app } = makeMxApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/operations').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M14.27 /operations/method-distribution still 200 (sibling regression)', async () => {
    const { app } = makeMxApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/operations/method-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
