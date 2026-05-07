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

  // Confidence + exposure aren't on the canonical wire shape yet, so the
  // server uses deterministic stand-ins keyed off severity + customer_id
  // until the rule engine + customer-exposure feed land. Keeps the list
  // stable across reloads so the SPA's tests + UX feel consistent.
  const confidence = CONFIDENCE_BY_SEVERITY[severity];
  const exposure =
    lookups.customers[canonical.customer_id]?.exposure_kes ??
    EXPOSURE_BY_SEVERITY[severity];

  const criticality_score = computeScore({
    severity,
    confidence,
    customer_exposure_kes: exposure,
    age_min: ageMin,
  });

  return {
    id: canonical.alert_id,
    severity,
    customer: { id: canonical.customer_id, name: customerName },
    rule: { id: canonical.rule_id, name: ruleName },
    indicators: [...canonical.indicators_fired],
    age_min: ageMin,
    assignee,
    created_at: canonical.raised_at,
    confidence,
    customer_exposure_kes: exposure,
    criticality_score,
    linked_alert_ids: [],
  };
}

const CONFIDENCE_BY_SEVERITY: Record<UiSeverity, number> = {
  critical: 0.92,
  high:     0.82,
  medium:   0.65,
  low:      0.55,
};

const EXPOSURE_BY_SEVERITY: Record<UiSeverity, number> = {
  critical: 1_500_000,
  high:       800_000,
  medium:     400_000,
  low:        200_000,
};

const SEVERITY_WEIGHT: Record<UiSeverity, number> = {
  critical: 4, high: 3, medium: 2, low: 1,
};

function ageBoost(ageMin: number): number {
  if (ageMin < 24 * 60) return 1.0;
  if (ageMin < 72 * 60) return 1.2;
  return 1.5;
}

function computeScore(input: {
  severity: UiSeverity;
  confidence: number;
  customer_exposure_kes: number;
  age_min: number;
}): number {
  const sw = SEVERITY_WEIGHT[input.severity];
  const conf = Math.min(1, Math.max(0, input.confidence));
  const expBase = Math.max(input.customer_exposure_kes, 100_000);
  const expMult = Math.log10(expBase / 100_000);
  const safe = expMult <= 0 ? 1 : 1 + expMult;
  return Math.round(sw * conf * safe * ageBoost(input.age_min) * 100) / 100;
}

export interface ListFilters {
  severity?: UiSeverity;
  assignee?: string;
  /** Group by customer; highest-criticality alert per customer is primary. */
  dedup?: boolean;
  /** Sort key. `criticality` (default) ranks by computeScore desc. */
  sort?: 'criticality' | 'severity' | 'age';
}

export function mapAlertList(
  canonicals: CanonicalAlert[],
  lookups: Lookups,
  filters: ListFilters = {},
  now: () => Date = () => new Date(),
): AlertRow[] {
  let rows = canonicals
    .map((c) => mapAlertEvent(c, lookups, now))
    .filter((r) => {
      if (filters.severity && r.severity !== filters.severity) return false;
      if (filters.assignee && r.assignee !== filters.assignee) return false;
      return true;
    });

  if (filters.dedup) {
    const byCustomer = new Map<string, AlertRow[]>();
    for (const r of rows) {
      const arr = byCustomer.get(r.customer.id) ?? [];
      arr.push(r);
      byCustomer.set(r.customer.id, arr);
    }
    const merged: AlertRow[] = [];
    for (const arr of byCustomer.values()) {
      if (arr.length === 1) { merged.push(arr[0]); continue; }
      let primary = arr[0];
      for (const r of arr) {
        if (r.criticality_score > primary.criticality_score) primary = r;
      }
      const linked = arr.filter((r) => r.id !== primary.id).map((r) => r.id);
      merged.push({ ...primary, linked_alert_ids: linked });
    }
    rows = merged;
  }

  const sort = filters.sort ?? 'criticality';
  rows.sort((a, b) => {
    if (sort === 'criticality') return b.criticality_score - a.criticality_score;
    if (sort === 'severity') return SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
    return b.age_min - a.age_min; // age — oldest first
  });
  return rows;
}

/** Test/dev helper: deduplicate canonicals by alert_id (last-write-wins). */
export function dedupeByAlertId(canonicals: CanonicalAlert[]): CanonicalAlert[] {
  const seen = new Map<string, CanonicalAlert>();
  for (const c of canonicals) seen.set(c.alert_id, c);
  return [...seen.values()];
}
