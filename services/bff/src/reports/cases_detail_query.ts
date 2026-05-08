// services/bff/src/reports/cases_detail_query.ts
//
// Cases Report (BAC §3.1.8) — row-level detail with the same SLA
// breach math the dashboard SLA Breach Matrix uses (BAC §3.1.9.1.4).
//
// Two implementations behind one interface:
//   - InMemory: filters cms_cases + sla_config in JS. Used by tests
//     + dev fallback when no Pg pool is wired.
//   - Pg: runs the SQL plan from the Step 1 design (CTE +
//     specific-then-fallback resolver, age-bucket filter inline).
//
// Pure-ish: the in-memory query is a pure function of its inputs
// (cases, configs, users, filters). Exporters live alongside but are
// pure too — easy to unit-test.

import { Pool } from 'pg';
import {
  buildSlaConfigIndex,
  type Priority,
  type SlaConfig,
} from '../dashboard/sla_breach_matrix';

export type AgeBucket = '0-7d' | '8-30d' | '31-90d' | '90+d' | 'ALL';
export type Severity = 'high' | 'medium' | 'low';
export type ExportFormat = 'json' | 'csv' | 'xlsx' | 'pdf';

const SORT_WHITELIST = [
  'created_at',
  'age_days',
  'sla_target_days',
  'priority',
  'status',
  'case_number',
  'severity',
] as const;
export type SortColumn = (typeof SORT_WHITELIST)[number];

export interface CasesDetailFilter {
  ageBucket?: Exclude<AgeBucket, 'ALL'>;
  breached?: boolean;
  from?: string;     // ISO 8601, filter created_at >=
  to?: string;       // ISO 8601, filter created_at <=
  branch?: string;
  status?: string[]; // CSV expansion at the route layer
  severity?: Severity[];
  q?: string;        // ILIKE on case_number / title
  sort?: SortColumn;
  dir?: 'asc' | 'desc';
  page?: number;
  page_size?: number;
}

export interface CaseRow {
  case_id: string;
  case_number: string;
  borrower: { id: string | null; name: string | null };
  product: string | null;          // case_category for now
  case_category: string | null;
  priority: Priority;
  severity: Severity;
  status: string;
  created_at: string;
  age_days: number;
  age_bucket: Exclude<AgeBucket, 'ALL'>;
  sla_target_days: number | null;
  is_breached: boolean;
  assigned_to: string | null;
  assignee_display_name: string | null;
  branch: string | null;
  alert_id: string | null;
  tags: string[];
}

export interface CasesDetailReport {
  items: CaseRow[];
  total: number;
  page: number;
  page_size: number;
  filters_applied: CasesDetailFilter;
  generated_at: string;
  tenant_id: string;
}

// ── Helpers (pure) ──────────────────────────────────────────────────

const PRIORITY_TO_SEVERITY: Record<Priority, Severity> = {
  P1: 'high', P2: 'medium', P3: 'medium', P4: 'low',
};

function bucketFor(ageDays: number): Exclude<AgeBucket, 'ALL'> {
  if (ageDays <= 7) return '0-7d';
  if (ageDays <= 30) return '8-30d';
  if (ageDays <= 90) return '31-90d';
  return '90+d';
}

export function isValidSortColumn(s: unknown): s is SortColumn {
  return typeof s === 'string' && (SORT_WHITELIST as readonly string[]).includes(s);
}

// ── Inputs the in-memory path needs ─────────────────────────────────

export interface InMemoryInputs {
  /** cms_cases rows for the tenant. */
  cases: Array<{
    case_id: string;
    case_number: string;
    title: string;
    case_category: string | null;
    priority: Priority;
    status: string;
    created_at: string;
    alert_id: string | null;
    assigned_to: string | null;
    tags: string[];
  }>;
  /** ACTIVE sla_config for the tenant. */
  configs: SlaConfig[];
  /** username/user_id → display_name + branch (for the assignee join). */
  users: Map<string, { display_name: string | null; branch: string | null }>;
  /** alert_id → customer { id, name } for the borrower join. */
  customers: Map<string, { id: string; name: string }>;
}

