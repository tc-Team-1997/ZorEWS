// services/bff/src/dashboard/sla_breach_matrix.ts
//
// SLA Breach Matrix — BAC §3.1.6 / §3.1.9.1.4 dashboard widget.
//
// Pure resolver + a lightweight read store. The route handler:
//   1. Pulls open cases from app_cases.cms_cases (tenant + filter scoped)
//   2. Pulls ACTIVE sla_config rows from app_admin.sla_config
//   3. Calls computeSlaBreachMatrix() — purely composable, no IO
//
// The resolver is the heart of the feature. Tests pass hand-built
// inputs and assert against the bucketed output.

import { Pool } from 'pg';

// ── Types ───────────────────────────────────────────────────────────

export type Priority = 'P1' | 'P2' | 'P3' | 'P4';
export type Severity = 'high' | 'medium' | 'low';
export type CaseStatus = string; // free-form to absorb cms_cases / cases divergence

export interface SlaConfig {
  sla_config_id: string;
  tenant_id: string;
  case_category: string;
  priority: Priority;
  business_unit: string | null;
  sla_target_days: number;
  status: 'ACTIVE' | 'SUPERSEDED' | 'ARCHIVED';
}

/** Minimal case shape the matrix needs. The route handler projects
 *  cms_cases rows down to this shape so the resolver is decoupled
 *  from the table schema. */
export interface MatrixCase {
  case_id: string;
  case_category: string | null;     // null falls back to 'default_fallback'
  priority: Priority;
  business_unit: string | null;
  status: CaseStatus;
  created_at: string;                // ISO 8601
  /** Optional severity used for the high/med/low split. Inferred from
   *  priority when absent (P1→high, P2/P3→medium, P4→low). */
  severity?: Severity;
}

export interface MatrixBucket {
  label: '0-7 days' | '8-30 days' | '31-90 days' | '90+ days';
  /** Inclusive lower / exclusive upper, in whole days from created_at. */
  min_days: number;
  max_days: number | null;          // null = open-ended (90+)
  total_open: number;
  breached: number;
  breach_pct: number;                // 0..100, rounded to 1 decimal
  severity_split: { high: number; medium: number; low: number };
}

