// services/regulatory-svc/cases/src/state_machine.ts
//
// Pure state-machine helpers. No IO, no side effects — service.ts wraps
// these with persistence + event emission.
//
// Allowed transitions (FR-CASE-1):
//
//   create:     <none> -> open
//   assign:     open      -> assigned
//   logAction:  assigned  -> in_action
//               in_action -> in_action
//               monitored -> in_action      (re-engage during monitoring)
//   monitor:    in_action -> monitored
//   close:      open | assigned | in_action | monitored -> closed
//
// Anything else throws IllegalTransition. Closed cases are terminal in the
// prototype — re-opening would need a new alert (which would yield a new
// case_id by construction).

import type { CaseState } from './types';

export type Transition = 'assign' | 'logAction' | 'monitor' | 'close';

export class IllegalTransition extends Error {
  status = 409;
  constructor(
    public readonly current: CaseState,
    public readonly attempted: Transition,
  ) {
    super(`cannot ${attempted} a case in state ${current}`);
    this.name = 'IllegalTransition';
  }
}

const TABLE: Record<CaseState, Partial<Record<Transition, CaseState>>> = {
  open: {
    assign: 'assigned',
    close: 'closed',
  },
  assigned: {
    logAction: 'in_action',
    close: 'closed',
  },
  in_action: {
    logAction: 'in_action',
    monitor: 'monitored',
    close: 'closed',
  },
  monitored: {
    logAction: 'in_action',
    close: 'closed',
  },
  closed: {},
};

export function nextState(current: CaseState, transition: Transition): CaseState {
  const next = TABLE[current][transition];
  if (!next) throw new IllegalTransition(current, transition);
  return next;
}

export function isTerminal(state: CaseState): boolean {
  return state === 'closed';
}
