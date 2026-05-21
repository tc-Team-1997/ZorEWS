// services/bff/src/feature_store_pd_reader.ts
//
// B5 of v1.5+ unified.* consumer migration: PD enrichment shim that
// closes the loop on B2's `pd_source: 'band'` stopgap.
//
// B2 ships `bandToPdScore(risk_level)` which maps the mart text
// bucket ('low' / 'medium' / 'high') to a synthetic PD (0.2 / 0.5 /
// 0.8). The `pd_source: 'band'` field on every CustomerListItem
// signals to the SPA that the value is a band approximation, not a
// real model prediction.
//
// B5 lands the shim that lets the SPA flip to `pd_source:
// 'feature_store'` THE MOMENT T2.1 lands real PD data, with **zero
// change to the customer routes**. Strategy:
//
//   1. `IFeatureStorePdReader` interface with single batch fetch
//      method — returns `Map<customer_id, pd_score>`.
//   2. Route layer (B2 customer routes) calls the reader AFTER
//      `fetchList()` returns. For each row found in the map, the
//      pd_score replaces the band value + pd_source flips.
//   3. `PgFeatureStorePdReader` probes `feature_store.feature_values`
//      table for rows with `feature_name='pd_score'` (or equivalent
//      T2.1 column) — returns undefined when the table doesn't exist
//      yet, so today's bootstrap doesn't break.
//   4. Bootstrap probe in server.ts returns undefined until T2.1
//      ships the feature_store schema. When T2.1 lands, the probe
//      finds the table + wires the reader + the SPA's pd_source
//      flips automatically.
//
// **Critical contract guarantee**: the customer route behavior is
// **identical** when the reader is undefined (today) and when it's
// wired (post-T2.1). The only observable diff is the `pd_source`
// discriminator flipping for rows where real PD data exists.
//
// **Partial-coverage semantics**: when the feature_store has PD for
// SOME customers but not others (mid-rollout, or PD model only
// trained on certain segments), the SPA sees mixed `pd_source`
// values per row. That's correct + auditable.

import { Pool, type PoolClient } from 'pg';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface IFeatureStorePdReader {
  /** Single-customer PD lookup. Returns null when no row present. */
  fetchPd(tenant_id: string, customer_id: string): Promise<number | null>;
  /** Batch PD lookup. Returns a Map keyed by customer_id (only
   *  customers WITH a PD value appear in the map). */
  fetchPdBatch(tenant_id: string, customer_ids: string[]): Promise<Map<string, number>>;
}

// ---------------------------------------------------------------------
// Pg implementation
// ---------------------------------------------------------------------

/**
 * Reads PD scores from `feature_store.feature_values` using the
 * canonical T2.1 schema (customer_id + feature_name + value + as_of).
 * Always fetches the most-recent (`MAX(as_of)`) PD per customer.
 *
 * When T2.1 lands a different column shape, swap THIS class's query
 * — the interface contract stays stable.
 */
export class PgFeatureStorePdReader implements IFeatureStorePdReader {
  constructor(private readonly pool: Pool | PoolClient) {}

  async fetchPd(tenant_id: string, customer_id: string): Promise<number | null> {
    if (!tenant_id || tenant_id.trim() === '') {
      throw new Error('PgFeatureStorePdReader.fetchPd: tenant_id required');
    }
    if (!customer_id || customer_id.trim() === '') {
      throw new Error('PgFeatureStorePdReader.fetchPd: customer_id required');
    }
    const r = await this.pool.query(
      `SELECT value
         FROM feature_store.feature_values
        WHERE tenant_id = $1
          AND customer_id = $2
          AND feature_name = 'pd_score'
        ORDER BY as_of DESC
        LIMIT 1`,
      [tenant_id, customer_id],
    );
    if (r.rowCount === 0) return null;
    const v = Number(r.rows[0].value);
    return Number.isFinite(v) ? v : null;
  }

