// mobile/src/types.ts
//
// Shared response shapes — mirror the BFF envelope contract from T4.24.
// Kept slim — the mobile shell only needs the fields the 3 screens
// actually render.

/** T4.24 envelope shape — every /v1/* response is wrapped in this. */
export interface EnvelopeHeader {
  status: 'SUCCESS' | 'ERROR';
  code: string;
  message: string;
  requestId?: string;
  timestamp: string;
}

export interface Envelope<T> {
  header: EnvelopeHeader;
  body?: T;
  error?: {
    code: string;
    message: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    detail?: Record<string, unknown>;
  };
}

/** Mirrors `Alert` shape from `services/bff/src/types.ts`. */
export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface MobileAlert {
  id: string;
  customer: { id: string; name: string };
  rule: { id: string; name: string };
  severity: AlertSeverity;
  indicators: string[];
  created_at: string;
  age_min: number;
  status?: 'open' | 'acknowledged' | 'closed';
  /** Computed criticality score per T4.9 — drives mobile sort order. */
  criticality_score?: number;
}

/** Mirrors `CaseSummary` + `Case` shape. */
export type CaseState =
  | 'open'
  | 'assigned'
  | 'in_action'
  | 'monitored'
  | 'closed'
  | 'reopened';

export interface MobileCase {
  id: string;
  customer: { id: string; name: string };
  state: CaseState;
  outcome: 'cured' | 'cured_temp' | 'defaulted' | null;
  assignee: string | null;
  created_at: string;
  origin_alert_id: string | null;
  loan_id: string | null;
  sla_status?: 'on_track' | 'approaching' | 'breached' | 'closed';
}

/** Investigation step from M9.1 + M9.2 checklist surface. */
export interface MobileInvestigationStep {
  step_id: string;
  name: string;
  completed: boolean;
  completed_at: string | null;
  completed_by: string | null;
  required: boolean;
}

export interface MobileGpsCoords {
  lat: number;
  lng: number;
  accuracy_m?: number;
}

/** Mirrors `CaseAction` + the case-action sink contract. */
export interface MobileCaseAction {
  case_id: string;
  kind: 'call' | 'visit' | 'sms' | 'email' | 'note';
  officer_id: string;
  outcome_note?: string;
  gps?: MobileGpsCoords;
}
