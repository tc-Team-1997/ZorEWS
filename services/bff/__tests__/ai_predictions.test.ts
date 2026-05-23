// services/bff/__tests__/ai_predictions.test.ts
//
// Unit tests for InMemoryAiPredictionStore + makeAiPredictionStore factory.
// In-memory only. Integration tests (pg-backed) live in ai_predictions_pg.test.ts
// and are gated on BFF_PG_URL — matches the convention used by
// admin_config_pg.test.ts + webhooks_pg.test.ts + scenarios_store.test.ts.

import {
  InMemoryAiPredictionStore,
  PgAiPredictionStore,
  makeAiPredictionStore,
  defaultAiPredictionStore,
  PREDICTION_PAGE_SIZE_DEFAULT,
  PREDICTION_PAGE_SIZE_MAX,
  type AiPredictionStore,
  type RecordPredictionInput,
} from '../src/ai_predictions';
import type { InferenceResult } from '../src/ai_model_registry';

function makeResult(overrides: Partial<InferenceResult> = {}): InferenceResult {
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
    ...overrides,
  };
}

function makeInput(
  result: InferenceResult,
  overrides: Partial<RecordPredictionInput> = {},
): RecordPredictionInput {
  return {
    tenant_id: 'BANK_DEMO',
    model_id: result.model_id,
    model_version: '3.2.1',
    prediction_type: 'pd',
    result,
    input_snapshot: { customer_id: result.customer_id },
    created_by: 'alice.admin',
    ...overrides,
  };
}

