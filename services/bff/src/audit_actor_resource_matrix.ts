// services/bff/src/audit_actor_resource_matrix.ts
//
// T6 M15.19 — Audit actor × resource_type cross-tab matrix.
//
// M15.1 ships the audit log. M15.8 ships the per-ACTOR 1D rollup
// (actor → total_events with by_resource_type nested inside each row).
// M15.17 ships the action × resource_type 2D matrix. M15.18 ships the
// per-(resource_type, resource_id) hot-spot pivot.
//
// M15.19 ships the orthogonal actor × resource_type 2D cross-tab —
// the proper matrix M15.8 only nests. Each AuditEvent lives in exactly
// one (actor_username, resource_type) cell. Actor axis is OPEN (any
// actor seen in events); resource_type axis is CLOSED (10 canonical
// AuditResourceTypes).
//
// Per-cell counts events. Per-row {actor_username, total,
// by_resource_type (every type at 0 when absent — stable grid),
// resource_types_without[] canonical, distinct_resource_types}.
// Per-col {resource_type, total, by_actor (compact — only actors with
// > 0 events appear), actors_without[] (sorted asc), distinct_actors}.
// Envelope: peak_cell + empty_cells + most_versatile_actor (actor
// touching the most distinct resource_types — the access-review
// "broadest footprint" signal) + most_touched_resource_type
// (resource_type touched by the most distinct actors).
//
// Mirror of M15.17 / M1.14 / M13.17 matrix pattern combining OPEN axis
// (actors — N can grow) × CLOSED axis (10 AuditResourceTypes).
//
// Drives BIL access-review governance: "which actor touches the most
// resource types — does that match their assigned scope? which
// resource type is touched by the widest set of actors?".

import type { AuditEvent, AuditResourceType } from './audit_trail';
import { ALL_AUDIT_RESOURCE_TYPES } from './audit_resource_severity_matrix';

// ─── Public types ──────────────────────────────────────────────────────

export interface AuditActorRow {
  actor_username: string;
  total: number;
  by_resource_type: Record<AuditResourceType, number>;
  /** Resource_types with by_resource_type=0 (canonical order). */
  resource_types_without: AuditResourceType[];
  /** Distinct resource_types touched by this actor (0..10). */
  distinct_resource_types: number;
}

export interface AuditActorResourceColumn {
  resource_type: AuditResourceType;
  total: number;
  /** Per-actor counts; compact — only actors with > 0 appear. */
  by_actor: Record<string, number>;
  /** Actors with by_actor=0 (sorted asc; subset of all observed actors). */
  actors_without: string[];
  /** Distinct actors touching this resource_type. */
  distinct_actors: number;
}