export interface SlaBreachMatrix {
  buckets: MatrixBucket[];
  generatedAt: string;
  filters: {
    tenant_id: string;
    branch?: string;
    business_unit?: string;
    as_of?: string;
  };
  /** Stat: how many open cases were not categorised and therefore fell
   *  through to default_fallback. Useful for ops to measure data quality. */
  uncategorised_count: number;
  /** Stat: how many open cases had no matching sla_config row at all
   *  (not even default_fallback). These are excluded from the matrix. */
  unresolved_count: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

const BUCKET_DEFS: Array<Pick<MatrixBucket, 'label' | 'min_days' | 'max_days'>> = [
  { label: '0-7 days',   min_days: 0,  max_days: 7   },
  { label: '8-30 days',  min_days: 8,  max_days: 30  },
  { label: '31-90 days', min_days: 31, max_days: 90  },
  { label: '90+ days',   min_days: 91, max_days: null },
];

const PRIORITY_TO_SEVERITY: Record<Priority, Severity> = {
  P1: 'high',
  P2: 'medium',
  P3: 'medium',
  P4: 'low',
};

const CLOSED_STATES = new Set([
  'CLOSED',
  'RESOLVED',
  'closed',
  'resolved',
]);

function bucketFor(ageDays: number): MatrixBucket['label'] {
  if (ageDays <= 7) return '0-7 days';
  if (ageDays <= 30) return '8-30 days';
  if (ageDays <= 90) return '31-90 days';
  return '90+ days';
}

/**
 * Resolve the SLA target days for a case. Specific-first lookup:
 *
 *   1. (tenant, category,        priority, business_unit) ACTIVE
 *   2. (tenant, category,        priority, business_unit=NULL) ACTIVE
 *   3. (tenant, default_fallback, priority, business_unit=NULL) ACTIVE
 *   4. undefined → caller bumps unresolved_count
 *
 * The matrix endpoint loads all ACTIVE configs once per request and
 * then resolves per-case in O(1) via this index.
 */
export function buildSlaConfigIndex(
  configs: SlaConfig[],
): (tenantId: string, category: string | null, priority: Priority, bu: string | null) => number | undefined {
  // Index by (tenant, category, priority, bu||'')
  const exact = new Map<string, number>();
  for (const c of configs) {
    if (c.status !== 'ACTIVE') continue;
    const key = `${c.tenant_id}${c.case_category}${c.priority}${c.business_unit ?? ''}`;
    exact.set(key, c.sla_target_days);
  }
  return (tenantId, category, priority, bu) => {
    const cat = category ?? 'default_fallback';
    if (bu) {
      const bvKey = `${tenantId}${cat}${priority}${bu}`;
      const v = exact.get(bvKey);
      if (v !== undefined) return v;
    }
    const generalKey = `${tenantId}${cat}${priority}`;
    const v = exact.get(generalKey);
    if (v !== undefined) return v;
    if (cat !== 'default_fallback') {
      const fbKey = `${tenantId}default_fallback${priority}`;
      return exact.get(fbKey);
    }
    return undefined;
  };
}

// ── Pure resolver ───────────────────────────────────────────────────

export function computeSlaBreachMatrix(input: {
  tenant_id: string;
  cases: MatrixCase[];
  configs: SlaConfig[];
  asOf?: Date;
  filters?: { branch?: string; business_unit?: string };
}): SlaBreachMatrix {
  const asOf = input.asOf ?? new Date();
  const asOfMs = asOf.getTime();
  const resolveTarget = buildSlaConfigIndex(input.configs);

  const empty = (): MatrixBucket['severity_split'] => ({ high: 0, medium: 0, low: 0 });
  const buckets: Record<MatrixBucket['label'], MatrixBucket> = {
    '0-7 days':   { ...BUCKET_DEFS[0], total_open: 0, breached: 0, breach_pct: 0, severity_split: empty() },
    '8-30 days':  { ...BUCKET_DEFS[1], total_open: 0, breached: 0, breach_pct: 0, severity_split: empty() },
    '31-90 days': { ...BUCKET_DEFS[2], total_open: 0, breached: 0, breach_pct: 0, severity_split: empty() },
    '90+ days':   { ...BUCKET_DEFS[3], total_open: 0, breached: 0, breach_pct: 0, severity_split: empty() },
  };

  let uncategorised = 0;
  let unresolved = 0;

  for (const c of input.cases) {
    if (CLOSED_STATES.has(c.status)) continue;
    if (input.filters?.business_unit && c.business_unit !== input.filters.business_unit) continue;

    const createdMs = Date.parse(c.created_at);
    if (!Number.isFinite(createdMs)) continue;
    const ageDays = Math.max(0, Math.floor((asOfMs - createdMs) / 86_400_000));

    const target = resolveTarget(input.tenant_id, c.case_category, c.priority, c.business_unit);
    if (target === undefined) {
      unresolved++;
      continue;
    }
    if (!c.case_category) uncategorised++;

    const breached = ageDays > target;
    const sev = c.severity ?? PRIORITY_TO_SEVERITY[c.priority];
    const bucket = buckets[bucketFor(ageDays)];
    bucket.total_open++;
    if (breached) bucket.breached++;
    bucket.severity_split[sev]++;
  }

  for (const b of Object.values(buckets)) {
    b.breach_pct = b.total_open === 0
      ? 0
      : Math.round((b.breached / b.total_open) * 1000) / 10;
  }

  return {
    buckets: [
      buckets['0-7 days'],
      buckets['8-30 days'],
      buckets['31-90 days'],
      buckets['90+ days'],
    ],
    generatedAt: asOf.toISOString(),
    filters: {
      tenant_id: input.tenant_id,
      ...(input.filters?.branch ? { branch: input.filters.branch } : {}),
      ...(input.filters?.business_unit ? { business_unit: input.filters.business_unit } : {}),
      ...(input.asOf ? { as_of: input.asOf.toISOString() } : {}),
    },
    uncategorised_count: uncategorised,
    unresolved_count: unresolved,
  };
}

// ── PG-backed reader ────────────────────────────────────────────────

export interface SlaMatrixSource {
  loadConfigs(tenant_id: string): Promise<SlaConfig[]>;
  loadOpenCases(tenant_id: string, filters: { branch?: string; business_unit?: string }): Promise<MatrixCase[]>;
}

export class PgSlaMatrixSource implements SlaMatrixSource {
  constructor(private readonly pool: Pool) {}

