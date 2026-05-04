// services/bff/src/rule_templates.ts
//
// T6 M5.1 — BIL rule template library.
//
// Module 5 (Rule Engine) had T4.7 surface — full CRUD + state-machine
// + backtest + performance. What was missing for BIL onboarding: a
// starter library of pre-built rule templates that admins can clone
// to bootstrap a tenant configuration without writing rules from
// scratch.
//
// Each template captures the BIL operational intent in
// condition_pseudocode (the same form the rule editor uses) plus
// metadata for the UI: vertical (banking/insurance/both), category
// (risk_monitoring / fraud_detection / compliance / operational /
// underwriting), recommended severity + actions, and a list of
// supporting indicators that drive the rule's evaluation.
//
// Why platform-wide (not per-tenant): templates are the platform's
// best-practice library — every BIL tenant should see the same set.
// Per-tenant cloning + customisation happens via the existing
// `/v1/rules` POST endpoint (T4.7).

// ─── Public types ──────────────────────────────────────────────────────

export type RuleTemplateVertical = 'banking' | 'insurance' | 'both';

export type RuleTemplateCategory =
  | 'risk_monitoring'
  | 'fraud_detection'
  | 'compliance'
  | 'operational'
  | 'underwriting';

export type RecommendedSeverity = 'critical' | 'high' | 'medium' | 'low';

export type RecommendedAction =
  | 'open_case'
  | 'notify_supervisor'
  | 'pause_disbursement'
  | 'request_documents'
  | 'flag_for_review'
  | 'auto_decline';

export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  vertical: RuleTemplateVertical;
  category: RuleTemplateCategory;
  /** Pseudocode of the rule's predicate. Same form the editor uses
   *  when admins clone the template. */
  condition_pseudocode: string;
  recommended_severity: RecommendedSeverity;
  recommended_actions: RecommendedAction[];
  /** Indicator ids the rule references (banking FIN-/BEH-/TXN-/CRD- and/
   *  or insurance POL-/CUS-INS-/AGT-/CLM-/OPS- per the indicator
   *  catalogues). */
  supporting_indicators: string[];
  /** Source citation in the BIL pitch / Banking API doc — useful audit. */
  source_doc: string;
}

export class RuleTemplateError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RuleTemplateError';
  }
}

