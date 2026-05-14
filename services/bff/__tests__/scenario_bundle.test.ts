// services/bff/__tests__/scenario_bundle.test.ts
//
// T6 M16.13 — Custom scenario preset bundle export/import.

import request from 'supertest';
import {
  SCENARIO_BUNDLE_MAX_ITEMS,
  SCENARIO_BUNDLE_SCHEMA_VERSION,
  ScenarioBundleError,
  exportScenarioBundle,
  importScenarioBundle,
  validateBundle,
  type ScenarioBundle,
} from '../src/scenario_bundle';
import { InMemoryCustomPresetStore } from '../src/scenario_custom';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function seedPreset(
  store: InMemoryCustomPresetStore,
  tenant: string,
  name: string,
) {
  return store.create(
    tenant,
    {
      name,
      description: `desc for ${name}`,
      category: 'business',
      regulator: 'INTERNAL',
      severity: 'moderate',
      shocks: { gdp: -0.02, rate: 0.01, fx: 0.05 },
    },
    'alice',
    NOW,
  );
}

// ─── validateBundle ──────────────────────────────────────────────────

describe('M16.13 — validateBundle', () => {
  test('rejects non-object', () => {
    expect(() => validateBundle(null)).toThrow(ScenarioBundleError);
  });

  test('rejects unsupported schema_version', () => {
    expect(() =>
      validateBundle({
        schema_version: '99',
        exported_at: NOW.toISOString(),
        exported_by: 'alice',
        source_tenant_id: 'BIL',
        items: [
          {
            name: 'X',
            description: '',
            category: 'business',
            regulator: 'INTERNAL',
            severity: 'mild',
            shocks: { gdp: 0, rate: 0, fx: 0 },
            source_doc: '',
          },
        ],
      }),
    ).toThrow(/expected schema_version/);
  });

  test('rejects empty items[]', () => {
    expect(() =>
      validateBundle({
        schema_version: SCENARIO_BUNDLE_SCHEMA_VERSION,
        exported_at: NOW.toISOString(),
        exported_by: 'alice',
        source_tenant_id: 'BIL',
        items: [],
      }),
    ).toThrow(/at least 1 item/);
  });

  test(`rejects items > ${SCENARIO_BUNDLE_MAX_ITEMS}`, () => {
    const items = Array.from({ length: SCENARIO_BUNDLE_MAX_ITEMS + 1 }, (_, i) => ({
      name: `p${i}`,
      description: '',
      category: 'business' as const,
      regulator: 'INTERNAL' as const,
      severity: 'mild' as const,
      shocks: { gdp: 0, rate: 0, fx: 0 },
      source_doc: '',
    }));
    expect(() =>
      validateBundle({
        schema_version: SCENARIO_BUNDLE_SCHEMA_VERSION,
        exported_at: NOW.toISOString(),
        exported_by: 'alice',
        source_tenant_id: 'BIL',
        items,
      }),
    ).toThrow(/> cap/);
  });

  test('rejects item missing shocks', () => {
    expect(() =>
      validateBundle({
        schema_version: SCENARIO_BUNDLE_SCHEMA_VERSION,
        exported_at: NOW.toISOString(),
        exported_by: 'alice',
        source_tenant_id: 'BIL',
        items: [{ name: 'X' }],
      }),
    ).toThrow(/shocks required/);
  });
});

// ─── exportScenarioBundle ────────────────────────────────────────────

