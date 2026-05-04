// services/bff/src/rules/variables.ts
//
// Banking variable library — the catalog the visual builder offers
// when an officer adds a new condition row. 30 variables across 5
// categories. Each entry doubles as inline help (description +
// refresh frequency), so the SPA tooltip is fed straight from here.

import type { BankingVariable } from './types';

export const VARIABLE_LIBRARY: BankingVariable[] = [
  // ── Account-level (6) ──
  {
    id: 'avg_monthly_balance',
    category: 'account',
    label: 'Average monthly balance',
    description: 'Mean EOD balance across the calendar month.',
    type: 'amount_kes',
    refresh: 'daily',
    unit: 'KES',
  },
  {
    id: 'min_balance_breach_count',
    category: 'account',
    label: 'Minimum-balance breach count',
    description: 'Days in the trailing 90 the EOD balance fell below the product-required minimum.',
    type: 'count',
    refresh: 'daily',
  },
  {
    id: 'salary_credit_consistency',
    category: 'account',
    label: 'Salary credit consistency',
    description: 'Share of expected salary credits that landed within ±2 days of the recurring date.',
    type: 'percent',
    refresh: 'monthly',
  },
  {
    id: 'eod_balance_trend_30d',
    category: 'account',
    label: 'EOD balance trend (30d)',
    description: 'Linear-regression slope of the last 30 EOD balances. Negative = declining.',
    type: 'percent',
    refresh: 'daily',
  },
  {
    id: 'debit_credit_ratio_90d',
    category: 'account',
    label: 'Debit/credit ratio (90d)',
    description: 'Total debits ÷ total credits over the trailing 90 days. >1 = net outflow.',
    type: 'number',
    refresh: 'daily',
  },
  {
    id: 'balance_drop_30d_pct',
    category: 'account',
    label: 'Balance drop 30d %',
    description: 'Percentage decline in EOD balance over the last 30 days.',
    type: 'percent',
    refresh: 'daily',
  },

  // ── Loan-level (8) ──
  {
    id: 'current_dpd',
    category: 'loan',
    label: 'Current DPD',
    description: 'Days past due on any active EMI on this loan account.',
    type: 'days',
    refresh: 'daily',
  },
  {
    id: 'max_dpd_6m',
    category: 'loan',
    label: 'Max DPD (last 6 months)',
    description: 'Highest DPD value the loan touched in the trailing 180 days.',
    type: 'days',
    refresh: 'daily',
  },
  {
    id: 'emi_bounce_count_90d',
    category: 'loan',
    label: 'EMI bounce count (90d)',
    description: 'Number of EMI presentations that returned unpaid in the last 90 days.',
    type: 'count',
    refresh: 'daily',
  },
  {
    id: 'partial_payment_freq_90d',
    category: 'loan',
    label: 'Partial-payment frequency (90d)',
    description: 'Count of EMIs where the customer paid less than the demanded amount.',
    type: 'count',
    refresh: 'daily',
  },
  {
    id: 'ltv_ratio',
    category: 'loan',
    label: 'LTV ratio',
    description: 'Outstanding balance ÷ current valuation of the secured asset.',
    type: 'percent',
    refresh: 'monthly',
  },
  {
    id: 'outstanding_vs_sanctioned',
    category: 'loan',
    label: 'Outstanding vs sanctioned',
    description: 'Current balance ÷ original sanctioned amount. >1 = top-up taken.',
    type: 'percent',
    refresh: 'daily',
  },
  {
    id: 'restructuring_history_flag',
    category: 'loan',
    label: 'Restructuring history',
    description: 'TRUE if the loan was ever restructured (incl. COVID-restructured accounts).',
    type: 'flag',
    refresh: 'daily',
  },
  {
    id: 'utilization',
    category: 'loan',
    label: 'Utilisation',
    description: 'For revolving credit — drawn balance ÷ approved limit.',
    type: 'percent',
    refresh: 'daily',
  },

  // ── Customer-level (6) ──
  {
    id: 'bureau_score',
    category: 'customer',
    label: 'Bureau score (current)',
    description: 'Latest CIBIL/Experian score for the obligor.',
    type: 'number',
    refresh: 'monthly',
  },
  {
    id: 'bureau_score_delta_90d',
    category: 'customer',
    label: 'Bureau score Δ (90d)',
    description: 'Change in bureau score vs 90 days ago. Negative = deterioration.',
    type: 'number',
    refresh: 'monthly',
  },
  {
    id: 'enquiries_30d',
    category: 'customer',
    label: 'Bureau enquiries (30d)',
    description: 'Number of credit enquiries pulled by other lenders in the trailing 30 days.',
    type: 'count',
    refresh: 'daily',
  },
  {
    id: 'total_exposure_kes',
    category: 'customer',
    label: 'Total exposure',
    description: 'Sum of outstanding across every product the customer holds with the bank.',
    type: 'amount_kes',
    refresh: 'daily',
    unit: 'KES',
  },
  {
    id: 'vintage_with_bank_months',
    category: 'customer',
    label: 'Vintage with bank',
    description: 'Months since the customer opened their first product.',
    type: 'count',
    refresh: 'daily',
  },
  {
    id: 'employment_status',
    category: 'customer',
    label: 'Employment status',
    description: 'Last-known employment classification.',
    type: 'enum',
    enum_values: ['salaried', 'self_employed', 'business_owner', 'retired', 'unemployed', 'unknown'],
    refresh: 'quarterly',
  },

  // ── Transaction-level (6) ──
  {
    id: 'cash_withdrawal_pct_income',
    category: 'transaction',
    label: 'Cash withdrawal % of income',
    description: 'Cash + ATM withdrawals as a share of declared monthly income.',
    type: 'percent',
    refresh: 'daily',
  },
  {
    id: 'salary_credit_on_time_flag',
    category: 'transaction',
    label: 'Salary credit on-time flag',
    description: 'TRUE if last expected salary credit landed within ±2 days of pay date.',
    type: 'flag',
    refresh: 'monthly',
  },
  {
    id: 'high_value_transfer_count_30d',
    category: 'transaction',
    label: 'High-value transfers (30d)',
    description: 'Count of single-transaction transfers exceeding KES 500,000 in the last 30 days.',
    type: 'count',
    refresh: 'daily',
  },
  {
    id: 'atm_declined_count_30d',
    category: 'transaction',
    label: 'ATM declined (30d)',
    description: 'Failed ATM withdrawals due to insufficient funds.',
    type: 'count',
    refresh: 'daily',
  },
  {
    id: 'cheque_return_count_30d',
    category: 'transaction',
    label: 'Cheque returns (30d)',
    description: 'Count of presented cheques returned unpaid.',
    type: 'count',
    refresh: 'daily',
  },
  {
    id: 'txn_volume_zscore_90d',
    category: 'transaction',
    label: 'Transaction volume z-score (90d)',
    description: 'Standard deviations from this customer’s 12-month rolling-mean transaction volume.',
    type: 'number',
    refresh: 'daily',
  },

  // ── External (4) ──
  {
    id: 'industry_risk_grade',
    category: 'external',
    label: 'Industry risk grade (MSME)',
    description: 'Grade A–E assigned to the obligor’s NIC/sector by the bank’s credit-policy team.',
    type: 'enum',
    enum_values: ['A', 'B', 'C', 'D', 'E'],
    refresh: 'quarterly',
  },
  {
    id: 'pincode_npa_rate',
    category: 'external',
    label: 'Pincode-level NPA rate',
    description: 'Trailing-12-month NPA percentage across the obligor’s residence pincode.',
    type: 'percent',
    refresh: 'monthly',
  },
  {
    id: 'gst_filing_regularity',
    category: 'external',
    label: 'GST filing regularity',
    description: 'Share of expected GSTR-3B filings the business made on time over 12 months.',
    type: 'percent',
    refresh: 'monthly',
  },
  {
    id: 'rbi_repo_rate_change_bps',
    category: 'external',
    label: 'RBI repo-rate change (bps)',
    description: 'Net policy-rate movement over the trailing 90 days.',
    type: 'number',
    refresh: 'monthly',
  },
];

export function variablesByCategory(): Record<string, BankingVariable[]> {
  const out: Record<string, BankingVariable[]> = {
    account: [],
    loan: [],
    customer: [],
    transaction: [],
    external: [],
  };
  for (const v of VARIABLE_LIBRARY) out[v.category].push(v);
  return out;
}

export function findVariable(id: string): BankingVariable | undefined {
  return VARIABLE_LIBRARY.find((v) => v.id === id);
}
