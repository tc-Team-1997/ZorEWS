// services/bff/src/scenario/store.ts
//
// Saved-scenario persistence. Same env-driven factory pattern as
// webhooks: BFF_PG_URL set → pg-backed; unset → in-memory.
//
// Why two stores: tests + the BFF dev server with no pg need a working
// store; the production target is `app_scenario.saved_scenarios`. The
// SPA talks to the BFF either way and never knows which is in play.

import { Pool } from 'pg';
import type { ScenarioResult, ShockInputs } from './types';

export interface SavedScenario {
  id: string;
  /** T4.24 Phase 4 — tenant the scenario belongs to. The (tenant_id,
   *  saved_by) composite is what list/get filter on. */
  tenant_id: string;
  name: string;
  saved_by: string;
  saved_at: string;
  inputs: ShockInputs;
  result: ScenarioResult;
}

/**
 * Both backends expose the same shape — server.ts duck-types against this.
 *
 * T4.24 Phase 4 — every method is tenant-scoped. Cross-tenant reads
 * return undefined; cross-tenant deletes return false. The route layer
 * passes `req.tenant.tenant_id` from the middleware.
 */
export interface IScenarioStore {
  /** Load existing rows into cache. No-op for in-memory. */
  init(): Promise<void>;
  list(filters: { tenant_id: string; saved_by?: string }): SavedScenario[];
  get(id: string, tenant_id: string): SavedScenario | undefined;
  save(input: {
    /** Optional client-supplied id. The SPA generates one locally so its
     *  cache entry doesn't get a different id than the server stores —
     *  see web/src/lib/savedScenarios.ts. Server generates one if absent. */
    id?: string;
    tenant_id: string;
    name: string;
    saved_by: string;
    inputs: ShockInputs;
    result: ScenarioResult;
  }): SavedScenario;
  delete(id: string, tenant_id: string): boolean;
  /** Re-insert a previously-archived scenario with its original ID +
   *  saved_at + saved_by. Used by the recovery adapter. Returns false
   *  when the id is already taken (route maps to 409). */
  restore(scenario: SavedScenario): boolean;
  /** Test-only — wipe everything. */
  reset(): Promise<void> | void;
}

/**
 * In-memory store. Used in tests + dev when BFF_PG_URL is unset.
 * Mirrors the SPA's localStorage cap so semantics are stable.
 */
export class InMemoryScenarioStore implements IScenarioStore {
  private readonly byId = new Map<string, SavedScenario>();

  async init(): Promise<void> {
    // no-op
  }

  list(filters: { tenant_id: string; saved_by?: string }): SavedScenario[] {
    const all = Array.from(this.byId.values()).filter(
      (s) => s.tenant_id === filters.tenant_id,
    );
    const filtered = filters.saved_by
      ? all.filter((s) => s.saved_by === filters.saved_by)
      : all;
    return filtered.sort((a, b) =>
      a.saved_at < b.saved_at ? 1 : a.saved_at > b.saved_at ? -1 : 0,
    );
  }

  get(id: string, tenant_id: string): SavedScenario | undefined {
    const s = this.byId.get(id);
    return s && s.tenant_id === tenant_id ? s : undefined;
  }

