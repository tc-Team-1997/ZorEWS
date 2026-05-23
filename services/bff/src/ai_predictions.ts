// services/bff/src/ai_predictions.ts
//
// Pg-backed prediction logging for M7.1 AiModelRegistry.score().
// The registry's score() is pure (deterministic per (model, tenant, customer, day)
// — see ai_model_registry.ts:synthesiseInference). This module is the SEPARATE
// persistence layer that the route handler invokes AFTER score() succeeds, so
// the registry itself stays pure + the audit trail of "what predictions did we
// produce, for whom, with what attribution?" lands in pg.
//
// Same shape as PgConfigStore (admin_config.ts) + PgWebhookSubscriptionStore:
//   - cache-on-init   → sync reads from in-memory cache
//   - fire-and-forget → background pg INSERTs; route response not blocked
//   - env-gated       → BFF_PG_URL unset → InMemoryAiPredictionStore
//
// Target table: app_copilot.ai_predictions (data/schema/036_ai_persistence.sql).
// Soft delete via deleted_at; reads filter WHERE deleted_at IS NULL.

import type { InferenceResult, ModelType } from './ai_model_registry';

export interface AiPrediction {
  prediction_id: string;
  tenant_id: string;
  model_id: string;
  model_version: string;
  prediction_type: ModelType;
  customer_id: string;
  /** PD/fraud/churn/lapse: 0..1 probability. anomaly: -1..1. claim_severity: KES. */
  value: number;
  /** Decision bucket — null for regression + anomaly. */
  band: 'low' | 'medium' | 'high' | null;
  /** Calibrated probability for binary models; null for regression / anomaly. */
  confidence: number | null;
  /** SHAP-style top features (jsonb in pg). */
  top_features: { feature: string; value: number; attribution: number }[];
  /** Raw input snapshot — useful for forensic replay after a model swap. */
  input_snapshot: Record<string, unknown> | null;
  generated_at: string;
  created_at: string;
  created_by: string;
}

export interface AiPredictionFilter {
  customer_id?: string;
  model_id?: string;
  model_version?: string;
  prediction_type?: ModelType;
  since?: string;
  until?: string;
  page?: number;
  page_size?: number;
}

export interface RecordPredictionInput {
  tenant_id: string;
  model_id: string;
  model_version: string;
  prediction_type: ModelType;
  result: InferenceResult;
  /** Raw input — captured into input_snapshot for forensic replay. */
  input_snapshot?: Record<string, unknown> | null;
  /** Actor that triggered the prediction. */
  created_by?: string;
}

export interface AiPredictionStore {
  /** Record a prediction. Returns the persisted row (sync from cache for routes). */
  record(input: RecordPredictionInput, now?: Date): AiPrediction;
  /** Paginated list — newest-first by generated_at. */
  list(tenant_id: string, filter?: AiPredictionFilter): {
    items: AiPrediction[];
    page: number;
    page_size: number;
    total: number;
  };
  /** Get one — null on miss / cross-tenant. */
  get(tenant_id: string, prediction_id: string): AiPrediction | null;
}

export const PREDICTION_PAGE_SIZE_DEFAULT = 50;
export const PREDICTION_PAGE_SIZE_MAX = 200;

/**
 * Maximum absolute value persistable in the pg `value` / `confidence` columns.
 * The schema (data/schema/036_ai_persistence.sql) declares them as
 * `numeric(10,6)` — 10 total digits with 6 after the decimal — so the
 * persistable range is ±9999.999999.
 *
 * Probability bands (PD/fraud/churn/lapse) fit comfortably in [0, 1].
 * Anomaly scores fit in [-1, 1].
 * Claim-severity regression values (KES) WILL exceed this limit on real-world
 * inputs; the additive migration to widen the column to NUMERIC(20,6) is a
 * follow-up tracked outside this slice.
 *
 * When the value exceeds this limit the background pg INSERT will fail with
 * `numeric field overflow` and be logged via console.error; the in-memory
 * cache still has the row, so the route response is unaffected.
 */
