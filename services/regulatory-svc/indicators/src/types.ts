// Indicator engine types.
//
// MartCustomer360 / MartLoan360 / MartTxnFeatures mirror the corresponding
// dbt models under data/dbt/models/marts/*.sql. Where the indicator catalog
// (catalog.json) references a column that the dbt model does NOT yet expose,
// we declare it as an OPTIONAL field here and the compute function tolerates
// `undefined`. This is flagged for follow-up with agent-data — the runtime
// surface and the dbt mart need to converge before we materialise these
// indicators in SQL.
//
// Convention: amounts are KES (numeric → number). Dates are ISO-8601 strings
// at the boundary (typed as string here) and converted to `Date` inside the
// compute fns when needed.

import { IndicatorDef } from '../../../../rules/types';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

// ---------- mart.customer_360 ----------

/**
 * Snapshot of mart.customer_360 plus a few catalog-required columns that
 * agent-data has not yet added (marked TODO). Optional fields are tolerated
 * by the runtime; absent columns make the relevant indicator return
 * value=null, breached=false, severity='low' (treated as "unknown").
 */
export interface MartCustomer360 {
  // ---- columns currently materialised by data/dbt/models/marts/customer_360.sql
  customer_id: string;
  full_name?: string;
  segment?: string;
  branch_code?: string;
  kyc_status?: string;
  risk_rating?: string;
  monthly_income: number | null;
  onboarded_at?: string;
  active_loan_count: number;
  total_outstanding: number;
  total_disbursed: number;
  worst_dpd: number;
  npa_outstanding: number;
  has_npa: boolean;
  last_disbursed_at?: string | null;
  last_repayment_at?: string | null;
  repayment_count_lifetime: number;
  arrears_repayment_count: number;
  lifetime_shortfall: number;
  lifetime_inflow: number;
  lifetime_outflow: number;
  last_txn_at?: string | null;
  bureau_score?: number | null;
  bureau_score_band?: string | null;
  bureau_as_of?: string | null;
  delinquencies_12m?: number | null;
  open_facilities?: number | null;
  enquiries_3m?: number | null;
  exposure_to_income_ratio?: number | null;
  as_of: string;

  // ---- columns the catalog references that dbt does NOT yet expose.
  //      Agent-data follow-up: extend mart.customer_360 with these.
  /** FIN-002: declared minimum operating balance per customer. */
  min_op_balance?: number | null;
  /** FIN-003: total liquid savings balance (across all savings products). */
  savings_balance?: number | null;
  /** FIN-008: used overdraft balance (current). */
  overdraft_used?: number | null;
  /** FIN-008: sanctioned overdraft limit. */
  overdraft_limit?: number | null;
  /** BEH-004: count of channel logins, last 30d & last 90d (rolling). */
  channel_logins_30d?: number | null;
  channel_logins_90d?: number | null;
  /** BEH-005: complaints filed in last 60d. */
  complaints_60d?: number | null;
  /** BEH-006: nearest KYC document expiry (days from today; negative = expired). */
  kyc_expiry_days?: number | null;
  /** BEH-008: failed-contact attempts in last 30d. */
  contact_failures_30d?: number | null;
  /** CRD-001: bureau score 60d ago (so we can diff). */
  bureau_score_prior_60d?: number | null;
  /** CRD-002: new bureau credit inquiries in last 90d. */
  bureau_inquiries_90d?: number | null;
  /** CRD-003: max DPD reported by other lenders to bureau in last 90d. */
  bureau_external_dpd_max_90d?: number | null;
  /** CRD-004: external (non-this-bank) outstanding today + 90d ago. */
  bureau_ext_outstanding?: number | null;
  bureau_ext_outstanding_90d_ago?: number | null;
  /** CRD-008: any linked guarantor defaulted in last 180d. */
  guarantor_default_180d?: boolean | null;
}

// ---------- mart.loan_360 ----------

export interface RepaymentEntry {
  due_date: string;            // ISO-8601 date
  paid_date?: string | null;
  amount_due: number;
  amount_paid: number;
  days_late: number;           // 0 if on/before due_date
}

export interface RestructureRequest {
  requested_at: string;        // ISO-8601 date
  reason?: string;
}

export interface MartLoan360 {
  loan_id: string;
  customer_id: string;
  segment?: string;
  branch_code?: string;
  product_code?: string;
  currency?: string;
  principal_amount: number;
  outstanding_amount: number;
  interest_rate?: number;
  tenor_months?: number;
  disbursed_at?: string;
  maturity_date?: string;
  npa_status?: 'PERFORMING' | 'WATCH' | 'SUBSTANDARD' | 'DOUBTFUL' | 'LOSS';
  is_npa?: boolean;
  days_past_due: number;
  dpd_bucket?: string;
  last_repayment_at?: string | null;
  last_repayment_date?: string | null;
  repayment_count: number;
  total_paid: number;
  total_shortfall: number;
  arrears_payment_count: number;
  ltv_ratio?: number | null;
  as_of: string;

