// services/bff/src/analytics/stage_migration.ts
//
// Stage Migration sub-dashboard — T4.1 4d, EWS.docx §5.5 / §8.
//
// IFRS 9 stages (1 = perform, 2 = SICR, 3 = NPA) aren't carried in
// app_alerts.alerts yet. The prototype derives a 3-stage proxy from
// alert severity:
//     stage_1 (low)     ←  severity = 'low'
//     stage_2 (medium)  ←  severity = 'medium'
//     stage_3 (high)    ←  severity in ('high', 'critical')
// When real IFRS 9 stages land, only the `severityToStage` mapper +
// the source query change. The resolver + UI shape are stable.

import { Pool } from 'pg';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';
export type StageCode = 'stage_1' | 'stage_2' | 'stage_3';
export const STAGE_CODES: ReadonlyArray<StageCode> = ['stage_1', 'stage_2', 'stage_3'];

/** Snapshot row — one record per (customer × snapshot_date). */
export interface StageSnapshotRow {
  customer_id: string;
  stage: StageCode;
}

export interface StageMigrationFilter {
  /** ISO timestamp the "current" snapshot is taken at. */
  as_of?: string;
  /** ISO timestamp the "prior" snapshot is taken at. */
  prior_as_of?: string;
  /** Customer-segment filter; opt-in via segment_lookup. */
  segment?: string;
}

/** A single matrix cell: from = prior stage, to = current stage. */
export interface MatrixCell {
  from: StageCode;
  to: StageCode;
  count: number;
}

export interface StageTotal {
  stage: StageCode;
  /** Customer count in the current snapshot. */
  current: number;
  /** Customer count in the prior snapshot. */
  prior: number;
  /** current - prior */
  delta: number;
}

export interface StageMigrationReport {
  /** 9 cells (3×3) covering every (from → to) pair. */
  matrix: MatrixCell[];
  totals: StageTotal[];
  /** Customers who moved up (more risk) = sum off-diagonal upper-right cells. */
  upgrades_count: number;
  /** Customers who moved down (less risk) = sum lower-left cells. */
  downgrades_count: number;
  /** Customers who stayed = sum diagonal. */
  stationary_count: number;
  /** Customers in current snapshot only (no prior record). */
  new_customers_count: number;
  /** Customers in prior snapshot only (gone from current). */
  exited_customers_count: number;
  generated_at: string;
  tenant_id: string;
  filters_applied: StageMigrationFilter;
}

// ── Mapping helpers ────────────────────────────────────────────────────

/** Severity → 3-stage proxy. Used by the Pg source; exported for tests. */
export function severityToStage(s: AlertSeverity): StageCode {
  if (s === 'low') return 'stage_1';
  if (s === 'medium') return 'stage_2';
  return 'stage_3'; // 'high' or 'critical'
}

// ── Pure resolver ──────────────────────────────────────────────────────

export function computeStageMigration(input: {
  tenant_id: string;
  current: StageSnapshotRow[];
  prior: StageSnapshotRow[];
  filter?: StageMigrationFilter;
  asOf: Date;
  segmentOf?: (customer_id: string) => string | null;
}): StageMigrationReport {
  const filter = input.filter ?? {};
  const inSeg = (id: string) =>
    !filter.segment || (input.segmentOf ? input.segmentOf(id) === filter.segment : false);
  const current = input.current.filter((r) => inSeg(r.customer_id));
  const prior = input.prior.filter((r) => inSeg(r.customer_id));

  const curMap = new Map(current.map((r) => [r.customer_id, r.stage]));
  const priorMap = new Map(prior.map((r) => [r.customer_id, r.stage]));

  // Pre-fill all 9 cells so consumers can render a stable 3×3 grid.
  const matrix = new Map<string, MatrixCell>();
  for (const from of STAGE_CODES) {
    for (const to of STAGE_CODES) {
      matrix.set(`${from}|${to}`, { from, to, count: 0 });
    }
  }

  let upgrades = 0;
  let downgrades = 0;
  let stationary = 0;
  let newCustomers = 0;
  let exited = 0;

  // Walk the union of customer_ids — counting transitions.
  const allIds = new Set<string>();
  for (const id of curMap.keys()) allIds.add(id);
  for (const id of priorMap.keys()) allIds.add(id);

  for (const id of allIds) {
    const from = priorMap.get(id);
    const to = curMap.get(id);
    if (!from && to) {
      newCustomers += 1;
      continue;
    }
    if (from && !to) {
      exited += 1;
      continue;
    }
    if (!from || !to) continue;
    matrix.get(`${from}|${to}`)!.count += 1;
    const fromIdx = STAGE_CODES.indexOf(from);
    const toIdx = STAGE_CODES.indexOf(to);
    if (toIdx > fromIdx) upgrades += 1;          // moved to a higher (riskier) stage
    else if (toIdx < fromIdx) downgrades += 1;   // moved to a lower (safer) stage
    else stationary += 1;
  }

  // Per-stage totals
  const totals: StageTotal[] = STAGE_CODES.map((stage) => {
    const cur = current.filter((r) => r.stage === stage).length;
    const pri = prior.filter((r) => r.stage === stage).length;
    return { stage, current: cur, prior: pri, delta: cur - pri };
  });

  return {
    matrix: STAGE_CODES.flatMap((from) =>
      STAGE_CODES.map((to) => matrix.get(`${from}|${to}`)!),
    ),
    totals,
    upgrades_count: upgrades,
    downgrades_count: downgrades,
    stationary_count: stationary,
    new_customers_count: newCustomers,
    exited_customers_count: exited,
    generated_at: input.asOf.toISOString(),
    tenant_id: input.tenant_id,
    filters_applied: filter,
  };
}

// ── Pg source ──────────────────────────────────────────────────────────

export interface StageMigrationSource {
  loadSnapshot(tenant_id: string, asOf: Date): Promise<StageSnapshotRow[]>;
}

export class PgStageMigrationSource implements StageMigrationSource {
  constructor(private readonly pool: Pool) {}

  async loadSnapshot(tenant_id: string, asOf: Date): Promise<StageSnapshotRow[]> {
    // Latest severity per customer at-or-before asOf.
    const sql = `
      SELECT DISTINCT ON (customer_id)
             customer_id,
             severity
        FROM app_alerts.alerts
       WHERE tenant_id = $1 AND created_at <= $2
       ORDER BY customer_id, created_at DESC
    `;
    const out = await this.pool.query(sql, [tenant_id, asOf]);
    return out.rows.map((r) => ({
      customer_id: String(r.customer_id),
      stage: severityToStage(String(r.severity) as AlertSeverity),
    }));
  }
}

export class InMemoryStageMigrationSource implements StageMigrationSource {
  constructor(private readonly snapshotsByDate: (asOf: Date) => StageSnapshotRow[]) {}
  async loadSnapshot(_tenant_id: string, asOf: Date): Promise<StageSnapshotRow[]> {
    return this.snapshotsByDate(asOf);
  }
}

export async function makeStageMigrationSource(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ source: StageMigrationSource; pool: Pool | null }> {
  const url = env.BFF_PG_URL ?? env.ADMIN_PG_URL;
  if (!url) {
    return {
      source: new InMemoryStageMigrationSource(() => []),
      pool: null,
    };
  }
  const pool = new Pool({ connectionString: url, max: 4 });
  return { source: new PgStageMigrationSource(pool), pool };
}
