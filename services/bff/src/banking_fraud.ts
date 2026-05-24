// services/bff/src/banking_fraud.ts
//
// Banking Fraud full surface — closes §2.3 #18 of
// ZorEWS_Pending_Gap_Analysis.md.
//
// Existing /v1/fraud/dashboard is a dashboard endpoint only. This module
// ships the operational surface: fraud cases CRUD, fraud-rules editor,
// SAR (Suspicious Activity Report — RBI Master Directions on Frauds 2016)
// submission + Vigilance referral.
//
//   GET    /v1/fraud/cases?status=&priority=&assignee=
//   POST   /v1/fraud/cases
//   GET    /v1/fraud/cases/:case_id
//   PATCH  /v1/fraud/cases/:case_id            (assign, escalate, status)
//   GET    /v1/fraud/rules
//   POST   /v1/fraud/rules                     (create new rule)
//   PATCH  /v1/fraud/rules/:rule_id            (update)
//   DELETE /v1/fraud/rules/:rule_id
//   POST   /v1/fraud/cases/:case_id/sar        (Suspicious Activity Report)
//   POST   /v1/fraud/cases/:case_id/vigilance  (Vigilance referral)

export type FraudCaseStatus = 'open' | 'investigating' | 'reported' | 'closed' | 'false_positive';
export const ALL_FRAUD_CASE_STATUSES: readonly FraudCaseStatus[] = ['open', 'investigating', 'reported', 'closed', 'false_positive'];

export type FraudPriority = 'low' | 'medium' | 'high' | 'critical';
export const ALL_FRAUD_PRIORITIES: readonly FraudPriority[] = ['low', 'medium', 'high', 'critical'];

export type FraudCategory = 'identity_theft' | 'cheque_fraud' | 'card_fraud' | 'cyber_fraud' | 'loan_fraud' | 'account_takeover' | 'staff_collusion' | 'other';
export const ALL_FRAUD_CATEGORIES: readonly FraudCategory[] = [
  'identity_theft', 'cheque_fraud', 'card_fraud', 'cyber_fraud', 'loan_fraud', 'account_takeover', 'staff_collusion', 'other',
];

export interface FraudCase {
  case_id: string;
  tenant_id: string;
  customer_id: string | null;
  account_id: string | null;
  category: FraudCategory;
  priority: FraudPriority;
  status: FraudCaseStatus;
  amount_kes: number;
  description: string;
  detected_at: string;
  assignee: string | null;
  opened_by: string;
  opened_at: string;
  updated_at: string;
  closed_at: string | null;
  sar_id: string | null;
  vigilance_ref: string | null;
  rule_id: string | null;
}

export interface FraudRule {
  rule_id: string;
  tenant_id: string;
  name: string;
  category: FraudCategory;
  condition_pseudocode: string;
  threshold: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export class FraudError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'FraudError';
  }
}

export function isFraudCaseStatus(x: unknown): x is FraudCaseStatus {
  return typeof x === 'string' && ALL_FRAUD_CASE_STATUSES.includes(x as FraudCaseStatus);
}
export function isFraudPriority(x: unknown): x is FraudPriority {
  return typeof x === 'string' && ALL_FRAUD_PRIORITIES.includes(x as FraudPriority);
}
export function isFraudCategory(x: unknown): x is FraudCategory {
  return typeof x === 'string' && ALL_FRAUD_CATEGORIES.includes(x as FraudCategory);
}

const _cases = new Map<string, FraudCase>();
const _rules = new Map<string, FraudRule>();
let _caseSeq = 0;
let _ruleSeq = 0;
let _sarSeq = 0;
let _vigSeq = 0;

export function listFraudCases(
  tenant_id: string,
  filter: { status?: FraudCaseStatus; priority?: FraudPriority; assignee?: string } = {},
): FraudCase[] {
  if (!tenant_id) throw new FraudError('invalid_input', 'tenant_id required');
  const out: FraudCase[] = [];
  for (const c of _cases.values()) {
    if (c.tenant_id !== tenant_id) continue;
    if (filter.status && c.status !== filter.status) continue;
    if (filter.priority && c.priority !== filter.priority) continue;
    if (filter.assignee && c.assignee !== filter.assignee) continue;
    out.push({ ...c });
  }
  const prRank: Record<FraudPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  out.sort((a, b) => prRank[a.priority] - prRank[b.priority] || b.updated_at.localeCompare(a.updated_at));
  return out;
}

export function getFraudCase(tenant_id: string, case_id: string): FraudCase | null {
  const found = _cases.get(case_id);
  if (!found || found.tenant_id !== tenant_id) return null;
  return { ...found };
}