  // ---- catalog-required columns not yet in mart.loan_360.
  //      Agent-data follow-up: add these when extending loan_360.
  /** EMI obligation per loan, summed across loans for total_emi. */
  emi_amount?: number | null;
  /** BEH-001/002/003: ordered repayment history for the loan. */
  repayment_history?: RepaymentEntry[];
  /** BEH-007: customer-initiated restructure/moratorium requests. */
  restructure_requests?: RestructureRequest[];
  /** CRD-005: current and prior IFRS 9 stage. */
  ifrs9_stage?: 1 | 2 | 3 | null;
  ifrs9_stage_90d_ago?: 1 | 2 | 3 | null;
  /** CRD-007: most recent collateral fair-market value. */
  collateral_fmv?: number | null;
}

// ---------- mart.txn_features ----------

/**
 * One row per (customer_id, as_of). Catalog-driven extensions on top of the
 * 7/30/90 day rolling fields the dbt model already produces.
 */
export interface MartTxnFeatures {
  customer_id: string;
  as_of: string;

  // 7/30/90 inflow/outflow totals (already in dbt mart)
  inflow_7d: number;
  outflow_7d: number;
  txn_count_7d: number;
  net_flow_7d: number;
  inflow_30d: number;
  outflow_30d: number;
  txn_count_30d: number;
  net_flow_30d: number;
  inflow_90d: number;
  outflow_90d: number;
  txn_count_90d: number;
  net_flow_90d: number;
  burn_ratio_30d?: number | null;
  inflow_velocity_ratio?: number | null;

  // ---- catalog-required extensions not yet in mart.txn_features.
  //      Agent-data follow-up: extend txn_features with these signals.
  /** FIN-001: rolling daily-balance time-series, last 60 days, oldest→newest. */
  daily_balance?: number[];
  /** FIN-002: rolling end-of-day balance time-series, last 30d. */
  eod_balance_30d?: number[];
  /** FIN-004 / FIN-007: monthly income, last 12 months. */
  monthly_income_history?: number[];
  /** FIN-006: monthly salary inflow, last 6 months (oldest→newest). */
  salary_inflow_history?: number[];
  /** TXN-002: trailing 90 days of rolling-30-day outflow sums. */
  rolling_outflow_30d_history?: number[];
  /** TXN-003: outflow split by channel, last 30d. cash share is computed from this. */
  outflow_by_channel_30d?: { cash: number; non_cash: number };
  /** TXN-004: distinct merchant counts. */
  merchant_unique_30d?: number;
  merchant_unique_30_60d?: number;
  /** TXN-005: bounced (NSF-returned) payment count, last 60d. */
  bounced_payment_count_60d?: number;
  /** TXN-006: inflow split by source. {source_id: amount}. */
  inflow_by_source_90d?: Record<string, number>;
  /** TXN-007: trailing 90 days of rolling-30-day P2P outflow sums. */
  rolling_p2p_outflow_30d_history?: number[];
  p2p_outflow_30d?: number;
  /** TXN-008: weekend share, last 30d and prior 30-60d. */
  weekend_txn_share_30d?: number;
  weekend_txn_share_30_60d?: number;

  // ---- Fraud-family extensions (FRD-001 … FRD-004). Agent-data
  //      follow-up: surface these from txn_features when the source
  //      raw.txn_events feed lands.
  /** FRD-001: total withdrawal amount last 7 days. */
  withdrawals_7d?: number;
  /** FRD-001: rolling weekly mean of withdrawals over the prior 90 days. */
  weekly_withdrawal_mean_90d?: number;
  /** FRD-002: salary credit consistency in [0,1] over last 30 days. */
  salary_credit_consistency_30d?: number;
  /** FRD-002: salary credit consistency in [0,1] for the prior 30-60d window. */
  salary_credit_consistency_30_60d?: number;
  /** FRD-003: share [0,1] of last-7d transactions on a previously-unused channel. */
  unfamiliar_channel_share_7d?: number;
  /** FRD-004: greatest single-day haversine distance (km) between consecutive
   *  transactions in the last 7d. 0 = no movement. */
  geo_anomaly_distance_km_7d?: number;
}

// ---------- compute fn API ----------

export interface ComputeResult {
  /** Numeric value of the indicator. `null` means inputs were unavailable. */
  value: number | null;
  /** Whether this indicator's value crosses the breach threshold. */
  breached: boolean;
  /** Severity bucket — low | medium | high | critical. Falls back to 'low' when not breached. */
  severity: Severity;
}

export interface ComputeInputs {
  customer: MartCustomer360;
  loans: MartLoan360[];
  txn: MartTxnFeatures;
  catalogEntry: IndicatorDef;
  /** Snapshot date (ISO-8601 YYYY-MM-DD). Mostly relevant for time-windowed indicators. */
  snapshotDate: string;
}

export type ComputeFn = (inputs: ComputeInputs) => ComputeResult;

export type ComputeRegistry = Record<string, ComputeFn>;

// ---------- record we persist + emit ----------

export interface IndicatorValueRecord {
  customer_id: string;
  snapshot_date: string;
  indicator_id: string;
  value: number | null;
  breached: boolean;
  severity: Severity;
  ts: string; // ISO-8601 of compute time
}
