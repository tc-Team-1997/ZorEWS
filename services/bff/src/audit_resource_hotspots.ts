// services/bff/src/audit_resource_hotspots.ts
//
// T6 M15.18 — Audit event per-resource hot-spot rollup.
//
// Pivots over the M15.1 audit chain by `(resource_type, resource_id)`.
// For each unique resource touched, counts events + actors + actions
// + first/last activity. Surfaces the hottest resources — the audit-
// drill-through entry point investigators land on first.
//
// Distinct from:
//   - M15.6  action-verb catalog (groups by action)
//   - M15.8  per-actor activity (groups by actor)
//   - M15.12 resource_type 1D distribution (groups by RT only)
//   - M15.14 resource_type × severity matrix
//   - M15.17 action × resource_type matrix
//
// This pivot is by the full (RT, RID) tuple — the actual entity ID
// matters, not just its type. Drives:
//   - "which case has the most audit events? — likely the noisy one
//     to investigate"
//   - "which user has been touched the most? — surface for privacy
//     review"
//   - "which config key sees the most edits? — heavy-config-churn
//     signal"
//
// Pure resolver — accepts AuditEvent[] directly. Route handler drains
// the audit-trail store with a high page_size.

import type {
  AuditEvent,
  AuditResourceType,
} from './audit_trail';

// ─── Constants ───────────────────────────────────────────────────────

/** Cap on the top_hotspots[] envelope list — SPA gets the top-N per
 *  the operator-tunable param. */
export const DEFAULT_HOTSPOT_LIMIT = 20;
export const MIN_HOTSPOT_LIMIT = 1;
export const MAX_HOTSPOT_LIMIT = 200;

// ─── Errors ──────────────────────────────────────────────────────────

export class AuditResourceHotspotsError extends Error {
  override name = 'AuditResourceHotspotsError';
  constructor(public code: 'invalid_input', message: string) {
    super(message);
  }
}

// ─── Output shapes ────────────────────────────────────────────────────

export interface ResourceHotspotRow {
  resource_type: AuditResourceType;
  resource_id: string;
  total_events: number;
  distinct_actors: number;
  /** Up to 50 actors sorted asc. */
  actors: string[];
  distinct_actions: number;
  /** Up to 50 actions sorted asc. */
  actions: string[];
  /** ISO of oldest event touching this resource. */
  first_event_at: string;
  /** ISO of newest event touching this resource. */
  last_event_at: string;
}

export interface AuditResourceHotspotsReport {
  tenant_id: string;
  generated_at: string;
  total_events: number;
  /** Distinct (resource_type, resource_id) pairs seen. */
  total_resources: number;
  /** Limit echo. */
  limit: number;
  /** Top-N hotspots sorted by total_events desc; tie-break by
   *  resource_type asc + resource_id asc. */
  top_hotspots: ResourceHotspotRow[];
  /** Hottest single resource = top of `top_hotspots`. Null on empty. */
  hottest_resource: { resource_type: AuditResourceType; resource_id: string; total_events: number } | null;
  /** Per-resource-type marginal totals — every AuditResourceType key
   *  present at 0 when absent, for stable SPA grid. */
  by_resource_type: Record<AuditResourceType, number>;
}

const ALERT_ACTORS_CAP = 50;
const ALERT_ACTIONS_CAP = 50;

// ─── Builder ──────────────────────────────────────────────────────────

const ALL_AUDIT_RESOURCE_TYPES: readonly AuditResourceType[] = [
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
];

interface ResourceAccum {
  total: number;
  actors: Set<string>;
  actions: Set<string>;
  first_ts: string;
  last_ts: string;
}

export function summarizeAuditResourceHotspots(
  tenant_id: string,
  events: readonly AuditEvent[],
  now: Date,
  limit: number = DEFAULT_HOTSPOT_LIMIT,
): AuditResourceHotspotsReport {
  if (
    !Number.isInteger(limit) ||
    limit < MIN_HOTSPOT_LIMIT ||
    limit > MAX_HOTSPOT_LIMIT
  ) {
    throw new AuditResourceHotspotsError(
      'invalid_input',
      `limit must be an integer in [${MIN_HOTSPOT_LIMIT}, ${MAX_HOTSPOT_LIMIT}]`,
    );
  }

  const byResource = new Map<string, ResourceAccum & { resource_type: AuditResourceType; resource_id: string }>();
  const byResourceType = {} as Record<AuditResourceType, number>;
  for (const rt of ALL_AUDIT_RESOURCE_TYPES) {
    byResourceType[rt] = 0;
  }

  let total_events = 0;
  for (const ev of events) {
    if (typeof ev.resource_id !== 'string' || ev.resource_id.length === 0) continue;
    if (!ALL_AUDIT_RESOURCE_TYPES.includes(ev.resource_type)) continue;
    total_events += 1;
    byResourceType[ev.resource_type] = (byResourceType[ev.resource_type] ?? 0) + 1;
    const key = `${ev.resource_type}::${ev.resource_id}`;
    let row = byResource.get(key);
    if (!row) {
      row = {
        resource_type: ev.resource_type,
        resource_id: ev.resource_id,
        total: 0,
        actors: new Set<string>(),
        actions: new Set<string>(),
        first_ts: ev.ts,
        last_ts: ev.ts,
      };
      byResource.set(key, row);
    }
    row.total += 1;
    if (typeof ev.actor_username === 'string' && ev.actor_username.length > 0) {
      row.actors.add(ev.actor_username);
    }
    if (typeof ev.action === 'string' && ev.action.length > 0) {
      row.actions.add(ev.action);
    }
    if (ev.ts < row.first_ts) row.first_ts = ev.ts;
    if (ev.ts > row.last_ts) row.last_ts = ev.ts;
  }

  const rows: ResourceHotspotRow[] = [];
  for (const r of byResource.values()) {
    rows.push({
      resource_type: r.resource_type,
      resource_id: r.resource_id,
      total_events: r.total,
      distinct_actors: r.actors.size,
      actors: [...r.actors].sort().slice(0, ALERT_ACTORS_CAP),
      distinct_actions: r.actions.size,
      actions: [...r.actions].sort().slice(0, ALERT_ACTIONS_CAP),
      first_event_at: r.first_ts,
      last_event_at: r.last_ts,
    });
  }

  // Sort total_events desc; tie-break resource_type asc + resource_id
  // asc for stable rendering.
  rows.sort((a, b) => {
    if (b.total_events !== a.total_events) return b.total_events - a.total_events;
    if (a.resource_type !== b.resource_type) {
      return a.resource_type < b.resource_type ? -1 : 1;
    }
    return a.resource_id < b.resource_id
      ? -1
      : a.resource_id > b.resource_id
        ? 1
        : 0;
  });

  const top_hotspots = rows.slice(0, limit);
  const hottest_resource =
    rows.length > 0
      ? {
          resource_type: rows[0].resource_type,
          resource_id: rows[0].resource_id,
          total_events: rows[0].total_events,
        }
      : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_events,
    total_resources: rows.length,
    limit,
    top_hotspots,
    hottest_resource,
    by_resource_type: byResourceType,
  };
}