describe('InMemoryAiPredictionStore', () => {
  let store: AiPredictionStore;

  beforeEach(() => {
    store = new InMemoryAiPredictionStore();
  });

  it('record() returns a row with a fresh prediction_id', () => {
    const row = store.record(makeInput(makeResult()));
    expect(row.prediction_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(row.tenant_id).toBe('BANK_DEMO');
    expect(row.model_id).toBe('pd_xgb_v3');
    expect(row.model_version).toBe('3.2.1');
    expect(row.prediction_type).toBe('pd');
    expect(row.customer_id).toBe('CUST-100001');
    expect(row.value).toBe(0.42);
    expect(row.band).toBe('medium');
    expect(row.confidence).toBe(0.42);
    expect(row.top_features).toHaveLength(2);
    expect(row.input_snapshot).toEqual({ customer_id: 'CUST-100001' });
    expect(row.generated_at).toBe('2026-05-23T12:00:00.000Z');
    expect(row.created_by).toBe('alice.admin');
  });

  it('record() defaults created_by to "system" when omitted', () => {
    const row = store.record({ ...makeInput(makeResult()), created_by: undefined });
    expect(row.created_by).toBe('system');
  });

  it('record() preserves null input_snapshot', () => {
    const row = store.record({ ...makeInput(makeResult()), input_snapshot: null });
    expect(row.input_snapshot).toBeNull();
  });

  it('record() copies top_features (no aliasing — caller can mutate result freely)', () => {
    const result = makeResult();
    const row = store.record(makeInput(result));
    result.top_features[0].attribution = 0.99; // mutate the source
    expect(row.top_features[0].attribution).toBe(0.18); // unaffected
  });

  it('record() handles anomaly model (negative value, null band)', () => {
    const result = makeResult({
      model_id: 'anomaly_iso_v1',
      score: -0.55,
      probability: null,
      band: null,
    });
    const row = store.record(makeInput(result, { model_id: 'anomaly_iso_v1', prediction_type: 'anomaly' }));
    expect(row.value).toBe(-0.55);
    expect(row.band).toBeNull();
    expect(row.confidence).toBeNull();
  });

  it('record() handles claim_severity regression (KES value, null band+confidence)', () => {
    const result = makeResult({
      model_id: 'claim_severity_v1',
      score: 250_000,
      probability: null,
      band: null,
    });
    const row = store.record(
      makeInput(result, { model_id: 'claim_severity_v1', prediction_type: 'claim_severity' }),
    );
    expect(row.value).toBe(250_000);
    expect(row.band).toBeNull();
  });

  it('list() returns newest-first', () => {
    const r1 = store.record(makeInput(makeResult({ scored_at: '2026-05-20T10:00:00.000Z' })));
    const r2 = store.record(makeInput(makeResult({ scored_at: '2026-05-21T10:00:00.000Z' })));
    const r3 = store.record(makeInput(makeResult({ scored_at: '2026-05-22T10:00:00.000Z' })));
    const out = store.list('BANK_DEMO');
    expect(out.items).toHaveLength(3);
    expect(out.items[0].prediction_id).toBe(r3.prediction_id);
    expect(out.items[2].prediction_id).toBe(r1.prediction_id);
  });

  it('list() filters by customer_id', () => {
    store.record(makeInput(makeResult({ customer_id: 'CUST-A' })));
    store.record(makeInput(makeResult({ customer_id: 'CUST-B' })));
    store.record(makeInput(makeResult({ customer_id: 'CUST-A' })));
    const out = store.list('BANK_DEMO', { customer_id: 'CUST-A' });
    expect(out.items).toHaveLength(2);
    expect(out.items.every((p) => p.customer_id === 'CUST-A')).toBe(true);
  });

  it('list() filters by model_id', () => {
    store.record(makeInput(makeResult(), { model_id: 'pd_xgb_v3' }));
    store.record(makeInput(makeResult(), { model_id: 'fraud_lgb_v1', prediction_type: 'fraud' }));
    const out = store.list('BANK_DEMO', { model_id: 'fraud_lgb_v1' });
    expect(out.items).toHaveLength(1);
    expect(out.items[0].model_id).toBe('fraud_lgb_v1');
  });

  it('list() filters by prediction_type', () => {
    store.record(makeInput(makeResult(), { prediction_type: 'pd' }));
    store.record(makeInput(makeResult(), { prediction_type: 'fraud', model_id: 'fraud_lgb_v1' }));
    store.record(makeInput(makeResult(), { prediction_type: 'churn', model_id: 'churn_xgb_v1' }));
    const out = store.list('BANK_DEMO', { prediction_type: 'fraud' });
    expect(out.items).toHaveLength(1);
    expect(out.items[0].prediction_type).toBe('fraud');
  });

  it('list() filters by since/until window', () => {
    store.record(makeInput(makeResult({ scored_at: '2026-05-20T10:00:00.000Z' })));
    store.record(makeInput(makeResult({ scored_at: '2026-05-22T10:00:00.000Z' })));
    store.record(makeInput(makeResult({ scored_at: '2026-05-24T10:00:00.000Z' })));
    const out = store.list('BANK_DEMO', { since: '2026-05-21T00:00:00.000Z', until: '2026-05-23T00:00:00.000Z' });
    expect(out.items).toHaveLength(1);
    expect(out.items[0].generated_at).toBe('2026-05-22T10:00:00.000Z');
  });

  it('list() pagination: page=2 page_size=2 with 5 rows returns 2 items', () => {
    for (let i = 0; i < 5; i++) {
      store.record(
        makeInput(
          makeResult({
            customer_id: `CUST-${i}`,
            scored_at: new Date(2026, 4, 23, 10, i).toISOString(),
          }),
        ),
      );
    }
    const out = store.list('BANK_DEMO', { page: 2, page_size: 2 });
    expect(out.items).toHaveLength(2);
    expect(out.page).toBe(2);
    expect(out.page_size).toBe(2);
    expect(out.total).toBe(5);
  });

  it('list() page_size clamped to PREDICTION_PAGE_SIZE_MAX', () => {
    const out = store.list('BANK_DEMO', { page_size: 999_999 });
    expect(out.page_size).toBe(PREDICTION_PAGE_SIZE_MAX);
  });

  it('list() page_size defaults when not supplied', () => {
    const out = store.list('BANK_DEMO');
    expect(out.page_size).toBe(PREDICTION_PAGE_SIZE_DEFAULT);
  });

  it('list() returns empty result for never-seen tenant', () => {
    store.record(makeInput(makeResult()));
    const out = store.list('UNKNOWN_TENANT');
    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
  });

  it('get() returns the row for matching tenant', () => {
    const r = store.record(makeInput(makeResult()));
    const got = store.get('BANK_DEMO', r.prediction_id);
    expect(got).not.toBeNull();
    expect(got!.prediction_id).toBe(r.prediction_id);
  });

  it('get() returns null on cross-tenant lookup', () => {
    const r = store.record(makeInput(makeResult()));
    const got = store.get('BIL', r.prediction_id);
    expect(got).toBeNull();
  });

  it('get() returns null on unknown prediction_id', () => {
    const got = store.get('BANK_DEMO', 'does-not-exist');
    expect(got).toBeNull();
  });

  it('tenant isolation: writes against BANK_DEMO do not surface to BIL list', () => {
    store.record(makeInput(makeResult({ customer_id: 'CUST-1' }), { tenant_id: 'BANK_DEMO' }));
    store.record(makeInput(makeResult({ customer_id: 'CUST-2' }), { tenant_id: 'BIL' }));
    const bank = store.list('BANK_DEMO');
    const bil = store.list('BIL');
    expect(bank.items).toHaveLength(1);
    expect(bank.items[0].customer_id).toBe('CUST-1');
    expect(bil.items).toHaveLength(1);
    expect(bil.items[0].customer_id).toBe('CUST-2');
  });
});

describe('defaultAiPredictionStore singleton', () => {
  it('is a working InMemoryAiPredictionStore by default', () => {
    expect(defaultAiPredictionStore).toBeDefined();
    const r = defaultAiPredictionStore.record(makeInput(makeResult({ customer_id: 'SINGLETON-TEST' })));
    expect(r.prediction_id).toBeTruthy();
    const got = defaultAiPredictionStore.get('BANK_DEMO', r.prediction_id);
    expect(got).not.toBeNull();
  });
});

describe('makeAiPredictionStore factory (env-gated)', () => {
  it('returns InMemoryAiPredictionStore when BFF_PG_URL unset', () => {
    const store = makeAiPredictionStore({});
    expect(store).toBeInstanceOf(InMemoryAiPredictionStore);
    expect(store).not.toBeInstanceOf(PgAiPredictionStore);
  });

  it('returns PgAiPredictionStore when BFF_PG_URL is set (live url not required for this unit check)', () => {
    // The factory eagerly fires init() in the background but we don't await — so
    // a non-resolving connection won't blow up this test. PgAiPredictionStore
    // extends InMemoryAiPredictionStore so the instanceof check above must
    // confirm both legs (otherwise sub-class would falsely pass the parent check).
    const store = makeAiPredictionStore({ BFF_PG_URL: 'postgres://invalid:invalid@127.0.0.1:1/x' });
    expect(store).toBeInstanceOf(PgAiPredictionStore);
    expect(store).toBeInstanceOf(InMemoryAiPredictionStore);
  });
});
