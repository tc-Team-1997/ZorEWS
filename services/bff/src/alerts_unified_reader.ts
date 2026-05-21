// services/bff/src/alerts_unified_reader.ts
//
// B1 of the v1.5+ unified.* consumer migration: pg-backed reader for the
// unified.alerts view. Returns AlertRow[] directly — no in-code customer
// or rule hydration (the view's SQL JOIN does it).
//
// Wiring policy: when BFF_PG_URL is set AND unified.alerts exists, the
// server bootstrap instantiates a PgUnifiedAlertsReader and stashes it
// on AppDeps. The 3 alert routes (server.ts:2740, 2838, 30628) check
// for the reader and use it when present; else fall through to the
// existing mapAlertList(source.read(), lookups, ...) path. Behaviorally
// identical AlertRow output either way (parity asserted by
// alerts_unified_reader_pg.test.ts).
//
// linked_alert_ids is populated post-fetch by the caller's existing
// dedupByCustomer() logic (criticality.ts) — not stored in the view.

import { Pool, type PoolClient } from 'pg';
import type { AlertRow, UiSeverity } from './types';

export type AlertReadFilters = {
  tenant_id: string;
  /** Optional severity narrow — when set, pushed into the SQL WHERE. */
  severity?: UiSeverity;
  /** Optional assignee narrow — when set, pushed into the SQL WHERE. */
  assignee?: string;
  /** Optional status narrow ('open' / 'acked' / 'closed'). */
  status?: string;
  /** Optional customer narrow — surfaces customer-scoped alert subsets. */
  customer_id?: string;
  /** Hard LIMIT clamp (default 1000; SPA + ops don't render past ~500). */
  limit?: number;
};

/** Interface so tests can inject a stub; production uses PgUnifiedAlertsReader. */
export interface IUnifiedAlertsReader {
  fetch(filters: AlertReadFilters): Promise<AlertRow[]>;
}

/** Hard upper bound on rows returned per call. */
export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 5000;

/**
 * Project unified.alerts into the AlertRow shape mapping.ts produces.
 *
 * Columns sourced verbatim from data/schema/035_unified_views.sql §5
 * (Section 5 of the migration). Stays in lock-step with the view DDL —
 * if the view's projection changes, this SELECT does too.
 *
 * `linked_alert_ids` always returns [] from the view (the dedup-derived
 * back-reference is a SPA-side concept, populated post-fetch).
 */
const SELECT_COLS = `
  alert_id,
  severity,
  customer_id,
  customer_name,
  rule_id,
  rule_name,
  indicators,
  confidence,
  customer_exposure_kes,
  criticality_score,
  assignee,
  created_at,
  age_minutes
`;

export class PgUnifiedAlertsReader implements IUnifiedAlertsReader {
  constructor(private readonly pool: Pool | PoolClient) {}

  async fetch(filters: AlertReadFilters): Promise<AlertRow[]> {
    if (!filters.tenant_id || filters.tenant_id.trim() === '') {
      // Match the BFF tenant-middleware contract — empty tenant_id is a
      // misconfiguration not a query state.
      throw new Error('PgUnifiedAlertsReader.fetch: tenant_id required');
    }

    const clauses: string[] = ['tenant_id = $1'];
    const params: unknown[] = [filters.tenant_id];
    let p = 2;

    if (filters.severity !== undefined) {
      clauses.push(`severity = $${p++}`);
      params.push(filters.severity);
    }
    if (filters.assignee !== undefined) {
      clauses.push(`assignee = $${p++}`);
      params.push(filters.assignee);
    }
    if (filters.status !== undefined) {
      clauses.push(`status = $${p++}`);
      params.push(filters.status);
    }
    if (filters.customer_id !== undefined) {
      clauses.push(`customer_id = $${p++}`);
      params.push(filters.customer_id);
    }

    const lim = Math.min(
      Math.max(1, Math.floor(filters.limit ?? DEFAULT_LIMIT)),
      MAX_LIMIT,
    );
    params.push(lim);

    const sql = `
      SELECT ${SELECT_COLS}
        FROM unified.alerts
       WHERE ${clauses.join(' AND ')}
       ORDER BY criticality_score DESC NULLS LAST, created_at DESC
       LIMIT $${p}
    `;

    const r = await this.pool.query(sql, params);
    return r.rows.map(rowToAlertRow);
  }
}

/** Pure helper — converts a unified.alerts row to the AlertRow contract. */
function rowToAlertRow(row: Record<string, unknown>): AlertRow {
  return {
    id: String(row.alert_id),
    severity: row.severity as UiSeverity,
    customer: {
      id: String(row.customer_id),
      name: String(row.customer_name ?? row.customer_id),
    },
    rule: {
      id: String(row.rule_id),
      name: String(row.rule_name ?? row.rule_id),
    },
    indicators: Array.isArray(row.indicators) ? (row.indicators as string[]) : [],
    age_min: Number.isFinite(row.age_minutes as number)
      ? Math.max(0, Math.floor(Number(row.age_minutes)))
      : 0,
    assignee: (row.assignee as string | null | undefined) ?? null,
    created_at:
      row.created_at instanceof Date
        ? (row.created_at as Date).toISOString()
        : String(row.created_at),
    confidence: Number(row.confidence ?? 0),
    customer_exposure_kes: Number(row.customer_exposure_kes ?? 0),
    criticality_score: Number(row.criticality_score ?? 0),
    linked_alert_ids: [], // populated post-fetch by criticality.ts dedup
  };
}

/**
 * Probe + factory: returns a PgUnifiedAlertsReader when the live database
 * has unified.alerts, else undefined. Called once at server bootstrap.
 *
 * The undefined path lets the existing in-memory + NDJSON reader keep
 * serving — additive, no breakage.
 */
export async function makeUnifiedAlertsReader(
  pool: Pool | PoolClient | null | undefined,
): Promise<IUnifiedAlertsReader | undefined> {
  if (!pool) return undefined;
  try {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.views
        WHERE table_schema = 'unified' AND table_name = 'alerts' LIMIT 1`,
    );
    if (r.rowCount === 1) {
      return new PgUnifiedAlertsReader(pool);
    }
    return undefined;
  } catch {
    // Pool unhealthy / not connected / network error — quietly fall back
    // to the existing path. Logged at bootstrap; not a startup-blocker.
    return undefined;
  }
}

/**
 * Env-aware bootstrap factory: reads BFF_PG_URL, creates a small pool,
 * probes for the view's presence, and returns a reader or undefined.
 * Mirrors `makeWebhookStore(env)` / `makeScenarioStore(env)` shape so
 * the server bootstrap pattern stays consistent.
 */
export async function makeUnifiedAlertsReaderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<IUnifiedAlertsReader | undefined> {
  const url = env.BFF_PG_URL ?? env.ADMIN_PG_URL;
  if (!url) return undefined;
  const pool = new Pool({ connectionString: url, max: 2 });
  return makeUnifiedAlertsReader(pool);
}

/** Test helper — used by parity tests + route tests to inject a stub. */
export class InMemoryUnifiedAlertsReader implements IUnifiedAlertsReader {
  constructor(private readonly rows: AlertRow[]) {}
  async fetch(filters: AlertReadFilters): Promise<AlertRow[]> {
    return this.rows.filter((r) => {
      if (filters.severity && r.severity !== filters.severity) return false;
      if (filters.assignee && r.assignee !== filters.assignee) return false;
      if (filters.customer_id && r.customer.id !== filters.customer_id) return false;
      return true;
    });
  }
}
