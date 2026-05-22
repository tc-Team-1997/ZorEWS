// services/bff/src/connector_freshness_alert.ts
//
// T6 M3.19 — Connector data-freshness alert detector.
//
// Per-connector freshness check: compares each connector's
// `last_run_at` against the schedule deadline. Flags connectors
// where the next expected run is overdue → "your CBS ingest hasn't
// run in 4 hours, expected every 5 minutes — investigate now".
//
// Distinct from:
//   M3.1  — connector registry + run-history (raw inventory)
//   M3.5  — connector run analytics (success-rate + percentile)
//   M3.6  — failure pattern clustering (errors, not staleness)
//   M3.12 — hourly-volume timeline (when do runs happen, not "is the
//           next run overdue?")
//   M14.26 — adapter SLA budget (M14 fleet, different surface)
//
// Mirror of M14.26 SLA budget pattern, adapted for the ingestion
// connector registry: replace expected p95 latency with expected
// run interval; replace observed latency with overdue_minutes.
//
// Parses the free-form `schedule` string into expected_interval_minutes
// via a small regex grammar. Schedules that don't parse fall through
// to `unparseable_schedule` status (informational, no alert) so the
// resolver stays forward-compatible with new schedule formats.

import type {
  Connector,
  ConnectorStatus,
  IngestionRegistry,
} from './ingestion';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

/** Status verdict per connector. */
export type FreshnessStatus =
  | 'on_time' // last_run_at within expected window
  | 'overdue' // 0 < overdue_minutes ≤ expected_interval_minutes
  | 'critical_stale' // overdue_minutes > expected_interval_minutes (≥ 2× window)
  | 'never_run' // schedule parses but no last_run_at yet
  | 'unparseable_schedule' // free-form schedule can't be mapped to minutes
  | 'paused'; // connector paused → no expectation

export const ALL_FRESHNESS_STATUSES: readonly FreshnessStatus[] = [
  'on_time',
  'overdue',
  'critical_stale',
  'never_run',
  'unparseable_schedule',
  'paused',
] as const;

// ---------------------------------------------------------------------
// Schedule parser — tiny regex grammar for the seed catalog patterns
// ---------------------------------------------------------------------

/** Parse Connector.schedule → expected minutes between runs.
 *  Returns null for free-form / unrecognised schedules (caller treats
 *  as 'unparseable_schedule'). */
export function parseScheduleMinutes(schedule: string): number | null {
  const s = schedule.trim().toLowerCase();
  if (s === '') return null;

  // continuous / realtime / streaming → 1 minute window
  if (s === 'continuous' || s === 'realtime' || s === 'streaming') return 1;

  // "every N min", "every N minutes"
  const everyMin = s.match(/^every\s+(\d+)\s*(min|mins|minute|minutes)$/);
  if (everyMin) return Number.parseInt(everyMin[1], 10);

  // "every N hour", "every N hours" → N × 60
  const everyHour = s.match(/^every\s+(\d+)\s*(hr|hrs|hour|hours)$/);
  if (everyHour) return Number.parseInt(everyHour[1], 10) * 60;

  // "hourly" → 60
  if (s === 'hourly') return 60;

  // "daily HH:MM" or "daily" → 1440 (24 × 60)
  if (s === 'daily' || /^daily\s+\d{1,2}:\d{2}$/.test(s)) return 1440;

  // "weekly" or "weekly on <day>" → 10080 (7 × 1440)
  if (s === 'weekly' || /^weekly\b/.test(s)) return 10_080;

  // "monthly" → 43200 (30 × 1440) — approximation
  if (s === 'monthly') return 43_200;

  return null;
}

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface ConnectorFreshnessRow {
  connector_id: string;
  name: string;
  source_system: string;
  schedule: string;
  connector_status: ConnectorStatus;
  /** Parsed schedule interval — null when schedule is unparseable
   *  or the connector is paused. */
  expected_interval_minutes: number | null;
  /** Most recent run timestamp; null when never run. */
  last_run_at: string | null;
  /**
   * When the next run was expected = last_run_at + expected_interval.
   * null when paused / unparseable / never_run.
   */
  expected_next_run_at: string | null;
  /**
   * Signed: positive = overdue, 0 or negative = on time. null when
   * we can't compute (paused / unparseable / never_run).
   */
  overdue_minutes: number | null;
  freshness_status: FreshnessStatus;
}

export interface ConnectorFreshnessReport {
  tenant_id: string;
  generated_at: string;
  total_connectors: number;
  /** Every FreshnessStatus key present at 0 when absent — stable grid. */
  by_status: Record<FreshnessStatus, number>;
  /** All connectors sorted by overdue_minutes desc (most stale first),
   *  paused/never_run/unparseable/on_time at the tail in canonical
   *  status order. */
  connectors: ConnectorFreshnessRow[];
  /**
   * Worst offender: connector with highest overdue_minutes among
   * overdue + critical_stale rows. null when nothing at risk.
   */
  worst_offender: {
    connector_id: string;
    name: string;
    overdue_minutes: number;
    freshness_status: FreshnessStatus;
  } | null;
  /** Total connectors with overdue OR critical_stale status. */
  total_at_risk: number;
  /** Convenience: number of paused connectors (excluded from at-risk). */
  total_paused: number;
}

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

function zeroByStatus(): Record<FreshnessStatus, number> {
  return {
    on_time: 0,
    overdue: 0,
    critical_stale: 0,
    never_run: 0,
    unparseable_schedule: 0,
    paused: 0,
  };
}

