// services/bff/src/investigation_cohort_summary.ts
//
// T6 M9.8 — Case investigation cohort summary.
//
// M9.1 ships the per-investigation tracker. M9.5 detects per-case
// SLA breaches. M9.6 reconstructs a single case's timeline. M9.8 is
// the executive cohort rollup over ALL investigations in the
// tenant: per-status counts, per-decision counts (closed cases),
// mean age + mean time-to-close, oldest open + newest closed
// pointers for at-a-glance triage. Mirrors the M14.19/M3.5
// analytics rollup pattern but for case investigations.
//
// Pure — no I/O. Caller passes the list already loaded from the
// store. Status of every state is always emitted (zero when absent)
// so the SPA can render a complete state-mix bar chart without
// post-processing.

import {
  INVESTIGATION_STATUSES,
  type CaseInvestigation,
  type InvestigationStatus,
  type InvestigationDecision,
} from './case_investigation';

// ─── Public types ─────────────────────────────────────────────────────

export interface InvestigationPointer {
  investigation_id: string;
  case_id: string;
  ts: string;
  /** Age in hours from `ts` to `now` (oldest open) OR resolution
   *  age in hours from opened_at to closed_at (newest closed). */
  age_hours: number;
}

export interface InvestigationCohortSummary {
  tenant_id: string;
  generated_at: string;
  sample_size: number;
  by_status: Record<InvestigationStatus, number>;
  /** Closed investigations only, bucketed by decision. The 4 named
   *  decisions plus a 'null' bucket for closed-without-decision. */
  by_decision: Record<NonNullable<InvestigationDecision>, number> & { null: number };
  open_count: number;
  closed_count: number;
  /** Mean age of OPEN investigations (now - opened_at). null when
   *  no open investigations. */
  mean_age_open_hours: number | null;
  /** Mean closed_at - opened_at. null when no closed investigations. */
  mean_time_to_close_hours: number | null;
  /** Oldest currently-open investigation. null when no opens. */
  oldest_open: InvestigationPointer | null;
  /** Most recently closed investigation. null when no closures. */
  newest_closed: InvestigationPointer | null;
}

// ─── Pure aggregator ──────────────────────────────────────────────────

function emptyByStatus(): Record<InvestigationStatus, number> {
  const r = {} as Record<InvestigationStatus, number>;
  for (const s of INVESTIGATION_STATUSES) r[s] = 0;
  return r;
}

function emptyByDecision(): InvestigationCohortSummary['by_decision'] {
  return {
    fraud_confirmed: 0,
    fraud_unsubstantiated: 0,
    partial_fraud: 0,
    data_quality: 0,
    null: 0,
  };
}

function hoursBetween(a: string, b: string | Date): number {
  const aMs = new Date(a).getTime();
  const bMs = b instanceof Date ? b.getTime() : new Date(b).getTime();
  return (bMs - aMs) / 3_600_000;
}

export function summarizeInvestigationCohort(
  tenant_id: string,
  investigations: readonly CaseInvestigation[],
  now: Date,
): InvestigationCohortSummary {
  const by_status = emptyByStatus();
  const by_decision = emptyByDecision();
  let open_count = 0;
  let closed_count = 0;
  let sum_age_open_hours = 0;
  let sum_time_to_close_hours = 0;
  let oldest_open: InvestigationPointer | null = null;
  let newest_closed: InvestigationPointer | null = null;
  const nowIso = now.toISOString();

  for (const inv of investigations) {
    by_status[inv.status] += 1;
    if (inv.status === 'closed') {
      closed_count += 1;
      const key: NonNullable<InvestigationDecision> | 'null' = inv.decision ?? 'null';
      by_decision[key] += 1;
      if (inv.closed_at) {
        const ttc = hoursBetween(inv.opened_at, inv.closed_at);
        sum_time_to_close_hours += ttc;
        if (!newest_closed || inv.closed_at > newest_closed.ts) {
          newest_closed = {
            investigation_id: inv.investigation_id,
            case_id: inv.case_id,
            ts: inv.closed_at,
            age_hours: ttc,
          };
        }
      }
    } else {
      open_count += 1;
      const age = hoursBetween(inv.opened_at, now);
      sum_age_open_hours += age;
      if (!oldest_open || inv.opened_at < oldest_open.ts) {
        oldest_open = {
          investigation_id: inv.investigation_id,
          case_id: inv.case_id,
          ts: inv.opened_at,
          age_hours: age,
        };
      }
    }
  }

  return {
    tenant_id,
    generated_at: nowIso,
    sample_size: investigations.length,
    by_status,
    by_decision,
    open_count,
    closed_count,
    mean_age_open_hours: open_count > 0 ? sum_age_open_hours / open_count : null,
    mean_time_to_close_hours: closed_count > 0 ? sum_time_to_close_hours / closed_count : null,
    oldest_open,
    newest_closed,
  };
}
