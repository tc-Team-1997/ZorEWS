// services/collection-adapter/src/router.ts
//
// Pure routing decision. Given a case.created event (and the original
// alert's severity + loan_id, which the cases service includes in the
// event's `payload`), decide whether to escalate to Collection.
//
// Policy:
//   - severity ∈ {critical, high}                       → route ("severity")
//   - severity = medium AND loan_id present             → route ("loan_default_track")
//   - otherwise                                          → no-route

import type { CaseEvent, Severity } from './types';

export interface RouteDecision {
  route: boolean;
  reason: string;
  severity: Severity;
  loan_id: string | null;
}

const VALID_SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

export function decideRoute(event: CaseEvent): RouteDecision {
  // Routing only fires on case creation; later transitions don't trigger
  // Collection (they're handled by /collection/callback going the other way).
  if (event.event_type !== 'case.created') {
    return {
      route: false,
      reason: 'not_a_creation_event',
      severity: 'low',
      loan_id: null,
    };
  }

  // Cases service includes severity in payload on create (see service.ts).
  const sevRaw = (event.payload?.severity as string | undefined) ?? 'low';
  const severity: Severity = (VALID_SEVERITIES as string[]).includes(sevRaw)
    ? (sevRaw as Severity)
    : 'low';
  const loan_id =
    typeof event.payload?.loan_id === 'string' ? (event.payload.loan_id as string) : null;

  if (severity === 'critical' || severity === 'high') {
    return { route: true, reason: 'severity', severity, loan_id };
  }
  if (severity === 'medium' && loan_id) {
    return { route: true, reason: 'loan_default_track', severity, loan_id };
  }
  return { route: false, reason: 'below_threshold', severity, loan_id };
}
