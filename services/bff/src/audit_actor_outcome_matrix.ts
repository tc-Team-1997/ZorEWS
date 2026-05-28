// services/bff/src/audit_actor_outcome_matrix.ts
//
// T6 M15.20 — Audit actor × outcome cross-tab matrix.
//
// M15.1 ships the audit log. M15.8 ships the per-ACTOR 1D rollup (actor
// → total_events with by_outcome nested inside each row). M15.15 ships
// the severity × outcome matrix. M15.19 ships actor × resource_type.
//
// M15.20 ships the orthogonal actor × outcome 2D cross-tab — the proper
// matrix M15.8 only nested for the outcome axis. Each AuditEvent lives
// in exactly one (actor_username, outcome) cell. Actor axis is OPEN
// (any actor seen in events); outcome axis is CLOSED (3 canonical
// AuditOutcomes: success / failure / denied).
//
// Per-cell counts events. Per-row {actor_username, total, by_outcome
// (every outcome at 0 when absent — stable grid), outcomes_without[]
// canonical, distinct_outcomes (0..3), failure_count (= failure +
// denied — the non-success tail)}. Per-col {outcome, total, by_actor
// (compact — only actors with > 0 appear), actors_without[] sorted asc,
// distinct_actors}. Envelope: peak_cell + empty_cells + the
// outcome-specific leaderboards that make this lens worth shipping:
// most_failing_actor (highest failure_count — the segregation-of-duties
// / suspicious-activity signal), actors_with_denials[] (actors with ≥1
// denied event — who's hitting authorization walls), most_common_outcome
// (column with the highest total), and most_versatile_actor (most
// distinct outcomes — an actor whose work spans success AND failure AND
// denied).
//
// Mirror of M15.19 / M15.15 / M1.14 matrix pattern combining an OPEN
// axis (actors — N can grow) with a CLOSED axis (3 AuditOutcomes).
//
// Drives BIL access-review + security governance: "which actor racks up
// the most failed/denied actions — is that a misconfigured integration,
// a struggling operator, or a probe? who is repeatedly denied?".

import type { AuditEvent, AuditOutcome } from './audit_trail';

// Canonical outcome order (kept local — mirrors how M15.15 declares its
// own ALL_AUDIT_OUTCOMES const rather than exporting a shared one).
export const ALL_AUDIT_OUTCOMES: readonly AuditOutcome[] = [
  'success',
  'failure',
  'denied',
];

// ─── Public types ──────────────────────────────────────────────────────

export interface AuditActorOutcomeRow {
  actor_username: string;
  total: number;
  by_outcome: Record<AuditOutcome, number>;
  /** Outcomes with by_outcome=0 (canonical order). */
  outcomes_without: AuditOutcome[];
  /** Distinct outcomes touched by this actor (0..3). */
  distinct_outcomes: number;
  /** failure + denied — the non-success tail for this actor. */
  failure_count: number;
}

export interface AuditOutcomeColumn {
  outcome: AuditOutcome;
  total: number;
  /** Per-actor counts; compact — only actors with > 0 appear. */
  by_actor: Record<string, number>;
  /** Actors with by_actor=0 (sorted asc; subset of all observed actors). */
  actors_without: string[];
  /** Distinct actors with this outcome. */
  distinct_actors: number;
}