describe('M16.13 — exportScenarioBundle', () => {
  test('returns versioned envelope with deep-copied items + identity stripped', () => {
    const store = new InMemoryCustomPresetStore();
    const a = seedPreset(store, 'BIL', 'Alpha');
    const b = seedPreset(store, 'BIL', 'Beta');
    const out = exportScenarioBundle(store, {
      tenant_id: 'BIL',
      preset_ids: [a.id, b.id],
      exported_by: 'alice',
      now: NOW,
    });
    expect(out.schema_version).toBe(SCENARIO_BUNDLE_SCHEMA_VERSION);
    expect(out.source_tenant_id).toBe('BIL');
    expect(out.items.map((i) => i.name)).toEqual(['Alpha', 'Beta']);
    // Identity stripped — no `id` on bundle items.
    expect((out.items[0] as unknown as Record<string, unknown>).id).toBeUndefined();
    // Deep copy: mutating bundle doesn't reach the live store.
    out.items[0]!.shocks.gdp = 999;
    expect(store.get('BIL', a.id)!.shocks.gdp).toBe(-0.02);
  });

  test('unknown preset_id → unknown_preset', () => {
    const store = new InMemoryCustomPresetStore();
    seedPreset(store, 'BIL', 'Alpha');
    expect(() =>
      exportScenarioBundle(store, {
        tenant_id: 'BIL',
        preset_ids: ['custom_does_not_exist'],
        exported_by: 'alice',
        now: NOW,
      }),
    ).toThrow(/unknown_preset|not found/);
  });

  test('duplicate preset_ids → invalid_input', () => {
    const store = new InMemoryCustomPresetStore();
    const a = seedPreset(store, 'BIL', 'Alpha');
    expect(() =>
      exportScenarioBundle(store, {
        tenant_id: 'BIL',
        preset_ids: [a.id, a.id],
        exported_by: 'alice',
        now: NOW,
      }),
    ).toThrow(/duplicate/);
  });

  test('empty preset_ids → invalid_input', () => {
    const store = new InMemoryCustomPresetStore();
    expect(() =>
      exportScenarioBundle(store, {
        tenant_id: 'BIL',
        preset_ids: [],
        exported_by: 'alice',
        now: NOW,
      }),
    ).toThrow(/non-empty/);
  });
});

// ─── importScenarioBundle ────────────────────────────────────────────

function exportTwo(): ScenarioBundle {
  const source = new InMemoryCustomPresetStore();
  const a = seedPreset(source, 'BIL', 'Alpha');
  const b = seedPreset(source, 'BIL', 'Beta');
  return exportScenarioBundle(source, {
    tenant_id: 'BIL',
    preset_ids: [a.id, b.id],
    exported_by: 'alice',
    now: NOW,
  });
}

describe('M16.13 — importScenarioBundle', () => {
  test('clean target → all created', () => {
    const bundle = exportTwo();
    const target = new InMemoryCustomPresetStore();
    const out = importScenarioBundle(target, {
      target_tenant_id: 'BIL_STAGING',
      bundle,
      imported_by: 'bob',
      now: NOW,
    });
    expect(out.created_count).toBe(2);
    expect(out.skipped_count).toBe(0);
    expect(out.error_count).toBe(0);
    expect(target.list('BIL_STAGING').map((p) => p.name).sort()).toEqual(['Alpha', 'Beta']);
  });

  test('name collision → skipped already_exists', () => {
    const bundle = exportTwo();
    const target = new InMemoryCustomPresetStore();
    seedPreset(target, 'BIL_STAGING', 'Alpha');
    const out = importScenarioBundle(target, {
      target_tenant_id: 'BIL_STAGING',
      bundle,
      imported_by: 'bob',
      now: NOW,
    });
    expect(out.created_count).toBe(1);
    expect(out.skipped_count).toBe(1);
    const skipped = out.rows.find((r) => r.status === 'skipped')!;
    expect(skipped.source_name).toBe('Alpha');
    expect(skipped.status === 'skipped' && skipped.reason).toMatch(/already_exists/);
  });

  test('name_prefix lets the same-tenant clone succeed', () => {
    const bundle = exportTwo();
    const target = new InMemoryCustomPresetStore();
    seedPreset(target, 'BIL', 'Alpha');
    seedPreset(target, 'BIL', 'Beta');
    const out = importScenarioBundle(target, {
      target_tenant_id: 'BIL',
      bundle,
      imported_by: 'bob',
      name_prefix: 'COPY — ',
      now: NOW,
    });
    expect(out.created_count).toBe(2);
    expect(target.list('BIL').map((p) => p.name).sort()).toEqual([
      'Alpha',
      'Beta',
      'COPY — Alpha',
      'COPY — Beta',
    ]);
  });

  test('intra-bundle duplicate names: second occurrence skipped against the first', () => {
    const source = new InMemoryCustomPresetStore();
    const a = seedPreset(source, 'BIL', 'Shared');
    const b = seedPreset(source, 'BIL', 'Other');
    const bundle = exportScenarioBundle(source, {
      tenant_id: 'BIL',
      preset_ids: [a.id, b.id],
      exported_by: 'alice',
      now: NOW,
    });
    bundle.items[1]!.name = 'Shared'; // both want the same target name
    const target = new InMemoryCustomPresetStore();
    const out = importScenarioBundle(target, {
      target_tenant_id: 'NEW',
      bundle,
      imported_by: 'bob',
      now: NOW,
    });
    expect(out.created_count).toBe(1);
    expect(out.skipped_count).toBe(1);
  });

  test('name_prefix > 24 chars → invalid_input', () => {
    const bundle = exportTwo();
    const target = new InMemoryCustomPresetStore();
    expect(() =>
      importScenarioBundle(target, {
        target_tenant_id: 'BIL',
        bundle,
        imported_by: 'bob',
        name_prefix: 'x'.repeat(25),
        now: NOW,
      }),
    ).toThrow(/name_prefix/);
  });
});

