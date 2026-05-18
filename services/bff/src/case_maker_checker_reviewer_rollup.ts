// services/bff/src/case_maker_checker_reviewer_rollup.ts
//
// T6 M9.16 — Maker-checker by-reviewer activity rollup.
//
// M9.3 ships the case maker-checker workflow with approve/reject (per
// RBI's segregation-of-duties principle — maker ≠ checker enforced).
// M9.4 ships the case event journal. M9.13/M9.14 ship per-case
// dimensions. M9.15 ships event action distribution.
//
// M9.16 lands the PER-CHECKER pivot — who has been approving/rejecting
// sensitive case actions (close / escalate / override_decision)? Per
// checker: distinct cases reviewed + per-action_type breakdown +
// approved_count + rejected_count + decision_rate.
//
// Mirror of M7.16 (AI promotion reviewer rollup) for the case
// maker-checker surface. Also paralleling M2.15 / M13.16 / M15.8 /
// M9.14 / M11.15 per-actor pattern.
//
// Drives BIL compliance "who has been approving sensitive case
// actions?" quarterly access-review + "is any checker rubber-stamping
// all submissions?" segregation-of-duties review.
//
// Pure resolver — caller passes drained MakerCheckerAction list.

import type {
  MakerCheckerAction,
  MakerCheckerEngine,
  SensitiveActionType,
} from './case_maker_checker';

// ─── Canonical enum ────────────────────────────────────────────────────

const ALL_ACTION_TYPES: readonly SensitiveActionType[] = [
  'case.close',
  'case.escalate',
  'case.override_decision',
] as const;

// ─── Public types ──────────────────────────────────────────────────────

export interface MakerCheckerReviewerRow {
  checker_username: string;
  total_decisions: number;
  approved_count: number;
  rejected_count: number;
  /** approved_count / total_decisions; null when total=0. */
  approval_rate: number | null;
  /** Distinct case_ids this checker has decided on (sorted asc, cap 50). */
  distinct_cases: number;
  case_ids: string[];
  /** Per-action_type breakdown (every type at 0 when absent). */
  by_action_type: Record<SensitiveActionType, number>;
  /** Newest checker_at across this checker's decisions; null when none. */
  most_recent_at: string | null;
}

export interface MakerCheckerReviewerRollupSummary {
  tenant_id: string;
  generated_at: string;
  total_decisions: number;
  total_reviewers: number;
  reviewers: MakerCheckerReviewerRow[];
  /** Top row by total_decisions; canonical username asc tie-break;
   *  null on empty. */
  most_active_reviewer: string | null;
  /** Subset with approval_rate === 1.0 AND total_decisions >= 3 —
   *  rubber-stamping candidates for BIL compliance review. Sorted by
   *  reviewers[] declared order. */
  rubber_stamp_reviewers: string[];
}

export const MC_RUBBER_STAMP_MIN_DECISIONS = 3;

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByActionType(): Record<SensitiveActionType, number> {
  return {
    'case.close': 0,
    'case.escalate': 0,
    'case.override_decision': 0,
  };
}

function drainAllActions(
  engine: MakerCheckerEngine,
  tenant_id: string,
): MakerCheckerAction[] {
  const PAGE = 500;
  const out: MakerCheckerAction[] = [];
  for (let page = 1; page <= 200; page++) {
    const result = engine.list(tenant_id, { page, page_size: PAGE });
    out.push(...result.items);
    if (result.items.length < PAGE) break;
  }
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function summarizeMakerCheckerReviewerActivity(
  engine: MakerCheckerEngine,
  tenant_id: string,
  now: Date,
): MakerCheckerReviewerRollupSummary {
  const actions = drainAllActions(engine, tenant_id);

  type Bucket = {
    total_decisions: number;
    approved_count: number;
    rejected_count: number;
    cases: Set<string>;
    by_action_type: Record<SensitiveActionType, number>;
    most_recent_at: string | null;
  };
  const buckets = new Map<string, Bucket>();

  let total_decisions = 0;

  for (const a of actions) {
    if (a.status !== 'approved' && a.status !== 'rejected') continue;
    const checker = a.checker_username;
    if (!checker) continue;

    let b = buckets.get(checker);
    if (!b) {
      b = {
        total_decisions: 0,
        approved_count: 0,
        rejected_count: 0,
        cases: new Set<string>(),
        by_action_type: emptyByActionType(),
        most_recent_at: null,
      };
      buckets.set(checker, b);
    }
    b.total_decisions++;
    total_decisions++;
    if (a.status === 'approved') b.approved_count++;
    else b.rejected_count++;
    b.cases.add(a.case_id);
    if (ALL_ACTION_TYPES.includes(a.action_type)) {
      b.by_action_type[a.action_type]++;
    }
    if (a.checker_at && (!b.most_recent_at || a.checker_at > b.most_recent_at)) {
      b.most_recent_at = a.checker_at;
    }
  }

  const reviewers: MakerCheckerReviewerRow[] = [...buckets.entries()]
    .map(([checker, b]) => ({
      checker_username: checker,
      total_decisions: b.total_decisions,
      approved_count: b.approved_count,
      rejected_count: b.rejected_count,
      approval_rate:
        b.total_decisions === 0 ? null : b.approved_count / b.total_decisions,
      distinct_cases: b.cases.size,
      case_ids: [...b.cases].sort().slice(0, 50),
      by_action_type: { ...b.by_action_type },
      most_recent_at: b.most_recent_at,
    }))
    .sort((a, b) => {
      if (b.total_decisions !== a.total_decisions) {
        return b.total_decisions - a.total_decisions;
      }
      return a.checker_username.localeCompare(b.checker_username);
    });

  const most_active_reviewer =
    reviewers.length > 0 ? reviewers[0].checker_username : null;

  const rubber_stamp_reviewers = reviewers
    .filter(
      (r) =>
        r.approval_rate === 1 &&
        r.total_decisions >= MC_RUBBER_STAMP_MIN_DECISIONS,
    )
    .map((r) => r.checker_username);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_decisions,
    total_reviewers: reviewers.length,
    reviewers,
    most_active_reviewer,
    rubber_stamp_reviewers,
  };
}
