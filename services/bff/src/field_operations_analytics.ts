// services/bff/src/field_operations_analytics.ts
//
// T6 M14.19 — Field-operations analytics.
//
// M14.10 ships the per-tenant field-visit ledger (6-outcome enum,
// optional GPS, FIFO 200/tenant) and a small `aggregateByOutcome`
// helper. M14.19 lifts that into the full supervisor view: across a
// window of visits, who's doing the work, how successful are they,
// and which customers got attention recently.
//
// Surfaces:
//   - outcome mix (re-uses the existing aggregateByOutcome shape)
//   - distinct officers + customers touched
//   - per-officer rollup: visit_count, distinct_customers, success_rate,
//     outcome breakdown, last_visit_at — sorted by visit_count desc
//   - mean_visits_per_officer
//
// Design:
//  - Pure resolver. No I/O, no store coupling. Caller passes the
//    visits slice — typically `fieldVisitStore.list(tenant, filter)`.
//  - "Success" = met_customer + partial_payment + promised_to_pay.
//    no_response / dispute / escalation_needed are failures from
//    the collections-workflow perspective. Tunable via constant.
//  - Per-officer list sorted worst-first by `visit_count` so
//    supervisors see top performers first; ties broken by
//    success_rate (desc) then officer_id (asc) for stability.

import {
  VISIT_OUTCOMES,
  aggregateByOutcome,
  type FieldVisit,
  type OutcomeAggregate,
  type VisitOutcome,
} from './field_officer';

// ─── Public types ─────────────────────────────────────────────────────

export const SUCCESS_OUTCOMES: readonly VisitOutcome[] = [
  'met_customer',
  'partial_payment',
  'promised_to_pay',
];

export interface OfficerRollup {
  officer_id: string;
  visit_count: number;
  distinct_customers: number;
  /** success-outcome visits / visit_count. */
  success_rate: number;
  /** Counts per outcome — same key set as OutcomeAggregate.by_outcome. */
  by_outcome: Record<VisitOutcome, number>;
  /** ISO timestamp of the most recent visit in the window. */
  last_visit_at: string;
}

export interface FieldOperationsAnalytics {
  /** Number of visits the analytics is computed over. */
  sample_size: number;
  /** Distinct officer_ids in the window. */
  distinct_officers: number;
  /** Distinct customer_ids in the window. */
  distinct_customers: number;
  /** Re-exported outcome mix across the entire window. */
  outcome_mix: OutcomeAggregate;
  /** Total success-outcome visits across the window. */
  success_count: number;
  /** success_count / sample_size — null when sample_size=0. */
  success_rate: number | null;
  /** sample_size / distinct_officers — null when distinct_officers=0. */
  mean_visits_per_officer: number | null;
  /** Per-officer rollup, sorted by visit_count desc (then success_rate
   *  desc, officer_id asc for tie-breaking). */
  per_officer: OfficerRollup[];
}

// ─── Pure aggregator ──────────────────────────────────────────────────

function emptyByOutcome(): Record<VisitOutcome, number> {
  return Object.fromEntries(VISIT_OUTCOMES.map((o) => [o, 0])) as Record<
    VisitOutcome,
    number
  >;
}

const SUCCESS_SET: ReadonlySet<VisitOutcome> = new Set(SUCCESS_OUTCOMES);

/**
 * Roll up a window of FieldVisit records into FieldOperationsAnalytics.
 * Caller is responsible for slicing the window before calling
 * (typically `fieldVisitStore.list(tenant, filter)`).
 */
export function summarizeFieldOperations(
  visits: readonly FieldVisit[],
): FieldOperationsAnalytics {
  const outcome_mix = aggregateByOutcome(visits);
  const distinctCustomers = new Set<string>();
  /** officer_id → rollup */
  const perOfficerMap = new Map<
    string,
    {
      visit_count: number;
      customers: Set<string>;
      by_outcome: Record<VisitOutcome, number>;
      success_count: number;
      last_visit_at: string;
    }
  >();

  let success_count = 0;
  for (const v of visits) {
    distinctCustomers.add(v.customer_id);
    if (SUCCESS_SET.has(v.outcome)) success_count += 1;
    let rec = perOfficerMap.get(v.officer_id);
    if (!rec) {
      rec = {
        visit_count: 0,
        customers: new Set<string>(),
        by_outcome: emptyByOutcome(),
        success_count: 0,
        last_visit_at: v.visit_at,
      };
      perOfficerMap.set(v.officer_id, rec);
    }
    rec.visit_count += 1;
    rec.customers.add(v.customer_id);
    rec.by_outcome[v.outcome] += 1;
    if (SUCCESS_SET.has(v.outcome)) rec.success_count += 1;
    if (v.visit_at > rec.last_visit_at) rec.last_visit_at = v.visit_at;
  }

  const per_officer: OfficerRollup[] = [];
  for (const [officer_id, rec] of perOfficerMap) {
    per_officer.push({
      officer_id,
      visit_count: rec.visit_count,
      distinct_customers: rec.customers.size,
      success_rate: rec.visit_count === 0 ? 0 : rec.success_count / rec.visit_count,
      by_outcome: rec.by_outcome,
      last_visit_at: rec.last_visit_at,
    });
  }
  per_officer.sort((a, b) => {
    if (b.visit_count !== a.visit_count) return b.visit_count - a.visit_count;
    if (b.success_rate !== a.success_rate) return b.success_rate - a.success_rate;
    return a.officer_id < b.officer_id ? -1 : a.officer_id > b.officer_id ? 1 : 0;
  });

  const sample_size = visits.length;
  const distinct_officers = perOfficerMap.size;
  return {
    sample_size,
    distinct_officers,
    distinct_customers: distinctCustomers.size,
    outcome_mix,
    success_count,
    success_rate: sample_size === 0 ? null : success_count / sample_size,
    mean_visits_per_officer:
      distinct_officers === 0 ? null : sample_size / distinct_officers,
    per_officer,
  };
}