// ─── Routes: POST /v1/scenarios/library/custom/{export,import}-bundle ───

function makeBundleApp(role = 'admin') {
  const customPresetStore = new InMemoryCustomPresetStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    customPresetStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, customPresetStore };
}

describe('M16.13 — POST /v1/scenarios/library/custom/export-bundle', () => {
  test('export → 200 envelope', async () => {
    const { app, customPresetStore } = makeBundleApp('admin');
    const p = seedPreset(customPresetStore, 'BIL', 'Alpha');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/export-bundle')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ preset_ids: [p.id] });
    expect(r.status).toBe(200);
    expect(r.body.body.schema_version).toBe(SCENARIO_BUNDLE_SCHEMA_VERSION);
    expect(r.body.body.items[0].name).toBe('Alpha');
  });

  test('unknown preset_id → 404', async () => {
    const { app } = makeBundleApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/export-bundle')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ preset_ids: ['custom_does_not_exist'] });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBundleApp('case_owner');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/export-bundle')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ preset_ids: [] });
    expect(r.status).toBe(403);
  });
});

describe('M16.13 — POST /v1/scenarios/library/custom/import-bundle', () => {
  test('import → 200 with per-row outcomes', async () => {
    const source = new InMemoryCustomPresetStore();
    const a = seedPreset(source, 'BIL', 'Alpha');
    const bundle = exportScenarioBundle(source, {
      tenant_id: 'BIL',
      preset_ids: [a.id],
      exported_by: 'alice',
      now: NOW,
    });
    const { app, customPresetStore } = makeBundleApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/import-bundle')
      .set(TH_BIL)
      .set('x-apex-user', 'bob')
      .send({ bundle });
    expect(r.status).toBe(200);
    expect(r.body.body.created_count).toBe(1);
    expect(customPresetStore.list('BIL').map((p) => p.name)).toEqual(['Alpha']);
  });

  test('bad schema_version → 400', async () => {
    const { app } = makeBundleApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/import-bundle')
      .set(TH_BIL)
      .set('x-apex-user', 'bob')
      .send({
        bundle: {
          schema_version: '99',
          exported_at: NOW.toISOString(),
          exported_by: 'alice',
          source_tenant_id: 'BIL',
          items: [
            {
              name: 'X',
              description: '',
              category: 'business',
              regulator: 'INTERNAL',
              severity: 'mild',
              shocks: { gdp: 0, rate: 0, fx: 0 },
              source_doc: '',
            },
          ],
        },
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_unsupported_schema_version');
  });

  test('cross-tenant: imports land in caller tenant', async () => {
    const source = new InMemoryCustomPresetStore();
    const a = seedPreset(source, 'BIL', 'Alpha');
    const bundle = exportScenarioBundle(source, {
      tenant_id: 'BIL',
      preset_ids: [a.id],
      exported_by: 'alice',
      now: NOW,
    });
    const { app, customPresetStore } = makeBundleApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/import-bundle')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .set('x-apex-user', 'bob')
      .send({ bundle });
    expect(r.status).toBe(200);
    expect(customPresetStore.list('BIL').length).toBe(0);
    expect(customPresetStore.list('BANK_DEMO').length).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBundleApp('case_owner');
    const r = await request(app)
      .post('/v1/scenarios/library/custom/import-bundle')
      .set(TH_BIL)
      .set('x-apex-user', 'bob')
      .send({ bundle: {} });
    expect(r.status).toBe(403);
  });
});
