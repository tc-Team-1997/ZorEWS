// services/bff/src/case_state_transition_matrix.ts
//
// T6 M9.17 — Case state transition cross-tab matrix.
//
// M9.4 ships the case event journal; M9.6 ships the per-case timeline
// reconstruction; M9.15 ships the action distribution pivot.
//
// M9.17 ships the FLEET state-transition matrix: across every
// `state_change` event in the journal, pivot transitions into a 2D
// matrix of from-state × to-state. Per-cell: count + distinct_cases
// (Set-dedup; same case re-traversing the same transition counts
// once for distinct, multiple for count).
//
// State labels are AUTO-DISCOVERED from observed payload.from + payload.to
// values rather than hardcoded to a specific state machine — works
// across CmsCaseState (OPEN/ASSIGNED/INVESTIGATING/PENDING_APPROVAL/
// ESCALATED/CLOSED/REOPENED) and InvestigationStatus (triage/
// gathering_evidence/awaiting_response/review/decision/closed) without
// branching.
//
// Envelope: peak_cell (highest count + canonical iteration tie-break;
// null on empty), most_common_destination (state with highest inbound
// transitions; canonical tie-break; null on empty), most_common_source
// (state with highest outbound; canonical tie-break; null on empty),
// dead_ends[] (states observed AS destinations but never AS sources —
// terminal-only), origins[] (states observed AS sources but never AS
// destinations — entry-only).
//
// Distinct from M9.6 (per-case chronological ladder) by being the
// FLEET-WIDE cross-tab — answers "which transitions are most common?
// is there a closed → reopened flow happening too often?" governance
// questions.

import type { CaseEvent } from './case_events';

// ─── Public types ──────────────────────────────────────────────────────

export interface CaseTransitionRow {
  from_state: string;
  total_outbound: number;
  /** Per-destination counts. Compact — only states with > 0 transitions
   *  from this source appear as keys. */
  by_to: Record<string, number>;
  /** Distinct (case_id, to_state) pairs originating from this source. */
  distinct_cases: number;
}

export interface CaseTransitionColumn {
  to_state: string;
  total_inbound: number;
  /** Per-source counts. Compact. */
  by_from: Record<string, number>;
  /** Distinct case_ids landing in this destination. */
  distinct_cases: number;
}