export interface AuditActorOutcomeMatrix {
  tenant_id: string;
  generated_at: string;
  total_events: number;
  total_events_observed: number;
  /** Distinct actors observed (sorted asc). */
  actors: string[];
  total_actors: number;
  total_outcomes: number; // = 3
  rows: AuditActorOutcomeRow[];
  columns: AuditOutcomeColumn[];
  /** Highest-count cell; canonical iteration tie-break — actors in
   *  asc order × outcomes in ALL_AUDIT_OUTCOMES order; null on empty. */
  peak_cell: {
    actor_username: string;
    outcome: AuditOutcome;
    count: number;
  } | null;
  /** Actor with the highest failure_count (failure + denied) — the
   *  security / segregation-of-duties signal; canonical actor asc
   *  tie-break; null when no failures/denials anywhere. */
  most_failing_actor: string | null;
  /** Actors with ≥ 1 denied event (sorted asc) — who's hitting
   *  authorization walls. */
  actors_with_denials: string[];
  /** Outcome column with the highest total; canonical tie-break
   *  (success > failure > denied); null on empty. */
  most_common_outcome: AuditOutcome | null;
  /** Actor with most distinct non-zero by_outcome entries; canonical
   *  actor asc tie-break; null on empty. */
  most_versatile_actor: string | null;
  /** (actor, outcome) cells with count=0 — canonical row-major order
   *  (actor asc × outcome canonical). */
  empty_cells: Array<{ actor_username: string; outcome: AuditOutcome }>;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByOutcome(): Record<AuditOutcome, number> {
  const out = {} as Record<AuditOutcome, number>;
  for (const o of ALL_AUDIT_OUTCOMES) out[o] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildAuditActorOutcomeMatrix(
  tenant_id: string,
  events: readonly AuditEvent[],
  now: Date,
): AuditActorOutcomeMatrix {
  // cellCounts[actor][outcome] = count
  const cellCounts = new Map<string, Map<AuditOutcome, number>>();
  const actorsSet = new Set<string>();
  let total_events = 0;

  for (const e of events) {
    if (typeof e.actor_username !== 'string' || e.actor_username.length === 0) continue;
    if (!ALL_AUDIT_OUTCOMES.includes(e.outcome)) continue;
    total_events++;
    actorsSet.add(e.actor_username);

    let row = cellCounts.get(e.actor_username);
    if (!row) {
      row = new Map();
      cellCounts.set(e.actor_username, row);
    }
    row.set(e.outcome, (row.get(e.outcome) ?? 0) + 1);
  }

  const actors = [...actorsSet].sort((a, b) => a.localeCompare(b));

  // Build rows in canonical actor asc order.
  const rows: AuditActorOutcomeRow[] = actors.map((actor_username) => {
    const cells = cellCounts.get(actor_username)!;
    const by_outcome = emptyByOutcome();
    for (const [oc, c] of cells.entries()) by_outcome[oc] = c;
    let total = 0;
    for (const o of ALL_AUDIT_OUTCOMES) total += by_outcome[o];
    const outcomes_without = ALL_AUDIT_OUTCOMES.filter((o) => by_outcome[o] === 0);
    return {
      actor_username,
      total,
      by_outcome,
      outcomes_without,
      distinct_outcomes: ALL_AUDIT_OUTCOMES.length - outcomes_without.length,
      failure_count: by_outcome.failure + by_outcome.denied,
    };
  });

  // Build columns in canonical outcome order.
  const columns: AuditOutcomeColumn[] = ALL_AUDIT_OUTCOMES.map((outcome) => {
    const by_actor: Record<string, number> = {};
    let total = 0;
    for (const actor of actors) {
      const c = cellCounts.get(actor)?.get(outcome) ?? 0;
      if (c > 0) {
        by_actor[actor] = c;
        total += c;
      }
    }
    const actors_without = actors.filter(
      (a) => (cellCounts.get(a)?.get(outcome) ?? 0) === 0,
    );
    return {
      outcome,
      total,
      by_actor,
      actors_without,
      distinct_actors: Object.keys(by_actor).length,
    };
  });

  // peak_cell — highest count; canonical iteration (actors asc × outcomes canonical).
  let peak_cell:
    | { actor_username: string; outcome: AuditOutcome; count: number }
    | null = null;
  let peakCount = 0;
  for (const actor of actors) {
    for (const oc of ALL_AUDIT_OUTCOMES) {
      const c = cellCounts.get(actor)?.get(oc) ?? 0;
      if (c > peakCount) {
        peakCount = c;
        peak_cell = { actor_username: actor, outcome: oc, count: c };
      }
    }
  }

  // most_failing_actor — highest failure_count; canonical actor asc tie-break.
  let most_failing_actor: string | null = null;
  if (rows.length > 0) {
    const sortedFailing = [...rows].sort((a, b) => {
      if (b.failure_count !== a.failure_count) return b.failure_count - a.failure_count;
      return a.actor_username.localeCompare(b.actor_username);
    });
    if (sortedFailing[0].failure_count > 0) {
      most_failing_actor = sortedFailing[0].actor_username;
    }
  }

  // actors_with_denials — actors with ≥ 1 denied event (sorted asc).
  const actors_with_denials = rows
    .filter((r) => r.by_outcome.denied > 0)
    .map((r) => r.actor_username);

  // most_common_outcome — highest column total; canonical tie-break.
  let most_common_outcome: AuditOutcome | null = null;
  let bestCommon = 0;
  for (const col of columns) {
    if (col.total > bestCommon) {
      bestCommon = col.total;
      most_common_outcome = col.outcome;
    }
  }

  // most_versatile_actor — highest distinct_outcomes; canonical actor asc tie-break.
  let most_versatile_actor: string | null = null;
  if (rows.length > 0) {
    const sortedVersatile = [...rows].sort((a, b) => {
      if (b.distinct_outcomes !== a.distinct_outcomes) {
        return b.distinct_outcomes - a.distinct_outcomes;
      }
      return a.actor_username.localeCompare(b.actor_username);
    });
    if (sortedVersatile[0].distinct_outcomes > 0) {
      most_versatile_actor = sortedVersatile[0].actor_username;
    }
  }

  // empty_cells — canonical actor × outcome row-major order.
  const empty_cells: Array<{ actor_username: string; outcome: AuditOutcome }> = [];
  for (const actor of actors) {
    for (const oc of ALL_AUDIT_OUTCOMES) {
      const c = cellCounts.get(actor)?.get(oc) ?? 0;
      if (c === 0) empty_cells.push({ actor_username: actor, outcome: oc });
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_events,
    total_events_observed: events.length,
    actors,
    total_actors: actors.length,
    total_outcomes: ALL_AUDIT_OUTCOMES.length,
    rows,
    columns,
    peak_cell,
    most_failing_actor,
    actors_with_denials,
    most_common_outcome,
    most_versatile_actor,
    empty_cells,
  };
}
