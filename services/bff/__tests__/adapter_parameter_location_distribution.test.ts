// services/bff/__tests__/adapter_parameter_location_distribution.test.ts
//
// T6 M14.30 — Adapter operation parameter `in` distribution.

import request from 'supertest';
import {
  summarizeAdapterParameterLocations,
  ALL_PARAMETER_LOCATIONS,
} from '../src/adapter_parameter_location_distribution';
import { listAdapterOperationCatalog } from '../src/adapter_operation_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makePlApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Pure resolver — envelope shape ──────────────────────────────────

describe('M14.30 — envelope shape', () => {
  test('exactly 3 locations in canonical order', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    expect(s.locations.length).toBe(3);
    expect(s.locations.map((l) => l.location)).toEqual([
      'path',
      'query',
      'body',
    ]);
  });

  test('generated_at echoed', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    expect(s.generated_at).toBe(NOW.toISOString());
  });

  test('total_operations matches catalog sum', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    const catalog = listAdapterOperationCatalog();
    const expected = catalog.adapters.reduce(
      (acc, g) => acc + g.operation_count,
      0,
    );
    expect(s.total_operations).toBe(expected);
  });

  test('total_parameters is Σ of catalog ops × parameters', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    const catalog = listAdapterOperationCatalog();
    let total = 0;
    for (const g of catalog.adapters) {
      for (const op of g.operations) {
        total += op.parameters.length;
      }
    }
    expect(s.total_parameters).toBe(total);
  });
});

// ─── Partition invariants ───────────────────────────────────────────

describe('M14.30 — partition invariants', () => {
  test('Σ row.count = total_parameters', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    const sum = s.locations.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(s.total_parameters);
  });

  test('required + optional = count per row', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    for (const r of s.locations) {
      expect(r.required_count + r.optional_count).toBe(r.count);
    }
  });

  test('Σ by_type per row = row.count', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    for (const r of s.locations) {
      const sum = Object.values(r.by_type).reduce((a, b) => a + b, 0);
      expect(sum).toBe(r.count);
    }
  });

  test('Σ by_adapter per row = row.count', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    for (const r of s.locations) {
      const sum = Object.values(r.by_adapter).reduce(
        (a, b) => a + (b ?? 0),
        0,
      );
      expect(sum).toBe(r.count);
    }
  });

  test('Σ by_method per row = row.count', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    for (const r of s.locations) {
      const sum = Object.values(r.by_method).reduce(
        (a, b) => a + (b ?? 0),
        0,
      );
      expect(sum).toBe(r.count);
    }
  });
});

// ─── Every-key-present invariants ────────────────────────────────────

describe('M14.30 — every-key-present per row', () => {
  test('every row by_type has all 4 ParameterType keys', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    for (const r of s.locations) {
      const keys = Object.keys(r.by_type).sort();
      expect(keys).toEqual(['datetime', 'enum', 'integer', 'string']);
    }
  });
});

// ─── by_adapter / by_method are compact ──────────────────────────────

describe('M14.30 — compact partial records', () => {
  test('by_adapter contains only adapters with > 0 in this location', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    for (const r of s.locations) {
      for (const v of Object.values(r.by_adapter)) {
        expect(v).toBeGreaterThan(0);
      }
      expect(r.distinct_adapters).toBe(Object.keys(r.by_adapter).length);
    }
  });

  test('by_method contains only methods with > 0 in this location', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    for (const r of s.locations) {
      for (const v of Object.values(r.by_method)) {
        expect(v).toBeGreaterThan(0);
      }
    }
  });
});

// ─── Sample shape ────────────────────────────────────────────────────

