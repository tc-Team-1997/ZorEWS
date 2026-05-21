// services/bff/src/customer_overlay_reader.ts
//
// B2 of v1.5+ unified.* consumer migration: pg-backed reader for the
// unified.customer_360 view. Two consumer patterns served:
//   1. List read — drives /api/customers (full migration to mart-backed
//      data; band-derived pd_score stopgap until B5 lands real PD).
//   2. Single-customer overlay — drives /api/customers/:id/risk +
//      /v1/risk-profile/:customer_id enrichment (open_alerts_count,
//      open_cases_count, latest_alert_at, has_blocking_caps signal,
//      pending_approvals_count). Additive — existing risk_profile
//      shape unchanged.
//
// Wiring policy matches B1: bootstrap probes unified.customer_360
// existence and wires reader on AppDeps.customerOverlayReader when
// available; undefined → routes fall through to existing stub.

import { Pool, type PoolClient } from 'pg';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

/** Row shape returned by the reader — mirrors unified.customer_360
 *  view columns (T4.25 spec §5.1 + reality-correction commit). */
export interface CustomerOverlayRow {
  tenant_id: string;
  customer_id: string;
  name: string;
  /** 'Low' / 'Medium' / 'High' text bucket (mart.customer_360.risk_rating). */
  risk_level: string | null;
  /** Total outstanding in KES (mart.total_outstanding). */
  exposure_kes: number;
  /** Worst days-past-due across loans (mart.worst_dpd). */
  dpd: number;
  kyc_status: string | null;
  segment: string | null;
  onboarded_at: string | null;
  /** Aggregate from app_alerts.alerts where status='open'. */
  open_alerts_count: number;
  max_criticality_score: number | null;
  latest_alert_at: string | null;
  open_cases_count: number;
  breached_sla_count: number;
  pending_approvals_count: number;
  last_activity_at: string | null;
}

/** Slim shape for the /api/customers list — projection of CustomerOverlayRow. */
export interface CustomerListItem {
  id: string;
  name: string;
  /** Band-derived synthetic PD (B2 stopgap; B5 replaces with real feature-store PD). */
  pd: number;
  /** Origin marker so callers know `pd` is a band approximation, not a real model output. */
  pd_source: 'band' | 'feature_store' | 'stub';
  level: 'Low' | 'Medium' | 'High';
  exposure: number;
  dpd: number;
  open_alerts_count: number;
  open_cases_count: number;
}

export type CustomerListFilters = {
  tenant_id: string;
  /** Optional risk_level narrow — comma-list ['Low', 'Medium', 'High'] subset. */
  levels?: string[];
  /** Optional minimum band-derived pd score (0..1). */
  pd_min?: number;
  /** Hard LIMIT — clamped to MAX_LIMIT (default 1000). */
  limit?: number;
};

export interface IUnifiedCustomer360Reader {
  /** Full row for one (tenant, customer); null when absent. */
  fetchOne(tenant_id: string, customer_id: string): Promise<CustomerOverlayRow | null>;
  /** List rows with filters; for the SPA customer list. */
  fetchList(filters: CustomerListFilters): Promise<CustomerListItem[]>;
}

export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 10_000;

/**
 * Pure helper: map risk_level text bucket → synthetic PD score (B2 stopgap).
 * When B5 lands real feature-store PD, callers swap to that source +
 * change pd_source: 'band' → 'feature_store'. This mapping is honest
 * about being a display-only approximation.
 *
 * Buckets:
 *   Low    → 0.2  (rough analog of 20% PD)
 *   Medium → 0.5  (50%)
 *   High   → 0.8  (80%)
 *   else   → 0.0  (unknown rating; sort-stable)
 */
export function bandToPdScore(risk_level: string | null | undefined): number {
  switch ((risk_level ?? '').toLowerCase()) {
    case 'low': return 0.2;
    case 'medium': return 0.5;
    case 'high': return 0.8;
    default: return 0;
  }
}

/** Normalise mart's risk_rating text into the SPA's 3-bucket enum. */
export function normalizeLevel(risk_level: string | null | undefined): 'Low' | 'Medium' | 'High' {
  const v = (risk_level ?? '').toLowerCase();
  if (v === 'high') return 'High';
  if (v === 'medium') return 'Medium';
  return 'Low';
}

// ---------------------------------------------------------------------
// Pg implementation
// ---------------------------------------------------------------------

const SELECT_ALL_COLS = `
  tenant_id, customer_id, name, risk_level, exposure_kes, dpd,
  kyc_status, segment, onboarded_at,
  open_alerts_count, max_criticality_score, latest_alert_at,
  open_cases_count, breached_sla_count, pending_approvals_count,
  last_activity_at
`;

export class PgUnifiedCustomer360Reader implements IUnifiedCustomer360Reader {
  constructor(private readonly pool: Pool | PoolClient) {}

  async fetchOne(tenant_id: string, customer_id: string): Promise<CustomerOverlayRow | null> {
    if (!tenant_id || tenant_id.trim() === '') {
      throw new Error('PgUnifiedCustomer360Reader.fetchOne: tenant_id required');
    }
    if (!customer_id || customer_id.trim() === '') {
      throw new Error('PgUnifiedCustomer360Reader.fetchOne: customer_id required');
    }
    const r = await this.pool.query(
      `SELECT ${SELECT_ALL_COLS}
         FROM unified.customer_360
        WHERE tenant_id = $1 AND customer_id = $2
        LIMIT 1`,
      [tenant_id, customer_id],
    );
    if (r.rowCount === 0) return null;
    return rowToCustomerOverlay(r.rows[0]);
  }

