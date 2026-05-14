// services/bff/src/case_timeline.ts
//
// T6 M9.6 — Case investigation timeline reconstruction.
//
// M9.4 ships the per-tenant append-only event journal; M9.5 ships
// the cross-case SLA breach detector. M9.6 zooms in: take ONE case
// and reconstruct its full state-transition ladder from the events
// — opened → state_changes → final state, with the time spent in
// each state surfaced as a duration. Useful for case retrospectives
// + supervisor case-review views (the "what happened on this case?"
// dashboard panel).
//
// Design:
//  - Pure function. Caller passes the events array — typically
//    `caseEventStore.forCase(tenant, case_id)` — plus `now` for
//    the open-case age computation.
//  - Walks events in `sequence_no` order (defensively sorts even
//    though forCase returns insertion-order — same as M9.5).
//  - `opened` seeds the initial state; `state_change.payload.to`
//    transitions; `closed` drops to terminal. Mirrors M9.5's
//    reconstruction logic so the two views tell a consistent story.

import type { CaseEvent, CaseEventAction } from './case_events';

// ─── Public types ─────────────────────────────────────────────────────

const ALL_ACTIONS: CaseEventAction[] = [
  'opened',
  'state_change',
  'closed',
  'escalated',
  'override_requested',
  'override_approved',
  'override_rejected',
  'note_added',
  'checklist_updated',
];

export interface CaseTransition {
  /** Per-tenant monotonic sequence_no of the source event. */
  sequence_no: number;
  /** ISO timestamp of the transition. */
  occurred_at: string;
  /** Actor that drove the transition. */
  actor: string;
  /** State immediately before this transition. null on the initial
   *  `opened` event (no prior state to come from). */
  from_state: string | null;
  /** State entered by this transition. For `closed` events this is
   *  'closed'. */
  to_state: string;
  /** Wall-clock hours spent in `from_state` immediately before this
   *  transition. null on the initial opened transition. */
  duration_in_previous_state_hours: number | null;
}

export interface CaseTimeline {
  case_id: string;
  /** Total events observed for this case (including non-state events
   *  like note_added / checklist_updated). */
  total_events: number;
  /** Counts per CaseEventAction — every key present at 0 when absent. */
  events_by_action: Record<CaseEventAction, number>;
  /** ISO of the `opened` event. null when the case has never been opened
   *  (only non-opened events present). */
  opened_at: string | null;
  /** ISO of the `closed` event. null when the case is still open. */
  closed_at: string | null;
  /** Current state — 'closed' when closed, else the last state_change
   *  destination (or the opened seed). null when no opened event. */
  current_state: string | null;
  /** Wall-clock hours from when the case ENTERED its current state.
   *  null when the case has no opened event. When closed, the time
   *  the case spent in 'closed' (typically 0 since closing is
   *  terminal; non-zero only if reopened/state_changed after close). */
  time_in_current_state_hours: number | null;
  /** Wall-clock hours from opened_at to closed_at (or now if open).
   *  null when no opened event. */
  total_age_hours: number | null;
  /** Ordered transition ladder (oldest-first). Each entry is the
   *  *result* of an `opened` / `state_change` / `closed` event;
   *  non-state-changing events (note_added etc.) are summed into
   *  events_by_action but don't produce a transition row. */
  transitions: CaseTransition[];
}

// ─── Helpers ──────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

function emptyByAction(): Record<CaseEventAction, number> {
  const out = {} as Record<CaseEventAction, number>;
  for (const a of ALL_ACTIONS) out[a] = 0;
  return out;
}

function hoursBetween(a: string, b: string): number {
  const ams = new Date(a).getTime();
  const bms = new Date(b).getTime();
  if (!Number.isFinite(ams) || !Number.isFinite(bms)) return 0;
  return Math.max(0, (bms - ams) / HOUR_MS);
}

// ─── Pure reconstructor ──────────────────────────────────────────────

/**
 * Reconstruct one case's timeline from a slice of events. Caller is
 * responsible for filtering events to a single case_id (typically via
 * `caseEventStore.forCase`).
 */
export function reconstructCaseTimeline(
  events: readonly CaseEvent[],
  case_id: string,
  now: Date,
): CaseTimeline {
  const sorted = events
    .filter((e) => e.case_id === case_id)
    .slice()
    .sort((a, b) => a.sequence_no - b.sequence_no);
  const events_by_action = emptyByAction();
  for (const e of sorted) {
    if (ALL_ACTIONS.includes(e.action)) events_by_action[e.action] += 1;
  }

  let opened_at: string | null = null;
  let closed_at: string | null = null;
  let current_state: string | null = null;
  let current_entered_at: string | null = null;
  const transitions: CaseTransition[] = [];

  for (const e of sorted) {
    if (e.action === 'opened') {
      const initial =
        typeof e.payload.initial_state === 'string' && e.payload.initial_state.trim()
          ? (e.payload.initial_state as string).trim()
          : 'triage';
      if (opened_at === null) opened_at = e.recorded_at;
      // First opened seeds the case; any further opened events are
      // anomalies but treated as transitions for completeness.
      transitions.push({
        sequence_no: e.sequence_no,
        occurred_at: e.recorded_at,
        actor: e.actor,
        from_state: current_state,
        to_state: initial,
        duration_in_previous_state_hours:
          current_entered_at === null
            ? null
            : hoursBetween(current_entered_at, e.recorded_at),
      });
      current_state = initial;
      current_entered_at = e.recorded_at;
    } else if (e.action === 'state_change' && current_state !== null) {
      const to = e.payload.to;
      if (typeof to !== 'string' || !to.trim()) continue;
      transitions.push({
        sequence_no: e.sequence_no,
        occurred_at: e.recorded_at,
        actor: e.actor,
        from_state: current_state,
        to_state: to.trim(),
        duration_in_previous_state_hours:
          current_entered_at === null
            ? null
            : hoursBetween(current_entered_at, e.recorded_at),
      });
      current_state = to.trim();
      current_entered_at = e.recorded_at;
    } else if (e.action === 'closed' && current_state !== null) {
      transitions.push({
        sequence_no: e.sequence_no,
        occurred_at: e.recorded_at,
        actor: e.actor,
        from_state: current_state,
        to_state: 'closed',
        duration_in_previous_state_hours:
          current_entered_at === null
            ? null
            : hoursBetween(current_entered_at, e.recorded_at),
      });
      current_state = 'closed';
      current_entered_at = e.recorded_at;
      if (closed_at === null) closed_at = e.recorded_at;
    }
    // Other actions (note_added, checklist_updated, override_*,
    // escalated) are summed into events_by_action but don't shift state.
  }

  const time_in_current_state_hours =
    current_entered_at === null
      ? null
      : hoursBetween(current_entered_at, closed_at ?? now.toISOString());
  const total_age_hours =
    opened_at === null
      ? null
      : hoursBetween(opened_at, closed_at ?? now.toISOString());

  return {
    case_id,
    total_events: sorted.length,
    events_by_action,
    opened_at,
    closed_at,
    current_state,
    time_in_current_state_hours,
    total_age_hours,
    transitions,
  };
}
