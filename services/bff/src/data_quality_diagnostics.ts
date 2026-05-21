// services/bff/src/data_quality_diagnostics.ts
//
// B6 of the v1.5+ unified.* consumer migration: read-only orphan-
// reference scanner. Surfaces the cases where unified.* views' LEFT
// JOIN resilience papers over an underlying FK-style mismatch, so
// ops can investigate without runtime hard-failures (the views still
// return rows; this diagnostic just lists what's "orphaned").
//
// Scope (v1):
//   1. cases_without_alert — app_cases.cases.alert_id ∉ app_alerts.alerts
//   2. alerts_without_customer — app_alerts.alerts.customer_id ∉ mart.customer_360
//   3. approvals_without_case — app_audit.approvals.correlation_id ∉ app_cases.cases
//      (only counted when correlation_id matches the case_id pattern;
//       approvals correlate to non-case subjects too, e.g. rule_promotion)
//
// Tenant-scoped. Read-only. No throws — empty input + adapter errors
// surface as zero counts, not exceptions.

import { Pool, type PoolClient } from 'pg';

export type OrphanClass =
  | 'cases_without_alert'
  | 'alerts_without_customer'
  | 'approvals_without_case';

export interface OrphanReferenceClassReport {
  /** Which orphan family this row describes. */
  class: OrphanClass;
  /** Total rows scanned in the parent table (after tenant filter). */
  total_scanned: number;
  /** Of those, how many failed the resolution check. */
  orphan_count: number;
  /** orphan_count / total_scanned, in [0, 1]; 0 when total_scanned = 0. */
  orphan_rate: number;
  /** First N orphan rows for SPA display (deterministic order: id ASC). */
  sample_orphans: OrphanSample[];
}

export interface OrphanSample {
  /** The parent row id (case_id / alert_id / approval_id). */
  parent_id: string;
  /** The unresolved reference value (alert_id / customer_id / case_id). */
  missing_ref: string;
  /** Best-effort context (e.g. case state, alert severity) for SPA chips. */
  context?: Record<string, unknown>;
}

export interface OrphanReferenceReport {
  tenant_id: string;
  generated_at: string;
  /** Sample cap echo (always honored even on the largest classes). */
  sample_cap: number;
  /** 3 entries — one per OrphanClass, in canonical order. */
  classes: OrphanReferenceClassReport[];
  /** Convenience rollup: SUM(orphan_count) across all 3 classes. */
  total_orphans: number;
  /** True iff total_orphans = 0 (SPA "all clear" banner). */
  is_clean: boolean;
}

export const DEFAULT_SAMPLE_CAP = 100;
export const MAX_SAMPLE_CAP = 500;

export const ALL_ORPHAN_CLASSES: readonly OrphanClass[] = [
  'cases_without_alert',
  'alerts_without_customer',
  'approvals_without_case',
] as const;

export type RunScanOptions = {
  tenant_id: string;
  /** Cap sample_orphans per class; clamped to [1, MAX_SAMPLE_CAP]. */
  sample_cap?: number;
  /** Override for tests — defaults to () => new Date(). */
  now?: () => Date;
};

/**
 * Run the 3-class orphan scan against the live pg database.
 *
 * Pure-ish: takes a Pool/PoolClient, does N=6 read-only queries (2
 * per class: count + sample), composes the report. Failures on any
 * one class are caught + surfaced as zero counts + an empty sample
 * — partial-degradation by design, so a flaky adapter on one class
 * doesn't blank the whole report.
 */
