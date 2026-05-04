// Compute functions for the Credit family (CRD-001 … CRD-008).

import { ComputeFn, ComputeRegistry } from '../types';
import { severityIfBreached } from '../severity';

// CRD-001 — bureau_score_drop_60d: prior - current. Positive = score fell.
//   breach when drop ≥ 50 points.
const CRD_001: ComputeFn = ({ customer, catalogEntry }) => {
  const cur = customer.bureau_score;
  const prior = customer.bureau_score_prior_60d;
  if (cur === null || cur === undefined || prior === null || prior === undefined) {
    return { value: null, breached: false, severity: 'low' };
  }
  const drop = prior - cur;
  const breached = drop >= 50;
  return { value: drop, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// CRD-002 — new_credit_inquiries_90d.
//   breach when ≥ 3.
const CRD_002: ComputeFn = ({ customer, catalogEntry }) => {
  const c = customer.bureau_inquiries_90d;
  if (c === null || c === undefined) {
    return { value: null, breached: false, severity: 'low' };
  }
  const breached = c >= 3;
  return { value: c, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// CRD-003 — external_dpd_max_90d.
//   breach when ≥ 30 days.
const CRD_003: ComputeFn = ({ customer, catalogEntry }) => {
  const d = customer.bureau_external_dpd_max_90d;
  if (d === null || d === undefined) {
    return { value: null, breached: false, severity: 'low' };
  }
  const breached = d >= 30;
  return { value: d, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// CRD-004 — total_external_exposure_growth_90d: (now - then) / then.
//   breach when growth ≥ 0.3 (30% in 90 days).
const CRD_004: ComputeFn = ({ customer, catalogEntry }) => {
  const cur = customer.bureau_ext_outstanding;
  const prior = customer.bureau_ext_outstanding_90d_ago;
  if (cur === null || cur === undefined || prior === null || prior === undefined) {
    return { value: null, breached: false, severity: 'low' };
  }
  if (prior <= 0) {
    return { value: null, breached: false, severity: 'low' };
  }
  const growth = (cur - prior) / prior;
  const breached = growth >= 0.3;
  return { value: growth, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// CRD-005 — ifrs9_stage_movement: max stage delta over loans (today vs 90d ago).
//   breach when any loan moves up at least one stage.
const CRD_005: ComputeFn = ({ loans, catalogEntry }) => {
  const deltas: number[] = [];
  for (const l of loans) {
    const cur = l.ifrs9_stage;
    const prior = l.ifrs9_stage_90d_ago;
    if (cur === null || cur === undefined || prior === null || prior === undefined) continue;
    deltas.push(cur - prior);
  }
  if (deltas.length === 0) {
    return { value: null, breached: false, severity: 'low' };
  }
  const maxDelta = Math.max(...deltas);
  const breached = maxDelta >= 1;
  return { value: maxDelta, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// CRD-006 — internal_dpd_current: max DPD across this bank's loans.
//   breach when ≥ 30 days.
const CRD_006: ComputeFn = ({ loans, customer, catalogEntry }) => {
  const dpds = loans.map((l) => l.days_past_due ?? 0);
  const max = dpds.length ? Math.max(...dpds) : (customer.worst_dpd ?? 0);
  const breached = max >= 30;
  return { value: max, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// CRD-007 — collateral_coverage_ratio: collateral_fmv / outstanding.
//   We summarise across loans: total_fmv / total_outstanding.
//   breach when ratio < 1 (under-collateralised).
const CRD_007: ComputeFn = ({ loans, catalogEntry }) => {
  let totalFmv = 0;
  let totalOut = 0;
  let any = false;
  for (const l of loans) {
    if (l.collateral_fmv !== null && l.collateral_fmv !== undefined) {
      totalFmv += l.collateral_fmv;
      totalOut += l.outstanding_amount ?? 0;
      any = true;
    }
  }
  if (!any || totalOut <= 0) {
    return { value: null, breached: false, severity: 'low' };
  }
  const ratio = totalFmv / totalOut;
  const breached = ratio < 1;
  return { value: ratio, breached, severity: severityIfBreached(breached, catalogEntry.severity_weight) };
};

// CRD-008 — guarantor_default_flag: any linked guarantor defaulted in 180d.
//   breach when flag = 1.
const CRD_008: ComputeFn = ({ customer, catalogEntry }) => {
  const flag = customer.guarantor_default_180d;
  if (flag === null || flag === undefined) {
    return { value: null, breached: false, severity: 'low' };
  }
  const v = flag ? 1 : 0;
  return { value: v, breached: !!flag, severity: severityIfBreached(!!flag, catalogEntry.severity_weight) };
};

export const CREDIT_REGISTRY: ComputeRegistry = {
  'CRD-001': CRD_001,
  'CRD-002': CRD_002,
  'CRD-003': CRD_003,
  'CRD-004': CRD_004,
  'CRD-005': CRD_005,
  'CRD-006': CRD_006,
  'CRD-007': CRD_007,
  'CRD-008': CRD_008,
};
