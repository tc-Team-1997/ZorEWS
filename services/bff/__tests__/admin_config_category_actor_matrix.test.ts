// services/bff/__tests__/admin_config_category_actor_matrix.test.ts
//
// T6 M13.17 — Config override category × actor cross-tab matrix.

import request from 'supertest';
import { buildConfigCategoryActorMatrix } from '../src/admin_config_category_actor_matrix';
import {
  listCategories,
  InMemoryConfigStore,
  type ConfigCategory,
  type ConfigEntry,
  type ConfigStore,
} from '../src/admin_config';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeTestApp(role: string = 'admin', configStore?: ConfigStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    configStore,
  });
}

function makeEntry(
  key: string,
  category: ConfigCategory,
  updated_by: string | null,
): ConfigEntry {
  return {
    key,
    category,
    type: 'number',
    description: 'test',
    default_value: 1,
    value: 2,
    is_default: updated_by === null,
    updated_at: updated_by === null ? null : NOW.toISOString(),
    updated_by,
  };
}

// ─── Pure resolver ─────────────────────────────────────────────────────

describe('M13.17 — buildConfigCategoryActorMatrix', () => {
  test('empty input → empty matrix', () => {
    const m = buildConfigCategoryActorMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.total_overrides).toBe(0);
    expect(m.total_actors).toBe(0);
    expect(m.actors).toEqual([]);
    expect(m.rows.length).toBe(6);
    for (const row of m.rows) {
      expect(row.total_overrides).toBe(0);
      expect(row.by_actor).toEqual({});
      expect(row.distinct_actors).toBe(0);
      expect(row.top_actors).toEqual([]);
    }
    expect(m.columns).toEqual([]);
    expect(m.peak_cell).toBeNull();
    expect(m.most_versatile_actor).toBeNull();
    expect(m.most_active_category).toBeNull();
    expect(m.empty_cells).toEqual([]);
    expect(m.total_categories).toBe(6);
  });

  test('all-defaults input → empty matrix', () => {
    const entries = [
      makeEntry('alerts.red', 'alerts', null),
      makeEntry('notif.email', 'notifications', null),
    ];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    expect(m.total_overrides).toBe(0);
    expect(m.actors).toEqual([]);
  });

  test('single override lands in correct cell', () => {
    const entries = [makeEntry('alerts.red', 'alerts', 'alice')];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    expect(m.total_overrides).toBe(1);
    expect(m.actors).toEqual(['alice']);
    const alertsRow = m.rows.find((r) => r.category === 'alerts')!;
    expect(alertsRow.total_overrides).toBe(1);
    expect(alertsRow.by_actor.alice).toBe(1);
    expect(alertsRow.distinct_actors).toBe(1);
    const aliceCol = m.columns.find((c) => c.actor_username === 'alice')!;
    expect(aliceCol.total_overrides).toBe(1);
    expect(aliceCol.by_category.alerts).toBe(1);
    expect(aliceCol.by_category.notifications).toBe(0);
    expect(aliceCol.distinct_categories).toBe(1);
  });

  test('rows in canonical listCategories order', () => {
    const m = buildConfigCategoryActorMatrix('BIL', [], NOW);
    expect(m.rows.map((r) => r.category)).toEqual(listCategories());
  });

  test('columns sorted asc by actor_username', () => {
    const entries = [
      makeEntry('a', 'alerts', 'zebra'),
      makeEntry('b', 'alerts', 'alpha'),
      makeEntry('c', 'alerts', 'mike'),
    ];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    expect(m.actors).toEqual(['alpha', 'mike', 'zebra']);
    expect(m.columns.map((c) => c.actor_username)).toEqual([
      'alpha',
      'mike',
      'zebra',
    ]);
  });

  test('every by_category key present per column (6 keys)', () => {
    const entries = [makeEntry('a', 'alerts', 'alice')];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    const col = m.columns[0];
    for (const cat of listCategories()) {
      expect(col.by_category[cat]).toBeGreaterThanOrEqual(0);
    }
    expect(Object.keys(col.by_category).length).toBe(6);
  });

  test('Σ col.by_category = col.total_overrides partition', () => {
    const entries = [
      makeEntry('a', 'alerts', 'alice'),
      makeEntry('b', 'notifications', 'alice'),
      makeEntry('c', 'scoring', 'alice'),
    ];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    const col = m.columns[0];
    const sum = listCategories().reduce((a, cat) => a + col.by_category[cat], 0);
    expect(sum).toBe(col.total_overrides);
    expect(sum).toBe(3);
  });

  test('Σ row.by_actor = row.total_overrides partition', () => {
    const entries = [
      makeEntry('a', 'alerts', 'alice'),
      makeEntry('b', 'alerts', 'alice'),
      makeEntry('c', 'alerts', 'bob'),
    ];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    const alertsRow = m.rows.find((r) => r.category === 'alerts')!;
    const sum = Object.values(alertsRow.by_actor).reduce((a, n) => a + n, 0);
    expect(sum).toBe(alertsRow.total_overrides);
    expect(sum).toBe(3);
  });

  test('grand-total cross-check Σ rows = Σ cols = total_overrides', () => {
    const entries = [
      makeEntry('a', 'alerts', 'alice'),
      makeEntry('b', 'notifications', 'bob'),
      makeEntry('c', 'scoring', 'carol'),
      makeEntry('d', 'features', 'alice'),
    ];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    const rowSum = m.rows.reduce((a, r) => a + r.total_overrides, 0);
    const colSum = m.columns.reduce((a, c) => a + c.total_overrides, 0);
    expect(rowSum).toBe(m.total_overrides);
    expect(colSum).toBe(m.total_overrides);
    expect(rowSum).toBe(4);
  });

  test('cell cross-check: row.by_actor[X] === col[X].by_category[cat]', () => {
    const entries = [
      makeEntry('a', 'alerts', 'alice'),
      makeEntry('b', 'alerts', 'alice'),
      makeEntry('c', 'notifications', 'alice'),
      makeEntry('d', 'alerts', 'bob'),
    ];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    for (const row of m.rows) {
      for (const col of m.columns) {
        const fromRow = row.by_actor[col.actor_username] ?? 0;
        const fromCol = col.by_category[row.category];
        expect(fromRow).toBe(fromCol);
      }
    }
  });

  test('top_actors cap 3 with canonical asc tie-break', () => {
    const entries = [];
    // 5 actors all with 1 override in alerts
    for (let i = 0; i < 5; i++) {
      entries.push(
        makeEntry(`k${i}`, 'alerts', `user-${String(i).padStart(2, '0')}`),
      );
    }
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    const alertsRow = m.rows.find((r) => r.category === 'alerts')!;
    expect(alertsRow.top_actors.length).toBe(3);
    // All tied at 1 → canonical asc order
    expect(alertsRow.top_actors.map((t) => t.actor_username)).toEqual([
      'user-00',
      'user-01',
      'user-02',
    ]);
  });

  test('categories_without per column canonical order', () => {
    const entries = [makeEntry('a', 'alerts', 'alice')];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    const col = m.columns[0];
    // 6 categories - 1 populated (alerts) = 5 without
    expect(col.categories_without.length).toBe(5);
    // Canonical listCategories order, minus 'alerts'
    expect(col.categories_without).toEqual(
      listCategories().filter((c) => c !== 'alerts'),
    );
  });

  test('peak_cell formula', () => {
    const entries = [
      // alerts/alice: 3
      makeEntry('a', 'alerts', 'alice'),
      makeEntry('b', 'alerts', 'alice'),
      makeEntry('c', 'alerts', 'alice'),
      // notifications/bob: 1
      makeEntry('d', 'notifications', 'bob'),
    ];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    expect(m.peak_cell).toEqual({
      category: 'alerts',
      actor_username: 'alice',
      count: 3,
    });
  });

  test('peak_cell canonical iteration tie-break', () => {
    const entries = [
      // alerts/zebra and notifications/alice both at 1
      makeEntry('a', 'alerts', 'zebra'),
      makeEntry('b', 'notifications', 'alice'),
    ];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    // alerts iterates first canonical → wins
    expect(m.peak_cell?.category).toBe('alerts');
    expect(m.peak_cell?.actor_username).toBe('zebra');
  });

  test('peak_cell null on empty', () => {
    const m = buildConfigCategoryActorMatrix('BIL', [], NOW);
    expect(m.peak_cell).toBeNull();
  });

  test('most_versatile_actor = highest distinct_categories', () => {
    const entries = [
      // alice spans 3 categories
      makeEntry('a', 'alerts', 'alice'),
      makeEntry('b', 'notifications', 'alice'),
      makeEntry('c', 'scoring', 'alice'),
      // bob in 1 category but 4 overrides
      makeEntry('d', 'alerts', 'bob'),
      makeEntry('e', 'alerts', 'bob'),
      makeEntry('f', 'alerts', 'bob'),
      makeEntry('g', 'alerts', 'bob'),
    ];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    expect(m.most_versatile_actor).toBe('alice');
  });

  test('most_versatile_actor canonical asc tie-break', () => {
    const entries = [
      // zebra + alpha both span 2 categories
      makeEntry('a', 'alerts', 'zebra'),
      makeEntry('b', 'notifications', 'zebra'),
      makeEntry('c', 'alerts', 'alpha'),
      makeEntry('d', 'notifications', 'alpha'),
    ];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    // alpha wins via asc
    expect(m.most_versatile_actor).toBe('alpha');
  });

  test('most_versatile_actor null on empty', () => {
    const m = buildConfigCategoryActorMatrix('BIL', [], NOW);
    expect(m.most_versatile_actor).toBeNull();
  });

  test('most_active_category = highest distinct_actors', () => {
    const entries = [
      // alerts touched by 3 actors
      makeEntry('a', 'alerts', 'alice'),
      makeEntry('b', 'alerts', 'bob'),
      makeEntry('c', 'alerts', 'carol'),
      // notifications touched by 1
      makeEntry('d', 'notifications', 'alice'),
    ];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    expect(m.most_active_category).toBe('alerts');
  });

  test('most_active_category canonical category-order tie-break', () => {
    const entries = [
      // alerts and notifications both touched by alice + bob (2 actors each)
      makeEntry('a', 'alerts', 'alice'),
      makeEntry('b', 'alerts', 'bob'),
      makeEntry('c', 'notifications', 'alice'),
      makeEntry('d', 'notifications', 'bob'),
    ];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    // alerts iterates first → wins
    expect(m.most_active_category).toBe('alerts');
  });

  test('most_active_category null on empty', () => {
    const m = buildConfigCategoryActorMatrix('BIL', [], NOW);
    expect(m.most_active_category).toBeNull();
  });

  test('empty_cells in canonical category × actor row-major order', () => {
    const entries = [
      makeEntry('a', 'alerts', 'alice'),
      makeEntry('b', 'notifications', 'bob'),
    ];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    // 6 categories × 2 actors = 12 cells; 2 populated (alerts/alice + notifications/bob), 10 empty
    expect(m.empty_cells.length).toBe(10);
    // First should be (alerts, bob) — category 'alerts', second actor alphabetically
    expect(m.empty_cells[0]).toEqual({ category: 'alerts', actor_username: 'bob' });
    // Then (cases, alice) — 'cases' is 2nd category in canonical listCategories() order
    expect(m.empty_cells[1]).toEqual({ category: 'cases', actor_username: 'alice' });
  });

  test('defaults excluded from counting', () => {
    const entries = [
      makeEntry('a', 'alerts', 'alice'), // override
      makeEntry('b', 'alerts', null), // default
      makeEntry('c', 'notifications', null), // default
    ];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    expect(m.total_overrides).toBe(1);
    expect(m.actors).toEqual(['alice']);
  });

  test('null updated_by defensively skipped', () => {
    // Construct an entry with is_default=false but updated_by=null (shouldn't happen).
    const entries: ConfigEntry[] = [
      {
        key: 'a',
        category: 'alerts',
        type: 'number',
        description: '',
        default_value: 1,
        value: 2,
        is_default: false,
        updated_at: NOW.toISOString(),
        updated_by: null,
      },
    ];
    const m = buildConfigCategoryActorMatrix('BIL', entries, NOW);
    expect(m.total_overrides).toBe(0);
  });

  test('tenant_id + generated_at echo', () => {
    const m = buildConfigCategoryActorMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M13.17 — GET /v1/admin/config/category-actor-matrix', () => {
  test('admin → 200 with default store (no overrides)', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/config/category-actor-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(0);
    expect(r.body.body.actors).toEqual([]);
    expect(r.body.body.rows.length).toBe(6);
  });

  test('populated reflects overrides', async () => {
    const store = new InMemoryConfigStore();
    store.set('BIL', 'alerts.red_sla_hours', 8, 'alice', NOW);
    store.set('BIL', 'notifications.email.enabled', false, 'alice', NOW);
    store.set('BIL', 'scoring.default_thresholds.low_max', 40, 'bob', NOW);
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/admin/config/category-actor-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(3);
    expect(r.body.body.actors).toEqual(['alice', 'bob']);
    expect(r.body.body.most_versatile_actor).toBe('alice');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTestApp('case_owner');
    const r = await request(app)
      .get('/v1/admin/config/category-actor-matrix')
      .set(TH);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryConfigStore();
    store.set('BIL', 'alerts.red_sla_hours', 8, 'alice', NOW);
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/admin/config/category-actor-matrix')
      .set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(0);
  });

  test('M13.16 /actor-rollup sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/config/actor-rollup')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('M13.12 /override-rate sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/config/override-rate')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('literal /category-actor-matrix not captured by /:key wildcard', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/config/category-actor-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.rows).toBeDefined();
  });
});