  async fetchPdBatch(
    tenant_id: string,
    customer_ids: string[],
  ): Promise<Map<string, number>> {
    if (!tenant_id || tenant_id.trim() === '') {
      throw new Error('PgFeatureStorePdReader.fetchPdBatch: tenant_id required');
    }
    const out = new Map<string, number>();
    if (customer_ids.length === 0) return out;
    // DISTINCT ON (customer_id) gives newest-as_of per customer in one query.
    const r = await this.pool.query(
      `SELECT DISTINCT ON (customer_id) customer_id, value
         FROM feature_store.feature_values
        WHERE tenant_id = $1
          AND feature_name = 'pd_score'
          AND customer_id = ANY($2::text[])
        ORDER BY customer_id, as_of DESC`,
      [tenant_id, customer_ids],
    );
    for (const row of r.rows) {
      const v = Number(row.value);
      if (Number.isFinite(v)) {
        out.set(String(row.customer_id), v);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------

/**
 * Probe for `feature_store.feature_values` existence. Returns reader
 * when found, undefined otherwise. **Today returns undefined for
 * every BFF instance** — T2.1 has not yet landed the table. When T2.1
 * ships, the probe will find the table + the reader will wire
 * automatically with no code change in server.ts.
 */
export async function makeFeatureStorePdReader(
  pool: Pool | PoolClient | null | undefined,
): Promise<IFeatureStorePdReader | undefined> {
  if (!pool) return undefined;
  try {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'feature_store'
          AND table_name = 'feature_values'
        LIMIT 1`,
    );
    if (r.rowCount === 1) return new PgFeatureStorePdReader(pool);
    return undefined;
  } catch {
    return undefined;
  }
}

/** Env-aware bootstrap factory. */
export async function makeFeatureStorePdReaderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<IFeatureStorePdReader | undefined> {
  const url = env.BFF_PG_URL ?? env.ADMIN_PG_URL;
  if (!url) return undefined;
  const pool = new Pool({ connectionString: url, max: 2 });
  return makeFeatureStorePdReader(pool);
}

// ---------------------------------------------------------------------
// Test stub
// ---------------------------------------------------------------------

export class InMemoryFeatureStorePdReader implements IFeatureStorePdReader {
  /** Seed: Map<tenant_id, Map<customer_id, pd>>. */
  constructor(
    private readonly data: Map<string, Map<string, number>>,
  ) {}

  async fetchPd(tenant_id: string, customer_id: string): Promise<number | null> {
    return this.data.get(tenant_id)?.get(customer_id) ?? null;
  }

  async fetchPdBatch(
    tenant_id: string,
    customer_ids: string[],
  ): Promise<Map<string, number>> {
    const tenantMap = this.data.get(tenant_id);
    const out = new Map<string, number>();
    if (!tenantMap) return out;
    for (const cid of customer_ids) {
      const v = tenantMap.get(cid);
      if (v !== undefined) out.set(cid, v);
    }
    return out;
  }
}

// ---------------------------------------------------------------------
// Enrichment helper (pure, no I/O) — used by the route layer to
// merge a batch PD lookup into the B2 list items.
// ---------------------------------------------------------------------

/**
 * Mutates each item: when the PD batch contains a value for the
 * item's id, replaces `pd` + flips `pd_source` from 'band' to
 * 'feature_store'. Otherwise leaves the item untouched (band path).
 *
 * Returns the same array (mutation is a deliberate optimisation —
 * the route layer just emitted the array from the reader, no other
 * consumer has the reference yet).
 */
export function enrichListItemsWithPd<
  T extends { id: string; pd: number; pd_source: 'band' | 'feature_store' | 'stub' },
>(items: T[], pdMap: Map<string, number>): T[] {
  for (const item of items) {
    const v = pdMap.get(item.id);
    if (v !== undefined) {
      item.pd = v;
      item.pd_source = 'feature_store';
    }
  }
  return items;
}
