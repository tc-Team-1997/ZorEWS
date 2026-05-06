// services/bff/src/ews_rules_seed.ts
//
// EWS-4 — 10 brief-mandated default rules.
//
// Each entry maps directly to one of the rules in the original
// brief (RULE_CREDIT_001 ... RULE_SCORE_001). Field shapes match
// validateEwsRule's expectations — these are the canonical
// reference rules new tenants get bootstrapped with.

import {
  type AlertSeverity,
  type EwsCondition,
  type EwsLogic,
  type EwsRuleCategory,
  type EwsRuleInput,
  type EwsRuleStore,
} from './ews_rules';

interface SeedDef {
  rule_id: string;
  name: string;
  category: EwsRuleCategory;
  description: string;
  conditions: EwsCondition[];
  logic: EwsLogic;
  alert_severity: AlertSeverity;
  weight: number;
  recommended_action: string;
}

export const EWS_DEFAULT_RULES: ReadonlyArray<SeedDef> = [
  {
    rule_id: 'RULE_CREDIT_001',
    name: 'High EMI Bounce Risk',
    category: 'credit',
    description:
      '3 or more EMI bounces in the last 90 days indicates the customer can no longer service debt — escalate to RM within 24 hours.',
    conditions: [{ field: 'emi_bounce_count_90d', operator: '>=', value: 3 }],
    logic: 'AND',
    alert_severity: 'RED',
    weight: 25,
    recommended_action: 'Pause further disbursement; assign to RM for 24-hour callback.',
  },
  {
    rule_id: 'RULE_LAPSE_001',
    name: 'Premium Overdue',
    category: 'lapse',
    description:
      'Premium overdue beyond 15 days triggers grace-period outreach to prevent policy lapse.',
    conditions: [{ field: 'premium_overdue_days', operator: '>', value: 15 }],
    logic: 'AND',
    alert_severity: 'ORANGE',
    weight: 20,
    recommended_action: 'Send grace-period reminder; agent to call customer within 48 hours.',
  },
  {
    rule_id: 'RULE_FRAUD_001',
    name: 'High-Claim Early-Policy Fraud Signal',
    category: 'fraud',
    description:
      'Claim more than 3× the customer’s rolling-12-month average AND filed within 30 days of policy inception suggests claim-loading fraud.',
    conditions: [
      { field: 'claim_to_avg_ratio', operator: '>', value: 3 },
      { field: 'policy_age_days_at_claim', operator: '<', value: 30 },
    ],
    logic: 'AND',
    alert_severity: 'RED',
    weight: 30,
    recommended_action: 'Hold payout; route to fraud investigations for documentary evidence review.',
  },
  {
    rule_id: 'RULE_KYC_001',
    name: 'KYC Document Expired',
    category: 'kyc',
    description:
      'KYC document expired more than 30 days ago — operator must re-verify before any disbursement or payout.',
    conditions: [{ field: 'kyc_doc_expiry_days', operator: '>', value: 30 }],
    logic: 'AND',
    alert_severity: 'YELLOW',
    weight: 10,
    recommended_action: 'Request fresh KYC docs; block transactions > 50k until re-verified.',
  },
  {
    rule_id: 'RULE_TXN_001',
    name: 'Transaction Spike',
    category: 'transaction',
    description:
      'A single transaction more than 10× the customer’s 90-day rolling average is a known fraud / mule-account signal.',
    conditions: [{ field: 'txn_amount_to_avg_ratio', operator: '>', value: 10 }],
    logic: 'AND',
    alert_severity: 'ORANGE',
    weight: 20,
    recommended_action: 'Step-up authentication; manual review by transaction monitoring team.',
  },
  {
    rule_id: 'RULE_AGENT_001',
    name: 'Agent Portfolio Lapse Rate High',
    category: 'agent',
    description:
      'Agent portfolio lapse rate exceeded 20% over the trailing 12 months — agent quality review required.',
    conditions: [{ field: 'agent_portfolio_lapse_pct', operator: '>', value: 20 }],
    logic: 'AND',
    alert_severity: 'RED',
    weight: 25,
    recommended_action: 'Suspend new-business onboarding for the agent; supervisor review of book.',
  },
  {
    rule_id: 'RULE_OPS_001',
    name: 'Login From New Country',
    category: 'ops',
    description:
      'First-ever login from a country the customer has never used before in the last 24 hours — possible account takeover.',
    conditions: [{ field: 'login_new_country_24h', operator: '==', value: 1 }],
    logic: 'AND',
    alert_severity: 'YELLOW',
    weight: 15,
    recommended_action: 'Force step-up auth on next login; SMS/email confirmation to customer.',
  },
  {
    rule_id: 'RULE_CONC_001',
    name: 'Customer Concentration Risk',
    category: 'concentration',
    description:
      'Single customer accounts for more than 30% of the lender’s portfolio exposure — concentration limit breach.',
    conditions: [
      { field: 'customer_exposure_pct_of_portfolio', operator: '>', value: 30 },
    ],
    logic: 'AND',
    alert_severity: 'ORANGE',
    weight: 20,
    recommended_action: 'No further disbursement to this customer; risk committee review of book mix.',
  },
  {
    rule_id: 'RULE_BEHAV_001',
    name: 'Sudden Transaction Frequency Drop',
    category: 'behaviour',
    description:
      'Transaction frequency dropped 50% comparing the trailing 30 days vs the prior 30 days — possible attrition or distress.',
    conditions: [{ field: 'txn_freq_drop_30d_pct', operator: '>=', value: 50 }],
    logic: 'AND',
    alert_severity: 'ORANGE',
    weight: 20,
    recommended_action: 'Outbound retention call; check for service complaints; product upsell or churn risk.',
  },
  {
    rule_id: 'RULE_SCORE_001',
    name: 'Risk Score Sudden Increase',
    category: 'score',
    description:
      'Internal BIL risk score increased by 30+ points in the last 7 days — material deterioration in customer health.',
    conditions: [{ field: 'risk_score_delta_7d', operator: '>=', value: 30 }],
    logic: 'AND',
    alert_severity: 'RED',
    weight: 25,
    recommended_action: 'Immediate RM review; consider down-grading credit limit; queue for collections.',
  },
];

