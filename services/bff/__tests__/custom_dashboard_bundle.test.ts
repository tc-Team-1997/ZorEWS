// services/bff/__tests__/custom_dashboard_bundle.test.ts
//
// T6 M11.9 — Custom dashboard export/import bundle.

import request from 'supertest';
import {
  DASHBOARD_BUNDLE_MAX_ITEMS,
  DASHBOARD_BUNDLE_SCHEMA_VERSION,
  DashboardBundleError,
  exportDashboardBundle,
  importDashboardBundle,
  validateBundle,
  type DashboardBundle,
} from '../src/custom_dashboard_bundle';
import {
  InMemoryCustomDashboardStore,
  type DashboardWidget,
} from '../src/custom_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkWidget(o: Partial<DashboardWidget> = {}): DashboardWidget {
  return {
    widget_type: o.widget_type ?? 'alerts_by_class',
    position: o.position ?? { row: 0, col: 0 },
    span: o.span ?? { rows: 1, cols: 6 },
    config: o.config ?? { since_hours: 24 },
  };
}

function seedDashboard(
  store: InMemoryCustomDashboardStore,
  tenant: string,
  name: string,
) {
  return store.create(
    tenant,
    { name, description: `desc for ${name}`, widgets: [mkWidget()] },
    'alice',
    NOW,
  );
}

// ─── validateBundle ────────────────────────────────────────────────────

describe('M11.9 — validateBundle', () => {
  test('rejects non-object input', () => {
    expect(() => validateBundle(null)).toThrow(DashboardBundleError);
    expect(() => validateBundle('not a bundle')).toThrow(DashboardBundleError);
  });

  test('rejects unsupported schema_version', () => {
    expect(() =>
      validateBundle({
        schema_version: '99',
        exported_at: NOW.toISOString(),
        exported_by: 'alice',
        source_tenant_id: 'BIL',
        items: [{ name: 'x', description: '', widgets: [mkWidget()] }],
      }),
    ).toThrow(/unsupported_schema_version|schema_version/);
  });

  test('rejects empty items[]', () => {
    expect(() =>
      validateBundle({
        schema_version: DASHBOARD_BUNDLE_SCHEMA_VERSION,
        exported_at: NOW.toISOString(),
        exported_by: 'alice',
        source_tenant_id: 'BIL',
        items: [],
      }),
    ).toThrow(/at least 1 item/);
  });

  test('rejects items overflow cap', () => {
    const items = Array.from({ length: DASHBOARD_BUNDLE_MAX_ITEMS + 1 }, (_, i) => ({
      name: `d${i}`,
      description: '',
      widgets: [mkWidget()],
    }));
    expect(() =>
      validateBundle({
        schema_version: DASHBOARD_BUNDLE_SCHEMA_VERSION,
        exported_at: NOW.toISOString(),
        exported_by: 'alice',
        source_tenant_id: 'BIL',
        items,
      }),
    ).toThrow(/> cap/);
  });

  test('rejects item without widgets', () => {
    expect(() =>
      validateBundle({
        schema_version: DASHBOARD_BUNDLE_SCHEMA_VERSION,
        exported_at: NOW.toISOString(),
        exported_by: 'alice',
        source_tenant_id: 'BIL',
        items: [{ name: 'x', description: '', widgets: [] }],
      }),
    ).toThrow(/widgets must be a non-empty array/);
  });
});

// ─── exportDashboardBundle ────────────────────────────────────────────

describe('M11.9 — exportDashboardBundle', () => {
  test('returns versioned envelope with deep-copied items', () => {
    const store = new InMemoryCustomDashboardStore();
    const d1 = seedDashboard(store, 'BIL', 'Alpha');
    const d2 = seedDashboard(store, 'BIL', 'Beta');
    const out = exportDashboardBundle(store, {
      tenant_id: 'BIL',
      dashboard_ids: [d1.dashboard_id, d2.dashboard_id],
      exported_by: 'alice',
      now: NOW,
    });
    expect(out.schema_version).toBe(DASHBOARD_BUNDLE_SCHEMA_VERSION);
    expect(out.source_tenant_id).toBe('BIL');
    expect(out.items.map((i) => i.name)).toEqual(['Alpha', 'Beta']);
    // Items are bundle-shape (no dashboard_id / tenant_id leaked).
    expect((out.items[0] as unknown as Record<string, unknown>).dashboard_id).toBeUndefined();
    expect((out.items[0] as unknown as Record<string, unknown>).tenant_id).toBeUndefined();
    // Deep copy: mutating the bundle doesn't reach the live store.
    out.items[0]!.widgets[0]!.config = { since_hours: 999 };
    const live = store.get('BIL', d1.dashboard_id)!;
    expect(live.widgets[0]!.config).toEqual({ since_hours: 24 });
  });

  test('unknown dashboard_id → unknown_dashboard', () => {
    const store = new InMemoryCustomDashboardStore();
    seedDashboard(store, 'BIL', 'Alpha');
    expect(() =>
      exportDashboardBundle(store, {
        tenant_id: 'BIL',
        dashboard_ids: ['dsh-does-not-exist'],
        exported_by: 'alice',
        now: NOW,
      }),
    ).toThrow(/unknown_dashboard|not found/);
  });

  test('duplicate dashboard_ids → invalid_input', () => {
    const store = new InMemoryCustomDashboardStore();
    const d1 = seedDashboard(store, 'BIL', 'Alpha');
    expect(() =>
      exportDashboardBundle(store, {
        tenant_id: 'BIL',
        dashboard_ids: [d1.dashboard_id, d1.dashboard_id],
        exported_by: 'alice',
        now: NOW,
      }),
    ).toThrow(/duplicate/);
  });

  test('empty dashboard_ids → invalid_input', () => {
    const store = new InMemoryCustomDashboardStore();
    expect(() =>
      exportDashboardBundle(store, {
        tenant_id: 'BIL',
        dashboard_ids: [],
        exported_by: 'alice',
        now: NOW,
      }),
    ).toThrow(/non-empty/);
  });
});

