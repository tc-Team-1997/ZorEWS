// services/bff/src/rules/state_machine.ts
//
// Maker-checker state machine for the rule lifecycle.
//
//                  ┌──────── reject ◀─────────┐
//                  │                          │
//   draft ──submit──▶ pending_review ──approve──▶ approved ──activate──▶ active ──deprecate──▶ deprecated
//      ▲                                              │
//      └────────────── edit (active rule) ────────────┘
//
// `edit` is allowed in draft (no-op transition; bumps version) and in
// active (clones into a new draft version which then needs re-approval).

import type { AuditEvent, AuditEventKind, RuleState, RuleV2 } from './types';

export type Transition = 'submit' | 'approve' | 'reject' | 'activate' | 'deprecate' | 'edit';

interface TransitionRule {
  from: RuleState;
  to: RuleState;
  /** Operation slug enforced by the route handler. */
  rbac: string;
  /** Audit kind written when this transition fires. */
  kind: AuditEventKind;
}

const TABLE: Record<Transition, TransitionRule[]> = {
  submit: [{ from: 'draft', to: 'pending_review', rbac: 'rules:create', kind: 'submitted' }],
  approve: [
    { from: 'pending_review', to: 'approved', rbac: 'rules:promote', kind: 'approved' },
  ],
  reject: [{ from: 'pending_review', to: 'draft', rbac: 'rules:promote', kind: 'rejected' }],
  activate: [
    // Activation is a separate gate from approval — only a CRO/admin can flip
    // the bit that puts a rule in front of real customers.
    { from: 'approved', to: 'active', rbac: 'rules:promote', kind: 'activated' },
  ],
  deprecate: [
    { from: 'active', to: 'deprecated', rbac: 'rules:retire', kind: 'deprecated' },
    { from: 'approved', to: 'deprecated', rbac: 'rules:retire', kind: 'deprecated' },
  ],
  edit: [
    { from: 'draft', to: 'draft', rbac: 'rules:create', kind: 'edited' },
    // Editing an active rule clones into draft for re-review.
    { from: 'active', to: 'draft', rbac: 'rules:create', kind: 'edited' },
  ],
};

export class IllegalTransition extends Error {
  constructor(public readonly from: RuleState, public readonly transition: Transition) {
    super(`cannot ${transition} a rule in state ${from}`);
    this.name = 'IllegalTransition';
  }
}

export class InvalidPayload extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPayload';
  }
}

export interface ApplyContext {
  actor_id: string;
  actor_role: string;
  ts: string;
  /** Required on `reject`. */
  comment?: string;
}

export function applyTransition(
  rule: RuleV2,
  transition: Transition,
  ctx: ApplyContext,
): RuleV2 {
  const candidates = TABLE[transition];
  const match = candidates?.find((t) => t.from === rule.state);
  if (!match) throw new IllegalTransition(rule.state, transition);

  if (transition === 'reject' && (!ctx.comment || !ctx.comment.trim())) {
    throw new InvalidPayload('comment is required when rejecting a rule');
  }

  const next: RuleV2 = { ...rule, state: match.to, updated_at: ctx.ts };
  // Maker-checker bookkeeping
  if (transition === 'submit') next.submitted_by = ctx.actor_id;
  if (transition === 'approve') next.approved_by = ctx.actor_id;
  if (transition === 'reject') {
    next.submitted_by = null;
    next.approved_by = null;
  }
  const audit: AuditEvent = {
    ts: ctx.ts,
    actor_id: ctx.actor_id,
    actor_role: ctx.actor_role,
    kind: match.kind,
    to_state: match.to,
    comment: ctx.comment,
    version: rule.version,
  };
  next.audit = [...rule.audit, audit];
  return next;
}

/** Map a transition to the RBAC capability the route handler must enforce. */
export function rbacFor(transition: Transition, fromState: RuleState): string {
  const t = TABLE[transition].find((row) => row.from === fromState);
  return t ? t.rbac : 'rules:create';
}

/** What transitions are legally available from the current state. */
export function legalTransitions(state: RuleState): Transition[] {
  const out: Transition[] = [];
  for (const [t, rows] of Object.entries(TABLE)) {
    if (rows.some((r) => r.from === state)) out.push(t as Transition);
  }
  return out;
}