/**
 * Pure function: project + filter + sort + paginate.
 * Used by tests + dev fallback. Pg path mirrors the same predicates.
 */
export function runCasesDetailReportInMemory(
  tenant_id: string,
  inputs: InMemoryInputs,
  filter: CasesDetailFilter,
  asOf: Date,
): CasesDetailReport {
  const resolveTarget = buildSlaConfigIndex(inputs.configs);
  const asOfMs = asOf.getTime();
  const projected: CaseRow[] = inputs.cases.map((c) => {
    const created = Date.parse(c.created_at);
    const ageDays = Number.isFinite(created)
      ? Math.max(0, (asOfMs - created) / 86_400_000)
      : 0;
    const target = resolveTarget(tenant_id, c.case_category, c.priority, null);
    const severity = PRIORITY_TO_SEVERITY[c.priority];
    const borrower = c.alert_id ? inputs.customers.get(c.alert_id) : undefined;
    const userInfo = c.assigned_to ? inputs.users.get(c.assigned_to) : undefined;
    return {
      case_id: c.case_id,
      case_number: c.case_number,
      borrower: { id: borrower?.id ?? null, name: borrower?.name ?? null },
      product: c.case_category, // alias for now
      case_category: c.case_category,
      priority: c.priority,
      severity,
      status: c.status,
      created_at: c.created_at,
      age_days: Math.round(ageDays * 100) / 100,
      age_bucket: bucketFor(ageDays),
      sla_target_days: target ?? null,
      is_breached:
        target !== undefined && ageDays > target && c.status !== 'CLOSED',
      assigned_to: c.assigned_to,
      assignee_display_name: userInfo?.display_name ?? null,
      branch: userInfo?.branch ?? null,
      alert_id: c.alert_id,
      tags: [...c.tags],
    };
  });

  const filtered = projected.filter((r) => {
    if (filter.ageBucket && r.age_bucket !== filter.ageBucket) return false;
    if (filter.breached === true && !r.is_breached) return false;
    if (filter.from && r.created_at < filter.from) return false;
    if (filter.to && r.created_at > filter.to) return false;
    if (filter.branch && r.branch !== filter.branch) return false;
    if (filter.status && filter.status.length > 0 && !filter.status.includes(r.status))
      return false;
    if (filter.severity && filter.severity.length > 0 && !filter.severity.includes(r.severity))
      return false;
    if (filter.q) {
      const q = filter.q.toLowerCase();
      // Match case_number; the title isn't projected but borrower.name + case_number cover it
      const hay = `${r.case_number} ${r.borrower.name ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const sortCol: SortColumn = filter.sort ?? 'created_at';
  const dir: 1 | -1 = filter.dir === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    let av: string | number = '';
    let bv: string | number = '';
    if (sortCol === 'age_days') { av = a.age_days; bv = b.age_days; }
    else if (sortCol === 'sla_target_days') {
      av = a.sla_target_days ?? Number.POSITIVE_INFINITY;
      bv = b.sla_target_days ?? Number.POSITIVE_INFINITY;
    }
    else if (sortCol === 'priority') { av = a.priority; bv = b.priority; }
    else if (sortCol === 'status') { av = a.status; bv = b.status; }
    else if (sortCol === 'case_number') { av = a.case_number; bv = b.case_number; }
    else if (sortCol === 'severity') { av = a.severity; bv = b.severity; }
    else { av = a.created_at; bv = b.created_at; }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });

  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, filter.page_size ?? 50));
  const start = (page - 1) * pageSize;
  return {
    items: filtered.slice(start, start + pageSize),
    total: filtered.length,
    page,
    page_size: pageSize,
    filters_applied: filter,
    generated_at: asOf.toISOString(),
    tenant_id,
  };
}

// ── Pg implementation ──────────────────────────────────────────────

export interface CasesDetailSource {
  run(tenant_id: string, filter: CasesDetailFilter, asOf: Date): Promise<CasesDetailReport>;
}

/**
 * Pg-backed query — runs the SQL plan from the Step 1 design.
 * Same predicates as the in-memory path; pagination + sort are
 * SQL-level so the breach filter doesn't lose rows across pages.
 */
export class PgCasesDetailSource implements CasesDetailSource {
  constructor(
    private readonly pool: Pool,
    /** Borrower lookup — derived from a separate `alerts × customers`
     *  view today; join into the query when those tables land. For
     *  the prototype, the route hands in a static map. */
    private readonly borrowerByAlertId: (alert_id: string) => { id: string; name: string } | undefined,
  ) {}

  async run(tenant_id: string, filter: CasesDetailFilter, asOf: Date): Promise<CasesDetailReport> {
    const sortCol: SortColumn = isValidSortColumn(filter.sort) ? filter.sort : 'created_at';
    const dir = filter.dir === 'asc' ? 'ASC' : 'DESC';
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, filter.page_size ?? 50));
    const offset = (page - 1) * pageSize;

    // Map sort column → SQL expression. Whitelist already validated above.
    const sortExprMap: Record<SortColumn, string> = {
      created_at: 'cwt.created_at',
      age_days: 'cwt.age_days',
      sla_target_days: 'cwt.sla_target_days NULLS LAST',
      priority: 'cwt.priority',
      status: 'cwt.status',
      case_number: 'cwt.case_number',
      severity:
        // Sort severity by weight, not alphabetically
        "CASE cwt.priority WHEN 'P1' THEN 3 WHEN 'P2' THEN 2 WHEN 'P3' THEN 2 WHEN 'P4' THEN 1 END",
    };

    // Build dynamic args. Order matters — PG positional placeholders.
    const args: unknown[] = [tenant_id];
    const ageBucket = filter.ageBucket ?? null;
    args.push(ageBucket);
    args.push(filter.breached === true);
    args.push(filter.from ?? null);
    args.push(filter.to ?? null);
    args.push(filter.branch ?? null);
    args.push(filter.status && filter.status.length > 0 ? filter.status : null);
    args.push(
      filter.severity && filter.severity.length > 0 ? filter.severity : null,
    );
    args.push(filter.q ?? null);
    args.push(pageSize);
    args.push(offset);

    // The CTE matches the Step 1 SQL plan verbatim.
    const baseSql = `
WITH cases_with_target AS (
  SELECT
    c.case_id, c.case_number, c.tenant_id, c.title, c.case_category,
    c.priority, c.status, c.created_at, c.updated_at,
    c.alert_id, c.assigned_to, c.tags, c.is_locked,
    EXTRACT(EPOCH FROM (now() - c.created_at)) / 86400.0 AS age_days,
    COALESCE(
      (SELECT sla_target_days FROM app_admin.sla_config sc
        WHERE sc.tenant_id = c.tenant_id
          AND sc.case_category = c.case_category
          AND sc.priority = c.priority
          AND sc.business_unit IS NULL
          AND sc.status = 'ACTIVE'),
      (SELECT sla_target_days FROM app_admin.sla_config sc
        WHERE sc.tenant_id = c.tenant_id
          AND sc.case_category = 'default_fallback'
          AND sc.priority = c.priority
          AND sc.business_unit IS NULL
          AND sc.status = 'ACTIVE')
    ) AS sla_target_days
  FROM app_cases.cms_cases c
  WHERE c.tenant_id = $1
)
SELECT cwt.*,
       CASE
         WHEN cwt.age_days <= 7  THEN '0-7d'
         WHEN cwt.age_days <= 30 THEN '8-30d'
         WHEN cwt.age_days <= 90 THEN '31-90d'
         ELSE '90+d'
       END AS age_bucket,
       (cwt.sla_target_days IS NOT NULL
        AND cwt.age_days > cwt.sla_target_days
        AND cwt.status NOT IN ('CLOSED')) AS is_breached,
       CASE cwt.priority
         WHEN 'P1' THEN 'high'
         WHEN 'P2' THEN 'medium'
         WHEN 'P3' THEN 'medium'
         WHEN 'P4' THEN 'low'
       END AS severity,
       u.branch AS assignee_branch,
       u.display_name AS assignee_display_name
  FROM cases_with_target cwt
  LEFT JOIN app_iam.users u
         ON u.username = cwt.assigned_to OR u.user_id = cwt.assigned_to
 WHERE ($2::text IS NULL OR
        CASE
          WHEN cwt.age_days <= 7  THEN '0-7d'
          WHEN cwt.age_days <= 30 THEN '8-30d'
          WHEN cwt.age_days <= 90 THEN '31-90d'
          ELSE '90+d'
        END = $2)
   AND ($3::boolean = FALSE OR (
          cwt.sla_target_days IS NOT NULL
          AND cwt.age_days > cwt.sla_target_days
          AND cwt.status NOT IN ('CLOSED')
        ))
   AND ($4::timestamptz IS NULL OR cwt.created_at >= $4)
   AND ($5::timestamptz IS NULL OR cwt.created_at <= $5)
   AND ($6::text IS NULL OR u.branch = $6)
   AND ($7::text[] IS NULL OR cwt.status = ANY($7::text[]))
   AND ($8::text[] IS NULL OR (
          CASE cwt.priority
            WHEN 'P1' THEN 'high'
            WHEN 'P2' THEN 'medium'
            WHEN 'P3' THEN 'medium'
            WHEN 'P4' THEN 'low'
          END
        ) = ANY($8::text[]))
   AND ($9::text IS NULL OR
          cwt.case_number ILIKE '%' || $9 || '%' OR
          cwt.title       ILIKE '%' || $9 || '%')`;

    const dataSql = `${baseSql}
 ORDER BY ${sortExprMap[sortCol]} ${dir}, cwt.case_id ASC
 LIMIT $10 OFFSET $11`;

    // Count query — same WHERE, no LIMIT/ORDER, no pagination args
    const countSql = baseSql.replace(/^SELECT cwt\.\*,[\s\S]+?(?=  FROM cases_with_target)/, 'SELECT count(*) AS c\n  ').replace('SELECT count(*) AS c\n  ', 'SELECT count(*) AS c FROM cases_with_target cwt\n  LEFT JOIN app_iam.users u\n         ON u.username = cwt.assigned_to OR u.user_id = cwt.assigned_to\n WHERE ');
    // Robust count fallback: re-build inline.
    const countWhereSql = `
WITH cases_with_target AS (
  SELECT c.tenant_id, c.case_category, c.priority, c.status, c.created_at,
         c.alert_id, c.assigned_to, c.case_number, c.title,
         EXTRACT(EPOCH FROM (now() - c.created_at)) / 86400.0 AS age_days,
         COALESCE(
           (SELECT sla_target_days FROM app_admin.sla_config sc
             WHERE sc.tenant_id = c.tenant_id AND sc.case_category = c.case_category
               AND sc.priority = c.priority AND sc.business_unit IS NULL
               AND sc.status = 'ACTIVE'),
           (SELECT sla_target_days FROM app_admin.sla_config sc
             WHERE sc.tenant_id = c.tenant_id AND sc.case_category = 'default_fallback'
               AND sc.priority = c.priority AND sc.business_unit IS NULL
               AND sc.status = 'ACTIVE')
         ) AS sla_target_days
    FROM app_cases.cms_cases c
   WHERE c.tenant_id = $1
)
SELECT count(*)::int AS c
  FROM cases_with_target cwt
  LEFT JOIN app_iam.users u
         ON u.username = cwt.assigned_to OR u.user_id = cwt.assigned_to
 WHERE ($2::text IS NULL OR
        CASE
          WHEN cwt.age_days <= 7  THEN '0-7d'
          WHEN cwt.age_days <= 30 THEN '8-30d'
          WHEN cwt.age_days <= 90 THEN '31-90d'
          ELSE '90+d'
        END = $2)
   AND ($3::boolean = FALSE OR (
          cwt.sla_target_days IS NOT NULL
          AND cwt.age_days > cwt.sla_target_days
          AND cwt.status NOT IN ('CLOSED')
        ))
   AND ($4::timestamptz IS NULL OR cwt.created_at >= $4)
   AND ($5::timestamptz IS NULL OR cwt.created_at <= $5)
   AND ($6::text IS NULL OR u.branch = $6)
   AND ($7::text[] IS NULL OR cwt.status = ANY($7::text[]))
   AND ($8::text[] IS NULL OR (
          CASE cwt.priority
            WHEN 'P1' THEN 'high' WHEN 'P2' THEN 'medium'
            WHEN 'P3' THEN 'medium' WHEN 'P4' THEN 'low'
          END
        ) = ANY($8::text[]))
   AND ($9::text IS NULL OR
          cwt.case_number ILIKE '%' || $9 || '%' OR
          cwt.title       ILIKE '%' || $9 || '%')`;
    void countSql;

    const countArgs = args.slice(0, 9); // first 9 placeholders, drop limit/offset
    const [dataRes, countRes] = await Promise.all([
      this.pool.query(dataSql, args),
      this.pool.query<{ c: number }>(countWhereSql, countArgs),
    ]);
    const total = Number(countRes.rows[0]?.c ?? 0);

    const items: CaseRow[] = dataRes.rows.map((row) => {
      const r = row as Record<string, unknown>;
      const alertId = r.alert_id ? String(r.alert_id) : null;
      const borrower = alertId ? this.borrowerByAlertId(alertId) : undefined;
      const tags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
      return {
        case_id: String(r.case_id),
        case_number: String(r.case_number),
        borrower: { id: borrower?.id ?? null, name: borrower?.name ?? null },
        product: r.case_category ? String(r.case_category) : null,
        case_category: r.case_category ? String(r.case_category) : null,
        priority: r.priority as Priority,
        severity: String(r.severity) as Severity,
        status: String(r.status),
        created_at: (r.created_at as Date).toISOString(),
        age_days: Math.round(Number(r.age_days) * 100) / 100,
        age_bucket: String(r.age_bucket) as Exclude<AgeBucket, 'ALL'>,
        sla_target_days: r.sla_target_days != null ? Number(r.sla_target_days) : null,
        is_breached: Boolean(r.is_breached),
        assigned_to: r.assigned_to ? String(r.assigned_to) : null,
        assignee_display_name: r.assignee_display_name ? String(r.assignee_display_name) : null,
        branch: r.assignee_branch ? String(r.assignee_branch) : null,
        alert_id: alertId,
        tags: [...tags],
      };
    });

    return {
      items,
      total,
      page,
      page_size: pageSize,
      filters_applied: filter,
      generated_at: asOf.toISOString(),
      tenant_id,
    };
  }
}

// ── Bootstrap factory ──────────────────────────────────────────────
//
// Returns a Pg-backed source when BFF_PG_URL (or ADMIN_PG_URL) is set,
// otherwise an in-memory adapter that pulls from the default CMS store.

export async function makeCasesDetailSource(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ source: CasesDetailSource; pool: Pool | null }> {
  const url = env.BFF_PG_URL ?? env.ADMIN_PG_URL;
  if (!url) {
    // In-memory fallback: empty inputs (the default CMS case store has
    // its own envelope and the prototype doesn't unify these types yet).
    // The Pg path is the production surface; the route still works in
    // dev — it just returns an empty report.
    const source: CasesDetailSource = {
      async run(tenant_id, filter, asOf) {
        return runCasesDetailReportInMemory(
          tenant_id,
          {
            cases: [],
            configs: [],
            users: new Map(),
            customers: new Map(),
          },
          filter,
          asOf,
        );
      },
    };
    return { source, pool: null };
  }
  const pool = new Pool({ connectionString: url, max: 4 });
  const source = new PgCasesDetailSource(pool, () => undefined);
  return { source, pool };
}
