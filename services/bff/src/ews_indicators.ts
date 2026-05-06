// services/bff/src/ews_indicators.ts
//
// EWS rules engine — indicator catalog (EWS-1).
//
// Disjoint by ID prefix from the regulatory-svc catalog (which uses
// FIN- / BEH- / TXN- / CRD-) and from the BFF BIL scoring catalog
// (POL- / CUS-INS- / AGT- / CLM- / OPS-) so the two-rules-engine
// world doesn't accidentally cross-resolve indicators.
//
// 15 indicators covering the 10 brief-mandated rules + 5 supporting
// signals. Each indicator declares its domain, type, refresh
// frequency, and natural range — the SPA builder uses the type +
// range to pick the right input control (slider / number / dropdown).

export type EwsIndicatorDomain =
  | 'credit'
  | 'insurance'
  | 'fraud'
  | 'kyc'
  | 'transaction'
  | 'agent'
  | 'operational'
  | 'portfolio'
  | 'behaviour'
  | 'risk_score';

export type EwsIndicatorType =
  | 'count'
  | 'percent'
  | 'ratio'
  | 'days'
  | 'amount'
  | 'flag'
  | 'enum';

export type EwsIndicatorRefresh = 'realtime' | 'daily' | 'monthly';

export interface EwsIndicator {
  /** Stable id, prefixed `EWS-<DOMAIN>-NNN`. */
  id: string;
  /** Snake-case key the rule DSL uses for `condition.field`. */
  name: string;
  /** Operator-friendly label for the SPA. */
  display_name: string;
  domain: EwsIndicatorDomain;
  type: EwsIndicatorType;
  description: string;
  refresh: EwsIndicatorRefresh;
  /** [min, max] inclusive bounds — caller's value MUST fall here. */
  range?: { min: number; max: number };
  /** Required for `enum` type indicators. */
  enum_values?: string[];
  /** Free-form unit (e.g. 'INR', 'count', '%'). */
  unit?: string;
}

