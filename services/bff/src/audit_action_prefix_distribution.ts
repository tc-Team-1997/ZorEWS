// services/bff/src/audit_action_prefix_distribution.ts
//
// T6 M15.13 — Audit action prefix distribution.
//
// BIL audit actions follow the `<prefix>.<verb>` pattern across the
// codebase: `case.create`, `case.assign`, `config.update`,
// `config.reset`, `scenario.create`, `scenario.update`,
// `scenario.delete`, etc. M15.6 ships the per-action catalog
// (one row per verb). M15.13 lands the COARSER pivot: group by
// PREFIX (everything before the first `.`) so the SPA can render a
// "by-domain" rollup answering "how much of our audit traffic is
// config vs scenario vs case?".
//
// Mirror of M4.13 indicator family extraction pattern (regex strip
// trailing suffix) but for audit verb prefixes. Pure resolver — walks
// the M15.1 audit trail in one pass.
//
// Pairs with the M15 pivot family: M15.6 by action verb, M15.8 by
// actor, M15.9 by severity, M15.10 by correlation, M15.11 daily
// volume, M15.12 by resource_type. M15.13 closes the verb-aggregation
// gap above M15.6.

import type {
  AuditEvent,
  AuditOutcome,
  AuditResourceType,
} from './audit_trail';

// ─── Public types ─────────────────────────────────────────────────────

const ALL_OUTCOMES: readonly AuditOutcome[] = ['success', 'failure', 'denied'];

export interface AuditPrefixRow {
  prefix: string;
  total_count: number;
  /** Distinct verb-suffixes seen for this prefix (the part AFTER the
   *  first `.`). Sorted asc. */
  distinct_verbs: string[];
  by_outcome: Record<AuditOutcome, number>;
  /** Distinct AuditResourceType values touched by events with this
   *  prefix. Sorted asc. */
  distinct_resource_types: AuditResourceType[];
  /** Distinct actor_usernames who performed events with this prefix.
   *  Sorted asc. */
  distinct_actors: string[];
  /** Newest ts across this prefix. null only when count=0 (which
   *  shouldn't surface since rows are only emitted for observed
   *  prefixes). */
  most_recent_at: string | null;
}

export interface AuditActionPrefixSummary {
  tenant_id: string;
  generated_at: string;
  total_events: number;
  total_prefixes: number;
  /** Events whose action doesn't contain a `.` — counted in
   *  envelope total_events but not bucketed into any prefix row.
   *  Surfaces "did we accidentally write a flat-verb event?". */
  unprefixed_count: number;
  /** Prefix rows sorted by total_count desc with prefix asc tie-break. */
  prefixes: AuditPrefixRow[];
  /** Top prefix by total_count. Canonical prefix asc tie-break via
   *  iteration. null when no prefixed events observed. */
  most_frequent_prefix: { prefix: string; total_count: number } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyOutcomeMap(): Record<AuditOutcome, number> {
  return { success: 0, failure: 0, denied: 0 };
}

function splitAction(action: string): { prefix: string | null; verb: string } {
  const dot = action.indexOf('.');
  if (dot <= 0) return { prefix: null, verb: action };
  return { prefix: action.slice(0, dot), verb: action.slice(dot + 1) };
}

// ─── Pure resolver ────────────────────────────────────────────────────

interface PrefixBuilder {
  prefix: string;
  total_count: number;
  verbs: Set<string>;
  outcomes: Record<AuditOutcome, number>;
  resource_types: Set<AuditResourceType>;
  actors: Set<string>;
  most_recent_ms: number;
  most_recent_iso: string | null;
}

export function summarizeAuditActionPrefixDistribution(
  tenant_id: string,
  events: readonly AuditEvent[],
  now: Date,
): AuditActionPrefixSummary {
  const byPrefix = new Map<string, PrefixBuilder>();
  let unprefixed_count = 0;

  for (const ev of events) {
    const { prefix, verb } = splitAction(ev.action);
    if (!prefix) {
      unprefixed_count++;
      continue;
    }
    let b = byPrefix.get(prefix);
    if (!b) {
      b = {
        prefix,
        total_count: 0,
        verbs: new Set(),
        outcomes: emptyOutcomeMap(),
        resource_types: new Set(),
        actors: new Set(),
        most_recent_ms: -Infinity,
        most_recent_iso: null,
      };
      byPrefix.set(prefix, b);
    }
    b.total_count++;
    b.verbs.add(verb);
    if (ALL_OUTCOMES.includes(ev.outcome)) b.outcomes[ev.outcome]++;
    if (ev.resource_type) b.resource_types.add(ev.resource_type);
    if (ev.actor_username) b.actors.add(ev.actor_username);
    const ts = new Date(ev.ts).getTime();
    if (Number.isFinite(ts) && ts > b.most_recent_ms) {
      b.most_recent_ms = ts;
      b.most_recent_iso = ev.ts;
    }
  }

  const prefixes: AuditPrefixRow[] = [];
  for (const b of byPrefix.values()) {
    prefixes.push({
      prefix: b.prefix,
      total_count: b.total_count,
      distinct_verbs: [...b.verbs].sort((a, z) => a.localeCompare(z)),
      by_outcome: b.outcomes,
      distinct_resource_types: [...b.resource_types].sort((a, z) => a.localeCompare(z)),
      distinct_actors: [...b.actors].sort((a, z) => a.localeCompare(z)),
      most_recent_at: b.most_recent_iso,
    });
  }

  // Sort: total_count desc, prefix asc tie-break.
  prefixes.sort((a, z) => {
    if (z.total_count !== a.total_count) return z.total_count - a.total_count;
    return a.prefix.localeCompare(z.prefix);
  });

  const most_frequent_prefix = prefixes.length > 0
    ? { prefix: prefixes[0]!.prefix, total_count: prefixes[0]!.total_count }
    : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_events: events.length,
    total_prefixes: prefixes.length,
    unprefixed_count,
    prefixes,
    most_frequent_prefix,
  };
}