// ─── importDashboardBundle ────────────────────────────────────────────

function exportTwoItems(): DashboardBundle {
  const source = new InMemoryCustomDashboardStore();
  const a = seedDashboard(source, 'BIL', 'Alpha');
  const b = seedDashboard(source, 'BIL', 'Beta');
  return exportDashboardBundle(source, {
    tenant_id: 'BIL',
    dashboard_ids: [a.dashboard_id, b.dashboard_id],
    exported_by: 'alice',
    now: NOW,
  });
}

describe('M11.9 — importDashboardBundle', () => {
  test('imports bundle into a clean target tenant', () => {
    const bundle = exportTwoItems();
    const target = new InMemoryCustomDashboardStore();
    const out = importDashboardBundle(target, {
      target_tenant_id: 'BIL_STAGING',
      bundle,
      imported_by: 'bob',
      now: NOW,
    });
    expect(out.created_count).toBe(2);
    expect(out.skipped_count).toBe(0);
    expect(out.error_count).toBe(0);
    expect(target.list('BIL_STAGING').map((d) => d.name).sort()).toEqual(['Alpha', 'Beta']);
  });

  test('name collision → skipped already_exists', () => {
    const bundle = exportTwoItems();
    const target = new InMemoryCustomDashboardStore();
    // Pre-seed a name collision.
    seedDashboard(target, 'BIL_STAGING', 'Alpha');
    const out = importDashboardBundle(target, {
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

  test('name_prefix sidesteps same-tenant collisions', () => {
    const bundle = exportTwoItems();
    const target = new InMemoryCustomDashboardStore();
    seedDashboard(target, 'BIL', 'Alpha');
    seedDashboard(target, 'BIL', 'Beta');
    const out = importDashboardBundle(target, {
      target_tenant_id: 'BIL',
      bundle,
      imported_by: 'bob',
      name_prefix: 'COPY — ',
      now: NOW,
    });
    expect(out.created_count).toBe(2);
    expect(target.list('BIL').map((d) => d.name).sort()).toEqual([
      'Alpha',
      'Beta',
      'COPY — Alpha',
      'COPY — Beta',
    ]);
  });

  test('intra-bundle duplicate names dedup against earlier created sibling', () => {
    const source = new InMemoryCustomDashboardStore();
    const a = seedDashboard(source, 'BIL', 'Shared');
    const b = seedDashboard(source, 'BIL', 'Other');
    const bundle = exportDashboardBundle(source, {
      tenant_id: 'BIL',
      dashboard_ids: [a.dashboard_id, b.dashboard_id],
      exported_by: 'alice',
      now: NOW,
    });
    // Mutate the bundle so both items share the same target name.
    bundle.items[1]!.name = 'Shared';
    const target = new InMemoryCustomDashboardStore();
    const out = importDashboardBundle(target, {
      target_tenant_id: 'NEW',
      bundle,
      imported_by: 'bob',
      now: NOW,
    });
    expect(out.created_count).toBe(1);
    expect(out.skipped_count).toBe(1);
  });

  test('cap-reached → error row, not crash', () => {
    const bundle = exportTwoItems();
    const target = new InMemoryCustomDashboardStore();
    // Fill the target to its 10-cap with placeholders.
    for (let i = 0; i < 10; i++) seedDashboard(target, 'FULL', `Placeholder ${i}`);
    const out = importDashboardBundle(target, {
      target_tenant_id: 'FULL',
      bundle,
      imported_by: 'bob',
      now: NOW,
    });
    // Both rows fail with cap_reached (DashboardError, code captured).
    expect(out.error_count).toBe(2);
    expect(out.rows.every((r) => r.status === 'error')).toBe(true);
    const errorRow = out.rows[0];
    expect(errorRow!.status === 'error' && errorRow!.reason).toMatch(/cap_reached/);
  });

  test('name_prefix > 24 chars → invalid_input', () => {
    const bundle = exportTwoItems();
    const target = new InMemoryCustomDashboardStore();
    expect(() =>
      importDashboardBundle(target, {
        target_tenant_id: 'BIL',
        bundle,
        imported_by: 'bob',
        name_prefix: 'x'.repeat(25),
        now: NOW,
      }),
    ).toThrow(/name_prefix/);
  });
});

// ─── Routes: POST /v1/dashboards/custom/export + import ──────────────

function makeBundleApp(role = 'admin', store?: InMemoryCustomDashboardStore) {
  const customDashboardStore = store ?? new InMemoryCustomDashboardStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    customDashboardStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, customDashboardStore };
}

describe('M11.9 — POST /v1/dashboards/custom/export', () => {
  test('export → 200 with versioned envelope', async () => {
    const store = new InMemoryCustomDashboardStore();
    const d = seedDashboard(store, 'BIL', 'Alpha');
    const { app } = makeBundleApp('admin', store);
    const r = await request(app)
      .post('/v1/dashboards/custom/export')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ dashboard_ids: [d.dashboard_id] });
    expect(r.status).toBe(200);
    expect(r.body.body.schema_version).toBe(DASHBOARD_BUNDLE_SCHEMA_VERSION);
    expect(r.body.body.items[0].name).toBe('Alpha');
  });

  test('unknown dashboard_id → 404', async () => {
    const { app } = makeBundleApp('admin');
    const r = await request(app)
      .post('/v1/dashboards/custom/export')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ dashboard_ids: ['dsh-nope'] });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_dashboard');
  });

  test('empty dashboard_ids → 400', async () => {
    const { app } = makeBundleApp('admin');
    const r = await request(app)
      .post('/v1/dashboards/custom/export')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ dashboard_ids: [] });
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBundleApp('case_owner');
    const r = await request(app)
      .post('/v1/dashboards/custom/export')
      .set(TH_BIL)
      .set('x-apex-user', 'alice')
      .send({ dashboard_ids: [] });
    expect(r.status).toBe(403);
  });
});

