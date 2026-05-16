// services/bff/src/audit_correlation_rollup.ts
//
// T6 M15.10 — Audit log per-correlation rollup.
//
// M15.1 ships the audit trail with `correlation_id` as an optional
// per-event field. M15.6 pivots by action verb, M15.8 by actor,
// M15.9 by severity. M15.10 ships the fourth pivot axis: group
// every audit event with a non-null `correlation_id` and surface
// the workflow it represents.
//
// Use case: BIL ops sees a customer ID flagged in a Slack channel
// at 14:32 and wants the full transcript — "what happened that
// touched this case, who acted, in what order, did anything fail?"
// Today the operator would filter the audit list manually + scroll;
// M15.10 gives the answer in one round-trip.
//
// Per-correlation row carries:
//   - event_count
//   - distinct_actors[], distinct_resource_types[], distinct_actions[]
//   - first_event_at, last_event_at, duration_ms
//   - action_chain[] oldest-first (ts + action + actor + outcome)
//   - has_failure (any event with outcome != 'success')
//
// Envelope surfaces total_correlations + most_active + longest_running
// + failed_correlations[] for at-a-glance triage.
//
// Pure rollup over an AuditEvent[] array. Tenant-scoped at the caller
// layer (the route only passes the requesting tenant's events).

import type { AuditEvent, AuditOutcome } from './audit_trail';

// ─── Public types ─────────────────────────────────────────────────────

export interface CorrelationChainEntry {
  ts: string;
  action: string;
  actor_username: string;
  outcome: AuditOutcome;
}

export interface CorrelationRollupRow {
  correlation_id: string;
  event_count: number;
  /** Distinct actor_username values seen in this correlation. Sorted asc. */
  distinct_actors: string[];
  /** Distinct resource_type values. Sorted asc. */
  distinct_resource_types: string[];
  /** Distinct action verbs. Sorted asc. */
  distinct_actions: string[];
  /** Oldest event ts in this correlation. */
  first_event_at: string;
  /** Newest event ts. */
  last_event_at: string;
  /** last - first in milliseconds. 0 when only a single event. */
  duration_ms: number;
  /** Ordered timeline of events in this correlation, oldest first.
   *  Tie-broken by event_id asc when timestamps collide. */
  action_chain: CorrelationChainEntry[];
  /** True iff any event in this correlation has outcome != 'success'. */
  has_failure: boolean;
}

export interface AuditCorrelationSummary {
  tenant_id: string;
  generated_at: string;
  /** Every audit event the resolver scanned (with + without correlation). */
  total_events_observed: number;
  total_events_with_correlation: number;
  total_events_without_correlation: number;
  total_correlations: number;
  /** Sorted by event_count desc with correlation_id asc tie-break. */
  correlations: CorrelationRollupRow[];
  /** Top row by event_count. null when no correlations. */
  most_active_correlation: {
    correlation_id: string;
    event_count: number;
  } | null;
  /** Top row by duration_ms (ties broken by correlation_id asc). null
   *  when no correlations. */
  longest_running_correlation: {
    correlation_id: string;
    duration_ms: number;
  } | null;
  /** correlation_ids with has_failure=true, sorted asc. Empty when all clean. */
  failed_correlations: string[];
}

// ─── Pure resolver ────────────────────────────────────────────────────

interface RowBuilder {
  correlation_id: string;
  event_count: number;
  actors: Set<string>;
  resource_types: Set<string>;
  actions: Set<string>;
  first_event_at: string | null;
  last_event_at: string | null;
  chain: Array<CorrelationChainEntry & { event_id: string }>;
  has_failure: boolean;
}

function newBuilder(correlation_id: string): RowBuilder {
  return {
    correlation_id,
    event_count: 0,
    actors: new Set(),
    resource_types: new Set(),
    actions: new Set(),
    first_event_at: null,
    last_event_at: null,
    chain: [],
    has_failure: false,
  };
}