// ─── Seed library ──────────────────────────────────────────────────────
//
// 12 BIL templates spanning the 5 categories and both verticals.
// Mirrors the use-cases the BIL pitch deck §§9-12 calls out.

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  // risk_monitoring
  {
    id: 'tpl_dpd_30_60',
    name: 'DPD 30-60 watchlist',
    description: 'Flag accounts where days-past-due crosses 30 but is still under 60',
    vertical: 'banking',
    category: 'risk_monitoring',
    condition_pseudocode: 'dpd >= 30 AND dpd < 60',
    recommended_severity: 'medium',
    recommended_actions: ['flag_for_review', 'notify_supervisor'],
    supporting_indicators: ['FIN-001'],
    source_doc: 'Banking API §6.1',
  },
  {
    id: 'tpl_utilisation_spike',
    name: 'Credit utilisation spike',
    description: 'Sudden jump in utilisation indicates near-term stress',
    vertical: 'banking',
    category: 'risk_monitoring',
    condition_pseudocode: 'utilisation_pct - utilisation_pct_30d_ago >= 25',
    recommended_severity: 'high',
    recommended_actions: ['flag_for_review', 'notify_supervisor', 'open_case'],
    supporting_indicators: ['FIN-002', 'BEH-001'],
    source_doc: 'Banking API §6.2',
  },
  {
    id: 'tpl_lapse_imminent',
    name: 'Imminent policy lapse',
    description: 'Policy will lapse within 14 days unless premium is paid',
    vertical: 'insurance',
    category: 'risk_monitoring',
    condition_pseudocode: 'days_to_lapse <= 14 AND premium_paid_current_period = false',
    recommended_severity: 'medium',
    recommended_actions: ['notify_supervisor', 'request_documents'],
    supporting_indicators: ['POL-002', 'CUS-INS-001'],
    source_doc: 'BIL pitch §10',
  },

  // fraud_detection
  {
    id: 'tpl_repeat_claim_180d',
    name: 'Repeat claim within 180 days',
    description: 'Same customer files a claim of identical reason within 180 days',
    vertical: 'insurance',
    category: 'fraud_detection',
    condition_pseudocode:
      'count(claims WHERE reason_code = current.reason_code AND filed_at > now() - 180d) >= 2',
    recommended_severity: 'high',
    recommended_actions: ['open_case', 'flag_for_review'],
    supporting_indicators: ['CLM-001', 'CLM-003'],
    source_doc: 'BIL pitch §9',
  },
  {
    id: 'tpl_amount_deviation_30pct',
    name: 'Claim amount deviation > 30%',
    description: 'Claim amount deviates >30% from the typical settlement for that reason code',
    vertical: 'insurance',
    category: 'fraud_detection',
    condition_pseudocode: 'abs(claim_amount - reason_avg_amount) / reason_avg_amount >= 0.30',
    recommended_severity: 'high',
    recommended_actions: ['open_case', 'request_documents'],
    supporting_indicators: ['CLM-002'],
    source_doc: 'BIL pitch §9',
  },
  {
    id: 'tpl_velocity_24h',
    name: 'Transaction velocity spike',
    description: 'Customer makes >10x their 30-day-avg transactions in a 24h window',
    vertical: 'banking',
    category: 'fraud_detection',
    condition_pseudocode: 'tx_count_24h >= 10 * tx_count_30d_avg',
    recommended_severity: 'critical',
    recommended_actions: ['pause_disbursement', 'open_case', 'notify_supervisor'],
    supporting_indicators: ['TXN-001', 'TXN-002'],
    source_doc: 'Banking API §6.4',
  },

  // compliance
  {
    id: 'tpl_aml_high_severity_open',
    name: 'High-severity AML match unresolved',
    description: 'Customer has an open high-severity AML match older than 24h — RBI escalation',
    vertical: 'both',
    category: 'compliance',
    condition_pseudocode:
      "exists(aml_match WHERE severity = 'high' AND status = 'open' AND matched_at < now() - 24h)",
    recommended_severity: 'critical',
    recommended_actions: ['open_case', 'notify_supervisor', 'pause_disbursement'],
    supporting_indicators: [],
    source_doc: 'Banking API §11 / IRDAI Form-K',
  },
  {
    id: 'tpl_kyc_expired',
    name: 'KYC documents expired',
    description: 'Customer KYC has expired or is within 30 days of expiry',
    vertical: 'both',
    category: 'compliance',
    condition_pseudocode: 'kyc_expiry_date <= now() + 30d',
    recommended_severity: 'medium',
    recommended_actions: ['request_documents', 'flag_for_review'],
    supporting_indicators: ['CUS-INS-002'],
    source_doc: 'BIL pitch §12 / RBI KYC',
  },

  // operational
  {
    id: 'tpl_sla_breach_red',
    name: 'Red-class SLA breach',
    description: 'A Red-classified alert has been open longer than its 4h SLA without escalation',
    vertical: 'both',
    category: 'operational',
    condition_pseudocode:
      "alert.bil_class = 'red' AND age_hours >= 4 AND escalated_at IS NULL",
    recommended_severity: 'critical',
    recommended_actions: ['notify_supervisor', 'open_case'],
    supporting_indicators: [],
    source_doc: 'BIL pitch §11',
  },
  {
    id: 'tpl_data_modification_anomalous',
    name: 'Anomalous data modifications',
    description: 'Operator records >5x their 30-day-avg modifications in a 7-day window',
    vertical: 'both',
    category: 'operational',
    condition_pseudocode: 'mod_count_7d >= 5 * mod_count_30d_avg',
    recommended_severity: 'high',
    recommended_actions: ['flag_for_review', 'notify_supervisor'],
    supporting_indicators: ['OPS-001', 'OPS-003'],
    source_doc: 'BIL pitch §11',
  },

  // underwriting
  {
    id: 'tpl_uw_delay_p95',
    name: 'Underwriting p95 delay breach',
    description: 'Underwriting decision time exceeds the 95th percentile by 50%',
    vertical: 'insurance',
    category: 'underwriting',
    condition_pseudocode: 'uw_delay_hours > 1.5 * uw_p95_delay_hours',
    recommended_severity: 'medium',
    recommended_actions: ['notify_supervisor', 'flag_for_review'],
    supporting_indicators: ['OPS-002'],
    source_doc: 'BIL pitch §10',
  },
  {
    id: 'tpl_high_risk_proposal',
    name: 'High-risk proposal flag',
    description: 'New proposal hits >2 risk factors at submission',
    vertical: 'insurance',
    category: 'underwriting',
    condition_pseudocode: 'count(risk_factors_present) >= 3',
    recommended_severity: 'high',
    recommended_actions: ['flag_for_review', 'request_documents'],
    supporting_indicators: ['POL-001', 'CUS-INS-001'],
    source_doc: 'BIL pitch §10',
  },
];

const TEMPLATES_BY_ID = new Map<string, RuleTemplate>(RULE_TEMPLATES.map((t) => [t.id, t]));

const VALID_CATEGORIES: RuleTemplateCategory[] = [
  'risk_monitoring',
  'fraud_detection',
  'compliance',
  'operational',
  'underwriting',
];

const VALID_VERTICALS: RuleTemplateVertical[] = ['banking', 'insurance', 'both'];

export function isRuleTemplateCategory(s: unknown): s is RuleTemplateCategory {
  return typeof s === 'string' && VALID_CATEGORIES.includes(s as RuleTemplateCategory);
}
export function isRuleTemplateVertical(s: unknown): s is RuleTemplateVertical {
  return typeof s === 'string' && VALID_VERTICALS.includes(s as RuleTemplateVertical);
}

/** All distinct categories in canonical order. */
export function listCategories(): RuleTemplateCategory[] {
  return [...VALID_CATEGORIES];
}

export interface TemplateFilter {
  vertical?: RuleTemplateVertical;
  category?: RuleTemplateCategory;
}

/**
 * List templates, optionally filtered. The `vertical` filter is
 * inclusive — passing 'banking' returns templates with vertical
 * 'banking' OR 'both' (cross-vertical templates apply to either).
 * Passing 'insurance' likewise returns 'insurance' + 'both'. Passing
 * 'both' returns ONLY the cross-vertical templates (the explicit
 * "give me only the cross-cutting ones" query).
 */
export function listTemplates(filter: TemplateFilter = {}): RuleTemplate[] {
  return RULE_TEMPLATES.filter((t) => {
    if (filter.category && t.category !== filter.category) return false;
    if (filter.vertical) {
      if (filter.vertical === 'both') {
        if (t.vertical !== 'both') return false;
      } else {
        if (t.vertical !== filter.vertical && t.vertical !== 'both') return false;
      }
    }
    return true;
  });
}

export function getTemplate(id: string): RuleTemplate | null {
  return TEMPLATES_BY_ID.get(id) ?? null;
}
