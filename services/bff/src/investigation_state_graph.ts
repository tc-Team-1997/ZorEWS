// services/bff/src/investigation_state_graph.ts
//
// T6 M9.7 — Case investigation state-machine introspection.
//
// M9.1 ships the 6-state InvestigationStatus enum + private
// TRANSITIONS map. M9.5 ships the SLA tier per state. M9.7 exposes
// both as a single readable graph so the SPA can build a data-
// driven "Move case to..." dropdown + "Status legend" tooltip
// instead of hardcoding the state graph in two places.
//
// Pure — derives entirely from the constants exported by
// case_investigation.ts and case_sla_breach.ts. No I/O.

import {
  INVESTIGATION_STATUSES,
  TRANSITIONS,
  type InvestigationStatus,
} from './case_investigation';
import { DEFAULT_SLA_HOURS_BY_STATE } from './case_sla_breach';

// ─── Public types ─────────────────────────────────────────────────────

export interface InvestigationStateNode {
  state: InvestigationStatus;
  /** Default SLA in hours for time-in-this-state. `null` for the
   *  terminal state (closed) — no SLA against a closed case. */
  sla_hours_default: number | null;
  /** True only for `closed`. Other states are non-terminal even if
   *  they have outgoing transitions to `closed`. */
  terminal: boolean;
  /** Legal next states from this state per the M9.1 TRANSITIONS map,
   *  sorted asc for stable rendering. */
  allowed_next_states: InvestigationStatus[];
}

export interface InvestigationStateGraph {
  total_states: number;
  states: InvestigationStateNode[];
}

// ─── Pure introspector ────────────────────────────────────────────────

/**
 * Builds the full investigation state-machine catalog. Walks the
 * M9.1 INVESTIGATION_STATUSES list (preserves the declared order,
 * which matches the workflow flow triage → … → closed), and for
 * each state emits SLA + terminal flag + sorted allowed transitions.
 */
export function listInvestigationStateGraph(): InvestigationStateGraph {
  const nodes: InvestigationStateNode[] = INVESTIGATION_STATUSES.map((state) => {
    const allowed = [...(TRANSITIONS[state] ?? [])].sort();
    return {
      state,
      sla_hours_default: DEFAULT_SLA_HOURS_BY_STATE[state] ?? null,
      terminal: state === 'closed',
      allowed_next_states: allowed,
    };
  });
  return {
    total_states: nodes.length,
    states: nodes,
  };
}
