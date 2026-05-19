// services/bff/src/connector_run_daily_volume.ts
//
// T6 M3.17 — Connector run daily volume timeline.
//
// M3.5 ships per-connector run analytics. M3.6 clusters failures.
// M3.12 ships fleet-wide hourly histogram (cyclic intraday view).
// M3.16 ships fleet-wide latency histogram.
//
// M3.17 ships the trailing-N-day TREND view across the fleet: per UTC
// calendar day, count {total, by_status (success/failure/partial/
// running), distinct_connectors}. Mirror of M1.9 / M8.15 / M10.15 /
// M12.13 / M15.11 daily-volume pattern.
//
// Distinct from M3.12 (hourly cyclic) — M3.17 is the linear trend.
// Drives BIL ops "are we processing more ingestion runs this month
// than last? when did the failure spike happen?" answers.

import type {
  IngestionRegistry,
  ConnectorRun,
  RunStatus,
} from './ingestion';

const MS_PER_DAY = 86_400_000;

export const DEFAULT_RUN_DAILY_WINDOW = 30;
export const MAX_RUN_DAILY_WINDOW = 365;
const PER_CONNECTOR_RUN_LIMIT = 200;

const ALL_RUN_STATUSES: readonly RunStatus[] = [
  'success',
  'failure',
  'partial',
  'running',
] as const;

// ─── Public types ──────────────────────────────────────────────────────

export interface ConnectorRunDailyBucket {
  /** UTC calendar date in YYYY-MM-DD format. */
  date: string;
  total: number;
  /** Per-status counts; every RunStatus key at 0 when absent. */
  by_status: Record<RunStatus, number>;
  /** Distinct connectors with ≥ 1 run on this day. */
  distinct_connectors: number;
}

export interface ConnectorRunDailyVolume {
  tenant_id: string;
  generated_at: string;
  days: number;
  /** UTC date string of the oldest bucket emitted. */
  window_start: string;
  /** UTC date string of the newest bucket (today UTC). */
  window_end: string;
  /** Runs landing inside the window (sum of bucketed days). */
  total_runs_in_window: number;
  /** Runs across the entire drained pool (incl. outside window). */
  total_runs_observed: number;
  per_connector_limit: number; // = PER_CONNECTOR_RUN_LIMIT
  by_day: ConnectorRunDailyBucket[];
  /** Highest-count day; earliest-day-wins tie-break via strict `>`;
   *  null when zero runs in window. */
  peak_day: string | null;
  peak_count: number;
  /** Mean runs per day across the window (rounded). */
  mean_per_day: number;
  /** Second-half mean − first-half mean / first-half mean. Positive =
   *  growth, negative = shrinking. null when first-half mean = 0 OR
   *  days < 2. */
  growth_rate: number | null;
  /** Status with highest total across window; canonical tie-break
   *  (success > failure > partial > running at tied count); null when
   *  zero runs. */
  busiest_status: RunStatus | null;
}

export class ConnectorRunDailyVolumeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ConnectorRunDailyVolumeError';
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByStatus(): Record<RunStatus, number> {
  const out = {} as Record<RunStatus, number>;
  for (const s of ALL_RUN_STATUSES) out[s] = 0;
  return out;
}

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcDayStart(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildConnectorRunDailyVolume(
  registry: IngestionRegistry,
  tenant_id: string,
  days: number,
  now: Date,
): ConnectorRunDailyVolume {
  if (!Number.isInteger(days) || days < 1 || days > MAX_RUN_DAILY_WINDOW) {
    throw new ConnectorRunDailyVolumeError(
      'invalid_input',
      `days must be an integer in [1, ${MAX_RUN_DAILY_WINDOW}]`,
    );
  }

  const todayUtc = utcDayStart(now);
  const windowStartUtc = new Date(todayUtc.getTime() - (days - 1) * MS_PER_DAY);

  // Pre-allocate every bucket so the SPA chart axis is stable even
  // for days with zero runs.
  const buckets: ConnectorRunDailyBucket[] = [];
  const bucketIndex = new Map<string, ConnectorRunDailyBucket>();
  for (let i = 0; i < days; i++) {
    const dayUtc = new Date(windowStartUtc.getTime() + i * MS_PER_DAY);
    const date = utcDateString(dayUtc);
    const bucket: ConnectorRunDailyBucket = {
      date,
      total: 0,
      by_status: emptyByStatus(),
      distinct_connectors: 0,
    };
    buckets.push(bucket);
    bucketIndex.set(date, bucket);
  }

  // Track distinct connectors per day via a per-day Set.
  const connectorSetsByDay = new Map<string, Set<string>>();
  for (const b of buckets) connectorSetsByDay.set(b.date, new Set<string>());

  let total_runs_observed = 0;
  let total_runs_in_window = 0;

  for (const connector of registry.list(tenant_id)) {
    const runs: ConnectorRun[] = registry.listRuns(
      tenant_id,
      connector.id,
      PER_CONNECTOR_RUN_LIMIT,
    );
    for (const run of runs) {
      total_runs_observed++;
      const startedAt = new Date(run.started_at).getTime();
      if (Number.isNaN(startedAt)) continue;
      const dayStr = utcDateString(utcDayStart(new Date(startedAt)));
      const bucket = bucketIndex.get(dayStr);
      if (!bucket) continue; // outside window
      bucket.total++;
      total_runs_in_window++;
      if (ALL_RUN_STATUSES.includes(run.status)) {
        bucket.by_status[run.status]++;
      }
      connectorSetsByDay.get(dayStr)!.add(connector.id);
    }
  }

  // Resolve distinct_connectors per bucket.
  for (const bucket of buckets) {
    bucket.distinct_connectors = connectorSetsByDay.get(bucket.date)!.size;
  }

  // peak_day — highest total; earliest-day-wins tie-break.
  let peak_day: string | null = null;
  let peak_count = 0;
  for (const bucket of buckets) {
    if (bucket.total > peak_count) {
      peak_count = bucket.total;
      peak_day = bucket.date;
    }
  }

  const mean_per_day = Math.round(total_runs_in_window / days);

  // growth_rate — null when days<2 OR first-half mean=0.
  let growth_rate: number | null = null;
  if (days >= 2) {
    const half = Math.floor(days / 2);
    let firstSum = 0;
    let secondSum = 0;
    for (let i = 0; i < days; i++) {
      if (i < half) firstSum += buckets[i].total;
      else secondSum += buckets[i].total;
    }
    const firstHalfMean = firstSum / half;
    const secondHalfMean = secondSum / (days - half);
    if (firstHalfMean > 0) {
      growth_rate = (secondHalfMean - firstHalfMean) / firstHalfMean;
    }
  }

  // busiest_status — highest count across window; canonical tie-break.
  let busiest_status: RunStatus | null = null;
  let busiestCount = 0;
  const statusTotals: Record<RunStatus, number> = emptyByStatus();
  for (const bucket of buckets) {
    for (const s of ALL_RUN_STATUSES) {
      statusTotals[s] += bucket.by_status[s];
    }
  }
  for (const s of ALL_RUN_STATUSES) {
    if (statusTotals[s] > busiestCount) {
      busiestCount = statusTotals[s];
      busiest_status = s;
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    days,
    window_start: utcDateString(windowStartUtc),
    window_end: utcDateString(todayUtc),
    total_runs_in_window,
    total_runs_observed,
    per_connector_limit: PER_CONNECTOR_RUN_LIMIT,
    by_day: buckets,
    peak_day,
    peak_count,
    mean_per_day,
    growth_rate,
    busiest_status,
  };
}
