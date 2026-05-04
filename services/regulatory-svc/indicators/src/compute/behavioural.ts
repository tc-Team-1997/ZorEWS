// Compute functions for the Behavioural family (BEH-001 … BEH-008).

import { ComputeFn, ComputeRegistry, RepaymentEntry } from '../types';
import { severityIfBreached } from '../severity';

const DAY_MS = 86_400_000;

const within = (entry: RepaymentEntry, snapshot: Date, days: number): boolean => {
  const due = new Date(entry.due_date);
  const ageDays = Math.floor((snapshot.getTime() - due.getTime()) / DAY_MS);
  return ageDays >= 0 && ageDays <= days;
};

const collectRepayments = (
  loans: { repayment_history?: RepaymentEntry[] }[],
): RepaymentEntry[] => {
  return loans.flatMap((l) => l.repayment_history ?? []);
};

// BEH-001 — repayment_delay_days_avg_90d: mean days_late across last-90d due dates.
//   breach when mean ≥ 7 days late.
const BEH_001: ComputeFn = ({ loans, snapshotDate, catalogEntry }) => {
  const snap = new Date(snapshotDate);
  const reps = collectRepayments(loans).filter((r) => within(r, snap, 90));
  if (reps.length === 0) {
    return { value: null, breached: false, severity: 'low' };
  }
  const avg = reps.reduce((a, r) => a + (r.days_late ?? 0), 0) / reps.length;
  const breached = avg >= 7;
  return { value: avg, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// BEH-002 — repayment_delay_streak: consecutive late repayments ending today.
//   breach when streak ≥ 2.
const BEH_002: ComputeFn = ({ loans, catalogEntry }) => {
  const reps = collectRepayments(loans);
  if (reps.length === 0) {
    return { value: null, breached: false, severity: 'low' };
  }
  // sort by due_date ascending, walk from newest backward.
  const sorted = [...reps].sort((a, b) => a.due_date.localeCompare(b.due_date));
  let streak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if ((sorted[i].days_late ?? 0) > 0) streak += 1;
    else break;
  }
  const breached = streak >= 2;
  return { value: streak, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// BEH-003 — partial_repayment_ratio_90d: count(partial) / count(due) over 90d.
//   breach when ratio ≥ 0.4.
const BEH_003: ComputeFn = ({ loans, snapshotDate, catalogEntry }) => {
  const snap = new Date(snapshotDate);
  const reps = collectRepayments(loans).filter((r) => within(r, snap, 90));
  if (reps.length === 0) {
    return { value: null, breached: false, severity: 'low' };
  }
  const partial = reps.filter((r) => (r.amount_paid ?? 0) < (r.amount_due ?? 0)).length;
  const ratio = partial / reps.length;
  const breached = ratio >= 0.4;
  return { value: ratio, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// BEH-004 — channel_login_drop_30d: 1 - (logins_30d/30) / (logins_90d_baseline/90).
//   The baseline is taken from logins in the prior 90d window.
//   breach when drop ≥ 0.5 (logins halved).
const BEH_004: ComputeFn = ({ customer, catalogEntry }) => {
  const recent = customer.channel_logins_30d;
  const prior = customer.channel_logins_90d;
  if (recent === null || recent === undefined || prior === null || prior === undefined) {
    return { value: null, breached: false, severity: 'low' };
  }
  if (prior === 0) {
    return { value: null, breached: false, severity: 'low' };
  }
  const recentRate = recent / 30;
  const priorRate = prior / 90;
  if (priorRate === 0) {
    return { value: null, breached: false, severity: 'low' };
  }
  const drop = 1 - recentRate / priorRate;
  const breached = drop >= 0.5;
  return { value: drop, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// BEH-005 — support_complaint_count_60d.
//   breach when complaints ≥ 2.
const BEH_005: ComputeFn = ({ customer, catalogEntry }) => {
  const c = customer.complaints_60d;
  if (c === null || c === undefined) {
    return { value: null, breached: false, severity: 'low' };
  }
  const breached = c >= 2;
  return { value: c, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// BEH-006 — kyc_doc_expiry_days: min(expiry - today). Negative = already expired.
//   breach when ≤ 30 days remaining.
const BEH_006: ComputeFn = ({ customer, catalogEntry }) => {
  const d = customer.kyc_expiry_days;
  if (d === null || d === undefined) {
    return { value: null, breached: false, severity: 'low' };
  }
  const breached = d <= 30;
  return { value: d, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// BEH-007 — restructure_request_flag: any request in last 60d → 1.
//   breach when flag = 1.
const BEH_007: ComputeFn = ({ loans, snapshotDate, catalogEntry }) => {
  const snap = new Date(snapshotDate);
  let any = false;
  for (const loan of loans) {
    for (const r of loan.restructure_requests ?? []) {
      const ageDays = Math.floor((snap.getTime() - new Date(r.requested_at).getTime()) / DAY_MS);
      if (ageDays >= 0 && ageDays <= 60) {
        any = true;
        break;
      }
    }
    if (any) break;
  }
  return { value: any ? 1 : 0, breached: any, severity: severityIfBreached(any, catalogEntry.severity_weight) };
};

// BEH-008 — unreachable_contact_count_30d.
//   breach when ≥ 3.
const BEH_008: ComputeFn = ({ customer, catalogEntry }) => {
  const c = customer.contact_failures_30d;
  if (c === null || c === undefined) {
    return { value: null, breached: false, severity: 'low' };
  }
  const breached = c >= 3;
  return { value: c, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

export const BEHAVIOURAL_REGISTRY: ComputeRegistry = {
  'BEH-001': BEH_001,
  'BEH-002': BEH_002,
  'BEH-003': BEH_003,
  'BEH-004': BEH_004,
  'BEH-005': BEH_005,
  'BEH-006': BEH_006,
  'BEH-007': BEH_007,
  'BEH-008': BEH_008,
};
