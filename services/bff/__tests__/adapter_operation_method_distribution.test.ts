// services/bff/__tests__/adapter_operation_method_distribution.test.ts
//
// T6 M14.27 — Adapter operation HTTP method distribution.

import request from 'supertest';
import {
  summarizeAdapterOperationsByMethod,
  ALL_HTTP_METHODS,
} from '../src/adapter_operation_method_distribution';
import { listAdapterOperationCatalog } from '../src/adapter_operation_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeMethodApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── summarizeAdapterOperationsByMethod — pure ───────────────────────

describe('M14.27 — catalog totals match', () => {
  test('total_operations matches sum of M14.24 group operation_counts', () => {
    const s = summarizeAdapterOperationsByMethod(NOW);
    const catalog = listAdapterOperationCatalog();
    expect(s.total_operations).toBe(catalog.total_operations);
    expect(s.total_operations).toBeGreaterThan(0);
  });
});

describe('M14.27 — canonical method order', () => {
  test('methods[] in canonical order even when zero-count', () => {
    const s = summarizeAdapterOperationsByMethod(NOW);
    expect(s.methods.map((r) => r.method)).toEqual([...ALL_HTTP_METHODS]);
  });
});

describe('M14.27 — every method emitted', () => {
  test('all 4 methods present in methods[]', () => {
    const s = summarizeAdapterOperationsByMethod(NOW);
    expect(s.methods.length).toBe(4);
  });
});

describe('M14.27 — Σ method.count = total_operations', () => {
  test('partition invariant', () => {
    const s = summarizeAdapterOperationsByMethod(NOW);
    const sum = s.methods.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(s.total_operations);
  });
});

describe('M14.27 — count per method matches manual catalog scan', () => {
  test('GET count matches the catalog manually', () => {
    const catalog = listAdapterOperationCatalog();
    let manualGet = 0;
    for (const group of catalog.adapters) {
      for (const op of group.operations) {
        if (op.method === 'GET') manualGet++;
      }
    }
    const s = summarizeAdapterOperationsByMethod(NOW);
    const getRow = s.methods.find((r) => r.method === 'GET')!;
    expect(getRow.count).toBe(manualGet);
  });
});

describe('M14.27 — by_adapter map', () => {
  test('only adapters with ≥1 operation in this method appear as keys', () => {
    const s = summarizeAdapterOperationsByMethod(NOW);
    const catalog = listAdapterOperationCatalog();
    for (const row of s.methods) {
      const keys = Object.keys(row.by_adapter);
      for (const adapterId of keys) {
        const group = catalog.adapters.find((g) => g.adapter_id === adapterId)!;
        const adapterMethodCount = group.operations.filter((o) => o.method === row.method).length;
        expect(adapterMethodCount).toBeGreaterThan(0);
        expect(row.by_adapter[adapterId as keyof typeof row.by_adapter]).toBe(adapterMethodCount);
      }
    }
  });

  test('Σ by_adapter per row = row.count', () => {
    const s = summarizeAdapterOperationsByMethod(NOW);
    for (const row of s.methods) {
      const sum = Object.values(row.by_adapter).reduce((a: number, b: number | undefined) => a + (b ?? 0), 0);
      expect(sum).toBe(row.count);
    }
  });
});

describe('M14.27 — distinct_adapters counter', () => {
  test('matches Object.keys(by_adapter).length per row', () => {
    const s = summarizeAdapterOperationsByMethod(NOW);
    for (const row of s.methods) {
      expect(row.distinct_adapters).toBe(Object.keys(row.by_adapter).length);
    }
  });
});

describe('M14.27 — sample_operations', () => {
  test('cap 5 + sorted adapter_id asc + path asc', () => {
    const s = summarizeAdapterOperationsByMethod(NOW);
    for (const row of s.methods) {
      expect(row.sample_operations.length).toBeLessThanOrEqual(5);
      for (let i = 1; i < row.sample_operations.length; i++) {
        const prev = row.sample_operations[i - 1]!;
        const curr = row.sample_operations[i]!;
        const cmp = prev.adapter_id.localeCompare(curr.adapter_id);
        if (cmp === 0) {
          expect(prev.path.localeCompare(curr.path)).toBeLessThanOrEqual(0);
        } else {
          expect(cmp).toBeLessThan(0);
        }
      }
    }
  });

  test('sample_operations carry adapter_id + operation_id + path', () => {
    const s = summarizeAdapterOperationsByMethod(NOW);
    const getRow = s.methods.find((r) => r.method === 'GET')!;
    expect(getRow.sample_operations.length).toBeGreaterThan(0);
    for (const sample of getRow.sample_operations) {
      expect(typeof sample.adapter_id).toBe('string');
      expect(typeof sample.operation_id).toBe('string');
      expect(typeof sample.path).toBe('string');
      expect(sample.adapter_id.length).toBeGreaterThan(0);
      expect(sample.path.length).toBeGreaterThan(0);
    }
  });
});

describe('M14.27 — most_common_method', () => {
  test('points at highest-count method', () => {
    const s = summarizeAdapterOperationsByMethod(NOW);
    const top = s.methods.reduce((a, b) => (a.count >= b.count ? a : b));
    expect(s.most_common_method).toBe(top.method);
  });

  test('non-null when catalog has operations', () => {
    const s = summarizeAdapterOperationsByMethod(NOW);
    expect(s.most_common_method).not.toBeNull();
  });
});

describe('M14.27 — unused_methods', () => {
  test('contains methods with count=0 in canonical order', () => {
    const s = summarizeAdapterOperationsByMethod(NOW);
    const expected = ALL_HTTP_METHODS.filter((m) => {
      const row = s.methods.find((r) => r.method === m)!;
      return row.count === 0;
    });
    expect(s.unused_methods).toEqual(expected);
  });
});

// ─── GET /v1/integrations/adapters/operations/method-distribution ────

describe('M14.27 — GET /v1/integrations/adapters/operations/method-distribution', () => {
  test('admin → 200 with populated rollup', async () => {
    const { app } = makeMethodApp('admin');
    const r = await request(app)
      .get('/v1/integrations/adapters/operations/method-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.methods.length).toBe(4);
    expect(r.body.body.total_operations).toBeGreaterThan(0);
    expect(r.body.body.most_common_method).not.toBeNull();
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeMethodApp('case_owner');
    const r = await request(app)
      .get('/v1/integrations/adapters/operations/method-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: same response across BIL ↔ BANK_DEMO', async () => {
    const { app } = makeMethodApp('admin');
    const bil = await request(app)
      .get('/v1/integrations/adapters/operations/method-distribution')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/integrations/adapters/operations/method-distribution')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.status).toBe(200);
    expect(bank.status).toBe(200);
    expect(bil.body.body.total_operations).toBe(bank.body.body.total_operations);
    expect(bil.body.body.most_common_method).toBe(bank.body.body.most_common_method);
  });

  test('M14.24 /v1/integrations/adapters/operations still works (sibling regression)', async () => {
    const { app } = makeMethodApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/operations').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
