// services/bff/src/feature_store.ts
//
// T2.1.1 — Feature store catalog + point-in-time + history queries.
//
// Closes the surface-layer half of T2.1 ("Feature store with 24-mo
// backfill of synthetic data"). The contract a real Aurora-backed
// feature store would satisfy:
//
//   getFeatureCatalog()                              → catalog
//   getFeatureSnapshot(tenant, entity_id, at)        → point-in-time row
//   getFeatureHistory(tenant, entity_id, feature, w) → time series
//
// Today this is in-memory + deterministic-synthesis (FNV-1a + Mulberry32
// per (tenant, entity, feature, day) — same scheme as T5.5 FinOps + X.4
// adoption + the BIL dashboard builders). Production swap = Aurora
// schema `feature_store.feature_values` with the same query interface;
// the BFF doesn't move when the persistence layer changes.
//
// Scope: 24-month rolling window (the T2.1 spec) over 8 PD-model
// features matching `ml/data/load_from_mart.py` so the training pipeline
// can pivot from "current mart snapshot" to "as-of point-in-time" once
// the swap lands. The features here are the SAME ones the model already
// consumes — no new features-of-features layering.

// ─── Catalog ──────────────────────────────────────────────────────────

/** 8 PD-model feature names matching `ml/data/load_from_mart.py`. */
export const ALL_FEATURE_NAMES = [
  'utilization',
  'dpd_max_90d',
  'bureau_score',
  'repayment_delay_streak',
  'txn_volume_zscore_90d',
  'tenure_months',
  'product_level',
  'income_level',
] as const;

export type FeatureName = (typeof ALL_FEATURE_NAMES)[number];

export function isFeatureName(v: unknown): v is FeatureName {
  return typeof v === 'string' && (ALL_FEATURE_NAMES as readonly string[]).includes(v);
}

export type FeatureValueType = 'number' | 'integer' | 'enum';

export interface FeatureDef {
  name: FeatureName;
  display_name: string;
  description: string;
  value_type: FeatureValueType;
  /** Stable range [min, max] used by the deterministic synthesiser
   *  AND by query consumers for client-side validation. */
  range: [number, number];
  /** Closed enum for categorical features (encoded as 0..N-1). Empty
   *  for non-enum. */
  enum_labels: ReadonlyArray<string>;
  /** Marks features the PD model treats as risk-positive (higher = worse). */
  risk_polarity: 'higher_is_worse' | 'lower_is_worse' | 'neutral';
}

export const FEATURE_CATALOG: ReadonlyArray<FeatureDef> = [
  {
    name: 'utilization',
    display_name: 'Exposure-to-income utilization',
    description: 'Credit exposure / monthly income, clamped to [0, 1.5].',
    value_type: 'number',
    range: [0, 1.5],
    enum_labels: [],
    risk_polarity: 'higher_is_worse',
  },
  {
    name: 'dpd_max_90d',
    display_name: 'Max DPD (90d)',
    description: 'Worst days-past-due in trailing 90 days.',
    value_type: 'integer',
    range: [0, 180],
    enum_labels: [],
    risk_polarity: 'higher_is_worse',
  },
  {
    name: 'bureau_score',
    display_name: 'Bureau score',
    description: 'Credit bureau score (300..900 typical band).',
    value_type: 'integer',
    range: [300, 900],
    enum_labels: [],
    risk_polarity: 'lower_is_worse',
  },
  {
    name: 'repayment_delay_streak',
    display_name: 'Repayment delay streak',
    description: 'Consecutive months with late payment (0 = current).',
    value_type: 'integer',
    range: [0, 24],
    enum_labels: [],
    risk_polarity: 'higher_is_worse',
  },
  {
    name: 'txn_volume_zscore_90d',
    display_name: 'Transaction-volume z-score (90d)',
    description: 'Z-score of monthly txn volume vs 90d window. Negative = drop.',
    value_type: 'number',
    range: [-3, 3],
    enum_labels: [],
    risk_polarity: 'lower_is_worse',
  },
  {
    name: 'tenure_months',
    display_name: 'Tenure months',
    description: 'Months since customer onboarding.',
    value_type: 'integer',
    range: [0, 240],
    enum_labels: [],
    risk_polarity: 'lower_is_worse',
  },
  {
    name: 'product_level',
    display_name: 'Product type (encoded)',
    description: 'Categorical encoding of the loan product family.',
    value_type: 'enum',
    range: [0, 4],
    enum_labels: ['PL_RET', 'AUTO_RET', 'INV_SME', 'WC_SME', 'CORP_TL'],
    risk_polarity: 'neutral',
  },
  {
    name: 'income_level',
    display_name: 'Income band (encoded)',
    description: 'Categorical encoding of monthly income band.',
    value_type: 'enum',
    range: [0, 4],
    enum_labels: ['<25k', '25-50k', '50-100k', '100-250k', '250k+'],
    risk_polarity: 'neutral',
  },
];

