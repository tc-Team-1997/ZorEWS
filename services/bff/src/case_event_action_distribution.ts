// services/bff/src/case_event_action_distribution.ts
//
// T6 M9.15 — Investigation event journal action distribution.
//
// M9.4 ships the case event journal — append-only ledger with 9 distinct
// action values (opened / state_change / closed / escalated /
// override_requested / override_approved / override_rejected /
// note_added / checklist_updated). M9.6 ships per-case timeline
// reconstruction.
//
// M9.15 lands the 1D PIVOT-BY-ACTION view across the entire tenant
// event chain. Per-action row carries count + distinct cases +
// distinct actors + most-recent timestamp. Envelope leaderboards
// surface most_common_action + unused_actions + most_active_actor
// (across all action types).
//
// Mirror of M14.27 / M7.13 / M3.13 / M5.16 1D distribution pattern
// for the case events surface.
//
// Drives BIL ops "what's our case-management activity mix? are
// overrides spiking? how many notes-added vs state-changes this week?"
// answers in one round-trip.
//
// Pure resolver — caller passes drained event list.

import {
  CASE_EVENT_ACTIONS,
  type CaseEvent,
  type CaseEventAction,
} from './case_events';

// ─── Public types ──────────────────────────────────────────────────────

export interface CaseEventActionRow {
  action: CaseEventAction;
  count: number;
  /** Distinct case_ids that fired at least one event of this action. */
  distinct_cases: number;
  /** Distinct actor usernames that fired at least one event of this action. */
  distinct_actors: number;
  /** Newest recorded_at across this row's events; null when count=0. */
  most_recent_at: string | null;
  /** Top-3 sample actors (newest-first by their most-recent event of
   *  this action; ties broken by actor asc). */
  sample_actors: string[];
}

export interface CaseEventActionDistributionSummary {
  tenant_id: string;
  generated_at: string;
  total_events: number;
  /** Per-action rows in canonical CASE_EVENT_ACTIONS order even when
   *  zero-count — stable SPA grid. */
  actions: CaseEventActionRow[];
  /** Action with highest count; canonical-order tie-break via
   *  iteration; null when no events. */
  most_common_action: CaseEventAction | null;
  /** Actions with count=0 in canonical order. */
  unused_actions: CaseEventAction[];
  /** Actor with the most events across the WHOLE chain (regardless
   *  of action); canonical username asc tie-break; null when empty. */
  most_active_actor: string | null;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function summarizeCaseEventActionDistribution(
  tenant_id: string,
  events: readonly CaseEvent[],
  now: Date,
): CaseEventActionDistributionSummary {
  // Per-action buckets initialised at 0 for every canonical key.
  type Bucket = {
    count: number;
    cases: Set<string>;
    actors: Set<string>;
    most_recent_at: string | null;
    actorLastSeen: Map<string, string>;
  };
  const buckets = new Map<CaseEventAction, Bucket>();
  for (const a of CASE_EVENT_ACTIONS) {
    buckets.set(a, {
      count: 0,
      cases: new Set<string>(),
      actors: new Set<string>(),
      most_recent_at: null,
      actorLastSeen: new Map<string, string>(),
    });
  }

  // Fleet-wide actor counts for most_active_actor.
  const actorTotals = new Map<string, number>();

  for (const e of events) {
    if (!(CASE_EVENT_ACTIONS as readonly string[]).includes(e.action)) continue;
    const b = buckets.get(e.action)!;
    b.count++;
    if (e.case_id) b.cases.add(e.case_id);
    if (e.actor) {
      b.actors.add(e.actor);
      const prev = b.actorLastSeen.get(e.actor);
      if (!prev || e.recorded_at > prev) {
        b.actorLastSeen.set(e.actor, e.recorded_at);
      }
      actorTotals.set(e.actor, (actorTotals.get(e.actor) ?? 0) + 1);
    }
    if (!b.most_recent_at || e.recorded_at > b.most_recent_at) {
      b.most_recent_at = e.recorded_at;
    }
  }

  const actions: CaseEventActionRow[] = CASE_EVENT_ACTIONS.map((a) => {
    const b = buckets.get(a)!;
    // sample_actors: top 3, sorted by their most-recent event newest-first,
    // tie-broken by actor asc.
    const actorPairs = [...b.actorLastSeen.entries()];
    actorPairs.sort((x, y) => {
      if (x[1] !== y[1]) return x[1] < y[1] ? 1 : -1; // newest first
      return x[0].localeCompare(y[0]);
    });
    const sample_actors = actorPairs.slice(0, 3).map(([actor]) => actor);
    return {
      action: a,
      count: b.count,
      distinct_cases: b.cases.size,
      distinct_actors: b.actors.size,
      most_recent_at: b.most_recent_at,
      sample_actors,
    };
  });

  // most_common_action — highest count; canonical-order tie-break via
  // iteration.
  let most_common_action: CaseEventAction | null = null;
  let mostCount = 0;
  for (const a of CASE_EVENT_ACTIONS) {
    const c = buckets.get(a)!.count;
    if (c > mostCount) {
      mostCount = c;
      most_common_action = a;
    }
  }
  if (mostCount === 0) most_common_action = null;

  // unused_actions — canonical-order zero-count filter.
  const unused_actions: CaseEventAction[] = CASE_EVENT_ACTIONS.filter(
    (a) => buckets.get(a)!.count === 0,
  );

  // most_active_actor — fleet-wide highest count; canonical username asc tie-break.
  let most_active_actor: string | null = null;
  let mostActorCount = 0;
  const actorEntries = [...actorTotals.entries()].sort((x, y) => {
    if (x[1] !== y[1]) return y[1] - x[1];
    return x[0].localeCompare(y[0]);
  });
  if (actorEntries.length > 0 && actorEntries[0][1] > 0) {
    most_active_actor = actorEntries[0][0];
    mostActorCount = actorEntries[0][1];
  }
  // (mostActorCount unused after assignment but kept for clarity.)
  void mostActorCount;

  const total_events = [...buckets.values()].reduce((acc, b) => acc + b.count, 0);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_events,
    actions,
    most_common_action,
    unused_actions,
    most_active_actor,
  };
}
