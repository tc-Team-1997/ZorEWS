// services/bff/src/case_sla_breach.ts
//
// T6 M9.5 — Case SLA breach detection.
//
// M9.1 ships the 6-state investigation tracker (triage →
// gathering_evidence → awaiting_response → review → decision →
// closed). M9.4 ships the per-tenant append-only event journal with
// `state_change` events carrying `payload: { from, to }`. M9.5 closes
// the SLA loop on the supervisor side: reconstruct each case's state
// timeline from the journal, find the time spent in the current
// state, and surface the cases that have exceeded their per-state
// SLA window.
//
// Design:
//  - Pure resolver over a readonly CaseEvent[] window + a clock. No
//    I/O, no store coupling. Caller supplies the events (typically
//    the full per-tenant journal slice from M9.4 fetchSince).
//  - State-vocabulary agnostic. Caller can pass any sla_by_state map;
//    states absent from the map are tracked as open but never flagged
//    as breached. Default map mirrors the M9.1 InvestigationStatus
//    values with sensible BIL §17 SLA tiers.
//  - State reconstruction: for each case_id, walk events in
//    sequence_no order; `opened` seeds the initial state +
//    entered_at; `state_change.payload.to` transitions; `closed`
//    drops the case out of the open pool.
//  - Breaches sorted worst-first (descending overdue_hours), capped
//    at 50 entries so the SPA strip never has to paginate.

import type { CaseEvent } from './case_events';

// ─── Public types ─────────────────────────────────────────────────────

/** Default SLA tiers — mirror the M9.1 InvestigationStatus values. */
export const DEFAULT_SLA_HOURS_BY_STATE: Readonly<Record<string, number | null>> = {
  triage: 4,
  gathering_evidence: 24,
  awaiting_response: 72,
  review: 24,
  decision: 12,
  closed: null,
};

export interface CaseSlaBreach {
  case_id: string;
  current_state: string;
  /** ISO timestamp the case entered current_state. */
  entered_state_at: string;
  /** Wall-clock hours from entered_state_at → now. */
  hours_in_state: number;
  /** SLA window for current_state in hours. */
  sla_hours: number;
  /** hours_in_state - sla_hours, always > 0 for entries in the list. */
  overdue_hours: number;
}

export interface CaseSlaSummary {
  /** Distinct case_ids observed in the events window. */
  total_cases_observed: number;
  /** Cases that are NOT in `closed` state. */
  open_cases: number;
  /** Cases that have a `closed` event. */
  closed_cases: number;
  /** Count of open cases past their per-state SLA. */
  breach_count: number;
  /** breach_count / open_cases — null when open_cases=0. */
  breach_rate: number | null;
  /** Worst-first list, capped at BREACH_LIST_CAP. */
  breaches: CaseSlaBreach[];
  /** Per-state counts across open cases. open = in that state and
   *  unclosed; breached = open AND past SLA. States not seen are
   *  absent from the map. */
  by_state: Record<string, { open: number; breached: number }>;
}

// ─── Constants ────────────────────────────────────────────────────────

export const BREACH_LIST_CAP = 50;
const HOUR_MS = 60 * 60 * 1000;

// ─── State reconstruction ────────────────────────────────────────────

interface CaseTimelineSnapshot {
  case_id: string;
  current_state: string;
  entered_state_at: string;
  closed: boolean;
}

function reconstructTimeline(
  events: readonly CaseEvent[],
): Map<string, CaseTimelineSnapshot> {
  // Group by case_id, preserving insertion order.
  const byCase = new Map<string, CaseEvent[]>();
  for (const e of events) {
    let arr = byCase.get(e.case_id);
    if (!arr) {
      arr = [];
      byCase.set(e.case_id, arr);
    }
    arr.push(e);
  }
  const out = new Map<string, CaseTimelineSnapshot>();
  for (const [case_id, arr] of byCase) {
    // Sort by sequence_no — events are usually already in order but
    // be defensive against a caller that passes a re-ordered window.
    const sorted = [...arr].sort((a, b) => a.sequence_no - b.sequence_no);
    let snap: CaseTimelineSnapshot | null = null;
    for (const e of sorted) {
      if (e.action === 'opened') {
        const initial =
          typeof e.payload.initial_state === 'string' && e.payload.initial_state.trim()
            ? (e.payload.initial_state as string).trim()
            : 'triage';
        snap = {
          case_id,
          current_state: initial,
          entered_state_at: e.recorded_at,
          closed: false,
        };
      } else if (e.action === 'state_change' && snap) {
        const to = e.payload.to;
        if (typeof to === 'string' && to.trim()) {
          snap.current_state = to.trim();
          snap.entered_state_at = e.recorded_at;
        }
      } else if (e.action === 'closed' && snap) {
        snap.current_state = 'closed';
        snap.entered_state_at = e.recorded_at;
        snap.closed = true;
      }
    }
    if (snap) out.set(case_id, snap);
  }
  return out;
}

// ─── Pure aggregator ──────────────────────────────────────────────────

/**
 * Detect SLA breaches across the cases referenced by the supplied
 * event window.
 *
 * `now` is the reference clock for "time spent in current state".
 * `sla_by_state` defaults to DEFAULT_SLA_HOURS_BY_STATE; values of
 * null mean "no SLA — never flag a breach for this state".
 */
export function detectCaseSlaBreaches(
  events: readonly CaseEvent[],
  now: Date,
  sla_by_state: Readonly<Record<string, number | null>> = DEFAULT_SLA_HOURS_BY_STATE,
): CaseSlaSummary {
  const timeline = reconstructTimeline(events);
  const nowMs = now.getTime();

  let open_cases = 0;
  let closed_cases = 0;
  const by_state: Record<string, { open: number; breached: number }> = {};
  const breaches: CaseSlaBreach[] = [];

  for (const snap of timeline.values()) {
    if (snap.closed) {
      closed_cases += 1;
      continue;
    }
    open_cases += 1;
    const stateKey = snap.current_state;
    const bucket = by_state[stateKey] ?? { open: 0, breached: 0 };
    bucket.open += 1;
    by_state[stateKey] = bucket;

    const sla = sla_by_state[stateKey];
    if (typeof sla !== 'number' || sla <= 0) continue;

    const enteredMs = new Date(snap.entered_state_at).getTime();
    if (!Number.isFinite(enteredMs)) continue;

    const hoursInState = (nowMs - enteredMs) / HOUR_MS;
    if (hoursInState <= sla) continue;

    bucket.breached += 1;
    breaches.push({
      case_id: snap.case_id,
      current_state: stateKey,
      entered_state_at: snap.entered_state_at,
      hours_in_state: hoursInState,
      sla_hours: sla,
      overdue_hours: hoursInState - sla,
    });
  }

  breaches.sort((a, b) => b.overdue_hours - a.overdue_hours);
  const capped = breaches.slice(0, BREACH_LIST_CAP);
  const breach_rate = open_cases === 0 ? null : breaches.length / open_cases;

  return {
    total_cases_observed: timeline.size,
    open_cases,
    closed_cases,
    breach_count: breaches.length,
    breach_rate,
    breaches: capped,
    by_state,
  };
}
