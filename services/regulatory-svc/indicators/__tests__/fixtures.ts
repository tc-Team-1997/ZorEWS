// Test fixtures.
//
// `baseSnapshot()` produces a "healthy" customer — every indicator should
// return breached=false on it. Each per-indicator test then mutates a single
// field to push that indicator into breach.

import { MartCustomer360, MartLoan360, MartTxnFeatures } from '../src/types';
import { MartSnapshot } from '../src/mart/reader';

export function baseCustomer(over: Partial<MartCustomer360> = {}): MartCustomer360 {
  return {
    customer_id: 'CUST-1',
    monthly_income: 100_000,
    active_loan_count: 1,
    total_outstanding: 200_000,
    total_disbursed: 250_000,
    worst_dpd: 0,
    npa_outstanding: 0,
    has_npa: false,
    repayment_count_lifetime: 24,
    arrears_repayment_count: 0,
    lifetime_shortfall: 0,
    lifetime_inflow: 1_200_000,
    lifetime_outflow: 1_000_000,
    bureau_score: 720,
    bureau_score_band: 'GOOD',
    delinquencies_12m: 0,
    open_facilities: 1,
    enquiries_3m: 0,
    exposure_to_income_ratio: 2.0, // 200k / 100k
    as_of: '2026-04-26',

    // catalog-required extensions, healthy defaults
    min_op_balance: 5_000,
    savings_balance: 50_000,
    overdraft_used: 0,
    overdraft_limit: 100_000,
    channel_logins_30d: 30,
    channel_logins_90d: 90,
    complaints_60d: 0,
    kyc_expiry_days: 365,
    contact_failures_30d: 0,
    bureau_score_prior_60d: 720,
    bureau_inquiries_90d: 0,
    bureau_external_dpd_max_90d: 0,
    bureau_ext_outstanding: 100_000,
    bureau_ext_outstanding_90d_ago: 100_000,
    guarantor_default_180d: false,
    ...over,
  };
}

export function baseLoan(over: Partial<MartLoan360> = {}): MartLoan360 {
  return {
    loan_id: 'LOAN-1',
    customer_id: 'CUST-1',
    principal_amount: 250_000,
    outstanding_amount: 200_000,
    days_past_due: 0,
    repayment_count: 12,
    total_paid: 50_000,
    total_shortfall: 0,
    arrears_payment_count: 0,
    npa_status: 'PERFORMING',
    is_npa: false,
    as_of: '2026-04-26',
    emi_amount: 25_000,
    repayment_history: [
      // 6 monthly repayments, all on-time
      { due_date: '2025-11-26', paid_date: '2025-11-26', amount_due: 25_000, amount_paid: 25_000, days_late: 0 },
      { due_date: '2025-12-26', paid_date: '2025-12-26', amount_due: 25_000, amount_paid: 25_000, days_late: 0 },
      { due_date: '2026-01-26', paid_date: '2026-01-26', amount_due: 25_000, amount_paid: 25_000, days_late: 0 },
      { due_date: '2026-02-26', paid_date: '2026-02-26', amount_due: 25_000, amount_paid: 25_000, days_late: 0 },
      { due_date: '2026-03-26', paid_date: '2026-03-26', amount_due: 25_000, amount_paid: 25_000, days_late: 0 },
      { due_date: '2026-04-26', paid_date: '2026-04-26', amount_due: 25_000, amount_paid: 25_000, days_late: 0 },
    ],
    restructure_requests: [],
    ifrs9_stage: 1,
    ifrs9_stage_90d_ago: 1,
    collateral_fmv: 300_000,
    ...over,
  };
}

export function baseTxn(over: Partial<MartTxnFeatures> = {}): MartTxnFeatures {
  return {
    customer_id: 'CUST-1',
    as_of: '2026-04-26',
    inflow_7d: 25_000,
    outflow_7d: 20_000,
    txn_count_7d: 8,
    net_flow_7d: 5_000,
    inflow_30d: 100_000,
    outflow_30d: 80_000,
    txn_count_30d: 30,
    net_flow_30d: 20_000,
    inflow_90d: 300_000,
    outflow_90d: 240_000,
    txn_count_90d: 90,
    net_flow_90d: 60_000,
    burn_ratio_30d: 0.8,
    inflow_velocity_ratio: 1.0,

    // healthy extension defaults
    daily_balance: Array.from({ length: 60 }, () => 50_000), // flat 50k for 60d
    eod_balance_30d: Array.from({ length: 30 }, () => 50_000),
    monthly_income_history: [100_000, 100_000, 100_000, 100_000, 100_000, 100_000,
                             100_000, 100_000, 100_000, 100_000, 100_000, 100_000],
    salary_inflow_history: [100_000, 100_000, 100_000, 100_000, 100_000, 100_000],
    rolling_outflow_30d_history: Array.from({ length: 90 }, () => 80_000),
    outflow_by_channel_30d: { cash: 10_000, non_cash: 70_000 },
    merchant_unique_30d: 12,
    merchant_unique_30_60d: 12,
    bounced_payment_count_60d: 0,
    inflow_by_source_90d: { salary: 200_000, freelance: 60_000, gifts: 40_000 },
    rolling_p2p_outflow_30d_history: Array.from({ length: 90 }, () => 5_000),
    p2p_outflow_30d: 5_000,
    weekend_txn_share_30d: 0.2,
    weekend_txn_share_30_60d: 0.2,
    ...over,
  };
}

export function healthySnapshot(): MartSnapshot {
  return {
    customer: baseCustomer(),
    loans: [baseLoan()],
    txn: baseTxn(),
  };
}
