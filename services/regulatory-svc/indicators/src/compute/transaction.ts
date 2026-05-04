// Compute functions for the Transaction family (TXN-001 … TXN-008).

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

// TXN-001 — outflow_to_inflow_ratio_30d.
//   breach when ratio ≥ 1.2.
const TXN_001: ComputeFn = ({ txn, catalogEntry }) => {
  const inflow = txn.inflow_30d ?? 0;
  const outflow = txn.outflow_30d ?? 0;
  // catalog formula uses max(inflow, 1) — same idea but force a number value.
  if (inflow <= 0 && outflow <= 0) {
    return { value: null, breached: false, severity: 'low' };
  }
  const ratio = outflow / Math.max(inflow, 1);
  const breached = ratio >= 1.2;
  return { value: ratio, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// TXN-002 — large_outflow_anomaly: z-score of last-30d outflow vs prior 90d distribution.
//   breach when z ≥ 3.
const TXN_002: ComputeFn = ({ txn, catalogEntry }) => {
  const series = txn.rolling_outflow_30d_history;
  if (!series || series.length < 30) {
    return { value: null, breached: false, severity: 'low' };
  }
  const baseline = series.slice(0, -1); // historical
  const latest = series[series.length - 1];
  const m = mean(baseline);
  const sd = stddev(baseline);
  if (sd === 0) {
    return { value: 0, breached: false, severity: 'low' };
  }
  const z = (latest - m) / sd;
  const breached = z >= 3;
  return { value: z, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// TXN-003 — cash_withdrawal_share_30d.
//   breach when share ≥ 0.6 (more than 60% of outflows are cash).
const TXN_003: ComputeFn = ({ txn, catalogEntry }) => {
  const split = txn.outflow_by_channel_30d;
  if (!split) return { value: null, breached: false, severity: 'low' };
  const total = (split.cash ?? 0) + (split.non_cash ?? 0);
  if (total <= 0) return { value: null, breached: false, severity: 'low' };
  const share = (split.cash ?? 0) / total;
  const breached = share >= 0.6;
  return { value: share, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// TXN-004 — merchant_diversity_drop_60d.
//   breach when drop ≥ 0.5.
const TXN_004: ComputeFn = ({ txn, catalogEntry }) => {
  const recent = txn.merchant_unique_30d;
  const prior = txn.merchant_unique_30_60d;
  if (recent === undefined || prior === undefined || prior === 0) {
    return { value: null, breached: false, severity: 'low' };
  }
  const drop = 1 - recent / prior;
  const breached = drop >= 0.5;
  return { value: drop, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// TXN-005 — bounced_payment_count_60d.
//   breach when count ≥ 1 (any bounce in 60d is a strong signal).
const TXN_005: ComputeFn = ({ txn, catalogEntry }) => {
  const c = txn.bounced_payment_count_60d;
  if (c === undefined) return { value: null, breached: false, severity: 'low' };
  const breached = c >= 1;
  return { value: c, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// TXN-006 — inflow_concentration_hhi: sum(share^2) over inflow sources.
//   breach when HHI ≥ 0.7 (single-source dependency).
const TXN_006: ComputeFn = ({ txn, catalogEntry }) => {
  const sources = txn.inflow_by_source_90d;
  if (!sources) return { value: null, breached: false, severity: 'low' };
  const amounts = Object.values(sources);
  const total = amounts.reduce((a, b) => a + b, 0);
  if (total <= 0) return { value: null, breached: false, severity: 'low' };
  const hhi = amounts.reduce((a, b) => a + (b / total) * (b / total), 0);
  const breached = hhi >= 0.7;
  return { value: hhi, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// TXN-007 — p2p_outflow_spike_30d: latest 30d / mean(rolling-30d, 90d).
//   breach when ratio ≥ 2 (doubling vs baseline).
const TXN_007: ComputeFn = ({ txn, catalogEntry }) => {
  const series = txn.rolling_p2p_outflow_30d_history;
  if (!series || series.length < 30) {
    return { value: null, breached: false, severity: 'low' };
  }
  const latest = series[series.length - 1];
  const baseline = series.slice(0, -1);
  const m = mean(baseline);
  const ratio = latest / (m + 1);
  const breached = ratio >= 2;
  return { value: ratio, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// TXN-008 — weekend_txn_share_change_60d.
//   breach when delta ≥ 0.2 (20pp shift toward weekends).
const TXN_008: ComputeFn = ({ txn, catalogEntry }) => {
  const recent = txn.weekend_txn_share_30d;
  const prior = txn.weekend_txn_share_30_60d;
  if (recent === undefined || prior === undefined) {
    return { value: null, breached: false, severity: 'low' };
  }
  const delta = recent - prior;
  const breached = Math.abs(delta) >= 0.2;
  return { value: delta, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

export const TRANSACTION_REGISTRY: ComputeRegistry = {
  'TXN-001': TXN_001,
  'TXN-002': TXN_002,
  'TXN-003': TXN_003,
  'TXN-004': TXN_004,
  'TXN-005': TXN_005,
  'TXN-006': TXN_006,
  'TXN-007': TXN_007,
  'TXN-008': TXN_008,
};