export function getFeatureDef(name: FeatureName): FeatureDef {
  const def = FEATURE_CATALOG.find((d) => d.name === name);
  if (!def) throw new FeatureStoreError('unknown_feature', `unknown feature: ${name}`);
  return def;
}

// ─── Errors ───────────────────────────────────────────────────────────

export class FeatureStoreError extends Error {
  override name = 'FeatureStoreError';
  constructor(
    public code:
      | 'invalid_input'
      | 'unknown_feature'
      | 'invalid_date'
      | 'invalid_window'
      | 'window_too_long',
    message: string,
  ) {
    super(message);
  }
}

// ─── Synthesis (FNV-1a + Mulberry32) ─────────────────────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 0x100000000;
  };
}

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Pure synthesiser — deterministic per (tenant, entity, feature, day).
 *  Production swap = Aurora SELECT against `feature_store.feature_values`. */
export function synthFeatureValue(
  tenant_id: string,
  entity_id: string,
  feature_name: FeatureName,
  at: Date,
): number {
  const def = getFeatureDef(feature_name);
  const key = `${tenant_id}|${entity_id}|${feature_name}|${utcDayKey(at)}`;
  const rng = mulberry32(fnv1a(key));
  const [lo, hi] = def.range;
  const r = rng();

  switch (def.value_type) {
    case 'enum': {
      // Stable per-(entity, feature) — enum doesn't move daily; pin
      // off (tenant, entity, feature) without the day so the value
      // is constant across the 24-mo window for a given customer.
      const stableKey = `${tenant_id}|${entity_id}|${feature_name}`;
      const stableRng = mulberry32(fnv1a(stableKey));
      return Math.floor(stableRng() * def.enum_labels.length);
    }
    case 'integer':
      // For tenure: monotonically increasing — entity_id seeds the
      // starting tenure, observed_at adds elapsed days/30.
      if (feature_name === 'tenure_months') {
        const baseKey = `${tenant_id}|${entity_id}|tenure_base`;
        const baseRng = mulberry32(fnv1a(baseKey));
        const baseTenure = Math.floor(baseRng() * 60); // 0..60 months on day-0
        const days = Math.max(0, Math.floor((at.getTime() - Date.parse(EPOCH)) / 86_400_000));
        return Math.min(hi, baseTenure + Math.floor(days / 30));
      }
      return Math.min(hi, Math.max(lo, Math.round(lo + r * (hi - lo))));
    default:
      return Math.min(hi, Math.max(lo, lo + r * (hi - lo)));
  }
}

// Synthesiser epoch — tenure starts ticking from here.
const EPOCH = '2024-01-01T00:00:00Z';

// ─── Query primitives ────────────────────────────────────────────────

export interface FeatureSnapshotRow {
  entity_id: string;
  observed_at: string;
  features: Record<FeatureName, number>;
}

export interface FeatureHistoryPoint {
  observed_at: string;
  value: number;
}

export interface FeatureHistory {
  tenant_id: string;
  entity_id: string;
  feature_name: FeatureName;
  since: string;
  until: string;
  count: number;
  points: FeatureHistoryPoint[];
  /** Convenience aggregates over the window. */
  min: number | null;
  max: number | null;
  mean: number | null;
  first_value: number | null;
  last_value: number | null;
  trend: 'rising' | 'falling' | 'flat' | null;
}

