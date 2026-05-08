// Compute functions for the Fraud family (FRD-001 … FRD-004).
//
// Source signals are surfaced via mart.txn_features extensions declared in
// types.ts. When inputs are missing we return value=null, breached=false,
// severity='low' — the same "unknown" convention the other families use.

import { ComputeFn, ComputeRegistry } from '../types';
import { severityIfBreached } from '../severity';

// FRD-001 — sudden_withdrawal_spike: 7d withdrawals / 90d weekly mean.
//   breach when ratio ≥ 10 (a one-week spike that is 10× the historical
//   weekly average — a robust mule-account signal).
const FRD_001: ComputeFn = ({ txn, catalogEntry }) => {
  const recent = txn.withdrawals_7d;
  const mean = txn.weekly_withdrawal_mean_90d;
  if (recent === undefined || mean === undefined) {
    return { value: null, breached: false, severity: 'low' };
  }
  // Guard against tiny means producing infinite ratios on noisy seed data.
  const ratio = recent / Math.max(mean, 0.01);
  const breached = ratio >= 10;
  return {
    value: ratio,
    breached,
    severity: severityIfBreached(breached, catalogEntry.severity_weight),
  };
};

// FRD-002 — salary_credit_disappeared: salary consistency dropped to 0 in
// the recent window, having been ≥ 0.6 in the prior window.
//   value: 1 if the disappearance condition holds, else 0 (boolean-as-number).
const FRD_002: ComputeFn = ({ txn, catalogEntry }) => {
  const recent = txn.salary_credit_consistency_30d;
  const prior = txn.salary_credit_consistency_30_60d;
  if (recent === undefined || prior === undefined) {
    return { value: null, breached: false, severity: 'low' };
  }
  const disappeared = recent === 0 && prior >= 0.6;
  const value = disappeared ? 1 : 0;
  return {
    value,
    breached: disappeared,
    severity: severityIfBreached(disappeared, catalogEntry.severity_weight),
  };
};

// FRD-003 — channel_anomaly_score: share of last-7d transactions on a
// previously-unused channel.
//   breach when share ≥ 0.4.
const FRD_003: ComputeFn = ({ txn, catalogEntry }) => {
  const share = txn.unfamiliar_channel_share_7d;
  if (share === undefined) {
    return { value: null, breached: false, severity: 'low' };
  }
  const breached = share >= 0.4;
  return {
    value: share,
    breached,
    severity: severityIfBreached(breached, catalogEntry.severity_weight),
  };
};

// FRD-004 — geo_anomaly_distance_km: greatest single-day distance between
// consecutive transactions in the last 7 days.
//   breach when ≥ 500 km within a day (physically implausible without travel).
const FRD_004: ComputeFn = ({ txn, catalogEntry }) => {
  const km = txn.geo_anomaly_distance_km_7d;
  if (km === undefined) {
    return { value: null, breached: false, severity: 'low' };
  }
  const breached = km >= 500;
  return {
    value: km,
    breached,
    severity: severityIfBreached(breached, catalogEntry.severity_weight),
  };
};

export const FRAUD_REGISTRY: ComputeRegistry = {
  'FRD-001': FRD_001,
  'FRD-002': FRD_002,
  'FRD-003': FRD_003,
  'FRD-004': FRD_004,
};
