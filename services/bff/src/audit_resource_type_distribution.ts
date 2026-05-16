// services/bff/src/audit_resource_type_distribution.ts
//
// T6 M15.12 — Audit event resource_type distribution.
//
// M15.9 ships severity distribution with by_resource_type INSIDE
// each severity row. M15.12 is the orthogonal pivot — resource_type
// as the primary axis with by_severity + by_outcome rolled up
// INSIDE each resource_type row.
//
// Use case: BIL ops opens the audit page and wants the answer to
// "how many events touched each resource type? which type sees the
// most critical events?" with one round-trip instead of N filtered
// queries.
//
// Mirror of M15.9 inverted + M5.16 / M11.11 pivot pattern.
// Pure rollup over an AuditEvent[]. Tenant-scoped at the caller.

import type {
  AuditEvent,
  AuditOutcome,
  AuditResourceType,
  AuditSeverity,
} from './audit_trail';

// ─── Constants ────────────────────────────────────────────────────────

const ALL_RESOURCE_TYPES: readonly AuditResourceType[] = [
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
] as const;

const ALL_SEVERITIES: readonly AuditSeverity[] = ['critical', 'warning', 'info'] as const;
const ALL_OUTCOMES: readonly AuditOutcome[] = ['success', 'failure', 'denied'] as const;

const TOP_ACTION_CAP = 5;

// ─── Public types ─────────────────────────────────────────────────────

export interface ResourceTypeRow {
  resource_type: AuditResourceType;
  total_count: number;
  /** Per-AuditSeverity; every key present at 0 when absent. */
  by_severity: Record<AuditSeverity, number>;
  /** Per-AuditOutcome; every key present at 0 when absent. */
  by_outcome: Record<AuditOutcome, number>;
  /** Top-5 actions touching this resource_type. Sorted count desc
   *  + action asc tie-break. */
  by_action_top: Array<{ action: string; count: number }>;
  /** Distinct actor_username values touching this resource_type. */
  distinct_actors: number;
  /** Newest event ts in this row. null when count=0. */
  most_recent_at: string | null;
}

export interface AuditResourceTypeDistributionSummary {
  tenant_id: string;
  generated_at: string;
  total_events: number;
  /** Every ALL_RESOURCE_TYPES in canonical order even when zero-count. */
  types: ResourceTypeRow[];
  /** Highest total_count type. Canonical-order tie-break (user wins
   *  over session at same count). null on empty. */
  most_active_type: AuditResourceType | null;
  /** Types with total_count=0 in canonical order. */
  unused_types: AuditResourceType[];
  /** Newest event ts across the WHOLE chain (regardless of type).
   *  null when no events. */
  last_event_at: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyBySeverity(): Record<AuditSeverity, number> {
  return { critical: 0, warning: 0, info: 0 };
}

function emptyByOutcome(): Record<AuditOutcome, number> {
  return { success: 0, failure: 0, denied: 0 };
}

interface RowBuilder {
  resource_type: AuditResourceType;
  total_count: number;
  by_severity: Record<AuditSeverity, number>;
  by_outcome: Record<AuditOutcome, number>;
  action_counts: Map<string, number>;
  actors: Set<string>;
  most_recent_at: string | null;
}

function newBuilder(resource_type: AuditResourceType): RowBuilder {
  return {
    resource_type,
    total_count: 0,
    by_severity: emptyBySeverity(),
    by_outcome: emptyByOutcome(),
    action_counts: new Map(),
    actors: new Set(),
    most_recent_at: null,
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeAuditByResourceType(
  tenant_id: string,
  events: readonly AuditEvent[],
  now: Date,
): AuditResourceTypeDistributionSummary {
  const builders = new Map<AuditResourceType, RowBuilder>();
  for (const rt of ALL_RESOURCE_TYPES) builders.set(rt, newBuilder(rt));

  let last_event_at: string | null = null;

  for (const e of events) {
    const b = builders.get(e.resource_type);
    if (!b) continue; // unknown type — shouldn't happen
    b.total_count++;
    if (ALL_SEVERITIES.includes(e.severity)) b.by_severity[e.severity]++;
    if (ALL_OUTCOMES.includes(e.outcome)) b.by_outcome[e.outcome]++;
    b.action_counts.set(e.action, (b.action_counts.get(e.action) ?? 0) + 1);
    b.actors.add(e.actor_username);
    if (!b.most_recent_at || e.ts > b.most_recent_at) b.most_recent_at = e.ts;
    if (!last_event_at || e.ts > last_event_at) last_event_at = e.ts;
  }

  // Finalise rows + top-5 action list.
  const types: ResourceTypeRow[] = ALL_RESOURCE_TYPES.map((rt) => {
    const b = builders.get(rt)!;
    const by_action_top = [...b.action_counts.entries()]
      .sort((a, c) => {
        if (c[1] !== a[1]) return c[1] - a[1];
        return a[0].localeCompare(c[0]);
      })
      .slice(0, TOP_ACTION_CAP)
      .map(([action, count]) => ({ action, count }));
    return {
      resource_type: b.resource_type,
      total_count: b.total_count,
      by_severity: b.by_severity,
      by_outcome: b.by_outcome,
      by_action_top,
      distinct_actors: b.actors.size,
      most_recent_at: b.most_recent_at,
    };
  });

  // most_active_type: highest count with canonical-order tie-break.
  let most_active_type: AuditResourceType | null = null;
  let mostCount = 0;
  for (const rt of ALL_RESOURCE_TYPES) {
    const b = builders.get(rt)!;
    if (b.total_count > mostCount) {
      mostCount = b.total_count;
      most_active_type = rt;
    }
  }
  if (mostCount === 0) most_active_type = null;

  const unused_types = ALL_RESOURCE_TYPES.filter(
    (rt) => builders.get(rt)!.total_count === 0,
  );

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_events: events.length,
    types,
    most_active_type,
    unused_types,
    last_event_at,
  };
}