/** Classify (overdue_minutes, expected_interval) into status. */
function classifyOverdue(
  overdueMinutes: number,
  expectedInterval: number,
): 'on_time' | 'overdue' | 'critical_stale' {
  if (overdueMinutes <= 0) return 'on_time';
  if (overdueMinutes > expectedInterval) return 'critical_stale';
  return 'overdue';
}

function buildRow(
  connector: Connector,
  now: Date,
): ConnectorFreshnessRow {
  // Paused connectors have no expectation
  if (connector.paused_at !== null) {
    return {
      connector_id: connector.id,
      name: connector.name,
      source_system: connector.source_system,
      schedule: connector.schedule,
      connector_status: connector.status,
      expected_interval_minutes: null,
      last_run_at: connector.last_run_at,
      expected_next_run_at: null,
      overdue_minutes: null,
      freshness_status: 'paused',
    };
  }

  const expected = parseScheduleMinutes(connector.schedule);
  if (expected === null) {
    return {
      connector_id: connector.id,
      name: connector.name,
      source_system: connector.source_system,
      schedule: connector.schedule,
      connector_status: connector.status,
      expected_interval_minutes: null,
      last_run_at: connector.last_run_at,
      expected_next_run_at: null,
      overdue_minutes: null,
      freshness_status: 'unparseable_schedule',
    };
  }

  if (connector.last_run_at === null) {
    return {
      connector_id: connector.id,
      name: connector.name,
      source_system: connector.source_system,
      schedule: connector.schedule,
      connector_status: connector.status,
      expected_interval_minutes: expected,
      last_run_at: null,
      expected_next_run_at: null,
      overdue_minutes: null,
      freshness_status: 'never_run',
    };
  }

  const lastRunMs = Date.parse(connector.last_run_at);
  if (!Number.isFinite(lastRunMs)) {
    // Defensive — treat malformed timestamp as unparseable
    return {
      connector_id: connector.id,
      name: connector.name,
      source_system: connector.source_system,
      schedule: connector.schedule,
      connector_status: connector.status,
      expected_interval_minutes: expected,
      last_run_at: connector.last_run_at,
      expected_next_run_at: null,
      overdue_minutes: null,
      freshness_status: 'unparseable_schedule',
    };
  }

  const expectedNextRunMs = lastRunMs + expected * 60_000;
  const expectedNextRunAt = new Date(expectedNextRunMs).toISOString();
  const overdueMinutes = Math.round((now.getTime() - expectedNextRunMs) / 60_000);
  const freshness_status = classifyOverdue(overdueMinutes, expected);

  return {
    connector_id: connector.id,
    name: connector.name,
    source_system: connector.source_system,
    schedule: connector.schedule,
    connector_status: connector.status,
    expected_interval_minutes: expected,
    last_run_at: connector.last_run_at,
    expected_next_run_at: expectedNextRunAt,
    overdue_minutes: overdueMinutes,
    freshness_status,
  };
}

// ---------------------------------------------------------------------
// Sort priority: overdue rows first (most overdue first), then
// canonical status order for the rest. Tie-break by connector_id asc.
// ---------------------------------------------------------------------

const SORT_PRIORITY: Record<FreshnessStatus, number> = {
  critical_stale: 0,
  overdue: 1,
  never_run: 2,
  unparseable_schedule: 3,
  paused: 4,
  on_time: 5,
};

function compareRows(a: ConnectorFreshnessRow, b: ConnectorFreshnessRow): number {
  // If both have overdue_minutes, sort by overdue desc first
  if (a.overdue_minutes !== null && b.overdue_minutes !== null) {
    if (a.overdue_minutes !== b.overdue_minutes) {
      return b.overdue_minutes - a.overdue_minutes;
    }
  }
  // Otherwise use status priority
  const pa = SORT_PRIORITY[a.freshness_status];
  const pb = SORT_PRIORITY[b.freshness_status];
  if (pa !== pb) return pa - pb;
  // Tie-break: connector_id asc
  return a.connector_id.localeCompare(b.connector_id);
}

// ---------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------

export function buildConnectorFreshnessReport(
  registry: IngestionRegistry,
  tenant_id: string,
  now: Date,
): ConnectorFreshnessReport {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new Error('buildConnectorFreshnessReport: tenant_id required');
  }

  const connectors = registry.list(tenant_id);
  const rows = connectors.map((c) => buildRow(c, now));

  // Count by status
  const by_status = zeroByStatus();
  for (const r of rows) by_status[r.freshness_status] += 1;

  // Sort rows
  rows.sort(compareRows);

  // Worst offender = highest overdue among overdue + critical_stale
  let worst_offender: ConnectorFreshnessReport['worst_offender'] = null;
  for (const r of rows) {
    if (
      (r.freshness_status === 'overdue' || r.freshness_status === 'critical_stale') &&
      r.overdue_minutes !== null
    ) {
      if (!worst_offender || r.overdue_minutes > worst_offender.overdue_minutes) {
        worst_offender = {
          connector_id: r.connector_id,
          name: r.name,
          overdue_minutes: r.overdue_minutes,
          freshness_status: r.freshness_status,
        };
      }
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_connectors: rows.length,
    by_status,
    connectors: rows,
    worst_offender,
    total_at_risk: by_status.overdue + by_status.critical_stale,
    total_paused: by_status.paused,
  };
}
