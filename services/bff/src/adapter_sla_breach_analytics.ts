// services/bff/src/adapter_sla_breach_analytics.ts
//
// T6 M14.20 — Adapter SLA breach event analytics.
//
// M14.11 ships the fleet SLA dashboard, M14.13 the per-tenant
// breach-event store, M14.14 acknowledgement metadata on events.
// M14.20 closes the loop with the supervisor view: across the
// recent window of breach events, which connectors are worst,
// which reasons are most common, how many breaches are still
// unacknowledged?
//
// Design:
//  - Pure aggregator. Caller slices the window (typically
//    `adapterSlaBreachEventStore.query(tenant, { since })`).
//  - top_breachers cap 10 — same posture as M12.5 top_requesters
//    + M10.9 top_users.
//  - by_reason has every SlaBreachReason key present at 0 when
//    none observed → stable SPA card.
//  - by_day uses UTC YYYY-MM-DD slice of observed_at, oldest-first.
//  - Tracks ack_rate: ack-rate = acknowledged_count /
//    (acknowledged_count + unacknowledged_count), null on empty.

import type {
  AdapterSlaBreachEvent,
  SlaBreachReason,
} from './adapter_sla_dashboard';

// ─── Public types ─────────────────────────────────────────────────────

const ALL_REASONS: SlaBreachReason[] = [
  'success_rate_below_target',
  'p95_latency_above_target',
  'no_finished_runs',
];

export interface ConnectorBreachRollup {
  connector_id: string;
  connector_name: string;
  breach_count: number;
  /** ISO timestamp of the newest event for this connector. */
  last_breached_at: string;
  /** Up to 3 newest reason arrays from this connector's events. */
  recent_reasons: SlaBreachReason[][];
}

export interface DailyBreachBucket {
  /** UTC YYYY-MM-DD. */
  day: string;
  count: number;
}

export interface AdapterSlaBreachAnalytics {
  sample_size: number;
  distinct_connectors: number;
  acknowledged_count: number;
  unacknowledged_count: number;
  /** acknowledged_count / sample_size — null when sample_size=0. */
  ack_rate: number | null;
  /** Every reason key present (0 when not observed). One event with
   *  N reasons in `sla_breaches[]` increments each of those keys. */
  by_reason: Record<SlaBreachReason, number>;
  /** Per-day, oldest-first. */
  by_day: DailyBreachBucket[];
  /** Top breaching connectors, cap 10, sorted by breach_count desc
   *  then last_breached_at desc then connector_id asc. */
  top_breachers: ConnectorBreachRollup[];
}

export const TOP_BREACHERS_CAP = 10;
const RECENT_REASONS_CAP = 3;

// ─── Pure aggregator ──────────────────────────────────────────────────

function emptyByReason(): Record<SlaBreachReason, number> {
  return {
    success_rate_below_target: 0,
    p95_latency_above_target: 0,
    no_finished_runs: 0,
  };
}

function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Roll up a window of AdapterSlaBreachEvent records into
 * AdapterSlaBreachAnalytics. Caller slices via
 * `adapterSlaBreachEventStore.query(tenant, { since })`.
 */
export function summarizeBreachEvents(
  events: readonly AdapterSlaBreachEvent[],
): AdapterSlaBreachAnalytics {
  const by_reason = emptyByReason();
  const dayMap = new Map<string, number>();

  type ConnAcc = {
    connector_id: string;
    connector_name: string;
    breach_count: number;
    last_breached_at: string;
    recent: { reasons: SlaBreachReason[]; at: string }[];
  };
  const byConn = new Map<string, ConnAcc>();

  let acknowledged_count = 0;
  for (const e of events) {
    for (const r of e.sla_breaches) {
      if (ALL_REASONS.includes(r)) by_reason[r] += 1;
    }
    if (e.acknowledged_at) acknowledged_count += 1;
    const day = utcDay(e.observed_at);
    if (day) dayMap.set(day, (dayMap.get(day) ?? 0) + 1);

    let acc = byConn.get(e.connector_id);
    if (!acc) {
      acc = {
        connector_id: e.connector_id,
        connector_name: e.connector_name,
        breach_count: 0,
        last_breached_at: e.observed_at,
        recent: [],
      };
      byConn.set(e.connector_id, acc);
    }
    acc.breach_count += 1;
    acc.recent.push({ reasons: [...e.sla_breaches], at: e.observed_at });
    if (e.observed_at > acc.last_breached_at) {
      acc.last_breached_at = e.observed_at;
      // Keep connector_name in sync with the newest event (rename-safe).
      acc.connector_name = e.connector_name;
    }
  }

  // Trim per-connector recent reasons to newest-first cap.
  for (const acc of byConn.values()) {
    acc.recent.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    acc.recent.length = Math.min(acc.recent.length, RECENT_REASONS_CAP);
  }

  const top_breachers: ConnectorBreachRollup[] = [...byConn.values()]
    .map((acc) => ({
      connector_id: acc.connector_id,
      connector_name: acc.connector_name,
      breach_count: acc.breach_count,
      last_breached_at: acc.last_breached_at,
      recent_reasons: acc.recent.map((r) => r.reasons),
    }))
    .sort((a, b) => {
      if (b.breach_count !== a.breach_count) return b.breach_count - a.breach_count;
      if (a.last_breached_at !== b.last_breached_at) {
        return a.last_breached_at < b.last_breached_at ? 1 : -1;
      }
      return a.connector_id < b.connector_id ? -1 : a.connector_id > b.connector_id ? 1 : 0;
    })
    .slice(0, TOP_BREACHERS_CAP);

  const by_day: DailyBreachBucket[] = [];
  for (const [day, count] of dayMap) by_day.push({ day, count });
  by_day.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const sample_size = events.length;
  const unacknowledged_count = sample_size - acknowledged_count;
  const ack_rate = sample_size === 0 ? null : acknowledged_count / sample_size;

  return {
    sample_size,
    distinct_connectors: byConn.size,
    acknowledged_count,
    unacknowledged_count,
    ack_rate,
    by_reason,
    by_day,
    top_breachers,
  };
}
