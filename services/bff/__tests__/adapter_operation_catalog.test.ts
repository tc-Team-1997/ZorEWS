// services/bff/__tests__/adapter_operation_catalog.test.ts
//
// T6 M14.24 — Adapter operation catalog.

import request from 'supertest';
import {
  listAdapterOperationCatalog,
  getAdapterOperations,
} from '../src/adapter_operation_catalog';
import { listFleetAdapters } from '../src/adapter_health';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── listAdapterOperationCatalog — pure ──────────────────────────────

describe('M14.24 — catalog shape', () => {
  test('every M14 adapter has at least one operation', () => {
    const cat = listAdapterOperationCatalog();
    expect(cat.total_adapters).toBe(8);
    for (const a of cat.adapters) {
      expect(a.operation_count).toBeGreaterThan(0);
      expect(a.operations.length).toBe(a.operation_count);
    }
  });

  test('total_operations equals sum of per-adapter operation_count', () => {
    const cat = listAdapterOperationCatalog();
    const sum = cat.adapters.reduce((acc, a) => acc + a.operation_count, 0);
    expect(cat.total_operations).toBe(sum);
  });

  test('every adapter id matches the M14.9 fleet roster', () => {
    const cat = listAdapterOperationCatalog();
    const fleet = listFleetAdapters();
    const fleetIds = new Set(fleet.map((a) => a.adapter_id));
    for (const a of cat.adapters) {
      expect(fleetIds.has(a.adapter_id)).toBe(true);
    }
    // Coverage: every fleet adapter has a catalog entry.
    const catIds = new Set(cat.adapters.map((a) => a.adapter_id));
    for (const f of fleet) {
      expect(catIds.has(f.adapter_id)).toBe(true);
    }
  });

  test('label + base_path match the fleet roster', () => {
    const cat = listAdapterOperationCatalog();
    const fleet = listFleetAdapters();
    const fleetById = new Map(fleet.map((f) => [f.adapter_id, f]));
    for (const a of cat.adapters) {
      const f = fleetById.get(a.adapter_id)!;
      expect(a.label).toBe(f.label);
      expect(a.base_path).toBe(f.base_path);
    }
  });

  test('every operation has the required fields populated', () => {
    const cat = listAdapterOperationCatalog();
    for (const a of cat.adapters) {
      for (const op of a.operations) {
        expect(op.operation_id.length).toBeGreaterThan(0);
        expect(['GET', 'POST', 'PATCH', 'DELETE']).toContain(op.method);
        expect(op.path.length).toBeGreaterThan(0);
        expect(op.description.length).toBeGreaterThan(0);
        expect(Array.isArray(op.parameters)).toBe(true);
      }
    }
  });

  test('every operation path begins with the adapter base_path', () => {
    const cat = listAdapterOperationCatalog();
    for (const a of cat.adapters) {
      for (const op of a.operations) {
        expect(op.path.startsWith(a.base_path)).toBe(true);
      }
    }
  });

  test('every parameter has well-formed shape', () => {
    const cat = listAdapterOperationCatalog();
    for (const a of cat.adapters) {
      for (const op of a.operations) {
        for (const p of op.parameters) {
          expect(p.name.length).toBeGreaterThan(0);
          expect(['query', 'path', 'body']).toContain(p.in);
          expect(['string', 'integer', 'datetime', 'enum']).toContain(p.type);
          expect(typeof p.required).toBe('boolean');
          expect(p.description.length).toBeGreaterThan(0);
          if (p.type === 'enum') {
            expect(p.enum_values).toBeDefined();
            expect(p.enum_values!.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  test('path parameters declared in the URL pattern are required', () => {
    const cat = listAdapterOperationCatalog();
    for (const a of cat.adapters) {
      for (const op of a.operations) {
        const pathParams = op.path.match(/:[a-z_]+/gi) ?? [];
        for (const segment of pathParams) {
          const name = segment.slice(1); // drop ':'
          const param = op.parameters.find((p) => p.name === name);
          expect(param).toBeDefined();
          expect(param!.in).toBe('path');
          expect(param!.required).toBe(true);
        }
      }
    }
  });

  test('operation_ids unique within an adapter group', () => {
    const cat = listAdapterOperationCatalog();
    for (const a of cat.adapters) {
      const ids = a.operations.map((op) => op.operation_id);
      expect(ids.length).toBe(new Set(ids).size);
    }
  });

  test('most_capable_adapter points at the adapter with the highest operation_count', () => {
    const cat = listAdapterOperationCatalog();
    const max = Math.max(...cat.adapters.map((a) => a.operation_count));
    expect(cat.most_capable_adapter.operation_count).toBe(max);
    const matched = cat.adapters.find((a) => a.adapter_id === cat.most_capable_adapter.adapter_id)!;
    expect(matched.operation_count).toBe(max);
  });

  test('defensive copies: mutating parameters does not pollute singleton', () => {
    const cat1 = listAdapterOperationCatalog();
    cat1.adapters[0]!.operations[0]!.parameters.push({
      name: 'injected',
      in: 'query',
      type: 'string',
      required: false,
      description: 'should not survive',
    });
    const cat2 = listAdapterOperationCatalog();
    const found = cat2.adapters[0]!.operations[0]!.parameters.find((p) => p.name === 'injected');
    expect(found).toBeUndefined();
  });
});

describe('M14.24 — getAdapterOperations', () => {
  test('known adapter → group', () => {
    const g = getAdapterOperations('insurance')!;
    expect(g.adapter_id).toBe('insurance');
    expect(g.operations.length).toBeGreaterThan(0);
  });

  test('unknown adapter → null', () => {
    expect(getAdapterOperations('not-an-adapter')).toBeNull();
  });
});

// ─── GET /v1/integrations/adapters/operations ────────────────────────

function makeOpApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M14.24 — GET /v1/integrations/adapters/operations', () => {
  test('admin → 200 with full catalog', async () => {
    const { app } = makeOpApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/operations').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_adapters).toBe(8);
    expect(r.body.body.total_operations).toBeGreaterThan(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeOpApp('case_owner');
    const r = await request(app).get('/v1/integrations/adapters/operations').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL and BANK_DEMO see the same catalog', async () => {
    const { app } = makeOpApp('admin');
    const bil = await request(app).get('/v1/integrations/adapters/operations').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/integrations/adapters/operations')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });

  test('M14.9 /v1/integrations/adapters still works (sibling route)', async () => {
    const { app } = makeOpApp('admin');
    const r = await request(app).get('/v1/integrations/adapters').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M14.23 /v1/integrations/adapters/sla-catalog still works (sibling route)', async () => {
    const { app } = makeOpApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/sla-catalog').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
