// services/bff/src/analytics/alert_resolution.ts
//
// Alert Resolution sub-dashboard — T4.1, EWS.docx §8 / §5.5.
//
// Computes the alert-lifecycle funnel + percentile durations + a
// weekly trend from the `app_alerts.alerts` row set. Pure resolver
// (input → output, no IO) so tests are trivial; Pg source layered on
// top via the same pattern as sla_breach_matrix.

import { Pool } from 'pg';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';
export type AlertStatus = 'open' | 'acked' | 'closed';

/** Minimal lifecycle row the resolver needs. */
export interface AlertLifecycleRow {
  alert_id: string;
  severity: AlertSeverity;
  status: AlertStatus;
  created_at: string;            // ISO
  acked_at: string | null;       // ISO or null
  closed_at: string | null;      // ISO or null
}

export interface AlertResolutionFilter {
  /** ISO inclusive lower bound on `created_at`. */
  from?: string;
  /** ISO inclusive upper bound on `created_at`. */
  to?: string;
  /** Single severity filter — undefined = all. */
  severity?: AlertSeverity | 'all';
}

export interface FunnelStage {
  stage: 'created' | 'acked' | 'investigated' | 'closed';
  count: number;
  /** Conversion ratio vs. `created`. 1.0 for the `created` row itself. */
  ratio: number;
}

export interface DurationStat {
  /** Sample size used for this percentile. */
  n: number;
  /** Median (p50) in seconds. null when n=0. */
  p50_sec: number | null;
  /** 95th percentile in seconds. null when n=0. */
  p95_sec: number | null;
  /** Mean in seconds. null when n=0. */
  mean_sec: number | null;
}

export interface TrendBucket {
  /** ISO week-start label (e.g. `2026-W18`) — purely for the X-axis. */
  week: string;
  created: number;
  acked: number;
  closed: number;
}

export interface AlertResolutionReport {
  funnel: FunnelStage[];
  /** created → acked. */
  ack_duration: DurationStat;
  /** created → closed. */
  close_duration: DurationStat;
  trend: TrendBucket[];
  generated_at: string;
  tenant_id: string;
  filters_applied: AlertResolutionFilter;
}

// ── Pure resolver ──────────────────────────────────────────────────────