describe('M14.30 — sample_parameters', () => {
  test('every sample carries adapter_id + operation_id + parameter_name + type + required', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    for (const r of s.locations) {
      for (const sample of r.sample_parameters) {
        expect(typeof sample.adapter_id).toBe('string');
        expect(typeof sample.operation_id).toBe('string');
        expect(typeof sample.parameter_name).toBe('string');
        expect(typeof sample.parameter_type).toBe('string');
        expect(typeof sample.required).toBe('boolean');
      }
    }
  });

  test('sample_parameters capped at 5', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    for (const r of s.locations) {
      expect(r.sample_parameters.length).toBeLessThanOrEqual(5);
    }
  });

  test('sample order: adapter_id asc → operation_id asc → parameter_name asc', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    for (const r of s.locations) {
      for (let i = 1; i < r.sample_parameters.length; i++) {
        const prev = r.sample_parameters[i - 1];
        const curr = r.sample_parameters[i];
        const prevKey = `${prev.adapter_id}|${prev.operation_id}|${prev.parameter_name}`;
        const currKey = `${curr.adapter_id}|${curr.operation_id}|${curr.parameter_name}`;
        expect(prevKey <= currKey).toBe(true);
      }
    }
  });
});

// ─── Catalog cross-check ─────────────────────────────────────────────

describe('M14.30 — catalog cross-check', () => {
  test('path row has params matching path-typed catalog entries', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    const pathRow = s.locations.find((r) => r.location === 'path')!;

    // Count path-params via manual walk.
    let manualCount = 0;
    const catalog = listAdapterOperationCatalog();
    for (const g of catalog.adapters) {
      for (const op of g.operations) {
        for (const p of op.parameters) {
          if (p.in === 'path') manualCount++;
        }
      }
    }
    expect(pathRow.count).toBe(manualCount);
  });

  test('path-params should be required (URL pattern invariant — every :seg required)', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    const pathRow = s.locations.find((r) => r.location === 'path')!;
    expect(pathRow.required_count).toBe(pathRow.count);
    expect(pathRow.optional_count).toBe(0);
  });
});

// ─── Leaderboards ────────────────────────────────────────────────────

describe('M14.30 — most_common_location', () => {
  test('points at highest-count row', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    const top = s.locations.reduce((a, b) => (a.count >= b.count ? a : b));
    expect(s.most_common_location).toBe(top.location);
  });

  test('non-null when catalog has parameters', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    if (s.total_parameters > 0) {
      expect(s.most_common_location).not.toBeNull();
    }
  });
});

describe('M14.30 — unused_locations', () => {
  test('contains every count=0 location in canonical order', () => {
    const s = summarizeAdapterParameterLocations(NOW);
    const expected = ALL_PARAMETER_LOCATIONS.filter((loc) => {
      const row = s.locations.find((r) => r.location === loc)!;
      return row.count === 0;
    });
    expect(s.unused_locations).toEqual(expected);
  });
});

// ─── Route ───────────────────────────────────────────────────────────

describe('M14.30 — GET /v1/integrations/adapters/operations/location-distribution', () => {
  test('admin → 200 with populated rollup', async () => {
    const { app } = makePlApp('admin');
    const r = await request(app)
      .get('/v1/integrations/adapters/operations/location-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.locations.length).toBe(3);
    expect(r.body.body.total_parameters).toBeGreaterThan(0);
    expect(r.body.body.most_common_location).not.toBeNull();
  });

  test('non-allowed role → 403', async () => {
    const { app } = makePlApp('case_owner');
    const r = await request(app)
      .get('/v1/integrations/adapters/operations/location-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: same response across BIL ↔ BANK_DEMO', async () => {
    const { app } = makePlApp('admin');
    const bil = await request(app)
      .get('/v1/integrations/adapters/operations/location-distribution')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/integrations/adapters/operations/location-distribution')
      .set(TH_BANK);
    expect(bil.body.body.total_parameters).toBe(bank.body.body.total_parameters);
    expect(bil.body.body.most_common_location).toBe(
      bank.body.body.most_common_location,
    );
  });

  test('M14.27 method-distribution sibling regression still 200', async () => {
    const { app } = makePlApp('admin');
    const r = await request(app)
      .get('/v1/integrations/adapters/operations/method-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M14.24 /v1/integrations/adapters/operations sibling regression still 200', async () => {
    const { app } = makePlApp('admin');
    const r = await request(app)
      .get('/v1/integrations/adapters/operations')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