export async function runOrphanReferenceScan(
  pool: Pool | PoolClient,
  opts: RunScanOptions,
): Promise<OrphanReferenceReport> {
  if (!opts.tenant_id || opts.tenant_id.trim() === '') {
    throw new Error('runOrphanReferenceScan: tenant_id required');
  }
  const sample_cap = Math.min(
    Math.max(1, Math.floor(opts.sample_cap ?? DEFAULT_SAMPLE_CAP)),
    MAX_SAMPLE_CAP,
  );
  const now = (opts.now ?? (() => new Date()))();

  // Each scan returns a report block; errors → zero block.
  const cases_without_alert = await scanClass(
    pool,
    'cases_without_alert',
    opts.tenant_id,
    sample_cap,
    SQL_CASES_WITHOUT_ALERT,
  );
  const alerts_without_customer = await scanClass(
    pool,
    'alerts_without_customer',
    opts.tenant_id,
    sample_cap,
    SQL_ALERTS_WITHOUT_CUSTOMER,
  );
  const approvals_without_case = await scanClass(
    pool,
    'approvals_without_case',
    opts.tenant_id,
    sample_cap,
    SQL_APPROVALS_WITHOUT_CASE,
  );

  const classes = [cases_without_alert, alerts_without_customer, approvals_without_case];
  const total_orphans = classes.reduce((acc, c) => acc + c.orphan_count, 0);
  return {
    tenant_id: opts.tenant_id,
    generated_at: now.toISOString(),
    sample_cap,
    classes,
    total_orphans,
    is_clean: total_orphans === 0,
  };
}

// ---------------------------------------------------------------------
// SQL per class. Each definition declares 2 queries: COUNT_SQL +
// SAMPLE_SQL. The scanner runs them in sequence per class.
// ---------------------------------------------------------------------

type ClassSql = {
  /** SELECT (total_scanned, orphan_count) FROM ... WHERE tenant_id = $1 */
  COUNT_SQL: string;
  /** SELECT (parent_id, missing_ref, context_json) FROM ... WHERE tenant_id = $1 LIMIT $2 */
  SAMPLE_SQL: string;
};

const SQL_CASES_WITHOUT_ALERT: ClassSql = {
  COUNT_SQL: `
    SELECT
      COUNT(*)::int                                                  AS total_scanned,
      COUNT(*) FILTER (
        WHERE c.alert_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM app_alerts.alerts a
             WHERE a.alert_id = c.alert_id
          )
      )::int                                                          AS orphan_count
    FROM app_cases.cases c
    WHERE c.tenant_id = $1
  `,
  SAMPLE_SQL: `
    SELECT
      c.case_id                                                       AS parent_id,
      c.alert_id                                                      AS missing_ref,
      jsonb_build_object(
        'state', c.state,
        'severity', c.severity,
        'created_at', c.created_at
      )                                                                AS context_json
    FROM app_cases.cases c
    WHERE c.tenant_id = $1
      AND c.alert_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM app_alerts.alerts a
         WHERE a.alert_id = c.alert_id
      )
    ORDER BY c.case_id ASC
    LIMIT $2
  `,
};

const SQL_ALERTS_WITHOUT_CUSTOMER: ClassSql = {
  COUNT_SQL: `
    SELECT
      COUNT(*)::int                                                  AS total_scanned,
      COUNT(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1 FROM mart.customer_360 m
           WHERE m.tenant_id = a.tenant_id
             AND m.customer_id = a.customer_id
        )
      )::int                                                          AS orphan_count
    FROM app_alerts.alerts a
    WHERE a.tenant_id = $1
  `,
  SAMPLE_SQL: `
    SELECT
      a.alert_id                                                      AS parent_id,
      a.customer_id                                                   AS missing_ref,
      jsonb_build_object(
        'severity', a.severity,
        'status', a.status,
        'created_at', a.created_at
      )                                                                AS context_json
    FROM app_alerts.alerts a
    WHERE a.tenant_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM mart.customer_360 m
         WHERE m.tenant_id = a.tenant_id
           AND m.customer_id = a.customer_id
      )
    ORDER BY a.alert_id ASC
    LIMIT $2
  `,
};

// Approvals' correlation_id is a free-form text field — it carries
// case_id for CAS/CAP/escalate workflows + other shapes (rule_id,
// user_id) for non-case subject types. We only flag a correlation as
// "orphan" when subject_type signals it SHOULD resolve to a case.
const CASE_LIKE_SUBJECT_TYPES = `('cas', 'cap', 'case_close', 'case_escalate', 'case_override')`;

