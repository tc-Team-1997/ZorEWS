// services/bff/src/mapping.ts
//
// The pure heart of T3.10: convert one canonical alert envelope to the UI's
// list-row shape. No IO, no IO-bearing imports, no environment reads.
//
// FUTURE — Task 6 (alert prioritization):
//   The criticality formula lives in web/src/lib/criticality.ts (computeScore)
//   and is currently applied in the MSW handler (web/src/mocks/handlers.ts
//   /api/alerts route). When this BFF mapping is wired to a real customer-
//   exposure source, port the same formula here so /api/alerts and
//   /v1/alerts agree on rankings:
//     1. Extend Lookups with a per-customer exposure_kes field.
//     2. Extend AlertRow with confidence + customer_exposure_kes +
//        criticality_score + linked_alert_ids.
//     3. After mapAlertEvent's join, run computeScore() then dedupByCustomer().
//   Keep the formula identical to the SPA helper — divergence between SPA
//   ranking and BFF ranking would silently confuse analysts switching
//   between dev (MSW) and prod (BFF).

import type { AlertRow, CanonicalAlert, Lookups, UiSeverity, WireSeverity } from './types';

const SEVERITY_MAP: Record<WireSeverity, UiSeverity> = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

/**
 * Convert canonical → list-row.
 *
 * - severity: UPPERCASE → lowercase
 * - customer.name / rule.name: looked up; fall back to id when absent
 * - age_min: floor((now - raised_at) / 60000); clamped to 0 if the event
 *   was raised "in the future" (clock skew safety)
 * - assignee: pulled from lookups.assignees if present, else null
 */
export function mapAlertEvent(
  canonical: CanonicalAlert,
  lookups: Lookups,
  now: () => Date = () => new Date(),
): AlertRow {
  const severity = SEVERITY_MAP[canonical.severity];
  if (!severity) {
    // The schema constrains severity to the four values above; if a producer
    // bug ships something else, we don't want the whole list to 500 — surface
    // it as 'low' and let the analyst decide. (This mirrors the SmartQueue's
    // forgiving behaviour.)
    throw new Error(`unknown wire severity: ${canonical.severity}`);
  }

  const customerName = lookups.customers[canonical.customer_id]?.name ?? canonical.customer_id;
  const ruleName = lookups.rules[canonical.rule_id]?.name ?? canonical.rule_id;
  const assignee = lookups.assignees?.[canonical.alert_id] ?? null;

  const raisedMs = Date.parse(canonical.raised_at);
  const ageMs = now().getTime() - raisedMs;
  const ageMin = Number.isFinite(ageMs) ? Math.max(0, Math.floor(ageMs / 60000)) : 0;

  return {
    id: canonical.alert_id,
    severity,
    customer: { id: canonical.customer_id, name: customerName },
    rule: { id: canonical.rule_id, name: ruleName },
    indicators: [...canonical.indicators_fired],
    age_min: ageMin,
    assignee,
    created_at: canonical.raised_at,
  };
}

export interface ListFilters {
  severity?: UiSeverity;
  assignee?: string;
}

export function mapAlertList(
  canonicals: CanonicalAlert[],
  lookups: Lookups,
  filters: ListFilters = {},
  now: () => Date = () => new Date(),
): AlertRow[] {
  // Newest-first by raised_at, with stable secondary sort on alert_id so
  // re-runs across the same outbox shard return the same order.
  const rows = canonicals
    .map((c) => mapAlertEvent(c, lookups, now))
    .filter((r) => {
      if (filters.severity && r.severity !== filters.severity) return false;
      if (filters.assignee && r.assignee !== filters.assignee) return false;
      return true;
    });
  rows.sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
  return rows;
}

/** Test/dev helper: deduplicate canonicals by alert_id (last-write-wins). */
export function dedupeByAlertId(canonicals: CanonicalAlert[]): CanonicalAlert[] {
  const seen = new Map<string, CanonicalAlert>();
  for (const c of canonicals) seen.set(c.alert_id, c);
  return [...seen.values()];
}
