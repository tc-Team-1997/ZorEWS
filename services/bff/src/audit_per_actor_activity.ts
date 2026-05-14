// services/bff/src/audit_per_actor_activity.ts
//
// T6 M15.8 — Audit log per-actor activity rollup.
//
// M15.1 ships the audit trail with N-axis filtering. M15.6 ships
// the per-action catalog (action verb → count). M15.7 ships the
// day-of-week × hour-of-day heatmap. M15.8 ships the orthogonal
// actor-pivoted rollup: for every distinct `actor_username` in
// the chain, count their total events + per-action breakdown +
// per-resource_type breakdown + per-outcome breakdown + first
// and last event timestamps.
//
// Lets the SPA render an "ops activity by user" panel surfacing
// who's busiest in the audit chain. Useful for periodic access
// reviews ("user X did 200 config changes last quarter — verify
// scope is appropriate") + after-incident forensics.
//
// Pure rollup over an AuditEvent[] array. Tenant-scoped at the
// caller layer.

import type {
  AuditEvent,
  AuditOutcome,
  AuditResourceType,
} from './audit_trail';

// ─── Public types ─────────────────────────────────────────────────────

const ALL_OUTCOMES: readonly AuditOutcome[] = ['success', 'failure', 'denied'] as const;
const ALL_RESOURCE_TYPES: readonly AuditResourceType[] = [
  'user',
  'session',
  'config',
  'case',
  'alert',
  'report',
  'scenario',
  'rule',
  'integration',
  'system',
] as const;

export interface ActorActivityRow {
  actor_username: string;
  total_events: number;
  /** Distinct action verbs this actor performed. */
  distinct_actions: number;
  /** Count per action verb (open enum so all keys are dynamic).
   *  Sorted by count desc with action asc tie-break at serialise
   *  time via `by_action_top[]`; the raw map is unsorted. */
  by_action: Record<string, number>;
  /** Top 5 actions for this actor. */
  by_action_top: Array<{ action: string; count: number }>;
  /** Per-AuditOutcome: every key present, zero when absent. */
  by_outcome: Record<AuditOutcome, number>;
  /** Per-AuditResourceType: every key present, zero when absent. */
  by_resource_type: Record<AuditResourceType, number>;
  /** First (oldest) and last (newest) event timestamps for this
   *  actor. ISO strings; both always set if total_events > 0. */
  first_event_at: string | null;
  last_event_at: string | null;
  /** Highest-severity actor_role seen for this actor (audit events
   *  carry the role at event-time, which can drift). Helpful for
   *  the SPA chip rendering — admin > supervisor > others. null
   *  when no events. */
  primary_role: string | null;
}

export interface ActorActivitySummary {
  tenant_id: string;
  generated_at: string;
  total_actors: number;
  total_events: number;
  /** Actors sorted by total_events desc with actor_username asc
   *  tie-break — busiest floats to the top. */
  actors: ActorActivityRow[];
  /** Top actor by total_events. null when no events observed.
   *  Ties broken by actor_username asc. */
  most_active_actor: {
    actor_username: string;
    total_events: number;
  } | null;
  /** Actors who only ever caused failure-outcome events (every
   *  recorded event has outcome='failure' or 'denied'). Sorted asc.
   *  Empty when no such actor exists. */
  failure_only_actors: string[];
}

// ─── Pure resolver ────────────────────────────────────────────────────

function emptyOutcomeCounts(): Record<AuditOutcome, number> {
  return { success: 0, failure: 0, denied: 0 };
}

function emptyResourceCounts(): Record<AuditResourceType, number> {
  return {
    user: 0,
    session: 0,
    config: 0,
    case: 0,
    alert: 0,
    report: 0,
    scenario: 0,
    rule: 0,
    integration: 0,
    system: 0,
  };
}

// Hierarchy for primary_role selection — admin first, then
// supervisor, then alphabetical fallback among others.
const ROLE_RANK: Record<string, number> = {
  admin: 0,
  supervisor: 1,
  risk_analyst: 2,
  case_owner: 3,
  field_officer: 4,
};

function pickPrimaryRole(seen: Set<string>): string | null {
  if (seen.size === 0) return null;
  const sorted = [...seen].sort((a, b) => {
    const ra = ROLE_RANK[a] ?? 99;
    const rb = ROLE_RANK[b] ?? 99;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
  return sorted[0] ?? null;
}

function buildRow(actor_username: string): ActorActivityRow {
  return {
    actor_username,
    total_events: 0,
    distinct_actions: 0,
    by_action: {},
    by_action_top: [],
    by_outcome: emptyOutcomeCounts(),
    by_resource_type: emptyResourceCounts(),
    first_event_at: null,
    last_event_at: null,
    primary_role: null,
  };
}

export function summarizePerActorActivity(
  tenant_id: string,
  events: readonly AuditEvent[],
  now: Date,
): ActorActivitySummary {
  const byActor = new Map<string, ActorActivityRow>();
  const rolesByActor = new Map<string, Set<string>>();
  let total_events = 0;

  for (const e of events) {
    let row = byActor.get(e.actor_username);
    if (!row) {
      row = buildRow(e.actor_username);
      byActor.set(e.actor_username, row);
      rolesByActor.set(e.actor_username, new Set());
    }
    row.total_events++;
    total_events++;

    row.by_action[e.action] = (row.by_action[e.action] ?? 0) + 1;
    if (ALL_OUTCOMES.includes(e.outcome)) {
      row.by_outcome[e.outcome]++;
    }
    if (ALL_RESOURCE_TYPES.includes(e.resource_type)) {
      row.by_resource_type[e.resource_type]++;
    }
    if (!row.first_event_at || e.ts < row.first_event_at) row.first_event_at = e.ts;
    if (!row.last_event_at || e.ts > row.last_event_at) row.last_event_at = e.ts;
    rolesByActor.get(e.actor_username)!.add(e.actor_role);
  }

  // Build top-5 + distinct_actions + primary_role per row.
  for (const [actor, row] of byActor.entries()) {
    const entries = Object.entries(row.by_action);
    row.distinct_actions = entries.length;
    row.by_action_top = entries
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, 5)
      .map(([action, count]) => ({ action, count }));
    row.primary_role = pickPrimaryRole(rolesByActor.get(actor)!);
  }

  const actors = [...byActor.values()].sort((a, b) => {
    if (b.total_events !== a.total_events) return b.total_events - a.total_events;
    return a.actor_username.localeCompare(b.actor_username);
  });

  const most_active_actor = actors.length > 0
    ? { actor_username: actors[0]!.actor_username, total_events: actors[0]!.total_events }
    : null;

  const failure_only_actors = actors
    .filter((a) => a.total_events > 0 && a.by_outcome.success === 0
      && (a.by_outcome.failure + a.by_outcome.denied) === a.total_events)
    .map((a) => a.actor_username)
    .sort();

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_actors: actors.length,
    total_events,
    actors,
    most_active_actor,
    failure_only_actors,
  };
}
