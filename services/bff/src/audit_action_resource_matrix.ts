// services/bff/src/audit_action_resource_matrix.ts
//
// T6 M15.17 — Audit action × resource_type cross-tab matrix.
//
// M15.1 ships the audit log. M15.6 ships the 1D action catalog
// (BY-ACTION). M15.12 ships 1D resource_type distribution. M15.13
// ships 1D action-prefix distribution. M15.14 ships resource_type ×
// severity matrix. M15.15 ships severity × outcome matrix.
//
// M15.17 ships the orthogonal action × resource_type 2D cross-tab.
// Each AuditEvent lives in exactly one (action, resource_type) cell.
// Action axis is OPEN (any action verb from observed events);
// resource_type axis is CLOSED (10 canonical AuditResourceTypes).
//
// Per-cell counts events. Per-row {action, total, by_resource_type
// (every type at 0 when absent — stable grid), resource_types_without[]
// canonical}. Per-col {resource_type, total, by_action (compact —
// only actions with > 0 events appear), actions_without[] (sorted asc)}.
// Envelope: peak_cell + empty_cells + most_versatile_action (action
// with most distinct non-zero by_resource_type entries) +
// most_diverse_resource_type (resource_type with most distinct
// non-zero by_action entries).
//
// Mirror of M1.11 / M14.28 / M12.14 / M3.14 / M15.14 / M8.14 matrix
// pattern combining OPEN axis (actions — N can grow) × CLOSED axis
// (10 AuditResourceTypes).
//
// Drives BIL governance "which actions hit which resource types
// most often? are there action verbs that span every resource type
// vs single-purpose ones?" type analysis.

import type { AuditEvent, AuditResourceType } from './audit_trail';
import { ALL_AUDIT_RESOURCE_TYPES } from './audit_resource_severity_matrix';

// ─── Public types ──────────────────────────────────────────────────────

export interface AuditActionRow {
  action: string;
  total: number;
  by_resource_type: Record<AuditResourceType, number>;
  /** Resource_types with by_resource_type=0 (canonical order). */
  resource_types_without: AuditResourceType[];
  /** Distinct resource_types touched by this action (0..10). */
  distinct_resource_types: number;
}

export interface AuditResourceColumn {
  resource_type: AuditResourceType;
  total: number;
  /** Per-action counts; compact — only actions with > 0 appear. */
  by_action: Record<string, number>;
  /** Actions with by_action=0 (sorted asc; subset of all observed actions). */
  actions_without: string[];
  /** Distinct actions touching this resource_type. */
  distinct_actions: number;
}

