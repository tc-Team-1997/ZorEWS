// services/bff/__tests__/adapter_parameter_name_index.test.ts
//
// T6 M14.31 — Adapter operation parameter-name cross-index.

import request from 'supertest';
import { buildAdapterParameterNameIndex } from '../src/adapter_parameter_name_index';
import { listAdapterOperationCatalog } from '../src/adapter_operation_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-28T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

const ALL_TYPES = ['string', 'integer', 'datetime', 'enum'] as const;
const ALL_LOCS = ['path', 'query', 'body'] as const;

function makeApp_(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

/** Manual count of total parameters across the real catalog. */
function catalogParamTotal(): number {
  let n = 0;
  for (const g of listAdapterOperationCatalog().adapters) {
    for (const op of g.operations) n += op.parameters.length;
  }
  return n;
}

// ─── Pure resolver (real platform catalog) ───────────────────────────────

describe('M14.31 — buildAdapterParameterNameIndex', () => {
  test('envelope shape + generated_at echo', () => {
    const idx = buildAdapterParameterNameIndex(NOW);
    expect(idx.generated_at).toBe(NOW.toISOString());
    expect(idx.total_distinct_names).toBe(idx.names.length);
    expect(idx.total_operations).toBe(listAdapterOperationCatalog().total_operations);
    expect(idx.total_parameters).toBe(catalogParamTotal());
    expect(idx.total_distinct_names).toBeGreaterThan(0);
  });

  test('Σ reference_count = total_parameters partition invariant', () => {
    const idx = buildAdapterParameterNameIndex(NOW);
    const sum = idx.names.reduce((a, e) => a + e.reference_count, 0);
    expect(sum).toBe(idx.total_parameters);
  });

  test('names sorted by reference_count desc + name asc tie-break', () => {
    const idx = buildAdapterParameterNameIndex(NOW);
    for (let i = 1; i < idx.names.length; i++) {
      const prev = idx.names[i - 1];
      const cur = idx.names[i];
      if (prev.reference_count === cur.reference_count) {
        expect(prev.name.localeCompare(cur.name)).toBeLessThanOrEqual(0);
      } else {
        expect(prev.reference_count).toBeGreaterThan(cur.reference_count);
      }
    }
  });

  test('per-entry: reference_count = occurrences.length', () => {
    const idx = buildAdapterParameterNameIndex(NOW);
    for (const e of idx.names) {
      expect(e.reference_count).toBe(e.occurrences.length);
    }
  });

  test('observed_types = distinct occurrence types in canonical order', () => {
    const idx = buildAdapterParameterNameIndex(NOW);
    for (const e of idx.names) {
      const distinct = ALL_TYPES.filter((t) => e.occurrences.some((o) => o.type === t));
      expect(e.observed_types).toEqual(distinct);
    }
  });

  test('observed_locations = distinct occurrence locations in canonical order', () => {
    const idx = buildAdapterParameterNameIndex(NOW);
    for (const e of idx.names) {
      const distinct = ALL_LOCS.filter((l) => e.occurrences.some((o) => o.in === l));
      expect(e.observed_locations).toEqual(distinct);
    }
  });

  test('adapters = distinct occurrence adapter_ids sorted asc', () => {
    const idx = buildAdapterParameterNameIndex(NOW);
    for (const e of idx.names) {
      const distinct = [...new Set(e.occurrences.map((o) => o.adapter_id))].sort((a, z) =>
        a.localeCompare(z),
      );
      expect(e.adapters).toEqual(distinct);
    }
  });

  test('occurrences sorted by adapter_id asc + operation_id asc', () => {
    const idx = buildAdapterParameterNameIndex(NOW);
    for (const e of idx.names) {
      for (let i = 1; i < e.occurrences.length; i++) {
        const prev = e.occurrences[i - 1];
        const cur = e.occurrences[i];
        const cmp =
          prev.adapter_id.localeCompare(cur.adapter_id) ||
          prev.operation_id.localeCompare(cur.operation_id);
        expect(cmp).toBeLessThanOrEqual(0);
      }
    }
  });

  test('has_type_drift ⟺ observed_types.length > 1 (logical invariant)', () => {
    const idx = buildAdapterParameterNameIndex(NOW);
    for (const e of idx.names) {
      expect(e.has_type_drift).toBe(e.observed_types.length > 1);
      expect(e.has_location_drift).toBe(e.observed_locations.length > 1);
    }
  });

  test('shared_names = reference_count > 1; single_use_names = exactly 1; disjoint + cover all', () => {
    const idx = buildAdapterParameterNameIndex(NOW);
    const sharedExpected = idx.names
      .filter((e) => e.reference_count > 1)
      .map((e) => e.name)
      .sort((a, z) => a.localeCompare(z));
    const singleExpected = idx.names
      .filter((e) => e.reference_count === 1)
      .map((e) => e.name)
      .sort((a, z) => a.localeCompare(z));
    expect(idx.shared_names).toEqual(sharedExpected);
    expect(idx.single_use_names).toEqual(singleExpected);
    // disjoint
    expect(idx.shared_names.filter((n) => idx.single_use_names.includes(n))).toEqual([]);
    // cover all distinct names
    expect(idx.shared_names.length + idx.single_use_names.length).toBe(
      idx.total_distinct_names,
    );
  });

  test('drifting_names = names with type OR location drift, sorted asc', () => {
    const idx = buildAdapterParameterNameIndex(NOW);
    const expected = idx.names
      .filter((e) => e.has_type_drift || e.has_location_drift)
      .map((e) => e.name)
      .sort((a, z) => a.localeCompare(z));
    expect(idx.drifting_names).toEqual(expected);
    // every drifting name actually drifts
    for (const n of idx.drifting_names) {
      const e = idx.names.find((x) => x.name === n)!;
      expect(e.has_type_drift || e.has_location_drift).toBe(true);
    }
  });

  test('most_shared_name = top entry by reference_count', () => {
    const idx = buildAdapterParameterNameIndex(NOW);
    expect(idx.most_shared_name).not.toBeNull();
    expect(idx.most_shared_name!.name).toBe(idx.names[0].name);
    expect(idx.most_shared_name!.reference_count).toBe(idx.names[0].reference_count);
    // it is a maximum
    for (const e of idx.names) {
      expect(e.reference_count).toBeLessThanOrEqual(idx.most_shared_name!.reference_count);
    }
  });

  test('customer_id spot-check: most-shared, all string (no type drift), but location drift across path/query/body', () => {
    const idx = buildAdapterParameterNameIndex(NOW);
    const cust = idx.names.find((e) => e.name === 'customer_id');
    expect(cust).toBeDefined();
    // customer_id is the most-shared parameter name in the catalog
    expect(cust!.reference_count).toBeGreaterThanOrEqual(2);
    // every adapter agrees it's a string → no TYPE drift
    expect(cust!.observed_types).toEqual(['string']);
    expect(cust!.has_type_drift).toBe(false);
    // but adapters disagree on WHERE it lives (path vs query vs body) →
    // LOCATION drift — exactly the contract-consistency finding M14.31
    // is built to surface. observed_locations stays in canonical order.
    expect(cust!.observed_locations.length).toBeGreaterThan(1);
    expect(cust!.has_location_drift).toBe(true);
    const idxOf = (l: string) => ALL_LOCS.indexOf(l as never);
    const positions = cust!.observed_locations.map(idxOf);
    expect(positions).toEqual([...positions].sort((a, b) => a - b)); // canonical order
    // surfaces in BOTH shared_names and drifting_names; never single_use
    expect(idx.shared_names).toContain('customer_id');
    expect(idx.drifting_names).toContain('customer_id');
    expect(idx.single_use_names).not.toContain('customer_id');
  });

  test('platform-static (different now → same names + counts)', () => {
    const a = buildAdapterParameterNameIndex(NOW);
    const b = buildAdapterParameterNameIndex(new Date('2027-01-01T00:00:00.000Z'));
    expect(b.total_parameters).toBe(a.total_parameters);
    expect(b.total_distinct_names).toBe(a.total_distinct_names);
    expect(b.names.map((e) => e.name)).toEqual(a.names.map((e) => e.name));
    expect(b.most_shared_name).toEqual(a.most_shared_name);
  });
});

// ─── HTTP route ──────────────────────────────────────────────────────────

describe('M14.31 — GET /v1/integrations/adapters/operations/param-name-index', () => {
  test('admin → 200 with index shape', async () => {
    const { app } = makeApp_('admin');
    const r = await request(app)
      .get('/v1/integrations/adapters/operations/param-name-index')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_distinct_names).toBeGreaterThan(0);
    expect(Array.isArray(r.body.body.names)).toBe(true);
    expect(r.body.body.most_shared_name).not.toBeNull();
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeApp_('case_owner');
    const r = await request(app)
      .get('/v1/integrations/adapters/operations/param-name-index')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static across BIL ↔ BANK_DEMO', async () => {
    const { app } = makeApp_('admin');
    const bil = await request(app)
      .get('/v1/integrations/adapters/operations/param-name-index')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/integrations/adapters/operations/param-name-index')
      .set(TH_BANK);
    expect(bil.body.body.total_parameters).toBe(bank.body.body.total_parameters);
    expect(bil.body.body.most_shared_name).toEqual(bank.body.body.most_shared_name);
  });

  test('M14.30 /location-distribution sibling regression still 200', async () => {
    const { app } = makeApp_('admin');
    const r = await request(app)
      .get('/v1/integrations/adapters/operations/location-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M14.27 /method-distribution sibling regression still 200', async () => {
    const { app } = makeApp_('admin');
    const r = await request(app)
      .get('/v1/integrations/adapters/operations/method-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
