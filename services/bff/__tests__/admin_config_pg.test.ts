// services/bff/__tests__/admin_config_pg.test.ts
//
// PgConfigStore integration tests.
// Gated on BFF_PG_URL env var — matches the convention used by
// webhooks_pg.test.ts + scenarios_store.test.ts + cases_pg.test.ts.
//
// To run: BFF_PG_URL='postgres://zorews_user:apex@localhost:55432/zorews' npx jest admin_config_pg
//
// Skipped silently (vacuous pass) when BFF_PG_URL is unset.

import { Pool } from 'pg';
import { PgConfigStore, makeConfigStore, InMemoryConfigStore } from '../src/admin_config';

const PG_URL = process.env.BFF_PG_URL;
const TEST_TENANT = `TEST_CFG_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

const describePg = PG_URL ? describe : describe.skip;

describePg('PgConfigStore (integration)', () => {
  let pool: Pool;
  let store: PgConfigStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 3 });
    // The TEST_TENANT must exist in app_iam.tenants because tenant_configs.tenant_id
    // is FK-constrained. Insert a synthetic test tenant; cleanup in afterAll.
    await pool.query(
      `INSERT INTO app_iam.tenants (tenant_id, name, vertical, channels_allowed, active)
       VALUES ($1, $2, 'banking', ARRAY['API'], true)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [TEST_TENANT, `Test config tenant ${TEST_TENANT}`]
    );

    store = new PgConfigStore(pool);
    await store.init();
  });

  afterAll(async () => {
    // Cleanup — only touch our test tenant; never the real BANK_DEMO/BIL data
    await pool.query(`DELETE FROM app_admin.tenant_configs WHERE tenant_id = $1`, [TEST_TENANT]);
    await pool.query(`DELETE FROM app_iam.tenants WHERE tenant_id = $1`, [TEST_TENANT]);
    await pool.end();
  });

  it('init() loads cleanly against the live schema', () => {
    const entries = store.list(TEST_TENANT);
    expect(entries.length).toBeGreaterThan(0);
    // Brand-new test tenant — every entry should be a platform default
    expect(entries.every((e) => e.is_default === true)).toBe(true);
  });

  it('set() persists to pg + cache reflects immediately', async () => {
    const now = new Date();
    const entry = store.set(TEST_TENANT, 'alerts.red_sla_hours', 2, 'integration-test', now);

    // Sync read returns the override immediately (cache populated)
    expect(entry.value).toBe(2);
    expect(entry.is_default).toBe(false);
    expect(entry.updated_by).toBe('integration-test');

    // Wait for the fire-and-forget pg write to land
    await new Promise((r) => setTimeout(r, 150));

    const { rows } = await pool.query(
      `SELECT value, updated_by, value_type, category, deleted_at
       FROM app_admin.tenant_configs
       WHERE tenant_id = $1 AND config_key = $2`,
      [TEST_TENANT, 'alerts.red_sla_hours']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(2);
    expect(rows[0].updated_by).toBe('integration-test');
    expect(rows[0].value_type).toBe('number');
    expect(rows[0].category).toBe('alerts');
    expect(rows[0].deleted_at).toBeNull();
  });

  it('set() of existing key UPSERTs in place', async () => {
    const first = new Date();
    store.set(TEST_TENANT, 'alerts.red_sla_hours', 5, 'first-actor', first);
    await new Promise((r) => setTimeout(r, 100));

    const later = new Date(first.getTime() + 5000);
    const entry = store.set(TEST_TENANT, 'alerts.red_sla_hours', 8, 'second-actor', later);
    expect(entry.value).toBe(8);
    expect(entry.updated_by).toBe('second-actor');

    await new Promise((r) => setTimeout(r, 100));
    const { rows } = await pool.query(
      `SELECT value, updated_by FROM app_admin.tenant_configs
       WHERE tenant_id = $1 AND config_key = $2`,
      [TEST_TENANT, 'alerts.red_sla_hours']
    );
    expect(rows).toHaveLength(1); // UPSERT — single row
    expect(rows[0].value).toBe(8);
    expect(rows[0].updated_by).toBe('second-actor');
  });

  it('reset() soft-deletes the override + cache reverts to default', async () => {
    store.set(TEST_TENANT, 'alerts.red_sla_hours', 9, 'pre-reset', new Date());
    await new Promise((r) => setTimeout(r, 100));

    const reverted = store.reset(TEST_TENANT, 'alerts.red_sla_hours');
    expect(reverted.is_default).toBe(true);
    expect(reverted.value).toBe(4); // Platform default for alerts.red_sla_hours

    await new Promise((r) => setTimeout(r, 100));
    const { rows } = await pool.query(
      `SELECT deleted_at FROM app_admin.tenant_configs
       WHERE tenant_id = $1 AND config_key = $2`,
      [TEST_TENANT, 'alerts.red_sla_hours']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).not.toBeNull(); // Soft-deleted
  });

  it('set() after reset() UPSERTs and clears deleted_at', async () => {
    store.set(TEST_TENANT, 'alerts.red_sla_hours', 3, 'pre-reset', new Date());
    await new Promise((r) => setTimeout(r, 100));
    store.reset(TEST_TENANT, 'alerts.red_sla_hours');
    await new Promise((r) => setTimeout(r, 100));

    const re = store.set(TEST_TENANT, 'alerts.red_sla_hours', 6, 'post-reset', new Date());
    expect(re.value).toBe(6);
    expect(re.is_default).toBe(false);

    await new Promise((r) => setTimeout(r, 100));
    const { rows } = await pool.query(
      `SELECT value, deleted_at FROM app_admin.tenant_configs
       WHERE tenant_id = $1 AND config_key = $2`,
      [TEST_TENANT, 'alerts.red_sla_hours']
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(6);
    expect(rows[0].deleted_at).toBeNull(); // un-deleted on UPSERT
  });

  it('persists across new store instances (restart resilience)', async () => {
    store.set(TEST_TENANT, 'notifications.email.enabled', false, 'persistence-test', new Date());
    await new Promise((r) => setTimeout(r, 200));

    const fresh = new PgConfigStore(pool);
    await fresh.init();

    const entry = fresh.get(TEST_TENANT, 'notifications.email.enabled');
    expect(entry).not.toBeNull();
    expect(entry?.value).toBe(false);
    expect(entry?.is_default).toBe(false);
    expect(entry?.updated_by).toBe('persistence-test');
  });

  it('different value types round-trip correctly through JSONB', async () => {
    const now = new Date();
    // boolean
    store.set(TEST_TENANT, 'features.scenario_simulation_enabled', true, 't', now);
    // string
    store.set(TEST_TENANT, 'notifications.email.from_address', 'alerts@local.test', 't', now);
    // number (integer)
    store.set(TEST_TENANT, 'reporting.retention_days', 180, 't', now);
    // number (float — exercises scoring.default_thresholds.* keys with sub-1 values)
    store.set(TEST_TENANT, 'scoring.default_thresholds.low_max', 0.25, 't', now);
    store.set(TEST_TENANT, 'scoring.default_thresholds.medium_max', 0.60, 't', now);

    await new Promise((r) => setTimeout(r, 200));

    // Fresh store re-reads from pg — proves round-trip
    const fresh = new PgConfigStore(pool);
    await fresh.init();

    expect(fresh.get(TEST_TENANT, 'features.scenario_simulation_enabled')?.value).toBe(true);
    expect(fresh.get(TEST_TENANT, 'notifications.email.from_address')?.value).toBe('alerts@local.test');
    expect(fresh.get(TEST_TENANT, 'reporting.retention_days')?.value).toBe(180);
    expect(fresh.get(TEST_TENANT, 'scoring.default_thresholds.low_max')?.value).toBe(0.25);
    expect(fresh.get(TEST_TENANT, 'scoring.default_thresholds.medium_max')?.value).toBe(0.60);
  });

  it('tenant isolation: writes against TEST_TENANT do not affect BANK_DEMO', async () => {
    store.set(TEST_TENANT, 'reporting.retention_days', 42, 't', new Date());
    await new Promise((r) => setTimeout(r, 150));

    // BANK_DEMO should still show the platform default, not 42
    const bankDemoEntry = store.get('BANK_DEMO', 'reporting.retention_days');
    expect(bankDemoEntry).not.toBeNull();
    expect(bankDemoEntry?.value).not.toBe(42);
    expect(bankDemoEntry?.is_default).toBe(true);
  });
});

describe('makeConfigStore factory (env-gated)', () => {
  it('returns InMemoryConfigStore when BFF_PG_URL unset', () => {
    const store = makeConfigStore({});
    expect(store).toBeInstanceOf(InMemoryConfigStore);
  });

  it('returns PgConfigStore when BFF_PG_URL set (smoke)', () => {
    if (!PG_URL) {
      // No pg available — verify factory at least doesn't blow up with a junk URL
      // by skipping the live-pg path; tested above when PG_URL is present.
      return;
    }
    const store = makeConfigStore({ BFF_PG_URL: PG_URL });
    expect(store).toBeInstanceOf(PgConfigStore);
  });
});
