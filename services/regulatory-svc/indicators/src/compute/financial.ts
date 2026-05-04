// Compute functions for the Financial family (FIN-001 … FIN-008).
//
// Every function is pure: it consumes a snapshot of mart.* records and
// returns {value, breached, severity}. Breach thresholds are calibrated
// to roughly the same stress band that agent-rule's seed rules exploit
// (s ≈ 0.66 in the synthetic stress profile). They are intentionally
// conservative on their own — composite breach is the rule engine's job.

import { ComputeFn, ComputeRegistry } from '../types';
import { severityIfBreached } from '../severity';

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

const stddev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
};

// FIN-001 — balance_drop_30d_pct: 1 - (avg_last_30 / avg_prior_30).
//   breach when drop ≥ 30%.
const FIN_001: ComputeFn = ({ txn, catalogEntry }) => {
  const series = txn.daily_balance;
  if (!series || series.length < 60) {
    return { value: null, breached: false, severity: 'low' };
  }
  const last30 = series.slice(-30);
  const prior30 = series.slice(-60, -30);
  const a = mean(last30);
  const b = mean(prior30);
  if (b === 0) return { value: null, breached: false, severity: 'low' };
  const drop = 1 - a / b;
  const breached = drop >= 0.3;
  return { value: drop, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// FIN-002 — min_balance_breach_count_30d: count of EOD < min_op_balance.
//   breach when ≥ 5 in 30 days.
const FIN_002: ComputeFn = ({ customer, txn, catalogEntry }) => {
  const series = txn.eod_balance_30d;
  const minOp = customer.min_op_balance;
  if (!series || series.length === 0 || minOp === null || minOp === undefined) {
    return { value: null, breached: false, severity: 'low' };
  }
  const cnt = series.filter((b) => b < minOp).length;
  const breached = cnt >= 5;
  return { value: cnt, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// FIN-003 — savings_to_loan_ratio: savings / outstanding.
//   breach when ratio < 0.10 AND any outstanding > 0.
const FIN_003: ComputeFn = ({ customer, loans, catalogEntry }) => {
  const sav = customer.savings_balance;
  const outstanding = loans.reduce((a, l) => a + (l.outstanding_amount ?? 0), 0);
  if (sav === null || sav === undefined) {
    return { value: null, breached: false, severity: 'low' };
  }
  if (outstanding === 0) {
    return { value: null, breached: false, severity: 'low' };
  }
  const ratio = sav / outstanding;
  const breached = ratio < 0.1;
  return { value: ratio, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// FIN-004 — income_volatility_90d_cv: cv = stddev/mean over monthly income.
//   breach when cv ≥ 0.5 (≈ 50% relative volatility).
const FIN_004: ComputeFn = ({ txn, catalogEntry }) => {
  const series = txn.monthly_income_history?.slice(-3); // 90d ≈ last 3 months
  if (!series || series.length < 3) {
    return { value: null, breached: false, severity: 'low' };
  }
  const m = mean(series);
  if (m === 0) return { value: null, breached: false, severity: 'low' };
  const cv = stddev(series) / m;
  const breached = cv >= 0.5;
  return { value: cv, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// FIN-005 — net_cashflow_30d_to_emi: (inflow - outflow) / total_emi.
//   breach when ratio < 0.5 (less than half a single EMI of headroom).
const FIN_005: ComputeFn = ({ txn, loans, catalogEntry }) => {
  const totalEmi = loans.reduce((a, l) => a + (l.emi_amount ?? 0), 0);
  if (totalEmi <= 0) {
    return { value: null, breached: false, severity: 'low' };
  }
  const net = (txn.inflow_30d ?? 0) - (txn.outflow_30d ?? 0);
  const ratio = net / totalEmi;
  const breached = ratio < 0.5;
  return { value: ratio, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// FIN-006 — salary_inflow_skipped_months: max consecutive months with zero salary.
//   breach when streak ≥ 2.
const FIN_006: ComputeFn = ({ txn, catalogEntry }) => {
  const series = txn.salary_inflow_history;
  if (!series || series.length === 0) {
    return { value: null, breached: false, severity: 'low' };
  }
  let cur = 0;
  let max = 0;
  for (const v of series) {
    if (v === 0) {
      cur += 1;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  const breached = max >= 2;
  return { value: max, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// FIN-007 — loan_to_income_ratio: outstanding / sum(monthly_income, 12mo).
//   breach when ratio ≥ 0.5 (outstanding > half of annual income).
const FIN_007: ComputeFn = ({ customer, loans, txn, catalogEntry }) => {
  const outstanding =
    loans.reduce((a, l) => a + (l.outstanding_amount ?? 0), 0) ||
    customer.total_outstanding ||
    0;
  let annualIncome = 0;
  if (txn.monthly_income_history && txn.monthly_income_history.length > 0) {
    annualIncome = txn.monthly_income_history.reduce((a, b) => a + b, 0);
  } else if (customer.monthly_income) {
    annualIncome = customer.monthly_income * 12;
  }
  if (annualIncome <= 0) {
    return { value: null, breached: false, severity: 'low' };
  }
  const ratio = outstanding / annualIncome;
  const breached = ratio >= 0.5;
  return { value: ratio, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// FIN-008 — overdraft_utilisation_pct: used / limit.
//   breach when utilisation ≥ 0.9.
const FIN_008: ComputeFn = ({ customer, catalogEntry }) => {
  const used = customer.overdraft_used;
  const limit = customer.overdraft_limit;
  if (used === null || used === undefined || !limit) {
    return { value: null, breached: false, severity: 'low' };
  }
  const ratio = used / limit;
  const breached = ratio >= 0.9;
  return { value: ratio, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

export const FINANCIAL_REGISTRY: ComputeRegistry = {
  'FIN-001': FIN_001,
  'FIN-002': FIN_002,
  'FIN-003': FIN_003,
  'FIN-004': FIN_004,
  'FIN-005': FIN_005,
  'FIN-006': FIN_006,
  'FIN-007': FIN_007,
  'FIN-008': FIN_008,
};
