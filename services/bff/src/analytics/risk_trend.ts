// services/bff/src/analytics/risk_trend.ts
//
// Risk Trend sub-dashboard — T4.1, EWS.docx §5.5 / §8.
//
// Weekly bar+line composite: counts by severity (stacked bars) +
// average criticality_score (line). The BAC asks for stratification by
// "segment" (retail/SME/corporate); the alerts table only carries
// severity, so this resolver stratifies by severity. Customer segment
// can be added later by joining mart.customer_360 — opt-in via the
// `segment_lookup` callback.

import { Pool } from 'pg';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface RiskTrendRow {
  alert_id: string;
  customer_id: string;
  severity: AlertSeverity;
  /** numeric(8,2) — bigger = more critical. Used for the line series. */
  criticality_score: number;
  created_at: string; // ISO
}

export interface RiskTrendFilter {
  /** ISO inclusive lower bound on `created_at`. */
  from?: string;
  /** ISO inclusive upper bound on `created_at`. */
  to?: string;
  /** Optional segment filter — relies on `segment_lookup` being wired. */
  segment?: string;
}

export interface RiskTrendBucket {
  /** ISO week label (e.g. `2026-W18`). */
  week: string;
  /** Mid-point Date for sorting + tooltip context. */
  week_start: string; // ISO Monday of the ISO week
  total: number;
  by_severity: Record<AlertSeverity, number>;
  /** Average criticality_score over the alerts in this bucket. null if 0. */
  avg_criticality: number | null;
  /** High+critical share of total, [0,1]. 0 if total=0. */
  high_critical_share: number;
}

export interface RiskTrendReport {
  buckets: RiskTrendBucket[];
  /** Aggregate over the full window — useful for the headline KPI cards. */
  totals: {
    alert_count: number;
    avg_criticality: number | null;
    high_critical_share: number;
  };
  generated_at: string;
  tenant_id: string;
  filters_applied: RiskTrendFilter;
}

// ── Pure resolver ──────────────────────────────────────────────────────

export function computeRiskTrend(input: {
  tenant_id: string;
  rows: RiskTrendRow[];
  filter?: RiskTrendFilter;
  asOf: Date;
  /** Optional customer_id → segment lookup. When set + filter.segment is
   *  provided, only alerts whose customer maps to that segment count. */
  segmentOf?: (customer_id: string) => string | null;
}): RiskTrendReport {
  const filter = input.filter ?? {};
  const fromMs = filter.from ? Date.parse(filter.from) : Number.NEGATIVE_INFINITY;
  const toMs = filter.to ? Date.parse(filter.to) : Number.POSITIVE_INFINITY;
  const wantSegment = filter.segment;

  const rows = input.rows.filter((r) => {
    const ts = Date.parse(r.created_at);
    if (!Number.isFinite(ts)) return false;
    if (ts < fromMs || ts > toMs) return false;
    if (wantSegment) {
      const seg = input.segmentOf ? input.segmentOf(r.customer_id) : null;
      if (seg !== wantSegment) return false;
    }
    return true;
  });

  const map = new Map<string, RiskTrendBucket>();
  let totalCrit = 0;
  let highCritCount = 0;

  for (const r of rows) {
    const created = new Date(r.created_at);
    const { label: week, monday } = isoWeekInfo(created);
    const b =
      map.get(week) ??
      ({
        week,
        week_start: monday.toISOString(),
        total: 0,
        by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
        avg_criticality: 0, // accumulated, finalized below
        high_critical_share: 0,
      } satisfies RiskTrendBucket);
    b.total += 1;
    b.by_severity[r.severity] += 1;
    // Stash sum in avg_criticality during the loop, divide at the end.
    b.avg_criticality = (b.avg_criticality ?? 0) + Number(r.criticality_score);
    map.set(week, b);
    totalCrit += Number(r.criticality_score);
    if (r.severity === 'critical' || r.severity === 'high') highCritCount += 1;
  }

  // Finalize per-bucket averages + high-critical share
  const buckets: RiskTrendBucket[] = [...map.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((b) => {
      const sumCrit = b.avg_criticality ?? 0;
      const highCrit = b.by_severity.critical + b.by_severity.high;
      return {
        ...b,
        avg_criticality: b.total === 0 ? null : Math.round((sumCrit / b.total) * 100) / 100,
        high_critical_share: b.total === 0 ? 0 : Math.round((highCrit / b.total) * 10000) / 10000,
      };
    });

  const totals = {
    alert_count: rows.length,
    avg_criticality:
      rows.length === 0 ? null : Math.round((totalCrit / rows.length) * 100) / 100,
    high_critical_share:
      rows.length === 0 ? 0 : Math.round((highCritCount / rows.length) * 10000) / 10000,
  };

  return {
    buckets,
    totals,
    generated_at: input.asOf.toISOString(),
    tenant_id: input.tenant_id,
    filters_applied: filter,
  };
}

// ── ISO-week helper ────────────────────────────────────────────────────

function isoWeekInfo(d: Date): { label: string; monday: Date } {
  // Standard ISO-8601 week: Thursday belongs to the same week, week 1 is
  // the week containing Jan 4.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  // Move the marker to Thursday of that ISO week (so the year-roll-over
  // case where Jan 1 is in week 52/53 of the prior year resolves right).
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);

  // Monday of the ISO week (the start of the bucket; for tooltip + sort)
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const adj = monday.getUTCDay() || 7;
  monday.setUTCDate(monday.getUTCDate() - (adj - 1));
  monday.setUTCHours(0, 0, 0, 0);

  return { label: `${t.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`, monday };
}

// ── Pg source ──────────────────────────────────────────────────────────

export interface RiskTrendSource {
  loadAlerts(tenant_id: string, filter: RiskTrendFilter): Promise<RiskTrendRow[]>;
}

export class PgRiskTrendSource implements RiskTrendSource {
  constructor(private readonly pool: Pool) {}

  async loadAlerts(tenant_id: string, filter: RiskTrendFilter): Promise<RiskTrendRow[]> {
    const args: unknown[] = [tenant_id];
    let where = `WHERE tenant_id = $1`;
    if (filter.from) {
      args.push(filter.from);
      where += ` AND created_at >= $${args.length}`;
    }
    if (filter.to) {
      args.push(filter.to);
      where += ` AND created_at <= $${args.length}`;
    }
    const sql = `
      SELECT alert_id, customer_id, severity, criticality_score, created_at
        FROM app_alerts.alerts
        ${where}
        ORDER BY created_at ASC
    `;
    const out = await this.pool.query(sql, args);
    return out.rows.map((r) => ({
      alert_id: String(r.alert_id),
      customer_id: String(r.customer_id),
      severity: String(r.severity) as AlertSeverity,
      criticality_score: Number(r.criticality_score),
      created_at: (r.created_at as Date).toISOString(),
    }));
  }
}

export class InMemoryRiskTrendSource implements RiskTrendSource {
  constructor(private readonly rows: RiskTrendRow[]) {}
  async loadAlerts(_tenant_id: string, _filter: RiskTrendFilter): Promise<RiskTrendRow[]> {
    return this.rows;
  }
}

export async function makeRiskTrendSource(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ source: RiskTrendSource; pool: Pool | null }> {
  const url = env.BFF_PG_URL ?? env.ADMIN_PG_URL;
  if (!url) return { source: new InMemoryRiskTrendSource([]), pool: null };
  const pool = new Pool({ connectionString: url, max: 4 });
  return { source: new PgRiskTrendSource(pool), pool };
}
