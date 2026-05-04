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

  test('catalog spans the four expected families with non-trivial coverage', () => {
    const cat = loadCatalog();
    const fams = new Map<string, number>();
    for (const ind of cat.indicators) {
      const f = ind.id.split('-')[0];
      fams.set(f, (fams.get(f) ?? 0) + 1);
    }
    expect(new Set(fams.keys())).toEqual(new Set(['FIN', 'BEH', 'TXN', 'CRD']));
    // Each family should be non-trivial; the v1 catalog had ≥6 per family.
    for (const [, c] of fams) expect(c).toBeGreaterThanOrEqual(6);
    // Catalog size is documented in README; this anchors the snapshot but
    // is derived from the file rather than hardcoded so single-indicator
    // additions don't break the test.
    expect(cat.indicators.length).toBeGreaterThanOrEqual(30);
  });

  test('compute registry size matches catalog size (the real invariant)', () => {
    const cat = loadCatalog();
    expect(Object.keys(COMPUTE_REGISTRY)).toHaveLength(cat.indicators.length);
  });
});
