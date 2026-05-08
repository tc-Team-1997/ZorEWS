// Registry-completeness gate. This test fails loud if a catalog id is missing
// a compute fn, or if the registry has stray keys that aren't in the catalog.

import { COMPUTE_REGISTRY } from '../src/compute';
import { checkRegistryAgainstCatalog, loadCatalog } from '../src/catalog';

describe('Compute registry vs catalog', () => {
  test('every catalog id has a registered compute fn', () => {
    const r = checkRegistryAgainstCatalog(COMPUTE_REGISTRY);
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error('registry mismatch', r);
    }
    expect(r.missing).toEqual([]);
    expect(r.extras).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test('catalog spans the five expected families with non-trivial coverage', () => {
    const cat = loadCatalog();
    const fams = new Map<string, number>();
    for (const ind of cat.indicators) {
      const f = ind.id.split('-')[0];
      fams.set(f, (fams.get(f) ?? 0) + 1);
    }
    // Fraud (FRD) added per BAC §3.5 — see T2.11.
    expect(new Set(fams.keys())).toEqual(new Set(['FIN', 'BEH', 'TXN', 'CRD', 'FRD']));
    // Original 4 had ≥6 each in v1; Fraud seeds at 4 and grows from there.
    expect(fams.get('FIN') ?? 0).toBeGreaterThanOrEqual(6);
    expect(fams.get('BEH') ?? 0).toBeGreaterThanOrEqual(6);
    expect(fams.get('TXN') ?? 0).toBeGreaterThanOrEqual(6);
    expect(fams.get('CRD') ?? 0).toBeGreaterThanOrEqual(6);
    expect(fams.get('FRD') ?? 0).toBeGreaterThanOrEqual(4);
    expect(cat.indicators.length).toBeGreaterThanOrEqual(30);
  });

  test('compute registry size matches catalog size (the real invariant)', () => {
    const cat = loadCatalog();
    expect(Object.keys(COMPUTE_REGISTRY)).toHaveLength(cat.indicators.length);
  });
});
