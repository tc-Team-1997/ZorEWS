// services/bff/__tests__/adapter_id_catalog.test.ts
//
// T6 M14.25 — Adapter entity ID format catalog.

import request from 'supertest';
import {
  listAdapterIdCatalog,
  buildPatternForTenant,
} from '../src/adapter_id_catalog';
import { listFleetAdapters } from '../src/adapter_health';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── listAdapterIdCatalog — pure ─────────────────────────────────────

describe('M14.25 — catalog shape', () => {
  test('covers every M14 adapter exactly once', () => {
    const c = listAdapterIdCatalog();
    const fleet = listFleetAdapters();
    const adapterIds = new Set(c.adapters.map((g) => g.adapter_id));
    expect(adapterIds.size).toBe(c.adapters.length);
    for (const a of fleet) {
      expect(adapterIds.has(a.adapter_id)).toBe(true);
    }
    expect(c.total_adapters).toBe(c.adapters.length);
  });

  test('total_entities = sum of per-adapter entity counts', () => {
    const c = listAdapterIdCatalog();
    const sum = c.adapters.reduce((acc, g) => acc + g.entities.length, 0);
    expect(c.total_entities).toBe(sum);
  });

  test('adapters sorted by adapter_id asc', () => {
    const c = listAdapterIdCatalog();
    const ids = c.adapters.map((g) => g.adapter_id);
    expect(ids).toEqual([...ids].sort());
  });

  test('every entity has the required fields populated', () => {
    const c = listAdapterIdCatalog();
    for (const g of c.adapters) {
      for (const e of g.entities) {
        expect(e.entity.length).toBeGreaterThan(0);
        expect(e.id_field.length).toBeGreaterThan(0);
        expect(e.pattern_template.length).toBeGreaterThan(0);
        expect(e.example.length).toBeGreaterThan(0);
        expect(e.description.length).toBeGreaterThan(0);
      }
    }
  });

  test('every adapter has at least one entity', () => {
    const c = listAdapterIdCatalog();
    for (const g of c.adapters) {
      expect(g.entities.length).toBeGreaterThan(0);
    }
  });

  test('pattern_template uses <TEN> placeholder for tenant slug', () => {
    const c = listAdapterIdCatalog();
    // Most patterns contain <TEN>; one exception (ifrs9 uses the
    // customer_id directly with no tenant slug). Verify at least 7 of
    // the 8 adapters use the placeholder.
    const withTenant = c.adapters.filter((g) =>
      g.entities.some((e) => e.pattern_template.includes('<TEN>')),
    );
    expect(withTenant.length).toBeGreaterThanOrEqual(7);
  });

  test('all_entities flat list matches adapters[]', () => {
    const c = listAdapterIdCatalog();
    const flat = c.adapters.flatMap((g) =>
      g.entities.map((e) => ({ adapter_id: g.adapter_id, entity: e.entity })),
    );
    const seen = new Set(flat.map((x) => `${x.adapter_id}.${x.entity}`));
    for (const e of c.all_entities) {
      expect(seen.has(`${e.adapter_id}.${e.entity}`)).toBe(true);
    }
    expect(c.all_entities.length).toBe(c.total_entities);
  });

  test('defensive copies: mutating the catalog does not pollute singleton', () => {
    const c1 = listAdapterIdCatalog();
    c1.adapters[0]!.entities.push({
      entity: 'injected',
      id_field: 'x',
      pattern_template: 'x',
      example: 'x',
      description: 'x',
    });
    const c2 = listAdapterIdCatalog();
    expect(c2.adapters[0]!.entities.find((e) => e.entity === 'injected')).toBeUndefined();
  });
});

// ─── buildPatternForTenant — pure ────────────────────────────────────

describe('M14.25 — buildPatternForTenant', () => {
  test('upper-case prefix patterns get upper-case tenant slug', () => {
    const re = buildPatternForTenant('^POL-<TEN>-\\d{6}$', 'BIL');
    expect(re.test('POL-BIL-123456')).toBe(true);
    expect(re.test('POL-bil-123456')).toBe(false);
  });

  test('lower-case prefix patterns get lower-case tenant slug', () => {
    const re = buildPatternForTenant('^dms-<TEN>-\\d{7}$', 'BIL');
    expect(re.test('dms-bil-1234567')).toBe(true);
    expect(re.test('dms-BIL-1234567')).toBe(false);
  });

  test('different tenants produce different patterns', () => {
    const reBIL = buildPatternForTenant('^POL-<TEN>-\\d{6}$', 'BIL');
    const reBANK = buildPatternForTenant('^POL-<TEN>-\\d{6}$', 'BANK_DEMO');
    expect(reBIL.source).not.toBe(reBANK.source);
    expect(reBIL.test('POL-BAN-123456')).toBe(false);
    expect(reBANK.test('POL-BAN-123456')).toBe(true);
  });

  test('every catalog example matches its own pattern after resolution', () => {
    const c = listAdapterIdCatalog();
    for (const g of c.adapters) {
      for (const e of g.entities) {
        // Examples are rendered for tenant slug 'BIL'.
        const re = buildPatternForTenant(e.pattern_template, 'BIL');
        expect(re.test(e.example)).toBe(true);
      }
    }
  });
});

// ─── GET /v1/integrations/adapters/id-catalog ────────────────────────

function makeIdCatalogApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M14.25 — GET /v1/integrations/adapters/id-catalog', () => {
  test('admin → 200 with full catalog', async () => {
    const { app } = makeIdCatalogApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/id-catalog').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_adapters).toBeGreaterThan(0);
    expect(r.body.body.adapters.length).toBe(r.body.body.total_adapters);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeIdCatalogApp('case_owner');
    const r = await request(app).get('/v1/integrations/adapters/id-catalog').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL and BANK_DEMO see the same catalog', async () => {
    const { app } = makeIdCatalogApp('admin');
    const bil = await request(app).get('/v1/integrations/adapters/id-catalog').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/integrations/adapters/id-catalog')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });

  test('M14.24 /v1/integrations/adapters/operations still works (sibling)', async () => {
    const { app } = makeIdCatalogApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/operations').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