export interface AuditActionResourceMatrix {
  tenant_id: string;
  generated_at: string;
  total_events: number;
  total_events_observed: number;
  /** Distinct actions observed (sorted asc). */
  actions: string[];
  total_actions: number;
  total_resource_types: number; // = 10
  rows: AuditActionRow[];
  columns: AuditResourceColumn[];
  /** Highest-count cell; canonical iteration tie-break — actions in
   *  asc order × resource_types in ALL_AUDIT_RESOURCE_TYPES order;
   *  null on empty. */
  peak_cell: {
    action: string;
    resource_type: AuditResourceType;
    count: number;
  } | null;
  /** Action with most distinct non-zero by_resource_type entries;
   *  canonical action asc tie-break; null on empty. */
  most_versatile_action: string | null;
  /** Resource_type with most distinct non-zero by_action entries;
   *  canonical ALL_AUDIT_RESOURCE_TYPES order tie-break; null on empty. */
  most_diverse_resource_type: AuditResourceType | null;
  /** (action, resource_type) cells with count=0 — canonical row-major
   *  order (action asc × resource_type canonical). */
  empty_cells: Array<{ action: string; resource_type: AuditResourceType }>;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByResourceType(): Record<AuditResourceType, number> {
  const out = {} as Record<AuditResourceType, number>;
  for (const t of ALL_AUDIT_RESOURCE_TYPES) out[t] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildAuditActionResourceMatrix(
  tenant_id: string,
  events: readonly AuditEvent[],
  now: Date,
): AuditActionResourceMatrix {
  // cellCounts[action][resource_type] = count
  const cellCounts = new Map<string, Map<AuditResourceType, number>>();
  const actionsSet = new Set<string>();
  let total_events = 0;

  for (const e of events) {
    if (typeof e.action !== 'string' || e.action.length === 0) continue;
    if (!ALL_AUDIT_RESOURCE_TYPES.includes(e.resource_type)) continue;
    total_events++;
    actionsSet.add(e.action);

    let row = cellCounts.get(e.action);
    if (!row) {
      row = new Map();
      cellCounts.set(e.action, row);
    }
    row.set(e.resource_type, (row.get(e.resource_type) ?? 0) + 1);
  }

  const actions = [...actionsSet].sort((a, b) => a.localeCompare(b));

  // Build rows in canonical action asc order.
  const rows: AuditActionRow[] = actions.map((action) => {
    const cells = cellCounts.get(action)!;
    const by_resource_type = emptyByResourceType();
    for (const [rt, c] of cells.entries()) by_resource_type[rt] = c;
    let total = 0;
    for (const t of ALL_AUDIT_RESOURCE_TYPES) total += by_resource_type[t];
    const resource_types_without = ALL_AUDIT_RESOURCE_TYPES.filter(
      (t) => by_resource_type[t] === 0,
    );
    return {
      action,
      total,
      by_resource_type,
      resource_types_without,
      distinct_resource_types:
        ALL_AUDIT_RESOURCE_TYPES.length - resource_types_without.length,
    };
  });

  // Build columns in canonical resource_type order.
  const columns: AuditResourceColumn[] = ALL_AUDIT_RESOURCE_TYPES.map(
    (resource_type) => {
      const by_action: Record<string, number> = {};
      let total = 0;
      for (const action of actions) {
        const c = cellCounts.get(action)?.get(resource_type) ?? 0;
        if (c > 0) {
          by_action[action] = c;
          total += c;
        }
      }
      const actions_without = actions.filter(
        (a) => (cellCounts.get(a)?.get(resource_type) ?? 0) === 0,
      );
      return {
        resource_type,
        total,
        by_action,
        actions_without,
        distinct_actions: Object.keys(by_action).length,
      };
    },
  );

  // peak_cell — highest count; canonical iteration (actions asc × types canonical).
  let peak_cell:
    | { action: string; resource_type: AuditResourceType; count: number }
    | null = null;
  let peakCount = 0;
  for (const action of actions) {
    for (const rt of ALL_AUDIT_RESOURCE_TYPES) {
      const c = cellCounts.get(action)?.get(rt) ?? 0;
      if (c > peakCount) {
        peakCount = c;
        peak_cell = { action, resource_type: rt, count: c };
      }
    }
  }

  // most_versatile_action — highest distinct_resource_types; canonical
  // action asc tie-break.
  let most_versatile_action: string | null = null;
  if (rows.length > 0) {
    const sortedVersatile = [...rows].sort((a, b) => {
      if (b.distinct_resource_types !== a.distinct_resource_types) {
        return b.distinct_resource_types - a.distinct_resource_types;
      }
      return a.action.localeCompare(b.action);
    });
    if (sortedVersatile[0].distinct_resource_types > 0) {
      most_versatile_action = sortedVersatile[0].action;
    }
  }

  // most_diverse_resource_type — highest distinct_actions; canonical order tie-break.
  let most_diverse_resource_type: AuditResourceType | null = null;
  let bestDiverse = 0;
  for (const col of columns) {
    if (col.distinct_actions > bestDiverse) {
      bestDiverse = col.distinct_actions;
      most_diverse_resource_type = col.resource_type;
    }
  }

  // empty_cells — canonical action × resource_type row-major order.
  const empty_cells: Array<{ action: string; resource_type: AuditResourceType }> = [];
  for (const action of actions) {
    for (const rt of ALL_AUDIT_RESOURCE_TYPES) {
      const c = cellCounts.get(action)?.get(rt) ?? 0;
      if (c === 0) empty_cells.push({ action, resource_type: rt });
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_events,
    total_events_observed: events.length,
    actions,
    total_actions: actions.length,
    total_resource_types: ALL_AUDIT_RESOURCE_TYPES.length,
    rows,
    columns,
    peak_cell,
    most_versatile_action,
    most_diverse_resource_type,
    empty_cells,
  };
}
