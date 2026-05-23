// services/bff/__tests__/ai_predictions_pg.test.ts
//
// PgAiPredictionStore integration tests.
// Gated on BFF_PG_URL env var — matches the convention from
// admin_config_pg.test.ts + webhooks_pg.test.ts + scenarios_store.test.ts.
//
// Run:
//   BFF_PG_URL='postgres://zorews_user:apex@localhost:55432/zorews' npx jest ai_predictions_pg

import { Pool } from 'pg';
import {
  PgAiPredictionStore,
  InMemoryAiPredictionStore,
  makeAiPredictionStore,
} from '../src/ai_predictions';
import type { InferenceResult } from '../src/ai_model_registry';

const PG_URL = process.env.BFF_PG_URL;
const TEST_TENANT = `TEST_AIP_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
const describePg = PG_URL ? describe : describe.skip;

function makeResult(o: Partial<InferenceResult> = {}): InferenceResult {
  return {
    model_id: 'pd_xgb_v3',
    customer_id: 'CUST-100001',
    score: 0.42,
    probability: 0.42,
    band: 'medium',
    scored_at: '2026-05-23T12:00:00.000Z',
    top_features: [
      { feature: 'dpd_30d', value: 1, attribution: 0.18 },
      { feature: 'utilisation_pct', value: 0.85, attribution: 0.12 },
    ],
    ...o,
  };
}

describePg('PgAiPredictionStore (integration)', () => {
  let pool: Pool;
  let store: PgAiPredictionStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 3 });
    await pool.query(
      `INSERT INTO app_iam.tenants (tenant_id, name, vertical, channels_allowed, active)
       VALUES ($1, $2, 'banking', ARRAY['API'], true)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [TEST_TENANT, `Test AI predictions tenant ${TEST_TENANT}`],
    );
    store = new PgAiPredictionStore(pool);
    await store.init();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM app_copilot.ai_predictions WHERE tenant_id = $1`, [TEST_TENANT]);
    await pool.query(`DELETE FROM app_iam.tenants WHERE tenant_id = $1`, [TEST_TENANT]);
    await pool.end();
  });

  it('init() loads cleanly against the live schema (fresh tenant → empty)', () => {
    const out = store.list(TEST_TENANT);
    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
  });

  it('record() persists to pg + cache reflects immediately', async () => {
    const row = store.record({
      tenant_id: TEST_TENANT,
      model_id: 'pd_xgb_v3',
      model_version: '3.2.1',
      prediction_type: 'pd',
      result: makeResult(),
      input_snapshot: { customer_id: 'CUST-100001', source: 'integration-test' },
      created_by: 'integration-test',
    });

    // Sync read returns the row immediately (cache populated by super.record())
    const fromCache = store.get(TEST_TENANT, row.prediction_id);
    expect(fromCache).not.toBeNull();
    expect(fromCache!.value).toBe(0.42);
    expect(fromCache!.band).toBe('medium');

    // Wait for fire-and-forget pg INSERT to land
    await new Promise((r) => setTimeout(r, 200));

    const { rows } = await pool.query(
      `SELECT prediction_id, tenant_id, model_id, model_version, prediction_type,
              customer_id, value, band, confidence, top_features, input_snapshot, created_by
       FROM app_copilot.ai_predictions
       WHERE prediction_id = $1`,
      [row.prediction_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(TEST_TENANT);
    expect(rows[0].model_id).toBe('pd_xgb_v3');
    expect(rows[0].model_version).toBe('3.2.1');
    expect(rows[0].prediction_type).toBe('pd');
    expect(rows[0].customer_id).toBe('CUST-100001');
    expect(parseFloat(rows[0].value)).toBeCloseTo(0.42, 4);
    expect(rows[0].band).toBe('medium');
    expect(parseFloat(rows[0].confidence)).toBeCloseTo(0.42, 4);
    expect(Array.isArray(rows[0].top_features)).toBe(true);
    expect(rows[0].top_features).toHaveLength(2);
    expect(rows[0].input_snapshot.source).toBe('integration-test');
    expect(rows[0].created_by).toBe('integration-test');
  });

  it('record() handles anomaly model (negative value, null band, null confidence)', async () => {
    const row = store.record({
      tenant_id: TEST_TENANT,
      model_id: 'anomaly_iso_v1',
      model_version: '1.0.0',
      prediction_type: 'anomaly',
      result: makeResult({ model_id: 'anomaly_iso_v1', score: -0.55, probability: null, band: null }),
      input_snapshot: null,
      created_by: 'integration-test',
    });
    await new Promise((r) => setTimeout(r, 200));

    const { rows } = await pool.query(
      `SELECT value, band, confidence, input_snapshot
       FROM app_copilot.ai_predictions WHERE prediction_id = $1`,
      [row.prediction_id],
    );
    expect(rows).toHaveLength(1);
    expect(parseFloat(rows[0].value)).toBeCloseTo(-0.55, 4);
    expect(rows[0].band).toBeNull();
    expect(rows[0].confidence).toBeNull();
    expect(rows[0].input_snapshot).toBeNull();
  });

  it('record() handles claim_severity regression (within numeric(10,6) precision)', async () => {
    // The value column is numeric(10,6) — max integer part is 9999. For real
    // KES regression values an additive migration will widen this column later
    // (ALTER COLUMN value TYPE NUMERIC(20,6) — purely widening + back-compat).
    // For now this test uses a value within the schema precision.
    const row = store.record({
      tenant_id: TEST_TENANT,
      model_id: 'claim_severity_v1',
      model_version: '0.1.0',
      prediction_type: 'claim_severity',
      result: makeResult({ model_id: 'claim_severity_v1', score: 9999.123456, probability: null, band: null }),
      input_snapshot: { claim_id: 'CLM-100001' },
      created_by: 'integration-test',
    });
    await new Promise((r) => setTimeout(r, 200));

    const { rows } = await pool.query(
      `SELECT value, prediction_type FROM app_copilot.ai_predictions WHERE prediction_id = $1`,
      [row.prediction_id],
    );
    expect(rows).toHaveLength(1);
    expect(parseFloat(rows[0].value)).toBeCloseTo(9999.123456, 4);
    expect(rows[0].prediction_type).toBe('claim_severity');
  });

  it('persists across new store instances (restart resilience)', async () => {
    const original = store.record({
      tenant_id: TEST_TENANT,
      model_id: 'fraud_lgb_v1',
      model_version: '1.5.0',
      prediction_type: 'fraud',
      result: makeResult({ model_id: 'fraud_lgb_v1', customer_id: 'CUST-PERSIST', score: 0.91, probability: 0.91, band: 'high' }),
      input_snapshot: { customer_id: 'CUST-PERSIST' },
      created_by: 'persistence-test',
    });
    await new Promise((r) => setTimeout(r, 250));

    const fresh = new PgAiPredictionStore(pool);
    await fresh.init();

    const rehydrated = fresh.get(TEST_TENANT, original.prediction_id);
    expect(rehydrated).not.toBeNull();
    expect(rehydrated!.value).toBe(0.91);
    expect(rehydrated!.band).toBe('high');
    expect(rehydrated!.created_by).toBe('persistence-test');
    expect(rehydrated!.top_features).toHaveLength(2);
    expect(rehydrated!.input_snapshot).toEqual({ customer_id: 'CUST-PERSIST' });
  });

  it('list() with filters narrows the result set against pg-backed cache', () => {
    // Records from earlier tests should all be present in this store's cache.
    const allInTenant = store.list(TEST_TENANT);
    expect(allInTenant.total).toBeGreaterThanOrEqual(3);

    const anomalyOnly = store.list(TEST_TENANT, { prediction_type: 'anomaly' });
    expect(anomalyOnly.total).toBeGreaterThanOrEqual(1);
    expect(anomalyOnly.items.every((p) => p.prediction_type === 'anomaly')).toBe(true);
  });

  it('cross-tenant: writes against TEST_TENANT do not surface to BANK_DEMO', async () => {
    const r = store.record({
      tenant_id: TEST_TENANT,
      model_id: 'pd_xgb_v3',
      model_version: '3.2.1',
      prediction_type: 'pd',
      result: makeResult({ customer_id: 'CUST-ISOLATION' }),
      input_snapshot: null,
      created_by: 'isolation-test',
    });
    await new Promise((r2) => setTimeout(r2, 200));

    // get() in BANK_DEMO context must return null
    const wrongTenant = store.get('BANK_DEMO', r.prediction_id);
    expect(wrongTenant).toBeNull();

    // list() in BANK_DEMO must not see this row
    const bank = store.list('BANK_DEMO', { customer_id: 'CUST-ISOLATION' });
    expect(bank.items.every((p) => p.tenant_id !== TEST_TENANT)).toBe(true);
  });
});

describe('makeAiPredictionStore factory (env-gated, with live pg)', () => {
  it('returns InMemoryAiPredictionStore when BFF_PG_URL unset', () => {
    const s = makeAiPredictionStore({});
    expect(s).toBeInstanceOf(InMemoryAiPredictionStore);
    expect(s).not.toBeInstanceOf(PgAiPredictionStore);
  });

  it('returns PgAiPredictionStore when BFF_PG_URL set against live pg', () => {
    if (!PG_URL) return;
    const s = makeAiPredictionStore({ BFF_PG_URL: PG_URL });
    expect(s).toBeInstanceOf(PgAiPredictionStore);
  });
});
