// services/bff/src/aml_alert_correlation.ts
//
// T3.3.1 — AML ↔ EWS bidirectional alert correlation.
//
// Layered over the M14.3 AmlAdapter (services/bff/src/integrations/aml.ts)
// + the existing alert/case/investigation surfaces. Closes the "linked
// AML alerts" gap surfaced by EWS.docx §3.5 + spec §3.3.
//
// Two correlation directions:
//   forward:  correlateAmlWithEws(aml_match_id, tenant)
//             — for a given AML match, list linked EWS alerts + cases
//             + investigations on the same customer + AML severity vs
//             EWS alert criticality view.
//   reverse:  correlateEwsWithAml(alert_id, tenant)
//             — for a given EWS alert, list AML matches on the same
//             customer + severity comparison.
//
// Pure composer — no schema changes, no new event types. Reads from
// the existing AmlAdapter + the AlertSource / CaseStore / Investigation
// surfaces via lightweight interfaces so the test path can inject stubs.

import type { AmlAdapter, AmlMatch, AmlMatchSeverity } from './integrations/aml';

// ─── Cross-module abstractions ───────────────────────────────────────
//
// We DON'T want to import the full Alert / Case / Investigation
// types from their respective stores because that would create a hard
// dependency loop. Instead we define lightweight read-only interfaces
// the correlator can call against, and adapter shims in the route
// handler bridge to the actual stores.

export interface AlertLite {
  id: string;
  customer_id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status?: string;
  created_at: string;
  criticality_score?: number;
  rule_id?: string;
  rule_name?: string;
}

export interface CaseLite {
  case_id: string;
  customer_id: string;
  state: string;
  created_at: string;
  assignee_username?: string | null;
}

export interface InvestigationLite {
  investigation_id: string;
  customer_id: string;
  status: string;
  case_id?: string;
  opened_at: string;
}

export interface CorrelationSources {
  /** Returns all EWS alerts for the customer in newest-first order. */
  listAlertsForCustomer(tenant_id: string, customer_id: string): Promise<AlertLite[]>;
  /** Returns all cases for the customer. */
  listCasesForCustomer(tenant_id: string, customer_id: string): Promise<CaseLite[]>;
  /** Returns investigations for the customer. */
  listInvestigationsForCustomer(
    tenant_id: string,
    customer_id: string,
  ): Promise<InvestigationLite[]>;
}

// ─── Output shapes ──────────────────────────────────────────────────

export interface AmlEwsCorrelation {
  tenant_id: string;
  generated_at: string;
  aml_match: AmlMatch;
  linked_alerts: AlertLite[];
  linked_cases: CaseLite[];
  linked_investigations: InvestigationLite[];
  /** Highest EWS alert severity for the same customer; null when none. */
  peak_alert_severity: AlertLite['severity'] | null;
  /** True iff AML severity = high AND any linked alert severity = critical/high. */
  bidirectional_high_flag: boolean;
  /** Recommended action surfaced for the SPA's correlation panel. */
  recommended_action: 'escalate_case' | 'open_investigation' | 'monitor' | 'no_action';
}

export interface EwsAmlCorrelation {
  tenant_id: string;
  generated_at: string;
  alert: AlertLite;
  aml_matches: AmlMatch[];
  peak_aml_severity: AmlMatchSeverity | null;
  /** True iff any AML match has status='open' AND severity='high'. */
  open_aml_high_flag: boolean;
  recommended_action: 'sanctions_review' | 'kyc_refresh' | 'monitor' | 'no_action';
}

export class CorrelationError extends Error {
  override name = 'CorrelationError';
  constructor(public code: 'invalid_input' | 'unknown_match' | 'unknown_alert', message: string) {
    super(message);
  }
}

// ─── Forward correlation: AML → EWS ──────────────────────────────────

export async function correlateAmlWithEws(
  aml_match_id: string,
  tenant_id: string,
  adapter: AmlAdapter,
  sources: CorrelationSources,
  now: Date,
): Promise<AmlEwsCorrelation> {
  if (!tenant_id) throw new CorrelationError('invalid_input', 'tenant_id required');
  if (!aml_match_id) throw new CorrelationError('invalid_input', 'aml_match_id required');

  const aml_match = await adapter.getMatch(tenant_id, aml_match_id);
  if (!aml_match) {
    throw new CorrelationError('unknown_match', `unknown AML match: ${aml_match_id}`);
  }

  const [linked_alerts, linked_cases, linked_investigations] = await Promise.all([
    sources.listAlertsForCustomer(tenant_id, aml_match.customer_id),
    sources.listCasesForCustomer(tenant_id, aml_match.customer_id),
    sources.listInvestigationsForCustomer(tenant_id, aml_match.customer_id),
  ]);

  const peak_alert_severity = peakAlertSeverity(linked_alerts);
  const bidirectional_high_flag =
    aml_match.severity === 'high' &&
    (peak_alert_severity === 'critical' || peak_alert_severity === 'high');

  const recommended_action = recommendAmlAction({
    aml: aml_match,
    peak_alert_severity,
    has_open_case: linked_cases.some((c) => !TERMINAL_CASE_STATES.has(c.state)),
    has_open_investigation: linked_investigations.some(
      (i) => i.status !== 'closed',
    ),
  });

  return {
    tenant_id,
    generated_at: now.toISOString(),
    aml_match,
    linked_alerts,
    linked_cases,
    linked_investigations,
    peak_alert_severity,
    bidirectional_high_flag,
    recommended_action,
  };
}