describe('M11.9 — POST /v1/dashboards/custom/import', () => {
  test('import → 200 with per-row outcomes', async () => {
    const source = new InMemoryCustomDashboardStore();
    const d1 = seedDashboard(source, 'BIL', 'Alpha');
    const bundle = exportDashboardBundle(source, {
      tenant_id: 'BIL',
      dashboard_ids: [d1.dashboard_id],
      exported_by: 'alice',
      now: NOW,
    });
    const target = new InMemoryCustomDashboardStore();
    const { app } = makeBundleApp('admin', target);
    const r = await request(app)
      .post('/v1/dashboards/custom/import')
      .set(TH_BIL)
      .set('x-apex-user', 'bob')
      .send({ bundle });
    expect(r.status).toBe(200);
    expect(r.body.body.created_count).toBe(1);
    expect(target.list('BIL').map((d) => d.name)).toEqual(['Alpha']);
  });

  test('bad schema_version → 400', async () => {
    const { app } = makeBundleApp('admin');
    const r = await request(app)
      .post('/v1/dashboards/custom/import')
      .set(TH_BIL)
      .set('x-apex-user', 'bob')
      .send({
        bundle: {
          schema_version: '99',
          exported_at: NOW.toISOString(),
          exported_by: 'alice',
          source_tenant_id: 'BIL',
          items: [{ name: 'X', description: '', widgets: [mkWidget()] }],
        },
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_unsupported_schema_version');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBundleApp('case_owner');
    const r = await request(app)
      .post('/v1/dashboards/custom/import')
      .set(TH_BIL)
      .set('x-apex-user', 'bob')
      .send({ bundle: {} });
    expect(r.status).toBe(403);
  });

  test('cross-tenant: imports land in caller tenant only', async () => {
    const source = new InMemoryCustomDashboardStore();
    const d = seedDashboard(source, 'BIL', 'Alpha');
    const bundle = exportDashboardBundle(source, {
      tenant_id: 'BIL',
      dashboard_ids: [d.dashboard_id],
      exported_by: 'alice',
      now: NOW,
    });
    const target = new InMemoryCustomDashboardStore();
    const { app } = makeBundleApp('admin', target);
    const r = await request(app)
      .post('/v1/dashboards/custom/import')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .set('x-apex-user', 'bob')
      .send({ bundle });
    expect(r.status).toBe(200);
    expect(target.list('BIL').length).toBe(0);
    expect(target.list('BANK_DEMO').length).toBe(1);
  });
});