/** Convert a SeedDef into the EwsRuleInput shape validateEwsRule expects. */
export function seedToInput(s: SeedDef): EwsRuleInput {
  return {
    rule_id: s.rule_id,
    name: s.name,
    category: s.category,
    description: s.description,
    conditions: s.conditions,
    logic: s.logic,
    action: {
      alert_severity: s.alert_severity,
      weight: s.weight,
      recommended_action: s.recommended_action,
    },
    is_active: false,
    tags: [],
  };
}

/**
 * Bootstrap a tenant with the 10 default rules. Idempotent —
 * skips rules that already exist (so re-seeding the same tenant
 * doesn't surface duplicate_rule_id). Each rule lands in `draft`
 * state; caller activates them explicitly via the route.
 *
 * Returns per-rule outcomes for the SPA's first-tenant wizard.
 */
export function seedDefaultEwsRules(
  store: EwsRuleStore,
  tenant_id: string,
  created_by: string,
  now: Date,
): Array<{ rule_id: string; status: 'created' | 'skipped_exists' | 'error'; reason?: string }> {
  const out: Array<{ rule_id: string; status: 'created' | 'skipped_exists' | 'error'; reason?: string }> = [];
  for (const def of EWS_DEFAULT_RULES) {
    if (store.get(tenant_id, def.rule_id)) {
      out.push({ rule_id: def.rule_id, status: 'skipped_exists' });
      continue;
    }
    try {
      store.create(tenant_id, seedToInput(def), created_by, now);
      out.push({ rule_id: def.rule_id, status: 'created' });
    } catch (e) {
      out.push({
        rule_id: def.rule_id,
        status: 'error',
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}
