// services/regulatory-svc/indicators/__tests__/insurance_catalog.test.ts
//
// T6 M4.1 — verify the BIL insurance KRI catalog shape + completeness.
//
// We do NOT enforce checkRegistryAgainstCatalog for the insurance catalog
// (compute fns ship later, alongside the BIL synthetic dataset). The
// invariants here are structural: 5 families, ≥3 indicators per family,
// every entry follows the same IndicatorDef shape as the banking catalog.

import request from 'supertest';
import { loadCatalogFor, loadInsuranceCatalog } from '../src/catalog';
import { makeApp } from '../src/server';

describe('BIL insurance catalog (T6 M4.1)', () => {
  test('loads via loadInsuranceCatalog()', () => {
    const cat = loadInsuranceCatalog();
    expect(cat.version).toBeDefined();
    expect(Array.isArray(cat.indicators)).toBe(true);
    expect(cat.indicators.length).toBeGreaterThanOrEqual(20);
    expect(cat.indicators.length).toBeLessThanOrEqual(40);
  });

  test('declares vertical=insurance so the catalog is self-identifying', () => {
    const cat = loadInsuranceCatalog() as { vertical?: string };
    expect(cat.vertical).toBe('insurance');
  });

  test('spans all 5 BIL families with ≥3 indicators each', () => {
    const cat = loadInsuranceCatalog();
    const familyCounts = new Map<string, number>();
    for (const ind of cat.indicators) {
      familyCounts.set(ind.family, (familyCounts.get(ind.family) ?? 0) + 1);
    }
    const families = Array.from(familyCounts.keys()).sort();
    expect(families).toEqual(['Agent', 'Claim', 'Customer', 'Operational', 'Policy']);
    for (const f of families) {
      expect(familyCounts.get(f)).toBeGreaterThanOrEqual(3);
    }
  });

  test('every indicator carries the standard IndicatorDef fields', () => {
    const cat = loadInsuranceCatalog();
    for (const ind of cat.indicators) {
      expect(typeof ind.id).toBe('string');
      expect(ind.id).toMatch(/^[A-Z]{3,7}(-INS)?-\d{3}$/);
      expect(typeof ind.name).toBe('string');
      expect(typeof ind.description).toBe('string');
      expect(typeof ind.formula_pseudocode).toBe('string');
      expect(typeof ind.window_days).toBe('number');
      expect(typeof ind.severity_weight).toBe('number');
      expect(ind.severity_weight).toBeGreaterThan(0);
      expect(ind.severity_weight).toBeLessThanOrEqual(1);
      expect(Array.isArray(ind.inputs)).toBe(true);
      expect(ind.inputs.length).toBeGreaterThan(0);
    }
  });

  test('id prefixes do not collide with banking catalog ids (FIN/BEH/TXN/CRD)', () => {
    const cat = loadInsuranceCatalog();
    for (const ind of cat.indicators) {
      const prefix = ind.id.split('-')[0]!;
      expect(['POL', 'CUS', 'AGT', 'CLM', 'OPS']).toContain(prefix);
    }
  });

  test('ids are unique within the catalog', () => {
    const cat = loadInsuranceCatalog();
    const ids = cat.indicators.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('loadCatalogFor(vertical) (T6 M4.1)', () => {
  test('default returns banking', () => {
    const cat = loadCatalogFor();
    // banking ids start with FIN/BEH/TXN/CRD; insurance with POL/CUS/AGT/CLM/OPS
    const prefix = cat.indicators[0]!.id.split('-')[0]!;
    expect(['FIN', 'BEH', 'TXN', 'CRD']).toContain(prefix);
  });

  test('insurance returns the BIL catalog', () => {
    const cat = loadCatalogFor('insurance');
    expect(cat.indicators[0]!.id).toMatch(/^(POL|CUS|AGT|CLM|OPS)-/);
  });
});

describe('GET /indicators/insurance + /indicators/by-vertical (T6 M4.1)', () => {
  test('GET /indicators/insurance returns the BIL catalog', async () => {
    const app = makeApp({ getRole: () => 'admin' });
    const r = await request(app).get('/indicators/insurance');
    expect(r.status).toBe(200);
    expect(r.body.vertical).toBe('insurance');
    expect(Array.isArray(r.body.indicators)).toBe(true);
    expect(r.body.indicators.length).toBeGreaterThanOrEqual(20);
  });

  test('GET /indicators/by-vertical?vertical=insurance returns BIL catalog', async () => {
    const app = makeApp({ getRole: () => 'admin' });
    const r = await request(app).get('/indicators/by-vertical?vertical=insurance');
    expect(r.status).toBe(200);
    expect(r.body.vertical).toBe('insurance');
  });

  test('GET /indicators/by-vertical?vertical=banking returns banking catalog', async () => {
    const app = makeApp({ getRole: () => 'admin' });
    const r = await request(app).get('/indicators/by-vertical?vertical=banking');
    expect(r.status).toBe(200);
    // Banking catalog also has indicators array; first id should be FIN/BEH/TXN/CRD
    const firstPrefix = r.body.indicators[0].id.split('-')[0];
    expect(['FIN', 'BEH', 'TXN', 'CRD']).toContain(firstPrefix);
  });

  test('GET /indicators/by-vertical with invalid vertical → 400', async () => {
    const app = makeApp({ getRole: () => 'admin' });
    const r = await request(app).get('/indicators/by-vertical?vertical=crypto');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/banking.*insurance/);
  });

  test('GET /indicators/by-vertical with no vertical defaults to banking', async () => {
    const app = makeApp({ getRole: () => 'admin' });
    const r = await request(app).get('/indicators/by-vertical');
    expect(r.status).toBe(200);
    const firstPrefix = r.body.indicators[0].id.split('-')[0];
    expect(['FIN', 'BEH', 'TXN', 'CRD']).toContain(firstPrefix);
  });
});