  async loadConfigs(tenant_id: string): Promise<SlaConfig[]> {
    const r = await this.pool.query(
      `SELECT sla_config_id, tenant_id, case_category, priority, business_unit,
              sla_target_days, status
         FROM app_admin.sla_config
        WHERE tenant_id = $1 AND status = 'ACTIVE'`,
      [tenant_id],
    );
    return r.rows.map((row) => ({
      sla_config_id: String(row.sla_config_id),
      tenant_id: String(row.tenant_id),
      case_category: String(row.case_category),
      priority: row.priority as Priority,
      business_unit: row.business_unit ? String(row.business_unit) : null,
      sla_target_days: Number(row.sla_target_days),
      status: row.status as SlaConfig['status'],
    }));
  }

  async loadOpenCases(
    tenant_id: string,
    filters: { branch?: string; business_unit?: string },
  ): Promise<MatrixCase[]> {
    // cms_cases is the rich source (priority + status + tags + new
    // case_category column). app_cases.cases is the legacy state-machine
    // table without a category — left out of the matrix until/unless it
    // gets the same column.
    const where: string[] = ['tenant_id = $1', "status NOT IN ('CLOSED','RESOLVED')"];
    const args: unknown[] = [tenant_id];
    if (filters.business_unit) {
      args.push(`%${filters.business_unit}%`);
      where.push(`assigned_to ILIKE $${args.length}`);
    }
    const r = await this.pool.query(
      `SELECT case_id, case_category, priority, status, created_at,
              assigned_to AS business_unit_hint
         FROM app_cases.cms_cases
        WHERE ${where.join(' AND ')}`,
      args,
    );
    return r.rows.map((row) => ({
      case_id: String(row.case_id),
      case_category: row.case_category ? String(row.case_category) : null,
      priority: row.priority as Priority,
      business_unit: null, // cms_cases has no first-class BU column today
      status: String(row.status),
      created_at: (row.created_at as Date).toISOString(),
    }));
  }
}

// ── In-memory reader (tests + dev fallback) ─────────────────────────

export class InMemorySlaMatrixSource implements SlaMatrixSource {
  constructor(
    private readonly configs: SlaConfig[],
    private readonly cases: MatrixCase[],
  ) {}
  async loadConfigs(tenant_id: string): Promise<SlaConfig[]> {
    return this.configs.filter((c) => c.tenant_id === tenant_id && c.status === 'ACTIVE');
  }
  async loadOpenCases(
    tenant_id: string,
    filters: { branch?: string; business_unit?: string },
  ): Promise<MatrixCase[]> {
    return this.cases.filter((c) => {
      if (CLOSED_STATES.has(c.status)) return false;
      if (filters.business_unit && c.business_unit !== filters.business_unit) return false;
      return true;
    }).map((c) => ({ ...c }));
    void tenant_id;
  }
}

/** Factory that flips on BFF_PG_URL — mirrors the makeScenarioStore pattern. */
export async function makeSlaMatrixSource(
  env: NodeJS.ProcessEnv = process.env,
  fallbackCases: MatrixCase[] = [],
  fallbackConfigs: SlaConfig[] = [],
): Promise<{ source: SlaMatrixSource; pool: Pool | null }> {
  const url = env.BFF_PG_URL ?? env.ADMIN_PG_URL;
  if (!url) {
    return {
      source: new InMemorySlaMatrixSource(fallbackConfigs, fallbackCases),
      pool: null,
    };
  }
  const pool = new Pool({ connectionString: url, max: 4 });
  return { source: new PgSlaMatrixSource(pool), pool };
}
