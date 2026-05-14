// services/bff/src/audit_action_catalog.ts
//
// T6 M15.6 — Audit action catalog introspection.
//
// M15.1 ships the audit trail; M15.2 chain integrity; M15.3 evidence
// packaging; M15.4 printable summary; M15.5 sample chain verifier.
// M15.6 adds a discoverable catalog: walk the tenant's audit chain
// and emit, per distinct action, the metadata keys it carries +
// the resource_types it shows up against + recency. Lets the SPA
// build a filter dropdown that's data-driven (every action this
// tenant has ever emitted) instead of hardcoding the action list.
//
// Design:
//  - Pure function over a `readonly AuditEvent[]`. No I/O.
//  - Groups events by `action` string. For each group emits the
//    union of `metadata` keys observed across all events (so the
//    SPA knows which filter chips to render), the distinct
//    `resource_type` set seen, the event count, the newest event
//    timestamp + actor (recency anchor).
//  - Actions sorted by observed_count desc, ties broken by action
//    string asc — most-used actions float to the top of the
//    dropdown.

import type { AuditEvent } from './audit_trail';

// ─── Public types ─────────────────────────────────────────────────────

export interface AuditActionCatalogEntry {
  action: string;
  /** Total events with this action across the input window. */
  observed_count: number;
  /** Distinct resource_types this action has been emitted against,
   *  sorted asc. Surfaces e.g. `delete` showing up against both
   *  `case` and `scenario`. */
  distinct_resource_types: string[];
  /** Union of metadata keys observed across all events with this
   *  action, sorted asc. Empty when no event carried metadata. */
  metadata_keys: string[];
  /** ISO timestamp of the newest event with this action. */
  latest_event_at: string;
  /** Actor on the newest event. */
  last_actor: string;
}

export interface AuditActionCatalog {
  total_events: number;
  /** Distinct action strings observed. */
  distinct_actions: number;
  /** Sorted by observed_count desc, ties broken by action asc. */
  actions: AuditActionCatalogEntry[];
}

// ─── Pure aggregator ──────────────────────────────────────────────────

interface ActionAcc {
  action: string;
  count: number;
  resource_types: Set<string>;
  metadata_keys: Set<string>;
  latest_event_at: string;
  last_actor: string;
}

/**
 * Pure introspector — walks the event window and emits a per-action
 * catalog. Caller passes the full chain (typically via
 * `auditTrailStore.list(tenant, {page_size: max}).items`).
 */
export function introspectAuditCatalog(
  events: readonly AuditEvent[],
): AuditActionCatalog {
  const byAction = new Map<string, ActionAcc>();
  for (const e of events) {
    let acc = byAction.get(e.action);
    if (!acc) {
      acc = {
        action: e.action,
        count: 0,
        resource_types: new Set<string>(),
        metadata_keys: new Set<string>(),
        latest_event_at: e.ts,
        last_actor: e.actor_username,
      };
      byAction.set(e.action, acc);
    }
    acc.count += 1;
    if (e.resource_type) acc.resource_types.add(e.resource_type);
    if (e.metadata && typeof e.metadata === 'object') {
      for (const key of Object.keys(e.metadata)) acc.metadata_keys.add(key);
    }
    if (e.ts > acc.latest_event_at) {
      acc.latest_event_at = e.ts;
      acc.last_actor = e.actor_username;
    }
  }

  const actions: AuditActionCatalogEntry[] = [];
  for (const acc of byAction.values()) {
    actions.push({
      action: acc.action,
      observed_count: acc.count,
      distinct_resource_types: [...acc.resource_types].sort(),
      metadata_keys: [...acc.metadata_keys].sort(),
      latest_event_at: acc.latest_event_at,
      last_actor: acc.last_actor,
    });
  }
  actions.sort((a, b) => {
    if (b.observed_count !== a.observed_count) return b.observed_count - a.observed_count;
    return a.action < b.action ? -1 : a.action > b.action ? 1 : 0;
  });

  return {
    total_events: events.length,
    distinct_actions: byAction.size,
    actions,
  };
}
