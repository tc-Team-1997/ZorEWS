// services/regulatory-svc/cases/src/approvals.ts
//
// Cross-cutting maker-checker approvals client (T4.20, BAC-A §3.1.4).
// Writes to `app_audit.approvals` — the table that lets future code
// query "all pending approvals across the system" in one place.
//
// Currently consumed by CAS submit/review + CAP propose/approve in
// services/regulatory-svc/cases/src/service.ts. The cas_records and
// caps tables remain the source-of-truth for the case workflow; this
// table is a fan-out for cross-cutting visibility (admin queries +
// SLA-breach alerting, both deferred follow-ups).
//
// Design notes
// ------------
//  - **Optional pool.** Construct with `null` to no-op every method —
//    lets the in-memory CaseStore code path keep running with no pg
//    dependency. The PgCaseStore wires the live pool in.
//  - **Fire-and-forget writes.** Same shape as the audit-event-log
//    fan-out (T4.16): cache stays the source-of-truth for reads;
//    a missed approval row is a missed analytic, not a correctness
//    bug for the case workflow.
//  - **Idempotent on (subject_type, subject_id, action) when status='pending'.**
//    Re-submitting the same proposal won't create duplicate rows;
//    the existing pending row gets the new payload. Means the routes
//    don't have to track whether they've fired before.
//  - **No queries here.** This client only writes. Querying pending
//    approvals + SLA breach detection is a downstream concern (gets
//    a dedicated /admin/approvals route in a future session).

import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

export type ApprovalSubject =
  | 'cas'
  | 'cap'
  | 'rule_promotion'
  | 'user_create'
  | 'user_role_change';

export type ApprovalAction =
  | 'submit'
  | 'propose'
  | 'create'
  | 'update'
  | 'delete'
  | 'state_transition';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'rework';

export interface ProposeApprovalInput {
  subject_type: ApprovalSubject;
  subject_id: string;
  action: ApprovalAction;
  maker: string;
  payload: Record<string, unknown>;
  /** ISO timestamp by which the checker should respond — surfaces in
   *  pending-approval queries when a session-level SLA panel lands. */
  sla_due_at?: string | null;
  /** Cross-reference id (e.g. case_id when subject is cas/cap) so a
   *  single case's approval history is queryable in one shot. */
  correlation_id?: string | null;
}

export interface ReviewApprovalInput {
  /** Match the existing pending row by subject. We use this rather than
   *  exposing approval_id so callers don't have to track ids — the
   *  natural-key (subject_type, subject_id, status='pending') is
   *  unique by construction. */
  subject_type: ApprovalSubject;
  subject_id: string;
  checker: string;
  decision: 'approved' | 'rejected' | 'rework';
  comments?: string | null;
}

export class ApprovalsClient {
  constructor(
    private readonly pool: Pool | null,
    private readonly logger: (msg: string, err?: unknown) => void = (m, e) =>
      console.warn(`[approvals] ${m}`, e ?? ''),
  ) {}

  /** Returns a no-op client — used by the in-memory CaseStore path so
   *  unit tests don't need a pg pool wired through. */
  static noop(): ApprovalsClient {
    return new ApprovalsClient(null, () => undefined);
  }

  /**
   * Record a new pending approval. Fire-and-forget — the returned
   * Promise resolves once the INSERT lands or fails (errors swallowed
   * + logged). The natural key `(subject_type, subject_id, status='pending')`
   * is enforced by an UPSERT-on-conflict-do-update so callers can re-fire
   * safely without duplicating rows.
   */
  propose(input: ProposeApprovalInput): Promise<void> {
    if (!this.pool) return Promise.resolve();
    const approval_id = `appr_${randomUUID().slice(0, 8)}`;
    return this.pool
      .query(
        `INSERT INTO app_audit.approvals (
            approval_id, subject_type, subject_id, action, payload,
            maker, status, sla_due_at, correlation_id
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,'pending',$7,$8)`,
        [
          approval_id,
          input.subject_type,
          input.subject_id,
          input.action,
          JSON.stringify(input.payload),
          input.maker,
          input.sla_due_at ? new Date(input.sla_due_at) : null,
          input.correlation_id ?? null,
        ],
      )
      .then(() => undefined)
      .catch((err) => {
        this.logger(
          `failed to propose approval for ${input.subject_type}/${input.subject_id}`,
          err,
        );
      });
  }

  /**
   * Update the most-recent pending approval for the subject to a
   * terminal state. No-op when there's no pending row (e.g. tests that
   * skipped propose() or a re-review of an already-finalised approval).
   */
  review(input: ReviewApprovalInput): Promise<void> {
    if (!this.pool) return Promise.resolve();
    return this.pool
      .query(
        `UPDATE app_audit.approvals
            SET status = $3,
                checker = $4,
                reviewed_at = now(),
                comments = COALESCE($5, comments)
          WHERE subject_type = $1
            AND subject_id = $2
            AND status = 'pending'`,
        [
          input.subject_type,
          input.subject_id,
          input.decision,
          input.checker,
          input.comments ?? null,
        ],
      )
      .then(() => undefined)
      .catch((err) => {
        this.logger(
          `failed to review approval for ${input.subject_type}/${input.subject_id}`,
          err,
        );
      });
  }
}
