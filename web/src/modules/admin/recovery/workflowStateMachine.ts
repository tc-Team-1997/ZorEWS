// web/src/modules/admin/recovery/workflowStateMachine.ts
//
// Recovery Approval state machine — mirrors M9.3 case_maker_checker +
// M7.2 ai_model_promotion contracts so operators experience familiar UX.
//
// Pure — no I/O. The BFF route handlers (when wired) call canTransition()
// before mutating, and the SPA queue UI uses TRANSITIONS to decide which
// action buttons to render per row.

export type RecoveryApprovalStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'cancelled';

export const ALL_RECOVERY_APPROVAL_STATUSES: readonly RecoveryApprovalStatus[] = [
  'draft', 'submitted', 'approved', 'rejected', 'executed', 'cancelled',
] as const;

/**
 * Closed-enum transition table.
 *   draft       → submitted | cancelled
 *   submitted   → approved  | rejected | cancelled
 *   approved    → executed  | cancelled       (admin override pre-execution)
 *   rejected    → terminal
 *   executed    → terminal
 *   cancelled   → terminal
 */
export const TRANSITIONS: Record<RecoveryApprovalStatus, readonly RecoveryApprovalStatus[]> = {
  draft:     ['submitted', 'cancelled'],
  submitted: ['approved', 'rejected', 'cancelled'],
  approved:  ['executed', 'cancelled'],
  rejected:  [],
  executed:  [],
  cancelled: [],
} as const;

export const TERMINAL_STATUSES: readonly RecoveryApprovalStatus[] = [
  'rejected', 'executed', 'cancelled',
] as const;

export function canTransition(from: RecoveryApprovalStatus, to: RecoveryApprovalStatus): boolean {
  if (from === to) return false; // no-op transitions rejected
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: RecoveryApprovalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function nextStatesFor(status: RecoveryApprovalStatus): readonly RecoveryApprovalStatus[] {
  return TRANSITIONS[status];
}

export interface SelfApprovalCheck {
  allowed: boolean;
  reason?: 'self_approval_forbidden';
}

/**
 * RBI segregation-of-duties rule: maker MUST differ from checker.
 * Mirrors the M9.3 case_maker_checker check verbatim.
 */
export function checkMakerNotChecker(
  maker_username: string,
  checker_username: string,
): SelfApprovalCheck {
  if (maker_username && checker_username && maker_username === checker_username) {
    return { allowed: false, reason: 'self_approval_forbidden' };
  }
  return { allowed: true };
}

export interface RecoveryApprovalLabels {
  status: RecoveryApprovalStatus;
  label: string;
  description: string;
  tone: 'neutral' | 'blue' | 'success' | 'warning' | 'danger';
}

export const STATUS_LABELS: Record<RecoveryApprovalStatus, RecoveryApprovalLabels> = {
  draft: {
    status: 'draft',
    label: 'Draft',
    description: 'Maker is still composing — not yet visible to checkers.',
    tone: 'neutral',
  },
  submitted: {
    status: 'submitted',
    label: 'Pending Recovery Approval',
    description: 'Awaiting checker decision in the approval queue.',
    tone: 'warning',
  },
  approved: {
    status: 'approved',
    label: 'Approved',
    description: 'Checker has signed off — awaiting execution by an action-holder.',
    tone: 'success',
  },
  rejected: {
    status: 'rejected',
    label: 'Rejected',
    description: 'Checker rejected the request. Maker can submit a fresh one.',
    tone: 'danger',
  },
  executed: {
    status: 'executed',
    label: 'Restored',
    description: 'Adapter restored/purged the record successfully.',
    tone: 'blue',
  },
  cancelled: {
    status: 'cancelled',
    label: 'Cancelled',
    description: 'Maker withdrew the request before review.',
    tone: 'neutral',
  },
} as const;
