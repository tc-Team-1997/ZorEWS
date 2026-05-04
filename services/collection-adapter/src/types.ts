// services/collection-adapter/src/types.ts
//
// We mirror what services/regulatory-svc/cases actually emits — see that
// module's CaseEvent type. The registry's apex.case.events.v1.json schema
// pre-dates the cases service implementation and uses different field names
// (`occurred_at` vs `ts`, `lifecycle_state` vs `event_type`); the registry
// schema needs to be bumped to v2 to match the live emitter, but that's its
// own task. For T3.4 we consume the live shape.

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type Outcome = 'cured' | 'cured_temp' | 'defaulted';

export type CaseState = 'open' | 'assigned' | 'in_action' | 'monitored' | 'closed';

export type CaseEventType =
  | 'case.created'
  | 'case.assigned'
  | 'case.action_logged'
  | 'case.monitored'
  | 'case.closed';

export interface CaseEvent {
  event_id: string;
  event_type: CaseEventType;
  ts: string;
  case_id: string;
  alert_id: string;
  customer_id: string;
  prior_state: CaseState | null;
  new_state: CaseState;
  payload: Record<string, unknown>;
}

/**
 * Local route record — written to apex.collection.routes outbox once per
 * routed case. Captures the routing decision context so a downstream sync
 * to the bank's Collection module can be replayed.
 */
export interface CollectionRouteEvent {
  route_id: string;
  case_id: string;
  alert_id: string;
  customer_id: string;
  severity: Severity;
  loan_id: string | null;
  routed_at: string;
  reason: string;
  source_event_id: string;
}

/** Inbound shape for /collection/callback. */
export interface CollectionCallbackInput {
  case_id: string;
  status: Outcome;
  note?: string | null;
}