export interface AuditActorResourceMatrix {
  tenant_id: string;
  generated_at: string;
  total_events: number;
  total_events_observed: number;
  /** Distinct actors observed (sorted asc). */
  actors: string[];
  total_actors: number;
  total_resource_types: number; // = 10
  rows: AuditActorRow[];
  columns: AuditActorResourceColumn[];
  /** Highest-count cell; canonical iteration tie-break — actors in
   *  asc order × resource_types in ALL_AUDIT_RESOURCE_TYPES order;
   *  null on empty. */
  peak_cell: {
    actor_username: string;
    resource_type: AuditResourceType;
    count: number;
  } | null;
  /** Actor with most distinct non-zero by_resource_type entries —
   *  the "broadest footprint" access-review signal; canonical actor
   *  asc tie-break; null on empty. */
  most_versatile_actor: string | null;
  /** Resource_type with most distinct non-zero by_actor entries;
   *  canonical ALL_AUDIT_RESOURCE_TYPES order tie-break; null on empty. */
  most_touched_resource_type: AuditResourceType | null;
  /** (actor, resource_type) cells with count=0 — canonical row-major
   *  order (actor asc × resource_type canonical). */
  empty_cells: Array<{ actor_username: string; resource_type: AuditResourceType }>;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByResourceType(): Record<AuditResourceType, number> {
  const out = {} as Record<AuditResourceType, number>;
  for (const t of ALL_AUDIT_RESOURCE_TYPES) out[t] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildAuditActorResourceMatrix(
  tenant_id: string,
  events: readonly AuditEvent[],
  now: Date,
): AuditActorResourceMatrix {
  // cellCounts[actor][resource_type] = count
  const cellCounts = new Map<string, Map<AuditResourceType, number>>();
  const actorsSet = new Set<string>();
  let total_events = 0;

  for (const e of events) {
    if (typeof e.actor_username !== 'string' || e.actor_username.length === 0) continue;
    if (!ALL_AUDIT_RESOURCE_TYPES.includes(e.resource_type)) continue;
    total_events++;
    actorsSet.add(e.actor_username);

    let row = cellCounts.get(e.actor_username);
    if (!row) {
      row = new Map();
      cellCounts.set(e.actor_username, row);
    }
    row.set(e.resource_type, (row.get(e.resource_type) ?? 0) + 1);
  }

  const actors = [...actorsSet].sort((a, b) => a.localeCompare(b));

  // Build rows in canonical actor asc order.
  const rows: AuditActorRow[] = actors.map((actor_username) => {
    const cells = cellCounts.get(actor_username)!;
    const by_resource_type = emptyByResourceType();
    for (const [rt, c] of cells.entries()) by_resource_type[rt] = c;
    let total = 0;
    for (const t of ALL_AUDIT_RESOURCE_TYPES) total += by_resource_type[t];
    const resource_types_without = ALL_AUDIT_RESOURCE_TYPES.filter(
      (t) => by_resource_type[t] === 0,
    );
    return {
      actor_username,
      total,
      by_resource_type,
      resource_types_without,
      distinct_resource_types:
        ALL_AUDIT_RESOURCE_TYPES.length - resource_types_without.length,
    };
  });

  // Build columns in canonical resource_type order.
  const columns: AuditActorResourceColumn[] = ALL_AUDIT_RESOURCE_TYPES.map(
    (resource_type) => {
      const by_actor: Record<string, number> = {};
      let total = 0;
      for (const actor of actors) {
        const c = cellCounts.get(actor)?.get(resource_type) ?? 0;
        if (c > 0) {
          by_actor[actor] = c;
          total += c;
        }
      }
      const actors_without = actors.filter(
        (a) => (cellCounts.get(a)?.get(resource_type) ?? 0) === 0,
      );
      return {
        resource_type,
        total,
        by_actor,
        actors_without,
        distinct_actors: Object.keys(by_actor).length,
      };
    },
  );

  // peak_cell — highest count; canonical iteration (actors asc × types canonical).
  let peak_cell:
    | { actor_username: string; resource_type: AuditResourceType; count: number }
    | null = null;
  let peakCount = 0;
  for (const actor of actors) {
    for (const rt of ALL_AUDIT_RESOURCE_TYPES) {
      const c = cellCounts.get(actor)?.get(rt) ?? 0;
      if (c > peakCount) {
        peakCount = c;
        peak_cell = { actor_username: actor, resource_type: rt, count: c };
      }
    }
  }

  // most_versatile_actor — highest distinct_resource_types; canonical
  // actor asc tie-break.
  let most_versatile_actor: string | null = null;
  if (rows.length > 0) {
    const sortedVersatile = [...rows].sort((a, b) => {
      if (b.distinct_resource_types !== a.distinct_resource_types) {
        return b.distinct_resource_types - a.distinct_resource_types;
      }
      return a.actor_username.localeCompare(b.actor_username);
    });
    if (sortedVersatile[0].distinct_resource_types > 0) {
      most_versatile_actor = sortedVersatile[0].actor_username;
    }
  }

  // most_touched_resource_type — highest distinct_actors; canonical order tie-break.
  let most_touched_resource_type: AuditResourceType | null = null;
  let bestDiverse = 0;
  for (const col of columns) {
    if (col.distinct_actors > bestDiverse) {
      bestDiverse = col.distinct_actors;
      most_touched_resource_type = col.resource_type;
    }
  }

  // empty_cells — canonical actor × resource_type row-major order.
  const empty_cells: Array<{ actor_username: string; resource_type: AuditResourceType }> = [];
  for (const actor of actors) {
    for (const rt of ALL_AUDIT_RESOURCE_TYPES) {
      const c = cellCounts.get(actor)?.get(rt) ?? 0;
      if (c === 0) empty_cells.push({ actor_username: actor, resource_type: rt });
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_events,
    total_events_observed: events.length,
    actors,
    total_actors: actors.length,
    total_resource_types: ALL_AUDIT_RESOURCE_TYPES.length,
    rows,
    columns,
    peak_cell,
    most_versatile_actor,
    most_touched_resource_type,
    empty_cells,
  };
}
