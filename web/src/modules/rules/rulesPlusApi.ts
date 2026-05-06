// web/src/modules/rules/rulesPlusApi.ts
//
// RP-2 — API client for the Rules-Plus routes shipped in RP-1.
// Layered alongside the existing EwsRuleBuilderPage's inline calls
// (additive — that page stays).

import { http } from '@/lib/http';

export interface RuleVersionSnapshot {
  version_id: string;
  rule_id: string;
  tenant_id: string;
  semver: string;
  snapshot: unknown;
  created_by: string;
  created_at: string;
  reason: string | null;
}

export interface RuleApproval {
  approval_id: string;
  rule_id: string;
  tenant_id: string;
  maker_username: string;
  approver_username: string | null;
  decision: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  reason: string | null;
  submitted_at: string;
  decided_at: string | null;
}

export interface RuleDiffEntry {
  field: string;
  before: unknown;
  after: unknown;
  kind: 'changed' | 'added' | 'removed';
}

function unwrap<T>(p: Promise<{ data: { body: T } }>): Promise<T> {
  return p.then((r) => r.data.body);
}

export const rulesPlusApi = {
  clone: (rule_id: string, new_rule_id: string, new_name?: string) =>
    unwrap<{ rule: { rule_id: string }; semver: string; cloned_from: string }>(
      http.post(`/v1/ews/rules/${rule_id}/clone`, { new_rule_id, new_name }),
    ),

  submit: (rule_id: string, reason?: string) =>
    unwrap<{ rule: { state: string }; approval: RuleApproval }>(
      http.post(`/v1/ews/rules/${rule_id}/submit`, { reason }),
    ),

  approve: (rule_id: string, reason?: string) =>
    unwrap<{ rule: { state: string }; approval: RuleApproval }>(
      http.post(`/v1/ews/rules/${rule_id}/approve`, { reason }),
    ),

  reject: (rule_id: string, reason: string) =>
    unwrap<{ rule: { state: string }; approval: RuleApproval }>(
      http.post(`/v1/ews/rules/${rule_id}/reject`, { reason }),
    ),

  versions: (rule_id: string) =>
    unwrap<{
      items: RuleVersionSnapshot[];
      total: number;
      latest_semver: string | null;
    }>(http.get(`/v1/ews/rules/${rule_id}/versions`)),

  version: (rule_id: string, semver: string) =>
    unwrap<RuleVersionSnapshot>(
      http.get(`/v1/ews/rules/${rule_id}/versions/${semver}`),
    ),

  diff: (rule_id: string, from: string, to: string) =>
    unwrap<{
      rule_id: string;
      from: string;
      to: string;
      diff: RuleDiffEntry[];
      change_count: number;
    }>(http.post(`/v1/ews/rules/${rule_id}/versions/diff`, { from, to })),

  approvals: (rule_id: string) =>
    unwrap<{ items: RuleApproval[]; total: number; pending: RuleApproval | null }>(
      http.get(`/v1/ews/rules/${rule_id}/approvals`),
    ),

  testRule: (
    rule_id: string,
    values: Record<string, number | string>,
  ) =>
    unwrap<{
      rule_id: string;
      matched: boolean;
      matched_indicators: string[];
      score_impact: number;
      alert_severity: string;
    }>(http.post(`/v1/ews/rules/${rule_id}/test`, { values })),
};

// Auto-save utilities ---------------------------------------------------

const DRAFT_KEY = 'apex.ews.rules.wizard.draft';
export const AUTO_SAVE_INTERVAL_MS = 30_000;

export function loadDraft<T>(): T | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveDraft<T>(draft: T): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ draft, savedAt: Date.now() }));
  } catch {
    // localStorage full or disabled — silent fall-through
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
}

export interface DraftEnvelope<T> {
  draft: T;
  savedAt: number;
}
