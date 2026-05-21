// services/bff/src/audit_activity_unified_reader.ts
//
// B3 of v1.5+ unified.* consumer migration: pg-backed reader for the
// unified.audit_activity view. Distinct from B1/B2/B4 — this is NOT
// a migration of an existing route. The view UNIONs 3 different pg
// audit chains (audit.event_log WORM hash chain + app_iam.audit_events
// auth-svc local + app_audit.approvals maker-checker), none of which
// had a unified read surface on the BFF before today.
//
// The M15.1 BIL `defaultAuditTrailStore` is a SEPARATE in-memory
// audit ledger driving /v1/audit/* routes — its hash-chain contract
// is preserved untouched. B3 is purely additive: a new admin route
// at /v1/admin/audit-activity that lets operators query across all 3
// pg-backed chains in one call (useful for regulator evidence
// requests, cross-chain timeline reconstruction, "show me everything
// that happened to case X across approvals + WORM + auth"
// workflows).
//
// Wiring pattern matches B6: undefined → 501 EWS_501_not_available
// (no fallback because no prior route shape exists); pg present →
// reader wired + queries the view directly.

import { Pool, type PoolClient } from 'pg';

// ---------------------------------------------------------------------
// Types — mirror unified.audit_activity view columns (T4.25 spec §5.4).
// ---------------------------------------------------------------------

/** Closed enum: which underlying audit chain the row came from. */
export type AuditActivitySource = 'chain' | 'auth_local' | 'approval';

export const ALL_AUDIT_ACTIVITY_SOURCES: AuditActivitySource[] = [
  'chain',
  'auth_local',
  'approval',
];

export interface AuditActivityEvent {
  source: AuditActivitySource;
  tenant_id: string;
  /** Source-specific id cast to TEXT for UNION compatibility. */
  event_id: string;
  /** ISO-8601 string (event_ts / occurred_at / proposed_at normalised). */
  ts: string;
  /** Actor that performed the event (actor / actor_username / maker normalised). */
  actor: string | null;
  /** Verb (event_type / action normalised). */
  action: string;
  /** Resource type acted on; NULL for chain rows, 'user' for auth_local, subject_type for approval. */
  resource_type: string | null;
  /** Resource id; subject_id for chain/approval, target_username for auth_local. */
  resource_id: string | null;
  /** Currently approval status only; NULL for other sources. */
  outcome: string | null;
  /** Reserved for future severity classification (NULL today per view DDL). */
  severity: string | null;
  /** chain.correlation_id / approval.correlation_id; NULL for auth_local. */
  correlation_id: string | null;
  /** Source-specific JSONB payload (payload / detail / payload). */
  metadata: Record<string, unknown> | null;
}

export type AuditActivityFilters = {
  tenant_id: string;
  /** Source narrow — single or comma-list of {chain, auth_local, approval}. */
  source?: AuditActivitySource[];
  actor?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  correlation_id?: string;
  /** ISO-8601 datetime lower bound (inclusive). */
  since?: string;
  /** ISO-8601 datetime upper bound (inclusive). */
  until?: string;
  /** Hard LIMIT — clamped to MAX_LIMIT. */
  limit?: number;
};

export interface IUnifiedAuditActivityReader {
  fetchActivity(filters: AuditActivityFilters): Promise<AuditActivityEvent[]>;
  /** Convenience: full cross-source timeline for a correlation_id. */
  fetchByCorrelationId(
    tenant_id: string,
    correlation_id: string,
    limit?: number,
  ): Promise<AuditActivityEvent[]>;
}

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 5000;

// ---------------------------------------------------------------------
// Pg implementation
// ---------------------------------------------------------------------

const SELECT_COLS = `
  source, tenant_id, event_id, ts, actor, action,
  resource_type, resource_id, outcome, severity,
  correlation_id, metadata
`;

export function isAuditActivitySource(v: unknown): v is AuditActivitySource {
  return typeof v === 'string' && (ALL_AUDIT_ACTIVITY_SOURCES as string[]).includes(v);
}

export class PgUnifiedAuditActivityReader implements IUnifiedAuditActivityReader {
  constructor(private readonly pool: Pool | PoolClient) {}