const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseIso(s: string, code: 'invalid_date'): Date {
  if (typeof s !== 'string' || !ISO_DATETIME_RE.test(s)) {
    throw new FeatureStoreError(code, `malformed ISO-8601: ${s}`);
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new FeatureStoreError(code, `unparseable: ${s}`);
  return new Date(ms);
}

/** 24-month backfill window. */
export const MAX_HISTORY_WINDOW_DAYS = 24 * 31; // generous month rounding
export const DEFAULT_HISTORY_WINDOW_DAYS = 90;

/** Returns the full feature row at a point-in-time. */
export function getFeatureSnapshot(
  tenant_id: string,
  entity_id: string,
  at: Date,
): FeatureSnapshotRow {
  if (!tenant_id) throw new FeatureStoreError('invalid_input', 'tenant_id required');
  if (!entity_id) throw new FeatureStoreError('invalid_input', 'entity_id required');
  const features = {} as Record<FeatureName, number>;
  for (const f of ALL_FEATURE_NAMES) {
    features[f] = synthFeatureValue(tenant_id, entity_id, f, at);
  }
  return {
    entity_id,
    observed_at: at.toISOString(),
    features,
  };
}

/** Daily-sampled time series of one feature across a [since, until] window. */
export function getFeatureHistory(
  tenant_id: string,
  entity_id: string,
  feature_name: FeatureName,
  since: Date,
  until: Date,
): FeatureHistory {
  if (!tenant_id) throw new FeatureStoreError('invalid_input', 'tenant_id required');
  if (!entity_id) throw new FeatureStoreError('invalid_input', 'entity_id required');
  if (!isFeatureName(feature_name)) {
    throw new FeatureStoreError('unknown_feature', `unknown feature: ${feature_name}`);
  }
  if (since.getTime() > until.getTime()) {
    throw new FeatureStoreError('invalid_window', 'since must be <= until');
  }
  const days = Math.floor((until.getTime() - since.getTime()) / 86_400_000);
  if (days > MAX_HISTORY_WINDOW_DAYS) {
    throw new FeatureStoreError(
      'window_too_long',
      `window exceeds ${MAX_HISTORY_WINDOW_DAYS}-day cap (24mo)`,
    );
  }
  // Sample daily — production might down-sample at >180 days, but the
  // synthesis is fast enough that we just emit all points.
  const points: FeatureHistoryPoint[] = [];
  for (let t = since.getTime(); t <= until.getTime(); t += 86_400_000) {
    const at = new Date(t);
    points.push({
      observed_at: at.toISOString(),
      value: synthFeatureValue(tenant_id, entity_id, feature_name, at),
    });
  }
  const values = points.map((p) => p.value);
  const count = points.length;
  const min = count > 0 ? Math.min(...values) : null;
  const max = count > 0 ? Math.max(...values) : null;
  const mean =
    count > 0 ? Math.round((values.reduce((s, v) => s + v, 0) / count) * 1_000_000) / 1_000_000 : null;
  const first_value = points[0]?.value ?? null;
  const last_value = points[points.length - 1]?.value ?? null;
  let trend: FeatureHistory['trend'] = null;
  if (first_value !== null && last_value !== null) {
    // 5% relative threshold; otherwise flat. Enums always flat (stable).
    const def = getFeatureDef(feature_name);
    if (def.value_type === 'enum') {
      trend = 'flat';
    } else {
      const abs = Math.abs(first_value);
      const delta = last_value - first_value;
      const rel = abs > 0 ? delta / abs : delta;
      if (rel > 0.05) trend = 'rising';
      else if (rel < -0.05) trend = 'falling';
      else trend = 'flat';
    }
  }
  return {
    tenant_id,
    entity_id,
    feature_name,
    since: since.toISOString(),
    until: until.toISOString(),
    count,
    points,
    min,
    max,
    mean,
    first_value,
    last_value,
    trend,
  };
}

// ─── Coverage stats ──────────────────────────────────────────────────

export interface FeatureCoverageStats {
  tenant_id: string;
  generated_at: string;
  catalog_size: number;
  /** Day-zero of the synthesiser — production swap returns the
   *  earliest `observed_at` in `feature_store.feature_values`. */
  earliest_observed_at: string;
  latest_observed_at: string;
  window_days: number;
  /** Number of distinct customer ids registered with the store —
   *  for the synthesis path this is "unbounded; on-demand". */
  total_entities_seeded: number | 'unbounded_synthetic';
  features: ReadonlyArray<FeatureDef>;
}

export function buildFeatureCoverageStats(tenant_id: string, now: Date): FeatureCoverageStats {
  const cutoff = new Date(now.getTime() - MAX_HISTORY_WINDOW_DAYS * 86_400_000);
  return {
    tenant_id,
    generated_at: now.toISOString(),
    catalog_size: FEATURE_CATALOG.length,
    earliest_observed_at: cutoff.toISOString(),
    latest_observed_at: now.toISOString(),
    window_days: MAX_HISTORY_WINDOW_DAYS,
    total_entities_seeded: 'unbounded_synthetic',
    features: FEATURE_CATALOG,
  };
}

// ─── Convenience parsers for route handlers ──────────────────────────

export function parseHistoryWindow(
  sinceRaw: string | undefined,
  untilRaw: string | undefined,
  now: Date,
): { since: Date; until: Date } {
  const until = untilRaw ? parseIso(untilRaw, 'invalid_date') : now;
  const since = sinceRaw
    ? parseIso(sinceRaw, 'invalid_date')
    : new Date(until.getTime() - DEFAULT_HISTORY_WINDOW_DAYS * 86_400_000);
  return { since, until };
}

export function parseSnapshotAt(atRaw: string | undefined, now: Date): Date {
  return atRaw ? parseIso(atRaw, 'invalid_date') : now;
}

// ─── Persistence (T2.1.3 — Aurora swap) ──────────────────────────────
//
// IFeatureStore is the abstraction used by route handlers. The default
// path uses the deterministic synthesiser (T2.1.1) so dev mode + tests
// run without external infra. Production sets FEATURE_STORE_PG_URL and
// the PgFeatureStore takes over — same response shapes, real data.
//
// pg client + Pool are imported lazily so the synth path doesn't drag
// the dependency into test runs.

export interface IFeatureStore {
  getSnapshot(tenant_id: string, entity_id: string, at: Date): Promise<FeatureSnapshotRow>;
  getHistory(
    tenant_id: string,
    entity_id: string,
    feature_name: FeatureName,
    since: Date,
    until: Date,
  ): Promise<FeatureHistory>;
  coverage(tenant_id: string, now: Date): Promise<FeatureCoverageStats>;
}

/** Synth-backed impl wrapping the existing pure functions. Identity
 *  for the dev / test path — preserves the T2.1.1 behaviour. */
export class SynthFeatureStore implements IFeatureStore {
  async getSnapshot(tenant_id: string, entity_id: string, at: Date): Promise<FeatureSnapshotRow> {
    return getFeatureSnapshot(tenant_id, entity_id, at);
  }
  async getHistory(
    tenant_id: string,
    entity_id: string,
    feature_name: FeatureName,
    since: Date,
    until: Date,
  ): Promise<FeatureHistory> {
    return getFeatureHistory(tenant_id, entity_id, feature_name, since, until);
  }
  async coverage(tenant_id: string, now: Date): Promise<FeatureCoverageStats> {
    return buildFeatureCoverageStats(tenant_id, now);
  }
}

/** Pg-backed impl satisfying the same shape. Uses `feature_store.feature_values`
 *  per data/schema/034_feature_store.sql. Falls back to synth when no rows
 *  exist for the (tenant, entity, feature) — keeps the dev surface alive
 *  while real backfill is in progress. */
export class PgFeatureStore implements IFeatureStore {
  // The `pool` is typed as unknown so we don't require pg as a hard import
  // here — production wires it via makeFeatureStore() below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private pool: any) {}

  async getSnapshot(tenant_id: string, entity_id: string, at: Date): Promise<FeatureSnapshotRow> {
    if (!tenant_id) throw new FeatureStoreError('invalid_input', 'tenant_id required');
    if (!entity_id) throw new FeatureStoreError('invalid_input', 'entity_id required');
    // Query the catalog feature_names + latest value at-or-before `at`.
    const sql = `
      SELECT DISTINCT ON (feature_name)
        feature_name,
        value::double precision AS value
      FROM feature_store.feature_values
      WHERE tenant_id = $1
        AND entity_id = $2
        AND observed_at <= $3
      ORDER BY feature_name, observed_at DESC
    `;
    const result = await this.pool.query(sql, [tenant_id, entity_id, at.toISOString()]);
    const features = {} as Record<FeatureName, number>;
    const seen = new Set<string>();
    for (const row of result.rows ?? []) {
      const fname = row.feature_name as FeatureName;
      if (!isFeatureName(fname)) continue;
      features[fname] = Number(row.value);
      seen.add(fname);
    }
    // Fill any missing catalog features from synth (graceful fallback
    // during partial-backfill). Production with a complete backfill
    // returns every row from the SELECT above.
    for (const f of ALL_FEATURE_NAMES) {
      if (!seen.has(f)) features[f] = synthFeatureValue(tenant_id, entity_id, f, at);
    }
    return { entity_id, observed_at: at.toISOString(), features };
  }

  async getHistory(
    tenant_id: string,
    entity_id: string,
    feature_name: FeatureName,
    since: Date,
    until: Date,
  ): Promise<FeatureHistory> {
    if (!tenant_id) throw new FeatureStoreError('invalid_input', 'tenant_id required');
    if (!entity_id) throw new FeatureStoreError('invalid_input', 'entity_id required');
    if (!isFeatureName(feature_name)) {
      throw new FeatureStoreError('unknown_feature', `unknown feature: ${feature_name}`);
    }
    if (since.getTime() > until.getTime()) {
      throw new FeatureStoreError('invalid_window', 'since must be <= until');
    }
    const days = Math.floor((until.getTime() - since.getTime()) / 86_400_000);
    if (days > MAX_HISTORY_WINDOW_DAYS) {
      throw new FeatureStoreError('window_too_long', `window exceeds ${MAX_HISTORY_WINDOW_DAYS}-day cap`);
    }
    const sql = `
      SELECT observed_at, value::double precision AS value
      FROM feature_store.feature_values
      WHERE tenant_id = $1 AND entity_id = $2 AND feature_name = $3
        AND observed_at >= $4 AND observed_at <= $5
      ORDER BY observed_at ASC
    `;
    const result = await this.pool.query(sql, [
      tenant_id,
      entity_id,
      feature_name,
      since.toISOString(),
      until.toISOString(),
    ]);
    const points: FeatureHistoryPoint[] = (result.rows ?? []).map((r: { observed_at: Date; value: number }) => ({
      observed_at: new Date(r.observed_at).toISOString(),
      value: Number(r.value),
    }));
    // If no data, fall back to synth (matches getSnapshot fallback).
    if (points.length === 0) {
      return getFeatureHistory(tenant_id, entity_id, feature_name, since, until);
    }
    const values = points.map((p) => p.value);
    const count = points.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const mean = Math.round((values.reduce((s, v) => s + v, 0) / count) * 1_000_000) / 1_000_000;
    const first_value = points[0].value;
    const last_value = points[points.length - 1].value;
    const def = getFeatureDef(feature_name);
    let trend: FeatureHistory['trend'] = null;
    if (def.value_type === 'enum') {
      trend = 'flat';
    } else {
      const abs = Math.abs(first_value);
      const delta = last_value - first_value;
      const rel = abs > 0 ? delta / abs : delta;
      if (rel > 0.05) trend = 'rising';
      else if (rel < -0.05) trend = 'falling';
      else trend = 'flat';
    }
    return {
      tenant_id,
      entity_id,
      feature_name,
      since: since.toISOString(),
      until: until.toISOString(),
      count,
      points,
      min,
      max,
      mean,
      first_value,
      last_value,
      trend,
    };
  }

  async coverage(tenant_id: string, now: Date): Promise<FeatureCoverageStats> {
    // Coverage stats blend live pg counts (when present) with the
    // 24-month synth window envelope. earliest_observed_at is the
    // earliest row in the table for this tenant, falling back to
    // (now - 24mo) when empty.
    const sql = `
      SELECT
        COUNT(DISTINCT entity_id)::int AS distinct_entities,
        MIN(observed_at) AS earliest,
        MAX(observed_at) AS latest
      FROM feature_store.feature_values
      WHERE tenant_id = $1
    `;
    const result = await this.pool.query(sql, [tenant_id]);
    const row = result.rows?.[0] as { distinct_entities: number; earliest: Date | null; latest: Date | null } | undefined;
    const fallback = buildFeatureCoverageStats(tenant_id, now);
    if (!row || row.distinct_entities === 0) return fallback;
    return {
      ...fallback,
      earliest_observed_at: row.earliest ? new Date(row.earliest).toISOString() : fallback.earliest_observed_at,
      latest_observed_at: row.latest ? new Date(row.latest).toISOString() : fallback.latest_observed_at,
      total_entities_seeded: row.distinct_entities,
    };
  }
}

/** Env-gated factory. FEATURE_STORE_PG_URL set → PgFeatureStore;
 *  unset → SynthFeatureStore (the T2.1.1 dev/test path). The pg client
 *  is imported lazily so test runs without pg installed still load. */
export async function makeFeatureStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ store: IFeatureStore; pool: unknown }> {
  const url = env.FEATURE_STORE_PG_URL;
  if (!url) return { store: new SynthFeatureStore(), pool: null };
  // Lazy import — avoids dragging pg into the synth path.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require('pg') as typeof import('pg');
  const pool = new Pool({ connectionString: url, max: 4 });
  return { store: new PgFeatureStore(pool), pool };
}