export interface CaseTransitionMatrix {
  tenant_id: string;
  generated_at: string;
  total_transitions: number;
  total_state_change_events: number;
  /** Total events scanned (incl. non-state_change). */
  total_events_observed: number;
  /** Distinct states (union of from + to). Sorted asc. */
  states: string[];
  /** Per-source rows; sorted by total_outbound desc + from_state asc. */
  rows: CaseTransitionRow[];
  /** Per-destination columns; sorted by total_inbound desc + to_state asc. */
  columns: CaseTransitionColumn[];
  /** Highest-count cell across the matrix; canonical iteration tie-break
   *  (from asc × to asc); null on empty. */
  peak_cell: {
    from_state: string;
    to_state: string;
    count: number;
  } | null;
  /** State with highest total_inbound; tie-broken by state name asc;
   *  null on empty. */
  most_common_destination: string | null;
  /** State with highest total_outbound; tie-broken by state name asc;
   *  null on empty. */
  most_common_source: string | null;
  /** States observed as destinations but never as sources — terminal. */
  dead_ends: string[];
  /** States observed as sources but never as destinations — entry-only. */
  origins: string[];
  /** Self-transitions count (from_state === to_state — should be rare /
   *  always zero with proper state machines but surfaced as a sanity
   *  check). */
  self_transition_count: number;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildCaseTransitionMatrix(
  tenant_id: string,
  events: readonly CaseEvent[],
  now: Date,
): CaseTransitionMatrix {
  // Cell counts indexed (from → to → {count, cases Set}).
  const cellCounts = new Map<
    string,
    Map<string, { count: number; cases: Set<string> }>
  >();
  const fromStates = new Set<string>();
  const toStates = new Set<string>();
  let total_transitions = 0;
  let total_state_change_events = 0;
  let self_transition_count = 0;
  const distinctInbound = new Map<string, Set<string>>();
  const distinctOutbound = new Map<string, Set<string>>();

  for (const e of events) {
    if (e.action !== 'state_change') continue;
    total_state_change_events++;
    const from = typeof e.payload.from === 'string' ? e.payload.from.trim() : '';
    const to = typeof e.payload.to === 'string' ? e.payload.to.trim() : '';
    if (!from || !to) continue;

    total_transitions++;
    fromStates.add(from);
    toStates.add(to);

    if (from === to) self_transition_count++;

    let rowMap = cellCounts.get(from);
    if (!rowMap) {
      rowMap = new Map();
      cellCounts.set(from, rowMap);
    }
    let cell = rowMap.get(to);
    if (!cell) {
      cell = { count: 0, cases: new Set<string>() };
      rowMap.set(to, cell);
    }
    cell.count++;
    cell.cases.add(e.case_id);

    let outSet = distinctOutbound.get(from);
    if (!outSet) {
      outSet = new Set();
      distinctOutbound.set(from, outSet);
    }
    outSet.add(`${e.case_id}|${to}`);

    let inSet = distinctInbound.get(to);
    if (!inSet) {
      inSet = new Set();
      distinctInbound.set(to, inSet);
    }
    inSet.add(e.case_id);
  }

  // Union of from + to states for the canonical iteration order
  // (sorted asc).
  const allStatesSet = new Set<string>([...fromStates, ...toStates]);
  const states = [...allStatesSet].sort((a, b) => a.localeCompare(b));

  // Build rows — one per state observed as a source.
  const rows: CaseTransitionRow[] = [];
  for (const from of states) {
    if (!fromStates.has(from)) continue;
    const rowMap = cellCounts.get(from)!;
    const by_to: Record<string, number> = {};
    let total_outbound = 0;
    for (const [to, cell] of rowMap.entries()) {
      by_to[to] = cell.count;
      total_outbound += cell.count;
    }
    rows.push({
      from_state: from,
      total_outbound,
      by_to,
      distinct_cases: distinctOutbound.get(from)!.size,
    });
  }
  rows.sort((a, b) => {
    if (b.total_outbound !== a.total_outbound) {
      return b.total_outbound - a.total_outbound;
    }
    return a.from_state.localeCompare(b.from_state);
  });

  // Build columns — one per state observed as a destination.
  const columns: CaseTransitionColumn[] = [];
  for (const to of states) {
    if (!toStates.has(to)) continue;
    const by_from: Record<string, number> = {};
    let total_inbound = 0;
    for (const [from, rowMap] of cellCounts.entries()) {
      const cell = rowMap.get(to);
      if (cell) {
        by_from[from] = cell.count;
        total_inbound += cell.count;
      }
    }
    columns.push({
      to_state: to,
      total_inbound,
      by_from,
      distinct_cases: distinctInbound.get(to)?.size ?? 0,
    });
  }
  columns.sort((a, b) => {
    if (b.total_inbound !== a.total_inbound) {
      return b.total_inbound - a.total_inbound;
    }
    return a.to_state.localeCompare(b.to_state);
  });

  // peak_cell — highest count; iterate states in canonical asc order
  // for tie-break.
  let peak_cell: {
    from_state: string;
    to_state: string;
    count: number;
  } | null = null;
  let peakCount = 0;
  for (const from of states) {
    const rowMap = cellCounts.get(from);
    if (!rowMap) continue;
    for (const to of states) {
      const cell = rowMap.get(to);
      if (cell && cell.count > peakCount) {
        peakCount = cell.count;
        peak_cell = { from_state: from, to_state: to, count: cell.count };
      }
    }
  }

  // most_common_destination — highest total_inbound; tie-broken by state asc.
  let most_common_destination: string | null = null;
  let bestInbound = 0;
  const sortedDest = [...columns].sort((a, b) => {
    if (b.total_inbound !== a.total_inbound) {
      return b.total_inbound - a.total_inbound;
    }
    return a.to_state.localeCompare(b.to_state);
  });
  if (sortedDest.length > 0) {
    most_common_destination = sortedDest[0].to_state;
    bestInbound = sortedDest[0].total_inbound;
  }
  void bestInbound;

  // most_common_source — highest total_outbound; tie-broken by state asc.
  let most_common_source: string | null = null;
  if (rows.length > 0) {
    most_common_source = rows[0].from_state;
  }

  // dead_ends — observed AS destination but never AS source.
  const dead_ends = [...toStates]
    .filter((s) => !fromStates.has(s))
    .sort((a, b) => a.localeCompare(b));

  // origins — observed AS source but never AS destination.
  const origins = [...fromStates]
    .filter((s) => !toStates.has(s))
    .sort((a, b) => a.localeCompare(b));

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_transitions,
    total_state_change_events,
    total_events_observed: events.length,
    states,
    rows,
    columns,
    peak_cell,
    most_common_destination,
    most_common_source,
    dead_ends,
    origins,
    self_transition_count,
  };
}