  async fetchList(filters: CustomerListFilters): Promise<CustomerListItem[]> {
    if (!filters.tenant_id || filters.tenant_id.trim() === '') {
      throw new Error('PgUnifiedCustomer360Reader.fetchList: tenant_id required');
    }
    const lim = Math.min(
      Math.max(1, Math.floor(filters.limit ?? DEFAULT_LIMIT)),
      MAX_LIMIT,
    );
    const params: unknown[] = [filters.tenant_id];
    let where = 'WHERE tenant_id = $1';
    if (filters.levels && filters.levels.length > 0) {
      // Mart's risk_rating is lowercase ('low'/'medium'/'high'); SPA
      // passes the same casing. Lower-case + IN for safety either way.
      params.push(filters.levels.map((l) => l.toLowerCase()));
      where += ` AND LOWER(risk_level) = ANY($${params.length}::text[])`;
    }
    params.push(lim);
    const sql = `
      SELECT ${SELECT_ALL_COLS}
        FROM unified.customer_360
        ${where}
        -- Sort by risk_level desc (High → Medium → Low) then exposure desc
        ORDER BY
          CASE LOWER(risk_level)
            WHEN 'high'   THEN 3
            WHEN 'medium' THEN 2
            WHEN 'low'    THEN 1
            ELSE 0
          END DESC,
          exposure_kes DESC NULLS LAST,
          customer_id ASC
        LIMIT $${params.length}
    `;
    const r = await this.pool.query(sql, params);
    const items = r.rows.map((row) => projectListItem(rowToCustomerOverlay(row)));
    // Apply pd_min filter post-projection (band-derived pd happens in JS).
    const pdMin = Number(filters.pd_min ?? 0);
    return Number.isFinite(pdMin) && pdMin > 0
      ? items.filter((it) => it.pd >= pdMin)
      : items;
  }
}

function rowToCustomerOverlay(row: Record<string, unknown>): CustomerOverlayRow {
  return {
    tenant_id: String(row.tenant_id),
    customer_id: String(row.customer_id),
    name: String(row.name ?? row.customer_id),
    risk_level: row.risk_level == null ? null : String(row.risk_level),
    exposure_kes: Number(row.exposure_kes ?? 0),
    dpd: Number(row.dpd ?? 0),
    kyc_status: row.kyc_status == null ? null : String(row.kyc_status),
    segment: row.segment == null ? null : String(row.segment),
    onboarded_at: dateToIso(row.onboarded_at),
    open_alerts_count: Number(row.open_alerts_count ?? 0),
    max_criticality_score:
      row.max_criticality_score == null ? null : Number(row.max_criticality_score),
    latest_alert_at: dateToIso(row.latest_alert_at),
    open_cases_count: Number(row.open_cases_count ?? 0),
    breached_sla_count: Number(row.breached_sla_count ?? 0),
    pending_approvals_count: Number(row.pending_approvals_count ?? 0),
    last_activity_at: dateToIso(row.last_activity_at),
  };
}

function dateToIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Project full overlay row → slim list item with band-derived pd. */
export function projectListItem(row: CustomerOverlayRow): CustomerListItem {
  return {
    id: row.customer_id,
    name: row.name,
    pd: bandToPdScore(row.risk_level),
    pd_source: 'band',
    level: normalizeLevel(row.risk_level),
    exposure: row.exposure_kes,
    dpd: row.dpd,
    open_alerts_count: row.open_alerts_count,
    open_cases_count: row.open_cases_count,
  };
}

/**
 * Probe + factory: returns the reader when unified.customer_360 exists;
 * else undefined. Mirrors makeUnifiedAlertsReader from B1.
 */
export async function makeUnifiedCustomer360Reader(
  pool: Pool | PoolClient | null | undefined,
): Promise<IUnifiedCustomer360Reader | undefined> {
  if (!pool) return undefined;
  try {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.views
        WHERE table_schema = 'unified' AND table_name = 'customer_360' LIMIT 1`,
    );
    if (r.rowCount === 1) return new PgUnifiedCustomer360Reader(pool);
    return undefined;
  } catch {
    return undefined;
  }
}

/** Env-aware bootstrap factory — mirrors makeUnifiedAlertsReaderFromEnv. */
export async function makeUnifiedCustomer360ReaderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<IUnifiedCustomer360Reader | undefined> {
  const url = env.BFF_PG_URL ?? env.ADMIN_PG_URL;
  if (!url) return undefined;
  const pool = new Pool({ connectionString: url, max: 2 });
  return makeUnifiedCustomer360Reader(pool);
}

/** Test stub. */
export class InMemoryUnifiedCustomer360Reader implements IUnifiedCustomer360Reader {
  constructor(private readonly rows: CustomerOverlayRow[]) {}
  async fetchOne(tenant_id: string, customer_id: string): Promise<CustomerOverlayRow | null> {
    return this.rows.find(
      (r) => r.tenant_id === tenant_id && r.customer_id === customer_id,
    ) ?? null;
  }
  async fetchList(filters: CustomerListFilters): Promise<CustomerListItem[]> {
    const lim = Math.min(
      Math.max(1, Math.floor(filters.limit ?? DEFAULT_LIMIT)),
      MAX_LIMIT,
    );
    let rows = this.rows.filter((r) => r.tenant_id === filters.tenant_id);
    if (filters.levels && filters.levels.length > 0) {
      const lowSet = new Set(filters.levels.map((l) => l.toLowerCase()));
      rows = rows.filter((r) => lowSet.has((r.risk_level ?? '').toLowerCase()));
    }
    const items = rows.slice(0, lim).map(projectListItem);
    const pdMin = Number(filters.pd_min ?? 0);
    return Number.isFinite(pdMin) && pdMin > 0
      ? items.filter((it) => it.pd >= pdMin)
      : items;
  }
}
