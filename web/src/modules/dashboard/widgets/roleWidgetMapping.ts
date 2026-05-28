// Phase 3 — Dashboard Foundation: role → widget-category mapping.
//
// Declares which widget CATEGORIES each role may see. resolveWidgets
// unions the rules across all of a viewer's roles, then filters the
// registry. This is the role-based-dashboard rule the brief asks for:
//   Fraud Analyst    → fraud widgets only
//   Risk Analyst     → SMA + NPA + risk widgets (overview + risk + fraud)
//   Claims Investigator → claim-fraud + anomaly (fraud)
//
// Keyed by role id. The 5 BACKEND roles (admin / supervisor /
// risk_analyst / collection_officer / field_officer) are the ones the
// frontend auth store actually carries today. The ENTERPRISE role ids
// (fraud_analyst, claims_investigator, …) from the 16-role catalogue are
// included too so the system already behaves correctly once enterprise
// roles flow through to the SPA — forward-compatible, not aspirational.

import type { RoleWidgetRule } from './types';

export const ROLE_WIDGET_MAPPING: Record<string, RoleWidgetRule> = {
  // ── Backend roles (live today) ─────────────────────────────────────
  // Admin + supervisor get the full board for oversight.
  admin: '*',
  supervisor: '*',
  // Risk analysts: portfolio overview + all risk signals + fraud.
  risk_analyst: ['overview', 'risk', 'fraud'],
  // Collection officers: overview + the collections/recovery surface.
  collection_officer: ['overview', 'collections'],
  // Field officers: overview + the risk watch surface they action.
  field_officer: ['overview', 'risk'],

  // ── Enterprise roles (16-role catalogue — honoured when present) ────
  super_admin: '*',
  country_admin: '*',
  bank_admin: '*',
  insurance_admin: '*',
  operations_user: ['overview', 'risk', 'collections'],
  fraud_analyst: ['fraud'], // fraud widgets only (per brief)
  claims_investigator: ['fraud'], // claim fraud + anomaly (per brief)
  underwriting_officer: ['overview', 'risk'],
  persistency_manager: ['overview', 'collections'],
  compliance_officer: ['overview', 'risk', 'fraud'],
  credit_officer: ['overview', 'risk', 'collections'],
  auditor: '*', // read-only, but sees everything for review
  platform_auditor: '*',
  read_only_user: ['overview'],
};

/** Safe default for an unrecognised role — overview only (never blank,
 *  never everything). resolveWidgets falls back to this. */
export const DEFAULT_ROLE_RULE: RoleWidgetRule = ['overview'];
