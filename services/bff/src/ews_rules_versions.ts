// services/bff/src/ews_rules_versions.ts
//
// Rules-Plus RP-1 — SemVer versioning + maker-checker + clone + diff.
//
// Layered ON TOP of EWS-1..5's rules engine. The existing
// `services/bff/src/ews_rules.ts` is NOT modified — its CRUD,
// state machine, and audit hooks stay frozen. This module adds:
//
//   * SemVer version snapshots (one row per rule edit, capped at 50)
//   * Approval ledger (one row per submit/approve/reject) with
//     maker-checker self-approval refusal
//   * Clone helper (deprecated rule → fresh DRAFT v0.1.0)
//   * Pure-function diff between two snapshots
//
// Routes wired in server.ts (RP-1).

import { randomUUID } from 'node:crypto';
import {
  CmsCaseError as CaseLikeError, // unused; keep imports tight
} from './cms_cases';
import {
  EwsRuleError,
  type EwsRule,
  type EwsRuleStore,
  type EwsCondition,
} from './ews_rules';

// keep the case-like import line under linters happy
void CaseLikeError;

// ─── SemVer ──────────────────────────────────────────────────────────

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export const SEMVER_INITIAL = '0.1.0';

export type SemverBump = 'major' | 'minor' | 'patch';

export function isSemver(s: unknown): s is string {
  return typeof s === 'string' && SEMVER_RE.test(s);
}

