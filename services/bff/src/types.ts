// services/bff/src/types.ts
//
// Two contracts touch this service: the canonical alert event coming in
// (apex.regulatory.events.v2) and the list-row going out (web's
// AlertListResponse). We mirror both shapes exactly here — no cross-module
// imports — so the BFF can be deployed independently and the producer
// (regulatory-svc/alerts) and consumer (web/) can each evolve their types
// without dragging us along.

/** Wire severity from the canonical envelope (UPPERCASE per v2 schema). */
export type WireSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** UI-side severity (lowercase). */
export type UiSeverity = 'low' | 'medium' | 'high' | 'critical';

/** Canonical alert envelope (subset of fields the BFF needs). */
export interface CanonicalAlert {
  alert_id: string;
  raised_at: string;
  customer_id: string;
  loan_id?: string | null;
  severity: WireSeverity;
  rule_id: string;
  indicators_fired: string[];
  reason_summary?: string;
  trace_id?: string;
  // We don't read pd, scoring, or rule_firings — the list view doesn't
  // surface them. They remain in the wire payload untouched.
}

/** UI list-row shape — must match web/src/lib/api.ts:Alert exactly. */
export interface AlertRow {
  id: string;
  severity: UiSeverity;
  customer: { id: string; name: string };
  rule: { id: string; name: string };
  indicators: string[];
  age_min: number;
  assignee?: string | null;
  created_at: string;
  /** Fields the SPA's prioritization formula uses (web/src/lib/criticality.ts).
   *  Populated by mapAlertList so the queue can rank + dedup. */
  confidence: number;
  customer_exposure_kes: number;
  criticality_score: number;
  linked_alert_ids: string[];
  /** Phase 4 — acknowledgement state, joined from the M8.3 AlertAckStore
   *  by alert id. Decorated by listAlerts; absent on the raw mapping. */
  acknowledged?: boolean;
}

export interface AlertListResponse {
  items: AlertRow[];
  total: number;
}

export interface CustomerLookup {
  [customer_id: string]: { name: string; exposure_kes?: number };
}

export interface RuleLookup {
  [rule_id: string]: { name: string };
}

export interface AssigneeLookup {
  [alert_id: string]: string;
}

export interface Lookups {
  customers: CustomerLookup;
  rules: RuleLookup;
  /**
   * Alert assignment is owned by the SmartQueue in regulatory-svc/alerts.
   * The BFF reads this from a thin /alerts/:id/assignee endpoint or, for
   * the prototype, from a snapshot map. Entries are best-effort — missing
   * assignees fall back to `null`.
   */
  assignees?: AssigneeLookup;
}