  async fetchActivity(filters: AuditActivityFilters): Promise<AuditActivityEvent[]> {
    if (!filters.tenant_id || filters.tenant_id.trim() === '') {
      throw new Error('PgUnifiedAuditActivityReader.fetchActivity: tenant_id required');
    }
    const lim = Math.min(
      Math.max(1, Math.floor(filters.limit ?? DEFAULT_LIMIT)),
      MAX_LIMIT,
    );
    const params: unknown[] = [filters.tenant_id];
    let where = 'WHERE tenant_id = $1';
    if (filters.source && filters.source.length > 0) {
      // Validate every source — reject bogus enum values defensively.
      for (const s of filters.source) {
        if (!isAuditActivitySource(s)) {
          throw new Error(
            `PgUnifiedAuditActivityReader.fetchActivity: invalid source '${String(s)}'`,
          );
        }
      }
      params.push(filters.source);
      where += ` AND source = ANY($${params.length}::text[])`;
    }
    if (filters.actor !== undefined) {
      params.push(filters.actor);
      where += ` AND actor = $${params.length}`;
    }
    if (filters.action !== undefined) {
      params.push(filters.action);
      where += ` AND action = $${params.length}`;
    }
    if (filters.resource_type !== undefined) {
      params.push(filters.resource_type);
      where += ` AND resource_type = $${params.length}`;
    }
    if (filters.resource_id !== undefined) {
      params.push(filters.resource_id);
      where += ` AND resource_id = $${params.length}`;
    }
    if (filters.correlation_id !== undefined) {
      params.push(filters.correlation_id);
      where += ` AND correlation_id = $${params.length}`;
    }
    if (filters.since !== undefined) {
      params.push(filters.since);
      where += ` AND ts >= $${params.length}::timestamptz`;
    }
    if (filters.until !== undefined) {
      params.push(filters.until);
      where += ` AND ts <= $${params.length}::timestamptz`;
    }
    params.push(lim);
    const sql = `
      SELECT ${SELECT_COLS}
        FROM unified.audit_activity
        ${where}
        -- Newest-first: regulators + ops always want recent activity.
        -- Tie-break on (source, event_id) for stable cursor pagination.
        ORDER BY ts DESC NULLS LAST, source ASC, event_id ASC
        LIMIT $${params.length}
    `;
    const r = await this.pool.query(sql, params);
    return r.rows.map(rowToEvent);
  }

  async fetchByCorrelationId(
    tenant_id: string,
    correlation_id: string,
    limit?: number,
  ): Promise<AuditActivityEvent[]> {
    if (!tenant_id || tenant_id.trim() === '') {
      throw new Error('PgUnifiedAuditActivityReader.fetchByCorrelationId: tenant_id required');
    }
    if (!correlation_id || correlation_id.trim() === '') {
      throw new Error(
        'PgUnifiedAuditActivityReader.fetchByCorrelationId: correlation_id required',
      );
    }
    const lim = Math.min(
      Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)),
      MAX_LIMIT,
    );
    // Oldest-first so the SPA renders the workflow ladder top→bottom.
    const r = await this.pool.query(
      `SELECT ${SELECT_COLS}
         FROM unified.audit_activity
        WHERE tenant_id = $1 AND correlation_id = $2
        ORDER BY ts ASC NULLS LAST, source ASC, event_id ASC
        LIMIT $3`,
      [tenant_id, correlation_id, lim],
    );
    return r.rows.map(rowToEvent);
  }
}

function rowToEvent(row: Record<string, unknown>): AuditActivityEvent {
  const src = String(row.source);
  if (!isAuditActivitySource(src)) {
    // Defensive — view is a closed enum but guard against drift.
    throw new Error(`Unknown audit_activity source: ${src}`);
  }
  return {
    source: src,
    tenant_id: String(row.tenant_id),
    event_id: String(row.event_id),
    ts: dateToIso(row.ts) ?? '',
    actor: row.actor == null ? null : String(row.actor),
    action: String(row.action),
    resource_type: row.resource_type == null ? null : String(row.resource_type),
    resource_id: row.resource_id == null ? null : String(row.resource_id),
    outcome: row.outcome == null ? null : String(row.outcome),
    severity: row.severity == null ? null : String(row.severity),
    correlation_id: row.correlation_id == null ? null : String(row.correlation_id),
    metadata:
      row.metadata == null
        ? null
        : (row.metadata as Record<string, unknown>),
  };
}

function dateToIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// ---------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------

/**
 * Probe the view's existence; return reader when found, undefined
 * otherwise. Mirrors makeUnifiedAlertsReader / makeUnifiedCasesReader.
 */
export async function makeUnifiedAuditActivityReader(
  pool: Pool | PoolClient | null | undefined,
): Promise<IUnifiedAuditActivityReader | undefined> {
  if (!pool) return undefined;
  try {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.views
        WHERE table_schema = 'unified' AND table_name = 'audit_activity' LIMIT 1`,
    );
    if (r.rowCount === 1) return new PgUnifiedAuditActivityReader(pool);
    return undefined;
  } catch {
    return undefined;
  }
}

/** Env-aware bootstrap factory. */
export async function makeUnifiedAuditActivityReaderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<IUnifiedAuditActivityReader | undefined> {
  const url = env.BFF_PG_URL ?? env.ADMIN_PG_URL;
  if (!url) return undefined;
  const pool = new Pool({ connectionString: url, max: 2 });
  return makeUnifiedAuditActivityReader(pool);
}

// ---------------------------------------------------------------------
// Test stub
// ---------------------------------------------------------------------

export class InMemoryUnifiedAuditActivityReader implements IUnifiedAuditActivityReader {
  constructor(private readonly events: AuditActivityEvent[]) {}

  async fetchActivity(filters: AuditActivityFilters): Promise<AuditActivityEvent[]> {
    if (!filters.tenant_id || filters.tenant_id.trim() === '') {
      throw new Error('InMemoryUnifiedAuditActivityReader.fetchActivity: tenant_id required');
    }
    const lim = Math.min(
      Math.max(1, Math.floor(filters.limit ?? DEFAULT_LIMIT)),
      MAX_LIMIT,
    );
    let rows = this.events.filter((e) => e.tenant_id === filters.tenant_id);
    if (filters.source && filters.source.length > 0) {
      const sources = new Set(filters.source);
      rows = rows.filter((e) => sources.has(e.source));
    }
    if (filters.actor !== undefined) rows = rows.filter((e) => e.actor === filters.actor);
    if (filters.action !== undefined) rows = rows.filter((e) => e.action === filters.action);
    if (filters.resource_type !== undefined)
      rows = rows.filter((e) => e.resource_type === filters.resource_type);
    if (filters.resource_id !== undefined)
      rows = rows.filter((e) => e.resource_id === filters.resource_id);
    if (filters.correlation_id !== undefined)
      rows = rows.filter((e) => e.correlation_id === filters.correlation_id);
    if (filters.since !== undefined) {
      const lo = Date.parse(filters.since);
      rows = rows.filter((e) => Date.parse(e.ts) >= lo);
    }
    if (filters.until !== undefined) {
      const hi = Date.parse(filters.until);
      rows = rows.filter((e) => Date.parse(e.ts) <= hi);
    }
    // Newest-first
    rows.sort((a, b) => {
      const cmp = Date.parse(b.ts) - Date.parse(a.ts);
      if (cmp !== 0) return cmp;
      if (a.source !== b.source) return a.source < b.source ? -1 : 1;
      return a.event_id < b.event_id ? -1 : 1;
    });
    return rows.slice(0, lim);
  }

  async fetchByCorrelationId(
    tenant_id: string,
    correlation_id: string,
    limit?: number,
  ): Promise<AuditActivityEvent[]> {
    if (!tenant_id || tenant_id.trim() === '') {
      throw new Error('InMemoryUnifiedAuditActivityReader.fetchByCorrelationId: tenant_id required');
    }
    if (!correlation_id || correlation_id.trim() === '') {
      throw new Error(
        'InMemoryUnifiedAuditActivityReader.fetchByCorrelationId: correlation_id required',
      );
    }
    const lim = Math.min(
      Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)),
      MAX_LIMIT,
    );
    const rows = this.events.filter(
      (e) => e.tenant_id === tenant_id && e.correlation_id === correlation_id,
    );
    rows.sort((a, b) => {
      const cmp = Date.parse(a.ts) - Date.parse(b.ts);
      if (cmp !== 0) return cmp;
      if (a.source !== b.source) return a.source < b.source ? -1 : 1;
      return a.event_id < b.event_id ? -1 : 1;
    });
    return rows.slice(0, lim);
  }
}