function finalise(b: RowBuilder): CorrelationRollupRow {
  // Sort the chain oldest-first (ts asc, event_id asc tie-break) then
  // strip the event_id helper field used only for ordering.
  const sorted = [...b.chain].sort((x, y) => {
    if (x.ts !== y.ts) return x.ts < y.ts ? -1 : 1;
    return x.event_id < y.event_id ? -1 : 1;
  });
  const first_event_at = b.first_event_at!;
  const last_event_at = b.last_event_at!;
  const duration_ms =
    new Date(last_event_at).getTime() - new Date(first_event_at).getTime();

  return {
    correlation_id: b.correlation_id,
    event_count: b.event_count,
    distinct_actors: [...b.actors].sort(),
    distinct_resource_types: [...b.resource_types].sort(),
    distinct_actions: [...b.actions].sort(),
    first_event_at,
    last_event_at,
    duration_ms,
    action_chain: sorted.map(({ event_id: _eid, ...rest }) => rest),
    has_failure: b.has_failure,
  };
}

export function summarizeAuditByCorrelation(
  tenant_id: string,
  events: readonly AuditEvent[],
  now: Date,
): AuditCorrelationSummary {
  const byCorrelation = new Map<string, RowBuilder>();
  let total_with = 0;
  let total_without = 0;

  for (const e of events) {
    if (e.correlation_id === null || e.correlation_id === undefined) {
      total_without++;
      continue;
    }
    total_with++;
    let b = byCorrelation.get(e.correlation_id);
    if (!b) {
      b = newBuilder(e.correlation_id);
      byCorrelation.set(e.correlation_id, b);
    }
    b.event_count++;
    b.actors.add(e.actor_username);
    b.resource_types.add(e.resource_type);
    b.actions.add(e.action);
    if (!b.first_event_at || e.ts < b.first_event_at) b.first_event_at = e.ts;
    if (!b.last_event_at || e.ts > b.last_event_at) b.last_event_at = e.ts;
    b.chain.push({
      ts: e.ts,
      action: e.action,
      actor_username: e.actor_username,
      outcome: e.outcome,
      event_id: e.event_id,
    });
    if (e.outcome !== 'success') b.has_failure = true;
  }

  const correlations = [...byCorrelation.values()]
    .map(finalise)
    .sort((a, b) => {
      if (b.event_count !== a.event_count) return b.event_count - a.event_count;
      return a.correlation_id.localeCompare(b.correlation_id);
    });

  const most_active_correlation = correlations.length > 0
    ? {
        correlation_id: correlations[0]!.correlation_id,
        event_count: correlations[0]!.event_count,
      }
    : null;

  // longest_running: find max duration_ms; tie-broken by correlation_id asc.
  let longest_running_correlation: AuditCorrelationSummary['longest_running_correlation'] = null;
  for (const row of correlations) {
    if (!longest_running_correlation) {
      longest_running_correlation = {
        correlation_id: row.correlation_id,
        duration_ms: row.duration_ms,
      };
      continue;
    }
    if (row.duration_ms > longest_running_correlation.duration_ms) {
      longest_running_correlation = {
        correlation_id: row.correlation_id,
        duration_ms: row.duration_ms,
      };
    } else if (
      row.duration_ms === longest_running_correlation.duration_ms &&
      row.correlation_id.localeCompare(longest_running_correlation.correlation_id) < 0
    ) {
      longest_running_correlation = {
        correlation_id: row.correlation_id,
        duration_ms: row.duration_ms,
      };
    }
  }

  const failed_correlations = correlations
    .filter((r) => r.has_failure)
    .map((r) => r.correlation_id)
    .sort();

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_events_observed: events.length,
    total_events_with_correlation: total_with,
    total_events_without_correlation: total_without,
    total_correlations: correlations.length,
    correlations,
    most_active_correlation,
    longest_running_correlation,
    failed_correlations,
  };
}
