// services/bff/src/connector_run_volume_hourly.ts
//
// T6 M3.12 — Connector fleet run-volume hourly histogram.
//
// M3.1 ships the connector registry + per-connector run history.
// M3.5 ships per-connector run analytics (success_rate + latency
// percentiles). M3.6 ships failure-pattern clustering. None of these
// answer the fleet-level question: "what does our daily ingestion
// traffic curve look like — when are we busiest, when are we quiet?"
//
// M3.12 ships that view. Aggregates EVERY connector's recent runs
// into a 24-bucket histogram by UTC hour-of-day with per-bucket
// status breakdown. Drives the ops dashboard's "Fleet Activity"
// timeline + maintenance-window planning ("schedule the kernel
// update at hour 03:00 — that's our quietest hour").
//
// Mirror of M14.22 (field visit dow×hour heatmap) + M15.7 (audit
// activity heatmap) but as a 1D timeline rather than 2D matrix.
// Pure rollup over the M3.1 registry + listRuns per connector.

import type { IngestionRegistry, RunStatus } from './ingestion';

// ─── Constants ────────────────────────────────────────────────────────

const ALL_STATUSES: readonly RunStatus[] = [
  'success',
  'failure',
  'partial',
  'running',
] as const;

const PER_CONNECTOR_LIMIT = 200;

// ─── Public types ─────────────────────────────────────────────────────

export interface HourlyVolumeBucket {
  /** 0..23 UTC hour-of-day. */
  hour: number;
  total_runs: number;
  /** Per-RunStatus count; every key present at 0 when absent. */
  by_status: Record<RunStatus, number>;
}

export interface ConnectorRunHourlyVolumeSummary {
  tenant_id: string;
  generated_at: string;
  /** Total runs scanned across the fleet (sum over by_hour). */
  total_runs: number;
  /** Distinct connectors that had at least one run land in the histogram. */
  active_connectors: number;
  /** Distinct connectors in the registry (active + idle). */
  total_connectors: number;
  /** Per-connector cap on runs drained from listRuns. Surfaced so the
   *  SPA can render "showing the last 200 runs per connector" footnote. */
  per_connector_limit: number;
  /** Always 24 entries in UTC hour 0..23 order. */
  by_hour: HourlyVolumeBucket[];
  /** Highest total_runs hour. Tie-broken by hour asc (earliest UTC
   *  hour wins at same count). null when no runs in the window. */
  peak_hour: number | null;
  /** Count at peak_hour. 0 when no runs. */
  peak_count: number;
  /** Hours with total_runs === 0, in ascending order. */
  quiet_hours: number[];
  /** Σ total / 24, rounded. */
  mean_runs_per_hour: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByStatus(): Record<RunStatus, number> {
  return { success: 0, failure: 0, partial: 0, running: 0 };
}

function buildEmptyBuckets(): HourlyVolumeBucket[] {
  const out: HourlyVolumeBucket[] = [];
  for (let h = 0; h < 24; h++) {
    out.push({ hour: h, total_runs: 0, by_status: emptyByStatus() });
  }
  return out;
}

function utcHour(iso: string): number | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t).getUTCHours();
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildConnectorRunHourlyVolume(
  registry: IngestionRegistry,
  tenant_id: string,
  now: Date,
): ConnectorRunHourlyVolumeSummary {
  const by_hour = buildEmptyBuckets();
  const connectors = registry.list(tenant_id);
  const activeSet = new Set<string>();
  let total_runs = 0;

  for (const c of connectors) {
    const runs = registry.listRuns(tenant_id, c.id, PER_CONNECTOR_LIMIT);
    if (runs.length === 0) continue;
    let landed = 0;
    for (const r of runs) {
      const hour = utcHour(r.started_at);
      if (hour === null) continue;
      // Defensive: ignore unknown statuses (the enum is closed but a
      // future addition shouldn't break the rollup).
      if (!ALL_STATUSES.includes(r.status)) continue;
      const bucket = by_hour[hour]!;
      bucket.total_runs++;
      bucket.by_status[r.status]++;
      total_runs++;
      landed++;
    }
    if (landed > 0) activeSet.add(c.id);
  }

  // peak_hour: highest total_runs; ties broken by hour asc (earliest
  // hour wins). null when zero runs.
  let peak_hour: number | null = null;
  let peak_count = 0;
  for (const bucket of by_hour) {
    if (bucket.total_runs > peak_count) {
      peak_count = bucket.total_runs;
      peak_hour = bucket.hour;
    }
  }
  if (peak_count === 0) peak_hour = null;

  const quiet_hours = by_hour
    .filter((b) => b.total_runs === 0)
    .map((b) => b.hour);

  const mean_runs_per_hour = Math.round(total_runs / 24);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_runs,
    active_connectors: activeSet.size,
    total_connectors: connectors.length,
    per_connector_limit: PER_CONNECTOR_LIMIT,
    by_hour,
    peak_hour,
    peak_count,
    quiet_hours,
    mean_runs_per_hour,
  };
}
