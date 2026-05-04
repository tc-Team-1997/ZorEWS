// services/regulatory-svc/cases/src/case_id.ts
//
// Deterministic UUIDv5-style id derived from (alert_id, customer_id). Same
// alert routed twice yields the same case (FR-CASE-2: single id across
// EWS<->Collection). We deliberately mirror the alerts/ deterministicAlertId
// algorithm rather than pulling a cross-module import — keeps cases/ self
// contained and lets each module evolve its key shape independently.

import { createHash } from 'node:crypto';

export function deterministicCaseId(alertId: string, customerId: string): string {
  const contentKey = ['apex.case.v1', alertId, customerId].join('|');
  const h = createHash('sha256').update(contentKey).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '5' + h.slice(13, 16),
    ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

let actionCounter = 0;
/**
 * Action ids only need to be unique within a case + monotonically sortable.
 * A timestamp + counter suffix is enough for the prototype; in production
 * the case-event consumer would dedupe on (case_id, action_id).
 */
export function newActionId(now: () => Date = () => new Date()): string {
  actionCounter = (actionCounter + 1) & 0xffff;
  const suffix = actionCounter.toString(16).padStart(4, '0');
  return `act_${now().getTime().toString(36)}_${suffix}`;
}

let eventCounter = 0;
export function newEventId(now: () => Date = () => new Date()): string {
  eventCounter = (eventCounter + 1) & 0xffff;
  const suffix = eventCounter.toString(16).padStart(4, '0');
  return `evt_${now().getTime().toString(36)}_${suffix}`;
}

let casCounter = 0;
export function newCasId(now: () => Date = () => new Date()): string {
  casCounter = (casCounter + 1) & 0xffff;
  return `cas_${now().getTime().toString(36)}_${casCounter.toString(16).padStart(4, '0')}`;
}

let capCounter = 0;
export function newCapId(now: () => Date = () => new Date()): string {
  capCounter = (capCounter + 1) & 0xffff;
  return `cap_${now().getTime().toString(36)}_${capCounter.toString(16).padStart(4, '0')}`;
}