// ─── Reverse correlation: EWS → AML ──────────────────────────────────

export async function correlateEwsWithAml(
  alert_id: string,
  tenant_id: string,
  alertLookup: (
    tenant_id: string,
    alert_id: string,
  ) => Promise<AlertLite | null>,
  adapter: AmlAdapter,
  now: Date,
): Promise<EwsAmlCorrelation> {
  if (!tenant_id) throw new CorrelationError('invalid_input', 'tenant_id required');
  if (!alert_id) throw new CorrelationError('invalid_input', 'alert_id required');

  const alert = await alertLookup(tenant_id, alert_id);
  if (!alert) throw new CorrelationError('unknown_alert', `unknown alert: ${alert_id}`);

  const aml_matches = await adapter.listMatches(tenant_id, alert.customer_id);
  const peak_aml_severity = peakAmlSeverity(aml_matches);
  const open_aml_high_flag = aml_matches.some(
    (m) => m.status === 'open' && m.severity === 'high',
  );

  const recommended_action = recommendEwsAction({
    alert,
    aml_matches,
    open_aml_high_flag,
  });

  return {
    tenant_id,
    generated_at: now.toISOString(),
    alert,
    aml_matches,
    peak_aml_severity,
    open_aml_high_flag,
    recommended_action,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

const ALERT_SEVERITY_RANK: Record<AlertLite['severity'], number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const AML_SEVERITY_RANK: Record<AmlMatchSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const TERMINAL_CASE_STATES = new Set(['closed', 'resolved']);

export function peakAlertSeverity(alerts: AlertLite[]): AlertLite['severity'] | null {
  if (alerts.length === 0) return null;
  let peak: AlertLite['severity'] = alerts[0].severity;
  for (const a of alerts) {
    if (ALERT_SEVERITY_RANK[a.severity] > ALERT_SEVERITY_RANK[peak]) peak = a.severity;
  }
  return peak;
}

export function peakAmlSeverity(matches: AmlMatch[]): AmlMatchSeverity | null {
  if (matches.length === 0) return null;
  let peak: AmlMatchSeverity = matches[0].severity;
  for (const m of matches) {
    if (AML_SEVERITY_RANK[m.severity] > AML_SEVERITY_RANK[peak]) peak = m.severity;
  }
  return peak;
}

export function recommendAmlAction(input: {
  aml: AmlMatch;
  peak_alert_severity: AlertLite['severity'] | null;
  has_open_case: boolean;
  has_open_investigation: boolean;
}): AmlEwsCorrelation['recommended_action'] {
  const { aml, peak_alert_severity, has_open_case, has_open_investigation } = input;
  // High AML severity + critical/high EWS alert → escalate.
  if (
    aml.severity === 'high' &&
    (peak_alert_severity === 'critical' || peak_alert_severity === 'high')
  ) {
    return 'escalate_case';
  }
  // High AML severity, no investigation yet → open one.
  if (aml.severity === 'high' && !has_open_investigation) return 'open_investigation';
  // Open case OR open investigation → monitor (already being handled).
  if (has_open_case || has_open_investigation) return 'monitor';
  // Low AML severity, no linked surfaces → no action.
  if (aml.severity === 'low' && peak_alert_severity === null) return 'no_action';
  return 'monitor';
}

export function recommendEwsAction(input: {
  alert: AlertLite;
  aml_matches: AmlMatch[];
  open_aml_high_flag: boolean;
}): EwsAmlCorrelation['recommended_action'] {
  const { alert, open_aml_high_flag, aml_matches } = input;
  // Sanctions hit + critical alert → sanctions_review.
  const hasSanctionsHit = aml_matches.some(
    (m) => m.match_type === 'sanctions' && m.status === 'open',
  );
  if (hasSanctionsHit) return 'sanctions_review';
  // High AML + medium+ alert → kyc_refresh.
  if (open_aml_high_flag && ALERT_SEVERITY_RANK[alert.severity] >= 2) {
    return 'kyc_refresh';
  }
  if (aml_matches.length > 0) return 'monitor';
  return 'no_action';
}