const SQL_APPROVALS_WITHOUT_CASE: ClassSql = {
  COUNT_SQL: `
    SELECT
      COUNT(*)::int                                                  AS total_scanned,
      COUNT(*) FILTER (
        WHERE ap.correlation_id IS NOT NULL
          AND ap.subject_type IN ${CASE_LIKE_SUBJECT_TYPES}
          AND NOT EXISTS (
            SELECT 1 FROM app_cases.cases c
             WHERE c.case_id = ap.correlation_id
               AND c.tenant_id = ap.tenant_id
          )
      )::int                                                          AS orphan_count
    FROM app_audit.approvals ap
    WHERE ap.tenant_id = $1
  `,
  SAMPLE_SQL: `
    SELECT
      ap.approval_id                                                  AS parent_id,
      ap.correlation_id                                               AS missing_ref,
      jsonb_build_object(
        'subject_type', ap.subject_type,
        'action', ap.action,
        'status', ap.status,
        'proposed_at', ap.proposed_at
      )                                                                AS context_json
    FROM app_audit.approvals ap
    WHERE ap.tenant_id = $1
      AND ap.correlation_id IS NOT NULL
      AND ap.subject_type IN ${CASE_LIKE_SUBJECT_TYPES}
      AND NOT EXISTS (
        SELECT 1 FROM app_cases.cases c
         WHERE c.case_id = ap.correlation_id
           AND c.tenant_id = ap.tenant_id
      )
    ORDER BY ap.approval_id ASC
    LIMIT $2
  `,
};

async function scanClass(
  pool: Pool | PoolClient,
  cls: OrphanClass,
  tenant_id: string,
  sample_cap: number,
  sql: ClassSql,
): Promise<OrphanReferenceClassReport> {
  try {
    const counts = await pool.query(sql.COUNT_SQL, [tenant_id]);
    const total_scanned = Number(counts.rows[0]?.total_scanned ?? 0);
    const orphan_count = Number(counts.rows[0]?.orphan_count ?? 0);

    let sample_orphans: OrphanSample[] = [];
    if (orphan_count > 0) {
      const samples = await pool.query(sql.SAMPLE_SQL, [tenant_id, sample_cap]);
      sample_orphans = samples.rows.map((r) => ({
        parent_id: String(r.parent_id),
        missing_ref: String(r.missing_ref),
        context: (r.context_json as Record<string, unknown>) ?? undefined,
      }));
    }

    return {
      class: cls,
      total_scanned,
      orphan_count,
      orphan_rate: total_scanned === 0 ? 0 : orphan_count / total_scanned,
      sample_orphans,
    };
  } catch {
    // Partial degradation: one class failing doesn't blank the report.
    // Log surface is the caller's job; here we just emit a zero block.
    return {
      class: cls,
      total_scanned: 0,
      orphan_count: 0,
      orphan_rate: 0,
      sample_orphans: [],
    };
  }
}

// ---------------------------------------------------------------------
// In-memory stub for hermetic tests (mirrors PgUnifiedAlertsReader pattern).
// ---------------------------------------------------------------------

export interface IOrphanScanner {
  run(opts: RunScanOptions): Promise<OrphanReferenceReport>;
}

export class PgOrphanScanner implements IOrphanScanner {
  constructor(private readonly pool: Pool | PoolClient) {}
  run(opts: RunScanOptions): Promise<OrphanReferenceReport> {
    return runOrphanReferenceScan(this.pool, opts);
  }
}

/**
 * Test-mode in-memory scanner — caller supplies the report it wants
 * the scanner to return. Used by route tests that don't have pg.
 */
export class InMemoryOrphanScanner implements IOrphanScanner {
  constructor(private readonly canned: OrphanReferenceReport) {}
  async run(_opts: RunScanOptions): Promise<OrphanReferenceReport> {
    return { ...this.canned, tenant_id: _opts.tenant_id };
  }
}

/**
 * Env-aware bootstrap factory: returns a PgOrphanScanner when BFF_PG_URL
 * (or ADMIN_PG_URL) is set, else undefined. Mirrors
 * makeUnifiedAlertsReaderFromEnv() shape from B1.
 */
export async function makeOrphanScannerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<IOrphanScanner | undefined> {
  const url = env.BFF_PG_URL ?? env.ADMIN_PG_URL;
  if (!url) return undefined;
  const pool = new Pool({ connectionString: url, max: 2 });
  return new PgOrphanScanner(pool);
}