export function computeAlertResolution(input: {
  tenant_id: string;
  rows: AlertLifecycleRow[];
  filter?: AlertResolutionFilter;
  asOf: Date;
}): AlertResolutionReport {
  const filter = input.filter ?? {};
  const fromMs = filter.from ? Date.parse(filter.from) : Number.NEGATIVE_INFINITY;
  const toMs = filter.to ? Date.parse(filter.to) : Number.POSITIVE_INFINITY;
  const sev = filter.severity && filter.severity !== 'all' ? filter.severity : null;

  const rows = input.rows.filter((r) => {
    const ts = Date.parse(r.created_at);
    if (!Number.isFinite(ts)) return false;
    if (ts < fromMs || ts > toMs) return false;
    if (sev && r.severity !== sev) return false;
    return true;
  });

  const created = rows.length;
  const acked = rows.filter((r) => r.acked_at !== null).length;
  // "Investigated" — heuristic: acked AND (closed_at >= acked_at + 5 min) OR
  // acked AND not yet closed. Plain `acked but immediately closed` doesn't
  // count as investigated. The threshold is meant to filter out auto-close.
  const investigated = rows.filter((r) => {
    if (!r.acked_at) return false;
    if (!r.closed_at) return true;
    return Date.parse(r.closed_at) - Date.parse(r.acked_at) >= 5 * 60_000;
  }).length;
  const closed = rows.filter((r) => r.closed_at !== null).length;

  const ratio = (n: number) => (created === 0 ? 0 : Number((n / created).toFixed(4)));
  const funnel: FunnelStage[] = [
    { stage: 'created',      count: created,      ratio: ratio(created) },
    { stage: 'acked',        count: acked,        ratio: ratio(acked) },
    { stage: 'investigated', count: investigated, ratio: ratio(investigated) },
    { stage: 'closed',       count: closed,       ratio: ratio(closed) },
  ];

  const ackDurations: number[] = [];
  const closeDurations: number[] = [];
  for (const r of rows) {
    const c = Date.parse(r.created_at);
    if (r.acked_at) {
      const d = (Date.parse(r.acked_at) - c) / 1000;
      if (d >= 0) ackDurations.push(d);
    }
    if (r.closed_at) {
      const d = (Date.parse(r.closed_at) - c) / 1000;
      if (d >= 0) closeDurations.push(d);
    }
  }

  const trend = buildWeeklyTrend(rows);

  return {
    funnel,
    ack_duration: percentileStats(ackDurations),
    close_duration: percentileStats(closeDurations),
    trend,
    generated_at: input.asOf.toISOString(),
    tenant_id: input.tenant_id,
    filters_applied: filter,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function percentileStats(samples: number[]): DurationStat {
  if (samples.length === 0) return { n: 0, p50_sec: null, p95_sec: null, mean_sec: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (q: number) => {
    // Nearest-rank, clamped — keeps p50 of [1] = 1, p95 of [1,2,3] = 3
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[idx];
  };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    p50_sec: Math.round(p(0.5)),
    p95_sec: Math.round(p(0.95)),
    mean_sec: Math.round(sum / sorted.length),
  };
}

function isoWeekLabel(d: Date): string {
  // Thu of the week → ISO week number (the conventional algorithm)
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function buildWeeklyTrend(rows: AlertLifecycleRow[]): TrendBucket[] {
  const map = new Map<string, TrendBucket>();
  const bump = (week: string, key: 'created' | 'acked' | 'closed') => {
    const b = map.get(week) ?? { week, created: 0, acked: 0, closed: 0 };
    b[key] += 1;
    map.set(week, b);
  };
  for (const r of rows) {
    const c = new Date(r.created_at);
    if (Number.isFinite(c.getTime())) bump(isoWeekLabel(c), 'created');
    if (r.acked_at) {
      const a = new Date(r.acked_at);
      if (Number.isFinite(a.getTime())) bump(isoWeekLabel(a), 'acked');
    }
    if (r.closed_at) {
      const x = new Date(r.closed_at);
      if (Number.isFinite(x.getTime())) bump(isoWeekLabel(x), 'closed');
    }
  }
  return [...map.values()].sort((a, b) => a.week.localeCompare(b.week));
}

// ── Pg source ──────────────────────────────────────────────────────────

export interface AlertResolutionSource {
  loadAlertLifecycle(
    tenant_id: string,
    filter: AlertResolutionFilter,
  ): Promise<AlertLifecycleRow[]>;
}

export class PgAlertResolutionSource implements AlertResolutionSource {
  constructor(private readonly pool: Pool) {}

  async loadAlertLifecycle(
    tenant_id: string,
    filter: AlertResolutionFilter,
  ): Promise<AlertLifecycleRow[]> {
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
    if (filter.severity && filter.severity !== 'all') {
      args.push(filter.severity);
      where += ` AND severity = $${args.length}`;
    }
    const sql = `
      SELECT alert_id, severity, status, created_at, acked_at, closed_at
        FROM app_alerts.alerts
        ${where}
        ORDER BY created_at ASC
    `;
    const out = await this.pool.query(sql, args);
    return out.rows.map((r) => ({
      alert_id: String(r.alert_id),
      severity: String(r.severity) as AlertSeverity,
      status: String(r.status) as AlertStatus,
      created_at: (r.created_at as Date).toISOString(),
      acked_at: r.acked_at ? (r.acked_at as Date).toISOString() : null,
      closed_at: r.closed_at ? (r.closed_at as Date).toISOString() : null,
    }));
  }
}

export class InMemoryAlertResolutionSource implements AlertResolutionSource {
  constructor(private readonly rows: AlertLifecycleRow[]) {}
  async loadAlertLifecycle(
    _tenant_id: string,
    _filter: AlertResolutionFilter,
  ): Promise<AlertLifecycleRow[]> {
    return this.rows;
  }
}

export async function makeAlertResolutionSource(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ source: AlertResolutionSource; pool: Pool | null }> {
  const url = env.BFF_PG_URL ?? env.ADMIN_PG_URL;
  if (!url) return { source: new InMemoryAlertResolutionSource([]), pool: null };
  const pool = new Pool({ connectionString: url, max: 4 });
  return { source: new PgAlertResolutionSource(pool), pool };
}