export function createFraudCase(
  tenant_id: string,
  input: { customer_id?: string; account_id?: string; category: FraudCategory; priority: FraudPriority; amount_kes: number; description: string; rule_id?: string },
  opened_by: string,
  now: Date,
): FraudCase {
  if (!tenant_id) throw new FraudError('invalid_input', 'tenant_id required');
  if (!opened_by) throw new FraudError('invalid_input', 'opened_by required');
  if (!isFraudCategory(input.category)) throw new FraudError('invalid_category', `category ${input.category}`);
  if (!isFraudPriority(input.priority)) throw new FraudError('invalid_priority', `priority ${input.priority}`);
  if (!Number.isFinite(input.amount_kes) || input.amount_kes < 0)
    throw new FraudError('invalid_input', 'amount_kes must be a non-negative finite number');
  if (!input.description || input.description.trim().length < 5)
    throw new FraudError('invalid_input', 'description ≥ 5 chars required');
  _caseSeq++;
  const id = `frd-${tenant_id}-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(_caseSeq).padStart(5, '0')}`;
  const entry: FraudCase = {
    case_id: id,
    tenant_id,
    customer_id: input.customer_id ?? null,
    account_id: input.account_id ?? null,
    category: input.category,
    priority: input.priority,
    status: 'open',
    amount_kes: input.amount_kes,
    description: input.description.trim(),
    detected_at: now.toISOString(),
    assignee: null,
    opened_by,
    opened_at: now.toISOString(),
    updated_at: now.toISOString(),
    closed_at: null,
    sar_id: null,
    vigilance_ref: null,
    rule_id: input.rule_id ?? null,
  };
  _cases.set(id, entry);
  return entry;
}

export function updateFraudCase(
  tenant_id: string,
  case_id: string,
  patch: Partial<{ status: FraudCaseStatus; priority: FraudPriority; assignee: string | null; description: string }>,
  now: Date,
): FraudCase {
  const entry = _cases.get(case_id);
  if (!entry || entry.tenant_id !== tenant_id) throw new FraudError('unknown_case', `unknown ${case_id}`);
  if (patch.status !== undefined) {
    if (!isFraudCaseStatus(patch.status)) throw new FraudError('invalid_status', `status ${patch.status}`);
    if (entry.status === 'closed' && patch.status !== 'closed')
      throw new FraudError('invalid_transition', 'closed cases are immutable');
    entry.status = patch.status;
    if (patch.status === 'closed') entry.closed_at = now.toISOString();
  }
  if (patch.priority !== undefined) {
    if (!isFraudPriority(patch.priority)) throw new FraudError('invalid_priority', `priority ${patch.priority}`);
    entry.priority = patch.priority;
  }
  if (patch.assignee !== undefined) entry.assignee = patch.assignee;
  if (patch.description !== undefined) {
    if (patch.description.trim().length < 5) throw new FraudError('invalid_input', 'description ≥ 5 chars');
    entry.description = patch.description.trim();
  }
  entry.updated_at = now.toISOString();
  return { ...entry };
}

// ─── Fraud rules ───────────────────────────────────────────────────────