  save(input: {
    id?: string;
    tenant_id: string;
    name: string;
    saved_by: string;
    inputs: ShockInputs;
    result: ScenarioResult;
  }): SavedScenario {
    const trimmed = input.name.trim();
    if (!trimmed) throw httpError(400, 'name is required');
    const entry: SavedScenario = {
      id: input.id ?? `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenant_id: input.tenant_id,
      name: trimmed,
      saved_by: input.saved_by,
      saved_at: new Date().toISOString(),
      inputs: input.inputs,
      result: input.result,
    };
    this.byId.set(entry.id, entry);
    return entry;
  }

  delete(id: string, tenant_id: string): boolean {
    const s = this.byId.get(id);
    if (!s || s.tenant_id !== tenant_id) return false;
    return this.byId.delete(id);
  }

  restore(scenario: SavedScenario): boolean {
    if (this.byId.has(scenario.id)) return false;
    this.byId.set(scenario.id, { ...scenario });
    return true;
  }

  reset(): void {
    this.byId.clear();
  }
}

/**
 * Postgres-backed store. Same cache-on-init + sync reads + write-through
 * fire-and-forget pattern from T4.13–T4.17.
 *
 * Schema gotcha: `app_scenario.saved_scenarios` splits the shock inputs
 * into 3 columns (gdp_shock_pct, rate_shock_bps, fx_shock_pct) but stores
 * the full result as JSONB. We project on read/write — the in-memory
 * SavedScenario keeps the nested `inputs: { gdp, rate, fx }` shape that
 * the SPA expects.
 */
export class PgScenarioStore implements IScenarioStore {
  private readonly byId = new Map<string, SavedScenario>();

  constructor(
    private readonly pool: Pool,
    private readonly logger: (msg: string, err?: unknown) => void = (m, e) =>
      console.warn(`[pg-scenario-store] ${m}`, e ?? ''),
  ) {}

  async init(): Promise<void> {
    const rows = await this.pool.query<{
      scenario_id: string;
      tenant_id: string;
      name: string;
      saved_by: string;
      saved_at: Date;
      gdp_shock_pct: string; // NUMERIC arrives as string
      rate_shock_bps: number;
      fx_shock_pct: string;
      result: ScenarioResult;
    }>(
      `SELECT scenario_id, tenant_id, name, saved_by, saved_at,
              gdp_shock_pct::text AS gdp_shock_pct,
              rate_shock_bps,
              fx_shock_pct::text AS fx_shock_pct,
              result
         FROM app_scenario.saved_scenarios`,
    );
    this.byId.clear();
    for (const r of rows.rows) {
      this.byId.set(r.scenario_id, {
        id: r.scenario_id,
        tenant_id: r.tenant_id,
        name: r.name,
        saved_by: r.saved_by,
        saved_at: r.saved_at.toISOString(),
        inputs: {
          gdp: Number(r.gdp_shock_pct),
          rate: r.rate_shock_bps,
          fx: Number(r.fx_shock_pct),
        },
        result: r.result,
      });
    }
  }

  list(filters: { tenant_id: string; saved_by?: string }): SavedScenario[] {
    const all = Array.from(this.byId.values()).filter(
      (s) => s.tenant_id === filters.tenant_id,
    );
    const filtered = filters.saved_by
      ? all.filter((s) => s.saved_by === filters.saved_by)
      : all;
    return filtered.sort((a, b) =>
      a.saved_at < b.saved_at ? 1 : a.saved_at > b.saved_at ? -1 : 0,
    );
  }

  get(id: string, tenant_id: string): SavedScenario | undefined {
    const s = this.byId.get(id);
    return s && s.tenant_id === tenant_id ? s : undefined;
  }

  save(input: {
    id?: string;
    tenant_id: string;
    name: string;
    saved_by: string;
    inputs: ShockInputs;
    result: ScenarioResult;
  }): SavedScenario {
    const trimmed = input.name.trim();
    if (!trimmed) throw httpError(400, 'name is required');
    const entry: SavedScenario = {
      id: input.id ?? `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenant_id: input.tenant_id,
      name: trimmed,
      saved_by: input.saved_by,
      saved_at: new Date().toISOString(),
      inputs: input.inputs,
      result: input.result,
    };
    this.byId.set(entry.id, entry);
    void this.pool
      .query(
        `INSERT INTO app_scenario.saved_scenarios (
            scenario_id, tenant_id, name, saved_by, saved_at,
            gdp_shock_pct, rate_shock_bps, fx_shock_pct, result
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          entry.id,
          entry.tenant_id,
          entry.name,
          entry.saved_by,
          new Date(entry.saved_at),
          input.inputs.gdp,
          input.inputs.rate,
          input.inputs.fx,
          JSON.stringify(input.result),
        ],
      )
      .catch((err) => this.logger(`failed to insert scenario ${entry.id}`, err));
    return entry;
  }

  delete(id: string, tenant_id: string): boolean {
    const existing = this.byId.get(id);
    if (!existing || existing.tenant_id !== tenant_id) return false;
    this.byId.delete(id);
    void this.pool
      .query(`DELETE FROM app_scenario.saved_scenarios WHERE scenario_id = $1`, [id])
      .catch((err) => this.logger(`failed to delete scenario ${id}`, err));
    return true;
  }

  /** Re-insert a previously-archived scenario with its original ID +
   *  saved_at + saved_by. Cache + pg sync. ON CONFLICT DO NOTHING for
   *  defence-in-depth against cache/pg drift. */
  restore(scenario: SavedScenario): boolean {
    if (this.byId.has(scenario.id)) return false;
    this.byId.set(scenario.id, { ...scenario });
    void this.pool
      .query(
        `INSERT INTO app_scenario.saved_scenarios
           (scenario_id, tenant_id, name, saved_by, saved_at, gdp, rate, fx, result)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (scenario_id) DO NOTHING`,
        [
          scenario.id,
          scenario.tenant_id,
          scenario.name,
          scenario.saved_by,
          new Date(scenario.saved_at),
          scenario.inputs.gdp,
          scenario.inputs.rate,
          scenario.inputs.fx,
          JSON.stringify(scenario.result),
        ],
      )
      .catch((err) => this.logger(`failed to restore scenario ${scenario.id}`, err));
    return true;
  }

  async reset(): Promise<void> {
    await this.pool.query(`TRUNCATE app_scenario.saved_scenarios`);
    this.byId.clear();
  }
}

/**
 * Build the scenario store based on env. BFF_PG_URL set → pg-backed;
 * unset → in-memory. Reuses BFF_PG_URL (same DSN as the webhook store).
 */
export async function makeScenarioStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ store: IScenarioStore; pool: Pool | null }> {
  const url = env.BFF_PG_URL;
  if (!url) return { store: new InMemoryScenarioStore(), pool: null };
  const pool = new Pool({ connectionString: url, max: 4 });
  const store = new PgScenarioStore(pool);
  await store.init();
  return { store, pool };
}

function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}
