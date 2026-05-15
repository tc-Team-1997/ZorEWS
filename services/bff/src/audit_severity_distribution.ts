// services/bff/src/audit_severity_distribution.ts
//
// T6 M15.9 — Audit event severity distribution.
//
// Pivots the audit chain by `severity` (info / warning / critical).
// Mirror of M5.16 (template severity distribution) for the audit
// surface. Pairs with M15.6 (action catalog) + M15.8 (per-actor
// activity) to give the SPA a complete 3-axis pivot family over
// the audit chain — by verb, by actor, by severity.
//
// Lets the SPA render severity-mix chips on the audit page header
// + spot warning/critical-event hotspots. Useful for compliance
// reviews ("how many critical events in the past month? — and
// which resource types do they touch?").
//
// Pure rollup. Single pass over the audit event array.

import type {
  AuditEvent,
  AuditOutcome,
  AuditResourceType,
  AuditSeverity,
} from './audit_trail';

// ─── Public types ─────────────────────────────────────────────────────

const ALL_SEVERITIES: readonly AuditSeverity[] = ['critical', 'warning', 'info'] as const;
const ALL_OUTCOMES: readonly AuditOutcome[] = ['success', 'failure', 'denied'] as const;
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

export interface SeverityDistributionRow {
  severity: AuditSeverity;
  total_count: number;
  /** Per-AuditResourceType count; every key present at 0 when absent. */
  by_resource_type: Record<AuditResourceType, number>;
  /** Per-AuditOutcome count; every key present at 0 when absent. */
  by_outcome: Record<AuditOutcome, number>;
  /** Top-5 actions within this severity bucket. Sorted count desc
   *  with action asc tie-break. */
  by_action_top: Array<{ action: string; count: number }>;
  /** Newest event timestamp in this severity bucket. null when
   *  total_count=0. */
  most_recent_at: string | null;
}

export interface AuditSeverityDistributionSummary {
  tenant_id: string;
  generated_at: string;
  total_events: number;
  /** Every severity emitted in canonical order: critical → warning →
   *  info (worst-first to match SPA chip ordering). */
  severities: SeverityDistributionRow[];
  /** Highest-count severity. Tie-broken by canonical order via
   *  iteration (critical wins over warning at same count). null when
   *  no events. */
  most_common_severity: AuditSeverity | null;
  /** Newest event timestamp with severity='critical'. null when no
   *  critical events. */
  last_critical_event_at: string | null;
}

// ─── Pure helpers ─────────────────────────────────────────────────────

function emptyResourceCounts(): Record<AuditResourceType, number> {
  return {
    user: 0,
    session: 0,
    config: 0,
    case: 0,
    alert: 0,
    report: 0,
    scenario: 0,
    rule: 0,
    integration: 0,
    system: 0,
  };
}

function emptyOutcomeCounts(): Record<AuditOutcome, number> {
  return { success: 0, failure: 0, denied: 0 };
}

function emptyRow(severity: AuditSeverity): SeverityDistributionRow {
  return {
    severity,
    total_count: 0,
    by_resource_type: emptyResourceCounts(),
    by_outcome: emptyOutcomeCounts(),
    by_action_top: [],
    most_recent_at: null,
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeAuditBySeverity(
  tenant_id: string,
  events: readonly AuditEvent[],
  now: Date,
): AuditSeverityDistributionSummary {
  const rows = new Map<AuditSeverity, SeverityDistributionRow>();
  for (const sev of ALL_SEVERITIES) rows.set(sev, emptyRow(sev));

  // Track action counts per severity for the top_action build.
  const actionCountsBySeverity = new Map<AuditSeverity, Map<string, number>>();
  for (const sev of ALL_SEVERITIES) actionCountsBySeverity.set(sev, new Map());

  let last_critical_event_at: string | null = null;

  for (const e of events) {
    const row = rows.get(e.severity);
    if (!row) continue; // unknown severity — shouldn't happen
    row.total_count++;
    if (ALL_RESOURCE_TYPES.includes(e.resource_type)) {
      row.by_resource_type[e.resource_type]++;
    }
    if (ALL_OUTCOMES.includes(e.outcome)) {
      row.by_outcome[e.outcome]++;
    }
    const actionMap = actionCountsBySeverity.get(e.severity)!;
    actionMap.set(e.action, (actionMap.get(e.action) ?? 0) + 1);
    if (!row.most_recent_at || e.ts > row.most_recent_at) {
      row.most_recent_at = e.ts;
    }
    if (e.severity === 'critical') {
      if (!last_critical_event_at || e.ts > last_critical_event_at) {
        last_critical_event_at = e.ts;
      }
    }
  }

  // Build top-5 action lists per severity.
  for (const sev of ALL_SEVERITIES) {
    const row = rows.get(sev)!;
    const actionMap = actionCountsBySeverity.get(sev)!;
    const sorted = [...actionMap.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, 5)
      .map(([action, count]) => ({ action, count }));
    row.by_action_top = sorted;
  }

  const severities = ALL_SEVERITIES.map((sev) => rows.get(sev)!);

  // most_common_severity: highest total_count; tie-broken by canonical
  // order via iteration (critical wins over warning at same count).
  let most_common_severity: AuditSeverity | null = null;
  let mostCount = 0;
  for (const sev of ALL_SEVERITIES) {
    const row = rows.get(sev)!;
    if (row.total_count > mostCount) {
      mostCount = row.total_count;
      most_common_severity = sev;
    }
  }
  if (mostCount === 0) most_common_severity = null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_events: events.length,
    severities,
    most_common_severity,
    last_critical_event_at,
  };
}
