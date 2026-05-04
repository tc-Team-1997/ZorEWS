// services/regulatory-svc/cases/src/types.ts
//
// Domain types for the case management module. Kept self-contained — the
// alerts/ and rules/ siblings each define their own narrow types and a thin
// inbound surface, so cases/ does the same instead of pulling cross-module
// imports.

export type CaseState =
  | 'open'
  | 'assigned'
  | 'in_action'
  | 'monitored'
  | 'closed';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type Outcome = 'cured' | 'cured_temp' | 'defaulted';

export type ActionKind = 'call' | 'visit' | 'sms' | 'email' | 'note';

export interface Gps {
  lat: number;
  lng: number;
  accuracy_m?: number | null;
}

export interface Action {
  action_id: string;
  ts: string;
  kind: ActionKind;
  officer_id: string;
  outcome_note?: string | null;
  gps?: Gps | null;
}

/**
 * Inbound payload to create a case. We only need the contractually stable
 * fields from the canonical alert envelope (apex.regulatory.events.v2).
 */
export interface AlertSummary {
  alert_id: string;
  customer_id: string;
  loan_id?: string | null;
  severity: Severity;
  rule_id: string;
  raised_at: string;
  reason_summary?: string | null;
}

export interface Case {
  case_id: string;
  /** T4.24 Phase 5 — tenant the case belongs to. Inherited from the
   *  originating alert / API caller. Stores list / get / upsert filter
   *  on it; cases are never visible across tenants. */
  tenant_id: string;
  alert_id: string;
  customer_id: string;
  loan_id: string | null;
  severity: Severity;
  rule_id: string;
  reason_summary: string | null;
  state: CaseState;
  assignee: string | null;
  outcome: Outcome | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  actions: Action[];
  /** Causal Analysis Stage records — see app_cases.cas_records.
   *  Per BAC-A manual §3.1.5; populated by the CAS routes. */
  cas_records: CasRecord[];
  /** Corrective Action Plans — see app_cases.caps.
   *  Per BAC-A manual §3.1.5; populated by the CAP routes.
   *  Case cannot transition to closed while any CAP is open/in_progress. */
  caps: Cap[];
}

// ─────────────────────────────────────────────────────────────────────────
// CAS — Causal Analysis Stage (BAC-A manual §3.1.5)
// ─────────────────────────────────────────────────────────────────────────

export type CauseType =
  | 'industry_downturn'
  | 'borrower_specific'
  | 'data_quality'
  | 'macro_shock'
  | 'fraud_suspected'
  | 'other';

export type SeverityAssessment = 'minor' | 'material' | 'severe';
export type CasDecision = 'close_case' | 'proceed_to_cap';
export type ReviewStatus = 'pending' | 'approved' | 'rework' | 'rejected';

export interface Attachment {
  name: string;
  url: string;
  size?: number | null;
}

export interface CasRecord {
  cas_id: string;
  case_id: string;
  cause_type: CauseType;
  cause_summary: string;
  severity_assessment: SeverityAssessment;
  decision: CasDecision;
  submitted_by: string;
  submitted_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_status: ReviewStatus;
  review_comments: string | null;
  attachments: Attachment[];
}

export interface SubmitCasInput {
  cause_type: CauseType;
  cause_summary: string;
  severity_assessment: SeverityAssessment;
  decision: CasDecision;
  submitted_by: string;
  attachments?: Attachment[] | null;
}

export interface ReviewCasInput {
  reviewed_by: string;
  review_status: 'approved' | 'rework' | 'rejected';
  review_comments?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// CAP — Corrective Action Plan (BAC-A manual §3.1.5)
// ─────────────────────────────────────────────────────────────────────────

export type IssuePriority = 'low_risk' | 'medium_risk' | 'high_risk';
export type CapStatus = 'open' | 'in_progress' | 'closed' | 'overdue';

export interface Cap {
  cap_id: string;
  case_id: string;
  cap_item: string;
  issue_owner_group: string;
  issue_owner: string;
  issue_priority: IssuePriority;
  target_completion_date: string;     // ISO date 'YYYY-MM-DD'
  status: CapStatus;
  proposed_by: string;
  proposed_at: string;
  approved_by: string | null;
  approved_at: string | null;
  closed_at: string | null;
  closure_comments: string | null;
  attachments: Attachment[];
}

export interface ProposeCapInput {
  cap_item: string;
  issue_owner_group: string;
  issue_owner: string;
  issue_priority: IssuePriority;
  target_completion_date: string;     // ISO date 'YYYY-MM-DD'
  proposed_by: string;
  attachments?: Attachment[] | null;
}

export interface ApproveCapInput {
  approved_by: string;
  approve: boolean;       // false = reject; CAP returns to status='open' with closure_comments holding the rejection reason
  comments?: string | null;
}

export interface CloseCapInput {
  closed_by: string;
  closure_comments?: string | null;
}

/**
 * Wire-shape event written to the outbox topic apex.case.events. Keeping it
 * separate from `Case` so we can evolve the persisted record without breaking
 * downstream consumers (and vice versa).
 */
export interface CaseEvent {
  event_id: string;
  event_type:
    | 'case.created'
    | 'case.assigned'
    | 'case.action_logged'
    | 'case.monitored'
    | 'case.closed'
    | 'case.cas_submitted'
    | 'case.cas_reviewed'
    | 'case.cap_proposed'
    | 'case.cap_approved'
    | 'case.cap_closed';
  ts: string;
  case_id: string;
  alert_id: string;
  customer_id: string;
  prior_state: CaseState | null;
  new_state: CaseState;
  payload: Record<string, unknown>;
}