export const PREDICTION_VALUE_MAX_ABS = 9999.999999;

// ─── crypto helper ─────────────────────────────────────────────────────

// Deterministic UUIDv7-ish id minted in TS (independent of pg gen_random_uuid).
// In-memory store needs an id BEFORE the pg INSERT lands — so we mint here +
// pass it through ON CONFLICT DO NOTHING (safe to re-mint on cache rehydrate).
function mintPredictionId(): string {
  // 4-2-2-2-6 hex with v4 marker, sourced from crypto.randomBytes via require so
  // the module stays usable in vitest+jsdom without `crypto.randomUUID()`.
  const c = require('crypto') as { randomBytes(n: number): Buffer };
  const b = c.randomBytes(16);
  // RFC 4122 v4: bits 13 ('4') + 17 (10xx)
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ─── In-memory store ───────────────────────────────────────────────────

export class InMemoryAiPredictionStore implements AiPredictionStore {
  // Per-tenant array, newest-first.
  protected readonly byTenant = new Map<string, AiPrediction[]>();
  protected readonly byId = new Map<string, AiPrediction>();

  record(input: RecordPredictionInput, now: Date = new Date()): AiPrediction {
    const id = mintPredictionId();
    const ts = now.toISOString();
    const row: AiPrediction = {
      prediction_id: id,
      tenant_id: input.tenant_id,
      model_id: input.model_id,
      model_version: input.model_version,
      prediction_type: input.prediction_type,
      customer_id: input.result.customer_id,
      value: input.result.score,
      band: input.result.band,
      confidence: input.result.probability,
      top_features: input.result.top_features.map((f) => ({ ...f })),
      input_snapshot: input.input_snapshot ?? null,
      generated_at: input.result.scored_at,
      created_at: ts,
      created_by: input.created_by ?? 'system',
    };
    let arr = this.byTenant.get(input.tenant_id);
    if (!arr) {
      arr = [];
      this.byTenant.set(input.tenant_id, arr);
    }
    arr.unshift(row);
    this.byId.set(id, row);
    return row;
  }

  list(tenant_id: string, filter: AiPredictionFilter = {}): {
    items: AiPrediction[];
    page: number;
    page_size: number;
    total: number;
  } {
    const arr = this.byTenant.get(tenant_id) ?? [];
    let filtered = arr;
    if (filter.customer_id) filtered = filtered.filter((p) => p.customer_id === filter.customer_id);
    if (filter.model_id) filtered = filtered.filter((p) => p.model_id === filter.model_id);
    if (filter.model_version) filtered = filtered.filter((p) => p.model_version === filter.model_version);
    if (filter.prediction_type) filtered = filtered.filter((p) => p.prediction_type === filter.prediction_type);
    if (filter.since) filtered = filtered.filter((p) => p.generated_at >= filter.since!);
    if (filter.until) filtered = filtered.filter((p) => p.generated_at <= filter.until!);
    const page = Math.max(1, Math.floor(filter.page ?? 1));
    const page_size = Math.min(
      PREDICTION_PAGE_SIZE_MAX,
      Math.max(1, Math.floor(filter.page_size ?? PREDICTION_PAGE_SIZE_DEFAULT)),
    );
    const start = (page - 1) * page_size;
    return {
      items: filtered.slice(start, start + page_size),
      page,
      page_size,
      total: filtered.length,
    };
  }

  get(tenant_id: string, prediction_id: string): AiPrediction | null {
    const r = this.byId.get(prediction_id);
    if (!r) return null;
    if (r.tenant_id !== tenant_id) return null;
    return r;
  }
}

// ─── Pg-backed store ───────────────────────────────────────────────────

export interface PgPoolLike {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

interface PredictionRow {
  prediction_id: string;
  tenant_id: string;
  model_id: string;
  model_version: string;
  prediction_type: ModelType;
  customer_id: string;
  value: string | number | null;
  band: 'low' | 'medium' | 'high' | null;
  confidence: string | number | null;
  top_features: AiPrediction['top_features'];
  input_snapshot: Record<string, unknown> | null;
  generated_at: string | Date;
  created_at: string | Date;
  created_by: string;
}

export class PgAiPredictionStore extends InMemoryAiPredictionStore {
  private initialised = false;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly pool: PgPoolLike, private readonly hydrateLimit = 5000) {
    super();
  }

  async init(): Promise<void> {
    if (this.initialised) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const { rows } = await this.pool.query<PredictionRow>(
        `SELECT prediction_id, tenant_id, model_id, model_version, prediction_type,
                customer_id, value, band, confidence, top_features, input_snapshot,
                generated_at, created_at, created_by
         FROM app_copilot.ai_predictions
         WHERE deleted_at IS NULL
         ORDER BY generated_at DESC
         LIMIT $1`,
        [this.hydrateLimit],
      );
      for (const r of rows) {
        const row: AiPrediction = {
          prediction_id: r.prediction_id,
          tenant_id: r.tenant_id,
          model_id: r.model_id,
          model_version: r.model_version,
          prediction_type: r.prediction_type,
          customer_id: r.customer_id,
          value: typeof r.value === 'string' ? parseFloat(r.value) : (r.value ?? 0),
          band: r.band,
          confidence:
            r.confidence === null
              ? null
              : typeof r.confidence === 'string'
                ? parseFloat(r.confidence)
                : r.confidence,
          top_features: Array.isArray(r.top_features) ? r.top_features : [],
          input_snapshot: r.input_snapshot,
          generated_at: typeof r.generated_at === 'string' ? r.generated_at : r.generated_at.toISOString(),
          created_at: typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString(),
          created_by: r.created_by,
        };
        // push to back since DB ordering is DESC; we'll re-sort via record's unshift
        // semantics if newer rows come in. For init load, push to the per-tenant arr
        // in DESC order (which is already the newest-first ordering record() expects).
        let arr = this.byTenant.get(row.tenant_id);
        if (!arr) {
          arr = [];
          this.byTenant.set(row.tenant_id, arr);
        }
        arr.push(row);
        this.byId.set(row.prediction_id, row);
      }
      this.initialised = true;
    })();
    return this.initPromise;
  }

  record(input: RecordPredictionInput, now: Date = new Date()): AiPrediction {
    const row = super.record(input, now);
    // Fire-and-forget pg INSERT — never blocks the response.
    // ON CONFLICT DO NOTHING handles the unlikely id collision during init replay.
    this.pool
      .query(
        `INSERT INTO app_copilot.ai_predictions
           (prediction_id, tenant_id, model_id, model_version, prediction_type,
            customer_id, value, band, confidence, top_features, input_snapshot,
            generated_at, created_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14)
         ON CONFLICT (prediction_id) DO NOTHING`,
        [
          row.prediction_id,
          row.tenant_id,
          row.model_id,
          row.model_version,
          row.prediction_type,
          row.customer_id,
          row.value,
          row.band,
          row.confidence,
          JSON.stringify(row.top_features),
          row.input_snapshot === null ? null : JSON.stringify(row.input_snapshot),
          row.generated_at,
          row.created_at,
          row.created_by,
        ],
      )
      .catch((e) => {
        console.error('[ai_predictions] background INSERT failed:', e);
      });
    return row;
  }
}

// ─── Env-gated factory ──────────────────────────────────────────────────

export function makeAiPredictionStore(env: NodeJS.ProcessEnv = process.env): AiPredictionStore {
  const pgUrl = env.BFF_PG_URL;
  if (!pgUrl) return new InMemoryAiPredictionStore();
  const pgModule = require('pg') as {
    Pool: new (opts: { connectionString: string; max?: number }) => PgPoolLike;
  };
  const pool = new pgModule.Pool({ connectionString: pgUrl, max: 3 });
  const store = new PgAiPredictionStore(pool);
  store.init().catch((e) => console.error('[ai_predictions] PgAiPredictionStore.init failed:', e));
  return store;
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultAiPredictionStore: AiPredictionStore = new InMemoryAiPredictionStore();