export function listFraudRules(tenant_id: string, enabled_only = false): FraudRule[] {
  if (!tenant_id) throw new FraudError('invalid_input', 'tenant_id required');
  const out: FraudRule[] = [];
  for (const r of _rules.values()) {
    if (r.tenant_id !== tenant_id) continue;
    if (enabled_only && !r.enabled) continue;
    out.push({ ...r });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function createFraudRule(
  tenant_id: string,
  input: { name: string; category: FraudCategory; condition_pseudocode: string; threshold: number; enabled?: boolean },
  created_by: string,
  now: Date,
): FraudRule {
  if (!tenant_id) throw new FraudError('invalid_input', 'tenant_id required');
  if (!created_by) throw new FraudError('invalid_input', 'created_by required');
  if (!input.name || input.name.length < 3 || input.name.length > 120)
    throw new FraudError('invalid_input', 'name must be 3..120 chars');
  if (!isFraudCategory(input.category)) throw new FraudError('invalid_category', `category ${input.category}`);
  if (!input.condition_pseudocode || input.condition_pseudocode.length < 5)
    throw new FraudError('invalid_input', 'condition_pseudocode required');
  if (!Number.isFinite(input.threshold)) throw new FraudError('invalid_input', 'threshold must be finite');
  _ruleSeq++;
  const id = `frrl-${tenant_id}-${String(_ruleSeq).padStart(5, '0')}`;
  const rule: FraudRule = {
    rule_id: id,
    tenant_id,
    name: input.name,
    category: input.category,
    condition_pseudocode: input.condition_pseudocode,
    threshold: input.threshold,
    enabled: input.enabled !== false,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    created_by,
  };
  _rules.set(id, rule);
  return rule;
}

export function updateFraudRule(
  tenant_id: string,
  rule_id: string,
  patch: Partial<{ name: string; condition_pseudocode: string; threshold: number; enabled: boolean }>,
  now: Date,
): FraudRule {
  const rule = _rules.get(rule_id);
  if (!rule || rule.tenant_id !== tenant_id) throw new FraudError('unknown_rule', `unknown ${rule_id}`);
  if (patch.name !== undefined) {
    if (patch.name.length < 3 || patch.name.length > 120) throw new FraudError('invalid_input', 'name must be 3..120');
    rule.name = patch.name;
  }
  if (patch.condition_pseudocode !== undefined) {
    if (patch.condition_pseudocode.length < 5) throw new FraudError('invalid_input', 'pseudocode required');
    rule.condition_pseudocode = patch.condition_pseudocode;
  }
  if (patch.threshold !== undefined) {
    if (!Number.isFinite(patch.threshold)) throw new FraudError('invalid_input', 'threshold not finite');
    rule.threshold = patch.threshold;
  }
  if (patch.enabled !== undefined) rule.enabled = patch.enabled;
  rule.updated_at = now.toISOString();
  return { ...rule };
}

export function deleteFraudRule(tenant_id: string, rule_id: string): boolean {
  const rule = _rules.get(rule_id);
  if (!rule || rule.tenant_id !== tenant_id) return false;
  _rules.delete(rule_id);
  return true;
}

// ─── SAR + Vigilance ───────────────────────────────────────────────────

export interface SarSubmission {
  sar_id: string;
  case_id: string;
  submitted_by: string;
  submitted_at: string;
  fiu_reference: string;
  summary: string;
}

export interface VigilanceReferral {
  vigilance_ref: string;
  case_id: string;
  referred_by: string;
  referred_at: string;
  reason: string;
}

export function submitSar(
  tenant_id: string,
  case_id: string,
  submitted_by: string,
  summary: string,
  now: Date,
): SarSubmission {
  if (!submitted_by) throw new FraudError('invalid_input', 'submitted_by required');
  if (!summary || summary.trim().length < 20)
    throw new FraudError('invalid_input', 'summary ≥ 20 chars (RBI Master Directions on Frauds 2016 §A.2)');
  const entry = _cases.get(case_id);
  if (!entry || entry.tenant_id !== tenant_id) throw new FraudError('unknown_case', `unknown ${case_id}`);
  if (entry.sar_id) throw new FraudError('sar_already_submitted', `SAR already on file: ${entry.sar_id}`);
  _sarSeq++;
  const id = `sar-${tenant_id}-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(_sarSeq).padStart(4, '0')}`;
  entry.sar_id = id;
  entry.status = 'reported';
  entry.updated_at = now.toISOString();
  // Simulate FIU-IND acknowledgement reference (real impl uses GoAML feedback)
  const fiu_reference = `FIU-IND-${now.toISOString().slice(0, 7).replace('-', '')}-${String(_sarSeq).padStart(6, '0')}`;
  return { sar_id: id, case_id, submitted_by, submitted_at: now.toISOString(), fiu_reference, summary: summary.trim() };
}

export function referToVigilance(
  tenant_id: string,
  case_id: string,
  referred_by: string,
  reason: string,
  now: Date,
): VigilanceReferral {
  if (!referred_by) throw new FraudError('invalid_input', 'referred_by required');
  if (!reason || reason.trim().length < 10) throw new FraudError('invalid_input', 'reason ≥ 10 chars');
  const entry = _cases.get(case_id);
  if (!entry || entry.tenant_id !== tenant_id) throw new FraudError('unknown_case', `unknown ${case_id}`);
  if (entry.vigilance_ref)
    throw new FraudError('vigilance_already_referred', `already referred: ${entry.vigilance_ref}`);
  _vigSeq++;
  const id = `vig-${tenant_id}-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(_vigSeq).padStart(4, '0')}`;
  entry.vigilance_ref = id;
  entry.updated_at = now.toISOString();
  return { vigilance_ref: id, case_id, referred_by, referred_at: now.toISOString(), reason: reason.trim() };
}

export function _resetFraudStore() {
  _cases.clear();
  _rules.clear();
  _caseSeq = 0;
  _ruleSeq = 0;
  _sarSeq = 0;
  _vigSeq = 0;
}