export const EWS_INDICATOR_CATALOG: Record<string, EwsIndicator> = {
  // ── Credit (RULE_CREDIT_001) ────────────────────────────────────────
  emi_bounce_count_90d: {
    id: 'EWS-CRD-001',
    name: 'emi_bounce_count_90d',
    display_name: 'EMI bounces in last 90 days',
    domain: 'credit',
    type: 'count',
    description: 'Number of EMI debits returned unsuccessful in the rolling 90-day window.',
    refresh: 'daily',
    range: { min: 0, max: 100 },
    unit: 'count',
  },

  internal_dpd_current: {
    id: 'EWS-CRD-002',
    name: 'internal_dpd_current',
    display_name: 'Days past due (current)',
    domain: 'credit',
    type: 'days',
    description: 'Days past due on any active loan with the lender.',
    refresh: 'daily',
    range: { min: 0, max: 720 },
    unit: 'days',
  },

  // ── Insurance (RULE_LAPSE_001, RULE_FRAUD_001) ──────────────────────
  premium_overdue_days: {
    id: 'EWS-INS-001',
    name: 'premium_overdue_days',
    display_name: 'Premium overdue (days)',
    domain: 'insurance',
    type: 'days',
    description: 'Days since the most recent premium due date passed without payment.',
    refresh: 'daily',
    range: { min: 0, max: 365 },
    unit: 'days',
  },

  claim_to_avg_ratio: {
    id: 'EWS-INS-002',
    name: 'claim_to_avg_ratio',
    display_name: 'Claim amount × avg-claim',
    domain: 'fraud',
    type: 'ratio',
    description: 'Claim amount divided by the rolling 12-month average claim for this customer.',
    refresh: 'realtime',
    range: { min: 0, max: 50 },
  },

  policy_age_days_at_claim: {
    id: 'EWS-INS-003',
    name: 'policy_age_days_at_claim',
    display_name: 'Policy age at claim (days)',
    domain: 'fraud',
    type: 'days',
    description: 'Number of days between policy inception and the claim date.',
    refresh: 'realtime',
    range: { min: 0, max: 36500 },
    unit: 'days',
  },

  // ── KYC (RULE_KYC_001) ──────────────────────────────────────────────
  kyc_doc_expiry_days: {
    id: 'EWS-KYC-001',
    name: 'kyc_doc_expiry_days',
    display_name: 'KYC document expired (days)',
    domain: 'kyc',
    type: 'days',
    description:
      'Days since the customer’s KYC document expired (negative when still valid). EWS namespace mirror of regulatory-svc BEH-006.',
    refresh: 'daily',
    range: { min: -3650, max: 3650 },
    unit: 'days',
  },

  // ── Transaction (RULE_TXN_001) ──────────────────────────────────────
  txn_amount_to_avg_ratio: {
    id: 'EWS-TXN-001',
    name: 'txn_amount_to_avg_ratio',
    display_name: 'Transaction × avg-txn',
    domain: 'transaction',
    type: 'ratio',
    description: 'Single transaction amount divided by the customer’s 90-day average transaction.',
    refresh: 'realtime',
    range: { min: 0, max: 1000 },
  },

  // ── Agent (RULE_AGENT_001) ──────────────────────────────────────────
  agent_portfolio_lapse_pct: {
    id: 'EWS-AGT-001',
    name: 'agent_portfolio_lapse_pct',
    display_name: 'Agent portfolio lapse (%)',
    domain: 'agent',
    type: 'percent',
    description:
      'Share of policies sold by an agent that have lapsed in the rolling 12-month window.',
    refresh: 'monthly',
    range: { min: 0, max: 100 },
    unit: '%',
  },

  // ── Operational (RULE_OPS_001) ──────────────────────────────────────
  login_new_country_24h: {
    id: 'EWS-OPS-001',
    name: 'login_new_country_24h',
    display_name: 'Login from new country (24h)',
    domain: 'operational',
    type: 'flag',
    description:
      'Set to 1 when a successful login originates from a country the customer has never logged in from before, evaluated over the previous 24 hours.',
    refresh: 'realtime',
    range: { min: 0, max: 1 },
  },

  device_change_24h_count: {
    id: 'EWS-OPS-002',
    name: 'device_change_24h_count',
    display_name: 'Device fingerprint changes (24h)',
    domain: 'operational',
    type: 'count',
    description: 'Distinct device fingerprints logging in over the previous 24 hours.',
    refresh: 'realtime',
    range: { min: 0, max: 100 },
    unit: 'count',
  },

  // ── Portfolio (RULE_CONC_001) ───────────────────────────────────────
  customer_exposure_pct_of_portfolio: {
    id: 'EWS-PRT-001',
    name: 'customer_exposure_pct_of_portfolio',
    display_name: 'Customer share of portfolio (%)',
    domain: 'portfolio',
    type: 'percent',
    description:
      'Single customer’s outstanding exposure expressed as a share of the lender’s total portfolio.',
    refresh: 'daily',
    range: { min: 0, max: 100 },
    unit: '%',
  },

  // ── Behaviour (RULE_BEHAV_001) ──────────────────────────────────────
  txn_freq_drop_30d_pct: {
    id: 'EWS-BHV-001',
    name: 'txn_freq_drop_30d_pct',
    display_name: 'Transaction frequency drop (30d, %)',
    domain: 'behaviour',
    type: 'percent',
    description:
      'Drop in transaction frequency comparing the trailing 30 days to the prior 30 days, expressed as a positive percentage (50 = halved).',
    refresh: 'daily',
    range: { min: -100, max: 100 },
    unit: '%',
  },

  // ── Risk score (RULE_SCORE_001) ─────────────────────────────────────
  risk_score_delta_7d: {
    id: 'EWS-RSK-001',
    name: 'risk_score_delta_7d',
    display_name: 'Risk score delta (7d)',
    domain: 'risk_score',
    type: 'count',
    description:
      'Change in BIL risk score over the last 7 days (positive = score went up = riskier).',
    refresh: 'daily',
    range: { min: -100, max: 100 },
  },

  // ── Supporting indicators (used by composite rules + future seed) ───
  ifrs9_stage_movement: {
    id: 'EWS-CRD-003',
    name: 'ifrs9_stage_movement',
    display_name: 'IFRS9 stage movement',
    domain: 'credit',
    type: 'enum',
    description: 'Change in IFRS9 stage classification (S1→S2, S2→S3, etc.).',
    refresh: 'monthly',
    enum_values: ['none', 'S1_to_S2', 'S2_to_S3', 'S3_to_S2', 'S2_to_S1'],
  },

  bureau_score_drop_60d: {
    id: 'EWS-RSK-002',
    name: 'bureau_score_drop_60d',
    display_name: 'External bureau score drop (60d)',
    domain: 'risk_score',
    type: 'count',
    description: 'Drop in external bureau score over the trailing 60 days.',
    refresh: 'monthly',
    range: { min: -300, max: 300 },
  },
};

/** Look up an indicator by its DSL name. */
export function getEwsIndicator(name: string): EwsIndicator | null {
  return EWS_INDICATOR_CATALOG[name] ?? null;
}

/** Returns true iff the supplied name is a known EWS indicator. */
export function isEwsIndicatorName(name: unknown): name is string {
  return typeof name === 'string' && name in EWS_INDICATOR_CATALOG;
}

/** Catalog count — useful for tests + sanity checks. */
export const EWS_INDICATOR_COUNT = Object.keys(EWS_INDICATOR_CATALOG).length;

/** Distinct domains present in the catalog. */
export function listEwsIndicatorDomains(): EwsIndicatorDomain[] {
  const set = new Set<EwsIndicatorDomain>();
  for (const ind of Object.values(EWS_INDICATOR_CATALOG)) set.add(ind.domain);
  return [...set].sort();
}