export function parseSemver(s: string): { major: number; minor: number; patch: number } {
  const m = SEMVER_RE.exec(s);
  if (!m) {
    throw new EwsRuleError('invalid_input', `not a SemVer: ${s}`);
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Pure: bump the requested component, zero out the lower ones. */
export function bumpSemver(prev: string, bump: SemverBump): string {
  const v = parseSemver(prev);
  if (bump === 'major') return `${v.major + 1}.0.0`;
  if (bump === 'minor') return `${v.major}.${v.minor + 1}.0`;
  return `${v.major}.${v.minor}.${v.patch + 1}`;
}

/** Compare a vs b. Returns -1/0/1. */
export function compareSemver(a: string, b: string): number {
  const A = parseSemver(a);
  const B = parseSemver(b);
  if (A.major !== B.major) return A.major < B.major ? -1 : 1;
  if (A.minor !== B.minor) return A.minor < B.minor ? -1 : 1;
  if (A.patch !== B.patch) return A.patch < B.patch ? -1 : 1;
  return 0;
}

// ─── Substantive-vs-metadata edit detection ──────────────────────────

const METADATA_FIELDS = new Set(['name', 'description', 'tags']);
const SUBSTANTIVE_FIELDS = new Set(['conditions', 'logic', 'action', 'category']);

/** Inspect two rule bodies; return the bump kind that best describes
 *  the delta. Substantive change → MINOR; metadata-only → PATCH. */
export function classifyEditBump(prev: EwsRule, next: EwsRule): SemverBump {
  for (const f of SUBSTANTIVE_FIELDS) {
    const a = (prev as unknown as Record<string, unknown>)[f];
    const b = (next as unknown as Record<string, unknown>)[f];
    if (JSON.stringify(a) !== JSON.stringify(b)) return 'minor';
  }
  for (const f of METADATA_FIELDS) {
    const a = (prev as unknown as Record<string, unknown>)[f];
    const b = (next as unknown as Record<string, unknown>)[f];
    if (JSON.stringify(a) !== JSON.stringify(b)) return 'patch';
  }
  return 'patch'; // no detectable change → still bump patch (defensive)
}

// ─── Public types ─────────────────────────────────────────────────────

export interface RuleVersionSnapshot {
  version_id: string;
  rule_id: string;
  tenant_id: string;
  semver: string;
  snapshot: EwsRule;
  created_by: string;
  created_at: string;
  reason: string | null;
}

export type ApprovalDecision = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface RuleApproval {
  approval_id: string;
  rule_id: string;
  tenant_id: string;
  maker_username: string;
  approver_username: string | null;
  decision: ApprovalDecision;
  reason: string | null;
  submitted_at: string;
  decided_at: string | null;
}

// ─── Caps ─────────────────────────────────────────────────────────────

export const RULE_VERSIONS_CAP_PER_RULE = 50;
export const RULE_APPROVALS_CAP_PER_RULE = 100;

// ─── Store interface ─────────────────────────────────────────────────

export interface EwsRuleVersionsStore {
  recordVersion(input: {
    tenant_id: string;
    rule: EwsRule;
    semver: string;
    created_by: string;
    reason?: string | null;
    now: Date;
  }): RuleVersionSnapshot;
  listVersions(tenant_id: string, rule_id: string): RuleVersionSnapshot[];
  getVersion(
    tenant_id: string,
    rule_id: string,
    semver: string,
  ): RuleVersionSnapshot | null;
  latestSemver(tenant_id: string, rule_id: string): string | null;

  recordSubmission(input: {
    tenant_id: string;
    rule_id: string;
    maker_username: string;
    reason?: string | null;
    now: Date;
  }): RuleApproval;
  recordDecision(input: {
    tenant_id: string;
    rule_id: string;
    approver_username: string;
    decision: 'approved' | 'rejected';
    reason?: string | null;
    now: Date;
  }): RuleApproval;
  /** The most recent pending submission for the rule, if any. */
  pendingApproval(tenant_id: string, rule_id: string): RuleApproval | null;
  listApprovals(tenant_id: string, rule_id: string): RuleApproval[];
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export class InMemoryEwsRuleVersionsStore implements EwsRuleVersionsStore {
  private readonly versions = new Map<string, RuleVersionSnapshot[]>();
  private readonly approvals = new Map<string, RuleApproval[]>();

  private vKey(t: string, r: string): string {
    return `${t}::${r}`;
  }
  private bucket<T>(m: Map<string, T[]>, k: string): T[] {
    let a = m.get(k);
    if (!a) {
      a = [];
      m.set(k, a);
    }
    return a;
  }

  recordVersion(input: {
    tenant_id: string;
    rule: EwsRule;
    semver: string;
    created_by: string;
    reason?: string | null;
    now: Date;
  }): RuleVersionSnapshot {
    if (!isSemver(input.semver)) {
      throw new EwsRuleError('invalid_input', `bad semver: ${input.semver}`);
    }
    const arr = this.bucket(this.versions, this.vKey(input.tenant_id, input.rule.rule_id));
    if (arr.find((v) => v.semver === input.semver)) {
      throw new EwsRuleError(
        'duplicate_semver',
        `version ${input.semver} already recorded for rule ${input.rule.rule_id}`,
      );
    }
    const row: RuleVersionSnapshot = {
      version_id: randomUUID(),
      rule_id: input.rule.rule_id,
      tenant_id: input.tenant_id,
      semver: input.semver,
      snapshot: clone(input.rule),
      created_by: input.created_by,
      created_at: input.now.toISOString(),
      reason: input.reason ?? null,
    };
    arr.push(row);
    if (arr.length > RULE_VERSIONS_CAP_PER_RULE) {
      arr.splice(0, arr.length - RULE_VERSIONS_CAP_PER_RULE);
    }
    return clone(row);
  }

  listVersions(tenant_id: string, rule_id: string): RuleVersionSnapshot[] {
    return (this.versions.get(this.vKey(tenant_id, rule_id)) ?? [])
      .slice()
      .sort((a, b) => compareSemver(b.semver, a.semver))
      .map(clone);
  }

  getVersion(tenant_id: string, rule_id: string, semver: string): RuleVersionSnapshot | null {
    const v = (this.versions.get(this.vKey(tenant_id, rule_id)) ?? []).find(
      (x) => x.semver === semver,
    );
    return v ? clone(v) : null;
  }

  latestSemver(tenant_id: string, rule_id: string): string | null {
    const arr = this.versions.get(this.vKey(tenant_id, rule_id)) ?? [];
    if (arr.length === 0) return null;
    return [...arr].sort((a, b) => compareSemver(b.semver, a.semver))[0]!.semver;
  }

  recordSubmission(input: {
    tenant_id: string;
    rule_id: string;
    maker_username: string;
    reason?: string | null;
    now: Date;
  }): RuleApproval {
    if (!input.maker_username.trim()) {
      throw new EwsRuleError('invalid_input', 'maker_username required');
    }
    const arr = this.bucket(this.approvals, this.vKey(input.tenant_id, input.rule_id));
    // Withdraw any prior pending row first.
    for (const a of arr) {
      if (a.decision === 'pending') {
        a.decision = 'withdrawn';
        a.decided_at = input.now.toISOString();
      }
    }
    const row: RuleApproval = {
      approval_id: randomUUID(),
      rule_id: input.rule_id,
      tenant_id: input.tenant_id,
      maker_username: input.maker_username.trim(),
      approver_username: null,
      decision: 'pending',
      reason: input.reason ?? null,
      submitted_at: input.now.toISOString(),
      decided_at: null,
    };
    arr.push(row);
    if (arr.length > RULE_APPROVALS_CAP_PER_RULE) {
      arr.splice(0, arr.length - RULE_APPROVALS_CAP_PER_RULE);
    }
    return clone(row);
  }

  recordDecision(input: {
    tenant_id: string;
    rule_id: string;
    approver_username: string;
    decision: 'approved' | 'rejected';
    reason?: string | null;
    now: Date;
  }): RuleApproval {
    if (!input.approver_username.trim()) {
      throw new EwsRuleError('invalid_input', 'approver_username required');
    }
    const arr = this.bucket(this.approvals, this.vKey(input.tenant_id, input.rule_id));
    const pending = arr.find((a) => a.decision === 'pending');
    if (!pending) {
      throw new EwsRuleError(
        'no_pending_approval',
        `rule ${input.rule_id} has no pending approval`,
      );
    }
    if (pending.maker_username === input.approver_username.trim()) {
      throw new EwsRuleError(
        'self_approval_refused',
        `${input.approver_username} cannot approve their own submission (4-eyes principle)`,
      );
    }
    pending.decision = input.decision;
    pending.approver_username = input.approver_username.trim();
    pending.decided_at = input.now.toISOString();
    if (input.reason !== undefined) pending.reason = input.reason;
    return clone(pending);
  }

  pendingApproval(tenant_id: string, rule_id: string): RuleApproval | null {
    const a = (this.approvals.get(this.vKey(tenant_id, rule_id)) ?? []).find(
      (x) => x.decision === 'pending',
    );
    return a ? clone(a) : null;
  }

  listApprovals(tenant_id: string, rule_id: string): RuleApproval[] {
    return (this.approvals.get(this.vKey(tenant_id, rule_id)) ?? [])
      .slice()
      .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1))
      .map(clone);
  }
}

export const defaultEwsRuleVersionsStore: EwsRuleVersionsStore =
  new InMemoryEwsRuleVersionsStore();

// ─── Diff helper ─────────────────────────────────────────────────────

export interface RuleDiffEntry {
  field: string;
  before: unknown;
  after: unknown;
  kind: 'changed' | 'added' | 'removed';
}

const DIFFABLE_FIELDS: Array<keyof EwsRule> = [
  'name',
  'category',
  'description',
  'conditions',
  'logic',
  'action',
  'tags',
  'state',
  'is_active',
];

/** Pure field-by-field diff between two rule snapshots. */
export function diffRuleSnapshots(a: EwsRule, b: EwsRule): RuleDiffEntry[] {
  const out: RuleDiffEntry[] = [];
  for (const f of DIFFABLE_FIELDS) {
    const before = a[f];
    const after = b[f];
    const beforeJson = JSON.stringify(before);
    const afterJson = JSON.stringify(after);
    if (beforeJson === afterJson) continue;
    out.push({
      field: f as string,
      before,
      after,
      kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
    });
  }
  return out;
}

// ─── Clone helper ────────────────────────────────────────────────────

export interface CloneOptions {
  /** New rule_id. Caller supplies (RULE_<X>_NNN format). */
  new_rule_id: string;
  /** Optional new name; defaults to "Copy of <original name>". */
  new_name?: string;
}

/**
 * Pure helper: turn an existing rule into the create-input for a fresh
 * DRAFT v0.1.0 clone. Does NOT call store.create — caller does that
 * with the returned input.
 */
export function buildCloneInput(
  source: EwsRule,
  opts: CloneOptions,
): {
  rule_id: string;
  name: string;
  category: EwsRule['category'];
  description: string;
  conditions: EwsCondition[];
  logic: EwsRule['logic'];
  action: EwsRule['action'];
  tags: string[];
} {
  if (!opts.new_rule_id || !/^RULE_[A-Z][A-Z0-9_]{2,30}$/.test(opts.new_rule_id)) {
    throw new EwsRuleError(
      'invalid_input',
      'new_rule_id must match RULE_<X>_NNN format',
    );
  }
  const name = (opts.new_name ?? `Copy of ${source.name}`).slice(0, 80);
  return {
    rule_id: opts.new_rule_id,
    name,
    category: source.category,
    description: source.description,
    conditions: source.conditions.map((c) => ({
      ...c,
      ...(Array.isArray(c.value) ? { value: [...c.value] } : {}),
      ...(c.range ? { range: [c.range[0], c.range[1]] as [number, number] } : {}),
    })),
    logic: source.logic,
    action: { ...source.action },
    tags: [...source.tags],
  };
}

// ─── High-level wrappers (the route layer calls these) ──────────────

/**
 * Approve via 4-eyes: refuses if approver is the maker. Calls into the
 * existing rule store's `submit` + `activate` to honour the legal
 * state machine; records an approval row.
 */
export function approveWithFourEyes(
  ruleStore: EwsRuleStore,
  versionsStore: EwsRuleVersionsStore,
  args: {
    tenant_id: string;
    rule_id: string;
    approver_username: string;
    reason?: string | null;
    now: Date;
  },
): { rule: EwsRule; approval: RuleApproval } {
  const approval = versionsStore.recordDecision({
    tenant_id: args.tenant_id,
    rule_id: args.rule_id,
    approver_username: args.approver_username,
    decision: 'approved',
    reason: args.reason,
    now: args.now,
  });
  // Walk the legal state path: ensure rule is in pending_review then activate.
  const cur = ruleStore.get(args.tenant_id, args.rule_id);
  if (!cur) {
    throw new EwsRuleError('unknown_rule', `rule ${args.rule_id} not found`);
  }
  let rule = cur;
  if (cur.state === 'draft') {
    rule = ruleStore.submit(args.tenant_id, args.rule_id, args.now);
  }
  rule = ruleStore.activate(args.tenant_id, args.rule_id, args.now);
  return { rule, approval };
}

/**
 * Reject a pending approval. Records a `rejected` row in the approval
 * ledger; the rule stays in PENDING_REVIEW (the SPA surfaces the
 * latest approval state via the approval log). Maker can edit (PUT)
 * + resubmit (which records a fresh pending row, withdrawing the
 * prior rejection).
 */
export function rejectWithFourEyes(
  ruleStore: EwsRuleStore,
  versionsStore: EwsRuleVersionsStore,
  args: {
    tenant_id: string;
    rule_id: string;
    approver_username: string;
    reason: string;
    now: Date;
  },
): { rule: EwsRule; approval: RuleApproval } {
  if (!args.reason || !args.reason.trim()) {
    throw new EwsRuleError('invalid_input', 'reason required for rejection');
  }
  const approval = versionsStore.recordDecision({
    tenant_id: args.tenant_id,
    rule_id: args.rule_id,
    approver_username: args.approver_username,
    decision: 'rejected',
    reason: args.reason,
    now: args.now,
  });
  const rule = ruleStore.get(args.tenant_id, args.rule_id);
  if (!rule) {
    throw new EwsRuleError('unknown_rule', `rule ${args.rule_id} not found`);
  }
  return { rule, approval };
}

/** Substantive flag — convenience shorthand. */
export function isSubstantiveEdit(prev: EwsRule, next: EwsRule): boolean {
  return classifyEditBump(prev, next) === 'minor';
}
